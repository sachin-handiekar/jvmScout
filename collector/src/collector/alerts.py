"""Alert evaluation + notification.

The UI persists alert rules in the ``alert_rules`` config table but, until now,
nothing acted on them. This module closes that gap: on every ingested exception
it evaluates the enabled rules and delivers a notification when one matches.

Design notes / honesty boundaries:
  * Evaluation runs off the ingest path as a fire-and-forget task so a slow or
    failing notifier never blocks or fails ingest.
  * Delivery is real over HTTP for ``webhook`` and ``slack`` (a Slack incoming
    webhook is just an HTTP POST of ``{"text": ...}``). ``email`` and
    ``pagerduty`` need infrastructure/credentials this build doesn't have, so
    they are logged as unsupported and the rule is NOT marked as triggered —
    we never claim to have sent something we didn't.
  * ``last_triggered_at`` is written back to the rule only after a successful
    delivery; it also debounces re-firing (see ``_DEBOUNCE``).
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from . import storage
from .config import settings
from .metrics import metrics

log = logging.getLogger("collector.alerts")

# HTTP-deliverable channels. email/pagerduty are intentionally excluded.
_HTTP_CHANNELS = {"webhook", "slack"}

# Minimum gap between two firings of the same rule, to avoid notification storms
# on high-volume events. volume_threshold/event_reoccurs additionally respect
# their own window.
_MIN_REFIRE_S = 60.0

_DELIVERY_TIMEOUT_S = 5.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(s: Optional[str]) -> Optional[float]:
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


class _RuleCache:
    """Short-TTL, per-project cache of alert rules so ingest doesn't read the DB
    per event but still picks up UI edits within a few seconds. Rules are scoped
    to the event's tenant (NULL project = the default)."""

    def __init__(self, ttl_s: float = 5.0) -> None:
        self._ttl = ttl_s
        self._by_project: dict[Optional[str], tuple[float, list[dict]]] = {}

    async def get(self, project_id: Optional[str]) -> list[dict]:
        now = time.monotonic()
        ent = self._by_project.get(project_id)
        if ent and now - ent[0] <= self._ttl:
            return ent[1]
        rules = await storage.list_config("alert_rules", project_id=project_id)
        self._by_project[project_id] = (now, rules)
        return rules

    def reset(self) -> None:
        self._by_project = {}


rule_cache = _RuleCache()


def _scope_deployment(rule: dict) -> Optional[str]:
    """In this data model an application and its deployment are both keyed off
    deployment_id, so either scope maps to the same column."""
    return rule.get("application_id") or rule.get("deployment_id")


def _matches_scope(rule: dict, ev: dict) -> bool:
    scope = _scope_deployment(rule)
    if not scope:
        return True
    return (ev.get("deploymentId") or ev.get("deployment_id")) == scope


def _event_fields(ev: dict) -> dict:
    """Normalize the agent's camelCase ingest payload to the few fields the
    evaluator needs. Fingerprint arrives as an int on the wire but is stored as a
    string, so coerce it to match the persisted column."""
    fp = ev.get("fingerprint")
    return {
        "fingerprint": "" if fp is None else str(fp),
        "exception_type": ev.get("exceptionType") or ev.get("exception_type") or "",
        "deployment_id": ev.get("deploymentId") or ev.get("deployment_id"),
        "environment": ev.get("environment"),
        "caught": ev.get("caught"),
    }


async def _condition_met(rule: dict, ev: dict, fields: dict,
                         project_id: Optional[str]) -> Optional[str]:
    """Return a human-readable reason if the rule should fire, else None."""
    trigger = rule.get("trigger_type")
    cfg = rule.get("config") or {}
    scope_dep = _scope_deployment(rule)

    if trigger in ("new_event", "deploy_regression"):
        # First-ever occurrence of this fingerprint (the just-stored row is the
        # only one) within the tenant. deploy_regression is the same signal,
        # scoped to a deployment.
        if await storage.fingerprint_row_count(
                fields["fingerprint"], project_id=project_id) <= 1:
            return f"New exception class {fields['exception_type']} first seen"
        return None

    if trigger == "event_reoccurs":
        wanted = (cfg.get("eventName") or "").strip()
        if wanted and wanted.lower() in (fields["exception_type"] or "").lower():
            return f"{fields['exception_type']} reoccurred"
        return None

    if trigger == "volume_threshold":
        threshold = int(cfg.get("threshold") or 0)
        window = int(cfg.get("windowMinutes") or 5)
        if threshold <= 0:
            return None
        count = await storage.count_occurrences(
            minutes=window, deployment_id=scope_dep, project_id=project_id)
        if count >= threshold:
            return f"{count} occurrences in {window}m (threshold {threshold})"
        return None

    return None


def _build_message(rule: dict, ev: dict, fields: dict, reason: str) -> dict:
    """Notification payload. Slack wants a top-level ``text``; generic webhooks
    receive the structured object too."""
    title = f"[jvmScout] {rule.get('name') or 'Alert'}"
    body = (
        f"{title}\n"
        f"{reason}\n"
        f"Type: {fields['exception_type'] or 'unknown'}\n"
        f"Deployment: {fields['deployment_id'] or '(none)'}\n"
        f"Fingerprint: {fields['fingerprint']}"
    )
    return {
        "text": body,
        "alert": rule.get("name"),
        "reason": reason,
        "trigger_type": rule.get("trigger_type"),
        "exception_type": fields["exception_type"],
        "deployment_id": fields["deployment_id"],
        "environment": fields["environment"],
        "fingerprint": fields["fingerprint"],
        "fired_at": _now_iso(),
    }


async def _destination_allowed(url: str) -> bool:
    """SSRF guard: alert destinations are tenant-admin-controlled, so by default
    the collector refuses to POST anywhere that doesn't resolve to a public
    address (no loopback/RFC1918/link-local/metadata endpoints). Operators whose
    webhook receivers live on an internal network opt out with
    COLLECTOR_ALERT_ALLOW_PRIVATE=1."""
    if settings.alert_allow_private:
        return True
    host = urlparse(url).hostname
    if not host:
        return False
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        # is_global is False for loopback, RFC1918, link-local (incl. the cloud
        # metadata range), CGNAT, and reserved space.
        if not ip.is_global:
            return False
    return True


async def _deliver(rule: dict, payload: dict) -> bool:
    """Attempt delivery. Returns True only if the notification was actually sent."""
    channel = rule.get("channel")
    target = (rule.get("target") or "").strip()
    config = rule.get("config") or {}
    destination = (config.get("destination") or target).strip()

    if channel not in _HTTP_CHANNELS:
        log.info("alert rule %s: channel %r not supported in this build; not delivered",
                 rule.get("id"), channel)
        return False
    if not destination.startswith(("http://", "https://")):
        log.warning("alert rule %s: %s destination %r is not an http(s) URL",
                    rule.get("id"), channel, destination)
        return False
    if not await _destination_allowed(destination):
        log.warning("alert rule %s: destination %r resolves to a non-public "
                    "address; delivery blocked (set COLLECTOR_ALERT_ALLOW_PRIVATE=1 "
                    "to allow internal webhooks)", rule.get("id"), destination)
        return False

    try:
        async with httpx.AsyncClient(timeout=_DELIVERY_TIMEOUT_S) as client:
            resp = await client.post(destination, json=payload)
        if resp.status_code >= 400:
            log.warning("alert rule %s: delivery to %s returned %s",
                        rule.get("id"), channel, resp.status_code)
            return False
        return True
    except Exception:
        log.warning("alert rule %s: delivery to %s failed",
                    rule.get("id"), channel, exc_info=True)
        return False


def _debounced(rule: dict) -> bool:
    """True if a rate-based rule fired too recently to fire again.

    new_event/deploy_regression are NOT time-debounced: they self-dedupe (they
    only fire on a fingerprint's first-ever occurrence), and each distinct new
    exception class is independently worth a notification. Only the inherently
    rate-based triggers (volume_threshold/event_reoccurs), which would otherwise
    fire on every matching event, get the anti-storm cool-down."""
    if rule.get("trigger_type") in ("new_event", "deploy_regression"):
        return False
    last = _parse_iso(rule.get("last_triggered_at"))
    if last is None:
        return False
    cfg = rule.get("config") or {}
    window_s = max(_MIN_REFIRE_S, float(cfg.get("windowMinutes") or 0) * 60.0)
    return (time.time() - last) < window_s


async def _evaluate_rule(rule: dict, ev: dict, fields: dict,
                         project_id: Optional[str]) -> bool:
    """Evaluate one rule; deliver + record if it fires. Returns True if delivered."""
    if not rule.get("enabled"):
        return False
    if not _matches_scope(rule, ev):
        return False
    if _debounced(rule):
        return False
    reason = await _condition_met(rule, ev, fields, project_id)
    if not reason:
        return False
    payload = _build_message(rule, ev, fields, reason)
    delivered = await _deliver(rule, payload)
    if not delivered:
        return False
    fired_at = _now_iso()
    await storage.update_config(
        "alert_rules", str(rule.get("id")), {"last_triggered_at": fired_at},
        project_id=project_id)
    rule["last_triggered_at"] = fired_at  # keep the cached copy consistent
    rule_cache.reset()  # reflect the new last_triggered_at on next read
    metrics.alerts_fired += 1
    log.info("alert rule %s fired: %s", rule.get("id"), reason)
    return True


async def evaluate_event(ev: dict, project_id: Optional[str] = None) -> int:
    """Evaluate all enabled alert rules against one ingested exception event,
    scoped to the event's tenant. Returns the number of rules that fired
    (delivered). Never raises — alerting must not break ingest."""
    try:
        rules = await rule_cache.get(project_id)
    except Exception:
        log.warning("could not load alert rules", exc_info=True)
        return 0
    if not rules:
        return 0
    fields = _event_fields(ev)
    if not fields["fingerprint"]:
        return 0
    fired = 0
    for rule in rules:
        try:
            if await _evaluate_rule(rule, ev, fields, project_id):
                fired += 1
        except Exception:
            log.warning("alert rule %s evaluation error", rule.get("id"), exc_info=True)
    return fired


# --- bounded evaluation worker ----------------------------------------------
# Evaluations run on ONE consumer task fed by a bounded queue, instead of one
# fire-and-forget task per ingested event: an exception storm must not fan out
# into thousands of concurrent DB-scanning tasks on the ingest event loop.
# When the queue is full, evaluations are skipped (counted + logged sparsely) —
# losing an alert check under storm load is preferable to sinking ingest.

_QUEUE_MAX = 1000

_queue: Optional[asyncio.Queue] = None
_worker: Optional[asyncio.Task] = None
_skipped = 0


def start_worker() -> None:
    """Start the evaluation consumer on the current event loop (lifespan)."""
    global _queue, _worker
    if _worker is not None and not _worker.done():
        return
    _queue = asyncio.Queue(maxsize=_QUEUE_MAX)
    _worker = asyncio.get_running_loop().create_task(_consume())


async def stop_worker() -> None:
    global _queue, _worker
    if _worker is not None:
        _worker.cancel()
        try:
            await _worker
        except asyncio.CancelledError:
            pass
        except Exception:
            log.warning("alert worker exited abnormally", exc_info=True)
    _worker = None
    _queue = None


async def _consume() -> None:
    assert _queue is not None
    while True:
        ev, project_id = await _queue.get()
        try:
            await evaluate_event(ev, project_id)
        except Exception:
            log.warning("alert evaluation crashed", exc_info=True)
        finally:
            _queue.task_done()


def schedule_evaluation(ev: dict, project_id: Optional[str] = None) -> None:
    """Queue an evaluation off the ingest path so ingest latency is unaffected."""
    global _skipped
    if _queue is not None:
        try:
            _queue.put_nowait((ev, project_id))
        except asyncio.QueueFull:
            _skipped += 1
            metrics.alerts_skipped += 1
            if _skipped == 1 or _skipped % 1000 == 0:
                log.warning("alert queue full; %d evaluations skipped so far",
                            _skipped)
        return
    # Worker not started (bare unit-test contexts): fall back to a task.
    try:
        asyncio.get_running_loop().create_task(_run_safely(ev, project_id))
    except RuntimeError:
        log.debug("no running loop; skipping alert evaluation")


async def _run_safely(ev: dict, project_id: Optional[str]) -> None:
    try:
        await evaluate_event(ev, project_id)
    except Exception:
        log.warning("alert evaluation task crashed", exc_info=True)
