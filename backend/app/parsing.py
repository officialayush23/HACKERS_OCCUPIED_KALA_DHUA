"""Deterministic extraction of facts from supplier messages.

This exists because the previous fallback was an apology. When the model was
unavailable — which is the default configuration, and the state the demo runs in
— every supplier reply produced *"Supplier message could not be parsed
automatically"*, which reads to anyone watching as the agent being broken.

It is not a fallback in the sense of a degraded mode. It is the floor:

    supplier message
          ↓
    deterministic extraction   ← always runs, always produces a result
          ↓
    LLM extraction             ← runs when available, may be better
          ↓
    schema validation          ← both go through the same gate
          ↓
    merge (LLM wins per-field, but only where it validated)
          ↓
    structured facts + an honest confidence

The rule that matters: **an unparsed number is null, never a guess.** A parser
that invents a quantity is worse than one that admits it found none, because the
solver downstream will spend money on it.

NO LLM IN THIS FILE.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import Any

# ---------------------------------------------------------------- patterns ---
#
# Written against how suppliers actually write, not how we wish they did:
# "500 units", "Rs 145/unit", "145 per unit", "2 days", "4-day road transit".

_QTY = re.compile(
    r"(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)\s*(?:units?|pcs?|pieces?|nos?\.?|modules?)",
    re.I)
_PRICE = re.compile(
    r"(?:rs\.?|inr|₹)\s*(\d+(?:\.\d+)?)\s*(?:/|per\s+)?\s*(?:unit|pc|piece|ea)?"
    r"|(\d+(?:\.\d+)?)\s*(?:/|per\s+)\s*unit", re.I)
_DAYS = re.compile(
    r"(\d+)\s*[-\s]?\s*(?:day|days|working days|business days)", re.I)
_MOQ = re.compile(
    r"minimum\s+order\s*(?:quantity|qty)?\s*(?:is|of|:)?\s*(\d{1,3}(?:,\d{3})+|\d+)", re.I)
_CERTS = re.compile(r"\b(AEC-?Q100|IATF\s?16949|ISO\s?9001|IEC-?62133|RoHS)\b", re.I)

# Classification. Order matters — the first bucket that matches wins, and the
# refusals are checked before the confirmations so "cannot confirm" is not read
# as a confirmation.
_SIGNALS: list[tuple[str, re.Pattern]] = [
    ("unable_to_supply", re.compile(
        r"\b(cannot|can't|unable|no stock|out of stock|not available|regret|decline)\b", re.I)),
    ("dispatched", re.compile(
        r"\b(dispatched|shipped|despatched|handed to (?:the )?carrier|in transit|"
        r"picked up|on its way)\b", re.I)),
    ("delay", re.compile(
        r"\b(delay|delayed|slip|slipped|postpone|pushed back|behind schedule|"
        r"later than|reschedul)\w*\b", re.I)),
    ("partial_available", re.compile(
        r"\b(partial|part of|some of|only \d+|we can (?:release|spare|offer))\b", re.I)),
    ("available", re.compile(
        r"\b(confirmed|available|ready|in stock|we can (?:supply|deliver|provide))\b", re.I)),
]

# Language that means "no firm commitment", whatever else the message says. This
# is the single most important signal in the file: it is what stops the agent
# treating "we may be able to arrange something" as an offer.
_HEDGES = re.compile(
    r"\b(may|might|should be able|hope|hopefully|approximately|around|about|"
    r"roughly|subject to|pending|tentative|expect(?:ed|ing)?|revert|shortly|"
    r"try(?:ing)? to|likely|possibly|somewhere)\b", re.I)

_FIRM = re.compile(
    r"\b(confirmed|guarantee[d]?|firm|committed|will deliver|we will|immediately)\b", re.I)


@dataclass
class Extraction:
    """What we managed to read. Every field may be None — that is the point."""
    claim: str = "unclear"
    quantity_mentioned: int | None = None
    unit_price: float | None = None
    lead_time_days: int | None = None
    min_order_quantity: int | None = None
    certifications: list[str] = field(default_factory=list)
    firm_commitment: bool = False
    vague: bool = True
    confidence: float = 0.0
    summary: str = ""
    source: str = "deterministic"       # deterministic | llm | merged
    # What a human should do when we could not read it well enough.
    needs_human: bool = False
    needs_human_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _int(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        return int(raw.replace(",", ""))
    except (TypeError, ValueError):
        return None


def extract(body: str) -> Extraction:
    """Read what the supplier actually said. Never invent a number."""
    text = (body or "").strip()
    out = Extraction()
    if not text:
        out.summary = "Empty message."
        out.needs_human = True
        out.needs_human_reason = "The supplier sent nothing we can read."
        return out

    # --- what kind of message is this ---
    for claim, pattern in _SIGNALS:
        if pattern.search(text):
            out.claim = claim
            break

    # --- the numbers, if they are actually there ---
    qty = _QTY.search(text)
    out.quantity_mentioned = _int(qty.group(1)) if qty else None

    price = _PRICE.search(text)
    if price:
        raw = price.group(1) or price.group(2)
        try:
            out.unit_price = float(raw)
        except (TypeError, ValueError):
            out.unit_price = None

    days = _DAYS.search(text)
    out.lead_time_days = _int(days.group(1)) if days else None

    moq = _MOQ.search(text)
    out.min_order_quantity = _int(moq.group(1)) if moq else None

    out.certifications = sorted({
        c.upper().replace(" ", "-").replace("AECQ100", "AEC-Q100")
        for c in _CERTS.findall(text)})

    # --- how much of this can we act on ---
    hedged = bool(_HEDGES.search(text))
    firm = bool(_FIRM.search(text))
    out.firm_commitment = firm and not hedged
    out.vague = hedged or out.claim == "unclear"

    # Confidence is a count of what we actually read, not a feeling.
    signals = sum([
        out.claim != "unclear",
        out.quantity_mentioned is not None,
        out.unit_price is not None,
        out.lead_time_days is not None,
    ])
    out.confidence = round(min(0.95, 0.2 * signals + (0.15 if firm else 0)
                               - (0.2 if hedged else 0)), 2)
    out.confidence = max(0.0, out.confidence)

    out.summary = _summarise(out)

    # --- when a human has to look at it ---
    if out.claim == "unclear" and out.quantity_mentioned is None:
        out.needs_human = True
        out.needs_human_reason = (
            "Nothing in this message can be acted on — no quantity, price or commitment.")
    elif hedged and out.quantity_mentioned is not None:
        out.needs_human = True
        out.needs_human_reason = (
            f"The supplier mentions {out.quantity_mentioned} units but avoids committing "
            f"to them. Treating this as an offer would be inventing a fact.")
    elif out.claim == "unable_to_supply":
        out.needs_human = False       # unambiguous; the solver simply drops them

    return out


def _summarise(e: Extraction) -> str:
    """One sentence a procurement manager can read. Only from what we found."""
    if e.claim == "unable_to_supply":
        return "Supplier says they cannot supply this."
    if e.claim == "dispatched":
        return "Supplier claims the shipment has already left."
    if e.claim == "delay":
        d = f" by about {e.lead_time_days} days" if e.lead_time_days else ""
        return f"Supplier is reporting a delay{d}."

    bits: list[str] = []
    if e.quantity_mentioned is not None:
        bits.append(f"{e.quantity_mentioned} units")
    if e.unit_price is not None:
        bits.append(f"Rs {e.unit_price:g}/unit")
    if e.lead_time_days is not None:
        bits.append(f"{e.lead_time_days}-day lead time")
    if e.min_order_quantity is not None:
        bits.append(f"minimum order {e.min_order_quantity}")

    if not bits:
        return "No figures given — the supplier acknowledged the enquiry without committing."
    offer = ", ".join(bits)
    return (f"Offer: {offer}." if e.firm_commitment
            else f"Possible offer: {offer} — but not firmly committed.")


# ------------------------------------------------------------- validation ---

_ALLOWED_CLAIMS = {"delay", "dispatched", "partial_available", "available",
                   "unable_to_supply", "unclear"}


def validate_llm(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only fields the model returned in a shape we can use.

    A model that returns `quantity_mentioned: "about five hundred"` has told us
    nothing, and coercing it would be inventing a number. Anything that does not
    validate is dropped, not repaired.
    """
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, Any] = {}

    claim = raw.get("claim")
    if isinstance(claim, str) and claim in _ALLOWED_CLAIMS:
        clean["claim"] = claim

    for key in ("quantity_mentioned", "lead_time_days", "min_order_quantity"):
        v = raw.get(key)
        if isinstance(v, bool):
            continue
        if isinstance(v, int) and 0 < v < 10_000_000:
            clean[key] = v
        elif isinstance(v, float) and v.is_integer() and 0 < v < 10_000_000:
            clean[key] = int(v)

    price = raw.get("unit_price")
    if isinstance(price, (int, float)) and not isinstance(price, bool) and 0 < price < 1_000_000:
        clean["unit_price"] = float(price)

    for key in ("vague", "firm_commitment"):
        if isinstance(raw.get(key), bool):
            clean[key] = raw[key]

    conf = raw.get("confidence")
    if isinstance(conf, str):
        conf = {"high": 0.9, "medium": 0.6, "low": 0.3}.get(conf.lower())
    if isinstance(conf, (int, float)) and not isinstance(conf, bool) and 0 <= conf <= 1:
        clean["confidence"] = round(float(conf), 2)

    summary = raw.get("summary")
    if isinstance(summary, str) and summary.strip():
        clean["summary"] = summary.strip()[:400]

    certs = raw.get("certifications")
    if isinstance(certs, list):
        clean["certifications"] = sorted({str(c).upper()[:32] for c in certs if c})

    return clean


def interpret(body: str, llm_raw: dict[str, Any] | None = None) -> Extraction:
    """The one entry point. Deterministic floor, model on top, schema between.

    The model may sharpen a field the parser missed. It may not overrule a number
    the parser read straight out of the text — if they disagree on a quantity that
    is itself a reason to involve a human, not a reason to pick one.
    """
    base = extract(body)
    clean = validate_llm(llm_raw)
    if not clean:
        return base

    merged = Extraction(**base.to_dict())
    merged.source = "merged"
    conflict: str | None = None

    for key, value in clean.items():
        current = getattr(merged, key, None)
        if key in ("quantity_mentioned", "unit_price", "lead_time_days") \
                and current is not None and value != current:
            conflict = (f"The model read {key.replace('_', ' ')} as {value}; the text says "
                        f"{current}. Not guessing between them.")
            continue                      # keep what the text literally says
        if current in (None, "", [], "unclear", 0.0) or key in ("summary", "vague",
                                                                "firm_commitment",
                                                                "confidence"):
            setattr(merged, key, value)

    if conflict:
        merged.needs_human = True
        merged.needs_human_reason = conflict
        merged.confidence = min(merged.confidence, 0.4)

    merged.summary = merged.summary or _summarise(merged)
    return merged
