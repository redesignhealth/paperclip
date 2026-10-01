"""Offline `hermes chat -q` MCP discovery fixture (TECH-7080).

Runs the real Hermes CLI non-interactively against a local streamable-HTTP MCP server and a
local OpenAI-compatible model stub. No network, no credentials. Proves that:
  * an allowlisted MCP tool is available to the model on the very first model turn,
  * a tool outside `tools.include` never reaches the model,
  * the process exits cleanly and leaves no Hermes child processes behind.

Usage: hermes-chat-mcp-fixture.py [auto|off]   (value of hermes `tools.tool_search.enabled`)
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
ALLOWED, FORBIDDEN, SERVER = "allowed_tool", "forbidden_tool", "fixture"
MCP_PORT, LLM_PORT = 18931, 18932
seen: list[dict] = []

mcp = MCPServer(SERVER)


@mcp.tool()
def allowed_tool() -> str:
    """Allowlisted fixture tool."""
    return "ok"


@mcp.tool()
def forbidden_tool() -> str:
    """Tool that must never reach the model."""
    return "no"


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

        if body.get("stream"):
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
tool_search = f"tools:\n  tool_search:\n    enabled: {MODE}\n" if MODE != "auto" else ""
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

assert proc.returncode == 0, f"hermes chat -q exited {proc.returncode}"
turn1 = next((r for r in seen if r.get("stream") and r.get("tools")), None)
assert turn1 is not None, "model never received a tool-bearing first turn"
tools = {t["function"]["name"]: t["function"].get("description", "") for t in turn1["tools"]}
prefixed = f"mcp__{SERVER}__{ALLOWED}"
bridge_listing = tools.get("tool_search", "")

if MODE == "off":
    assert prefixed in tools, f"{prefixed} missing from turn-1 tool schema"
    assert "tool_search" not in tools
else:
    assert "tool_search" in tools and "tool_call" in tools, "deferred-tool bridge missing"
    assert ALLOWED in bridge_listing, "allowlisted tool absent from turn-1 tool_search manifest"

everything = json.dumps(turn1["tools"])
assert FORBIDDEN not in everything, "non-allowlisted tool leaked to the model"

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
    "hermes_version": version, "tool_search_enabled": MODE, "exit_code": proc.returncode,
    "mcp_tool_schema_name": prefixed if prefixed in tools else None,
    "allowed_in_tool_search_manifest": ALLOWED in bridge_listing,
    "forbidden_exposed": False, "bridge_tools_present": sorted(n for n in tools if n.startswith("tool_")),
    "turn1_tool_count": len(tools), "model_requests": len(seen), "leftover_processes": 0}, sort_keys=True))
