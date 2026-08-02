---
feature: koan-product
artifact: prd
version: 1.3
last_aligned: 2026-08-02
status: current
---

# Product Requirements: Build Koan, a Runnable Agent Product

## Amendments

| Version | Date | Amendment | Summary |
|---|---|---|---|
| v1.1 | 2026-08-02 | [r1](../amendments/koan-product-r1.md) | Make the OpenAI-compatible base URL configurable in every LLM-backed mode. |
| v1.2 | 2026-08-02 | [r2](../amendments/koan-product-r2.md) | Support strict OpenAI tool-name schemas and non-streaming interactive endpoints. |
| v1.3 | 2026-08-02 | [r3](../amendments/koan-product-r3.md) | Log LLM I/O on demand and always render the final chat answer. |

**Goal:** Grow Koan's ReAct substrate (`koan`) into a **runnable, general-purpose agent system** — usable like Claude Code (interactive CLI loop with tool use, streaming, file/shell access, multi-turn sessions) but **not domain-locked to coding**. The same binary should also serve as a long-running HTTP server so other front-ends (web UIs, IDE plugins, automation jobs) can talk to it.

**Non-goals (for now):**
- Multi-user authentication / SSO / RBAC. Single-user local-first first; add later.
- Distributed deployment (clustering, sharding). Single-process is fine.
- A web UI. The CLI and HTTP API are the only surfaces in v1.
- Coding-specific superpowers (LSP, refactoring tools). General tools only; coding is one possible toolkit shipped as a profile.
- Replacing Claude Code. Inspired by it; not a clone.

---

## Guiding principles (carry-overs from the philosophy)

1. **Predictable framework, quality delegated upward.** The runtime stays deterministic; tools, prompts, profiles are the surfaces where "agent personality" lives.
2. **Off by default.** Every new subsystem ships disabled unless the user opts in (config or flag).
3. **Plug-in surface widens; runtime stays rigid.** New tools and middlewares register through the existing surfaces; no special cases.
4. **Adapter abstraction over concrete vendors.** LLM, persistence, transport, terminal — each swappable.
5. **Observability is part of "done."** A milestone isn't complete until traces, logs, and structured errors land for the new code path.

## OpenAI-compatible endpoint requirements

- The API base URL is selectable through `--base-url` for `run`, `chat`, and
  `serve`, with `KOAN_BASE_URL` and the user config file providing persistent
  defaults under the normal flag-over-env-over-file precedence.
- Koan may retain namespaced internal tool names such as `fs.read`, but the
  OpenAI adapter must translate every tool definition, forced tool choice, and
  historical tool call to a schema-safe wire name matching
  `^[a-zA-Z0-9_-]+$`, then translate returned calls back before dispatch.
- Interactive chat supports `--no-stream` for OpenAI-compatible endpoints that
  implement chat completions but not SSE streaming.
- Chat always renders the completed answer, including answers delivered through
  `submit_final_answer`; it must not duplicate text already rendered as stream
  deltas.
- `KOAN_LOG_LEVEL=debug` logs the complete LLM request and assembled response
  with model, base URL, request id, and duration. `trace` additionally logs raw
  streaming chunks. Authorization secrets must not be logged, and documentation
  must warn that prompts, tool arguments, and answers can be sensitive.

---

## Milestones

Each milestone is **independently shippable** and **observable on its own** (you can run the binary at the end of it and see the new behaviour). Milestones are ordered so each one solves a single concrete user need before the next one starts.

---

### M1 — `koan` CLI: one-shot prompt against the local LLM

**User-visible outcome:** `koan run "summarize this directory"` prints an answer to stdout. No tools yet, no streaming, no session.

**Why first:** Proves the substrate runs end-to-end against a real LLM provider, with a real config file, outside of `tsx examples/basic.ts`. Establishes the binary, the config schema, and the entry point everything else hangs off.

**Scope:**
- New `bin/koan` entry, exposed via `package.json#bin`.
- `koan run "<prompt>"` — single-shot: read prompt → run loop → write final answer to stdout, exit non-zero on error.
- Config resolution: `~/.config/koan/config.json` → env vars → CLI flags. Schema validated with Zod.
- API key lives in env (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) — no secrets in config files.
- Cancellation: Ctrl-C threads an `AbortController` through the loop and the LLM call.
- LLM call gets a per-round timeout (default 60s).
- Uses the existing `runReActAgent` unchanged — no scaffold changes other than adding `AbortSignal` plumbing.

**Acceptance:**
- `koan run "what year is it?"` produces a sensible answer.
- Ctrl-C kills the run within ~1s, no hang.
- A killed OpenAI call (firewall + timeout) exits with a clear error message, not a stack trace.

**~5–7 days of work.**

---

### M2 — Streaming output

**User-visible outcome:** The CLI prints tokens as the model produces them.

**Why next:** Without this, every interaction feels broken at >5s response times. Cheaper to add now than retrofit after tools land.

**Scope:**
- New `LLMStreamingClient` interface: `(req) => AsyncIterable<LLMStreamEvent>`. Events: `delta` (text chunk), `tool_call_started` (with name), `tool_call_args_delta`, `tool_call_complete`, `done`.
- OpenAI streaming adapter (`stream: true`), Anthropic streaming adapter.
- `runReActAgent` gains an optional streaming-aware path that emits the same events upward. Existing non-streaming callers keep working.
- CLI subscribes to `delta` events and writes them to stdout as they arrive; tool calls render as `[search_web(query=…)]` placeholders.
- The token-cache discipline survives: assistant tokens are recomputed once at end-of-response from the accumulated text, not estimated mid-stream.

**Acceptance:**
- A 30-second response renders with first token visible in <2s.
- Streaming + Ctrl-C still cleanly aborts.
- Streaming works with both an OpenAI-compatible endpoint and Anthropic.

**~7 days.**

---

### M3 — Tool calling against a curated default toolkit

**User-visible outcome:** `koan run "list the .ts files in src/ and tell me which is largest"` — actually does it.

**Why this scope:** The framework already has the wiring for tools; what's missing is a *useful* toolkit. We pick a deliberately small set so each tool can be securely implemented and tested rather than a kitchen sink.

**Default toolkit (v1):**
- `fs.read` — read a file (path, optional line range), with size limit and path-allowlist enforcement.
- `fs.list` — list a directory, non-recursive by default.
- `fs.write` — write/append a file, gated by an explicit `--allow-write` CLI flag.
- `shell.exec` — run a shell command with a timeout, capture stdout/stderr/exit, gated by an explicit `--allow-shell` flag and a denylist of obvious destructive patterns (`rm -rf`, `:(){...}`, etc.).
- `web.fetch` — HTTP GET with a 2 MB cap and a 30 s timeout.
- `submit_final_answer` — terminator tool, already shipped.

Each tool ships with a Zod schema for arguments. Schema validation runs **before** the handler. Schema errors come back to the model as a structured error result so the model can self-correct.

**Scope:**
- Introduce a `ToolPermission` concept: `read` / `write` / `shell` / `network`. Tools declare which permission they need; the loop refuses to call a tool whose permission isn't granted in the current run.
- Three permission modes: `--auto-approve none|safe|all`. `safe` auto-approves read-only tools (`fs.read`, `fs.list`, `web.fetch`); `all` approves everything; `none` (default) prompts at the CLI before each tool call. The prompt shows the tool name, args, and waits for `y/n/always`.
- Path-allowlist is the working directory by default, expandable via `--allow-path`.
- Each tool emits a structured event the CLI renders as e.g. `→ fs.read("src/loop.ts") ✓ 4321 bytes`.

**Acceptance:**
- The example query above works end-to-end with `--auto-approve safe`.
- A tool call requiring shell access prompts the user; declining sends a structured "tool denied by user" result back to the model.
- A tool argument that fails Zod validation produces a self-correcting message in the next round, not a thrown exception.
- Path traversal (`..`, absolute paths outside the allowlist) is blocked by `fs.*` tools.

**~10 days.**

---

### M4 — Interactive REPL session

**User-visible outcome:** `koan` (no args) opens a Claude-Code-style prompt: type, enter, see streaming response, type again. History persists within the session.

**Why now:** All the pieces from M1–M3 (tool calls with prompts, streaming, abort) need to compose into a continuous session. This milestone proves the multi-turn shape works.

**Scope:**
- TTY detection. If stdin is a TTY, default to REPL mode; otherwise pipe-friendly (read prompt from stdin).
- Multi-line input (Shift+Enter or `"""` heredoc).
- Slash commands: `/help`, `/exit`, `/clear`, `/history`, `/save <path>` (dump session JSON), `/load <path>` (restore), `/permissions` (show + toggle current grants), `/model <id>` (switch mid-session).
- Session state is the existing `ConversationHistory` plus a small wrapper for slash-command handling. The slice line at last-user is honoured for every turn.
- Ctrl-C aborts the current run but keeps the REPL alive; second Ctrl-C exits.
- Approval prompts during tool execution don't crash the rest of the line buffer; the REPL pauses input until the prompt resolves.

**Acceptance:**
- A user can have a 5-turn conversation that reads files, runs commands (with approval), and references "the file we looked at earlier" — the model gets the prior tool outputs.
- `/save` produces a JSON the loop can `/load` and continue.
- The terminator tool still works inside REPL: calling it ends only the current turn, not the session.

**~7 days.**

---

### M5 — Agent profiles (the "not just coding" hook)

**User-visible outcome:** `koan --profile research` and `koan --profile coding` behave as different personalities — different system prompt, different toolkit, different gate defaults — though both run on the same binary.

**Why this matters:** This is the milestone that proves the goal of "not just for coding." A profile is the unit of agent-personality, replacing the assumption that there's one global agent.

**Scope:**
- A profile is a YAML file under `~/.config/koan/profiles/<name>.yaml`. It's a superset of the existing `AgentConfig` plus: tool allowlist (subset of registered tools), default permissions, default model, default gate.
- Built-in profiles shipped:
  - `default` — generalist, all read-only tools auto-approved, no shell or write.
  - `coding` — same plus `fs.write` and `shell.exec`, system prompt mentioning code conventions, preferring terminator submission.
  - `research` — adds `web.fetch`, no shell, system prompt biased toward citing sources.
  - `strict` — no tools at all, knowledge-only.
- `koan profile list` / `koan profile show <name>` / `koan profile edit <name>` (opens `$EDITOR`).
- Profile selection precedence: CLI flag > env (`KOAN_PROFILE`) > current directory's `.koan.yaml` > `default`.
- `.koan.yaml` in the current directory lets a project pin its preferred profile (analogous to `CLAUDE.md`).

**Acceptance:**
- The same prompt produces visibly different behaviour under `--profile coding` vs `--profile research`.
- Dropping a `.koan.yaml` into a project directory makes `koan` (no flags) pick up that profile when run there.
- A profile that lists an unknown tool warns at startup but doesn't crash.

**~7 days.**

---

### M6 — Persistence: durable sessions

**User-visible outcome:** Closing the REPL and re-opening it later resumes where you left off. `koan sessions list` / `koan sessions resume <id>` work.

**Why now:** With multi-turn sessions and profiles in place, losing them on every exit is painful. Also unblocks the HTTP server (M8), which needs a persistent session backend.

**Scope:**
- New `SessionStore` interface: `create / get / append / list / delete`.
- Two implementations: `MemorySessionStore` (default, ephemeral), `SQLiteSessionStore` (file at `~/.local/share/koan/sessions.db`).
- The status callback already produced per-round events; wire one of those subscribers to `SessionStore.append` for the active session.
- Sessions store: id, profile name, created_at, updated_at, full `ConversationHistory`, tool-call audit log, total tokens spent.
- `koan sessions list` shows id / first user message preview / last activity.
- `koan sessions resume <id>` reopens the REPL with that session's history rehydrated.
- `--continue` flag on `koan run` resumes the most recent session.
- A migration system for the SQLite schema (start with a single migration; just establishes the discipline).

**Acceptance:**
- Kill the REPL, reopen with `--continue`; the model has full prior context.
- The sessions DB survives a process crash.
- Listing shows accurate token totals (cost accounting from `LLMResponse.usage`).

**~10 days.**

---

### M7 — Across-conversation memory (user profile)

**User-visible outcome:** The agent learns standing facts about the user ("I prefer terse responses", "my project lives at /Users/x/foo") and applies them across sessions.

**Why this fits here:** The scaffold's `AcrossConversationMemory` is wired but has no backend. With M6's SQLite store now in place, this is a small extension.

**Scope:**
- A `user_memory` table in the same SQLite DB. Fields: owner (forced by runtime, never trusted), key, value, created_at, updated_at.
- The shipped `write_user_memory` tool now actually persists. The wire-layer override on `isMemoryWrite` (already implemented) keeps owner enforcement honest.
- A `/memory` slash command: `list` / `forget <key>` / `clear`.
- The system prompt template gains `{{user_memories}}` — the loader concatenates active memories into the SP at request start.
- A confirmation-required write path: by default the tool returns a "would write X" preview the model surfaces; user confirms via `/memory accept` before persistence. Spec's fail-close discipline applies.

**Acceptance:**
- Telling the agent "from now on always cite sources" and starting a fresh session — the new session honours it.
- A model attempting to write memory for a different user (`owner: 'someone-else'`) silently has the owner overridden to the actual user.
- `/memory clear` empties everything for the current user without affecting other users in the same DB.

**~5 days.**

---

### M8 — HTTP server mode

**User-visible outcome:** `koan serve --port 8787` exposes the same agent behind a small REST + SSE API. A simple `curl` script can drive a session.

**Why this is the second-to-last:** Everything that makes the CLI useful — profiles, sessions, memory, streaming — needs to be available over the wire too. Doing it after the CLI shape is settled means the API is shaped by what's actually useful, not by what's easy.

**API surface (minimal):**
- `POST /v1/sessions` → `{ id, profile }` — creates a session.
- `GET /v1/sessions` / `GET /v1/sessions/:id` — list / inspect.
- `DELETE /v1/sessions/:id`.
- `POST /v1/sessions/:id/messages` with `Accept: text/event-stream` → SSE stream of `delta` / `tool_call` / `done` events.
- `POST /v1/sessions/:id/messages/:msgId/cancel` → aborts an in-flight run.
- `GET /v1/health` / `GET /v1/version`.
- All endpoints accept and surface `X-Request-Id` for tracing.

**Scope:**
- `koan serve` builds the same loop the CLI uses; the only differences are the transport and the session-rehydration path.
- Single shared bearer token via `--auth-token` / `KOAN_AUTH_TOKEN`. No multi-user model in v1.
- Tool-approval gets a callback hook: the server forwards "would call X with args Y" events to the client; the client must POST to a `/approve` endpoint within a timeout, else the tool is denied.
- Graceful shutdown: SIGTERM stops accepting new requests, drains in-flight loops up to a 30s deadline, then exits.
- Rate limiting per token (e.g. token bucket, 60 reqs/min default) and per-session concurrency cap (1 in-flight run at a time).

**Acceptance:**
- `curl -N http://localhost:8787/v1/sessions/.../messages` streams tokens just like the CLI.
- Killing the server with SIGTERM mid-run sends a clean error to the client and persists session state up to the last completed round.
- The same session can be driven from the CLI (`--continue`) and the HTTP API alternately.

**~12 days.**

---

### M9 — Observability and packaging

**User-visible outcome:** `koan` produces useful logs and traces by default; the binary can be installed by non-developers.

**Why last:** Hardening before release. Until M1–M8 land, optimising telemetry is wasted work because the surfaces are still moving.

**Scope:**
- Structured logging via `pino`, configurable level, JSON output by default in server mode and pretty in CLI mode.
- OpenTelemetry tracing as an opt-in (`OTEL_EXPORTER_*` env vars). One span per round, child spans per tool call and per LLM call. Session id and user id propagate as span attributes.
- Prometheus-format `/v1/metrics` endpoint on the HTTP server: total tokens, tool calls by name and outcome, round counts, p50/p95/p99 round latency, active session count.
- Cost reporting: a `/cost` slash command and a `total_cost_usd` field in the session JSON, computed from `LLMResponse.usage` against a per-model price table that's editable.
- Single binary distribution: `pkg`-or-`bun-build` produced executables for macOS-arm64, macOS-x64, linux-x64. Homebrew formula. Smoke test in CI.
- Docs: a real `README.md` walkthrough, a `docs/` folder with profile authoring, tool authoring, HTTP API reference.

**Acceptance:**
- A user installs via `brew install koan`, runs `koan run "hi"`, sees a sensible answer and a trace they can read.
- `curl /v1/metrics` returns parseable Prometheus output with non-zero counters.
- CI publishes binaries on tag.

**~10 days.**

---

## Cross-milestone discipline

These rules apply to every milestone, not to a single one:

- **No milestone closes without tests.** Each adds at least one new contract test for the user-visible behaviour.
- **No milestone closes with new `as any` debt.** If a milestone needs an escape hatch, it pays for it by widening the public type to support the case properly.
- **Each milestone runs against a real LLM in CI** (with a recorded cassette in offline mode) so we catch wire-format regressions early.
- **Every milestone updates `CHANGELOG.md`.** The user-visible outcome line above is the changelog entry seed.
- **Failing-fast principle:** at startup, validate config, profiles, tool permissions, persistence backend reachability. A misconfigured server should refuse to start, not silently degrade.

---

## Sequencing rationale at a glance

```
M1  CLI binary        (proves it runs)
 └── M2  Streaming    (proves it feels good)
      └── M3  Tools   (proves it does something)
           └── M4  REPL  (proves it composes multi-turn)
                ├── M5  Profiles  (proves it's general, not just coding)
                ├── M6  Persistence  (proves it survives restarts)
                │    └── M7  Cross-conv memory  (proves it learns)
                └── M8  HTTP server  (proves it scales beyond a TTY)
                     └── M9  Observability + packaging  (proves it's shippable)
```

**Total estimate:** ~80 working days for one engineer. Parallel paths possible after M4: M5 / M6 / M8 can be built concurrently by separate threads of work.

---

## What this plan deliberately doesn't include

- A web UI. The HTTP API exists; building a UI is a downstream project.
- A plugin marketplace. Tools are added by editing config and dropping files in `~/.config/koan/tools/`. A registry is a v2 concern.
- Multi-tenant authn/authz. Single bearer token in v1. Deliberately stops short of needing a user database.
- Coding-specific tools (LSP, AST manipulation, refactoring). The `coding` profile is just system prompt + the standard fs/shell tools. Anything coding-smart is a tool authoring exercise the profile catalog enables, not part of the core.
- Vision / file-attachment input. `RawMessage.media` is wired but no real loader handles images. Add when there's a concrete use case.
- Function-calling protocol other than OpenAI-style. The H8 WARN from the bailiff report stays open until a model needing it ships.

---

**Verdict criterion for the whole project:** "I can `brew install koan`, run `koan` in a fresh terminal, and have a useful conversation in any domain (research, writing, sysadmin, coding, planning) — interrupting freely, switching profiles, resuming tomorrow, and trusting that destructive tools will ask before acting."

When that sentence is true end-to-end, M1–M9 are done. Anything left over is v2.
