/**
 * `koan serve` — start the HTTP server.
 */
import { parseArgv, flagAsString, flagAsBool, flagAsNumber } from './argv.js';
import { startServer } from '../server/index.js';

const HELP = `usage: koan serve [flags]

Start the HTTP server.

Flags:
  --port <n>                Bind port (default 8787)
  --host <addr>             Bind host (default 127.0.0.1)
  --auth-token <token>      Bearer token. Else uses $KOAN_AUTH_TOKEN.
  --rpm <n>                 Requests/minute per token (default 60)
  --timeout <ms>            Per-LLM-call timeout (default 60000)
  --approval-timeout <ms>   Approval auto-deny timeout (default 60000)
  -h, --help                Show this help

Notes:
  Sessions persist to $XDG_DATA_HOME/koan/sessions.db, same as the CLI.
  CLI and HTTP can alternate against the same DB; both see the same history.

Endpoints (all under /v1, all JSON unless noted, all bearer-auth except health/version):
  GET    /health
  GET    /version
  POST   /sessions                       create
  GET    /sessions                       list
  GET    /sessions/:id
  DELETE /sessions/:id
  POST   /sessions/:id/messages          SSE stream of one turn
  POST   /sessions/:id/messages/cancel   abort the in-flight turn
  POST   /sessions/:id/approvals/:apid   resolve a pending approval
`;

export async function serveSubcommand(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (flagAsBool(parsed, 'help', 'h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const port = flagAsNumber(parsed, 'port') ?? 8787;
  const host = flagAsString(parsed, 'host') ?? '127.0.0.1';
  const authToken = flagAsString(parsed, 'auth-token');
  const rpm = flagAsNumber(parsed, 'rpm');
  const timeoutMs = flagAsNumber(parsed, 'timeout');
  const approvalTimeoutMs = flagAsNumber(parsed, 'approval-timeout');

  let handle;
  try {
    handle = await startServer({
      port, host, authToken, rpm,
      llmTimeoutMs: timeoutMs,
      approvalTimeoutMs,
    });
  } catch (e: any) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }

  // Keep the process alive. SIGTERM handled inside startServer; SIGINT here.
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.stderr.write('\nshutting down...\n');
      await handle.close();
      resolve();
    };
    process.once('SIGINT', stop);
  });
  return 0;
}
