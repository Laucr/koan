/**
 * M5 tests — profile schema, resolution precedence, built-ins, effective config.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import {
  ProfileSchema,
  BUILTIN_PROFILES,
  resolveProfile,
  readProfileFile,
  listAvailableProfiles,
  profileToYaml,
} from '../src/cli/profile.js';
import { buildEffectiveConfig } from '../src/cli/effective.js';

let scratch: string;
let projectDir: string;
let profilesDir: string;

beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m5-'));
  projectDir = path.join(scratch, 'project');
  profilesDir = path.join(scratch, 'profiles');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(profilesDir, { recursive: true });
});

// ── Schema ──────────────────────────────────────────────────────────────

describe('ProfileSchema', () => {
  it('accepts a minimal profile (just `name`)', () => {
    expect(() => ProfileSchema.parse({ name: 'tiny' })).not.toThrow();
  });
  it('defaults permissions to []', () => {
    const p = ProfileSchema.parse({ name: 'x' });
    expect(p.permissions).toEqual([]);
  });
  it('rejects unknown keys (strict)', () => {
    expect(() => ProfileSchema.parse({ name: 'x', randomKey: 1 })).toThrow();
  });
  it('rejects invalid permission values', () => {
    expect(() => ProfileSchema.parse({ name: 'x', permissions: ['nope'] })).toThrow();
  });
  it('rejects invalid provider values', () => {
    expect(() => ProfileSchema.parse({ name: 'x', provider: 'mystery' })).toThrow();
  });
});

// ── Built-ins ───────────────────────────────────────────────────────────

describe('BUILTIN_PROFILES', () => {
  it('all four ship and validate', () => {
    for (const key of ['default', 'coding', 'research', 'strict']) {
      const p = BUILTIN_PROFILES[key];
      expect(p).toBeDefined();
      expect(() => ProfileSchema.parse(p)).not.toThrow();
      expect(p.name).toBe(key);
    }
  });
  it('strict has no tools', () => {
    expect(BUILTIN_PROFILES.strict.tools).toEqual([]);
    expect(BUILTIN_PROFILES.strict.permissions).toEqual([]);
  });
  it('coding has write + shell', () => {
    expect(BUILTIN_PROFILES.coding.permissions).toContain('write');
    expect(BUILTIN_PROFILES.coding.permissions).toContain('shell');
  });
  it('research has network', () => {
    expect(BUILTIN_PROFILES.research.permissions).toContain('network');
  });
});

// ── Resolution precedence ───────────────────────────────────────────────

describe('resolveProfile precedence', () => {
  it('flag wins over env wins over project wins over builtin', async () => {
    // Write a user profile and a project profile.
    const userFile = path.join(profilesDir, 'coding.yaml');
    await fs.writeFile(userFile, yaml.dump({
      ...BUILTIN_PROFILES.coding,
      description: 'user-installed coding',
    }));
    const projectFile = path.join(projectDir, '.koan.yaml');
    await fs.writeFile(projectFile, yaml.dump({
      name: 'project-pinned',
      description: 'this project pins its own profile',
      permissions: ['read'],
    }));

    // 1. no flag, no env → project file wins
    const r1 = resolveProfile({ cwd: projectDir, profilesDir, env: {} });
    expect(r1.source).toBe('project-file');
    expect(r1.name).toBe('project-pinned');

    // 2. env wins over project
    const r2 = resolveProfile({ cwd: projectDir, profilesDir, env: { KOAN_PROFILE: 'coding' } });
    expect(r2.source).toBe('env');
    expect(r2.name).toBe('coding');
    expect(r2.profile.description).toBe('user-installed coding'); // user file beat the built-in
    expect(r2.filePath).toBe(userFile);

    // 3. flag wins over env
    const r3 = resolveProfile({ flag: 'research', cwd: projectDir, profilesDir, env: { KOAN_PROFILE: 'coding' } });
    expect(r3.source).toBe('flag');
    expect(r3.name).toBe('research');
    expect(r3.filePath).toBeUndefined(); // built-in, no file
  });

  it('falls back to "default" built-in when nothing is set', async () => {
    // Use an empty dir with no project file and no profiles dir.
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'koan-m5-empty-'));
    const emptyProfiles = path.join(emptyDir, 'no-profiles');
    const r = resolveProfile({ cwd: emptyDir, profilesDir: emptyProfiles, env: {} });
    expect(r.source).toBe('builtin');
    expect(r.name).toBe('default');
  });

  it('throws with a useful message on unknown profile name', () => {
    expect(() => resolveProfile({ flag: 'nope', profilesDir, env: {} })).toThrow(/Unknown profile/);
  });

  it('warns on filename/name mismatch', async () => {
    const file = path.join(profilesDir, 'mismatch.yaml');
    await fs.writeFile(file, yaml.dump({ name: 'wrong-name', description: '' }));
    expect(() => resolveProfile({ flag: 'mismatch', profilesDir, env: {} })).toThrow(/does not match the filename/);
  });
});

// ── readProfileFile / listAvailableProfiles ────────────────────────────

describe('readProfileFile + listAvailableProfiles', () => {
  it('readProfileFile reports useful errors for bad YAML / shape', async () => {
    const bad = path.join(scratch, 'broken.yaml');
    await fs.writeFile(bad, '{ this is: not [ valid');
    expect(() => readProfileFile(bad)).toThrow(/Failed to parse/);
  });
  it('readProfileFile reports schema issues with paths', async () => {
    const bad = path.join(scratch, 'badshape.yaml');
    await fs.writeFile(bad, yaml.dump({ name: 'x', permissions: ['weird'] }));
    expect(() => readProfileFile(bad)).toThrow(/Invalid profile/);
  });
  it('listAvailableProfiles includes built-ins and user files', async () => {
    const userFile = path.join(profilesDir, 'mine.yaml');
    await fs.writeFile(userFile, yaml.dump({ name: 'mine' }));
    const names = listAvailableProfiles(profilesDir);
    expect(names).toContain('default');
    expect(names).toContain('coding');
    expect(names).toContain('mine');
  });
});

// ── profileToYaml roundtrip ────────────────────────────────────────────

describe('profileToYaml', () => {
  it('reparses to the same shape', () => {
    const y = profileToYaml(BUILTIN_PROFILES.coding);
    const reparsed = ProfileSchema.parse(yaml.load(y));
    expect(reparsed.name).toBe('coding');
    expect(reparsed.permissions).toEqual(BUILTIN_PROFILES.coding.permissions);
  });
});

// ── buildEffectiveConfig ───────────────────────────────────────────────

describe('buildEffectiveConfig', () => {
  it('defaults to full toolkit when profile.tools is undefined', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.default, approveMode: 'none',
    });
    expect(eff.toolNames.length).toBeGreaterThan(0);
    expect(eff.toolNames).toContain('submit_final_answer');
  });

  it('strict profile produces zero tools', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.strict, approveMode: 'none',
    });
    expect(eff.toolNames).toEqual([]);
    expect(eff.permissions.size).toBe(0);
  });

  it('--auto-approve safe adds network on top of the profile', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.default, approveMode: 'safe',
    });
    expect(eff.permissions.has('network')).toBe(true);
    expect(eff.permissions.has('read')).toBe(true);
    expect(eff.permissions.has('write')).toBe(false); // not 'all'
  });

  it('--auto-approve all grants everything', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.default, approveMode: 'all',
    });
    for (const p of ['read', 'write', 'shell', 'network'] as const) {
      expect(eff.permissions.has(p)).toBe(true);
    }
  });

  it('flags add to profile permissions but do not remove them', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.coding, // already has write+shell+read
      approveMode: 'none',
      allowNetwork: true,
    });
    expect(eff.permissions.has('read')).toBe(true);
    expect(eff.permissions.has('write')).toBe(true);
    expect(eff.permissions.has('shell')).toBe(true);
    expect(eff.permissions.has('network')).toBe(true);
  });

  it('--no-tools forces empty even on coding profile', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.coding, approveMode: 'all', noTools: true,
    });
    expect(eff.toolNames).toEqual([]);
  });

  it('max-rounds override beats profile.maxRounds', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.coding, approveMode: 'none', maxRoundsOverride: 3,
    });
    expect(eff.maxRounds).toBe(3);
  });

  it('uses profile.maxRounds when no override', () => {
    const eff = buildEffectiveConfig({
      profile: BUILTIN_PROFILES.coding, approveMode: 'none',
    });
    expect(eff.maxRounds).toBe(BUILTIN_PROFILES.coding.maxRounds);
  });
});
