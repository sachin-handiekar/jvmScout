"""Tests for the per-fingerprint event-series endpoint and the alert engine.

Alert evaluation is normally fire-and-forget off the ingest path; here we drive
`alerts.evaluate_event` directly for deterministic assertions, and stub HTTP
delivery so no real network call is made.
"""
from __future__ import annotations

from conftest import AUTH, exception_event, run_async

from collector import alerts, storage


# --- per-fingerprint event series -----------------------------------------

def test_event_series_groups_by_fingerprint(client):
    # 2 occurrences of fp "a", 1 of fp "b".
    client.post("/collector", json=exception_event(fingerprint="a"), headers=AUTH)
    client.post("/collector", json=exception_event(fingerprint="a"), headers=AUTH)
    client.post("/collector", json=exception_event(fingerprint="b"), headers=AUTH)

    res = client.get("/stats/event-series", params={"hours": 24, "buckets": 24},
                     headers=AUTH).json()
    series = res["series"]
    assert series["a"]["total"] == 2
    assert series["b"]["total"] == 1
    assert len(series["a"]["buckets"]) == 24
    # Totals must equal the sum of their own buckets.
    assert sum(series["a"]["buckets"]) == 2
    assert sum(series["b"]["buckets"]) == 1


def test_event_series_counts_rows_not_cumulative_hit_count(client):
    # hitCount on the wire is the agent's *cumulative* lifetime counter for the
    # fingerprint, not a per-event delta: one stored event = one occurrence,
    # regardless of how large its running counter is.
    client.post("/collector", json=exception_event(fingerprint="c", hitCount=5),
                headers=AUTH)
    res = client.get("/stats/event-series", headers=AUTH).json()
    assert res["series"]["c"]["total"] == 1


def test_event_series_environment_filter(client):
    client.post("/collector", json=exception_event(fingerprint="p", environment="production"),
                headers=AUTH)
    client.post("/collector", json=exception_event(fingerprint="s", environment="staging"),
                headers=AUTH)
    res = client.get("/stats/event-series", params={"environment": "staging"},
                     headers=AUTH).json()
    assert "s" in res["series"]
    assert "p" not in res["series"]


# --- alert delivery stub ---------------------------------------------------

class _FakeResp:
    def __init__(self, status_code: int = 200) -> None:
        self.status_code = status_code


class _FakeClient:
    """Records every POST so tests can assert delivery without a network call."""

    posted: list[tuple[str, dict]] = []
    status = 200

    def __init__(self, *a, **k) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None):
        _FakeClient.posted.append((url, json))
        return _FakeResp(_FakeClient.status)


def _stub_delivery(monkeypatch):
    _FakeClient.posted = []
    _FakeClient.status = 200
    monkeypatch.setattr(alerts.httpx, "AsyncClient", _FakeClient)


def _make_rule(client, **fields) -> dict:
    payload = {
        "name": "Test rule",
        "enabled": True,
        "trigger_type": "new_event",
        "channel": "webhook",
        "target": "https://hooks.example.com/x",
        "config": {"destination": "https://hooks.example.com/x"},
        "last_triggered_at": None,
    }
    payload.update(fields)
    # POST through the route so the rule cache is reset (mirrors real usage).
    return client.post("/config/alert_rules", json=payload, headers=AUTH).json()


# --- alert engine ----------------------------------------------------------

def test_new_event_alert_fires_and_delivers(client, monkeypatch):
    _stub_delivery(monkeypatch)
    # First occurrence already stored (no rule yet -> no scheduled fire).
    client.post("/collector", json=exception_event(fingerprint="np"), headers=AUTH)
    rule = _make_rule(client, trigger_type="new_event")

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="np")))
    assert fired == 1
    assert len(_FakeClient.posted) == 1
    url, body = _FakeClient.posted[0]
    assert url == "https://hooks.example.com/x"
    assert "text" in body and body["fingerprint"] == "np"

    # last_triggered_at is recorded on the persisted rule.
    rules = client.get("/config/alert_rules", headers=AUTH).json()
    assert rules[0]["last_triggered_at"] is not None
    assert rules[0]["id"] == rule["id"]


def test_new_event_fires_for_each_distinct_class(client, monkeypatch):
    """Two genuinely-new fingerprints must both notify back-to-back; the
    anti-storm cool-down does not apply to new_event."""
    _stub_delivery(monkeypatch)
    client.post("/collector", json=exception_event(fingerprint="new1"), headers=AUTH)
    client.post("/collector", json=exception_event(fingerprint="new2"), headers=AUTH)
    _make_rule(client, trigger_type="new_event")

    f1 = run_async(alerts.evaluate_event(exception_event(fingerprint="new1")))
    f2 = run_async(alerts.evaluate_event(exception_event(fingerprint="new2")))
    assert f1 == 1 and f2 == 1
    assert len(_FakeClient.posted) == 2


def test_volume_threshold_alert_fires(client, monkeypatch):
    _stub_delivery(monkeypatch)
    for _ in range(3):
        client.post("/collector", json=exception_event(fingerprint="vol"), headers=AUTH)
    _make_rule(client, trigger_type="volume_threshold",
               config={"destination": "https://hooks.example.com/x",
                       "threshold": 2, "windowMinutes": 60})

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="vol")))
    assert fired == 1
    assert _FakeClient.posted


def test_volume_threshold_below_does_not_fire(client, monkeypatch):
    _stub_delivery(monkeypatch)
    client.post("/collector", json=exception_event(fingerprint="low"), headers=AUTH)
    _make_rule(client, trigger_type="volume_threshold",
               config={"destination": "https://hooks.example.com/x",
                       "threshold": 5, "windowMinutes": 60})

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="low")))
    assert fired == 0
    assert _FakeClient.posted == []


def test_event_reoccurs_matches_type(client, monkeypatch):
    _stub_delivery(monkeypatch)
    ev = exception_event(fingerprint="re", exceptionType="java/lang/NullPointerException")
    client.post("/collector", json=ev, headers=AUTH)
    # Create the rule after ingest so the ingest-path scheduled task can't fire
    # first and debounce this explicit evaluation.
    _make_rule(client, trigger_type="event_reoccurs",
               config={"destination": "https://hooks.example.com/x",
                       "eventName": "NullPointer"})

    fired = run_async(alerts.evaluate_event(ev))
    assert fired == 1


def test_disabled_rule_does_not_fire(client, monkeypatch):
    _stub_delivery(monkeypatch)
    client.post("/collector", json=exception_event(fingerprint="off"), headers=AUTH)
    _make_rule(client, enabled=False)

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="off")))
    assert fired == 0
    assert _FakeClient.posted == []


def test_unsupported_channel_not_delivered(client, monkeypatch):
    """email/pagerduty have no deliverer in this build, so the rule must NOT be
    marked as triggered (honesty: we never claim a send we didn't make)."""
    _stub_delivery(monkeypatch)
    client.post("/collector", json=exception_event(fingerprint="mail"), headers=AUTH)
    _make_rule(client, channel="email", target="oncall@example.com",
               config={"destination": "oncall@example.com"})

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="mail")))
    assert fired == 0
    assert _FakeClient.posted == []
    rules = client.get("/config/alert_rules", headers=AUTH).json()
    assert rules[0]["last_triggered_at"] is None


def test_failed_delivery_not_recorded(client, monkeypatch):
    _stub_delivery(monkeypatch)
    _FakeClient.status = 500  # endpoint rejects the webhook
    client.post("/collector", json=exception_event(fingerprint="fail"), headers=AUTH)
    _make_rule(client, trigger_type="new_event")

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="fail")))
    assert fired == 0
    rules = client.get("/config/alert_rules", headers=AUTH).json()
    assert rules[0]["last_triggered_at"] is None


def test_scope_filters_by_deployment(client, monkeypatch):
    _stub_delivery(monkeypatch)
    client.post("/collector",
                json=exception_event(fingerprint="scoped", deploymentId="svc-a"),
                headers=AUTH)
    # Rule scoped to a different deployment -> must not fire.
    _make_rule(client, trigger_type="new_event", application_id="svc-b")

    fired = run_async(alerts.evaluate_event(
        exception_event(fingerprint="scoped", deploymentId="svc-a")))
    assert fired == 0
    assert _FakeClient.posted == []


# --- SSRF guard on alert destinations ---------------------------------------

def test_destination_guard_blocks_non_public_addresses(monkeypatch):
    from collector.config import Settings
    monkeypatch.setattr(alerts, "settings", Settings())  # allow_private=False
    from conftest import run_async as _run
    for url in ("http://127.0.0.1/hook", "http://169.254.169.254/latest",
                "http://10.1.2.3/x", "http://192.168.1.5/x", "http://[::1]/x"):
        assert _run(alerts._destination_allowed(url)) is False, url


def test_destination_guard_permits_private_when_opted_in(monkeypatch):
    from collector.config import Settings
    monkeypatch.setattr(alerts, "settings", Settings(alert_allow_private=True))
    assert run_async(alerts._destination_allowed("http://10.1.2.3/x")) is True


# --- aggregated COUNT_ONLY summaries -----------------------------------------

def test_volume_threshold_sums_occurrences(client, monkeypatch):
    """One agent-aggregated COUNT_ONLY summary carrying occurrences=10 counts
    as 10 real throws for volume alerting."""
    _stub_delivery(monkeypatch)
    client.post("/collector",
                json=exception_event(fingerprint="agg", captureMode="COUNT_ONLY",
                                     occurrences=10),
                headers=AUTH)
    _make_rule(client, trigger_type="volume_threshold",
               config={"destination": "https://hooks.example.com/x",
                       "threshold": 10, "windowMinutes": 60})

    fired = run_async(alerts.evaluate_event(exception_event(fingerprint="agg")))
    assert fired == 1


def test_event_series_sums_occurrences(client):
    client.post("/collector",
                json=exception_event(fingerprint="occ", occurrences=7),
                headers=AUTH)
    client.post("/collector", json=exception_event(fingerprint="occ"), headers=AUTH)
    res = client.get("/stats/event-series", headers=AUTH).json()
    assert res["series"]["occ"]["total"] == 8
