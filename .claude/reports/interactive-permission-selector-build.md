---
feature: interactive-permission-selector
artifact: build
version: 1.0
prd_version: 1.0
plan_version: 1.0
last_aligned: 2026-08-15
status: current
---

# Build Report: Interactive Permission Selector

**Spec:** `.claude/prds/interactive-permission-selector.md`
**Plan:** `.claude/plans/interactive-permission-selector.md`
**Issue:** [#1](https://github.com/Laucr/koan/issues/1)
**Date:** 2026-08-15

## Summary

This build replaces Koan's `y/a/n` permission prompt with a reusable single/multi terminal selector and carries optional denial reasons through the existing permission result path.

## Motivation

The spec called for discoverable arrow-key navigation, explicit no-default behavior, reusable checkbox selection, and more expressive denials. This matters because permission prompts are a security boundary: interaction must be clear, fail closed, and never leak input into the next REPL command.

## Behavior

After this build:

- A TTY permission request displays Allow once, Allow always, and Deny as radio-style choices.
- With no default, Enter shows selection-required feedback; the first ↑/↓ move selects its destination exactly as clarified by the issue owner.
- Generic multi-select uses checkbox indicators and Space toggling and returns values in option order.
- Deny prompts for an optional one-line reason. Non-empty text is trimmed and included in the model-visible `PermissionDenied` result; blank text is omitted.
- Legacy string-returning approvers and HTTP `{ decision }` clients retain their existing contract.
- REPL selector mode suspends other keypress listeners, buffers rapid keys, ignores selector line events, restores listeners in `finally`, and returns cleanly to line input.
- EOF/cancellation is fail-closed, while Ctrl-C is forwarded to the established SIGINT path.
- Prompt and option rows are single-line, width-bounded, truncated with an ellipsis, and redrawn in place.

## Deviations from Plan

- None. `src/cli/run.ts` needed no direct edit because its existing `createTTYApprover({ output })` call automatically uses the new standalone TTY selector path.
- `README.md` was updated in addition to the listed source/test files so published permission instructions no longer describe `y/n/a`.

## Non-goals

This build does not:

- Batch multiple pending permission requests; multi-select is reusable component capability only.
- Add mouse input, filtering, pagination, or a full-screen TUI.
- Add a denial-reason database column or operational log record.
- Require HTTP clients to send a denial reason.

## Tradeoffs

- ANSI rendering and listener leasing are more code than a prompt dependency, but avoid a new runtime package and keep stdin ownership explicit.
- Approval results now accept both literals and a structured object. One normalization branch buys backward compatibility for existing callers.
- Denial reasons are visible to the model and persisted transcript when enabled. They are intentionally not duplicated to operational logs.
- The repository-wide suite retains three unrelated baseline failures; feature-focused suites and all other tests pass.

## Implementation Notes

- `src/cli/select.ts` separates pure state transitions and rendering from key acquisition, making all selection semantics deterministic without a real terminal.
- The broker temporarily suspends existing readline keypress listeners using public EventEmitter listener APIs, then restores them after the selector releases ownership.
- The HTTP coordinator stays restricted to literal decisions even though the in-process approver type can now return a structured denial.
- The selector reserves a validation row so in-place redraw height remains stable before and after an invalid Enter.

## Files Changed

- `README.md` — documents the new arrow-key permission flow.
- `src/cli/select.ts` — reusable selector state, rendering, TTY key input, and width handling.
- `src/cli/approve.ts` — selector-backed approvals, exclusive broker key sessions, and optional denial reasons.
- `src/cli/repl.ts` — supplies shared key and line ownership to the approver.
- `src/core/loop.ts` — compatible structured approval results and reason-aware denied tool output.
- `src/server/approval.ts` — keeps coordinator decisions literal and compatible.
- `src/server/serve.ts` — keeps HTTP request validation on literal decisions.
- `tests/cli-select.test.ts` — selector state, rendering, raw-mode, and multi-select contracts.
- `tests/m4-repl.test.ts` — mapping, reason, isolation, rapid-key, and Ctrl-C ownership tests.
- `tests/m3-tools.test.ts` — structured denial reason normalization and propagation tests.
- `.claude/prds/interactive-permission-selector.md` — approved issue requirements.
- `.claude/plans/interactive-permission-selector.md` — completed implementation plan.
- `.claude/memory/context-ledger.md` and history archive — Blueprint/Builder workflow context.

## Tests

Passed:

- `npm run build`
- `npm run lint`
- `npm run test:run -- tests/cli-select.test.ts tests/m4-repl.test.ts -t 'terminal selector|REPL approval input isolation'` — 16 passed
- `npm run test:run -- tests/m3-tools.test.ts -t 'loop: approval gate'` — 4 passed
- `npm run test:run -- tests/m8-server.test.ts -t 'ApprovalCoordinator|POST /sessions/:id/approvals/:apid'` — 5 passed
- PTY smoke at normal width — Down + Enter returned the second selection and restored terminal mode.
- PTY smoke at 24 columns — invalid Enter displayed truncated required feedback; Down + Enter returned the second selection.
- Full `npm run test:run` — 306 passed, 3 unrelated baseline failures.

Existing baseline failures:

- `tests/m3-tools.test.ts`: traversal path reaches `ENOENT` instead of `PathOutsideAllowlistError`.
- `tests/bailiff-r1.test.ts`: FORCE search gate remains pinned after round zero.
- `tests/bailiff-r1.test.ts`: rate-limit smoke times out while an LLM request waits for abort.

## Open Items

- None for issue #1. The three baseline test failures remain separate repository debt recorded before this build.

## Next Steps

- Run independent Bailiff contract verification against issue #1, the PRD, plan, report, and implementation.
