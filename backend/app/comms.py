"""Communication layer — agent ↔ supplier · warehouse · carrier · human.

Threads, not a chatbot. Every message is an operational act with a delivery
state, and every message emits an audit event.

Suppliers have PERSONAS, which is what makes the demo honest: SUP-21 lies about
dispatch, SUP-33 over-promises and under-delivers, SUP-42 is straight. The agent
is not told who lies — it finds out by checking carrier data.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from . import llm, parsing
from .core import CLOCK, broadcast_state, db, db_conn, emit, run_context

#: How a simulated counterparty behaves. Never revealed to the agent.
PERSONAS: dict[str, dict[str, Any]] = {
    "SUP-21": {"style": "evasive", "reply_delay_h": 6,
               "script": "Shipment has been dispatched and should arrive shortly. "
                         "We appreciate your patience.",
               "lies": True},
    "SUP-42": {"style": "straight", "reply_delay_h": 2,
               "script": "Confirmed. We can release 300 units immediately at Rs 132/unit, "
                         "4-day road transit, AEC-Q100 certified. Expedite available."},
    "SUP-33": {"style": "eager", "reply_delay_h": 1,
               "script": "Yes — 500 units available, Rs 145/unit, we can be at your gate "
                         "in 2 days. Local Pune stock."},
    "SUP-57": {"style": "formal", "reply_delay_h": 4,
               "script": "300 units available ex-Taipei at Rs 138/unit. Air freight 3 days, "
                         "IATF 16949 and AEC-Q100 certified. Minimum order 300."},
    "SUP-18": {"style": "pushy", "reply_delay_h": 1,
               "script": "800 units ready at Rs 108/unit, 3-day shipping. Best price you "
                         "will find. Certification paperwork can follow later."},
    "SUP-88": {"style": "straight", "reply_delay_h": 3,
               "script": "500 Li-ion modules available, Rs 902/unit. Road transport only — "
                         "IEC-62133 restricts air freight for these cells."},
}
DEFAULT_PERSONA = {"style": "neutral", "reply_delay_h": 3,
                   "script": "We have received your enquiry and will revert shortly."}

WAREHOUSE_REPLY = ("Physical count complete. {usable} units are usable. "
                   "{held} units are in quality hold pending inspection.")


# ----------------------------------------------------------------- core ----


async def open_thread(conn, *, incident_id: str | None, counterparty_type: str,
                      counterparty_id: str | None, counterparty_name: str | None,
                      subject: str) -> int:
    existing = await conn.fetchval(
        """select id from message_threads
            where incident_id is not distinct from $1
              and counterparty_id is not distinct from $2
              and status <> 'closed' limit 1""", incident_id, counterparty_id)
    if existing:
        return existing
    # Stamp the run. Threads were the one runtime artefact that never carried it,
    # which is why the supplier portal happily showed four conversations in a
    # world with no active run — the rows were real, they just belonged to a run
    # that had been wiped. A conversation is evidence about a run like anything
    # else.
    return await conn.fetchval(
        """insert into message_threads
             (incident_id, counterparty_type, counterparty_id, counterparty_name,
              subject, scenario_run_id)
           values ($1,$2,$3,$4,$5,$6) returning id""",
        incident_id, counterparty_type, counterparty_id, counterparty_name, subject,
        (run_context() or {}).get("run_id"))


async def post(conn, *, thread_id: int, direction: str, author_type: str,
               author_name: str, body: str, incident_id: str | None = None,
               delivery_state: str = "sent", is_contradiction: bool = False,
               to_name: str | None = None) -> dict:
    sim = round((CLOCK.now() - CLOCK.sim_start).total_seconds(), 2)
    row = await conn.fetchrow(
        """insert into thread_messages
             (thread_id, direction, author_type, author_name, body,
              delivery_state, is_contradiction, simulated_at_seconds)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning *""",
        thread_id, direction, author_type, author_name, body,
        delivery_state, is_contradiction, sim)
    msg = dict(row)
    await broadcast_state("message", {"thread_id": thread_id, "message": msg})

    # A draft is not a message yet. Logging it as MESSAGE_SENT would put a
    # sentence in the audit trail that never left the building — which is
    # precisely the kind of thing an auditor would later find and stop trusting
    # the rest of the log over.
    if delivery_state == "draft":
        return msg

    await emit(conn, incident_id=incident_id,
               actor="agent" if author_type == "agent" else author_type,
               event_type="MESSAGE_SENT" if direction == "outbound" else "MESSAGE_RECEIVED",
               human_summary=(
                   f"Wrote to {to_name or 'counterparty'}: {body.splitlines()[0][:100]}"
                   if direction == "outbound" else
                   f"Heard back from {author_name}: {body.splitlines()[0][:100]}"),
               payload={"thread_id": thread_id, "author": author_name,
                        "delivery_state": delivery_state})
    return msg


# ------------------------------------------------------------- supplier ----


async def agent_message_supplier(conn, *, incident_id: str, supplier_id: str,
                                 kind: str, context: dict) -> int:
    """Write to a supplier — or draft and stop, if this thread says so.

    "The agent emailed my supplier in my name" is the single most common reason
    a buyer refuses to switch a tool like this on. Autonomy is therefore a
    property of the conversation, not a global setting: chase a freight
    forwarder automatically, hand-hold the relationship that matters.
    """
    sup = await conn.fetchrow(
        "select coalesce(legal_name, name) as name, email from suppliers where id=$1",
        supplier_id)
    name = sup["name"] if sup else supplier_id

    subject = {"delay_confirmation": f"Urgent — delivery confirmation required "
                                     f"({context.get('po_id','')})",
               "rfq": f"Urgent RFQ — {context.get('component_name','component')}"}.get(
        kind, "Supply enquiry")

    thread_id = await open_thread(
        conn, incident_id=incident_id, counterparty_type="supplier",
        counterparty_id=supplier_id, counterparty_name=name, subject=subject)

    autonomy = await conn.fetchval(
        "select autonomy from message_threads where id=$1", thread_id) or "autonomous"

    body, used_llm = await llm.draft_supplier_message(kind, context)

    # --- hands off ------------------------------------------------------------
    if autonomy == "human":
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="MESSAGE_SUPPRESSED",
                   human_summary=(f"Did not write to {name} — this conversation is "
                                  f"marked for human handling. What I would have asked: "
                                  f"{body.splitlines()[0][:120]}"),
                   payload={"thread_id": thread_id, "supplier_id": supplier_id,
                            "autonomy": autonomy, "would_have_written": body})
        return thread_id

    # --- draft and wait -------------------------------------------------------
    if autonomy == "draft":
        await post(conn, thread_id=thread_id, direction="outbound", author_type="agent",
                   author_name="DisruptionOps Agent", body=body, incident_id=incident_id,
                   delivery_state="draft", to_name=name)
        await conn.execute(
            "update message_threads set needs_reply=true, last_activity_at=now() where id=$1",
            thread_id)
        await emit(conn, incident_id=incident_id, actor="agent",
                   event_type="MESSAGE_DRAFTED",
                   human_summary=f"Drafted a message to {name} and stopped. "
                                 f"It will not send until you press send.",
                   payload={"thread_id": thread_id, "supplier_id": supplier_id})
        await broadcast_state("draft_waiting", {"thread_id": thread_id})
        return thread_id

    # --- act ------------------------------------------------------------------
    await post(conn, thread_id=thread_id, direction="outbound", author_type="agent",
               author_name="DisruptionOps Agent", body=body, incident_id=incident_id,
               delivery_state="awaiting_response", to_name=name)
    await conn.execute(
        """update message_threads set status='awaiting_reply', last_activity_at=now()
            where id=$1""", thread_id)

    # Counterparty replies later, on the simulated clock — unless a person has
    # taken that desk, in which case we genuinely wait for them.
    asyncio.create_task(_supplier_reply(thread_id, supplier_id, name, incident_id))
    return thread_id


async def send_draft(conn, message_id: int, *, edited_body: str | None = None,
                     sent_by: str = "operator") -> dict:
    """Release a held draft. This is the human pressing send."""
    msg = await conn.fetchrow("select * from thread_messages where id=$1", message_id)
    if msg is None:
        raise ValueError(f"unknown message {message_id}")
    if msg["delivery_state"] != "draft":
        raise ValueError(f"message {message_id} is not a draft")

    body = (edited_body or msg["body"]).strip()
    thread = await conn.fetchrow(
        "select * from message_threads where id=$1", msg["thread_id"])

    await conn.execute(
        """update thread_messages set body=$2, delivery_state='awaiting_response'
            where id=$1""", message_id, body)
    await conn.execute(
        """update message_threads set status='awaiting_reply', needs_reply=false,
               last_activity_at=now() where id=$1""", msg["thread_id"])

    await emit(conn, incident_id=thread["incident_id"], actor=sent_by,
               event_type="DRAFT_SENT",
               human_summary=(f"{sent_by} sent the agent's draft to "
                              f"{thread['counterparty_name']}"
                              + (" (edited)." if edited_body and
                                 edited_body.strip() != msg["body"].strip() else ".")),
               payload={"thread_id": msg["thread_id"], "message_id": message_id,
                        "edited": bool(edited_body and
                                       edited_body.strip() != msg["body"].strip())})
    await broadcast_state("message", {"thread_id": msg["thread_id"]})

    if thread["counterparty_type"] == "supplier" and thread["counterparty_id"]:
        asyncio.create_task(_supplier_reply(
            msg["thread_id"], thread["counterparty_id"],
            thread["counterparty_name"], thread["incident_id"]))
    return {"ok": True, "message_id": message_id, "thread_id": msg["thread_id"]}


async def set_autonomy(conn, thread_id: int, mode: str, *, by: str = "operator") -> dict:
    if mode not in ("autonomous", "draft", "human"):
        raise ValueError("mode must be autonomous, draft or human")
    row = await conn.fetchrow("select * from message_threads where id=$1", thread_id)
    if row is None:
        raise ValueError(f"unknown thread {thread_id}")
    await conn.execute("update message_threads set autonomy=$2 where id=$1", thread_id, mode)
    said = {"autonomous": "the agent may write and send on this thread by itself",
            "draft": "the agent will write here but nothing sends until you release it",
            "human": "the agent will not write on this thread at all"}[mode]
    await emit(conn, incident_id=row["incident_id"], actor=by,
               event_type="THREAD_AUTONOMY_CHANGED",
               human_summary=f"{row['counterparty_name']} — {said}.",
               payload={"thread_id": thread_id, "autonomy": mode, "by": by})
    await broadcast_state("thread_autonomy", {"thread_id": thread_id, "autonomy": mode})
    return {"ok": True, "thread_id": thread_id, "autonomy": mode}


async def _supplier_reply(thread_id: int, supplier_id: str, name: str,
                          incident_id: str | None) -> None:
    """The scripted counterparty answers — unless a person is at their desk.

    Presence beats the script. A scripted liar proves nothing about an agent:
    the interesting version is a human at `/supplier/SUP-21` deciding, live,
    whether to tell the truth. So while somebody is sitting at that portal the
    persona stands down entirely and the agent genuinely waits for them. Close
    the tab and the personas resume, so an unattended demo still runs end to end.
    """
    from . import supplier_portal               # local import: avoids a cycle

    persona = PERSONAS.get(supplier_id, DEFAULT_PERSONA)
    # Simulated hours → real seconds via the clock rate.
    await asyncio.sleep(max(0.6, persona["reply_delay_h"] * CLOCK.seconds_per_sim_hour))

    if supplier_portal.present(supplier_id):
        try:
            async with db_conn() as conn:
                await conn.execute(
                    "update message_threads set status='awaiting_reply' where id=$1",
                    thread_id)
                await emit(conn, incident_id=incident_id, actor="agent",
                           event_type="AWAITING_COUNTERPARTY",
                           human_summary=(
                               f"Waiting on {name}. Somebody is at their portal, so this "
                               f"is a real answer from a real person — I am not going to "
                               f"invent one, and I am not going to plan as though it "
                               f"already arrived."),
                           payload={"thread_id": thread_id, "supplier_id": supplier_id,
                                    "staffed": True})
                await broadcast_state("awaiting_counterparty",
                                      {"thread_id": thread_id, "supplier_id": supplier_id})
        except Exception:                       # noqa: BLE001
            pass
        return

    try:
        async with db_conn() as conn:
            await post(conn, thread_id=thread_id, direction="inbound",
                       author_type="supplier", author_name=name,
                       body=persona["script"], incident_id=incident_id,
                       delivery_state="replied",
                       is_contradiction=bool(persona.get("lies")))
            await conn.execute(
                "update thread_messages set delivery_state='replied' "
                "where thread_id=$1 and direction='outbound'", thread_id)
            await conn.execute("update message_threads set status='open' where id=$1", thread_id)

            # Deterministic extraction always runs and always produces a result.
            # The model, when it is available, may sharpen a field the parser
            # missed — it may not overrule a number read straight from the text.
            raw, used_llm = await llm.interpret_supplier_message(
                persona["script"], {"po_id": "", "component_name": name})
            interp = parsing.interpret(persona["script"],
                                       raw if used_llm else None).to_dict()

            await emit(conn, incident_id=incident_id, actor="agent",
                       event_type="MESSAGE_INTERPRETED",
                       human_summary=f"Read {name}\u2019s reply \u2014 {interp['summary']}",
                       agent_reason=(
                           f"Deterministic extraction ran first and read: "
                           f"quantity={interp.get('quantity_mentioned')}, "
                           f"price={interp.get('unit_price')}, "
                           f"lead time={interp.get('lead_time_days')} days. "
                           f"Confidence {interp.get('confidence')}. "
                           + ("A model refined this but could not overrule a number read "
                              "straight from the text." if used_llm
                              else "No model was available; this is the parser alone.")),
                       payload={**interp, "supplier_id": supplier_id,
                                "supplier_name": name, "llm": used_llm,
                                "message": persona["script"]})

            # An offer we cannot act on is a decision for a person, not a guess.
            # It goes into the queue as a row with a status, because a question
            # emitted only into a log file is the agent talking to itself.
            if interp["needs_human"]:
                await supplier_portal.raise_human_input(
                    conn, kind="ambiguous_reply", incident_id=incident_id,
                    thread_id=thread_id, supplier_id=supplier_id,
                    question=f"{name}\u2019s reply cannot be acted on as written.",
                    detail=interp["needs_human_reason"],
                    confidence=interp["confidence"],
                    context={"message": persona["script"], "interpretation": interp,
                             "supplier_name": name},
                    options=[
                        {"id": "chase", "label": "Ask them to commit",
                         "detail": "Send a follow-up asking for a firm quantity, price "
                                   "and despatch date.",
                         "effect": "One more message on this thread; the agent waits."},
                        {"id": "takeover", "label": "I will reply myself",
                         "detail": "Hand this thread to a human. The agent stops "
                                   "writing here.",
                         "effect": "Thread autonomy becomes human."},
                        {"id": "exclude", "label": "Source elsewhere",
                         "detail": f"Drop {name} from this recovery and replan.",
                         "effect": "A constraint for this incident; the plan re-forms."},
                    ])
    except Exception:                              # noqa: BLE001
        pass


# ------------------------------------------------------------ warehouse ----


async def agent_request_warehouse(conn, *, incident_id: str, component_id: str,
                                  task_type: str, context: dict) -> dict:
    """A warehouse request is a TASK plus a message. Two different things."""
    name = context.get("component_name", component_id)

    # One open task per (component, type). The agent re-investigates on every new
    # piece of evidence; the warehouse should not get the same request four times.
    existing = await conn.fetchval(
        """select id from warehouse_tasks
            where component_id=$1 and task_type=$2 and status in ('open','in_progress')
            limit 1""", component_id, task_type)
    if existing:
        return {"task_id": existing, "thread_id": None, "deduped": True}

    task_id = await conn.fetchval(
        """insert into warehouse_tasks
             (facility_id, component_id, incident_id, task_type, priority,
              requested_by, instructions, scenario_run_id)
           values ('Pune-Plant-1',$1,$2,$3,'urgent','agent',$4,$5) returning id""",
        component_id, incident_id, task_type,
        f"Confirm physically usable stock of {name}. ERP shows "
        f"{context.get('erp_stock')} units. Production may stop in "
        f"{context.get('coverage_days', '?')} days.",
        # Stamp the run: a task raised during a wiped run is not a task.
        (run_context() or {}).get("run_id"))

    thread_id = await open_thread(
        conn, incident_id=incident_id, counterparty_type="warehouse",
        counterparty_id="Pune-Plant-1", counterparty_name="Pune Plant Warehouse",
        subject=f"Stock verification — {name}")

    body, _ = await llm.draft_supplier_message("warehouse_verify", context)
    await post(conn, thread_id=thread_id, direction="outbound", author_type="agent",
               author_name="DisruptionOps Agent", body=body, incident_id=incident_id,
               delivery_state="awaiting_response", to_name="Pune Plant Warehouse")

    await emit(conn, incident_id=incident_id, actor="agent", event_type="WAREHOUSE_TASK_CREATED",
               human_summary=f"Raised warehouse task #{task_id} — verify usable stock of {name}.",
               payload={"task_id": task_id, "task_type": task_type})
    await broadcast_state("warehouse_task", {"task_id": task_id, "status": "open"})
    return {"task_id": task_id, "thread_id": thread_id}


async def warehouse_complete_task(conn, task_id: int, result: dict) -> dict:
    """Operator submits physical reality. This is the loop closing."""
    task = await conn.fetchrow("select * from warehouse_tasks where id=$1", task_id)
    if task is None:
        raise ValueError(f"unknown task {task_id}")

    usable = int(result.get("usable_stock", 0))
    held = int(result.get("quarantined_stock", 0))

    await conn.execute(
        """update warehouse_tasks set status='done', completed_at=now(), result_payload=$2::jsonb
            where id=$1""", task_id, json.dumps(result))
    await conn.execute(
        """update inventory set usable_stock=$2, quarantined_stock=$3, last_updated=now()
            where component_id=$1""", task["component_id"], usable, held)

    name = await conn.fetchval(
        "select coalesce(display_name,id) from components where id=$1", task["component_id"])

    thread_id = await open_thread(
        conn, incident_id=task["incident_id"], counterparty_type="warehouse",
        counterparty_id="Pune-Plant-1", counterparty_name="Pune Plant Warehouse",
        subject=f"Stock verification — {name}")
    await post(conn, thread_id=thread_id, direction="inbound", author_type="warehouse",
               author_name="Pune Plant Warehouse",
               body=WAREHOUSE_REPLY.format(usable=usable, held=held),
               incident_id=task["incident_id"], delivery_state="replied")

    await emit(conn, incident_id=task["incident_id"], actor="warehouse",
               event_type="PHYSICAL_COUNT_CONFIRMED",
               human_summary=f"Warehouse confirmed {usable} usable units of {name}"
                             + (f", {held} in quality hold." if held else "."),
               payload={"component_id": task["component_id"], "usable_stock": usable,
                        "quarantined_stock": held, "task_id": task_id})
    await broadcast_state("inventory_changed", {"component_id": task["component_id"]})

    return {"task_id": task_id, "component_id": task["component_id"],
            "usable_stock": usable, "quarantined_stock": held,
            "incident_id": task["incident_id"]}


# --------------------------------------------------------------- carrier ---


async def carrier_update(conn, *, po_id: str, status: str, note: str | None = None,
                         incident_id: str | None = None) -> None:
    await conn.execute(
        """insert into shipment_tracking (po_id, tracking_status, last_movement, updated_at)
           values ($1,$2,now(),now())
           on conflict (po_id) do update set tracking_status=$2, updated_at=now()""",
        po_id, status)
    thread_id = await open_thread(
        conn, incident_id=incident_id, counterparty_type="carrier",
        counterparty_id="CARRIER", counterparty_name="Carrier Network",
        subject=f"Tracking — {po_id}")
    await post(conn, thread_id=thread_id, direction="inbound", author_type="carrier",
               author_name="Carrier Network",
               body=note or f"Scan update for {po_id}: {status}.",
               incident_id=incident_id, delivery_state="delivered")


async def threads_for(conn, incident_id: str | None = None) -> list[dict]:
    """Threads plus the three facts the inbox is sorted on.

    `needs_you` is the whole point of the Communications screen: an inbox that
    only shows conversations makes you read all of them to find the two that are
    stuck. A thread needs you when a draft is waiting to be released, when the
    agent has been told to keep its hands off, or when there is an unanswered
    question attached to it.
    """
    from . import supplier_portal               # local import: avoids a cycle

    if incident_id:
        rows = await conn.fetch(
            "select * from message_threads where incident_id=$1 order by id", incident_id)
    else:
        rows = await conn.fetch("select * from message_threads order by id desc limit 40")

    pending = {r["thread_id"] for r in await conn.fetch(
        "select distinct thread_id from human_input_requests where status='open'")
        if r["thread_id"] is not None}

    out = []
    for t in rows:
        msgs = [dict(m) for m in await conn.fetch(
            "select * from thread_messages where thread_id=$1 order by id", t["id"])]
        drafts = [m for m in msgs if m["delivery_state"] == "draft"]
        last = msgs[-1] if msgs else None
        staffed = (t["counterparty_type"] == "supplier" and t["counterparty_id"]
                   and supplier_portal.present(t["counterparty_id"]))
        out.append({
            **dict(t),
            "messages": msgs,
            "drafts": len(drafts),
            "last_message": last,
            "has_contradiction": any(m["is_contradiction"] for m in msgs),
            "open_question": t["id"] in pending,
            "counterparty_staffed": bool(staffed),
            "needs_you": bool(drafts) or t["id"] in pending or t["autonomy"] == "human",
        })
    return out
