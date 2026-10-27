import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  runAuthCheck,
  withReviewerApp,
  safeAuthError,
  appRequest,
} from '../../tools/governance/reviewer-app-auth.mjs';

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
function fixture(change = () => {}, options = {}) {
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
    masks = [],
    diagnostics = [];
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
    diagnostics,
    run: () =>
      (options.profile ? withReviewerApp : runAuthCheck)({
        ...options,
        privateKey: pem,
        now: () => Date.parse('2026-10-27T00:00:00Z'),
        fetchImpl,
        mask: (s) => masks.push(s),
        diagnostic: (s) => diagnostics.push(s),
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

for (const [index, phase] of [
  [0, 'app'],
  [1, 'installation'],
]) {
  test(`diagnoses ${phase} HTTP failure without exposing response or credentials`, async () => {
    const f = fixture((v) => {
      v[index] = new Response(pem + token, { status: 401 });
    });
    await assert.rejects(f.run(), (error) => {
      assert.equal(error.message, `${phase}: HTTP 401`);
      assert.ok(!error.message.includes(pem) && !error.message.includes(token));
      return true;
    });
    assert.equal(f.calls.length, index + 1);
  });
}

test('emits mathematically correct public SPKI fingerprint before first API call', async () => {
  const diagnostics = [],
    masks = [];
  const expected =
    'Public key fingerprint SHA256:' +
    createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
  await assert.rejects(
    runAuthCheck({
      privateKey: pem,
      diagnostic: (value) => diagnostics.push(value),
      mask: (value) => masks.push(value),
      fetchImpl: async () => {
        assert.deepEqual(diagnostics, [expected]);
        throw new Error(pem + token);
      },
    }),
  );
  assert.deepEqual(diagnostics, [expected]);
  assert.equal(masks.length, 1);
  assert.ok(!diagnostics.join('').includes(pem) && !diagnostics.join('').includes(masks[0]));
});

for (const [index, phase] of [
  [0, 'app'],
  [1, 'installation'],
]) {
  for (const [kind, response, expected] of [
    ['transport', () => new Error(pem + token), `${phase}: transport failure`],
    ['parse', () => new Response(pem + token), `${phase}: parse failure (HTTP 200)`],
    [
      'read',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(pem + token));
            },
          }),
        ),
      `${phase}: read failure (HTTP 200)`,
    ],
    [
      'redirect',
      () => new Response(pem + token, { status: 302 }),
      `${phase}: redirect rejected (HTTP 302)`,
    ],
    [
      'limit',
      () => new Response('a'.repeat(65537)),
      `${phase}: response limit exceeded (HTTP 200)`,
    ],
  ]) {
    test(`safe ${phase} ${kind} diagnostics preserve phase and status`, async () => {
      const f = fixture((v) => {
        v[index] = response();
      });
      await assert.rejects(f.run(), (error) => {
        assert.equal(error.message, expected);
        assert.equal(safeAuthError(error), expected);
        assert.ok(!JSON.stringify(error).includes(pem));
        assert.ok(!error.stack.includes(token));
        for (const credential of [pem, token, ...f.masks]) {
          assert.ok(!f.diagnostics.join('').includes(credential));
          assert.ok(!safeAuthError(error).includes(credential));
        }
        return true;
      });
      assert.equal(f.calls.length, index + 1);
    });
  }
}

test('invalid untrusted status is never copied into diagnostic output', async () => {
  const response = new Response(token);
  Object.defineProperty(response, 'status', { value: token });
  const f = fixture((v) => {
    v[0] = response;
  });
  await assert.rejects(f.run(), (error) => {
    assert.equal(safeAuthError(error), 'app: response failure');
    return true;
  });
});

test('CLI error mapper rejects arbitrary exceptions and spoofed diagnostic properties', () => {
  const error = new Error(pem + token);
  error.phase = 'app';
  error.status = 401;
  assert.equal(safeAuthError(error), 'Authentication check failed');
  assert.equal(
    safeAuthError({ message: token, name: 'AuthCheckError' }),
    'Authentication check failed',
  );
});

test('issuance and cleanup failures retain safe diagnostics without changing uncertainty or retry policy', async () => {
  const issuance = fixture((v) => {
    v[2] = new Response(pem + token, { status: 403 });
  });
  await assert.rejects(issuance.run(), (error) => {
    assert.equal(
      safeAuthError(error),
      'Token issuance uncertain; no usable token received for revocation [token-issuance: HTTP 403]',
    );
    return true;
  });
  assert.equal(issuance.calls.length, 3);
  const cleanup = fixture((v) => {
    v[3] = new Response(token, { status: 500 });
    v[4] = 403;
  });
  await assert.rejects(cleanup.run(), (error) => {
    assert.equal(
      safeAuthError(error),
      'Installation read failed; token revocation failed [repository-read: HTTP 500; token-revocation: HTTP 403]',
    );
    return true;
  });
  assert.equal(cleanup.calls.length, 5);
  assert.equal(cleanup.calls.at(-1).method, 'DELETE');
});

test('key rotation changes public diagnostic without a source pin', async () => {
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotatedPem = rotated.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const diagnostics = [],
    masks = [];
  await assert.rejects(
    runAuthCheck({
      privateKey: rotatedPem,
      diagnostic: (value) => diagnostics.push(value),
      mask: (value) => masks.push(value),
      fetchImpl: async () => {
        throw new Error('offline');
      },
    }),
    /app: transport failure/,
  );
  const fingerprint = createHash('sha256')
    .update(rotated.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  assert.deepEqual(diagnostics, [`Public key fingerprint SHA256:${fingerprint}`]);
  assert.notEqual(
    fingerprint,
    createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64'),
  );
  for (const credential of [rotatedPem, pem, token, ...masks])
    assert.ok(!diagnostics.join('').includes(credential));
});

test('write profile reuses pinned auth and revokes even when operation fails', async () => {
  let called = false;
  const f = fixture(
    (values) => {
      values[2].permissions = granted;
    },
    {
      profile: 'publish',
      operation: async () => {
        called = true;
        throw Error('raw sensitive callback');
      },
    },
  );
  await assert.rejects(f.run(), /Installation read failed/);
  assert.equal(called, true);
  assert.equal(JSON.parse(f.calls[2].body).permissions.pull_requests, 'write');
  assert.equal(f.calls.at(-1).method, 'DELETE');
});
test('publication result survives cleanup failure without a duplicate operation', async () => {
  const receipt = { state: 'verified', nativeId: 88 };
  const f = fixture(
    (values) => {
      values[2].permissions = granted;
      values[4] = 500;
    },
    { profile: 'publish', operation: async () => receipt },
  );
  await assert.rejects(
    f.run(),
    (error) => error.result === receipt && safeAuthError(error).includes('Token revocation failed'),
  );
  assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 1);
});

test('fixed publication response profile remains bounded and rejects arbitrary response profiles', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({ text: 'x'.repeat(2 * 1024 * 1024) });
  };
  await assert.rejects(
    appRequest(
      fetchImpl,
      'GET',
      '/repos/glyad/github-workspace-manager/compare/a...b',
      'synthetic-token',
      null,
      200,
      'publication',
      'publication',
    ),
    (error) => safeAuthError(error) === 'publication: response limit exceeded (HTTP 200)',
  );
  assert.equal(calls, 1);
  await assert.rejects(
    appRequest(fetchImpl, 'GET', '/app', 'synthetic-token', null, 200, 'publication', 'unbounded'),
    /Invalid response profile/,
  );
  assert.equal(calls, 1);
});
