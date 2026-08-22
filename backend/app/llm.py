"""Gemini client — the ONLY place a model is called.

Three rules that make this safe to demo:

1. The LLM never decides. It reads, interprets and explains. Every number and
   every constraint comes from `solver.py`.
2. Every call has a deterministic fallback. If the key is missing, the network
   is down, or the model returns garbage, the system keeps working and the
   audit trail says so. A demo must never break because of an API key.
3. Every call is logged with its latency and whether it fell back.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import httpx

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash").strip()
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
TIMEOUT_S = float(os.getenv("LLM_TIMEOUT_S", "20"))

#: Set false to force deterministic mode (useful when demoing offline).
LLM_ENABLED = os.getenv("LLM_ENABLED", "true").lower() not in ("false", "0", "no")

_stats = {"calls": 0, "fallbacks": 0, "total_ms": 0.0, "last_error": None}

# A wrong model name fails exactly like a wrong key, an expired key and a
# firewall: the badge says "deterministic" and nothing says why. Model names
# also move — one that existed when this was written may not exist on demo day,
# and "the AI silently stopped being used" is the worst possible way to find
# that out. So: try the configured name first, fall back through known-good
# ones, and remember whichever answered.
_MODEL_CANDIDATES = [
    GEMINI_MODEL,
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro",
]
_active_model: str | None = None


def stats() -> dict[str, Any]:
    return {
        **_stats,
        "enabled": LLM_ENABLED and bool(GEMINI_API_KEY),
        "model": _active_model or GEMINI_MODEL,
        "configured_model": GEMINI_MODEL,
        "model_resolved": _active_model is not None,
        "avg_ms": round(_stats["total_ms"] / _stats["calls"], 1) if _stats["calls"] else 0,
    }


async def _call(prompt: str, *, system: str | None = None,
                json_mode: bool = False, max_tokens: int = 700) -> str | None:
    """Raw call. Returns None on any failure — callers must handle that."""
    if not (LLM_ENABLED and GEMINI_API_KEY):
        return None

    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"

    global _active_model
    # Once one model has answered, stop shopping around.
    candidates = ([_active_model] if _active_model
                  else list(dict.fromkeys(m for m in _MODEL_CANDIDATES if m)))

    started = time.perf_counter()
    last: str | None = None
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            for model in candidates:
                r = await client.post(
                    GEMINI_URL.format(model=model),
                    headers={"x-goog-api-key": GEMINI_API_KEY,
                             "Content-Type": "application/json"},
                    json=body,
                )
                if r.status_code == 200:
                    _active_model = model
                    elapsed = (time.perf_counter() - started) * 1000
                    _stats["calls"] += 1
                    _stats["total_ms"] += elapsed
                    _stats["last_error"] = None
                    data = r.json()
                    parts = (data.get("candidates", [{}])[0]
                                 .get("content", {}).get("parts", []))
                    text = "".join(p.get("text", "") for p in parts).strip()
                    return text or None

                last = f"{model} -> HTTP {r.status_code}: {r.text[:120]}"
                # 404/400 means "not this model"; anything else (401, 429, 500)
                # is about the key or the service and trying another name is
                # just noise.
                if r.status_code not in (400, 404):
                    break

        _stats["calls"] += 1
        _stats["fallbacks"] += 1
        _stats["last_error"] = last or "no model answered"
        return None
    except Exception as exc:                      # noqa: BLE001 - never break the demo
        _stats["calls"] += 1
        _stats["fallbacks"] += 1
        _stats["last_error"] = f"{type(exc).__name__}: {exc}"[:200]
        return None


async def _json_call(prompt: str, *, system: str, fallback: dict) -> tuple[dict, bool]:
    """Returns (result, used_llm)."""
    raw = await _call(prompt, system=system, json_mode=True)
    if not raw:
        return fallback, False
    try:
        cleaned = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
        return json.loads(cleaned), True
    except json.JSONDecodeError:
        _stats["fallbacks"] += 1
        return fallback, False


# ---------------------------------------------------------------- prompts ----

INTERPRETER = (
    "You are a procurement analyst at NEXA Mobility Systems, a Tier-1 automotive "
    "electronics manufacturer in Pune. You read supplier messages and extract facts. "
    "You never invent numbers. If a message is vague, say so."
)

NARRATOR = (
    "You are the reasoning voice of an autonomous supply-chain agent. Write for a "
    "procurement operations manager who is not technical. Short sentences. No jargon, "
    "no bullet symbols, no markdown. Never invent numbers — use only what you are given."
)


async def interpret_supplier_message(body: str, context: dict) -> tuple[dict, bool]:
    """Turn a vague supplier email into structured signal."""
    fallback = {
        "claim": "unclear",
        "committed_date": None,
        "quantity_mentioned": None,
        "confidence": "low",
        "summary": "Supplier message could not be parsed automatically.",
        "vague": True,
    }
    prompt = (
        f"Supplier message about purchase order {context.get('po_id')} for "
        f"{context.get('component_name')}:\n\n\"{body}\"\n\n"
        "Return JSON with keys: claim (one of: delay, dispatched, partial_available, "
        "unable_to_supply, unclear), committed_date (ISO date or null), "
        "quantity_mentioned (int or null), confidence (high|medium|low), "
        "summary (one sentence), vague (boolean — true if the supplier avoided a firm commitment)."
    )
    return await _json_call(prompt, system=INTERPRETER, fallback=fallback)


async def assess_contradiction(supplier_claim: str, carrier_status: str,
                               supplier_name: str) -> tuple[dict, bool]:
    """Reason about a claim that conflicts with carrier evidence."""
    fallback = {
        "is_contradiction": True,
        "severity": "high",
        "reasoning": (f"{supplier_name} states '{supplier_claim}' but the carrier system "
                      f"shows '{carrier_status}'. Physical evidence outranks a supplier's "
                      f"own account, so this shipment cannot be treated as reliable."),
        "recommended_action": "Continue alternate sourcing. Do not count this shipment as recovery stock.",
    }
    prompt = (
        f"{supplier_name} claims: \"{supplier_claim}\".\n"
        f"Independent carrier tracking shows: \"{carrier_status}\".\n\n"
        "Return JSON: is_contradiction (bool), severity (low|medium|high|critical), "
        "reasoning (2 sentences, plain English, for an operations manager), "
        "recommended_action (one sentence)."
    )
    return await _json_call(prompt, system=INTERPRETER, fallback=fallback)


async def explain_decision(context: dict) -> tuple[str, bool]:
    """Human-readable 'why did the agent do this'."""
    chosen = context.get("chosen") or {}
    rejections = context.get("rejections") or []
    fb_lines = [
        f"Production stops in {context.get('coverage_days', '?')} days without action.",
        f"Selected {chosen.get('label', 'no option')} at "
        f"Rs {chosen.get('total_cost', 0):,.0f}.",
    ]
    for r in rejections[:3]:
        fb_lines.append(r.get("human_reason", ""))
    fallback = " ".join(x for x in fb_lines if x)

    prompt = (
        f"Component: {context.get('component_name')} "
        f"({context.get('part_number')}), used in {context.get('product_name')}.\n"
        f"Shortfall: {context.get('shortfall')} units. "
        f"Production coverage: {context.get('coverage_days')} days.\n"
        f"Chosen recovery: {chosen.get('label')} at Rs {chosen.get('total_cost', 0):,.0f}, "
        f"arriving in {round((chosen.get('arrival_hours') or 0) / 24, 1)} days.\n"
        f"Rejected options and the rule that blocked each:\n"
        + "\n".join(f"- {r.get('supplier_id')}: {r.get('human_reason')}" for r in rejections[:5])
        + "\n\nWrite 3 to 4 short sentences explaining, to a procurement manager, why this "
          "recovery was chosen and why the cheaper options were refused. Plain prose."
    )
    text = await _call(prompt, system=NARRATOR, max_tokens=350)
    return (text, True) if text else (fallback, False)


async def draft_supplier_message(kind: str, context: dict) -> tuple[str, bool]:
    """Write the outbound email the agent sends."""
    comp = context.get("component_name", "the component")
    po = context.get("po_id", "")
    qty = context.get("quantity", "")
    by = context.get("needed_by", "")

    if kind == "delay_confirmation":
        fallback = (
            f"Your reported delay on {po} threatens production at our Pune plant.\n\n"
            "Please confirm by return:\n"
            "  - exact quantity ready to ship\n"
            "  - current dispatch status\n"
            "  - actual carrier pickup time\n"
            "  - earliest realistic delivery date\n"
            "  - whether a partial shipment is possible\n\n"
            "We are evaluating alternate sourcing in parallel."
        )
        ask = (f"Write a firm but professional email to a supplier whose delay on {po} "
               f"({comp}) threatens our production line. Ask for exact ready quantity, "
               f"dispatch status, actual carrier pickup time, earliest delivery date, and "
               f"whether partial shipment is possible.")
    elif kind == "rfq":
        fallback = (
            f"URGENT RFQ - {comp}\n\n"
            f"Quantity required: {qty} units\n"
            f"Required by: {by}\n\n"
            "Please confirm available quantity, unit price, earliest delivery, "
            "certification status, and any expedited shipping option."
        )
        ask = (f"Write a short urgent RFQ email for {qty} units of {comp}, required by {by}. "
               f"Ask for available quantity, unit price, earliest delivery, certification "
               f"status and expedite options.")
    elif kind == "warehouse_verify":
        fallback = (
            f"ERP shows {context.get('erp_stock')} units of {comp} on hand.\n"
            "Please confirm physically usable inventory and the reason for any hold.\n"
            f"Production may stop in {context.get('coverage_days')} days."
        )
        ask = (f"Write a short internal request to the warehouse team asking them to confirm "
               f"physically usable stock of {comp}. ERP says {context.get('erp_stock')} units. "
               f"Production may stop in {context.get('coverage_days')} days.")
    else:
        return ("", False)

    text = await _call(ask + " No greeting line with a name. No signature. Plain text.",
                       system=INTERPRETER, max_tokens=320)
    return (text, True) if text else (fallback, False)


async def answer_question(question: str, state: dict) -> tuple[str, bool]:
    """Conversational agent. Reads state; never mutates it."""
    fallback = ("I can only answer from the current incident state, and the model is "
                "unavailable right now. Open the Decision Explorer for the full "
                "chosen-versus-rejected breakdown.")
    prompt = (
        "Current operational state:\n"
        f"{json.dumps(state, indent=2, default=str)[:4000]}\n\n"
        f"Question from the procurement manager: \"{question}\"\n\n"
        "Answer in 2-4 short sentences using only the state above. If the state does not "
        "contain the answer, say so plainly."
    )
    text = await _call(prompt, system=NARRATOR, max_tokens=400)
    return (text, True) if text else (fallback, False)


async def health() -> dict[str, Any]:
    """Used by /api/llm/health so the UI can show a live badge."""
    if not LLM_ENABLED:
        return {"ok": False, "reason": "LLM_ENABLED is false in the environment",
                **stats()}
    if not GEMINI_API_KEY:
        return {"ok": False, "reason": "GEMINI_API_KEY is not set", **stats()}
    t = await _call("Reply with the single word: OK", max_tokens=10)
    if t:
        return {"ok": True, "sample": t, **stats()}
    # Say what actually went wrong. "deterministic" with no explanation is how a
    # dead API key survives all the way to a demo.
    return {"ok": False,
            "reason": _stats["last_error"] or "the model returned nothing",
            **stats()}
