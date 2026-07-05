"""Multi-tenant project scoping + role enforcement.

Each agent authenticates with a token bound to a project + role; the collector
stamps ingested events with the token's project (not anything the agent claims)
and filters every read by the caller's project. Roles split ingest (agents),
viewer (dashboards), and admin (token/config management).
"""
from __future__ import annotations

from conftest import AUTH, exception_event


def _mint(client, project_id: str, role: str) -> str:
    """Issue a token for a project+role via the master key; return the raw token."""
    r = client.post(
        "/tokens",
        json={"name": f"{project_id}-{role}", "project_id": project_id, "role": role},
        headers=AUTH,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["project_id"] == project_id and body["role"] == role
    return body["token"]


def _hdr(token: str) -> dict:
    return {"X-API-Key": token}


# --- data scoping ----------------------------------------------------------

def test_events_are_scoped_to_the_ingesting_token_project(client):
    a_ingest = _mint(client, "alpha", "ingest")
    b_ingest = _mint(client, "beta", "ingest")
    a_view = _mint(client, "alpha", "viewer")
    b_view = _mint(client, "beta", "viewer")

    client.post("/collector", json=exception_event(fingerprint="a1"), headers=_hdr(a_ingest))
    client.post("/collector", json=exception_event(fingerprint="b1"), headers=_hdr(b_ingest))

    a_items = client.get("/exceptions", headers=_hdr(a_view)).json()["items"]
    b_items = client.get("/exceptions", headers=_hdr(b_view)).json()["items"]
    assert {i["fingerprint"] for i in a_items} == {"a1"}
    assert {i["fingerprint"] for i in b_items} == {"b1"}

    # Master/superadmin sees every project.
    all_items = client.get("/exceptions", headers=AUTH).json()["items"]
    assert {"a1", "b1"} <= {i["fingerprint"] for i in all_items}


def test_agent_cannot_spoof_another_projects_data(client):
    # Even if the agent declares deploymentId, the project comes from the token.
    a_ingest = _mint(client, "alpha", "ingest")
    b_view = _mint(client, "beta", "viewer")
    client.post("/collector",
                json=exception_event(fingerprint="x", deploymentId="beta"),
                headers=_hdr(a_ingest))
    # The beta viewer must not see it (it's alpha's, by token).
    assert client.get("/exceptions", headers=_hdr(b_view)).json()["items"] == []


def test_cross_tenant_detail_is_404(client):
    a_ingest = _mint(client, "alpha", "ingest")
    a_view = _mint(client, "alpha", "viewer")
    b_view = _mint(client, "beta", "viewer")
    client.post("/collector", json=exception_event(fingerprint="a1"), headers=_hdr(a_ingest))

    # Find the row id as master.
    row_id = client.get("/exceptions", headers=AUTH).json()["items"][0]["id"]
    assert client.get(f"/exceptions/{row_id}", headers=_hdr(a_view)).status_code == 200
    assert client.get(f"/exceptions/{row_id}", headers=_hdr(b_view)).status_code == 404


def test_stats_and_instances_are_scoped(client):
    a_ingest = _mint(client, "alpha", "ingest")
    b_ingest = _mint(client, "beta", "ingest")
    a_view = _mint(client, "alpha", "viewer")
    client.post("/collector", json=exception_event(fingerprint="a1"), headers=_hdr(a_ingest))
    client.post("/collector", json=exception_event(fingerprint="a2"), headers=_hdr(a_ingest))
    client.post("/collector", json=exception_event(fingerprint="b1"), headers=_hdr(b_ingest))

    s = client.get("/stats", headers=_hdr(a_view)).json()
    assert s["totalExceptions"] == 2  # only alpha's two events


# --- role enforcement ------------------------------------------------------

def test_ingest_token_cannot_read(client):
    a_ingest = _mint(client, "alpha", "ingest")
    assert client.get("/stats", headers=_hdr(a_ingest)).status_code == 403
    assert client.get("/exceptions", headers=_hdr(a_ingest)).status_code == 403


def test_viewer_token_cannot_ingest_or_admin(client):
    a_view = _mint(client, "alpha", "viewer")
    assert client.post("/collector", json=exception_event(), headers=_hdr(a_view)).status_code == 403
    # Admin-only actions.
    assert client.post("/tokens", json={"name": "x"}, headers=_hdr(a_view)).status_code == 403
    assert client.post("/config/alert_rules", json={"name": "r"},
                       headers=_hdr(a_view)).status_code == 403
    assert client.get("/config/api_tokens", headers=_hdr(a_view)).status_code == 403


def test_project_admin_can_mint_only_for_its_project(client):
    a_admin = _mint(client, "alpha", "admin")
    # Same project: allowed; role defaults to ingest.
    ok = client.post("/tokens", json={"name": "agent"}, headers=_hdr(a_admin))
    assert ok.status_code == 200
    assert ok.json()["project_id"] == "alpha"
    # Another project: forbidden.
    bad = client.post("/tokens", json={"name": "agent", "project_id": "beta"},
                      headers=_hdr(a_admin))
    assert bad.status_code == 403


def test_project_admin_reads_only_its_project(client):
    a_admin = _mint(client, "alpha", "admin")
    b_ingest = _mint(client, "beta", "ingest")
    client.post("/collector", json=exception_event(fingerprint="b1"), headers=_hdr(b_ingest))
    # alpha admin can read (admin has read), but sees nothing from beta.
    assert client.get("/exceptions", headers=_hdr(a_admin)).json()["items"] == []


# --- per-project config (alert / redaction rules) --------------------------

def _frame_with_local(name: str, value: str):
    return [{
        "frameIndex": 0, "className": "C", "methodName": "m", "lineNumber": 1,
        "isAppCode": True,
        "localVariables": [{"name": name, "value": value, "slot": 0, "source": "debug_info"}],
    }]


def test_redaction_rules_are_per_project(client):
    a_admin = _mint(client, "alpha", "admin")
    a_ingest = _mint(client, "alpha", "ingest")
    b_ingest = _mint(client, "beta", "ingest")
    a_view = _mint(client, "alpha", "viewer")
    b_view = _mint(client, "beta", "viewer")

    # alpha defines a redaction rule; beta has none.
    client.post("/config/redaction_rules",
                json={"kind": "identifier", "name": "pw", "value": "password", "enabled": True},
                headers=_hdr(a_admin))
    frame = _frame_with_local("password", "hunter2")
    client.post("/collector", json=exception_event(fingerprint="a1", stackTrace=frame),
                headers=_hdr(a_ingest))
    client.post("/collector", json=exception_event(fingerprint="b1", stackTrace=frame),
                headers=_hdr(b_ingest))

    a_id = client.get("/exceptions", headers=_hdr(a_view)).json()["items"][0]["id"]
    a_local = client.get(f"/exceptions/{a_id}", headers=_hdr(a_view)).json()
    assert a_local["stackTrace"][0]["localVariables"][0]["value"] == "***"  # masked

    b_id = client.get("/exceptions", headers=_hdr(b_view)).json()["items"][0]["id"]
    b_local = client.get(f"/exceptions/{b_id}", headers=_hdr(b_view)).json()
    assert b_local["stackTrace"][0]["localVariables"][0]["value"] == "hunter2"  # not masked


def test_config_listing_is_scoped_per_project(client):
    a_admin = _mint(client, "alpha", "admin")
    b_admin = _mint(client, "beta", "admin")
    client.post("/config/alert_rules",
                json={"name": "alpha rule", "enabled": True, "trigger_type": "new_event"},
                headers=_hdr(a_admin))

    a_list = client.get("/config/alert_rules", headers=_hdr(a_admin)).json()
    b_list = client.get("/config/alert_rules", headers=_hdr(b_admin)).json()
    m_list = client.get("/config/alert_rules", headers=AUTH).json()

    assert [r["name"] for r in a_list] == ["alpha rule"]
    assert a_list[0]["project_id"] == "alpha"
    assert b_list == []  # beta cannot see alpha's rule
    assert any(r["name"] == "alpha rule" for r in m_list)  # master sees all


# --- live WebSocket fan-out ------------------------------------------------

def test_ws_only_receives_own_project_events(client):
    a_ingest = _mint(client, "alpha", "ingest")
    b_ingest = _mint(client, "beta", "ingest")
    a_view = _mint(client, "alpha", "viewer")

    with client.websocket_connect(f"/ws/live?key={a_view}") as ws:
        # A beta event must be filtered out; the alpha event must arrive.
        client.post("/collector", json=exception_event(fingerprint="b1"), headers=_hdr(b_ingest))
        client.post("/collector", json=exception_event(fingerprint="a1"), headers=_hdr(a_ingest))
        msg = ws.receive_json()
        assert msg["kind"] == "exception"
        assert msg["event"]["fingerprint"] == "a1"  # not the beta event


# --- agent_start instance ownership ------------------------------------------

def test_agent_start_cannot_hijack_another_projects_instance(client):
    from conftest import agent_start_event
    a_ingest = _mint(client, "alpha", "ingest")
    b_ingest = _mint(client, "beta", "ingest")
    a_view = _mint(client, "alpha", "viewer")
    b_view = _mint(client, "beta", "viewer")

    r = client.post("/collector", json=agent_start_event(instanceId="shared-uuid"),
                    headers=_hdr(a_ingest)).json()
    assert r["accepted"] == 1

    # beta re-registers alpha's instance_id -> rejected, alpha's row untouched.
    evil = agent_start_event(instanceId="shared-uuid",
                             hostInfo={"name": "evil-host", "os": "?"})
    r = client.post("/collector", json=evil, headers=_hdr(b_ingest)).json()
    assert r["failed"] == 1 and r["accepted"] == 0

    a_instances = client.get("/jvm-info", headers=_hdr(a_view)).json()
    assert len(a_instances) == 1
    assert a_instances[0]["hostInfo"]["name"] == "host-1"
    assert client.get("/jvm-info", headers=_hdr(b_view)).json() == []
