import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalDigest, resourceKey } from '../../packages/domain/src/identity.js';
import { decodeRecord, encodeRecord } from '../../packages/domain/src/records.js';
import { createFixtures, freezeFixturePlan } from '../support/fixtures.js';
import { checkBoundaries } from '../../scripts/check-boundaries.mjs';

describe('portable resource identity', () => {
  it('folds only DNS and GitHub identity case while preserving display and remote evidence', () => {
    const f = createFixtures();
    const resource = f.resource({ host: 'GITHUB.COM', name: 'Repo' });
    expect(resourceKey(resource)).toBe(
      resourceKey(f.resource({ host: 'github.com', name: 'repo', remoteId: 'new-evidence' })),
    );
    expect(resource.name).toBe('Repo');
    expect(resourceKey(resource)).not.toBe(resourceKey(f.resource({ host: 'github.example' })));
  });
  it.each(['gіthub.com', 'github.com/path', 'https://github.com', '', 'github.com:443'])(
    'rejects ambiguous host %s',
    (host) => {
      const f = createFixtures();
      expect(() => resourceKey(f.resource({ host }))).toThrow();
    },
  );
  it.each(['répo', 'rеpo', '../repo', 'a/b', '', '.', '..', 'repo '])(
    'rejects unsupported resource spelling %s without transliteration',
    (name) => {
      const f = createFixtures();
      expect(() => resourceKey(f.resource({ name }))).toThrow();
    },
  );
  it('does not conflate delimiter-containing local paths with remote repository identities', () => {
    const f = createFixtures();
    expect(() => resourceKey(f.resource({ name: '/Work/Repo' }))).toThrow();
  });
});
describe('canonical JSON digest', () => {
  it('uses portable SHA-256 over deterministic JSON', () => {
    expect(canonicalDigest({ z: 1, a: ['é', true, null] })).toBe(
      canonicalDigest({ a: ['é', true, null], z: 1 }),
    );
    expect(canonicalDigest({ z: 1 })).not.toBe(canonicalDigest({ z: 2 }));
    for (const value of [null, '', 'a'.repeat(200), { a: 1 }, [1, 2, 3]]) {
      expect(canonicalDigest(value)).toBe(
        createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      );
    }
    expect(canonicalDigest(-0)).toBe(canonicalDigest(0));
    expect(canonicalDigest('é')).not.toBe(canonicalDigest('e\u0301'));
  });
  it.each([NaN, Infinity, -Infinity, undefined, new Date(), [undefined], { a: undefined }])(
    'rejects non-JSON input %s',
    (value) => {
      // Exercise untrusted boundary values beyond the compile-time Json type.
      expect(() => canonicalDigest(value as never)).toThrow();
    },
  );
  it('rejects cycles, sparse arrays and symbol keys', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalDigest(cycle as never)).toThrow();
    expect(() => canonicalDigest(new Array(2))).toThrow();
    expect(() => canonicalDigest({ [Symbol('x')]: 1 } as never)).toThrow();
  });
});
describe('record codecs and fixture references', () => {
  it('round-trips every persisted envelope and rejects unsupported versions/malformed payloads', () => {
    const f = createFixtures();
    const records = {
      plan: f.plan(),
      snapshot: f.snapshot(),
      event: f.event(),
      run: f.run(),
      delivery: f.delivery(),
    };
    for (const [kind, value] of Object.entries(records)) {
      const encoded = encodeRecord(kind as keyof typeof records, value);
      expect(
        decodeRecord(kind as keyof typeof records, JSON.parse(JSON.stringify(encoded))),
      ).toEqual(value);
      expect(() =>
        decodeRecord(kind as keyof typeof records, { ...(encoded as object), formatVersion: 2 }),
      ).toThrow();
      expect(() => decodeRecord(kind as keyof typeof records, { formatVersion: 1 })).toThrow();
      expect(() =>
        decodeRecord(kind as keyof typeof records, { ...(encoded as object), unexpected: true }),
      ).toThrow();
    }
    expect(() => encodeRecord('plan', f.plan({ draftRevision: NaN }))).toThrow();
    expect(() => decodeRecord('plan', { ...f.plan(), execution: { formatVersion: 2 } })).toThrow();
  });
  it('freezes fixture semantic inputs explicitly and recomputes composite references', () => {
    const f = createFixtures();
    const initial = f.plan();
    const changed = freezeFixturePlan({ ...initial, resolved: { setting: true } });
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    expect(f.snapshot({ plan: changed.fingerprint }).plan).toBe(changed.fingerprint);
    expect(f.run({ plan: changed.fingerprint }).plan).toBe(changed.fingerprint);
    expect(f.delivery({ plan: changed.fingerprint }).plan).toBe(changed.fingerprint);
    expect(decodeRecord('observation', encodeRecord('observation', f.observation()))).toEqual(
      f.observation(),
    );
  });
});
describe('dependency boundaries', () => {
  it.each([
    ['domain', "import fs = require('node:fs');"],
    ['domain', "import sdk = require('@octokit/rest');"],
    ['domain', "import adapter = require('@github-workspace-manager/adapters-local');"],
    ['domain', "import fixtures = require('../../../tests/support/fixtures.js');"],
    ['application', "import fs = require('node:fs'); export const fileReader = fs.readFileSync;"],
    ['application', "import sdk = require('@octokit/rest');"],
  ])('rejects forbidden import-equals in %s: %s', async (layer, source) => {
    const root = await mkdtemp(join(tmpdir(), 'gwm-import-equals-'));
    try {
      const directory = join(root, 'packages', layer, 'src');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'sample.ts'), source);
      expect(await checkBoundaries(root)).toEqual([expect.stringContaining('forbidden import')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    ['domain', "import records = require('./records.js');"],
    ['application', "import records = require('../../domain/src/records.js');"],
    ['domain', "type T = import('./records.js').Resource;"],
    ['application', "type T = import('./commands.js').Command;"],
    ['application', "type T = import('../../domain/src/records.js').Resource;"],
  ])('allows internal or inward TypeScript dependency in %s: %s', async (layer, source) => {
    const root = await mkdtemp(join(tmpdir(), 'gwm-inward-types-'));
    try {
      const directory = join(root, 'packages', layer, 'src');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'sample.ts'), source);
      expect(await checkBoundaries(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    "type T = import('node:fs').Stats;",
    "type T = import('@octokit/rest').Octokit;",
    "type T = import('../../../tests/support/fixtures.js').Fixtures;",
    'type T = import(providerName).Resource;',
    'import records = require(providerName);',
  ])('rejects forbidden or computed TypeScript dependency: %s', async (source) => {
    const root = await mkdtemp(join(tmpdir(), 'gwm-rejected-types-'));
    try {
      const directory = join(root, 'packages/domain/src');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'sample.ts'), source);
      expect((await checkBoundaries(root)).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects SDK, built-in, outward, alias, dynamic and test imports but allows portable domain dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gwm-boundaries-'));
    try {
      await mkdir(join(root, 'packages/domain/src'), { recursive: true });
      await mkdir(join(root, 'packages/application/src'), { recursive: true });
      const file = join(root, 'packages/domain/src/sample.ts');
      for (const source of [
        "import {Octokit} from '@octokit/rest';",
        "export * from 'node:fs';",
        "import type { X } from '../../application/src/x.js';",
        "const x = import('node:fs');",
        "import '@github-workspace-manager/adapters-local';",
        "import '../../../tests/support/fixtures.js';",
        'const x = import(providerName);',
        "const x = require('fs');",
      ]) {
        await writeFile(file, source);
        expect((await checkBoundaries(root)).length, source).toBeGreaterThan(0);
      }
      await writeFile(
        file,
        "import { sha256 } from '@noble/hashes/sha2.js';\n// import 'node:fs';\n",
      );
      expect(await checkBoundaries(root)).toEqual([]);
      await writeFile(join(root, 'packages/application/src/a.ts'), "import '../tests/fake.js';");
      expect((await checkBoundaries(root)).length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
