import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runAuthCheck } from '../../tools/governance/reviewer-app-auth.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const granted = { contents: 'read', metadata: 'read', pull_requests: 'write' };
const readonly = { contents: 'read', metadata: 'read', pull_requests: 'read' };
const repo = {
  id: 1427426748,
  full_name: 'glyad/github-workspace-manager',
  owner: { id: 4238205, login: 'glyad' },
};
const token = 'future-format.' + 'a'.repeat(170);
function fixture(change = () => {}) {
  const values = [
    {
      id: 5487224,
      client_id: 'Iv23ctaEdWaFhBYqhbZg',
      slug: 'glyad-workspace-reviewer',
      owner: { id: 4238205, login: 'glyad' },
      permissions: granted,
    },
    {
      id: 175625005,
      app_id: 5487224,
      app_slug: 'glyad-workspace-reviewer',
      account: { id: 4238205, login: 'glyad' },
      repository_selection: 'selected',
      permissions: granted,
      suspended_at: null,
      suspended_by: null,
    },
    {
      token,
      expires_at: '2026-10-27T01:00:00Z',
      repository_selection: 'selected',
      permissions: readonly,
      repositories: [repo],
    },
    { total_count: 1, repositories: [repo] },
  ];
  change(values);
  const calls = [],
    masks = [];
  const fetchImpl = async (url, init) => {
    const index = calls.length;
    calls.push({ url, ...init });
    if (init.method === 'DELETE') return new Response(null, { status: values[4] ?? 204 });
    const value = values[index];
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return Response.json(value, { status: index === 2 ? 201 : 200 });
  };
  return {
    calls,
    masks,
    run: () =>
      runAuthCheck({
        privateKey: pem,
        now: () => Date.parse('2026-10-27T00:00:00Z'),
        fetchImpl,
        mask: (s) => masks.push(s),
      }),
  };
}

test('signs RS256 claims, downscopes, independently reads and revokes before success', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), {
    appId: 5487224,
    installationId: 175625005,
    repositoryId: 1427426748,
    permissions: readonly,
    revoked: true,
  });
  const jwt = f.calls[0].headers.Authorization.slice(7);
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iat: 1793059140,
    exp: 1793059740,
    iss: 'Iv23ctaEdWaFhBYqhbZg',
  });
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
  assert.deepEqual(JSON.parse(f.calls[2].body), {
    repository_ids: [1427426748],
    permissions: { contents: 'read', pull_requests: 'read' },
  });
  assert.deepEqual(
    f.calls.map((c) => [c.method, new URL(c.url).pathname]),
    [
      ['GET', '/app'],
      ['GET', '/app/installations/175625005'],
      ['POST', '/app/installations/175625005/access_tokens'],
      ['GET', '/installation/repositories'],
      ['DELETE', '/installation/token'],
    ],
  );
  assert.deepEqual(f.masks, [jwt, token]);
  for (const c of f.calls) {
    assert.equal(new URL(c.url).origin, 'https://api.github.com');
    assert.equal(c.redirect, 'error');
    assert.ok(c.signal instanceof AbortSignal);
  }
});

for (const [name, change, count] of [
  [
    'wrong App',
    (v) => {
      v[0].id++;
    },
    1,
  ],
  [
    'wrong owner',
    (v) => {
      v[0].owner.id++;
    },
    1,
  ],
  [
    'wrong client',
    (v) => {
      v[0].client_id = 'other';
    },
    1,
  ],
  [
    'extra App permission',
    (v) => {
      v[0].permissions = { ...granted, issues: 'write' };
    },
    1,
  ],
  [
    'wrong installation',
    (v) => {
      v[1].id++;
    },
    2,
  ],
  [
    'all repositories',
    (v) => {
      v[1].repository_selection = 'all';
    },
    2,
  ],
  [
    'suspended',
    (v) => {
      v[1].suspended_at = 'today';
    },
    2,
  ],
  [
    'write scope returned',
    (v) => {
      v[2].permissions = granted;
    },
    4,
  ],
  [
    'wrong minted repository',
    (v) => {
      v[2].repositories = [{ ...repo, id: 1 }];
    },
    4,
  ],
  [
    'wrong readback',
    (v) => {
      v[3].repositories = [{ ...repo, id: 1 }];
    },
    5,
  ],
  [
    'extra readback repository',
    (v) => {
      v[3].total_count = 2;
    },
    5,
  ],
  [
    'read failure',
    (v) => {
      v[3] = new Error('secret API exception');
    },
    5,
  ],
  [
    'redirect',
    (v) => {
      v[0] = new Response('secret', { status: 302, headers: { Location: 'https://evil.example' } });
    },
    1,
  ],
  [
    'API error',
    (v) => {
      v[0] = new Response(pem + token, { status: 403 });
    },
    1,
  ],
  [
    'oversized response',
    (v) => {
      v[0] = new Response('a'.repeat(65537));
    },
    1,
  ],
  [
    'invalid JSON',
    (v) => {
      v[0] = new Response('secret invalid json');
    },
    1,
  ],
  [
    'uncertain issuance',
    (v) => {
      v[2] = new Error(pem + token);
    },
    3,
  ],
  [
    'failed revocation',
    (v) => {
      v[4] = 500;
    },
    5,
  ],
]) {
  test(`fails closed: ${name}`, async () => {
    const f = fixture(change);
    await assert.rejects(f.run(), (e) => {
      assert.ok(
        !e.message.includes(pem) && !e.message.includes(token) && !e.message.includes('secret'),
      );
      if (name === 'uncertain issuance') assert.match(e.message, /issuance uncertain/);
      if (name === 'failed revocation') assert.match(e.message, /revocation failed/);
      return true;
    });
    assert.equal(f.calls.length, count);
    if (count >= 4) assert.equal(f.calls.at(-1).method, 'DELETE');
  });
}

test('invalid key has a safe error before HTTP', async () => {
  await assert.rejects(runAuthCheck({ privateKey: 'private-key-marker' }), /JWT creation failed/);
});

test('manual workflow admits only trusted main and exposes secret only to probe', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/reviewer-app-auth.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github.repository == 'glyad\/github-workspace-manager'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: 24.19.0/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /pull_request:|push:|schedule:|npm |upload-artifact|inputs:/);
});

test('returned credential is revoked even with invalid expiry or missing restrictions', async () => {
  for (const change of [
    (v) => {
      v[2].expires_at = 'expired';
    },
    (v) => {
      delete v[2].permissions;
    },
    (v) => {
      v[2].repository_selection = 'all';
    },
  ]) {
    const f = fixture(change);
    await assert.rejects(f.run(), /Token restrictions mismatch/);
    assert.equal(f.calls.at(-1).method, 'DELETE');
    assert.equal(f.calls.at(-1).headers.Authorization, `Bearer ${token}`);
    assert.equal(f.masks.at(-1), token);
  }
});

test('both read failure and revocation failure remain visible', async () => {
  const f = fixture((v) => {
    v[3] = new Error('private exception');
    v[4] = 500;
  });
  await assert.rejects(f.run(), /Installation read failed; token revocation failed/);
  assert.equal(f.calls.length, 5);
});

test('metadata read may be implicit in token restrictions', async () => {
  const f = fixture((v) => {
    v[2].permissions = { contents: 'read', pull_requests: 'read' };
  });
  assert.equal((await f.run()).revoked, true);
});

test('no credentials reach public logs or success summary', async () => {
  const output = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => output.push(...args);
  console.error = (...args) => output.push(...args);
  try {
    const f = fixture();
    const summary = await f.run();
    assert.deepEqual(output, []);
    assert.ok(!JSON.stringify(summary).includes(token));
    const failed = fixture((v) => {
      v[3] = new Error(pem + token);
    });
    await assert.rejects(failed.run(), /Installation read failed/);
    assert.deepEqual(output, []);
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
});
