"""Apply user-managed redaction rules to captured events on ingest.

The dashboard's Redaction screen manages `redaction_rules` rows:
  - kind="identifier": `value` is a local-variable name; matching locals have
    their captured value masked (case-insensitive substring match).
  - kind="pattern":    `value` is a regex; any captured string (local values
    and the exception message) matching it is masked.

Redaction runs before the event is stored or broadcast, so secrets/PII in
local-variable values never get persisted or shown.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

REDACTED = "***"


@dataclass
class CompiledRules:
    identifiers: list[str] = field(default_factory=list)   # lowercased name fragments
    patterns: list[re.Pattern] = field(default_factory=list)

    @property
    def active(self) -> bool:
        return bool(self.identifiers or self.patterns)


def compile_rules(rules: list[dict]) -> CompiledRules:
    compiled = CompiledRules()
    for r in rules:
        if not r.get("enabled", True):
            continue
        value = (r.get("value") or "").strip()
        if not value:
            continue
        if (r.get("kind") or "").lower() == "identifier":
            compiled.identifiers.append(value.lower())
        else:
            try:
                compiled.patterns.append(re.compile(value))
            except re.error:
                continue  # skip invalid regexes rather than failing ingest
    return compiled


def _matches_pattern(value: Any, patterns: list[re.Pattern]) -> bool:
    if not isinstance(value, str):
        return False
    return any(p.search(value) for p in patterns)


def redact_event(raw: dict, rules: CompiledRules) -> dict:
    """Redact local-variable values + the message in-place. Returns `raw`."""
    if not rules.active or not isinstance(raw, dict):
        return raw

    # Exception message (pattern rules only).
    if rules.patterns and _matches_pattern(raw.get("exceptionMessage"), rules.patterns):
        raw["exceptionMessage"] = REDACTED

    stack = raw.get("stackTrace")
    if isinstance(stack, list):
        for frame in stack:
            if not isinstance(frame, dict):
                continue
            locals_ = frame.get("localVariables")
            if not isinstance(locals_, list):
                continue
            for lv in locals_:
                if not isinstance(lv, dict) or "value" not in lv:
                    continue
                name = (lv.get("name") or "").lower()
                if name and any(idn in name for idn in rules.identifiers):
                    lv["value"] = REDACTED
                elif _matches_pattern(lv.get("value"), rules.patterns):
                    lv["value"] = REDACTED
    return raw
