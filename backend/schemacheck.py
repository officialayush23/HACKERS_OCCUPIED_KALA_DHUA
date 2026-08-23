"""Check every SQL statement in the backend against the live schema.

    python schemacheck.py            # uses DATABASE_URL from the environment

Why this exists
---------------
Four separate outages in this project had exactly one shape: a query named a
column or table that was not in the live schema, FastAPI turned the error into a
500, and the frontend rendered an empty panel rather than a failure. A blank
Conversations tab and a working-but-empty Conversations tab look identical, so
every one of them survived to a demo.

`smoke.py` catches these too, but only for code paths a request actually
reaches. Plenty of queries only run on the third step of a scenario, or when a
supplier contradicts a carrier, or when someone types a command — and those are
precisely the ones nobody exercises before showing the thing to a judge.

What it does
------------
Pulls every SQL string literal out of `app/*.py` by parsing the AST — not by
regex over the source, so a query split across a hundred lines is still one
statement — then reads each one's table aliases and checks every `alias.column`
reference against `information_schema`.

What it deliberately does not do
--------------------------------
It is not a SQL parser and does not pretend to be. Unqualified columns, CTEs,
lateral subqueries and function calls are skipped rather than guessed at, which
means it can miss a bad column. It will not invent one: a reported failure is
always real. Silence is weak evidence; a report is strong evidence.

Exit code is the number of bad references, so it works in a pre-demo check:

    python schemacheck.py && python smoke.py && npm run dev
"""
from __future__ import annotations

import ast
import asyncio
import glob
import os
import re
import sys

try:
    import asyncpg
except ImportError:                                  # pragma: no cover
    print("asyncpg is not installed — pip install -r requirements.txt")
    sys.exit(2)

SQL_START = re.compile(r"^\s*(select|insert|update|delete|with)\b", re.I)

#: `from foo f`, `join foo as f`, `update foo f`, `insert into foo`. The alias is
#: optional; when it is absent the table stands in for itself, which is how
#: `inventory.usable_stock` resolves in a query that never aliased anything.
ALIAS = re.compile(
    r"\b(?:from|join|update|into)\s+([a-z_][a-z0-9_]*)\s*(?:as\s+)?([a-z_][a-z0-9_]*)?",
    re.I)

#: Words that follow a table name but are not an alias.
NOT_ALIAS = {
    "on", "where", "set", "values", "select", "group", "order", "limit", "using",
    "left", "right", "inner", "outer", "full", "cross", "join", "and", "or",
    "returning", "do", "conflict", "as", "lateral", "having", "union", "except",
    "intersect", "offset", "for", "window", "from", "with",
}

REF = re.compile(r"\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b")


def statements(root: str) -> list[tuple[str, int, str]]:
    """Every SQL string literal in the package, with where it came from."""
    found: list[tuple[str, int, str]] = []
    for path in sorted(glob.glob(os.path.join(root, "app", "*.py"))):
        try:
            tree = ast.parse(open(path, encoding="utf-8").read())
        except SyntaxError as exc:
            print(f"  ! {path} does not parse: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value
                if SQL_START.match(text) and len(text) > 25:
                    found.append((path, node.lineno, text))
    return found


def aliases(sql: str, tables: set[str]) -> dict[str, str]:
    """alias -> real table, for the tables this statement actually names."""
    out: dict[str, str] = {}
    for table, alias in ALIAS.findall(sql):
        t = table.lower()
        if t not in tables:
            continue
        out[t] = t                                    # the bare name always works
        a = (alias or "").lower()
        if a and a not in NOT_ALIAS and a not in tables:
            out[a] = t
    return out


def check(sql: str, schema: dict[str, list[str]]) -> list[str]:
    tables = set(schema)
    amap = aliases(sql, tables)
    if not amap:
        return []
    # A CTE name looks exactly like a table alias and has columns we cannot
    # know. Rather than guess, drop any prefix that a `with` clause defined.
    ctes = {m.lower() for m in re.findall(r"(?:with|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(",
                                          sql, re.I)}
    bad: list[str] = []
    for prefix, col in REF.findall(sql):
        p = prefix.lower()
        if p in ctes or p not in amap:
            continue
        table = amap[p]
        if col.lower() not in {c.lower() for c in schema[table]}:
            ref = f"{prefix}.{col}"
            if ref not in bad:
                bad.append(f"{ref}  →  {table} has no column {col!r}")
    return bad


async def main() -> int:
    url = os.getenv("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set. Run this from backend/ with your .env loaded.")
        return 2
    conn = await asyncpg.connect(url)
    try:
        rows = await conn.fetch(
            """select table_name, array_agg(column_name) as cols
                 from information_schema.columns
                where table_schema = 'public'
                group by table_name""")
    finally:
        await conn.close()
    schema = {r["table_name"]: list(r["cols"]) for r in rows}

    root = os.path.dirname(os.path.abspath(__file__))
    stmts = statements(root)
    print(f"{len(stmts)} SQL statements across {len(schema)} live tables\n")

    failures = 0
    for path, line, sql in stmts:
        for problem in check(sql, schema):
            failures += 1
            rel = os.path.relpath(path, root)
            print(f"FAIL  {rel}:{line}\n        {problem}")

    print()
    if failures:
        print(f"{failures} bad column reference(s). Each one is a 500 waiting for the "
              f"code path that reaches it.")
    else:
        print("No bad column references found. (Unqualified columns and CTE bodies are "
              "not checked — this proves the absence of one bug class, not of all bugs.)")
    return failures


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
