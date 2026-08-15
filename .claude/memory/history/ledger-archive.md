## Entry: bailiff @ 2026-06-24T11:36:00+08:00

- **scaffold** (2026-06-17, working tree): PASS — 51/51 contract tests written from philosophy docs all green; H8 (text-tagged tool-call protocol) flagged as extension point; recovery channel, monotonic slice, 5-layer FORBID, off-by-default memory, name-agnostic security boundary all verified.


## Entry: bailiff @ 2026-07-29T20:00:00+08:00

- **scaffold** (2026-06-24, c0ba932): PARTIAL — core loop/history/termination/middleware/memory boundary mostly conform; failures: across-conversation memory ignores off-by-default config, registries are not init-frozen in real runtime entrypoints, and the documented text-tagged protocol mode is missing.


## Entry: blueprint @ 2026-08-02T23:31:27+08:00

- **koan-product** amended to v1.3: configurable OpenAI-compatible endpoints, schema-safe tool names, non-streaming chat, complete answer rendering, and opt-in LLM I/O logs (r1–r3, stale: plan and bailiff)

## Entry: blueprint @ 2026-08-15T23:29+08:00

- **koan-product** (2026-07-29, 35fa942): PRD v1.3; configurable endpoint, schema-safe tool names, non-streaming chat, answer rendering, opt-in LLM I/O logs; plan and bailiff stale
- **portable-session-jsonl** (2026-08-02, working tree): PRD v1.1 / plan v1.0 aligned; canonical JSONL defaults on with persistence, SQLite remains authoritative, Codex/Claude are export profiles, session deletion removes both artifacts
- **Deferred**: foreign transcript import/resume and private Codex/Claude storage-schema emulation

## Entry: builder @ 2026-08-15T23:40+08:00

- **portable-session-jsonl** (2026-08-02, working tree): schema-v1 JSONL writer, SQLite-first turn batches, default-on CLI/HTTP persistence, Koan/Codex/Claude export, coordinated deletion
- **Diverged from plan**: supplied mock cannot emit tool calls, so smoke covered two-turn resume/export/delete and deterministic tests cover tool lifecycle; injected HTTP stores require explicit transcript enablement
- **Tech debt**: public compatibility projections need fixture refresh when upstream contracts change; full suite retains three unrelated existing failures documented in the build report

## Entry: bailiff @ 2026-08-15T23:49+08:00

- **scaffold** (2026-07-29, 0a49d11): PARTIAL — prior F1–F3 fixed; FORCE gate not one-shot (P12); M9 brew/OTel unmet; HTTP 429 ok, SSE/409/drain thin. Report: `scaffold-bailiff-r1.md`.
- **scaffold** (2026-06-24, c0ba932): PARTIAL — across-conv memory always-on; registries not frozen; text-tagged protocol missing (superseded).
