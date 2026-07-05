"""In-process operational counters, exposed at /metrics in Prometheus text
exposition format (no client-library dependency).

Counters live on the single event loop, so plain ints are safe. They reset on
process restart — Prometheus rate()/increase() handle that natively. These are
aggregate operational numbers (no event content, no per-tenant data).
"""
from __future__ import annotations

import time


class Metrics:
    def __init__(self) -> None:
        self.started_at = time.time()
        self.events_accepted = 0        # exception + agent_start events stored
        self.events_failed = 0          # malformed / rejected / store failures
        self.ingest_batches = 0         # POST /collector requests processed
        self.rate_limited = 0           # ingest requests rejected with 429
        self.alerts_fired = 0           # notifications actually delivered
        self.alerts_skipped = 0         # evaluations dropped (queue full)
        self.ws_clients = 0             # gauge: currently-connected sockets

    def render(self) -> str:
        up = time.time() - self.started_at
        lines = [
            "# HELP jvmscout_uptime_seconds Seconds since collector start.",
            "# TYPE jvmscout_uptime_seconds gauge",
            f"jvmscout_uptime_seconds {up:.0f}",
            "# HELP jvmscout_events_accepted_total Events stored since start.",
            "# TYPE jvmscout_events_accepted_total counter",
            f"jvmscout_events_accepted_total {self.events_accepted}",
            "# HELP jvmscout_events_failed_total Events rejected/dropped since start.",
            "# TYPE jvmscout_events_failed_total counter",
            f"jvmscout_events_failed_total {self.events_failed}",
            "# HELP jvmscout_ingest_batches_total Ingest POSTs processed since start.",
            "# TYPE jvmscout_ingest_batches_total counter",
            f"jvmscout_ingest_batches_total {self.ingest_batches}",
            "# HELP jvmscout_rate_limited_total Ingest POSTs rejected with 429.",
            "# TYPE jvmscout_rate_limited_total counter",
            f"jvmscout_rate_limited_total {self.rate_limited}",
            "# HELP jvmscout_alerts_fired_total Alert notifications delivered.",
            "# TYPE jvmscout_alerts_fired_total counter",
            f"jvmscout_alerts_fired_total {self.alerts_fired}",
            "# HELP jvmscout_alerts_skipped_total Alert evaluations dropped (queue full).",
            "# TYPE jvmscout_alerts_skipped_total counter",
            f"jvmscout_alerts_skipped_total {self.alerts_skipped}",
            "# HELP jvmscout_ws_clients Currently connected WebSocket clients.",
            "# TYPE jvmscout_ws_clients gauge",
            f"jvmscout_ws_clients {self.ws_clients}",
        ]
        return "\n".join(lines) + "\n"


metrics = Metrics()
