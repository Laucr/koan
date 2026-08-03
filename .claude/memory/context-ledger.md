# Context Ledger

Last updated: 2026-08-02 by builder

## Blueprint

- **koan-product** (2026-07-29, 35fa942): PRD v1.3; configurable endpoint, schema-safe tool names, non-streaming chat, answer rendering, opt-in LLM I/O logs; plan and bailiff stale
- **portable-session-jsonl** (2026-08-02, working tree): PRD v1.1 / plan v1.0 aligned; canonical JSONL defaults on with persistence, SQLite remains authoritative, Codex/Claude are export profiles, session deletion removes both artifacts
- **Deferred**: foreign transcript import/resume and private Codex/Claude storage-schema emulation

## Builder

- **portable-session-jsonl** (2026-08-02, working tree): schema-v1 JSONL writer, SQLite-first turn batches, default-on CLI/HTTP persistence, Koan/Codex/Claude export, coordinated deletion
- **Diverged from plan**: supplied mock cannot emit tool calls, so smoke covered two-turn resume/export/delete and deterministic tests cover tool lifecycle; injected HTTP stores require explicit transcript enablement
- **Tech debt**: public compatibility projections need fixture refresh when upstream contracts change; full suite retains three unrelated existing failures documented in the build report

## Bailiff

- **scaffold** (2026-07-29, 0a49d11): PARTIAL — prior F1–F3 fixed; FORCE gate not one-shot (P12); M9 brew/OTel unmet; HTTP 429 ok, SSE/409/drain thin. Report: `scaffold-bailiff-r1.md`.
- **scaffold** (2026-06-24, c0ba932): PARTIAL — across-conv memory always-on; registries not frozen; text-tagged protocol missing (superseded).
