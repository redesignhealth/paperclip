"""Offline `hermes chat -q` MCP discovery fixture (TECH-7080).

Runs the real Hermes CLI non-interactively against a local streamable-HTTP MCP server and a
local OpenAI-compatible model stub. No network, no credentials. Proves that:
  * an allowlisted MCP tool is available to the model on the very first model turn,
  * a tool outside `tools.include` never reaches the model,
  * the process exits cleanly and leaves no Hermes child processes behind.

Scenarios (argv[1]):
  auto       tool_search default: tools are deferred behind the tool_search bridge (manifest lists the allowed tool)
  off        tool_search disabled: allowed tool is a direct mcp__<server>__<tool> schema entry on turn 1
  roundtrip  tool_search off + a DETERMINISTIC model tool call: the stub returns a tool_call for the allowed tool,
             the MCP server must execute it exactly once, its result must reach the model in the next request,
             and the run must exit 0 with no teardown ExceptionGroup/Traceback
  forbidden  tool_search off + a hallucinated model call to the non-allowlisted tool: the MCP server must never
             execute it (kept separate from roundtrip so the positive exit-0 assertion stays unambiguous).
             NOTE: Hermes 0.21.x runs a tool-name repair pipeline (case/separator/`_tool`-suffix normalisation then
             fuzzy matching, agent/agent_runtime_helpers.py repair_tool_call) that remaps an unknown name onto a
             REGISTERED tool, so the hallucinated call is executed as the allowlisted tool. The invariant asserted
             is therefore: the forbidden tool never executes and only allowlisted tools can run.
Prints one JSON evidence line (no URLs, tokens or prompts) and exits non-zero on any failed assertion.
"""
import atexit
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import uvicorn
# mcp>=2 (the version Hermes 0.21.3 pins) exposes the server API as mcp.server.MCPServer; FastMCP is the 1.x name.
from mcp.server import MCPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else "auto"
assert MODE in ("auto", "off", "roundtrip", "forbidden"), f"unknown scenario {MODE!r}"
ALLOWED, FORBIDDEN, SERVER = "allowed_tool", "forbidden_tool", "fixture"
MCP_PORT, LLM_PORT = 18931, 18932
seen: list[dict] = []
mcp_calls: list[str] = []  # every tools/call the MCP server actually executed
ALLOWED_RESULT, FORBIDDEN_RESULT = "fixture-allowed-result-7089", "FIXTURE-FORBIDDEN-EXECUTED"

mcp = MCPServer(SERVER)


@mcp.tool()
def allowed_tool() -> str:
    """Allowlisted fixture tool."""
    mcp_calls.append(ALLOWED)
    return ALLOWED_RESULT


@mcp.tool()
def forbidden_tool() -> str:
    """Tool that must never reach the model."""
    mcp_calls.append(FORBIDDEN)
    return FORBIDDEN_RESULT


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"{}")
        seen.append(body)
        model = body.get("model", "fixture-model")

        def chunk(delta, finish=None):
            return "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "created": 0, "model": model,
                                          "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"

        scripted_tool = {"roundtrip": f"mcp__{SERVER}__{ALLOWED}", "forbidden": f"mcp__{SERVER}__{FORBIDDEN}"}.get(MODE)
        has_tool_result = any(m.get("role") == "tool" for m in body.get("messages", []))
        if body.get("stream") and scripted_tool and body.get("tools") and not has_tool_result:
            # Deterministic first agent turn: call the scripted tool; after its result comes back, answer in text.
            call = {"index": 0, "id": "call_fixture_1", "type": "function", "function": {"name": scripted_tool, "arguments": "{}"}}
            data = (chunk({"role": "assistant", "content": None, "tool_calls": [call]}) + chunk({}, "tool_calls")
                    + "data: [DONE]\n\n").encode()
            ctype = "text/event-stream"
        elif body.get("stream"):
            data = (chunk({"role": "assistant", "content": "fixture-done"}) + chunk({}, "stop") + "data: [DONE]\n\n").encode()
            ctype = "text/event-stream"
        else:
            data = json.dumps({"id": "x", "object": "chat.completion", "created": 0, "model": model, "choices": [
                {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "fixture-done"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
            ctype = "application/json"
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


threading.Thread(target=lambda: uvicorn.run(mcp.streamable_http_app(), host="127.0.0.1", port=MCP_PORT,
                                            log_level="warning"), daemon=True).start()
llm = ThreadingHTTPServer(("127.0.0.1", LLM_PORT), Model)
threading.Thread(target=llm.serve_forever, daemon=True).start()


def wait_listening(port: int, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise AssertionError(f"port {port} never started listening")


wait_listening(MCP_PORT)
wait_listening(LLM_PORT)

home = tempfile.mkdtemp(prefix="hermes-fixture-")
atexit.register(shutil.rmtree, home, ignore_errors=True)
tool_search = "" if MODE == "auto" else "tools:\n  tool_search:\n    enabled: off\n"
with open(f"{home}/config.yaml", "w") as fh:
    fh.write(f"""model:
  default: fixture-model
  provider: custom
  base_url: http://127.0.0.1:{LLM_PORT}/v1
  api_key: fixture-key
mcp_servers:
  {SERVER}:
    url: http://127.0.0.1:{MCP_PORT}/mcp
    enabled: true
    skip_preflight: true
    tools:
      include: [{ALLOWED}]
      resources: false
      prompts: false
{tool_search}""")

env = {**os.environ, "HERMES_HOME": home, "HERMES_DISABLE_LAZY_INSTALLS": "1"}
proc = subprocess.run(["hermes", "chat", "-q", "say hi", "-Q"], env=env, capture_output=True, text=True, timeout=120)
version = subprocess.run(["hermes", "--version"], env=env, capture_output=True, text=True).stdout.splitlines()[0]

if MODE != "forbidden":
    assert proc.returncode == 0, f"hermes chat -q exited {proc.returncode}"
turn1 = next((r for r in seen if r.get("stream") and r.get("tools")), None)
assert turn1 is not None, "model never received a tool-bearing first turn"
tools = {t["function"]["name"]: t["function"].get("description", "") for t in turn1["tools"]}
prefixed = f"mcp__{SERVER}__{ALLOWED}"
bridge_listing = tools.get("tool_search", "")

if MODE != "auto":
    assert prefixed in tools, f"{prefixed} missing from turn-1 tool schema"
    assert "tool_search" not in tools
else:
    assert "tool_search" in tools and "tool_call" in tools, "deferred-tool bridge missing"
    assert ALLOWED in bridge_listing, "allowlisted tool absent from turn-1 tool_search manifest"

everything = json.dumps(turn1["tools"])
assert FORBIDDEN not in everything, "non-allowlisted tool leaked to the model"

# Execution side: what the MCP server actually ran, and what the model was told afterwards.
tool_results = [m for r in seen for m in r.get("messages", []) if m.get("role") == "tool"]
result_text = json.dumps(tool_results)
combined_output = proc.stdout + proc.stderr
assert FORBIDDEN not in mcp_calls, "forbidden tool was executed by the MCP server"
assert FORBIDDEN_RESULT not in json.dumps(seen) and FORBIDDEN_RESULT not in combined_output, "forbidden tool result leaked"
if MODE == "roundtrip":
    assert mcp_calls == [ALLOWED], f"allowed tool must execute exactly once, got {mcp_calls}"
    assert any(ALLOWED_RESULT in str(m.get("content")) and m.get("tool_call_id") == "call_fixture_1" for m in tool_results), \
        "allowed tool result never reached the model as a role:tool message"
if MODE in ("roundtrip", "forbidden"):
    for marker in ("ExceptionGroup", "Traceback"):
        assert marker not in combined_output, f"teardown failure marker {marker!r} present in hermes output"
if MODE == "forbidden":
    assert set(mcp_calls) <= {ALLOWED}, f"only the allowlisted tool may execute, got {mcp_calls}"
    assert tool_results, "model was never given a tool result for the hallucinated call"

time.sleep(1)
leftovers = []
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        argv = open(f"/proc/{pid}/cmdline").read().split("\0")
    except OSError:
        continue
    # Match the program itself (hermes, or python running the hermes script), not wrapper shells whose
    # command text merely mentions it.
    if int(pid) != os.getpid() and any(a.endswith("/bin/hermes") or a == "hermes" for a in argv[:2]):
        leftovers.append(pid)
assert not leftovers, f"hermes processes left behind after exit: {leftovers}"

print("EVIDENCE " + json.dumps({
    "hermes_version": version, "scenario": MODE,
    "tool_search_enabled": "auto" if MODE == "auto" else "off", "exit_code": proc.returncode,
    "mcp_tool_schema_name": prefixed if prefixed in tools else None,
    "allowed_in_tool_search_manifest": ALLOWED in bridge_listing,
    "forbidden_exposed": False, "bridge_tools_present": sorted(n for n in tools if n.startswith("tool_")),
    "turn1_tool_count": len(tools), "model_requests": len(seen), "leftover_processes": 0,
    "mcp_calls_executed": mcp_calls, "tool_results_returned_to_model": len(tool_results),
    "tool_result_reached_model": ALLOWED_RESULT in result_text,
    "hallucinated_call_repaired_to_allowed": MODE == "forbidden" and mcp_calls == [ALLOWED]}, sort_keys=True))
