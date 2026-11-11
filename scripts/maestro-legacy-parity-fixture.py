"""Generates tests/fixtures/maestro-legacy-parity.json from the server SDK parity suite.

Run it inside the server SDK repository (branch feat/paridade-contrato-sdk), with its venv:

    cd <dooers-agents-server>
    PYTHONPATH=. .venv/bin/python <client>/scripts/maestro-legacy-parity-fixture.py \
        > <client>/tests/fixtures/maestro-legacy-parity.json

Production side: ``run_legacy(<scenario>)`` of ``tests/parity`` (a real ``AgentServer`` in
``thread_management="agent"``). Every persisted ``ThreadEvent`` is written the way
``serialize_frame`` writes it on the WebSocket (``exclude_none=True, by_alias=True``); runs the
same way. Nothing on this side is written by hand.

Maestro side: every ``AgentEvent`` the scenario handler yields goes through the SDK's own
``output_for`` (``maestro/outputs.py``, index rule 4.1) and becomes the event Maestro stores
(``<type>.create`` -> ``<type>.created``; Maestro adds ``agent_id`` and ``trigger_event_id`` to
``run.updated``). Two parts are built here because the SDK sink does not exist yet (plans 3 and
5): the ``media_link`` part of ``send.image/audio/document`` (index 4.3) and the initial
``channel_delivery.updated`` of a WhatsApp send (status and provider id of the tools-whatsapp
answer). The human side of a form response comes from the scenario turn. Event ids, the thread
id, run ids and dates are the ones of the matching production event, so the test compares them
directly.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import json
import subprocess
import sys
from collections.abc import Iterator
from typing import Any

from dooers.agents.server.handlers.send import AgentEvent
from dooers.agents.server.maestro.outputs import RunTracker, output_for
from dooers.agents.server.protocol.models import Run, ThreadEvent
from tests.parity.harness import run_legacy
from tests.parity.model import (
    AGENT_ID,
    ASSISTANT_NAME,
    FORM_EVENT_REF,
    USER,
    WHATSAPP_CUSTOMER,
    WHATSAPP_INSTANCE,
    WHATSAPP_OUTBOUND_ID,
)
from tests.parity.scenarios import SCENARIOS

AGENT_PRINCIPAL = "55555555-5555-4555-8555-555555555555"
AGENT_PARTICIPANT = "66666666-6666-4666-8666-666666666666"
HUMAN_PARTICIPANT = "77777777-7777-4777-8777-777777777777"
EXECUTION_ID = "88888888-8888-4888-8888-888888888888"
AGENT_ACTOR = {
    "kind": "agent",
    "principal_id": AGENT_PRINCIPAL,
    "instance_agent_id": AGENT_ID,
    "participant_id": AGENT_PARTICIPANT,
    "display_name": "Agente",
}
HUMAN_ACTOR = {"kind": "human", "principal_id": USER.user_id, "participant_id": HUMAN_PARTICIPANT, "display_name": "Humano"}

SINGLE = (
    "text",
    "text_author",
    "image",
    "audio",
    "document",
    "contact",
    "template",
    "reasoning",
    "tool_call",
    "tool_result",
    "tool_transaction",
    "chart",
    "chart_bar_horizontal",
    "chart_stacked_bar",
    "chart_line",
    "chart_area",
    "chart_pie",
    "chart_donut",
    "chart_scatter",
    "form",
    "form_text_text",
    "form_text_password",
    "form_text_email",
    "form_text_number",
    "form_text_date",
    "form_textarea",
    "form_select",
    "form_radio",
    "form_checkbox",
    "form_file",
)
WHATSAPP = ("whatsapp_text", "whatsapp_image", "whatsapp_document", "whatsapp_audio", "whatsapp_contact", "whatsapp_template")


def wire_event(event: dict[str, Any]) -> dict[str, Any]:
    return ThreadEvent.model_validate(event).model_dump(mode="json", exclude_none=True, by_alias=True)


def wire_run(run: dict[str, Any]) -> dict[str, Any]:
    return Run.model_validate(run).model_dump(mode="json", exclude_none=True, by_alias=True)


class ProductionRuns(RunTracker):
    """``RunTracker`` that opens the run ids production used, in order."""

    def __init__(self, ids: Iterator[str]) -> None:
        super().__init__()
        self._ids = ids

    def open(self) -> str:
        self._current = next(self._ids)
        return self._current


async def record(name: str) -> tuple[Any, list[AgentEvent]]:
    """Runs the scenario on the production path and keeps every AgentEvent its handler yields."""
    scenario = SCENARIOS[name]
    sends: list[AgentEvent] = []

    async def handler(on, send, memory, analytics, settings):
        async for event in scenario.handler(on, send, memory, analytics, settings):
            sends.append(AgentEvent(event.send_type, copy.deepcopy(event.data)))
            yield event

    SCENARIOS[name] = dataclasses.replace(scenario, handler=handler)
    try:
        result = await run_legacy(name)
    finally:
        SCENARIOS[name] = scenario
    return result, sends


class Maestro:
    """Builds the Maestro events of one scenario, aligned with its production events."""

    def __init__(self, production: list[dict[str, Any]]) -> None:
        self.production = [wire_event(e) for e in production]
        self.users = [e for e in self.production if e["actor"] == "user"]
        self.others = iter(e for e in self.production if e["actor"] != "user")
        self.runs = ProductionRuns(iter(u["run_id"] for u in self.users))
        self.turn = -1
        self.sequence = 0
        self.ordinal = 0

    def envelope(self, event_id: str, actor: dict[str, Any], created_at: str, type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.sequence += 1
        root = self.users[max(self.turn, 0)]["id"]
        event = {
            "event_id": event_id,
            "thread_id": self.production[0]["thread_id"],
            "sequence": str(self.sequence),
            "schema_version": 1,
            "actor": actor,
            "created_at": created_at,
            "causation_event_id": None if actor is HUMAN_ACTOR else root,
            "root_event_id": event_id if actor is HUMAN_ACTOR else root,
            "type": type_,
            "payload": payload,
        }
        if actor is AGENT_ACTOR:
            self.ordinal += 1
            event["execution_id"] = EXECUTION_ID
            event["output_id"] = f"output:{self.ordinal}"
        return event

    def agent(self, send: AgentEvent, *, run_times: dict[str, str] | None = None) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Maestro event of one AgentEvent and the production event it stands for (``None`` for runs)."""
        if send.send_type == "run_start":
            self.turn += 1
        if send.send_type in ("image", "audio", "document"):
            output_type, payload = "message.create", media_link(send)
            if self.runs.current is not None:
                payload["run_id"] = self.runs.current
        else:
            output = output_for(send, self.ordinal, runs=self.runs)
            output_type, payload = output.type, output.payload
        event_type = {"message.update": "message.updated", "run.update": "run.updated"}.get(
            output_type, output_type.replace(".create", ".created")
        )
        if event_type == "run.updated":
            payload = {**payload, "agent_id": payload.get("agent_id", AGENT_ID), "trigger_event_id": self.users[self.turn]["id"]}
            when = (run_times or {}).get(payload["status"], self.users[self.turn]["created_at"])
            return self.envelope(str_uuid(self.sequence), AGENT_ACTOR, when, event_type, payload), None
        if event_type == "message.updated":
            target = next(e for e in self.production if e["id"] == payload["event_id"])
            return self.envelope(str_uuid(self.sequence), AGENT_ACTOR, target["created_at"], event_type, payload), target
        target = next(self.others)
        return self.envelope(target["id"], AGENT_ACTOR, target["created_at"], event_type, payload), target

    def human_message(self, user_event: dict[str, Any]) -> dict[str, Any]:
        payload = {"content": copy.deepcopy(user_event["content"]), "mentions": []}
        return self.envelope(user_event["id"], HUMAN_ACTOR, user_event["created_at"], "message.created", payload)

    def form_response(self, user_event: dict[str, Any], data: dict[str, Any], form_event_id: str) -> dict[str, Any]:
        payload = {
            "form_event_id": form_event_id if data["form_event_id"] == FORM_EVENT_REF else data["form_event_id"],
            "values": copy.deepcopy(data["values"]),
            "cancelled": data["cancelled"],
        }
        return self.envelope(user_event["id"], HUMAN_ACTOR, user_event["created_at"], "form.responded", payload)

    def delivery(self, target: dict[str, Any], status: str, provider_message_id: str, error: str | None = None) -> dict[str, Any]:
        payload = {"event_id": target["id"], "channel": "whatsapp", "status": status, "provider_message_id": provider_message_id}
        if error:
            payload["error"] = error
        return self.envelope(str_uuid(self.sequence), AGENT_ACTOR, target["created_at"], "channel_delivery.updated", payload)


def str_uuid(n: int) -> str:
    return f"99999999-9999-4999-8999-{n + 1:012d}"


def media_link(send: AgentEvent) -> dict[str, Any]:
    """Index 4.3: the part the SDK keeps when it cannot download the URL of send.image/audio/document."""
    data = send.data
    part = {"type": "media_link", "kind": send.send_type, "url": data["url"]}
    part.update({key: data[key] for key in ("mime_type", "filename", "alt", "duration") if data.get(key) is not None})
    payload: dict[str, Any] = {"content": [part], "mentions": []}
    if data.get("author") is not None:
        payload["author"] = data["author"]
    if data.get("whatsapp") is not None:
        payload["whatsapp"] = copy.deepcopy(data["whatsapp"])
    return payload


async def single_cases() -> list[dict[str, Any]]:
    cases = []
    for name in SINGLE:
        result, sends = await record(name)
        maestro = Maestro(result.events)
        for send in sends:
            event, production = maestro.agent(send)
            if production is not None:
                cases.append({"name": name, "maestro": event, "production": production})
    return cases


async def fold_cases() -> list[dict[str, Any]]:
    cases = []
    # Form response (human): the run that the response opened gives it its run_id.
    for name in ("form_response_submit", "form_response_cancel"):
        result, sends = await record(name)
        maestro = Maestro(result.events)
        events = [maestro.human_message(maestro.users[0])]
        form_id = ""
        for send in sends:
            if send.send_type == "run_start" and maestro.turn == 0:
                turn = SCENARIOS[name].incoming.turns[1]
                events.append(maestro.form_response(maestro.users[1], dict(turn.data or {}), form_id))
            event, production = maestro.agent(send)
            if production is not None and production["type"] == "form":
                form_id = production["id"]
            events.append(event)
        cases.append({"name": name, "maestro": events, "target": maestro.users[1]["id"], "production": maestro.users[1]})
    # update_user_event: the agent edits the person's message.
    result, sends = await record("update_user_event")
    maestro = Maestro(result.events)
    original = SCENARIOS["update_user_event"].incoming.turns[0].message  # production keeps only the edited text
    events = [maestro.human_message({**maestro.users[0], "content": [{"type": "text", "text": original}]})]
    events += [maestro.agent(send)[0] for send in sends]
    cases.append({"name": "update_user_event", "maestro": events, "target": maestro.users[0]["id"], "production": maestro.users[0]})
    # WhatsApp sends: the message carries the route; the tools-whatsapp answer gives the first status.
    for name in WHATSAPP:
        result, sends = await record(name)
        maestro = Maestro(result.events)
        events = []
        for send in sends:
            event, production = maestro.agent(send)
            events.append(event)
            if production is not None:
                target = production
                events.append(maestro.delivery(target, "accepted", WHATSAPP_OUTBOUND_ID))
        cases.append({"name": name, "maestro": events, "target": target["id"], "production": target})
    return cases


async def receipt_cases() -> dict[str, Any]:
    """whatsapp_receipt: delivered, read, a late delivered, an unknown wamid, then failed."""
    result, sends = await record("whatsapp_receipt")
    maestro = Maestro(result.events)
    events = []
    for send in sends:
        if send.send_type == "text":
            # send.text in a WhatsApp thread: production resolves the route from the thread channel
            # (the customer number and the instance of channel_meta); the SDK publishes it in `whatsapp`.
            send = AgentEvent(send.send_type, {**send.data, "whatsapp": {"to_e164": WHATSAPP_CUSTOMER, "instance_id": WHATSAPP_INSTANCE}})
        event, production = maestro.agent(send)
        events.append(event)
        if production is not None:
            target = production
            events.append(maestro.delivery(target, "accepted", WHATSAPP_OUTBOUND_ID))
    steps = []
    for step, receipt in enumerate(result.outputs["receipts"], start=1):
        if receipt["wa_message_id"] == WHATSAPP_OUTBOUND_ID:  # an unknown wamid never reaches Maestro
            # The webhook error text (production keeps it as error_message) is the only error field Maestro has.
            error = receipt["delivery"][0].get("error_message") if receipt["status"] == "failed" else None
            events.append(maestro.delivery(target, receipt["status"], receipt["wa_message_id"], error))
        steps.append(
            {
                "name": f"step {step}: {receipt['wa_message_id']} {receipt['status']}",
                # The first `events` Maestro events are the state after this receipt.
                "events": len(events),
                "production": receipt["delivery"][0],
            }
        )
    return {"name": "whatsapp_receipt", "maestro": events, "target": target["id"], "steps": steps}


async def run_cases() -> list[dict[str, Any]]:
    cases = []
    for name in ("run_failed", "run_other_agent"):
        result, sends = await record(name)
        maestro = Maestro(result.events)
        run = wire_run(result.outputs["runs"][0])
        times = {"running": run["started_at"], "succeeded": run["ended_at"], "failed": run["ended_at"]}
        events = [maestro.agent(send, run_times=times)[0] for send in sends]
        cases.append({"name": name, "maestro": [e for e in events if e["type"] == "run.updated"], "production": run})
    return cases


def source() -> dict[str, Any]:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout.strip()

    return {
        "generator": "scripts/maestro-legacy-parity-fixture.py",
        "server_repository": "dooers-agents-server",
        "server_commit": git("rev-parse", "HEAD"),
        "server_dirty": bool(git("status", "--porcelain", "--", "src", "tests/parity")),
        "production": "tests/parity/harness.py run_legacy (thread_management='agent'), wire = serialize_frame",
        "maestro": "dooers.agents.server.maestro.outputs.output_for (index 4.1); media_link and channel_delivery built here",
    }


async def main() -> None:
    fixture = {
        "source": source(),
        "agent": {"instance_agent_id": AGENT_ID, "name": ASSISTANT_NAME},
        "human": {"principal_id": USER.user_id, "name": USER.user_name},
        "cases": await single_cases(),
        "folds": await fold_cases(),
        "receipts": await receipt_cases(),
        "runs": await run_cases(),
    }
    json.dump(fixture, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    asyncio.run(main())
