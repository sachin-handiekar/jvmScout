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
