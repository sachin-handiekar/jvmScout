"""Decompile stored app-class bytecode into source for the dashboard frame view.

A JVMTI agent ships bytecode, not source (see ``source_classes``), so we
reconstruct readable Java with a bundled decompiler (CFR — a single jar run via
the JVM). Everything degrades gracefully: if no JRE / decompiler jar is present
(e.g. a slim image without the decompiler), every call returns ``None`` and the
UI simply shows "No source available".

Honesty note: decompiled code does not match the original line-for-line (names
and layout differ), so we show the decompiled *method* that threw rather than
claiming a precise failing line.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import shutil
import subprocess
import tempfile
from collections import OrderedDict
from functools import lru_cache
from typing import Optional

log = logging.getLogger("collector.decompiler")

_TIMEOUT_S = 15.0
_MAX_CACHE = 256  # decompiled classes (keyed by bytecode sha)

# sha -> decompiled source
_cache: "OrderedDict[str, Optional[str]]" = OrderedDict()


@lru_cache(maxsize=1)
def _java_exe() -> Optional[str]:
    jh = os.environ.get("JAVA_HOME")
    if jh:
        cand = os.path.join(jh, "bin", "java.exe" if os.name == "nt" else "java")
        if os.path.isfile(cand):
            return cand
    return shutil.which("java")


@lru_cache(maxsize=1)
def _decompiler_jar() -> Optional[str]:
    jar = os.environ.get("COLLECTOR_DECOMPILER_JAR")
    if jar and os.path.isfile(jar):
        return jar
    # Default location used by the Docker image.
    for cand in ("/app/cfr.jar", os.path.join(os.getcwd(), "cfr.jar")):
        if os.path.isfile(cand):
            return cand
    return None


def available() -> bool:
    """True if a JRE and decompiler jar are present (so source view can work)."""
    return bool(_java_exe() and _decompiler_jar())


def _run_cfr(class_bytes: bytes, simple_name: str) -> Optional[str]:
    java, jar = _java_exe(), _decompiler_jar()
    if not java or not jar:
        return None
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, f"{simple_name}.class")
        with open(path, "wb") as fh:
            fh.write(class_bytes)
        try:
            proc = subprocess.run(
                [java, "-jar", jar, path, "--silent", "true", "--usenametable", "true"],
                capture_output=True, text=True, timeout=_TIMEOUT_S,
            )
        except (subprocess.TimeoutExpired, OSError):
            log.warning("decompile failed for %s", simple_name, exc_info=True)
            return None
        out = proc.stdout or ""
        return out if out.strip() else None


def decompile_class(class_name_slash: str, bytecode_b64: str) -> Optional[str]:
    """Decompile a class (slash name) from its base64 bytecode. Cached by content
    sha so repeat frame views are cheap. Returns Java source or None."""
    if not bytecode_b64 or not available():
        return None
    try:
        raw = base64.b64decode(bytecode_b64)
    except (ValueError, TypeError):
        return None
    sha = hashlib.sha256(raw).hexdigest()
    if sha in _cache:
        _cache.move_to_end(sha)
        return _cache[sha]
    simple = class_name_slash.rsplit("/", 1)[-1].replace("$", "_") or "Class"
    src = _run_cfr(raw, simple)
    _cache[sha] = src
    _cache.move_to_end(sha)
    while len(_cache) > _MAX_CACHE:
        _cache.popitem(last=False)
    return src


def _extract_method(source: str, method_name: str) -> Optional[tuple[int, int]]:
    """Best-effort (start, end) line indices (0-based, inclusive) of the method's
    decompiled body, via brace matching. None if not located."""
    lines = source.split("\n")
    if method_name in ("<init>", "<clinit>"):
        # Constructor / static initializer — hard to name reliably; skip.
        return None
    # A declaration line containing `name(` not used as a call (`.name(`/`new `).
    pat = re.compile(r"(?<![.\w])" + re.escape(method_name) + r"\s*\(")
    start = None
    for i, ln in enumerate(lines):
        if pat.search(ln) and "=" not in ln.split("(")[0] and ";" not in ln:
            start = i
            break
    if start is None:
        return None
    # Find the opening brace then match to its close.
    depth = 0
    seen = False
    for j in range(start, len(lines)):
        depth += lines[j].count("{") - lines[j].count("}")
        if "{" in lines[j]:
            seen = True
        if seen and depth <= 0:
            return (start, j)
    return (start, min(start + 40, len(lines) - 1))


def build_snippet(source: str, method_name: str, line: int) -> str:
    """Format decompiled source for the UI's frame source panel. Returns lines as
    ``N: code`` (N = decompiled line number). Shows the method that threw when it
    can be located, else the whole class, prefixed with a 'decompiled' note."""
    lines = source.split("\n")
    span = _extract_method(source, method_name or "")
    if span:
        # Exactly the method's lines (padding would bleed into adjacent members).
        lo, hi = span[0], span[1] + 1
    else:
        lo, hi = 0, len(lines)
    note = "// decompiled from bytecode — names/layout may differ from source"
    out = [f"  0: {note}"]
    for idx in range(lo, hi):
        out.append(f"  {idx + 1}: {lines[idx]}")
    return "\n".join(out)
