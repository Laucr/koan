# Amendment r1: Configurable OpenAI-compatible base URL

**Feature:** koan-product
**Date:** 2026-08-02
**PRD version:** 1.0 → 1.1
**Class:** additive
**Source:** user-feedback
**Implementation:** `493034f` (`refactor: support base-url switch`)

## What changed

Every LLM-backed Koan mode must accept an OpenAI-compatible API base URL. The
one-shot runner, interactive chat, and HTTP server must resolve the same
flag/environment/file configuration and pass it to their provider adapter.

## PRD sections affected

- Configuration resolution — base URL becomes a first-class override.
- M1 — local and compatible endpoints are selectable for one-shot execution.
- M4 — interactive chat uses the selected endpoint.
- M8 — server mode gains provider, model, base URL, and timeout parity.

## Old behavior → new behavior

| Aspect | Before | After |
|---|---|---|
| `run` and `chat` | Accepted `--base-url`. | Continue to accept and pass it to the adapter. |
| `serve` | Only environment/file configuration could select the LLM endpoint. | Accepts `--base-url`, `--provider`, `--model`, and `--timeout`. |
| Persistent default | Endpoint selection was weakly documented. | `KOAN_BASE_URL` and config-file `baseURL` are documented with precedence. |

## Downstream impact

### Plan

- M1 configuration — needs explicit base-URL acceptance coverage.
- M8 server startup — needs CLI parity requirements and regression tests.

### Build report

- No build report exists; implementation landed retroactively in `493034f`.

### Bailiff verdict

- M1b and M8 expectations need re-verification against PRD v1.1 or newer.

## Why

User smoke testing against a local OpenAI-schema-compatible server on port 8000
showed that endpoint selection must work consistently across every runtime mode.

## Suggested next steps

- [ ] Re-emit plan against the amended PRD.
- [x] Rebuild affected phases (`493034f`).
- [ ] Re-run bailiff after plan alignment.
- [x] Cover serve flag mapping and configuration precedence with tests.
