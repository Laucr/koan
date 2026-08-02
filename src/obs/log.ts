/**
 * Structured logging — a single shared pino logger.
 *
 * In CLI mode (TTY stdout/stderr) the default output is pretty-printed.
 * In server mode and CI the default is JSON.
 *
 * Configuration:
 *   KOAN_LOG_LEVEL   trace | debug | info (default) | warn | error | fatal | silent
 *   KOAN_LOG_FORMAT  json | pretty (default: pretty on TTY, json elsewhere)
 *
 * Child loggers carry component names and request ids so log lines are
 * always traceable to a subsystem.
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

let root: Logger | null = null;

export function getLogger(component?: string, extra?: Record<string, unknown>): Logger {
  if (!root) root = createRootLogger();
  if (!component) return root;
  return root.child({ component, ...extra });
}

function createRootLogger(): Logger {
  const level = process.env.KOAN_LOG_LEVEL ?? 'info';
  const explicitFormat = process.env.KOAN_LOG_FORMAT;
  const wantPretty =
    explicitFormat === 'pretty'
    || (explicitFormat !== 'json' && process.stderr.isTTY);

  const baseOpts: LoggerOptions = {
    level,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  // pino-pretty is loaded as a transport when the user wants pretty output.
  if (wantPretty) {
    try {
      const transport = pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: true,
          messageFormat: '{component}{if requestId} ({requestId}){end} {msg}',
        },
      });
      return pino(baseOpts, transport);
    } catch {
      // pino-pretty missing — fall through to JSON.
    }
  }
  // JSON to stderr by default so stdout stays clean for CLI piping.
  return pino(baseOpts, pino.destination({ dest: 2, sync: false }));
}

/** Reset the root logger. Tests use this between cases. */
export function resetLogger(): void {
  root = null;
}
