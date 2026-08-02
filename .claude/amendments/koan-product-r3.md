# Amendment r3: Observable LLM I/O and reliable chat answer rendering

**Feature:** koan-product
**Date:** 2026-08-02
**PRD version:** 1.2 → 1.3
**Class:** additive
**Source:** user-feedback
**Implementation:** `59e5ef0` (`fix: render chat answers and log LLM I/O`)

## What changed

Koan must expose opt-in, correlated logs for the complete request/response path
to the LLM server. Interactive chat must print the final answer whether it came
from ordinary assistant text or the `submit_final_answer` terminator tool.

## PRD sections affected

- M2 — streaming completion and assembled-response observability.
- M4 — final-answer rendering is part of the REPL contract.
- M9 — debug/trace logging covers the LLM boundary and documents sensitivity.

## Old behavior → new behavior

| Aspect | Before | After |
|---|---|---|
| LLM diagnostics | No complete adapter-level request/response log. | Debug logs full requests and assembled responses; trace logs stream chunks. |
| Correlation | LLM traffic lacked request-level correlation and duration. | Logs include request id, model, base URL, streaming mode, and duration. |
| Terminator answers | Chat could show a tool marker but omit the submitted final answer. | Final answers not already present in streamed text are printed exactly once. |
| Secrets/privacy | No LLM-payload logging policy. | Authorization is excluded and docs warn that payload content can be sensitive. |

## Downstream impact

### Plan

- M4 acceptance — must explicitly verify terminator answers are visible.
- M9 logging — needs LLM boundary payload, correlation, and sensitivity rules.

### Build report

- No build report exists; implementation landed retroactively in `59e5ef0`.

### Bailiff verdict

- M4b and M9a need re-verification against PRD v1.3.

## Why

During chat smoke testing, users could not see answers completed through the
terminator tool and could not inspect what Koan exchanged with the LLM server.

## Suggested next steps

- [ ] Re-emit plan against the amended PRD.
- [x] Rebuild affected phases (`59e5ef0`).
- [ ] Re-run bailiff after plan alignment.
- [x] Verify full request/response logs and answer rendering end to end.
