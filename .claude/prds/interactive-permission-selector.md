---
feature: interactive-permission-selector
artifact: prd
version: 1.0
last_aligned: 2026-08-15
status: current
---

# PRD: Interactive Permission Selector

**Version:** 1.0
**Date:** 2026-08-15
**Status:** Approved
**Source:** [GitHub issue #1](https://github.com/Laucr/koan/issues/1) and the owner's 2026-08-15 clarification

## §1. Overview

Replace Koan's `y/a/n` tool-approval prompt with a reusable, keyboard-driven terminal selector. The selector supports single- and multi-select modes, explicit no-default behavior, compact terminal rendering, and an optional denial reason that reaches permission handling.

## §2. Goals

- Let users navigate choices with ↑/↓ and submit with Enter.
- Support reusable single- and multi-select modes with visibly different indicators.
- Block submission and show actionable feedback when a required selection is absent.
- Prompt for an optional free-text reason after the user chooses Deny.
- Preserve the existing allow-once, allow-always, and deny semantics and keep call-site changes small.
- Keep all REPL and approval input under one owner so selector keystrokes cannot leak into the next chat prompt.
- Remain readable at typical terminal widths by bounding and truncating rendered content.

## §3. Non-Goals

- Adding a current permission workflow that selects multiple tool calls at once; multi-select is a reusable component capability for future call sites.
- Changing permission grants, `--auto-approve` modes, tool execution order, or server approval timeout behavior.
- Replacing Koan's full REPL line editor or adding mouse interaction.
- Persisting denial reasons in a new database field or emitting their free text to operational logs.
- Providing a full-screen terminal UI framework.

## §4. Constraints

- ↑/↓ move the highlight; Enter confirms the final selection.
- Multi-select uses Space to toggle items.
- Single- and multi-select modes use different indicator symbols or styles.
- With no preselected default, Enter is blocked until a valid selection exists and the UI explains why.
- Owner clarification: in no-default single-select mode, moving the highlight with ↑/↓ also selects the resulting option; Enter is blocked until that first movement.
- Selecting Deny offers an optional free-text reason, and the decision plus reason is returned to permission handling.
- Existing permission request call sites must adopt the component with minimal changes.
- Unavailable or interrupted input remains fail-closed.

## §5. User Stories / Use Cases

1. As a CLI user, I can inspect and choose Allow once, Allow always, or Deny without remembering letter shortcuts.
2. As a cautious user, I cannot accidentally submit an implicit choice when the prompt declares no default.
3. As a user denying a tool call, I can explain why so the agent can adapt its next action.
4. As a future CLI feature author, I can reuse the same component for a multi-item selection.

## §6. Functional Requirements

### §6.1 Selection State

- The component accepts ordered options with stable values and display labels, a `single` or `multiple` mode, and an optional initial selection.
- Highlight position and selected values are separate state.
- ↑/↓ wrap at the list boundaries.
- In single-select mode, moving the highlight replaces the selected value. If no default exists, the initial highlight is visual only and Enter reports that a choice is required until the user moves.
- In multi-select mode, ↑/↓ move only the highlight and Space toggles the highlighted value.
- Enter resolves only when at least one value is selected when selection is required.

### §6.2 Rendering and Input Ownership

- Single-select uses radio-style indicators; multi-select uses checkbox-style indicators. The highlighted row has a separate cursor/style treatment.
- Validation feedback is rendered in place after an invalid Enter and clears after a valid selection change.
- Labels and prompt text are sanitized to one physical line and truncated to the available output width with a deterministic fallback width when terminal columns are unavailable.
- Rendering updates the selector's own rows rather than appending an unbounded stream of copies.
- The selector uses Koan's shared REPL input ownership mechanism. It must not attach a competing, independently consuming readline interface while the REPL is active.
- EOF, cancellation, or an unusable interactive stream resolves safely as denial or propagates the established turn interruption; it never runs a tool by default.

### §6.3 Permission Integration

- `createTTYApprover` presents `Allow once`, `Allow always`, and `Deny` through the selector in single-select/no-default mode.
- Allow once maps to the existing `allow` behavior; Allow always maps to `always` and retains per-tool caching; Deny maps to `deny`.
- After Deny, the approver asks for a one-line optional reason. An empty line is a valid skip.
- Approval handling accepts legacy string decisions and a structured decision carrying an optional reason, so existing programmatic and HTTP call sites remain source-compatible.
- The core normalizes either representation. On denial it includes a non-empty reason in the model-visible `PermissionDenied` tool result; persisted sessions therefore record it through the existing tool-result/transcript path.
- Denial reason text is user-provided content: do not duplicate it into Pino operational logs or other new storage surfaces.

### §6.4 Reusable Multi-Select

- The same selector API supports multiple initially selected values, Space toggling, and returning all selected values in option order.
- The component has no permission-specific labels or decision types; permission mapping stays in `src/cli/approve.ts`.
- The initial issue integrates only the single-select permission prompt, but automated tests exercise multi-select behavior as a public reusable contract.

## §7. Technical Design

### §7.1 Data Flow

1. The core requests approval through `ToolApprover`.
2. `createTTYApprover` renders tool context and invokes the generic terminal selector.
3. A single input broker routes exclusive selector key events, then returns ownership to the REPL line reader.
4. Deny triggers an optional one-line reason prompt through the same broker.
5. The approver returns a string-compatible or structured approval result.
6. The core normalizes the result, runs/caches allowed tools, or returns a reason-aware `PermissionDenied` tool result.

### §7.2 Interfaces

- Add a CLI-local generic terminal selector module with option, mode, initial-selection, stream, and testable key-source inputs.
- Extend the shared input broker with an exclusive key-selection session instead of creating a second input consumer.
- Preserve `ToolApprovalDecision = 'allow' | 'deny' | 'always'` semantics and allow `ToolApproval` to carry `{ decision, reason? }` in addition to legacy strings.
- Keep `ToolApprover` call signatures and existing string-returning implementations valid.

### §7.3 Dependencies

- Use Node.js terminal/readline primitives and ANSI control sequences already available at runtime.
- Add no production dependency or full-screen TUI framework.

### §7.4 Reuse and Existing Patterns

- Extend `LineInputBroker`'s single-consumer discipline introduced by `fix: isolate approval input`; do not regress to competing readline consumers.
- Reuse `previewArgs` and the existing `createTTYApprover` seam.
- Normalize approval results once in `src/core/loop.ts`, preserving `alwaysAllow` behavior.
- Reuse model-visible tool results and transcript materialization rather than adding a parallel denial audit store.
- Follow Vitest stream fakes in `tests/m4-repl.test.ts` and approval gate tests in `tests/m3-tools.test.ts`.

## §8. Error Handling

- Invalid Enter leaves the selector active and displays `Select at least one option` (or equivalent clear feedback).
- Empty option sets and invalid initial selections fail before interactive input begins.
- EOF and terminal teardown deny safely; Ctrl-C follows the established active-turn interruption path.
- Rendering must restore input mode and release broker ownership in `finally`, including failures during output writes.
- A denial reason is trimmed; blank text is omitted rather than returned as an empty reason.

## §9. Acceptance Criteria

- [ ] ↑/↓ correctly move the highlight and wrap predictably.
- [ ] Enter submits the currently selected option or options.
- [ ] With no default, Enter is blocked and clear selection-required feedback is shown.
- [ ] In no-default single-select mode, the first ↑/↓ move selects the resulting highlighted option, per the owner's clarification.
- [ ] Multi-select uses Space to toggle and is visually distinct from single-select.
- [ ] Selecting Deny offers an optional free-text reason.
- [ ] The decision and optional reason reach permission handling; a non-empty denial reason appears in the model-visible denied tool result.
- [ ] Typical terminal widths remain readable through bounded single-line rendering and truncation.
- [ ] Existing string-returning approvers and HTTP approval clients continue to work.
- [ ] Selector input does not leak into the next REPL input line.
- [ ] Existing build and test suites pass, with focused selector, approver, and core permission tests added.

## §10. Confirmed Decisions

- No-default single-select requires an arrow movement before Enter; that movement both moves and selects.
- Multi-select is delivered as reusable component behavior, not as a new batch-permission workflow.
- Denial reasons flow through the approval result into the existing model-visible tool result/transcript path.
- Backward compatibility is maintained for string-based `ToolApprover` implementations and HTTP clients.
- No new production dependency is required.

## §11. Open Questions

- None.
