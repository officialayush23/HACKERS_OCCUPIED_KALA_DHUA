"""The supplier's side of the conversation.

Until now a supplier was a timer with a hardcoded string. The adversarial beat
— *the supplier claims dispatch, the agent catches it* — was therefore a thing
we asserted about our own simulation, and a judge had no way to disagree with
it. A scripted liar proves nothing about an agent.

This module makes the supplier a third actor with its own screen. A human sits
at `/supplier/SUP-21` and can quote a real price, hedge, decline, or claim a
shipment left when the carrier says it never moved. The agent has to cope with a
counterparty it cannot predict, live, in front of whoever is watching.

Three rules hold this together:

**Presence beats the script.** While somebody is at a supplier's portal, that
supplier's scripted persona stands down and the agent genuinely waits. Close the
tab and the personas resume, so an unattended demo still runs end to end.

**An offer that cannot change the plan is theatre.** An applied quote is written
through to `supplier_catalog`, which is what the solver reads. Drop your price
at the portal and the recommendation on the operations screen moves.

**A claim is not evidence.** Certifications asserted at the portal are recorded
on the quote and never written to `suppliers.certifications`. A supplier saying
they are AEC-Q100 is exactly the kind of thing that must not be trusted, and the
agent says so out loud when the claim is not on file.

NO LLM DECIDES ANYTHING HERE. The model may sharpen the reading of a free-text
message; the constraint filter downstream is unmoved.
"""
from __future__ import annotations

import json
import time
from typing import Any

from . import learning, llm, parsing
from .comms import open_thread, post
from .core import CLOCK, broadcast_state, emit

#: supplier_id -> monotonic timestamp of the last heartbeat from their portal.
#: Deliberately in-process and deliberately not persisted: "is a human sitting
#: at this screen right now" is not a fact about the world, it is a fact about
#: this browser tab, and it must not survive a restart.
_PRESENT: dict[str, float] = {}

#: A portal heartbeats every 15s; this is generous enough to survive a tab
#: being backgrounded and short enough that a closed tab hands control back
#: before anyone notices.
PRESENCE_TTL_SECONDS = 45.0


def heartbeat(supplier_id: str) -> None:
    _PRESENT[supplier_id] = time.monotonic()


def leave(supplier_id: str) -> None:
    _PRESENT.pop(supplier_id, None)


def present(supplier_id: str) -> bool:
    seen = _PRESENT.get(supplier_id)
    return seen is not None and (time.monotonic() - seen) < PRESENCE_TTL_SECONDS


def staffed() -> list[str]:
    """Every supplier currently being answered by a person."""
    now = time.monotonic()
    return sorted(s for s, t in _PRESENT.items() if now - t < PRESENCE_TTL_SECONDS)


# --------------------------------------------------------------- read side ---


DIRECTORY_SQL = """
select s.id,
       coalesce(s.legal_name, s.name) as name,
       s.city, s.country, s.email, s.origin,
       se.effective_reliability, se.contradictions_detected,
       array_agg(distinct sc.component_id) filter (where sc.component_id is not null)
         as components,
       (select count(*) from message_threads t
         where t.counterparty_id = s.id and t.status = 'awaiting_reply') as waiting_on_them
  from suppliers s
  join supplier_effective se on se.supplier_id = s.id
  left join supplier_catalog sc on sc.supplier_id = s.id
 group by s.id, s.legal_name, s.name, s.city, s.country, s.email, s.origin,
          se.effective_reliability, se.contradictions_detected
 order by waiting_on_them desc, s.id
"""


async def directory(conn) -> list[dict]:
    rows = await conn.fetch(DIRECTORY_SQL)
    return [{**dict(r), "staffed": present(r["id"])} for r in rows]


async def overview(conn, supplier_id: str) -> dict[str, Any]:
    """Everything the supplier's own screen needs, in one call.

    Note what is deliberately *not* here: the buyer's recovery plan, the other
    suppliers' prices, the weighted scores. A supplier portal that leaked the
    comparison would be a different and much worse product.
    """
    sup = await conn.fetchrow(
        """select s.*, se.effective_reliability, se.seeded_prior,
                  se.contradictions_detected, se.deliveries_on_time, se.deliveries_late
             from suppliers s
             join supplier_effective se on se.supplier_id = s.id
            where s.id = $1""", supplier_id)
    if sup is None:
        raise ValueError(f"unknown supplier {supplier_id}")

    threads = await conn.fetch(
        """select t.*, (select count(*) from thread_messages m where m.thread_id = t.id)
                         as message_count
             from message_threads t
            where t.counterparty_id = $1 and t.counterparty_type = 'supplier'
            order by t.id desc limit 20""", supplier_id)

    out_threads = []
    for t in threads:
        msgs = await conn.fetch(
            """select id, direction, author_type, author_name, body, delivery_state,
                      is_contradiction, sent_at, simulated_at_seconds
                 from thread_messages
                where thread_id = $1 and delivery_state <> 'draft'
                order by id""", t["id"])
        msgs = [dict(m) for m in msgs]
        last_in = next((m for m in reversed(msgs) if m["direction"] == "inbound"), None)
        last_out = next((m for m in reversed(msgs) if m["direction"] == "outbound"), None)
        out_threads.append({
            **dict(t),
            "messages": msgs,
            # "They are waiting on you" is the only question this screen answers.
            "awaiting_you": bool(last_out and (not last_in or last_in["id"] < last_out["id"])),
        })

    catalog = await conn.fetch(
        """select sc.component_id, sc.unit_price, sc.lead_time_days,
                  sc.available_quantity, sc.min_order_quantity,
                  coalesce(c.display_name, c.name) as component_name,
                  c.part_number, c.is_hazmat, c.required_certifications
             from supplier_catalog sc
             join components c on c.id = sc.component_id
            where sc.supplier_id = $1
            order by c.display_name""", supplier_id)

    lanes = await conn.fetch(
        """select mode::text as mode, transit_days, freight_cost
             from supplier_lanes where supplier_id = $1 order by transit_days""",
        supplier_id)

    orders = await conn.fetch(
        """select p.id, p.component_id, p.quantity, p.unit_price, p.status::text as status,
                  p.mode::text as mode, p.expected_delivery, p.created_by_agent,
                  coalesce(c.display_name, c.name) as component_name,
                  t.supplier_claim, t.tracking_status, t.last_movement
             from purchase_orders p
             join components c on c.id = p.component_id
             left join shipment_tracking t on t.po_id = p.id
            where p.supplier_id = $1
            order by case p.status::text when 'delayed' then 0 when 'in_transit' then 1
                                         when 'open' then 2 else 3 end,
                     p.expected_delivery""", supplier_id)

    quotes = await conn.fetch(
        """select q.*, coalesce(c.display_name, c.name) as component_name
             from supplier_quotes q
             left join components c on c.id = q.component_id
            where q.supplier_id = $1 order by q.id desc limit 15""", supplier_id)

    # What the buyer thinks of them, and why. Showing a supplier their own trust
    # score is unusual and is the point: it is a number they can move, and the
    # only thing that moves it up is delivering when they said they would.
    history = await learning.history(conn, supplier_id)

    return {
        "supplier": dict(sup),
        "staffed": present(supplier_id),
        "threads": out_threads,
        "catalog": [dict(r) for r in catalog],
        "lanes": [dict(r) for r in lanes],
        "purchase_orders": [
            {**dict(p),
             "contradicted": (p["supplier_claim"] in ("dispatched", "in_transit")
                              and p["tracking_status"] in ("label_created_no_pickup",
                                                           "not_shipped"))}
            for p in orders],
        "quotes": [dict(q) for q in quotes],
        "trust_history": history,
        "clock": CLOCK.state(),
    }


# -------------------------------------------------------------- write side ---


def compose(kind: str, offer: dict | None, note: str, supplier_name: str,
            component_name: str | None) -> str:
    """Turn a structured answer into the message a supplier would actually send.

    The agent still has to *read* this back out of prose. Handing the parser a
    clean dict would be testing nothing — the whole difficulty of the domain is
    that offers arrive as sentences.
    """
    what = component_name or "the requested component"

    if kind == "decline":
        base = (f"Thank you for the enquiry regarding {what}. "
                f"Unfortunately we are unable to supply this at present — we have no "
                f"stock available against the quantity and date you have asked for.")
        return f"{base}\n\n{note}".strip() if note else base

    if kind == "vague":
        base = (f"We have received your enquiry for {what} and are checking with our "
                f"plant. We may be able to arrange something and will revert shortly.")
        return f"{base}\n\n{note}".strip() if note else base

    if kind == "quote" and offer:
        bits = []
        if offer.get("quantity") is not None:
            bits.append(f"{offer['quantity']} units")
        if offer.get("unit_price") is not None:
            bits.append(f"Rs {offer['unit_price']:g}/unit")
        if offer.get("lead_time_days") is not None:
            bits.append(f"{offer['lead_time_days']}-day lead time")
        if offer.get("mode"):
            bits.append(f"{str(offer['mode']).lower()} transport")
        line = ", ".join(bits) if bits else "availability as discussed"
        base = f"Confirmed — we can supply {line}."
        if offer.get("min_order_quantity"):
            base += f" Minimum order quantity is {offer['min_order_quantity']}."
        if offer.get("certifications"):
            base += f" Certifications: {', '.join(offer['certifications'])}."
        if offer.get("expedite_available"):
            fee = offer.get("expedite_fee") or 0
            base += (f" Expedited despatch is available"
                     + (f" for an additional Rs {fee:g}." if fee else "."))
        return f"{base}\n\n{note}".strip() if note else base

    return note or "Noted, thank you."


async def _apply_quote(conn, supplier_id: str, offer: dict, supplier_name: str,
                       incident_id: str | None) -> dict[str, Any]:
    """Write an accepted offer through to the catalogue the solver reads.

    This is where the loop closes. Anything less — recording the quote and
    leaving the catalogue alone — means the supplier can say whatever they like
    and the recommendation never moves, which is a demo of a form, not a system.
    """
    component_id = offer["component_id"]
    mode = (offer.get("mode") or "ROAD").upper()
    transit = max(1, int(offer.get("lead_time_days") or 1))

    # The lane has to exist or CANDIDATE_SQL's join silently drops this supplier
    # from the pool — they would appear to have quoted into a void.
    await conn.execute(
        """insert into supplier_lanes (supplier_id, warehouse_id, mode, transit_days,
                                       freight_cost)
           values ($1,'Pune-Plant-1',$2::transport_mode,$3,$4)
           on conflict (supplier_id, warehouse_id, mode)
             do update set transit_days = excluded.transit_days""",
        supplier_id, mode, transit, float(offer.get("freight_cost") or 0))

    await conn.execute(
        """insert into supplier_catalog (supplier_id, component_id, unit_price,
                                         lead_time_days, available_quantity,
                                         min_order_quantity)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (supplier_id, component_id) do update
             set unit_price         = excluded.unit_price,
                 lead_time_days     = excluded.lead_time_days,
                 available_quantity = excluded.available_quantity,
                 min_order_quantity = excluded.min_order_quantity""",
        supplier_id, component_id,
        float(offer.get("unit_price") or 0),
        # lead_time_days on the catalogue row is the supplier's own readiness;
        # the lane adds transit on top. Counting the same days twice would
        # reject suppliers who can actually make the date.
        0,
        int(offer.get("quantity") or 0),
        max(1, int(offer.get("min_order_quantity") or 1)))

    # --- the claim we deliberately do not believe -----------------------------
    claimed = {c.upper() for c in (offer.get("certifications") or [])}
    on_file = {c.upper() for c in (await conn.fetchval(
        "select certifications from suppliers where id=$1", supplier_id) or [])}
    unverified = sorted(claimed - on_file)
    if unverified:
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="CERTIFICATION_CLAIM_UNVERIFIED",
                   human_summary=(
                       f"{supplier_name} asserts {', '.join(unverified)} in their reply. "
                       f"That is not on their certification record, so it does not count "
                       f"toward the requirement — a certification is a document, not a "
                       f"sentence in an email."),
                   payload={"supplier_id": supplier_id, "claimed": sorted(claimed),
                            "on_file": sorted(on_file), "unverified": unverified})

    return {"component_id": component_id, "mode": mode,
            "unverified_certifications": unverified}


async def reply(conn, supplier_id: str, *, thread_id: int | None, kind: str,
                body: str = "", offer: dict | None = None,
                note: str = "") -> dict[str, Any]:
    """A supplier answers. The single entry point for everything the portal does.

    `kind` is one of quote | vague | decline | freeform, and it changes what is
    written to the world — never how the answer is *read*. The parser sees prose
    either way, because that is what it will see in production.
    """
    if kind not in ("quote", "vague", "decline", "freeform"):
        raise ValueError("kind must be quote, vague, decline or freeform")

    sup = await conn.fetchrow(
        "select id, coalesce(legal_name, name) as name from suppliers where id=$1",
        supplier_id)
    if sup is None:
        raise ValueError(f"unknown supplier {supplier_id}")
    name = sup["name"]

    component_id = (offer or {}).get("component_id")
    component_name = None
    if component_id:
        component_name = await conn.fetchval(
            "select coalesce(display_name, name) from components where id=$1", component_id)

    # --- find or open the conversation ---------------------------------------
    incident_id = None
    if thread_id:
        t = await conn.fetchrow("select * from message_threads where id=$1", thread_id)
        if t is None:
            raise ValueError(f"unknown thread {thread_id}")
        if t["counterparty_id"] != supplier_id:
            raise ValueError(f"thread {thread_id} does not belong to {supplier_id}")
        incident_id = t["incident_id"]
    else:
        incident_id = await conn.fetchval(
            """select incident_id from message_threads
                where counterparty_id=$1 and status <> 'closed'
                order by id desc limit 1""", supplier_id)
        thread_id = await open_thread(
            conn, incident_id=incident_id, counterparty_type="supplier",
            counterparty_id=supplier_id, counterparty_name=name,
            subject=f"Message from {name}")

    text = (body or "").strip() or compose(kind, offer, note, name, component_name)

    await post(conn, thread_id=thread_id, direction="inbound", author_type="supplier",
               author_name=name, body=text, incident_id=incident_id,
               delivery_state="replied")
    await conn.execute(
        """update message_threads set status='open', needs_reply=false,
               last_activity_at=now() where id=$1""", thread_id)
    await conn.execute(
        """update thread_messages set delivery_state='replied'
            where thread_id=$1 and direction='outbound'
              and delivery_state in ('sent','awaiting_response')""", thread_id)

    # --- read it back out of prose, exactly as a real reply would be ----------
    raw, used_llm = await llm.interpret_supplier_message(
        text, {"component_name": component_name or "", "supplier_name": name})
    interp = parsing.interpret(text, raw if used_llm else None).to_dict()

    await emit(conn, incident_id=incident_id, actor="agent",
               event_type="MESSAGE_INTERPRETED",
               human_summary=f"Read {name}’s reply — {interp['summary']}",
               payload={**interp, "supplier_id": supplier_id, "supplier_name": name,
                        "llm": used_llm, "message": text, "via": "supplier_portal"})

    applied: dict[str, Any] | None = None
    quote_id: int | None = None

    # --- what the answer changes about the world ------------------------------
    if kind == "quote" and offer and offer.get("component_id"):
        sim = round((CLOCK.now() - CLOCK.sim_start).total_seconds(), 2)
        quote_id = await conn.fetchval(
            """insert into supplier_quotes
                 (thread_id, incident_id, supplier_id, component_id, quantity_offered,
                  unit_price, lead_time_days, mode, min_order_quantity, certifications,
                  expedite_available, expedite_fee, note, source, status,
                  applied_to_catalog, simulated_at_seconds)
               values ($1,$2,$3,$4,$5,$6,$7,$8::transport_mode,$9,$10,$11,$12,$13,
                       'portal','applied',true,$14)
            returning id""",
            thread_id, incident_id, supplier_id, offer["component_id"],
            offer.get("quantity"), offer.get("unit_price"), offer.get("lead_time_days"),
            (offer.get("mode") or "ROAD").upper(), offer.get("min_order_quantity"),
            [c.upper() for c in (offer.get("certifications") or [])],
            bool(offer.get("expedite_available")), float(offer.get("expedite_fee") or 0),
            note or None, sim)
        applied = await _apply_quote(conn, supplier_id, offer, name, incident_id)
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="QUOTE_RECEIVED",
                   human_summary=(
                       f"{name} quoted {offer.get('quantity')} units of "
                       f"{component_name or offer['component_id']} at Rs "
                       f"{offer.get('unit_price')}/unit, "
                       f"{offer.get('lead_time_days')}-day lead. Catalogue updated — "
                       f"this will be costed against every other option."),
                   payload={"quote_id": quote_id, "supplier_id": supplier_id,
                            **{k: v for k, v in offer.items() if k != "note"}})

    elif kind == "decline":
        # An honest "no" is worth as much as a yes: it removes them from the pool
        # instead of leaving the solver costing an option that does not exist.
        if component_id:
            await conn.execute(
                """update supplier_catalog set available_quantity = 0
                    where supplier_id=$1 and component_id=$2""", supplier_id, component_id)
        else:
            await conn.execute(
                "update supplier_catalog set available_quantity = 0 where supplier_id=$1",
                supplier_id)
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="SUPPLIER_DECLINED",
                   human_summary=(f"{name} cannot supply "
                                  f"{component_name or 'the requested component'}. "
                                  f"Removed from the candidate pool and replanning."),
                   payload={"supplier_id": supplier_id, "component_id": component_id})

    # --- when the agent should not guess --------------------------------------
    request_id = None
    if interp["needs_human"]:
        request_id = await raise_human_input(
            conn, kind="ambiguous_reply", incident_id=incident_id, thread_id=thread_id,
            supplier_id=supplier_id, component_id=component_id,
            question=f"{name}’s reply cannot be acted on as written.",
            detail=interp["needs_human_reason"],
            confidence=interp["confidence"],
            context={"message": text, "interpretation": interp, "supplier_name": name},
            options=[
                {"id": "chase", "label": "Ask them to commit",
                 "detail": "Send a follow-up asking for a firm quantity, price and date.",
                 "effect": "One more message on this thread; the agent keeps waiting."},
                {"id": "takeover", "label": "I will reply myself",
                 "detail": "Hand this thread to a human. The agent stops writing here.",
                 "effect": "Thread autonomy becomes human."},
                {"id": "exclude", "label": "Source elsewhere",
                 "detail": f"Drop {name} from this recovery and replan without them.",
                 "effect": "A permanent constraint for this incident; the plan re-forms."},
            ])

    # --- let the agent look again ---------------------------------------------
    replanned = None
    target = component_id or await conn.fetchval(
        """select component_id from purchase_orders
            where supplier_id=$1 order by created_at desc limit 1""", supplier_id)
    if target:
        from . import agent                     # local import: avoids a cycle
        try:
            replanned = await agent.wake(
                conn, component_id=target, trigger=f"supplier reply from {supplier_id}")
        except Exception as exc:                # noqa: BLE001 — a reply must never 500
            await emit(conn, actor="risk_detector", event_type="AGENT_WAKE_FAILED",
                       human_summary=f"Could not re-evaluate after {name}'s reply: {exc}",
                       payload={"supplier_id": supplier_id})

    await broadcast_state("supplier_replied",
                          {"supplier_id": supplier_id, "thread_id": thread_id})

    return {"ok": True, "thread_id": thread_id, "incident_id": incident_id or replanned,
            "interpretation": interp, "quote_id": quote_id, "applied": applied,
            "human_input_request_id": request_id, "message": text}


async def claim_dispatch(conn, supplier_id: str, *, po_id: str,
                         claim: str = "dispatched", note: str = "") -> dict[str, Any]:
    """Let a person tell the lie, so catching it means something.

    Runs down the injector's own `supplier_claim` path — the identical code the
    built-in adversarial scenario uses — so there is no portal-only branch that
    could behave differently from the one we demo.
    """
    owner = await conn.fetchval("select supplier_id from purchase_orders where id=$1", po_id)
    if owner is None:
        raise ValueError(f"unknown purchase order {po_id}")
    if owner != supplier_id:
        raise ValueError(f"{po_id} does not belong to {supplier_id}")

    from . import injector                      # local import: avoids a cycle
    name = await conn.fetchval(
        "select coalesce(legal_name, name) from suppliers where id=$1", supplier_id)
    out = await injector.apply_event(conn, "supplier_claim", {
        "po_id": po_id, "claim": claim,
        "body": note or f"Shipment for {po_id} has been {claim}.",
    })
    await broadcast_state("supplier_claimed", {"supplier_id": supplier_id, "po_id": po_id})
    return {**out, "supplier_id": supplier_id, "supplier_name": name, "po_id": po_id}


# ------------------------------------------------------- human input queue ---
#
# Lives here rather than in its own module because every producer of one of
# these so far is a message somebody sent. If a second family of them appears
# (a solver that cannot break a tie, say) this moves out.


async def raise_human_input(conn, *, kind: str, question: str,
                            detail: str | None = None,
                            incident_id: str | None = None,
                            thread_id: int | None = None,
                            supplier_id: str | None = None,
                            component_id: str | None = None,
                            confidence: float | None = None,
                            context: dict | None = None,
                            options: list[dict] | None = None) -> int:
    """Record a question the agent is not entitled to answer.

    Deduped on (kind, thread_id, supplier_id) while still open: the agent
    re-investigates on every new piece of evidence, and asking a human the same
    question four times is how a queue becomes something people stop reading.
    """
    existing = await conn.fetchval(
        """select id from human_input_requests
            where status='open' and kind=$1
              and thread_id is not distinct from $2
              and supplier_id is not distinct from $3
            limit 1""", kind, thread_id, supplier_id)
    if existing:
        return int(existing)

    sim = round((CLOCK.now() - CLOCK.sim_start).total_seconds(), 2)
    rid = await conn.fetchval(
        """insert into human_input_requests
             (incident_id, thread_id, supplier_id, component_id, kind, question,
              detail, context, options, confidence, simulated_at_seconds)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11) returning id""",
        incident_id, thread_id, supplier_id, component_id, kind, question, detail,
        json.dumps(context or {}, default=str), json.dumps(options or [], default=str),
        confidence, sim)

    await emit(conn, incident_id=incident_id, actor="agent",
               event_type="HUMAN_INPUT_REQUIRED",
               human_summary=f"{question} {detail or ''}".strip(),
               payload={"request_id": rid, "kind": kind, "confidence": confidence,
                        "options": options or [], "supplier_id": supplier_id,
                        **(context or {})})
    await broadcast_state("human_input_required", {"request_id": rid, "kind": kind})
    return int(rid)


async def resolve_human_input(conn, request_id: int, *, choice: str,
                              note: str | None = None,
                              decided_by: str = "operator") -> dict[str, Any]:
    """Answer the question, and make the answer do something.

    An option that only closes a card is worse than no option at all — it
    teaches the operator that the agent's questions are decorative.
    """
    row = await conn.fetchrow("select * from human_input_requests where id=$1", request_id)
    if row is None:
        raise ValueError(f"unknown request {request_id}")
    if row["status"] != "open":
        raise ValueError(f"request {request_id} is already {row['status']}")

    ctx = row["context"]
    ctx = json.loads(ctx) if isinstance(ctx, str) else (ctx or {})
    supplier_id = row["supplier_id"]
    supplier_name = ctx.get("supplier_name") or supplier_id or "the counterparty"
    incident_id = row["incident_id"]
    effect = "Recorded."

    if choice == "chase" and row["thread_id"]:
        await post(conn, thread_id=row["thread_id"], direction="outbound",
                   author_type="agent", author_name="DisruptionOps Agent",
                   incident_id=incident_id, delivery_state="awaiting_response",
                   to_name=supplier_name,
                   body=("Thank you, but we cannot plan against that reply.\n\n"
                         "Please confirm three things explicitly: the exact quantity you "
                         "can release, the unit price, and the date it will physically "
                         "leave your facility. If you cannot commit to all three, say so "
                         "and we will source elsewhere."))
        await conn.execute(
            "update message_threads set status='awaiting_reply' where id=$1", row["thread_id"])
        effect = f"Follow-up sent to {supplier_name} asking for a firm commitment."

    elif choice == "takeover" and row["thread_id"]:
        await conn.execute(
            "update message_threads set autonomy='human' where id=$1", row["thread_id"])
        effect = "This thread is yours now — the agent will not write on it again."

    elif choice == "exclude" and supplier_id:
        await conn.execute(
            """insert into agent_constraints
                 (incident_id, constraint_type, target, reason, created_by)
               values ($1,'exclude_supplier',$2,$3,'human')""",
            incident_id, supplier_id,
            note or f"Excluded by {decided_by} — reply could not be relied on")
        effect = f"{supplier_name} excluded from this recovery. Replanning without them."

    elif choice == "accept_claim":
        effect = "Claim accepted on your authority. Recorded against your name, not the agent's."

    await conn.execute(
        """update human_input_requests
              set status='resolved', chosen_option=$2, note=$3,
                  resolved_by=$4, resolved_at=now()
            where id=$1""", request_id, choice, note, decided_by)

    await emit(conn, incident_id=incident_id, actor=decided_by,
               event_type="HUMAN_INPUT_RESOLVED",
               human_summary=(f"{decided_by} answered: {choice}. {effect}"
                              + (f" Note: {note}" if note else "")),
               payload={"request_id": request_id, "choice": choice, "note": note,
                        "effect": effect, "question": row["question"]})

    # The answer changed the constraints. Let the agent act on it rather than
    # leaving it holding a plan built on the thing the human just overruled.
    if choice in ("exclude", "accept_claim") and (row["component_id"] or incident_id):
        cid = row["component_id"] or await conn.fetchval(
            "select component_id from incidents where id=$1", incident_id)
        if cid:
            from . import agent
            try:
                await agent.wake(conn, component_id=cid,
                                 trigger=f"human answered: {choice}")
            except Exception:                   # noqa: BLE001
                pass

    await broadcast_state("human_input_resolved", {"request_id": request_id})
    return {"ok": True, "request_id": request_id, "choice": choice, "effect": effect}


async def open_requests(conn) -> list[dict]:
    rows = await conn.fetch(
        """select h.*, coalesce(s.legal_name, s.name) as supplier_name,
                  coalesce(c.display_name, c.name) as component_name,
                  t.subject as thread_subject
             from human_input_requests h
             left join suppliers s on s.id = h.supplier_id
             left join components c on c.id = h.component_id
             left join message_threads t on t.id = h.thread_id
            where h.status = 'open' order by h.id desc limit 30""")
    out = []
    for r in rows:
        d = dict(r)
        for key in ("context", "options"):
            if isinstance(d.get(key), str):
                d[key] = json.loads(d[key])
        out.append(d)
    return out


async def recent_resolved(conn, limit: int = 10) -> list[dict]:
    rows = await conn.fetch(
        """select id, kind, question, chosen_option, note, resolved_by, resolved_at
             from human_input_requests
            where status='resolved' order by resolved_at desc limit $1""", limit)
    return [dict(r) for r in rows]
