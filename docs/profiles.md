# Profile reference

A **profile** is the unit of agent personality. One YAML file at
`~/.config/koan/profiles/<name>.yaml` (or `./.koan.yaml` for the
project-pinned variant) bundles:

- The system prompt template
- The default LLM (provider + model)
- The tool allowlist
- The default permission grants
- The default search-gate mode
- ReAct knobs (`maxRounds`)

## Schema

```yaml
# Required
name: my-agent

# Optional
description: One-liner shown by `koan profile list`.

# LLM defaults — these are overrideable by --provider / --model.
model: gpt-4o-mini
provider: openai          # openai | anthropic

# Template with {{var}} interpolation. Variables come from:
#   - {{user_memories}}, {{user_memories_count}}, {{mem_<key>}}  (cross-conv memory)
#   - {{user_name}}, {{user_preferences}}                         (legacy)
systemPromptTemplate: |
  You are my-agent. Be terse.

  Standing facts about the user:
  {{user_memories}}

# Tools available to this profile. If omitted, the full default toolkit
# is used. Set to [] for a knowledge-only profile.
tools:
  - fs.read
  - fs.list
  - web.fetch
  - submit_final_answer

# Permissions auto-granted at session start. Users can widen further at
# the CLI with --allow-* flags or /permissions add inside the REPL.
permissions:
  - read
  - network

# Default search gate. One of: auto | force | forbid.
defaultSearchGate: auto

# Hard cap on ReAct rounds per turn.
maxRounds: 12
```

The schema is **strict** — unknown keys cause an error so typos are
caught at load time.

## Built-in profiles

These ship inline and don't require any file:

| Name       | Tools | Permissions | Notes |
|------------|-------|-------------|-------|
| `default`  | full  | read        | Generalist. |
| `coding`   | full  | read, write, shell | Surgical-edit prompt, 16-round cap. |
| `research` | full  | read, network | "Cite your sources" prompt. |
| `strict`   | none  | (none) | Knowledge-only, 4-round cap. |

Inspect any of them:

```bash
koan profile show coding
```

## Authoring a profile

```bash
koan profile edit my-agent       # opens $EDITOR; creates a stub
koan profile list                # confirm it appears
koan --profile my-agent run "..." # use it
```

The filename and `name:` field must match. `koan profile edit` enforces
this when it creates the stub.

## Resolution precedence

When `--profile` is not given, the runtime picks in this order (later
wins):

1. `default` built-in
2. `~/.config/koan/profiles/<name>.yaml` (if `KOAN_PROFILE` is set)
3. `./.koan.yaml` in the current working directory
4. `--profile <name>` CLI flag

User-installed files **shadow** built-ins of the same name — you can
override `coding` locally without forking the codebase.

## Template variables

All variables come from `AcrossConversationMemory.getTemplateVars`. The
current shipped fetchers populate:

- `user_memories`        — newline-separated `- key: value` lines, or `(none)`
- `user_memories_count`  — string count
- `mem_<key>`            — one variable per stored memory
- `user_name`            — legacy; defaults to `"User"`
- `user_preferences`     — legacy; defaults to `"{}"`

Missing variables render as empty strings, not literally `{{missing}}`.
