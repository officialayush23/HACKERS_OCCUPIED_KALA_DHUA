"""Which model, and how to talk to it. One shape, three vendors.

`llm.py` is still the only place a model is *called*; this is the only place
that knows what a vendor's HTTP looks like. The split exists because swapping
providers was going to happen — Gemini for local testing, xAI in production —
and doing that inside the call site would have meant vendor branches threaded
through interpretation, narration and health at once.

Every driver exposes the same two things:

    build(...)  -> (url, headers, body)
    extract(json) -> str | None

so `llm._call` stays vendor-agnostic and the fallback-through-model-names logic
is written once.

Selection
--------
`LLM_PROVIDER` = auto | gemini | xai | bedrock. `auto` (the default) picks the
first provider that actually has a key, preferring the production one — so a
machine with only `GEMINI_API_KEY` runs on Gemini and a deploy with only the
production key runs on that, with no config change between them. That is the
whole point: local testing and production differ by which secret is present,
not by which code path runs.

Production is Bedrock
---------------------
`AWS_API_KEY_BEDROCK` / `AWS_BEARER_TOKEN_BEDROCK` holds an AWS Bedrock
long-term API key — the `ABSK…` bearer-token form, not SigV4 credentials and not
an xAI key. It is read only by the Bedrock driver. Sending that token to
`api.x.ai` would fail with a 401 that looks like a bad key rather than a
misrouted one, which is exactly the kind of confusion this file exists to
prevent: one credential, one driver, no guessing.

xAI stays wired and selectable (`XAI_API_KEY`, or `LLM_PROVIDER=xai`) so
swapping to it later is a secret, not a rewrite.

Nothing here decides anything. Every driver returns text; the solver decides.
"""
from __future__ import annotations

import os
from typing import Any


def _env(*names: str) -> str:
    """First of these that is set and non-empty."""
    for n in names:
        v = (os.getenv(n) or "").strip()
        if v:
            return v
    return ""


# ------------------------------------------------------------------ keys ----

GEMINI_API_KEY = _env("GEMINI_API_KEY", "GOOGLE_API_KEY")
XAI_API_KEY = _env("XAI_API_KEY", "GROK_API_KEY")
# Production. Both names are in circulation: AWS documents
# AWS_BEARER_TOKEN_BEDROCK, and the credential file ships it as
# AWS_API_KEY_BEDROCK. Accept either rather than making anyone rename a secret.
BEDROCK_API_KEY = _env("AWS_BEARER_TOKEN_BEDROCK", "AWS_API_KEY_BEDROCK")
BEDROCK_REGION = _env("AWS_REGION", "AWS_DEFAULT_REGION") or "us-east-1"

# Model names move. Each list is "what was configured, then known-good ones" —
# a name that stops existing costs a retry, not the feature.
GEMINI_MODELS = [
    _env("GEMINI_MODEL"), "gemini-2.0-flash", "gemini-1.5-flash",
    "gemini-1.5-flash-latest", "gemini-1.5-pro",
]
XAI_MODELS = [
    _env("XAI_MODEL"), "grok-4-fast-non-reasoning", "grok-3-mini", "grok-2-latest",
]
# Bedrock is fussy here in a way the others are not: the newer Claude models are
# only reachable through a cross-region *inference profile* (`us.` prefix) and
# return a 400 telling you so if you use the bare model id, while the older ones
# only exist under the bare id. Listing both forms means the first call finds
# whichever this account actually has, instead of a 400 that reads like a broken
# key.
BEDROCK_MODELS = [
    _env("BEDROCK_MODEL"),
    "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "anthropic.claude-3-haiku-20240307-v1:0",
]


# --------------------------------------------------------------- drivers ----


class Gemini:
    name = "gemini"
    key = GEMINI_API_KEY
    models = GEMINI_MODELS

    @staticmethod
    def build(model, *, prompt, system, json_mode, max_tokens):
        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_tokens},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        return (
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            {"x-goog-api-key": Gemini.key, "Content-Type": "application/json"},
            body,
        )

    @staticmethod
    def extract(data):
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts).strip() or None


class XAI:
    """OpenAI-compatible chat completions."""
    name = "xai"
    key = XAI_API_KEY
    models = XAI_MODELS

    @staticmethod
    def build(model, *, prompt, system, json_mode, max_tokens):
        messages = ([{"role": "system", "content": system}] if system else []) + \
                   [{"role": "user", "content": prompt}]
        body: dict[str, Any] = {
            "model": model, "messages": messages,
            "temperature": 0.2, "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        return (
            _env("XAI_BASE_URL") or "https://api.x.ai/v1/chat/completions",
            {"Authorization": f"Bearer {XAI.key}", "Content-Type": "application/json"},
            body,
        )

    @staticmethod
    def extract(data):
        choices = data.get("choices") or []
        if not choices:
            return None
        return (choices[0].get("message", {}).get("content") or "").strip() or None


class Bedrock:
    """Bedrock runtime with an API-key bearer token (not SigV4)."""
    name = "bedrock"
    key = BEDROCK_API_KEY
    models = BEDROCK_MODELS

    @staticmethod
    def build(model, *, prompt, system, json_mode, max_tokens):
        body: dict[str, Any] = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "temperature": 0.2,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            body["system"] = system
        return (
            f"https://bedrock-runtime.{BEDROCK_REGION}.amazonaws.com/model/{model}/invoke",
            {"Authorization": f"Bearer {Bedrock.key}", "Content-Type": "application/json",
             "Accept": "application/json"},
            body,
        )

    @staticmethod
    def extract(data):
        blocks = data.get("content") or []
        return "".join(b.get("text", "") for b in blocks
                       if b.get("type") == "text").strip() or None


ALL = {d.name: d for d in (Gemini, XAI, Bedrock)}


def resolve():
    """The driver to use, or None with a reason a person can act on."""
    want = (_env("LLM_PROVIDER") or "auto").lower()

    if want in ALL:
        d = ALL[want]
        if not d.key:
            return None, (f"LLM_PROVIDER={want} but no key for it. "
                          f"{_keyhint(want)}")
        return d, None

    if want != "auto":
        return None, f"LLM_PROVIDER={want!r} is not one of: auto, {', '.join(ALL)}"

    # Production first, so a machine carrying both keys uses the one it is meant
    # to. A laptop with only GEMINI_API_KEY falls through to Gemini, which is
    # what local testing wants.
    for d in (Bedrock, XAI, Gemini):
        if d.key:
            return d, None

    return None, ("No model key is set. Provide GEMINI_API_KEY for local testing, "
                  "or AWS_BEARER_TOKEN_BEDROCK / AWS_API_KEY_BEDROCK for production.")


def _keyhint(name: str) -> str:
    return {
        "gemini": "Set GEMINI_API_KEY.",
        "xai": "Set XAI_API_KEY.",
        "bedrock": "Set AWS_BEARER_TOKEN_BEDROCK or AWS_API_KEY_BEDROCK "
                   "(and AWS_REGION if not us-east-1).",
    }.get(name, "")


def inventory() -> list[dict]:
    """What is configured, for the diagnose endpoint. Never returns a key."""
    return [{
        "provider": d.name,
        "key_present": bool(d.key),
        "key_source": _source_of(d.name),
        "models": [m for m in d.models if m],
    } for d in ALL.values()]


def _source_of(name: str) -> str | None:
    pairs = {
        "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        "xai": ("XAI_API_KEY", "GROK_API_KEY"),
        "bedrock": ("AWS_BEARER_TOKEN_BEDROCK", "AWS_API_KEY_BEDROCK"),
    }[name]
    for v in pairs:
        if (os.getenv(v) or "").strip():
            return v
    return None
