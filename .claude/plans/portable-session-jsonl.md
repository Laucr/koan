---
feature: portable-session-jsonl
artifact: plan
version: 1.0
prd_version: 1.1
last_aligned: 2026-08-02
status: current
---

# Plan: Portable Session JSONL

**PRD:** `.claude/prds/portable-session-jsonl.md`
**Date:** 2026-08-02
**Status:** Final

## The Problem

Koan's Pino diagnostics exist only on stderr, while reusable conversation context exists only in SQLite or a human-oriented session view. Parser authors cannot consume an append-only Koan transcript or project a session into the documented Codex and Claude Code event streams.

## The Approach

Add a provider-neutral transcript subsystem alongside persistence. New persistent sessions open a canonical Koan JSONL writer by default; each turn collects timestamped lifecycle events in memory, SQLite commits the completed turn first, and then the writer appends one encoded batch. This preserves SQLite as the resume authority while keeping tool timing and event order that cannot be reconstructed later.

Offline exporters read `SessionRecord` from SQLite and project it into Koan, Codex, or Claude records. Live files remain lossless Koan JSONL; generating compatibility projections only on demand avoids three copies of sensitive session data and prevents a lowest-common-denominator schema. We reject direct use of Codex/Claude private rollout files because those formats are undocumented and parser compatibility would be brittle.

## The Work

### Phase 1: Pin Contracts and Introduce the Event Model

This phase implements §2, §4, §6.2, and §6.3 before filesystem or CLI behavior depends on them.

- `tests/fixtures/transcripts/codex/` — add version-noted JSONL fixtures covering the documented `thread.started`, turn, agent-message, usage, error, command, and MCP-tool shapes; record the Codex CLI/docs baseline in a fixture README.
- `tests/fixtures/transcripts/claude/` — add version-noted `stream-json` fixtures covering system `init`, user/assistant content blocks, `tool_use`, `tool_result`, success/error `result`, and usage; record the Claude Code/docs baseline.
- `src/transcript/types.ts` — define the schema-v1 `KoanTranscriptEvent` discriminated union, sequence/turn identifiers, payloads, and a `TranscriptSink` interface. Keep these types independent of provider adapters and filesystem I/O.
- `src/core/events.ts` — define a small `AgentLifecycleEvent` union for complete assistant messages and tool start/completion/failure, including call id, original Koan tool name, arguments, result, timestamp, and duration.
- `src/core/loop.ts` — add an optional lifecycle subscriber at the actual assistant/tool execution boundaries. Do not overload `LLMStreamEvent`, which represents provider transport streaming rather than agent activity.
- `tests/core.test.ts` — prove lifecycle ordering, correlation ids, validated arguments, tool failures, and duration fields for streaming and non-streaming clients without changing existing loop results.

### Phase 2: Build Canonical Serialization, Paths, and Durable Append

This phase implements §6.1, §6.2, §6.4, and §6.6.

- `src/transcript/redact.ts` — recursively redact case-insensitive secret-bearing keys and authorization values before any transcript serializer sees them; preserve payload shape with an explicit replacement marker.
- `src/transcript/koan.ts` — map session/turn/lifecycle inputs into schema-v1 canonical records and encode exactly one compact JSON object per line.
- `src/transcript/path.ts` — resolve the XDG/default transcript root and the `YYYY/MM/DD/<session-id>.jsonl` path from `SessionRecord.createdAt`; reject unsafe ids/path escape and expose path lookup for delete/where operations.
- `src/transcript/writer.ts` — create directories as `0700`, files as `0600`, inspect the trailing record on open, recover only an incomplete final line, restore the last sequence, and append a fully encoded event batch with one append operation.
- `src/transcript/index.ts` and `src/index.ts` — expose stable transcript types/path helpers needed by CLI, server, and library consumers without exporting writer internals unnecessarily.
- `src/cli/config.ts` — add strict `transcripts.enabled`/`directory` file configuration, `KOAN_TRANSCRIPTS_ENABLED`/`KOAN_TRANSCRIPTS_DIR`, CLI overrides, and a transcript-only resolver that does not require an API key for `sessions` commands. Default enablement is `true` when persistence is active.
- `tests/transcript.test.ts` — cover JSONL validity, monotonic sequences, redaction, POSIX modes, path derivation, append/resume, incomplete-tail recovery, unsafe ids, and injected filesystem failures.
- `tests/cli.test.ts` — cover file/environment/flag precedence and strict boolean validation, including `--no-persist` taking precedence over transcript enablement.

### Phase 3: Attach Live Transcripts to Every Persistent Runtime

This phase implements §2, §5, §6.1, §6.5, and §6.6.

- `src/persistence/runner.ts` — accept an optional transcript sink, assign a turn id, buffer `turn.started`, the new user message, lifecycle events, and the terminal turn event, then append the batch only after `appendMessages` and `recordUsage` succeed. Convert append failures into explicit result warnings while retaining the successful SQLite turn.
- `src/cli/run.ts` — parse transcript flags, validate/create the transcript root before session creation, open the session writer once the created record supplies its id/timestamp, emit `session.started`, pass the sink into `runTurn`, surface the effective transcript path with the session id, emit `session.closed` when available, and create no writer under `--no-persist` or `--no-transcripts`.
- `src/cli/main.ts` — add chat help/flag plumbing and open the correct existing-session transcript on `--continue`/`--resume`; new sessions emit one `session.started` record while resumed sessions continue the stored sequence.
- `src/cli/repl.ts` — accept the injected sink and let `runStoredTurn` own transcript event generation; keep ephemeral/test REPLs unchanged when no sink is supplied.
- `src/cli/serve-subcommand.ts` and `src/server/serve.ts` — resolve the same transcript settings, initialize one writer per persisted HTTP session, pass it through `runTurn`, and report transcript failures through existing server logging/error channels without leaking content.
- `tests/m6-persistence.test.ts` and `tests/m4-repl.test.ts` — verify run/chat creation, multi-turn append, resume sequence continuity, default enablement, explicit disablement, and the complete absence of DB/transcript artifacts under `--no-persist`.
- `tests/m8-server.test.ts` — verify server-created and resumed sessions use the same canonical transcript contract and isolate concurrent session writers.

### Phase 4: Add Offline Compatibility Export and Coordinated Delete

This phase implements §6.3, §6.4, §6.5, and the export/delete acceptance criteria in §7.

- `src/transcript/from-session.ts` — deterministically reconstruct canonical turn/message/tool events from a `SessionRecord` for older sessions and offline export; document unavailable historical timestamps/durations instead of inventing precision.
- `src/transcript/codex.ts` — emit the public `codex exec --json` projection, using `command_execution` for `shell.exec`, the closest documented specialized item where exact, and `mcp_tool_call` with `server: "koan"` for arbitrary Koan tools. Preserve call ids, status, arguments, results, errors, ordering, and available usage.
- `src/transcript/claude.ts` — emit the public Claude Code `stream-json` projection with init/user/assistant/tool/result records and terminal result metadata.
- `src/transcript/export.ts` — stream encoded records to stdout or write a sibling temporary file followed by atomic rename; clean up only the known temporary target on failure.
- `src/cli/sessions-subcommand.ts` — implement `where --transcripts`, `export <id> --format koan|codex|claude [--output]`, and coordinated deletion. Resolve the record/path before deletion, rename an existing transcript to a same-directory tombstone, delete SQLite state, then unlink the tombstone; restore the name if the DB deletion fails and report any cleanup failure.
- `tests/transcript-compat.test.ts` — compare serializers to the pinned public fixtures and parse each output line independently; assert arbitrary-tool fallback, result correlation, ordering, errors, and usage.
- `tests/m6-persistence.test.ts` — cover export of pre-feature SQLite sessions, stdout/file output, atomic failure behavior, transcript-aware `where`, deletion of both artifacts, missing transcript, and rollback of the tombstone when DB deletion fails.

### Phase 5: Document and Verify the Whole Feature

This phase closes §1, §4, and every criterion in §7.

- `README.md` — distinguish operational stderr logs from SQLite state and JSONL transcripts; document default paths, security implications, configuration precedence, disable flags, export examples, deletion behavior, and public compatibility scope.
- CLI help in `src/cli/main.ts`, `src/cli/run.ts`, `src/cli/sessions-subcommand.ts`, and `src/cli/serve-subcommand.ts` — make transcript defaults and location discovery visible without requiring source inspection.
- Run format/type checks, the full unit/integration suite, and focused malformed-tail, permissions, redaction, export fixture, resume, concurrent server, and destructive-delete tests.
- Perform one manual smoke session against the existing OpenAI-compatible mock server: chat for two turns with a tool call, inspect canonical JSONL, export both compatibility profiles, resume once, and delete the session while confirming both artifacts are gone.

## Trade-offs

- Transcript content duplicates SQLite and increases sensitive data at rest. Default-on behavior meets the confirmed expectation; `--no-transcripts`, user-only permissions, recursive redaction, and clear path discovery mitigate it.
- Buffering a turn until SQLite succeeds means a process crash can lose the current in-flight transcript events. That is intentional: a transcript must not claim resumable state that SQLite never committed.
- SQLite message rows do not retain original per-event timestamps or tool durations, so exports of older sessions cannot reproduce those fields exactly. Exporters will omit optional precision or mark reconstructed Koan metadata, never fabricate it.
- Compatibility profiles are projections, not byte-for-byte clones of private native session files. Pinning documented public event contracts and fixtures provides useful parser reuse without coupling Koan to unstable internals.
- Coordinating deletion across SQLite and the filesystem is not a true cross-resource transaction. Same-directory rename provides a recoverable staging step; cleanup failures remain visible and testable.
- Adding a core lifecycle callback expands the loop API. Keeping it optional and provider-neutral prevents transcript concerns from entering adapters or changing existing callers.

## Testing

- Unit-test event typing, serialization, recursive redaction, sequence recovery, filesystem permissions, paths, and malformed final records.
- Contract-test Codex and Claude exporters against pinned public JSONL fixtures, including arbitrary Koan tool calls.
- Integration-test `run`, `chat`, `serve`, resume/continue, opt-out, `--no-persist`, location discovery, export, and coordinated delete using temporary XDG directories.
- Inject store and filesystem failures to verify SQLite-first turn consistency, visible transcript warnings, atomic export, and delete rollback.
- Run `npm run build`, the complete test suite, and a manual mock-server workflow before handoff.

## Not Doing

- No Codex rollout-schema or Claude project-directory emulation; both are private storage formats.
- No foreign transcript import/resume in version 1; compatibility is outbound export.
- No raw LLM HTTP-body capture in session JSONL; diagnostic LLM I/O remains an explicit stderr logging concern.
- No JSONL-only replacement for SQLite persistence; SQLite remains authoritative.
- No live Codex/Claude duplicate files; compatibility profiles are generated by `sessions export`.
- No embedded unrestricted binary media; transcripts store safe metadata or references.
