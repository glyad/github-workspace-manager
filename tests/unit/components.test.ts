import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundaries } from '../../scripts/check-boundaries.mjs';
import { describe, expect, it } from 'vitest';
import {
  bundledComponents,
  validateComponents,
  renderAssets,
} from '../../packages/components/src/index.js';
import type { Artifact, FieldIntent, Json } from '../../packages/domain/src/records.js';
import type { ArtifactStore } from '../../packages/domain/src/ports.js';
import type { Configuration, Resolved } from '../../packages/domain/src/configuration.js';
import { createFixtures } from '../support/fixtures.js';
import { decodeConfigurationSource } from '../../packages/domain/src/configuration.js';

const f = createFixtures();
const decoded = decodeConfigurationSource({
  id: 'repo',
  kind: 'repository',
  resource: f.resource(),
  location: '.github/workspace.yml',
  ref: 'main',
  revision: 'abc',
  authority: 'remote-ref',
  trust: 'repository',
});
if (!decoded.ok) throw new Error('FIXTURE_SOURCE');
const source = decoded.value;
function configuration(
  fields: Record<string, FieldIntent> = {},
  components: string[] = [],
): Configuration {
  return { formatVersion: 1, resource: f.resource(), fields, components, source };
}
function resolved(fields: Record<string, FieldIntent>): Resolved {
  return {
    resource: f.resource(),
    fields: Object.fromEntries(
      Object.entries(fields).map(([path, intent]) => [path, { intent, source, constraints: [] }]),
    ),
    sources: [source],
    issues: [],
  };
}
const value = (value: Json): FieldIntent => ({ kind: 'value', value });
function store() {
  const bytes = new Map<string, Uint8Array>();
  const artifacts: ArtifactStore = {
    async put(input, mediaType) {
      const digest = createHash('sha256').update(input).digest('hex');
      bytes.set(digest, input.slice());
      return { digest, size: input.length, mediaType };
    },
    async get(ref) {
      const data = bytes.get(ref.digest);
      if (!data) throw new Error('MISSING');
      return data.slice();
    },
  };
  return { bytes, artifacts };
}
const ids = [
  'repository.basic',
  'repository.gitignore',
  'repository.issue-templates',
  'repository.license',
  'repository.local',
  'repository.pr-template',
  'repository.readme',
  'repository.rulesets',
  'repository.workflow',
];

describe('trusted bundled components', () => {
  it('registers exactly the nine approved components with actionable metadata', () => {
    const registry = bundledComponents();
    expect(registry.map((c) => c.id).sort()).toEqual(ids);
    for (const c of registry) {
      expect(c.schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(c.prerequisites).toEqual(expect.any(Array));
      for (const key of [
        'permissions',
        'ownedFields',
        'actions',
        'backupFields',
        'costTriggers',
        'reversalLimits',
      ] as const)
        expect(c[key].length).toBeGreaterThan(0);
    }
  });
  it('gives each semantic field exactly one owner and separates behavior from enforcement', () => {
    const registry = bundledComponents();
    const paths = registry.flatMap((c) => c.ownedFields);
    expect(new Set(paths).size).toBe(paths.length);
    expect(registry.find((c) => c.id === 'repository.workflow')?.ownedFields).toContain(
      'workflow.mergeMethods',
    );
    expect(registry.find((c) => c.id === 'repository.rulesets')?.ownedFields).toContain(
      'rulesets.enforcement',
    );
    expect(
      registry
        .find((c) => c.id === 'repository.rulesets')
        ?.ownedFields.some((p) => p.startsWith('workflow.')),
    ).toBe(false);
  });
  it('cannot mutate the next registry read', () => {
    const c = bundledComponents()[0]!;
    try {
      c.ownedFields.push('malicious.path');
    } catch {
      /* frozen is valid */
    }
    expect(bundledComponents()[0]!.ownedFields).not.toContain('malicious.path');
  });
  it('accepts independent updates on an existing repository without selecting repository.basic', () => {
    expect(
      validateComponents(
        configuration({ 'readme.content': value('# Exact') }, ['repository.readme']),
      ),
    ).toEqual([]);
  });
  it('rejects unknown components', () =>
    expect(validateComponents(configuration({}, ['repository.ci']))).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_COMPONENT' }),
    ));
  it('rejects managed fields outside selected component ownership', () =>
    expect(validateComponents(configuration({ 'readme.content': value('x') }))).toContainEqual(
      expect.objectContaining({ code: 'COMPONENT_NOT_SELECTED' }),
    ));
  it('preserves unknown unmanaged fields without expanding management', () =>
    expect(validateComponents(configuration({ 'future.setting': { kind: 'unmanaged' } }))).toEqual(
      [],
    ));
  it('rejects unknown mutations', () =>
    expect(
      validateComponents(
        configuration({ 'workflow.runCommand': value('x') }, ['repository.workflow']),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COMPONENT_FIELD' })));
  it('does not invent required license details', () =>
    expect(
      validateComponents(
        configuration({ 'license.selection': value({ id: 'MIT' }) }, ['repository.license']),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_COMPONENT_VALUE' })));
  it.each([
    ['basic.visibility', 'invisible'],
    ['basic.description', 3],
    ['local.clone', 'yes'],
    ['workflow.mergeMethods', ['unknown']],
    ['workflow.requiredApprovals', -1],
    ['workflow.signingRequired', 'true'],
    ['rulesets.enforcement', { mergeMethods: 'true' }],
    ['gitignore.templates', ['Unknown']],
  ])('rejects invalid %s values', (path, input) => {
    const component = bundledComponents().find((c) => c.ownedFields.includes(path))!;
    expect(
      validateComponents(configuration({ [path]: value(input as Json) }, [component.id])),
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_COMPONENT_VALUE' }));
  });
  it('validates metadata without executing schema-supplied code', () => {
    expect(
      validateComponents(
        configuration({ 'readme.content': value({ suppliedText: 'README.md', command: 'bad' }) }, [
          'repository.readme',
        ]),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_COMPONENT_VALUE' }));
  });
});

describe('frozen asset recipes', () => {
  it('stores every requested asset as exact bytes with independently verified SHA256', async () => {
    const prose = '# Chosen title\r\n\nשלום 🌍\n';
    const supplied = { prose };
    const fixture = resolved({
      'readme.content': value({ suppliedText: 'prose' }),
      'license.selection': value({ id: 'MIT', year: '2026', holder: 'Example Author' }),
      'gitignore.templates': value(['Node']),
      'issueTemplates.files': value([
        {
          path: '.github/ISSUE_TEMPLATE/bug.md',
          content: '---\nname: Bug\n---\nExact issue prose\n',
        },
      ]),
      'prTemplate.content': value('## Proposed change\nExact PR prose\n'),
    });
    const { artifacts, bytes } = store();
    const result = await renderAssets(fixture, supplied, artifacts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => c.path)).toEqual([
      '.github/ISSUE_TEMPLATE/bug.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.gitignore',
      'LICENSE',
      'README.md',
    ]);
    const output = Object.fromEntries(
      result.value.map((c) => {
        expect(c.after).toBeDefined();
        const artifact = c.after!;
        const data = bytes.get(artifact.digest)!;
        expect(artifact.digest).toBe(createHash('sha256').update(data).digest('hex'));
        expect(artifact.size).toBe(data.length);
        return [c.path, new TextDecoder().decode(data)];
      }),
    );
    expect(output['README.md']).toBe(prose);
    expect(output['.github/PULL_REQUEST_TEMPLATE.md']).toBe('## Proposed change\nExact PR prose\n');
    expect(output['.github/ISSUE_TEMPLATE/bug.md']).toBe(
      '---\nname: Bug\n---\nExact issue prose\n',
    );
    expect(result.value.find((c) => c.path === 'LICENSE')?.after?.digest).toBe(
      '67b53e3340dee5b65e4431674ff654e3e7a40d26325777f20c161585b5f055ef',
    );
    expect(result.value.find((c) => c.path === '.gitignore')?.after?.digest).toBe(
      'dcb0fefb689cd92e1532e3e9dd30ff1d9e2a5a8d36c9878926f9716c3d389d1d',
    );
    expect(output.LICENSE).toContain('Copyright (c) 2026 Example Author');
    expect(output.LICENSE).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(output['.gitignore']).toContain('node_modules/');
    expect(supplied).toEqual({ prose });
    expect(fixture.fields['readme.content']?.intent).toEqual(value({ suppliedText: 'prose' }));
  });
  it('preserves exact explicitly supplied license and ignore text', async () => {
    const { artifacts, bytes } = store();
    const result = await renderAssets(
      resolved({
        'license.content': value({ suppliedText: 'chosenLicense' }),
        'gitignore.content': value('custom\r\n'),
      }),
      { chosenLicense: 'License I explicitly selected\n' },
      artifacts,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((c) => new TextDecoder().decode(bytes.get(c.after!.digest)))).toEqual([
      'custom\r\n',
      'License I explicitly selected\n',
    ]);
  });
  it('never manages omitted, unmanaged or unrelated supplied files', async () => {
    const { artifacts, bytes } = store();
    expect(
      await renderAssets(
        resolved({
          'readme.content': { kind: 'unmanaged' },
          'basic.description': value('only settings'),
        }),
        { 'README.md': 'not selected', 'app.ts': 'unmanaged' },
        artifacts,
      ),
    ).toEqual({ ok: true, value: [] });
    expect(bytes.size).toBe(0);
  });
  it('deletes only explicitly reset fixed assets or explicitly named issue templates', async () => {
    const { artifacts, bytes } = store();
    expect(
      await renderAssets(
        resolved({
          'readme.content': { kind: 'reset' },
          'issueTemplates.files': value([
            { path: '.github/ISSUE_TEMPLATE/old.md', delete: true, beforeDigest: 'a'.repeat(64) },
          ]),
        }),
        {},
        artifacts,
      ),
    ).toEqual({
      ok: true,
      value: [
        { path: '.github/ISSUE_TEMPLATE/old.md', beforeDigest: 'a'.repeat(64) },
        { path: 'README.md' },
      ],
    });
    expect(bytes.size).toBe(0);
  });
  it('refuses unspecified issue-template removals', async () => {
    const { artifacts } = store();
    expect(
      await renderAssets(resolved({ 'issueTemplates.files': { kind: 'reset' } }), {}, artifacts),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'EXPLICIT_PATHS_REQUIRED' })],
    });
  });
  it.each([
    '../README.md',
    '/tmp/file.md',
    '.github/ISSUE_TEMPLATE/../../README.md',
    '.github\\ISSUE_TEMPLATE\\bug.md',
    '.github/ISSUE_TEMPLATE/%2e%2e.md',
    '.github/ISSUE_TEMPLATE/config.yml',
    '.github/ISSUE_TEMPLATE/nested/bug.md',
    '.github/ISSUE_TEMPLATE/bug.md:stream',
    '.github/ISSUE_TEMPLATE/CON.md',
  ])('rejects unsafe or out-of-scope path %s before any artifact storage', async (path) => {
    const { artifacts, bytes } = store();
    expect(
      await renderAssets(
        resolved({
          'readme.content': value('safe'),
          'issueTemplates.files': value([{ path, content: 'x' }]),
        }),
        {},
        artifacts,
      ),
    ).toMatchObject({ ok: false });
    expect(bytes.size).toBe(0);
  });
  it('rejects case-insensitive destination collisions', async () => {
    const { artifacts } = store();
    expect(
      await renderAssets(
        resolved({
          'issueTemplates.files': value([
            { path: '.github/ISSUE_TEMPLATE/Bug.md', content: 'a' },
            { path: '.github/ISSUE_TEMPLATE/bug.md', content: 'b' },
          ]),
        }),
        {},
        artifacts,
      ),
    ).toMatchObject({ ok: false });
  });
  it('rejects competing license recipes', async () => {
    const { artifacts } = store();
    expect(
      await renderAssets(
        resolved({
          'license.content': value('exact'),
          'license.selection': value({ id: 'MIT', year: '2026', holder: 'Author' }),
        }),
        {},
        artifacts,
      ),
    ).toMatchObject({ ok: false });
  });
  it('does not retrieve inherited suppliedText names or invent missing content', async () => {
    const { artifacts } = store();
    expect(
      await renderAssets(
        resolved({ 'readme.content': value({ suppliedText: 'toString' }) }),
        {},
        artifacts,
      ),
    ).toMatchObject({ ok: false });
  });
  it('fails closed on blocking resolved issues', async () => {
    const { artifacts, bytes } = store();
    const input = resolved({ 'readme.content': value('x') });
    input.issues = [{ code: 'POLICY_CONFLICT', blocking: true, message: 'blocked' }];
    expect(await renderAssets(input, {}, artifacts)).toMatchObject({ ok: false });
    expect(bytes.size).toBe(0);
  });
  it('does not trust a store that returns a false digest, size, media type or unreadable bytes', async () => {
    for (const bad of ['digest', 'size', 'mediaType', 'readback'] as const) {
      const { artifacts } = store();
      const broken: ArtifactStore = {
        async put(bytes, mediaType) {
          const ref = await artifacts.put(bytes, mediaType);
          return {
            ...ref,
            ...(bad === 'digest'
              ? { digest: '0'.repeat(64) }
              : bad === 'size'
                ? { size: 0 }
                : bad === 'mediaType'
                  ? { mediaType: 'application/bad' }
                  : {}),
          };
        },
        async get(ref) {
          return bad === 'readback' ? new Uint8Array([0]) : artifacts.get(ref);
        },
      };
      expect(
        await renderAssets(resolved({ 'readme.content': value('x') }), {}, broken),
      ).toMatchObject({ ok: false });
    }
  });
  it('reports store failures instead of returning changes that are not frozen', async () => {
    const artifacts: ArtifactStore = {
      async put(): Promise<Artifact> {
        throw new Error('secret transport details');
      },
      async get() {
        throw new Error('unused');
      },
    };
    expect(
      await renderAssets(resolved({ 'readme.content': value('x') }), {}, artifacts),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'ARTIFACT_FREEZE_FAILED' })],
    });
  });
  it('is deterministic across field ordering', async () => {
    const a = { 'readme.content': value('a'), 'prTemplate.content': value('b') };
    const b = Object.fromEntries(Object.entries(a).reverse());
    expect(await renderAssets(resolved(a), {}, store().artifacts)).toEqual(
      await renderAssets(resolved(b), {}, store().artifacts),
    );
  });
});

describe('component portability and hostile input boundaries', () => {
  it.each([
    "import 'node:fs';",
    "import '../../application/src/configuration.js';",
    "import '../../adapters-local/src/yaml-source.js';",
    "import '@github-workspace-manager/runtime';",
  ])('forbids outward component dependency %s', async (source) => {
    const root = await mkdtemp(join(tmpdir(), 'gwm-component-boundary-'));
    try {
      await mkdir(join(root, 'packages/components/src'), { recursive: true });
      await writeFile(join(root, 'packages/components/src/sample.ts'), source);
      expect(await checkBoundaries(root)).toEqual([expect.stringContaining('forbidden import')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('accepts portable domain, own module and bundled JSON imports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gwm-component-inward-'));
    try {
      await mkdir(join(root, 'packages/components/src'), { recursive: true });
      await writeFile(
        join(root, 'packages/components/src/sample.ts'),
        "import '../../domain/src/records.js'; import './schemas.js'; import '../assets/licenses.json' with {type:'json'};",
      );
      expect(await checkBoundaries(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('validates resource identity even when no assets are selected', async () => {
    const input = resolved({});
    input.resource.name = '..';
    expect(await renderAssets(input, {}, store().artifacts)).toMatchObject({ ok: false });
  });
  it.each(['.', '..', 'has space', 'contains/slash'])(
    'rejects invalid requested repository name %s',
    (name) => {
      expect(
        validateComponents(configuration({ 'basic.name': value(name) }, ['repository.basic'])),
      ).toContainEqual(expect.objectContaining({ code: 'INVALID_COMPONENT_VALUE' }));
    },
  );
  it('does not select a license or ignore template for empty configuration', async () => {
    expect(
      validateComponents(configuration({}, ['repository.license', 'repository.gitignore'])),
    ).toEqual([]);
    expect(await renderAssets(resolved({}), {}, store().artifacts)).toEqual({
      ok: true,
      value: [],
    });
  });
  it.each(['inline', 'supplied'] as const)(
    'preserves leading BOM, CRLF and non-ASCII UTF-8 bytes from %s text',
    async (mode) => {
      const prose = '\uFEFF# Exact\r\nשלום 🌍\n';
      const expected = Buffer.from(prose, 'utf8');
      expect([...expected.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const { artifacts } = store();
      const input = mode === 'inline' ? prose : { suppliedText: 'prose' };
      const result = await renderAssets(
        resolved({ 'readme.content': value(input) }),
        mode === 'supplied' ? { prose } : {},
        artifacts,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      const artifact = result.value[0]!.after!;
      expect(artifact).toEqual({
        digest: createHash('sha256').update(expected).digest('hex'),
        size: expected.length,
        mediaType: 'text/plain; charset=utf-8',
      });
      expect(await artifacts.get(artifact)).toEqual(new Uint8Array(expected));
    },
  );

  it('rejects invalid Unicode rather than silently replacing supplied bytes', async () => {
    const { artifacts, bytes } = store();
    expect(
      await renderAssets(resolved({ 'readme.content': value('lone \ud800') }), {}, artifacts),
    ).toMatchObject({ ok: false });
    expect(bytes.size).toBe(0);
  });
  it('captures all text before asynchronous persistence can mutate caller values', async () => {
    const supplied = { prose: 'original' };
    const input = resolved({
      'readme.content': value({ suppliedText: 'prose' }),
      'prTemplate.content': value('first'),
    });
    const { artifacts, bytes } = store();
    const changing: ArtifactStore = {
      async put(data, mediaType) {
        supplied.prose = 'changed';
        input.fields['readme.content']!.intent = value('changed');
        return artifacts.put(data, mediaType);
      },
      get: artifacts.get,
    };
    const result = await renderAssets(input, supplied, changing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      new TextDecoder().decode(
        bytes.get(result.value.find((c) => c.path === 'README.md')!.after!.digest),
      ),
    ).toBe('original');
  });
  it('rejects a mutating artifact store without returning a misleading plan', async () => {
    const { artifacts } = store();
    const mutating: ArtifactStore = {
      async put(data, mediaType) {
        data[0] = 0;
        return artifacts.put(data, mediaType);
      },
      get: artifacts.get,
    };
    expect(
      await renderAssets(resolved({ 'readme.content': value('exact') }), {}, mutating),
    ).toMatchObject({ ok: false });
  });
  it('rejects malformed intent enums at the runtime boundary', () => {
    const input = configuration({ 'readme.content': value('a') }, ['repository.readme']);
    (input.fields['readme.content'] as unknown as { kind: unknown }).kind = ['value'];
    expect(validateComponents(input)).toContainEqual(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
  });
});
