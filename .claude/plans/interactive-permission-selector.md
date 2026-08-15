---
feature: interactive-permission-selector
artifact: plan
version: 1.0
prd_version: 1.0
last_aligned: 2026-08-15
status: current
---

# Plan: Interactive Permission Selector

**PRD:** `.claude/prds/interactive-permission-selector.md`
**Issue:** [#1](https://github.com/Laucr/koan/issues/1)
**Date:** 2026-08-15
**Status:** Approved

## The Problem

Koan's approval prompt accepts whole-line `y/a/n` answers and cannot represent explicit no-default selection, reusable multiple choice, or a denial reason. The REPL recently fixed competing input consumers, so the replacement must add key-level interaction without giving approval and chat separate ownership of stdin.

## The Approach

Build a small CLI-local selector around a pure selection state machine and a terminal adapter, then route it through an extended single-owner input broker. Keep permission mapping outside the generic component. Expand approval results compatibly so legacy string approvers and HTTP clients continue working while TTY denial can carry a reason.

A new full-screen TUI library was rejected because this is a bounded prompt, the repository has no such dependency, and its independent input lifecycle would risk repeating the readline ownership bug. Replacing all REPL line editing was also rejected as unnecessary scope; the broker will expose an exclusive key-mode lease and restore line mode after selection.

## The Work

### Phase 1: Lock the Selector Contract

This phase implements PRD §6.1, §6.2, and §6.4 with deterministic logic before terminal integration.

* `src/cli/select.ts` — define generic options, single/multiple modes, initial selections, normalized selector results, and a pure transition function for up/down/space/enter/cancel.
* `src/cli/select.ts` — enforce the clarified no-default single-select rule: initial Enter is invalid; the first arrow move selects its destination.
* `src/cli/select.ts` — render radio versus checkbox indicators, a separate highlight, in-place validation feedback, width-aware truncation, and one-line sanitization.
* `tests/cli-select.test.ts` — contract-test navigation/wrapping, no-default blocking, default submission, single replacement, multi toggles, result ordering, rendering differences, truncation, and cancellation.

### Phase 2: Preserve Exclusive Input Ownership

This phase implements PRD §6.2 and protects the ledger's prior approval/readline fix.

* `src/cli/approve.ts` — extend `LineInputBroker` (or extract a narrowly scoped successor) so line reads and exclusive selector key sessions share one queue/owner and clean up in `finally`.
* `src/cli/repl.ts` — provide the approver with the broker's key-session and line-reading capabilities without creating a second readline interface.
* `src/cli/run.ts` and other TTY construction sites — provide the same selector-capable input seam where the one-shot CLI owns the terminal; keep non-TTY behavior fail-closed.
* `tests/m4-repl.test.ts` — prove arrow/space/enter events are consumed only by approval, selection/reason input does not become the next chat line, and EOF/Ctrl-C releases ownership safely.

### Phase 3: Integrate Permission Decisions and Reasons

This phase implements PRD §6.3 while retaining existing public behavior.

* `src/core/loop.ts` — split the decision literals from the compatible approval result shape, add one normalization point, retain existing string returns, and include a trimmed non-empty denial reason in `PermissionDenied` content.
* `src/cli/approve.ts` — replace `y/a/n` with single-select/no-default options for Allow once, Allow always, and Deny; after Deny, read one optional reason line from the same broker.
* `src/server/approval.ts` and `src/server/serve.ts` — keep existing string HTTP decisions valid and adjust types only where required by the normalized result; do not require clients to send a reason.
* `tests/m3-tools.test.ts` — cover structured denial reasons, blank reason omission, unchanged allow/always caching, and legacy string approvers.
* `tests/m4-repl.test.ts` — cover all three permission mappings plus denial with and without a reason.
* `tests/m8-server.test.ts` — retain the HTTP approval contract and verify no compatibility regression if shared types change.

### Phase 4: Validate the Complete Contract

This phase verifies PRD §9 and catches integration regressions.

* Run focused selector, REPL, core tool, and server approval tests.
* Run `npm run build` for exported type and strict TypeScript validation.
* Run `npm run lint` and `npm run test:run`.
* Exercise a PTY-backed permission prompt at a narrow and normal terminal width, including invalid Enter, navigation, denial reason, and return to the next REPL prompt.
* Confirm `git diff` contains only issue #1 code, tests, PRD/plan, build report, and verification artifacts allowed by repository conventions.

## Trade-offs

- ANSI in-place rendering is more code than a prompt dependency, but avoids a large dependency and preserves control over stdin ownership. Pure transition/render tests plus a PTY smoke test mitigate terminal-specific risk.
- Supporting both strings and structured approval results adds a normalization branch, but prevents a breaking API change for programmatic approvers and the HTTP coordinator.
- Denial reasons become visible to the model and persisted transcript when enabled. That is required for agent adaptation; avoiding operational-log duplication limits unnecessary exposure.
- Multi-select ships without a current production call site. Contract tests keep it usable until another CLI flow adopts it.

## Testing

- Pure state tests cover every key transition and no-default invariant without a TTY.
- Render tests compare stable symbols/content and width bounds without depending on terminal color support.
- Stream/broker tests prove exclusive input consumption and cleanup.
- Core tests prove reason propagation and backward compatibility.
- Existing server tests prove HTTP approval behavior is unchanged.
- A PTY smoke validates cursor rendering and REPL handoff that ordinary streams cannot faithfully simulate.

## Not Doing

- Batch approval of multiple pending tool calls; the generic component supports multi-select, but issue #1 names no batch workflow.
- Mouse controls, search/filtering, pagination, or full-screen layouts; they are outside the acceptance criteria.
- A dedicated denial-reason database column or operational audit event; existing tool results/transcripts already carry the result.
- Mandatory denial reasons; the issue explicitly makes them optional.
- Breaking the `ToolApprover` string decision contract or changing the HTTP request requirement.
