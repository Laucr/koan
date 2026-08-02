/**
 * Tiny argv parser. Avoids pulling in a dependency for the few flags we have.
 *
 * Recognises:
 *   - bare positional arguments (e.g. the prompt)
 *   - --flag value
 *   - --flag=value
 *   - --boolean (no value, sets to true)
 *   - -h / --help (handled by the caller)
 */
export interface ParsedArgv {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // everything after is positional
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // short flag, treat same as long
      flags[a.slice(1)] = true;
      continue;
    }
    positional.push(a);
  }

  return { positional, flags };
}

export function flagAsString(parsed: ParsedArgv, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = parsed.flags[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export function flagAsBool(parsed: ParsedArgv, ...keys: string[]): boolean {
  for (const k of keys) if (parsed.flags[k] === true) return true;
  return false;
}

export function flagAsNumber(parsed: ParsedArgv, ...keys: string[]): number | undefined {
  const v = flagAsString(parsed, ...keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Flag --${keys[0]} must be a number, got "${v}"`);
  return n;
}
