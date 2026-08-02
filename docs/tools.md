# Tool authoring

Every tool is a `ToolDef` value registered with the runtime. Tools are
**init-frozen** — they must be registered before any agent run starts.
The CLI calls `registerDefaultToolkit()` automatically; library users
can call `registerTool(def)` directly.

## ToolDef shape

```typescript
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema for the LLM
  isTerminator?: boolean;               // calling this ends the loop
  toolClass?: 'search' | 'other';       // for the search gate
  isMemoryWrite?: boolean;              // wire-layer security boundary
  permission?: 'read' | 'write' | 'shell' | 'network';
  paramsSchema?: { parse: (input: unknown) => unknown };  // Zod schema
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | ToolCallResult>;
}
```

### `permission`

Coarse capability. The runtime refuses to call a tool whose `permission`
isn't in the run's granted set. Tools without `permission` always run
(used by framework-internal tools like `submit_final_answer` and
`recall_folded_memory`).

### `paramsSchema`

Optional but **strongly recommended**. The loop validates model-supplied
args against this BEFORE invoking the handler. Validation failure
becomes a structured `ArgumentError` tool result the model can correct
on the next round — not a thrown exception.

Use Zod (already a dependency):

```typescript
import { z } from 'zod';

const MyToolSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().default(10),
});
```

### `isMemoryWrite`

Name-agnostic flag. Marks the tool as a user-memory writer; the loop
intercepts at the wire layer, forces `owner = request.userId`, and
routes through the pending-write confirmation queue. The handler itself
becomes a safety net (only reached if interception is bypassed).

### `handler`

`async (args, ctx) => string | ToolCallResult`

The `ctx`:

```typescript
interface ToolContext {
  sessionId: string;
  userId: string;
  signal?: AbortSignal;       // cancellation; check inside long ops
  cwd?: string;                // run's working dir
  allowedPaths?: string[];     // fs.* allowlist
}
```

Honour `ctx.signal` if your tool runs anything long-lived. `shell.exec`,
`web.fetch`, and the fs tools all use it.

## Worked example: a calculator tool

```typescript
import { z } from 'zod';
import { registerTool, type ToolDef } from 'koan';

const ExprSchema = z.object({
  expression: z.string().min(1),
});

export const calcTool: ToolDef = {
  name: 'math.calc',
  description: 'Evaluate a math expression. Supports + - * / parentheses.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'e.g. "2 * (3 + 4)"' },
    },
    required: ['expression'],
  },
  paramsSchema: ExprSchema,
  // No permission needed — pure computation, no side effects.
  handler: async (raw) => {
    const args = ExprSchema.parse(raw);
    // Sanitise — no user input ever reaches eval directly.
    if (!/^[\d+\-*/().\s]+$/.test(args.expression)) {
      return `Error: expression contains disallowed characters`;
    }
    // eslint-disable-next-line no-eval
    return `Result: ${eval(args.expression)}`;
  },
};

registerTool(calcTool);
```

The schema runs first; if `expression` is missing or empty, the model
sees `ArgumentError: expression: Required` and self-corrects.

## Path-allowlisted file tools

If your tool touches the filesystem, use the same `resolvePath` helper
the built-in fs tools use:

```typescript
import { resolvePath } from 'koan/tools/path-guard';

handler: async (raw, ctx) => {
  const args = MySchema.parse(raw);
  const { abs } = await resolvePath(args.path, ctx, /*requireExists*/ true);
  // abs is guaranteed to live inside ctx.allowedPaths.
  ...
};
```

`resolvePath` realpath-resolves both sides, so symlinks pointing out of
the allowlist are caught.

## Cancellation

Long-running tools should poll `ctx.signal.aborted` or wire the signal
into their downstream API. Example from `web.fetch`:

```typescript
const resp = await fetch(args.url, { signal });
```

When the user hits Ctrl-C in the REPL, the controller fires; your tool's
in-flight request is cancelled.

## Registration timing

- The registry **panics on duplicate names** at `initRegistries()` time.
- After `initRegistries()` runs, `registerTool` throws. The CLI calls
  `registerDefaultToolkit()` lazily (idempotent), so re-registering
  shipped tools is safe; new tools must register before the first run.
