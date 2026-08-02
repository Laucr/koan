# HTTP API reference

`koan serve` exposes the same loop + stores over HTTP. CLI and server
share the SQLite database — sessions are interchangeable.

## Authentication

Every endpoint under `/v1` except `/health`, `/version`, and `/metrics`
requires a bearer token:

```
Authorization: Bearer <token>
```

The expected token comes from `--auth-token` or `KOAN_AUTH_TOKEN`. If
neither is set, the server logs a warning and accepts any value.

## Rate limiting

Token-bucket per bearer, default 60 rpm. Configurable via `--rpm`.
Exceeding the bucket returns `429` with `Retry-After: <seconds>`.

## Concurrency

At most **one in-flight `POST .../messages`** per session. The second
concurrent POST returns `409` with the in-flight `requestId`. Use the
cancel endpoint to abort the running turn before starting a new one.

## Endpoints

### `GET /v1/health`

```json
200 OK
{ "status": "ok", "uptime": 12.345 }
```

### `GET /v1/version`

```json
200 OK
{ "version": "0.2.0" }
```

### `GET /v1/metrics`

Prometheus text exposition format. Unauthenticated.

```
# HELP koan_rounds_total Total ReAct rounds executed.
# TYPE koan_rounds_total counter
koan_rounds_total{model="gpt-4o-mini",profile="default"} 42
...
```

### `POST /v1/sessions`

Create a new session.

```json
POST /v1/sessions
Authorization: Bearer <token>
Content-Type: application/json

{
  "profile": "default",            // optional, defaults to "default"
  "provider": "openai",            // optional, defaults to server config
  "model": "gpt-4o-mini",          // optional
  "permissions": ["read"]          // optional
}
```

Response:

```json
201 Created
{
  "id": "s_xxx",
  "createdAt": "2026-06-22T08:00:00.000Z",
  "updatedAt": "2026-06-22T08:00:00.000Z",
  "profile": "default",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "cwd": "/home/koan",
  "permissions": ["read"],
  "usage": { "promptTokens": 0, "completionTokens": 0, "toolCalls": 0, "rounds": 0 },
  "messages": [],
  "title": "(empty session)"
}
```

### `GET /v1/sessions`

List sessions, newest-first.

Query params:
- `limit` (default 50)
- `profile` (filter)

```json
200 OK
{
  "sessions": [
    {
      "id": "s_xxx",
      "createdAt": "...",
      "updatedAt": "...",
      "profile": "default",
      "model": "gpt-4o-mini",
      "messageCount": 4,
      "tokensTotal": 1234,
      "title": "what year is it?"
    }
  ]
}
```

### `GET /v1/sessions/:id`

Full session record (same shape as `POST /sessions` response).

### `DELETE /v1/sessions/:id`

```json
200 OK
{ "deleted": "s_xxx" }
```

Cascades: deletes messages, cancels any in-flight run, drops pending
approvals + memory writes for that session.

### `POST /v1/sessions/:id/messages` (SSE)

Stream one turn over Server-Sent Events.

```http
POST /v1/sessions/s_xxx/messages
Authorization: Bearer <token>
Content-Type: application/json
Accept: text/event-stream

{ "content": "what year is it?" }
```

Response: `200 OK`, content-type `text/event-stream`. Events:

| Event              | Data                                                             |
|--------------------|------------------------------------------------------------------|
| `text_delta`       | `{ type, text }` — assistant token chunk                          |
| `tool_call_started`| `{ type, index, id, name }`                                       |
| `tool_call_args_delta` | `{ type, index, delta }` — partial JSON for arguments         |
| `tool_call_complete`| `{ type, index, id, name, argumentsJson }`                       |
| `approval_needed`  | `{ pendingId, toolName, argsPreview, timeoutMs }` — see below     |
| `error`            | `{ message }` — stream ends after                                 |
| `done`             | `{ finalAnswer, toolCallsMade, rounds, warnings, usage, pendingMemoryWrites }` |

After `done` (or `error`), the connection closes.

### `POST /v1/sessions/:id/messages/cancel`

Abort the in-flight turn (if any).

```json
200 OK
{ "cancelled": true }   // or false if nothing was in flight
```

### `POST /v1/sessions/:id/approvals/:apid`

Resolve a pending tool approval. The server emitted the `apid` via an
`approval_needed` SSE event.

```json
POST /v1/sessions/s_xxx/approvals/ap_3
Authorization: Bearer <token>
Content-Type: application/json

{ "decision": "allow" }    // or "deny" or "always"
```

```json
200 OK
{ "ok": true }
```

`404` if the `apid` doesn't match a pending approval (already resolved
or expired). Approvals auto-deny after 60 seconds by default
(`--approval-timeout`).

## SSE client example

```typescript
import { EventSource } from 'eventsource';

const r = await fetch('http://localhost:8787/v1/sessions', {
  method: 'POST',
  headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ profile: 'coding' }),
});
const { id } = await r.json();

// Send a message; consume the stream.
const resp = await fetch(`http://localhost:8787/v1/sessions/${id}/messages`, {
  method: 'POST',
  headers: {
    'authorization': 'Bearer ' + token,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
  },
  body: JSON.stringify({ content: 'summarize this directory' }),
});

const reader = resp.body!.getReader();
const decoder = new TextDecoder();
let buf = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = '', data = '';
    for (const ln of frame.split('\n')) {
      if (ln.startsWith('event:')) event = ln.slice(6).trim();
      else if (ln.startsWith('data:')) data += ln.slice(5).trim();
    }
    if (event === 'text_delta') {
      const e = JSON.parse(data);
      process.stdout.write(e.text);
    } else if (event === 'approval_needed') {
      const e = JSON.parse(data);
      // Ask the user, then POST the decision.
      await fetch(`http://localhost:8787/v1/sessions/${id}/approvals/${e.pendingId}`, {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' }),
      });
    } else if (event === 'done') {
      // Stream ends after this event.
    }
  }
}
```

## Graceful shutdown

`SIGTERM` (or calling `handle.close()`) puts the server into drain mode:

1. New requests get `503 server is draining`.
2. In-flight runs continue (up to 30s).
3. Stores are closed.

Send `SIGKILL` if you need it harder.
