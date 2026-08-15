---
feature: interactive-permission-selector
artifact: bailiff
version: 1.0
prd_version: 1.0
plan_version: 1.0
last_aligned: 2026-08-15
status: current
---

# Bailiff Report: Interactive Permission Selector

**Spec:** `.claude/prds/interactive-permission-selector.md`
**Plan:** `.claude/plans/interactive-permission-selector.md`
**Issue:** [#1](https://github.com/Laucr/koan/issues/1), including the owner's arrow-select clarification
**Date:** 2026-08-15
**Verdict:** PASS

## Summary

The implementation satisfies the issue and aligned PRD/plan v1.0 at the selector, approval adapter, broker, core-agent, HTTP compatibility, and real-PTY boundaries. All 19 expectations pass; the only warnings are repository-level lint/test debt that predates and is unrelated to this feature.

## Static Checks

No bailiff static-check profile exists for TypeScript. `npm run build` passed strict TypeScript compilation; `npm run lint` exited successfully but is a placeholder (`echo 'add eslint later'`), recorded as W1.

## Expectation Results

| # | Expectation | Source (PRD §) | Status | Notes |
|---|---|---|---|---|
| 1 | Ordered generic options support stable values/labels, single or multiple mode, and validated initial selections; empty options and invalid initials fail before input | §6.1, §7.2, §8 | PASS | Public API and bailiff contract tests |
| 2 | Up/down navigation wraps; highlight remains separate from selection | §4, §6.1, §9 | PASS | Up wraps 0→2; multi navigation preserves selection |
| 3 | In no-default single mode, Enter is blocked with clear in-place feedback until the first arrow move, which selects its destination; later arrows replace the selection | §4, §6.1, §8, §9, §10 | PASS | Owner clarification enforced in state, stream, and PTY tests |
| 4 | A valid Enter resolves selected values; single mode can submit an initial default | §6.1, §9 | PASS | Focused selector suite |
| 5 | Multi mode moves highlight without selecting, Space toggles, supports multiple initial values, and returns selected values in option order | §4, §6.1, §6.4, §9 | PASS | Independent and feature tests |
| 6 | Single and multiple rendering are visibly distinct (radio vs checkbox), highlight is separate, and validation clears after a valid change | §6.2, §8, §9 | PASS | Render/state contracts and PTY output |
| 7 | Prompt/labels are one physical line, width-bounded and truncated with deterministic fallback width; redraw is in-place and bounded | §2, §6.2, §9 | PASS | 24-column and fallback-width contracts; ANSI cursor-up/erase observed |
| 8 | Selector cancellation, EOF, unusable streams, teardown, and write failures release/restore input state and fail closed; Ctrl-C follows turn interruption | §4, §6.2, §8 | PASS | Raw mode and broker ownership restore on failure; EOF/Ctrl-C tests pass |
| 9 | Shared broker grants an exclusive key-selection session, prevents competing input consumers/leaked selector keys, and returns ownership to line reads | §2, §6.2, §7.1, §7.2, Plan Phase 2 | PASS | Broker contracts plus real PTY handoff |
| 10 | TTY approval presents Allow once / Allow always / Deny in single/no-default mode and maps them to allow / always / deny | §6.3, §9 | PASS | Request-shape/mapping tests and PTY Deny flow |
| 11 | Deny prompts through the same broker for an optional one-line reason; input is trimmed and blank input omitted | §6.3, §7.1, §8, §9 | PASS | Structured and blank reason tests; PTY trimmed `unsafe path` |
| 12 | Legacy string and structured approval representations normalize compatibly; allow runs once, always retains per-tool caching, deny blocks execution | §2, §3, §6.3, §7.2, §9 | PASS | Core contract and focused approval-gate suite |
| 13 | A non-empty denial reason reaches model-visible `PermissionDenied` output and transcript path without new operational logging/storage | §3, §6.3, §7.4, §9 | PASS | Public agent history contains trimmed reason; source/diff scan finds no reason logger/store |
| 14 | Existing HTTP approval clients remain literal-string compatible and are not required to send reasons | §3, §6.3, §7.2, §9 | PASS | Five coordinator/HTTP tests pass; endpoint still validates literals |
| 15 | Generic selector contains no permission labels/types; permission mapping remains in the approval adapter | §6.4, Plan Phase 1/3 | PASS | Structural source scan |
| 16 | No production dependency/full-screen TUI, batch approval, mouse/search/filter/pagination, new reason store/log, mandatory reason, or changed timeout/tool order/auto-approve behavior is introduced | §3, §7.3, Plan Not Doing | PASS | Dependency/diff/source scan; blank reason accepted |
| 17 | Focused selector, broker/REPL, core approval, and HTTP contracts plus build/lint/full-suite checks pass, accounting explicitly for proven pre-existing failures | §9, Plan Phase 4 | PASS | Build passed; focused 16+4+5 and bailiff 11 passed; full suite 317 passed with only three documented baseline failures (W2) |
| 18 | PTY behavior works at normal and narrow widths, including invalid Enter, arrow selection, denial reason, raw-mode restoration, and handoff to the next prompt | §6.2, §8, §9, Plan Phase 4 | PASS | 80/24-column selector smoke and 24-column shared-broker approval PTY smoke passed |
| 19 | No performance-pitfall trigger from the catalogue applies; the feature introduces no hot-path datastore, RPC-rate, batch, retry, Spark, or background-worker design | PRD §7, Plan The Approach | PASS | All catalogue triggers out of scope; no production dependency added |

## Failures

None.

## Warnings

- **W1:** `npm run lint` is a placeholder that only prints `add eslint later`; TypeScript compilation and tests provide coverage, but no actual linter runs.
- **W2:** Full `npm run test:run` finishes with 317 passing and three unrelated, builder-documented baseline failures: path traversal error classification, FORCE one-shot behavior, and HTTP rate-limit smoke timeout. Focused issue #1 suites and all other tests pass.

## Test Files

- `tests/interactive-permission-selector-bailiff.test.ts` — 11 independent contract tests covering selector state/rendering, input failure cleanup, approval mapping/reasons, broker ownership/handoff, and core legacy/structured denial compatibility.
- Existing focused coverage: `tests/cli-select.test.ts`, `tests/m4-repl.test.ts`, `tests/m3-tools.test.ts`, and `tests/m8-server.test.ts`.
- Manual PTY smokes: standalone selector at 80 and 24 columns; shared-broker Deny/reason/next-line flow at 24 columns.

## Suggested Fixes

- No issue #1 implementation fix is required.
- Separately replace the placeholder lint script with a real TypeScript lint command and resolve the three pre-existing suite failures tracked by Builder.
