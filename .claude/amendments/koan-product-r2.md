# Amendment r2: Strict tool-name and non-streaming endpoint compatibility

**Feature:** koan-product
**Date:** 2026-08-02
**PRD version:** 1.1 → 1.2
**Class:** additive
**Source:** user-feedback
**Implementation:** `112f485` (`fix: tool definitions with dots`)

## What changed

Koan keeps readable namespaced tool names internally while presenting valid
OpenAI function names on the wire. Interactive chat also supports a
non-streaming upstream mode for compatible servers without SSE support.

## PRD sections affected

- M2 — streaming is no longer mandatory for interactive chat.
- M3 — tool definitions gain an explicit provider-boundary naming contract.
- M4 — chat gains `--no-stream` without disabling tools or persistence.

## Old behavior → new behavior

| Aspect | Before | After |
|---|---|---|
| Tool definitions | Names such as `fs.read` were sent directly and rejected by strict APIs. | Invalid wire characters are translated and returned calls are restored before dispatch. |
| Tool history/forcing | Historical calls and `tool_choice` retained internal dotted names. | Definitions, history, and forced choices use the same reversible mapping. |
| Interactive upstream | `chat` always requested streaming. | `chat --no-stream` uses ordinary chat completions. |

## Downstream impact

### Plan

- M2 adapter work — needs a non-streaming compatibility path.
- M3 toolkit — needs wire-name translation contract tests.
- M4 REPL — needs a `--no-stream` option and output coverage.

### Build report

- No build report exists; implementation landed retroactively in `112f485`.

### Bailiff verdict

- M2b, M3, and M4 expectations need re-verification against PRD v1.2 or newer.

## Why

A strict OpenAI-compatible server rejected every chat prompt before inference
because Koan attached dotted tool names to every request. The supplied Python
mock also intentionally does not implement streaming.

## Suggested next steps

- [ ] Re-emit plan against the amended PRD.
- [x] Rebuild affected phases (`112f485`).
- [ ] Re-run bailiff after plan alignment.
- [x] Test reversible tool-name mapping and non-streaming chat configuration.
