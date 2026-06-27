"""Integration tests for the collector HTTP API."""
from __future__ import annotations

from conftest import AUTH, agent_start_event, exception_event, run_async

from collector import storage


# --- health & auth ---------------------------------------------------------

def test_healthz_is_public(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_data_endpoint_requires_auth(client):
    assert client.get("/stats").status_code == 401
    assert client.get("/exceptions").status_code == 401


def test_bad_key_rejected(client):
    r = client.get("/stats", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_key_via_query_param(client):
    r = client.get("/stats", params={"key": "test-key"})
    assert r.status_code == 200


def test_key_via_x_api_key_header(client):
    r = client.get("/stats", headers={"X-API-Key": "test-key"})
    assert r.status_code == 200


# --- ingest ----------------------------------------------------------------

def test_ingest_single_exception(client):
    r = client.post("/collector", json=exception_event(), headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"accepted": 1, "failed": 0}

    items = client.get("/exceptions", headers=AUTH).json()["items"]
    assert len(items) == 1
    # fingerprint arrived as int, stored as string
    assert items[0]["fingerprint"] == "1234567890"


def test_ingest_routes_agent_start_to_instances(client):
    r = client.post("/collector", json=agent_start_event(), headers=AUTH)
    assert r.json() == {"accepted": 1, "failed": 0}

    # Should not show up as an exception...
    assert client.get("/exceptions", headers=AUTH).json()["total"] == 0
    # ...but should be a JVM instance.
    instances = client.get("/jvm-instances", headers=AUTH).json()
    assert len(instances) == 1
    assert instances[0]["instanceId"] == "inst-1"


def test_ingest_batch_with_one_bad_item(client):
    batch = [
        exception_event(),
        "not-a-dict",
        {"location": 12345},  # invalid shape: location must be an object
        exception_event(fingerprint="abc"),
    ]
    r = client.post("/collector", json=batch, headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["accepted"] == 2
    assert body["failed"] == 2
    # Good items persisted despite the bad ones.
    assert client.get("/exceptions", headers=AUTH).json()["total"] == 2


def test_ingest_invalid_json(client):
    r = client.post(
        "/collector", content=b"{not json", headers={**AUTH, "Content-Type": "application/json"}
    )
    assert r.status_code == 400


def test_ingest_body_too_large(client):
    huge = "x" * (6 * 1024 * 1024)
    r = client.post("/collector", json=exception_event(exceptionMessage=huge), headers=AUTH)
    assert r.status_code == 413


# --- filtering & detail ----------------------------------------------------

def test_exceptions_filter_by_caught(client):
    client.post("/collector", json=exception_event(caught=True), headers=AUTH)
    client.post("/collector", json=exception_event(caught=False), headers=AUTH)
    uncaught = client.get("/exceptions", params={"caught": "false"}, headers=AUTH).json()
    assert uncaught["total"] == 1
    assert uncaught["items"][0]["caught"] is False


def test_exception_detail_returns_raw(client):
    client.post("/collector", json=exception_event(), headers=AUTH)
    exc_id = client.get("/exceptions", headers=AUTH).json()["items"][0]["id"]
    detail = client.get(f"/exceptions/{exc_id}", headers=AUTH).json()
    assert detail["exceptionType"] == "java/lang/NullPointerException"


def test_detail_404(client):
    assert client.get("/exceptions/999999", headers=AUTH).status_code == 404


# --- delete ----------------------------------------------------------------

def test_delete_all_requires_confirm(client):
    client.post("/collector", json=exception_event(), headers=AUTH)
    assert client.delete("/exceptions", headers=AUTH).status_code == 400
    r = client.delete("/exceptions", params={"confirm": "true"}, headers=AUTH)
    assert r.status_code == 200
    assert r.json()["deleted"] == 1
    assert client.get("/exceptions", headers=AUTH).json()["total"] == 0


# --- api tokens (per-token auth) -------------------------------------------

def test_issued_token_grants_access(client):
    # A viewer token can read; roles are covered in detail in test_tenancy.py.
    created = client.post(
        "/tokens", json={"name": "dash-1", "role": "viewer"}, headers=AUTH).json()
    raw = created["token"]
    assert raw.startswith("stk_")
    assert created["token_prefix"] == raw[:10]
    # The raw token authenticates and can read...
    assert client.get("/stats", headers={"X-API-Key": raw}).status_code == 200
    # ...but a bogus token does not.
    assert client.get("/stats", headers={"X-API-Key": "stk_bogus"}).status_code == 401
    # The stored row never contains the raw token.
    rows = client.get("/config/api_tokens", headers=AUTH).json()
    assert all(raw not in (r.get("token_hash") or "") for r in rows)


def test_revoked_token_is_rejected(client):
    created = client.post(
        "/tokens", json={"name": "t", "role": "viewer"}, headers=AUTH).json()
    raw, tid = created["token"], created["id"]
    assert client.get("/stats", headers={"X-API-Key": raw}).status_code == 200
    client.patch(f"/config/api_tokens/{tid}",
                 json={"revoked_at": "2026-01-01T00:00:00Z"}, headers=AUTH)
    assert client.get("/stats", headers={"X-API-Key": raw}).status_code == 401


# --- redaction -------------------------------------------------------------

def _frame_with_locals(locals_):
    return [{
        "frameIndex": 0, "className": "C", "methodName": "m", "lineNumber": 1,
        "isAppCode": True, "localVariables": locals_,
    }]


def test_redaction_identifier_masks_local(client):
    client.post("/config/redaction_rules",
                json={"kind": "identifier", "name": "pw", "value": "password", "enabled": True},
                headers=AUTH)
    ev = exception_event(stackTrace=_frame_with_locals([
        {"name": "password", "value": "hunter2", "slot": 0, "source": "debug_info"},
        {"name": "user", "value": "alice", "slot": 1, "source": "debug_info"},
    ]))
    client.post("/collector", json=ev, headers=AUTH)
    exc_id = client.get("/exceptions", headers=AUTH).json()["items"][0]["id"]
    detail = client.get(f"/exceptions/{exc_id}", headers=AUTH).json()
    by_name = {lv["name"]: lv["value"] for lv in detail["stackTrace"][0]["localVariables"]}
    assert by_name["password"] == "***"
    assert by_name["user"] == "alice"


def test_redaction_pattern_masks_value_and_message(client):
    client.post("/config/redaction_rules",
                json={"kind": "pattern", "name": "card",
                      "value": r"\d{4}-\d{4}-\d{4}-\d{4}", "enabled": True},
                headers=AUTH)
    ev = exception_event(
        exceptionMessage="card 1234-5678-9012-3456 leaked",
        stackTrace=_frame_with_locals([
            {"name": "cc", "value": "1234-5678-9012-3456", "slot": 0, "source": "debug_info"},
        ]))
    client.post("/collector", json=ev, headers=AUTH)
    exc_id = client.get("/exceptions", headers=AUTH).json()["items"][0]["id"]
    detail = client.get(f"/exceptions/{exc_id}", headers=AUTH).json()
    assert detail["stackTrace"][0]["localVariables"][0]["value"] == "***"
    assert detail["exceptionMessage"] == "***"


def test_redaction_disabled_rule_is_ignored(client):
    client.post("/config/redaction_rules",
                json={"kind": "identifier", "name": "pw", "value": "password", "enabled": False},
                headers=AUTH)
    ev = exception_event(stackTrace=_frame_with_locals([
        {"name": "password", "value": "hunter2", "slot": 0, "source": "debug_info"},
    ]))
    client.post("/collector", json=ev, headers=AUTH)
    exc_id = client.get("/exceptions", headers=AUTH).json()["items"][0]["id"]
    detail = client.get(f"/exceptions/{exc_id}", headers=AUTH).json()
    assert detail["stackTrace"][0]["localVariables"][0]["value"] == "hunter2"


# --- timeseries ------------------------------------------------------------

def test_timeseries_buckets_and_counts(client):
    client.post("/collector", json=exception_event(caught=False), headers=AUTH)
    client.post("/collector", json=exception_event(caught=True, fingerprint="x"), headers=AUTH)
    ts = client.get("/stats/timeseries", params={"hours": 24, "buckets": 24}, headers=AUTH).json()
    assert len(ts["series"]) == 24
    assert sum(b["uncaught"] for b in ts["series"]) == 1
    assert sum(b["caught"] for b in ts["series"]) == 1


def test_timeseries_environment_filter(client):
    client.post("/collector", json=exception_event(environment="staging"), headers=AUTH)
    client.post("/collector", json=exception_event(environment="production", fingerprint="p"), headers=AUTH)
    ts = client.get("/stats/timeseries", params={"environment": "staging"}, headers=AUTH).json()
    assert sum(b["uncaught"] + b["caught"] for b in ts["series"]) == 1


def test_timeseries_production_includes_untagged(client):
    client.post("/collector", json=exception_event(), headers=AUTH)  # no environment set
    ts = client.get("/stats/timeseries", params={"environment": "production"}, headers=AUTH).json()
    assert sum(b["uncaught"] + b["caught"] for b in ts["series"]) == 1


# --- live websocket --------------------------------------------------------

def test_ws_live_broadcasts_exception(client):
    # The dashboard's useLiveUpdates hook relies on this broadcast contract.
    with client.websocket_connect("/ws/live?key=test-key") as ws:
        r = client.post("/collector", json=exception_event(), headers=AUTH)
        assert r.status_code == 200
        msg = ws.receive_json()
        assert msg["kind"] == "exception"
        assert "event" in msg


def test_ws_live_rejects_bad_key(client):
    import pytest
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/live?key=wrong") as ws:
            ws.receive_text()


# --- config entities -------------------------------------------------------

def test_config_crud_roundtrip(client):
    # empty to start
    assert client.get("/config/redaction_rules", headers=AUTH).json() == []

    # create -> server assigns id + created_at
    created = client.post(
        "/config/redaction_rules",
        json={"name": "mask-ssn", "kind": "regex", "value": r"\d{3}-\d{2}-\d{4}", "enabled": True},
        headers=AUTH,
    ).json()
    assert created["id"]
    assert created["name"] == "mask-ssn"

    rules = client.get("/config/redaction_rules", headers=AUTH).json()
    assert len(rules) == 1 and rules[0]["id"] == created["id"]

    # patch
    patched = client.patch(
        f"/config/redaction_rules/{created['id']}", json={"enabled": False}, headers=AUTH
    ).json()
    assert patched["enabled"] is False

    # delete
    assert client.delete(
        f"/config/redaction_rules/{created['id']}", headers=AUTH
    ).json() == {"deleted": created["id"]}
    assert client.get("/config/redaction_rules", headers=AUTH).json() == []


def test_config_unknown_table_404(client):
    assert client.get("/config/bogus", headers=AUTH).status_code == 404


def test_config_requires_auth(client):
    assert client.get("/config/team_members").status_code == 401


# --- retention -------------------------------------------------------------

def test_retention_purge_removes_old_rows(client):
    client.post("/collector", json=exception_event(), headers=AUTH)

    async def _age_and_purge():
        from sqlalchemy import update
        async with storage.session() as s:
            await s.execute(update(storage.ExceptionRow).values(received_at="2000-01-01T00:00:00Z"))
            await s.commit()
        return await storage.purge_old_records()

    purged = run_async(_age_and_purge())
    assert purged == 1
    assert client.get("/exceptions", headers=AUTH).json()["total"] == 0


# --- security headers / CSP ------------------------------------------------

def test_security_headers_present(client):
    r = client.get("/healthz")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert r.headers.get("Referrer-Policy") == "no-referrer"


def test_csp_header_present_with_script_policy(client):
    r = client.get("/healthz")
    csp = r.headers.get("Content-Security-Policy")
    assert csp is not None
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "script-src 'self'" in csp


def test_script_hashes_cover_inline_and_skip_src(client):
    from collector.app import _script_hashes
    html = (
        "<script>console.log(1)</script>"
        "<script src='/a.js'></script>"
        "<script type='module'>boot()</script>"
    )
    hashes = _script_hashes(html)
    # The two inline scripts are hashed; the src= script is skipped.
    assert len(hashes) == 2
    assert all(h.startswith("'sha256-") and h.endswith("'") for h in hashes)


def test_build_csp_env_override(client, monkeypatch):
    from collector import app as appmod
    monkeypatch.setenv("COLLECTOR_CSP", "default-src 'none'")
    assert appmod._build_csp(None) == "default-src 'none'"
    # Empty override disables CSP entirely.
    monkeypatch.setenv("COLLECTOR_CSP", "")
    assert appmod._build_csp(None) is None
