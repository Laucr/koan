# Koan

Koan (as in a Zen koan) is a general-purpose AI agent CLI and HTTP server,
built on a predictable ReAct framework. The same binary works as an
interactive REPL, a one-shot prompt runner, and a long-running HTTP service
backed by SQLite.

Not domain-locked: ships with `default`, `coding`, `research`, and
`strict` profiles out of the box, and the profile format is the unit of
agent personality — system prompt, toolkit, default permissions, all in
a small YAML file.

## Quick start

```bash
# Install (development)
git clone https://github.com/Laucr/koan
cd koan
npm install
npm run build

# One-shot prompt
OPENAI_API_KEY=sk-... node bin/koan.mjs run "what year is it?"

# Interactive REPL
OPENAI_API_KEY=sk-... node bin/koan.mjs

# HTTP server
KOAN_AUTH_TOKEN=secret OPENAI_API_KEY=sk-... node bin/koan.mjs serve

# After install, `npm install -g .` exposes `koan` on $PATH.
```

### Connect a local OpenAI-compatible server

The OpenAI adapter expects the API root (normally ending in `/v1`). For a
server listening on port 8000, first run the connection smoke test:

```bash
# Uses http://127.0.0.1:8000/v1, discovers a model from GET /v1/models,
# and sends one non-streaming chat completion through Koan's adapter.
npm run check:llm

# If the server does not expose GET /v1/models, provide its model id.
KOAN_MODEL=my-model npm run check:llm
```

Then run Koan against the same server. A dummy key is sufficient
for servers that do not authenticate:

```bash
KOAN_API_KEY=sk-dummy npm run koan -- run "Hello from Koan" \
  --base-url http://127.0.0.1:8000/v1 \
  --model gpt-4o \
  --no-stream \
  --no-tools \
  --no-persist
```

For an interactive session with this non-streaming mock:

```bash
npm run koan -- chat --no-stream
```

Start with `--no-stream --no-tools` to verify basic chat-completions
compatibility. Remove those flags afterward to exercise streaming and the
ReAct tool-calling loop. The equivalent persistent environment settings are
`KOAN_BASE_URL`, `KOAN_MODEL`, and `KOAN_API_KEY`.

`--base-url` is supported by all LLM-backed CLI modes:

```bash
koan run "..." --base-url http://127.0.0.1:8000/v1
koan chat --base-url http://127.0.0.1:8000/v1
koan serve --base-url http://127.0.0.1:8000/v1
```

## Subcommands

```
koan                            Open the REPL (TTY) or print help (pipe)
koan run "<prompt>"             One-shot prompt → final answer
koan chat                       Open the REPL explicitly
koan serve                      Start the HTTP server
koan profile <list|show|edit|where>
koan sessions <list|show|resume|delete|export|where>
koan help
```

Every subcommand accepts `--help`.

## Configuration

Resolution precedence (later wins):

1. `~/.config/koan/config.json` — non-secret defaults
2. environment variables: `KOAN_PROVIDER`, `KOAN_MODEL`, `KOAN_BASE_URL`, `KOAN_LLM_TIMEOUT_MS`, `KOAN_TRANSCRIPTS_ENABLED`, `KOAN_TRANSCRIPTS_DIR`
3. CLI flags: `--provider`, `--model`, `--base-url`, `--timeout`, `--transcripts`, `--no-transcripts`, `--transcripts-dir`

API keys come **only** from environment variables:

- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `KOAN_API_KEY`

The config file actively rejects `apiKey`-shaped keys to prevent accidental
leakage via dotfiles checked into git.

## Profiles

A profile bundles system prompt + tool allowlist + default permissions
into a YAML file. Four built-ins ship inline:

| Profile     | Tools          | Permissions             | Use case             |
|-------------|----------------|-------------------------|----------------------|
| `default`   | full toolkit   | read                    | generalist           |
| `coding`    | full toolkit   | read, write, shell      | software engineering |
| `research`  | full toolkit   | read, network           | citing sources       |
| `strict`    | none           | (none)                  | knowledge-only       |

Selection precedence:

1. `--profile <name>` CLI flag
2. `KOAN_PROFILE` env var
3. `./.koan.yaml` in the current directory (project-pinned)
4. `default`

User-installed profiles live at `~/.config/koan/profiles/<name>.yaml`.
See [docs/profiles.md](docs/profiles.md) for the schema.

## Tools and permissions

The default toolkit:

| Tool                | Permission | What                                |
|---------------------|------------|-------------------------------------|
| `fs.read`           | read       | Read a file (line ranges, base64)   |
| `fs.list`           | read       | List a directory (recursive opt)    |
| `fs.write`          | write      | Write/append a file                 |
| `shell.exec`        | shell      | Run a shell command (timeout, caps) |
| `web.fetch`         | network    | HTTP GET, 2 MB cap, 30s timeout     |
| `write_user_memory` | (gated)    | Stage a fact for cross-session memory |
| `submit_final_answer` | —        | Terminator (structured answer)      |

Permission grants:

```bash
# read-only (default)
koan run "summarize this dir"

# auto-approve everything (use with caution)
koan run --auto-approve all "..."

# explicit per-capability grants
koan run --allow-write "..."
koan run --allow-shell --allow-path /tmp "..."
```

In `--auto-approve none` mode (the default) any non-read tool opens an
arrow-key permission selector before running. Choose Allow once, Allow always,
or Deny with ↑/↓ and Enter; Deny can include an optional reason.
`shell.exec` additionally refuses obvious
destructive patterns (`rm -rf /`, `dd of=/dev/sd*`, fork bomb, `curl … |
sh`, …) even when shell permission is granted.

See [docs/tools.md](docs/tools.md) for the tool-authoring API.

## Sessions

Every run is persisted by default to `~/.local/share/koan/sessions.db`
(SQLite). The CLI and HTTP server share the same database — you can
start a conversation in the REPL, close it, and continue it from `curl`
or vice versa.

```bash
koan sessions list
koan sessions show s_xxx
koan sessions resume s_xxx       # open in REPL
koan sessions delete s_xxx
koan sessions where              # print the SQLite path
koan sessions where --transcripts
koan sessions export s_xxx --format koan
koan sessions export s_xxx --format codex --output session.codex.jsonl
koan sessions export s_xxx --format claude --output session.claude.jsonl

koan run --continue "..."        # resume the most recent
koan run --resume s_xxx "..."    # resume a specific session
koan run --no-persist "..."      # don't write to the DB
```

Persistent sessions also write a canonical, append-only JSONL transcript by
default. Files live under
`$XDG_DATA_HOME/koan/transcripts/YYYY/MM/DD/<session-id>.jsonl` (normally
`~/.local/share/koan/transcripts/...`) with user-only permissions. SQLite
remains the source of truth for resume; JSONL is the portable event record.

Use `--no-transcripts` to retain SQLite persistence without JSONL, or
`--no-persist` to disable both. The config file accepts:

```json
{
  "transcripts": {
    "enabled": true,
    "directory": "/optional/custom/root"
  }
}
```

Deleting a session deletes its associated transcript. Codex and Claude
exports target their documented public CLI JSONL streams; Koan does not copy
their private on-disk session formats and cannot import them for resume.

## Cross-session memory

`write_user_memory` lets the agent stage standing facts about you. Writes
**don't persist until you confirm them** via `/memory accept <id>`. The
runtime forces the owner from the request — the model cannot write for a
different user even if it tries.

The selected profile can reference `{{user_memories}}` in its system
prompt template to surface remembered facts to the agent at the start of
every turn.

REPL slash commands:

```
/memory                  list stored memories
/memory pending          list staged writes
/memory accept <id>      persist one
/memory deny <id>        drop one
/memory forget <key>     delete a stored memory
/memory clear            drop everything for the current user
```

## HTTP API

```
GET    /v1/health
GET    /v1/version
GET    /v1/metrics                          (Prometheus format)
POST   /v1/sessions                         create
GET    /v1/sessions                         list
GET    /v1/sessions/:id
DELETE /v1/sessions/:id
POST   /v1/sessions/:id/messages            (SSE stream)
POST   /v1/sessions/:id/messages/cancel
POST   /v1/sessions/:id/approvals/:apid     (resolve a pending tool approval)
```

All endpoints under `/v1` are bearer-authenticated except `/health`,
`/version`, and `/metrics`. Set the expected token via `--auth-token` or
`KOAN_AUTH_TOKEN`.

See [docs/http.md](docs/http.md) for full request/response schemas and an
SSE event reference.

## Observability

- **Logging**: structured via `pino`. JSON to stderr by default; set
  `KOAN_LOG_FORMAT=pretty` for human-readable output on a TTY, or
  `KOAN_LOG_FORMAT=json` to force JSON. Koan does not create an operational
  log file; redirect stderr or use a log collector when a file is required.
- **Session transcripts**: canonical context JSONL is separate from Pino
  diagnostics. Find it with `koan sessions where --transcripts`; export a
  stored session with `koan sessions export`.
- **Levels**: `KOAN_LOG_LEVEL=info` (default; `trace`/`debug`/`warn`/`error`/`silent` also work).
- **LLM I/O**: `KOAN_LOG_LEVEL=debug` logs complete requests and assembled
  responses; `trace` additionally logs every streaming chunk. These payloads
  can contain prompts, tool arguments, and model answers, so enable them only
  when that data is safe to write to your terminal or log collector.
- **Metrics**: Prometheus text format at `GET /v1/metrics` (unauthenticated).
  Exposes counters for HTTP requests, rounds, tokens, tool calls, cost;
  histograms for round duration and HTTP latency; gauges for active
  sessions and pending approvals.
- **Cost**: per-model price table (override via `KOAN_MODEL_PRICES` JSON
  env). The REPL's `/cost` slash command shows tokens + estimated USD
  for the current session.

OpenTelemetry tracing is **not yet wired** — the SDK is bulky for the
limited value here, so the framework only emits Prometheus metrics in
v0.2. Tracing is on the roadmap.

## Design philosophy

The runtime under Koan is a strict ReAct framework built around six
commitments documented in `.claude/philosophy/`:

- **Predictable framework, quality delegated upward** — the loop doesn't
  judge content; agent designers set up tools/prompts/middleware that do.
- **Structural over semantic** — termination is "did you ask for a
  tool?", not "is this answer good?".
- **Off by default** — memory, middlewares, force signals all require
  explicit opt-in.
- **Lifetime is first-class** — every signal has a declared lifetime
  (one-shot / session-wide / monotonic / derived).
- **Rigid framework, flexible plug-ins** — tools, prompts, profiles, and
  memory backends are the plug-in surfaces; the loop runtime is rigid.
- **Treat the model as adversary at security boundaries** — user-memory
  writes are intercepted at the wire layer; the owner is forced from
  the request, never trusted from model args.

Read the philosophy docs for the deep rationale.

## License

MIT.
