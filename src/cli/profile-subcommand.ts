/**
 * `koan profile <subcommand>` — manage profiles.
 *
 *   koan profile list                  list all (built-ins + user files)
 *   koan profile show <name>           dump a profile as YAML
 *   koan profile edit <name>           open in $EDITOR (creates if missing)
 *   koan profile where                 print profiles dir
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import {
  BUILTIN_PROFILES, defaultProfilesDir, listAvailableProfiles,
  readProfileFile, profileToYaml, type Profile,
} from './profile.js';

const HELP = `usage: koan profile <subcommand>

Subcommands:
  list                    Show available profiles (built-ins + user files)
  show <name>             Dump a profile as YAML
  edit <name>             Open a profile in $EDITOR (creates a stub if missing)
  where                   Print the profiles directory

Examples:
  koan profile list
  koan profile show coding
  koan profile edit my-agent

Profiles directory:
  $XDG_CONFIG_HOME/koan/profiles or ~/.config/koan/profiles
`;

export async function profileSubcommand(argv: string[]): Promise<number> {
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const dir = defaultProfilesDir();

  switch (sub) {
    case 'list': {
      const names = listAvailableProfiles(dir);
      for (const n of names) {
        const profile = getProfileSafely(n, dir);
        const src = isBuiltin(n) ? 'builtin' : 'user';
        const desc = profile?.description ?? '';
        process.stdout.write(`${n.padEnd(16)} ${src.padEnd(8)} ${desc}\n`);
      }
      return 0;
    }

    case 'show': {
      const name = argv[1];
      if (!name) {
        process.stderr.write('error: `koan profile show` needs a name\n');
        return 2;
      }
      const profile = getProfileSafely(name, dir);
      if (!profile) {
        process.stderr.write(`error: unknown profile "${name}". Try \`koan profile list\`.\n`);
        return 1;
      }
      process.stdout.write(profileToYaml(profile));
      return 0;
    }

    case 'edit': {
      const name = argv[1];
      if (!name) {
        process.stderr.write('error: `koan profile edit` needs a name\n');
        return 2;
      }
      if (!/^[\w.-]+$/.test(name)) {
        process.stderr.write(`error: invalid profile name "${name}"; use letters, digits, _, ., -\n`);
        return 2;
      }
      const filePath = path.join(dir, `${name}.yaml`);
      if (!fs.existsSync(filePath)) {
        // Seed from a built-in if one matches, otherwise a minimal stub.
        const seed = BUILTIN_PROFILES[name] ?? stubProfile(name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, yaml.dump(seed, { lineWidth: 100 }), 'utf8');
      }
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      return new Promise<number>((resolve) => {
        const child = spawn(editor, [filePath], { stdio: 'inherit' });
        child.on('exit', (code) => resolve(code ?? 0));
        child.on('error', (e) => {
          process.stderr.write(`error: failed to launch ${editor}: ${e.message}\n`);
          resolve(1);
        });
      });
    }

    case 'where': {
      process.stdout.write(dir + '\n');
      return 0;
    }

    default:
      process.stderr.write(`unknown profile subcommand: ${sub}\n\n${HELP}`);
      return 2;
  }
}

function isBuiltin(name: string): boolean {
  return name in BUILTIN_PROFILES;
}

function getProfileSafely(name: string, dir: string): Profile | undefined {
  const userFile = path.join(dir, `${name}.yaml`);
  if (fs.existsSync(userFile)) {
    try { return readProfileFile(userFile); } catch { return undefined; }
  }
  return BUILTIN_PROFILES[name];
}

function stubProfile(name: string): Profile {
  return {
    name,
    description: '',
    systemPromptTemplate: 'You are a helpful agent.',
    permissions: ['read'],
    maxRounds: 12,
    acrossConversationMemory: false,
  };
}
