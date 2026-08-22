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
    """

    real_start: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sim_start: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    seconds_per_sim_hour: float = SECONDS_PER_SIM_HOUR
    running: bool = True

    def now(self) -> datetime:
        if not self.running:
            return self.sim_start
        real_elapsed = (datetime.now(timezone.utc) - self.real_start).total_seconds()
        sim_hours = real_elapsed / self.seconds_per_sim_hour
        return self.sim_start + timedelta(hours=sim_hours)

    def elapsed_sim_hours(self) -> float:
        return (self.now() - self.sim_start).total_seconds() / 3600.0

    def reset(self) -> None:
        self.real_start = datetime.now(timezone.utc)
        self.sim_start = datetime.now(timezone.utc)
        self.running = True

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


async def emit(
    conn,
    *,
    event_type: str,
    actor: str,
    human_summary: str,
    incident_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write one audit event and push it to every dashboard.

    ONE event, four representations: human trail, dev log, websocket, and the
    Decision Explorer. Never write a separate human log.
    """
    row = await conn.fetchrow(
        """
        insert into audit_events
            (incident_id, actor, event_type, human_summary, technical_payload)
        values ($1, $2, $3, $4, $5::jsonb)
        returning sequence, incident_id, ts, actor, event_type,
                  human_summary, technical_payload
        """,
        incident_id,
        actor,
        event_type,
        human_summary,
        json.dumps(payload or {}, default=str),
    )
    event = dict(row)
    event["technical_payload"] = json.loads(event["technical_payload"])
    event["sim_time"] = CLOCK.now().isoformat()
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
