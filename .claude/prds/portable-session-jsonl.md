---
feature: portable-session-jsonl
artifact: prd
version: 1.1
last_aligned: 2026-08-02
status: current
---

# PRD: Portable Session JSONL

**Version:** 1.1
**Date:** 2026-08-02
**Status:** Approved

## §1. Overview

Koan currently emits operational Pino logs to stderr and persists resumable conversation state in `$XDG_DATA_HOME/koan/sessions.db` (normally `~/.local/share/koan/sessions.db`). It does not create a log file. This feature adds append-only, discoverable JSONL session transcripts and export profiles compatible with the documented machine-readable streams of Codex CLI and Claude Code, so existing parsers can consume Koan context without treating diagnostic logs as conversation history.

## §2. Goals

- Give each persisted Koan session a durable, append-only, one-JSON-object-per-line transcript.
- Preserve user messages, assistant messages, tool calls/results, turn boundaries, errors, timestamps, and token usage without API secrets.
- Provide a lossless, versioned Koan schema as the canonical transcript format.
- Export a stored session as either documented Codex CLI `exec --json` events or Claude Code `stream-json` events.
- Make the transcript location easy to discover from the CLI.
- Keep existing SQLite resume behavior and stderr diagnostic logging intact.
- Validate compatibility serializers with golden fixtures and parser-oriented contract tests.

## §3. Non-Goals

- Reproducing Codex's private `~/.codex/sessions/**/rollout-*.jsonl` schema or Claude Code's private project-storage schema.
- Writing files into another tool's home directory or making Koan sessions appear in that tool's native session picker.
- Importing or resuming foreign Codex/Claude transcripts in version 1.
- Replacing SQLite as Koan's source of truth for session resume, list, update, or delete.
- Persisting full HTTP headers, API keys, authorization tokens, or raw provider request/response bodies in transcript files.
- Redirecting Pino operational logs to the transcript file.

## §4. Constraints

- JSONL output must contain exactly one complete JSON object per physical line and end complete records with a newline.
- Compatibility targets are public CLI stream contracts: [Codex `exec --json`](https://developers.openai.com/codex/noninteractive/#json-output-mode) and [Claude Code `--output-format stream-json`](https://docs.anthropic.com/en/docs/claude-code/cli-usage), not undocumented on-disk implementation details.
- Existing `--no-persist` behavior must remain ephemeral and must not create a transcript.
- Transcript failures must not silently corrupt or partially overwrite the SQLite session.
- Transcript files may contain sensitive conversation context and must be created with user-only permissions where the platform supports POSIX modes.
- Existing `run`, `chat`, `serve`, and `sessions` behavior must remain backward compatible unless a new transcript option is explicitly selected.

## §5. User Stories / Use Cases

1. As a Koan user, I can ask where durable state and transcript files live, so I can inspect or back them up.
2. As a parser author, I can consume a stable Koan JSONL schema without scraping human-readable terminal output.
3. As a Codex event-stream consumer, I can export a Koan session in the documented `codex exec --json` shape.
4. As a Claude Code event-stream consumer, I can export a Koan session in the documented `stream-json` shape.
5. As a privacy-conscious user, I can disable persistence and be confident no session transcript is written.

## §6. Technical Design

### §6.1 Artifact Boundaries and Data Flow

The implementation must keep three artifacts conceptually separate:

| Artifact | Purpose | Destination | Authority |
|---|---|---|---|
| Operational log | Diagnostics, LLM request lifecycle, failures | stderr, using the existing Pino logger | Ephemeral |
| Session database | Resume/list/delete and durable Koan state | `$XDG_DATA_HOME/koan/sessions.db` | Source of truth |
| Session transcript | Portable event history and interoperability | `$XDG_DATA_HOME/koan/transcripts/...jsonl` | Derived append-only record |

For a live persistent session, the runner updates SQLite and emits canonical transcript events through a transcript writer. `koan sessions export` reads the SQLite record and serializes it to the selected public compatibility profile. Exporting from SQLite ensures older sessions created before this feature can also be converted.

### §6.2 Canonical Koan Event Model

Every canonical record must contain:

```ts
interface KoanTranscriptEvent {
  schema_version: 1;
  timestamp: string;      // ISO-8601 UTC
  session_id: string;
  sequence: number;       // monotonic within the session
  turn_id?: string;
  type: KoanTranscriptEventType;
  payload: Record<string, unknown>;
}
```

The initial event vocabulary is:

- `session.started`: profile, provider, model, cwd, and granted permissions.
- `turn.started`: the start of one user-driven agent turn.
- `message.user`: user text/media references after Koan normalization.
- `message.assistant`: complete assistant content and associated tool calls.
- `tool.started`: tool call id, Koan tool name, and validated arguments.
- `tool.completed`: tool call id, success/failure status, duration, and serialized result or error.
- `turn.completed`: aggregate usage and termination reason.
- `turn.failed`: normalized error category and safe message.
- `session.closed`: normal shutdown metadata when available.

The canonical payload must preserve Koan-specific information that a compatibility profile cannot represent. Large/binary media must use metadata or references rather than embedding unrestricted binary data.

### §6.3 Compatibility Profiles

`koan` is the lossless canonical profile. `codex` and `claude` are projections and may omit Koan-only metadata, but must preserve conversational order and tool-call correlation.

The Codex profile follows the public event stream emitted by `codex exec --json`, including `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `turn.failed`, and `error`. Assistant text maps to an `agent_message` item. Known Koan tools map to the closest documented Codex item type; tools without an exact public equivalent map to `mcp_tool_call` with `server: "koan"`, retaining the original Koan tool name and call id. This fallback must be proven against compatibility fixtures. Usage maps to Codex prompt/cached/completion/reasoning token fields when available.

The Claude profile follows Claude Code stream JSON: a system `init` record, ordered `user` and `assistant` message records using Anthropic content blocks, tool calls as `tool_use`, tool results as `tool_result`, and a terminal system `result` record with session, status, duration, turn count, and usage fields available from Koan.

Compatibility tests must pin the external contract version/date and include fixtures from the official public examples or locally captured CLI output. Unknown future fields must not break Koan's readers; changes to emitted required fields require a Koan transcript schema/version review.

### §6.4 Storage Layout and Lifecycle

The default transcript root is:

```text
$XDG_DATA_HOME/koan/transcripts/
  YYYY/MM/DD/<session-id>.jsonl
```

When `XDG_DATA_HOME` is unset, the root resolves to `~/.local/share/koan/transcripts`. A transcript stays associated with the SQLite session id. Deleting a session deletes its associated transcript in the same user-requested operation and reports both targets.

Files must be opened append-only, directories should use mode `0700`, and files should use mode `0600` on POSIX systems. Each event is encoded fully before one append operation. On startup/resume, the writer scans only enough of the final line to reject or repair a trailing incomplete record without rewriting valid earlier records.

### §6.5 CLI and Configuration

Extend `koan sessions` with:

```text
koan sessions where [--transcripts]       # DB path by default; transcript root with flag
koan sessions export <id> \
  --format koan|codex|claude \
  [--output <path>]                        # stdout when omitted
```

The file configuration schema gains a strict `transcripts` object:

```json
{
  "transcripts": {
    "enabled": true,
    "directory": "/optional/custom/path"
  }
}
```

Environment equivalents are `KOAN_TRANSCRIPTS_ENABLED` and `KOAN_TRANSCRIPTS_DIR`. CLI flags are `--transcripts`, `--no-transcripts`, and `--transcripts-dir`. Explicit CLI flags override environment and file configuration using Koan's existing precedence rules. `--no-persist` overrides transcript enablement and writes neither SQLite nor JSONL.

Transcripts are enabled by default whenever durable session persistence is enabled. Users can disable only the JSONL artifact with `--no-transcripts`; `--no-persist` disables both SQLite session persistence and JSONL transcripts.

Live transcript files always use the canonical `koan` profile; compatibility profiles are generated explicitly by `sessions export`. This avoids duplicating session data three times and keeps the durable representation lossless.

### §6.6 Error Handling and Consistency

- Failure to initialize a required transcript writer before a new persistent session starts is a visible configuration/I/O error; Koan must not imply that the transcript is being recorded.
- A transcript append failure during a turn is logged with session id and path but without message content or secrets. The turn's SQLite persistence may complete, and the CLI must warn that the portable transcript is incomplete.
- `sessions export` writes to stdout by default. When `--output` is used, it writes a temporary sibling file and atomically renames it so a failed export does not leave a plausible partial file.
- Compatibility projection errors identify the session id, source message/tool-call ordinal, and target format, then exit non-zero.
- Secrets are redacted using the existing logging redaction policy plus transcript-specific recursive key redaction before serialization.

### §6.7 Reuse and Existing Patterns

- Reuse `SessionRecord`, `RawMessage`, and usage data from `src/persistence/session-store.ts` as the export input.
- Reuse `defaultSessionsDbPath()`'s XDG data-directory convention for transcript path resolution.
- Extend `FileConfigSchema`, `CLIFlags`, and `resolveConfig()` so strict validation and file/env/flag precedence remain consistent.
- Reuse the provider-neutral event boundaries in `src/core/streaming.ts` and the runner persistence seam in `src/persistence/runner.ts`; do not couple transcript serialization to OpenAI or Anthropic adapters.
- Keep `src/obs/log.ts` responsible only for operational logging and reuse its sensitive-key redaction concepts.
- Extend `src/cli/sessions-subcommand.ts` for location discovery and offline export.

## §7. Acceptance Criteria

- A normal persistent `koan run` or `koan chat` session produces a canonical JSONL file at the documented XDG path when transcripts are enabled.
- Every non-empty transcript line parses independently as JSON, has schema version 1, and has a strictly increasing sequence for its session.
- User/assistant/tool/result ordering and tool-call ids round-trip from SQLite into the canonical export.
- `koan sessions export <id> --format codex` passes contract tests modeled on documented `codex exec --json` consumers.
- `koan sessions export <id> --format claude` passes contract tests modeled on documented Claude Code `stream-json` consumers.
- Existing sessions that predate transcript support can be exported from SQLite.
- `koan sessions where --transcripts` prints the effective transcript root.
- `--no-persist` creates neither a session DB record nor a transcript file.
- No API key or authorization header appears in canonical or compatibility fixture outputs.
- Existing CLI, persistence, and logger test suites continue to pass.

## §8. Confirmed Decisions

- Canonical live transcripts are enabled by default whenever durable session persistence is enabled.
- `koan sessions delete <id>` deletes both the SQLite session and its associated transcript, and reports both removals.
- Live transcript files always use Koan's canonical lossless schema; Codex and Claude compatibility are explicit export profiles.
- Arbitrary Koan tools without a more precise Codex item mapping use the public `mcp_tool_call` shape with `server: "koan"`.
