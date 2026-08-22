"""Core infrastructure: config, db pool, simulated clock, event bus, websockets.

Deliberately one module. Phase 1 does not need a package hierarchy and a
hackathon does not need import archaeology at hour 30.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from contextvars import ContextVar
from typing import Any

import asyncpg
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------- config ----

DATABASE_URL = os.environ["DATABASE_URL"]          # port 5432 direct, NOT 6543
APPROVAL_THRESHOLD_INR = int(os.getenv("APPROVAL_THRESHOLD_INR", "150000"))
EMERGENCY_BUDGET_INR = int(os.getenv("EMERGENCY_BUDGET_INR", "500000"))
MAX_TOOL_CALLS = int(os.getenv("MAX_TOOL_CALLS_PER_INCIDENT", "12"))
# 1 real second == 1 simulated hour. A 5-day delay plays out in 2 minutes.
SECONDS_PER_SIM_HOUR = float(os.getenv("CLOCK_SECONDS_PER_SIM_HOUR", "1"))

_pool: asyncpg.Pool | None = None


async def db() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=1,
            max_size=8,
            statement_cache_size=0,   # safe if someone points this at a pooler
        )
    return _pool


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# ----------------------------------------------------------------- clock ----


@dataclass
class SimClock:
    """Maps real elapsed seconds onto simulated hours.

    Every deadline comparison in the solver goes through `now()`. Nothing in
    the codebase may call datetime.now() directly for business logic.

    **The clock is paused unless a scenario is running.** This is not a detail:
    a free-running clock silently ages the world while the dashboard sits open,
    so after fifteen idle minutes every seeded delivery date is a month in the
    past, every ETA reads negative, and the screen fills with nonsense that has
    nothing to do with the agent. Time passes when something is happening.
    """

    real_start: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sim_start: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    seconds_per_sim_hour: float = SECONDS_PER_SIM_HOUR
    running: bool = False
    # Simulated hours banked from previous running stretches.
    _banked_hours: float = 0.0

    def _live_hours(self) -> float:
        if not self.running:
            return 0.0
        real_elapsed = (datetime.now(timezone.utc) - self.real_start).total_seconds()
        return real_elapsed / self.seconds_per_sim_hour

    def now(self) -> datetime:
        return self.sim_start + timedelta(hours=self._banked_hours + self._live_hours())

    def elapsed_sim_hours(self) -> float:
        return self._banked_hours + self._live_hours()

    def start(self) -> None:
        """Resume from where we paused, without losing the elapsed simulation."""
        if self.running:
            return
        self.real_start = datetime.now(timezone.utc)
        self.running = True

    def pause(self) -> None:
        if not self.running:
            return
        self._banked_hours += self._live_hours()
        self.running = False

    def reset(self) -> None:
        self.real_start = datetime.now(timezone.utc)
        self.sim_start = datetime.now(timezone.utc)
        self._banked_hours = 0.0
        self.running = False

    def state(self) -> dict[str, Any]:
        return {
            "sim_now": self.now().isoformat(),
            "elapsed_sim_hours": round(self.elapsed_sim_hours(), 2),
            "seconds_per_sim_hour": self.seconds_per_sim_hour,
            "running": self.running,
        }


CLOCK = SimClock()


# ------------------------------------------------------------ websockets ----


class Hub:
    """Fan-out to every connected dashboard. No Redis, no Supabase Realtime."""

    def __init__(self) -> None:
        self._clients: set[Any] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        text = json.dumps(payload, default=str)
        async with self._lock:
            targets = list(self._clients)
        dead = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    @property
    def count(self) -> int:
        return len(self._clients)


HUB = Hub()


# ----------------------------------------------------------------- audit ----


#: Ambient run context. Set while a scenario is executing so every event —
#: including ones emitted deep inside the solver — is attributable to the run
#: that produced it. Without this, comparing run 1 against run 2 is guesswork.
_RUN: ContextVar[dict[str, Any] | None] = ContextVar("run_ctx", default=None)

#: Process-wide fallback. A contextvar only reaches code running inside the
#: scenario task; an event the operator fires by hand from the dashboard is a
#: separate request in a separate context and would otherwise lose its run
#: linkage entirely.
_ACTIVE: dict[str, Any] | None = None


def set_run_context(run_id: int | None, sim_started_at: datetime | None = None) -> None:
    global _ACTIVE
    ctx = None if run_id is None else {"run_id": run_id,
                                       "sim_start": sim_started_at or CLOCK.now()}
    _RUN.set(ctx)
    _ACTIVE = ctx


def run_context() -> dict[str, Any] | None:
    return _RUN.get() or _ACTIVE


async def emit(
    conn,
    *,
    event_type: str,
    actor: str,
    human_summary: str,
    incident_id: str | None = None,
    payload: dict[str, Any] | None = None,
    scenario_run_id: int | None = None,
    agent_reason: str | None = None,
) -> dict[str, Any]:
    """Write one audit event and push it to every dashboard.

    ONE event, THREE PROJECTIONS:

        human_summary     what a plant manager reads
        agent_reason      why the agent did it
        technical_payload ids, constraints, state transitions

    The Business / Agent / Technical tabs are views over this row. They are not
    three log systems, so they cannot disagree about what happened.

    `ts` is wall-clock and is NOT reproducible across runs. `simulated_at_seconds`
    is the axis you compare two runs on.
    """
    ctx = _RUN.get() or _ACTIVE
    run_id = scenario_run_id if scenario_run_id is not None else (ctx or {}).get("run_id")
    sim_start = (ctx or {}).get("sim_start") or CLOCK.sim_start
    sim_seconds = round((CLOCK.now() - sim_start).total_seconds(), 2)

    row = await conn.fetchrow(
        """
        insert into audit_events
            (incident_id, actor, event_type, human_summary, agent_reason,
             technical_payload, scenario_run_id, simulated_at_seconds)
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
        returning sequence, incident_id, ts, actor, event_type, human_summary,
                  agent_reason, technical_payload, scenario_run_id,
                  simulated_at_seconds
        """,
        incident_id,
        actor,
        event_type,
        human_summary,
        agent_reason,
        json.dumps(payload or {}, default=str),
        run_id,
        sim_seconds,
    )
    event = dict(row)
    event["technical_payload"] = json.loads(event["technical_payload"])
    event["sim_time"] = CLOCK.now().isoformat()
    event["simulated_at_seconds"] = float(sim_seconds)
    await HUB.broadcast({"kind": "audit_event", "event": event})
    return event


async def broadcast_state(kind: str, data: dict[str, Any]) -> None:
    await HUB.broadcast({"kind": kind, **data})


# ------------------------------------------------------------- utilities ----


async def next_incident_id(conn) -> str:
    n = await conn.fetchval("select count(*) from incidents")
    return f"INC-{1001 + int(n)}"


def hours_between(later: datetime, earlier: datetime) -> float:
    """Precise hours. Never extract(day from ...) — truncation loses a day."""
    return (later - earlier).total_seconds() / 3600.0
