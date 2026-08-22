"""Hit every read endpoint and report anything that is not a 200.

Run this after starting the backend and before showing anyone anything:

    python smoke.py                      # against http://localhost:8000
    python smoke.py http://host:8000

Why this exists
---------------
Four separate outages in this project had the same shape: a query referenced a
column or table that was not in the live schema, FastAPI turned it into a 500,
and the *frontend* showed an empty panel rather than an error. A blank
Conversations tab and a working-but-empty Conversations tab look identical, so
the failure survived all the way to a demo every time.

Unit tests would not have caught any of them — the code was correct against the
schema its author had in mind. Only asking the running server is decisive, and
it takes about a second.

Exit code is the number of failures, so this works in a pre-demo check:

    python smoke.py && npm run dev
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000").rstrip("/")

# Every GET the dashboard, the warehouse screen and the supplier portal make.
# Endpoints that need an id are probed with whatever the world actually has.
STATIC = [
    "/api/health", "/api/context", "/api/world", "/api/kpis", "/api/network",
    "/api/now", "/api/incidents", "/api/audit?after=0&limit=50", "/api/scenarios",
    "/api/scenarios/context", "/api/runs", "/api/runs/active", "/api/approvals",
    "/api/warehouse", "/api/threads", "/api/accuracy", "/api/evaluation/current",
    "/api/world/explain", "/api/human-input", "/api/suppliers", "/api/agent/state",
    "/api/llm/health", "/api/audit?limit=50&since_reset=false",
]


def get(path: str):
    try:
        with urllib.request.urlopen(BASE + path, timeout=25) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]
    except Exception as e:                        # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def main() -> int:
    paths = list(STATIC)

    # Fan out over real ids, because most of the breakages have been in the
    # per-entity queries rather than the list ones.
    code, sup = get("/api/suppliers")
    if code == 200 and isinstance(sup, dict):
        for s in (sup.get("suppliers") or [])[:4]:
            paths.append(f"/api/supplier/{s['id']}")
            paths.append(f"/api/suppliers/{s['id']}/reliability")

    code, inc = get("/api/incidents")
    if code == 200 and isinstance(inc, dict):
        for i in (inc.get("incidents") or [])[:3]:
            paths.append(f"/api/agent/steps/{i['id']}")
            paths.append(f"/api/audit?incident_id={i['id']}")
            paths.append(f"/api/intelligence?incident_id={i['id']}")

    code, ctx = get("/api/context")
    if code == 200 and isinstance(ctx, dict):
        for p in (ctx.get("production") or [])[:3]:
            paths.append(f"/api/solve/{p['id']}?record=false")

    width = max(len(p) for p in paths)
    failures = []
    for p in paths:
        code, body = get(p)
        ok = code == 200
        if not ok:
            failures.append((p, code, body))
        print(f"{'ok ' if ok else 'FAIL'}  {p:<{width}}  {code}")
        if not ok:
            print(f"        {str(body)[:300]}")

    print()
    if failures:
        print(f"{len(failures)} endpoint(s) failing:")
        for p, code, _ in failures:
            print(f"  {code}  {p}")
        print("\nA 500 here is almost always a query naming a column or table the "
              "live schema does not have. Check supabase/migrations/ has all been "
              "applied before looking at the Python.")
    else:
        print(f"all {len(paths)} endpoints healthy")
    return len(failures)


if __name__ == "__main__":
    raise SystemExit(main())
