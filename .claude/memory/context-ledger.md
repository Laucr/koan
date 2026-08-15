# Context Ledger

Last updated: 2026-08-15 by bailiff

## Blueprint

- **interactive-permission-selector** (2026-08-15, working tree): PRD/plan v1.0 aligned to issue #1; reusable single/multi terminal selector, clarified no-default arrow selection, compatible structured denial reasons, single-owner input
- **Deferred**: batch permission workflows; mouse controls and full-screen TUI

## Builder

- **interactive-permission-selector** (2026-08-15, working tree): generic pure selector plus ANSI adapter, exclusive broker key lease, compatible structured denials, literal HTTP decisions preserved
- **Diverged from plan**: none; `src/cli/run.ts` inherited the standalone selector without a direct edit, and README was refreshed
- **Tech debt**: full suite retains the same three unrelated failures documented in the build report

## Inquest

- **koan-product** (2026-08-08, working tree): smoke — code-bug: approval and REPL attached competing readline consumers → shared line broker fixed input ownership; verify in interactive chat

## Bailiff

- **interactive-permission-selector** (2026-08-15, working tree): PASS — 19/19 expectations and 11 independent contracts pass; real 24-column denial/reason/REPL handoff passes; warnings: placeholder lint and three unrelated baseline failures. Report: `interactive-permission-selector-bailiff-r1.md`.
- **scaffold** (2026-07-29, 0a49d11): PARTIAL — prior F1–F3 fixed; FORCE gate not one-shot (P12); M9 brew/OTel unmet; HTTP 429 ok, SSE/409/drain thin. Report: `scaffold-bailiff-r1.md`.
- **scaffold** (2026-06-24, c0ba932): PARTIAL — across-conv memory always-on; registries not frozen; text-tagged protocol missing (superseded).
