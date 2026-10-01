#!/usr/bin/env python3
"""
Compiles and deterministically splits the hash-locked Hermes Agent dependency closure.

Usage:
    python3 scripts/compile-hermes-requirements.py --check         # Verify committed files offline (drift check, no uv/network needed)
    python3 scripts/compile-hermes-requirements.py --print-digest  # Output normalized closure digest to stdout (offline)
    python3 scripts/compile-hermes-requirements.py --refresh       # Explicit opt-in regeneration using pinned uv (maintainers only)
"""

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Pinned exact uv version used for reproducible dependency compilation.
# Maintainers run --refresh intentionally when updating dependencies.
PINNED_UV_VERSION = "0.11.28"

# Reviewability thresholds: ensure every chunk is well below PR omission limits (<250 lines, <20KB)
MAX_CHUNK_LINES = 225
MAX_CHUNK_BYTES = 18000
HARD_MAX_CHUNK_LINES = 250
HARD_MAX_CHUNK_BYTES = 20480

REPO_ROOT = Path(__file__).resolve().parent.parent
HERMES_DIR = REPO_ROOT / "docker" / "hermes"
REQ_IN = HERMES_DIR / "requirements.in"
REQ_TXT = HERMES_DIR / "requirements.txt"
REQ_DIGEST = HERMES_DIR / "requirements.digest"

# Credential patterns: high-signal tokens and credential-bearing URL userinfo.
# Designed strictly to avoid false positives on legitimate package names (e.g. secretstorage, tokenizers)
# while detecting credentials in package lines, provenance/comment lines, and index URLs.
CREDENTIAL_PATTERNS = [
    (re.compile(r"://[^/\s@:]+:[^/\s@]+@"), "URL userinfo containing credentials"),
    (re.compile(r"://[^\s/@]*ghp_[^\s/@]*@"), "URL userinfo containing GitHub personal token"),
    (re.compile(r"://[^\s/@]*sk-[^\s/@]*@"), "URL userinfo containing secret API key"),
    (re.compile(r"://[^\s/@]*(?:AKIA|ASIA)[^\s/@]*@"), "URL userinfo containing AWS access key"),
    (re.compile(r"://[^\s/@]*xox[baprs]-[^\s/@]*@"), "URL userinfo containing Slack token"),
    (re.compile(r"://[^\s/@]*AIza[^\s/@]*@"), "URL userinfo containing Google API key"),
    (re.compile(r"\bghp_[a-zA-Z0-9]{20,}\b"), "GitHub personal access token (ghp_)"),
    (re.compile(r"\bgithub_pat_[a-zA-Z0-9_]{20,}\b"), "Fine-grained GitHub token (github_pat_)"),
    (re.compile(r"\b(?:gho|ghs|ghr)_[a-zA-Z0-9]{20,}\b"), "GitHub OAuth/app token"),
    (re.compile(r"\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,}\b"), "API secret key (sk-)"),
    (re.compile(r"\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b", re.IGNORECASE), "Bearer credential token"),
    (re.compile(r"\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b"), "JWT credential token"),
    (re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b"), "AWS access key ID"),
    (re.compile(r"(?i)\b(?:aws[_-]?)?(?:secret[_-]?(?:access[_-]?)?key|session[_-]?token)\s*[:=]\s*['\"]?[A-Za-z0-9/+=]{20,}['\"]?"), "AWS secret access key or session token form"),
    (re.compile(r"\bxox[baprs]-[0-9a-zA-Z-]{10,}\b"), "Slack token (xox[baprs]-...)"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"), "Google API key (AIza...)"),
]


def scan_for_credentials(text: str, source_label: str) -> None:
    """Scans text (including comments, provenance, package headers, and hashes) for credentials."""
    for line_no, line in enumerate(text.splitlines(), 1):
        for pattern, desc in CREDENTIAL_PATTERNS:
            if pattern.search(line):
                raise ValueError(
                    f"Credential security violation in {source_label} on line {line_no} "
                    f"({desc}): credential-bearing tokens and userinfo are strictly forbidden."
                )


def redact_diagnostics(text: str) -> str:
    """Redacts URL credentials and high-signal secret tokens from error/subprocess diagnostics."""
    if not text:
        return ""
    # Redact URL userinfo
    redacted = re.sub(r"://[^/\s@]+@", "://[redacted]@", text)
    # Redact high-signal tokens
    redacted = re.sub(r"\bghp_[a-zA-Z0-9]{20,}\b", "ghp_[redacted]", redacted)
    redacted = re.sub(r"\bgithub_pat_[a-zA-Z0-9_]{20,}\b", "github_pat_[redacted]", redacted)
    redacted = re.sub(r"\b(?:gho|ghs|ghr)_[a-zA-Z0-9]{20,}\b", "[redacted_github_token]", redacted)
    redacted = re.sub(r"\bsk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,}\b", "sk-[redacted]", redacted)
    redacted = re.sub(r"\bBearer\s+[a-zA-Z0-9_\-\.]{20,}\b", "Bearer [redacted]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b", "[redacted_jwt]", redacted)
    redacted = re.sub(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b", "[redacted_aws_key]", redacted)
    redacted = re.sub(
        r"(?i)\b((?:aws[_-]?)?(?:secret[_-]?(?:access[_-]?)?key|session[_-]?token)\s*[:=]\s*['\"]?)[A-Za-z0-9/+=]{20,}(['\"]?)",
        r"\1[redacted]\2",
        redacted,
    )
    redacted = re.sub(r"\bxox[baprs]-[0-9a-zA-Z-]{10,}\b", "[redacted_slack_token]", redacted)
    redacted = re.sub(r"\bAIza[0-9A-Za-z_-]{20,}\b", "[redacted_google_key]", redacted)
    return redacted


def find_uv_runner() -> list[str]:
    """Finds uvx or uv to execute the pinned uv tool version. Only invoked on --refresh."""
    uvx_bin = shutil.which("uvx")
    if not uvx_bin:
        local_uvx = Path.home() / ".local" / "bin" / "uvx"
        if local_uvx.exists() and os.access(local_uvx, os.X_OK):
            uvx_bin = str(local_uvx)
    if uvx_bin:
        return [uvx_bin, "--from", f"uv=={PINNED_UV_VERSION}", "uv"]

    uv_bin = shutil.which("uv")
    if not uv_bin:
        local_uv = Path.home() / ".local" / "bin" / "uv"
        if local_uv.exists() and os.access(local_uv, os.X_OK):
            uv_bin = str(local_uv)
    if uv_bin:
        return [uv_bin, "tool", "run", "--from", f"uv=={PINNED_UV_VERSION}", "uv"]

    raise RuntimeError(
        f"Neither 'uvx' nor 'uv' executable was found. Maintainers must install uv to run --refresh: "
        "https://github.com/astral-sh/uv"
    )


def compile_closure(req_in_path: Path = REQ_IN) -> str:
    """Invokes pinned uv to resolve and compile the dependency closure with hashes."""
    runner = find_uv_runner()
    rel_req_in = os.path.relpath(req_in_path, REPO_ROOT)
    cmd = runner + [
        "pip",
        "compile",
        rel_req_in,
        "--python-version",
        "3.13",
        "--python-platform",
        "linux",
        "--generate-hashes",
    ]
    res = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
    if res.returncode != 0:
        redacted_stderr = redact_diagnostics(res.stderr)
        redacted_stdout = redact_diagnostics(res.stdout)
        msg = f"uv pip compile failed (exit code {res.returncode}):\n{redacted_stderr}"
        if redacted_stdout:
            msg += f"\n{redacted_stdout}"
        raise RuntimeError(msg)
    normalized_stdout = re.sub(
        r"# via -r .*?docker/hermes/requirements\.in",
        "# via -r docker/hermes/requirements.in",
        res.stdout,
    )
    scan_for_credentials(normalized_stdout, "uv pip compile output")
    return normalized_stdout


def compute_normalized_closure_digest(blocks: list[str]) -> str:
    """Computes deterministic SHA-256 digest of normalized (name==version, sorted hashes) closure."""
    if not blocks:
        raise ValueError("Cannot compute normalized closure digest from empty package blocks")

    parsed_pkgs: dict[str, tuple[str, list[str]]] = {}
    for block in blocks:
        scan_for_credentials(block, "closure package block")
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            raise ValueError("Encountered empty package block in closure")
        header = lines[0].rstrip("\\").strip()
        m = re.match(r"^([a-zA-Z0-9_.-]+)==([a-zA-Z0-9_.-]+)$", header)
        if not m:
            raise ValueError(
                f"Invalid package header in closure block (must be exact 'name==version'): '{lines[0]}'"
            )
        pkg_norm = normalize_name(m.group(1))
        version = m.group(2)
        hashes: list[str] = []
        for hline in lines[1:]:
            clean_h = hline.rstrip("\\").strip()
            if clean_h.startswith("#"):
                continue
            if not re.match(r"^--hash=sha256:[a-f0-9]{64}$", clean_h):
                raise ValueError(
                    f"Invalid or malformed hash line in closure block for '{pkg_norm}': '{hline}'"
                )
            hashes.append(clean_h)

        if not hashes:
            raise ValueError(f"Package '{pkg_norm}=={version}' has no sha256 distribution hashes")
        if pkg_norm in parsed_pkgs:
            raise ValueError(f"Duplicate package '{pkg_norm}' declared in closure blocks")

        parsed_pkgs[pkg_norm] = (version, sorted(hashes))

    canonical_lines = []
    for pkg in sorted(parsed_pkgs.keys()):
        ver, hashes = parsed_pkgs[pkg]
        canonical_lines.append(f"{pkg}=={ver}")
        for h in hashes:
            canonical_lines.append(f"    {h}")
    canonical_text = "\n".join(canonical_lines) + "\n"
    return hashlib.sha256(canonical_text.encode("utf-8")).hexdigest()


def parse_package_blocks(raw_output: str) -> list[str]:
    """Parses individual package blocks from raw compile output or chunk content."""
    blocks: list[str] = []
    current: list[str] = []
    for line in raw_output.splitlines(keepends=True):
        stripped = line.strip()
        if (
            stripped.startswith("# This file was autogenerated")
            or stripped.startswith("#    uv pip compile")
            or stripped.startswith("# Autogenerated chunk")
        ):
            continue
        if stripped and not stripped.startswith("#") and not stripped.startswith("--hash"):
            if current:
                blocks.append("".join(current))
                current = []
        if current or (stripped and not stripped.startswith("#")):
            current.append(line)
    if current:
        blocks.append("".join(current))
    return blocks


def chunk_blocks(blocks: list[str]) -> list[list[str]]:
    """Greedily and deterministically partitions package blocks into reviewable chunks."""
    chunks: list[list[str]] = []
    curr_chunk: list[str] = []
    curr_lines = 0
    curr_bytes = 0

    for block in blocks:
        b_lines = block.count("\n")
        b_bytes = len(block.encode("utf-8"))
        if curr_chunk and (
            curr_lines + b_lines > MAX_CHUNK_LINES
            or curr_bytes + b_bytes > MAX_CHUNK_BYTES
        ):
            chunks.append(curr_chunk)
            curr_chunk = []
            curr_lines = 0
            curr_bytes = 0
        curr_chunk.append(block)
        curr_lines += b_lines
        curr_bytes += b_bytes

    if curr_chunk:
        chunks.append(curr_chunk)
    return chunks


def build_generated_files(chunks: list[list[str]]) -> dict[str, str]:
    """Builds index and chunk file string mappings."""
    files: dict[str, str] = {}
    top_level_lines = [
        "# Autogenerated top-level Hermes requirements index.\n",
        "# Resolves the full hash-locked dependency closure via chunk includes.\n",
        "# Each include file is sized <250 lines and <20KB for code review integrity.\n",
        "# Regenerate with: python3 scripts/compile-hermes-requirements.py --refresh\n",
    ]

    for idx, chunk in enumerate(chunks, 1):
        filename = f"requirements-{idx:02d}.txt"
        top_level_lines.append(f"-r {filename}\n")
        chunk_content = (
            f"# Autogenerated chunk {idx:02d} by scripts/compile-hermes-requirements.py. Do not edit directly.\n"
            + "".join(chunk)
        )
        files[filename] = chunk_content

    files["requirements.txt"] = "".join(top_level_lines)
    return files


def normalize_name(name: str) -> str:
    """Normalizes package name per PEP 503."""
    return re.sub(r"[-_.]+", "-", name).lower()


def validate_committed_closure(hermes_dir: Path | None = None) -> str:
    """
    Offline deterministic validator. Does NOT invoke uv, resolve indexes, or access network.
    Validates:
      1. requirements.in top-level pins are defined with exact '==' pins.
      2. requirements.txt exists, contains only header comments and sorted sequential '-r requirements-XX.txt' lines.
      3. All referenced chunk files exist, and no unreferenced chunk files exist on disk.
      4. Chunk size invariants: each chunk is <250 lines and <20KB.
      5. Exact pins and structure: every package entry in chunks uses exact '==' pinning and valid sha256 hashes.
      6. No duplicates: no package is declared more than once across chunks.
      7. Canonical sort order: package entries across chunks are sorted in alphabetical order.
      8. Requirements.in representation: every top-level package and version is present in the closure.
      9. Reconstructed canonical content invariants: reconstructing blocks across chunks and re-chunking
         matches the committed chunk files byte-for-byte.
     10. Multi-architecture hashes: cffi block carries wheel hashes for multiple linux architectures.
     11. Normalized closure digest: mandatory requirements.digest exists, is well-formed, and matches computed digest.

    Returns the computed normalized closure digest string.
    """
    target_dir = hermes_dir.resolve() if hermes_dir else HERMES_DIR
    req_in_path = target_dir / "requirements.in"
    req_txt_path = target_dir / "requirements.txt"
    req_digest_path = target_dir / "requirements.digest"

    # 1. requirements.in
    if not req_in_path.exists():
        raise ValueError(f"requirements.in not found at {req_in_path}")

    req_in_content = req_in_path.read_text(encoding="utf-8")
    scan_for_credentials(req_in_content, req_in_path.name)
    top_level_pins: dict[str, tuple[str, str]] = {}  # norm_name -> (version, raw_line)
    for line in req_in_content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Extras (e.g. [mcp,anthropic]) are resolver features resolved into the closure
        # by pinned uv refresh rather than standalone distribution packages.
        m = re.match(r"^([a-zA-Z0-9_.-]+)(?:\[[a-zA-Z0-9_.,-]+\])?==([a-zA-Z0-9_.-]+)$", line)
        if not m:
            raise ValueError(f"requirements.in entry must be an exact '==' pin: '{line}'")
        pkg_name = normalize_name(m.group(1))
        version = m.group(2)
        top_level_pins[pkg_name] = (version, line)

    # 2. requirements.txt index
    if not req_txt_path.exists():
        raise ValueError(f"requirements.txt not found at {req_txt_path}")

    req_txt_content = req_txt_path.read_text(encoding="utf-8")
    scan_for_credentials(req_txt_content, req_txt_path.name)
    req_txt_lines = req_txt_content.splitlines()

    if not req_txt_lines or not req_txt_lines[0].startswith("# Autogenerated top-level Hermes requirements index."):
        raise ValueError(f"{req_txt_path} missing expected autogenerated header")

    included_chunks: list[str] = []
    for line in req_txt_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^-r\s+(requirements-\d{2}\.txt)$", stripped)
        if not m:
            raise ValueError(
                f"{req_txt_path} contains invalid line (must be '-r requirements-XX.txt' or comment): '{stripped}'"
            )
        included_chunks.append(m.group(1))

    if not included_chunks:
        raise ValueError(f"{req_txt_path} does not include any chunk files")

    expected_includes = [f"requirements-{idx:02d}.txt" for idx in range(1, len(included_chunks) + 1)]
    if included_chunks != expected_includes:
        raise ValueError(
            f"{req_txt_path} includes are not strictly sequential and sorted.\n"
            f"Expected: {expected_includes}\n"
            f"Found:    {included_chunks}"
        )

    # 3. Chunk files on disk vs requirements.txt
    disk_chunks = sorted(p.name for p in target_dir.glob("requirements-*.txt"))
    if disk_chunks != included_chunks:
        missing_on_disk = set(included_chunks) - set(disk_chunks)
        unreferenced_on_disk = set(disk_chunks) - set(included_chunks)
        msg_parts = []
        if missing_on_disk:
            msg_parts.append(f"Referenced in {req_txt_path.name} but missing on disk: {sorted(missing_on_disk)}")
        if unreferenced_on_disk:
            msg_parts.append(f"Present on disk but unreferenced in {req_txt_path.name}: {sorted(unreferenced_on_disk)}")
        raise ValueError("Chunk file mismatch: " + "; ".join(msg_parts))

    # 4 & 5. Chunk inspection and package block validation
    all_blocks: list[str] = []
    seen_packages: dict[str, tuple[str, str]] = {}  # norm_name -> (version, chunk_name)
    ordered_package_names: list[str] = []

    for idx, chunk_name in enumerate(included_chunks, 1):
        chunk_path = target_dir / chunk_name
        chunk_content = chunk_path.read_text(encoding="utf-8")
        scan_for_credentials(chunk_content, chunk_name)
        chunk_lines = chunk_content.splitlines(keepends=True)
        chunk_bytes = len(chunk_content.encode("utf-8"))

        if len(chunk_lines) >= HARD_MAX_CHUNK_LINES:
            raise ValueError(
                f"{chunk_name} exceeds line limit: {len(chunk_lines)} lines >= {HARD_MAX_CHUNK_LINES}"
            )
        if chunk_bytes >= HARD_MAX_CHUNK_BYTES:
            raise ValueError(
                f"{chunk_name} exceeds byte limit: {chunk_bytes} bytes >= {HARD_MAX_CHUNK_BYTES}"
            )

        expected_chunk_header = (
            f"# Autogenerated chunk {idx:02d} by scripts/compile-hermes-requirements.py. Do not edit directly."
        )
        if not chunk_lines or chunk_lines[0].strip() != expected_chunk_header:
            raise ValueError(
                f"{chunk_name} does not start with expected header:\n  Expected: {expected_chunk_header}\n  Found:    {chunk_lines[0].strip() if chunk_lines else '<empty>'}"
            )

        parsed_blocks = parse_package_blocks(chunk_content)
        if not parsed_blocks:
            raise ValueError(f"{chunk_name} contains no package blocks")

        for block in parsed_blocks:
            scan_for_credentials(block, f"{chunk_name} block")
            all_blocks.append(block)
            block_lines = [l.strip() for l in block.splitlines() if l.strip()]
            header_line = block_lines[0]
            if not header_line.endswith("\\"):
                raise ValueError(
                    f"Package header '{header_line}' in {chunk_name} must end with continuation backslash '\\'"
                )
            clean_header = header_line[:-1].strip()

            pkg_match = re.match(r"^([a-zA-Z0-9_.-]+)==([a-zA-Z0-9_.-]+)$", clean_header)
            if not pkg_match:
                raise ValueError(
                    f"Package in {chunk_name} is not an exact '==' pin: '{header_line}'"
                )

            pkg_name_raw, pkg_version = pkg_match.group(1), pkg_match.group(2)
            norm_name = normalize_name(pkg_name_raw)

            if norm_name in seen_packages:
                prev_version, prev_chunk = seen_packages[norm_name]
                raise ValueError(
                    f"Duplicate package '{norm_name}' found in {chunk_name} (previously declared in {prev_chunk} as {prev_version})"
                )
            seen_packages[norm_name] = (pkg_version, chunk_name)
            ordered_package_names.append(norm_name)

            hash_lines = [l for l in block_lines[1:] if not l.startswith("#")]
            if not hash_lines:
                raise ValueError(
                    f"Package '{pkg_name_raw}=={pkg_version}' in {chunk_name} has no sha256 distribution hashes"
                )
            for i, hline in enumerate(hash_lines):
                is_final = (i == len(hash_lines) - 1)
                if is_final:
                    if hline.endswith("\\"):
                        raise ValueError(
                            f"Final hash line for package '{pkg_name_raw}' in {chunk_name} must not end with backslash: '{hline}'"
                        )
                    clean_hline = hline.strip()
                else:
                    if not hline.endswith("\\"):
                        raise ValueError(
                            f"Non-final hash line for package '{pkg_name_raw}' in {chunk_name} must end with continuation backslash '\\': '{hline}'"
                        )
                    clean_hline = hline[:-1].strip()

                if not re.match(r"^--hash=sha256:[a-f0-9]{64}$", clean_hline):
                    raise ValueError(
                        f"Unexpected or malformed line in {chunk_name} for package '{pkg_name_raw}': '{hline}'"
                    )

    # 6. Alphabetical ordering invariant
    if ordered_package_names != sorted(ordered_package_names):
        for i in range(len(ordered_package_names) - 1):
            if ordered_package_names[i] > ordered_package_names[i + 1]:
                raise ValueError(
                    f"Package order in chunks is not canonically sorted: "
                    f"'{ordered_package_names[i]}' precedes '{ordered_package_names[i + 1]}'"
                )

    # 7. requirements.in representation (extras are resolver features, not standalone packages)
    for req_name, (req_version, req_raw) in top_level_pins.items():
        if req_name not in seen_packages:
            raise ValueError(
                f"Top-level requirement '{req_raw}' from requirements.in is not represented in closure chunks"
            )
        closed_version, closed_chunk = seen_packages[req_name]
        if closed_version != req_version:
            raise ValueError(
                f"Version mismatch for top-level requirement '{req_name}': "
                f"requirements.in specifies {req_version}, but closure in {closed_chunk} has {closed_version}"
            )

    # 8. Reconstructed canonical content invariants:
    # Re-chunking all parsed package blocks using canonical greedy chunking must match disk chunks exactly.
    rechunked = chunk_blocks(all_blocks)
    if len(rechunked) != len(included_chunks):
        raise ValueError(
            f"Reconstructed chunk count mismatch: re-chunking produced {len(rechunked)} chunks, "
            f"but disk has {len(included_chunks)} chunks"
        )

    for idx, (expected_chunk_blocks, chunk_name) in enumerate(zip(rechunked, included_chunks), 1):
        expected_content = (
            f"# Autogenerated chunk {idx:02d} by scripts/compile-hermes-requirements.py. Do not edit directly.\n"
            + "".join(expected_chunk_blocks)
        )
        actual_content = (target_dir / chunk_name).read_text(encoding="utf-8")
        if actual_content != expected_content:
            raise ValueError(
                f"Canonical content invariant violated: {chunk_name} differs from reconstructed canonical output"
            )

    # Multi-architecture hashes check scoped to cffi block only
    cffi_block = next((b for b in all_blocks if re.match(r"^cffi==[a-zA-Z0-9_.-]+", b.strip())), None)
    if cffi_block:
        cffi_hashes = re.findall(r"--hash=sha256:[a-f0-9]{64}", cffi_block)
        if len(cffi_hashes) < 5:
            raise ValueError(
                f"Expected multi-architecture wheel hashes for cffi block, found only {len(cffi_hashes)}"
            )

    # 9. Normalized closure digest check (mandatory offline verification)
    if not req_digest_path.exists():
        raise ValueError(f"requirements.digest is mandatory but was not found at {req_digest_path}")

    digest_content = req_digest_path.read_text(encoding="utf-8")
    scan_for_credentials(digest_content, req_digest_path.name)
    digest_lines = [l.strip() for l in digest_content.splitlines() if l.strip()]
    if not digest_lines:
        raise ValueError(f"{req_digest_path.name} is empty or malformed: expected exactly one sha256 hex digest")
    if len(digest_lines) > 1:
        raise ValueError(
            f"{req_digest_path.name} contains multiple or duplicate lines: expected exactly one sha256 hex digest"
        )

    expected_digest = digest_lines[0]
    if not re.match(r"^[a-f0-9]{64}$", expected_digest):
        raise ValueError(
            f"{req_digest_path.name} contains malformed digest '{expected_digest}': expected 64-char lowercase hex sha256"
        )

    computed_digest = compute_normalized_closure_digest(all_blocks)
    if computed_digest != expected_digest:
        raise ValueError(
            f"Normalized closure digest mismatch against {req_digest_path.name}:\n"
            f"  Expected: {expected_digest}\n"
            f"  Computed: {computed_digest}"
        )

    return computed_digest


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--hermes-dir",
        type=Path,
        default=None,
        help="Custom requirements directory (default: docker/hermes relative to repo root)",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Custom repo root directory (default: parent of scripts/)",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--check",
        action="store_true",
        help="Offline deterministic drift and integrity verification of committed requirements (no uv or network required)",
    )
    group.add_argument(
        "--print-digest",
        action="store_true",
        help="Offline deterministic output of normalized closure digest to stdout",
    )
    group.add_argument(
        "--refresh",
        action="store_true",
        help=f"Opt-in regeneration of requirements closure from requirements.in using pinned uv ({PINNED_UV_VERSION})",
    )
    args = parser.parse_args()

    if args.hermes_dir:
        hermes_dir = args.hermes_dir.resolve()
    elif args.root:
        hermes_dir = (args.root.resolve() / "docker" / "hermes").resolve()
    else:
        hermes_dir = HERMES_DIR

    if args.check:
        try:
            validate_committed_closure(hermes_dir)
            print("OK: Hermes requirements hash lock closure and chunks match exactly (no drift, fully offline).")
            return 0
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1

    if args.print_digest:
        try:
            digest = validate_committed_closure(hermes_dir)
            print(digest)
            return 0
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1

    if args.refresh:
        print(f"Resolving dependencies with pinned uv=={PINNED_UV_VERSION}...")
        req_in_path = hermes_dir / "requirements.in"
        req_digest_path = hermes_dir / "requirements.digest"
        raw_closure = compile_closure(req_in_path)
        blocks = parse_package_blocks(raw_closure)
        chunks = chunk_blocks(blocks)
        generated = build_generated_files(chunks)

        # Clear existing chunk files
        for chunk_file in hermes_dir.glob("requirements-*.txt"):
            chunk_file.unlink()

        # Write generated chunk files and index
        for filename, content in generated.items():
            out_path = hermes_dir / filename
            out_path.write_text(content, encoding="utf-8")
            lines = content.count("\n")
            bytes_count = len(content.encode("utf-8"))
            print(f"Wrote {filename}: {lines} lines, {bytes_count} bytes")

        # Write deterministic normalized closure digest
        digest = compute_normalized_closure_digest(blocks)
        req_digest_path.write_text(f"{digest}\n", encoding="utf-8")
        print(f"Wrote {req_digest_path.name}: {digest}")

        # Validate newly written files against all invariants
        validate_committed_closure(hermes_dir)
        print(
            f"Successfully compiled and split {len(blocks)} packages into {len(chunks)} chunks "
            f"using uv=={PINNED_UV_VERSION}."
        )
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
