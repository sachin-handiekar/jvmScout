"""Source-class bytecode storage + decompiled-source attachment.

The decompile path needs a JRE + CFR jar, which CI's Python-only collector job
doesn't have, so those tests skip unless a decompiler is available locally.
"""
from __future__ import annotations

import pytest

from conftest import AUTH, exception_event, run_async

from collector import decompiler, storage

# A real compiled class `p.Demo` with an `add(int,int)` method (javac, no -g),
# used to exercise the decompiler without invoking javac at test time.
DEMO_CLASS_B64 = (
    "yv66vgAAAEYADwoAAgADBwAEDAAFAAYBABBqYXZhL2xhbmcvT2JqZWN0AQAGPGluaXQ+AQADKClW"
    "BwAIAQAGcC9EZW1vAQAEQ29kZQEAD0xpbmVOdW1iZXJUYWJsZQEAA2FkZAEABShJSSlJAQAKU291"
    "cmNlRmlsZQEACURlbW8uamF2YQAgAAcAAgAAAAAAAgAAAAUABgABAAkAAAAdAAEAAQAAAAUqtwAB"
    "sQAAAAEACgAAAAYAAQAAAAIAAAALAAwAAQAJAAAAIgACAAQAAAAGGxxgPh2sAAAAAQAKAAAACgAC"
    "AAAABAAEAAUAAQANAAAAAgAO"
)


def _frame(class_name: str, method: str, line: int) -> dict:
    return {
        "frameIndex": 0, "className": class_name, "methodName": method,
        "lineNumber": line, "isAppCode": True, "sourceFile": "Demo.java",
        "localVariables": [],
    }


def test_source_class_is_stored_and_scoped(client):
    client.post("/collector",
                json={"type": "source_class", "className": "p/Demo",
                      "bytecodeB64": DEMO_CLASS_B64},
                headers=AUTH)
    # Stored under the ingesting principal's project (master -> NULL).
    got = run_async(storage.get_source_class("p/Demo", project_id=None))
    assert got == DEMO_CLASS_B64
    # A different class isn't there.
    assert run_async(storage.get_source_class("p/Other", project_id=None)) is None


@pytest.mark.skipif(not decompiler.available(),
                    reason="no JRE/CFR decompiler available")
def test_decompiled_source_attached_to_app_frame(client):
    client.post("/collector",
                json={"type": "source_class", "className": "p/Demo",
                      "bytecodeB64": DEMO_CLASS_B64},
                headers=AUTH)
    client.post("/collector",
                json=exception_event(stackTrace=[_frame("p.Demo", "add", 4)]),
                headers=AUTH)

    exc_id = client.get("/exceptions", headers=AUTH).json()["items"][0]["id"]
    detail = client.get(f"/exceptions/{exc_id}", headers=AUTH).json()
    frame = detail["stackTrace"][0]
    assert frame.get("sourceSnippet"), "expected decompiled source on the app frame"
    snippet = frame["sourceSnippet"]
    assert "decompiled from bytecode" in snippet  # honesty banner
    assert "add" in snippet                        # the method body is shown


def test_decompiler_build_snippet_extracts_method():
    # Pure-Python: method extraction + formatting, no JVM needed.
    source = (
        "class Demo {\n"
        "    int add(int a, int b) {\n"
        "        return a + b;\n"
        "    }\n"
        "    int sub(int a, int b) {\n"
        "        return a - b;\n"
        "    }\n"
        "}\n"
    )
    snip = decompiler.build_snippet(source, "add", 2)
    assert "int add" in snip
    assert "sub" not in snip            # only the throwing method is shown
    assert snip.splitlines()[0].strip().endswith("names/layout may differ from source")
