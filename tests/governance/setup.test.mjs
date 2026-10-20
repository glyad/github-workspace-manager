import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightSetup, openSetupSession, authorizeSetupPath, closeSetupSession, reconcileRepositoryCreation } from '../../tools/governance/setup.mjs';
import { inspectDestination, createReadOnlyGitHubPort, probeExistingSigning } from '../../tools/governance/github.mjs';

const desired = JSON.parse(await readFile(new URL('../../governance/repository.json', import.meta.url)));
function observation(overrides = {}) {
  return { host: 'github.com', actor: { login: 'glyad', id: 'U_1' }, protocol: 'https',
    repository: { exists: false, fullName: 'glyad/github-workspace-manager', id: null },
    destination: { path: desired.destination, state: 'absent', safeAncestors: true },
    signing: { localVerified: true, githubAssociationVerified: true, fingerprint: 'existing-fingerprint' },
    project: { authorized: true, scopeVerified: true, matches: [] },
    rules: { supported: true, revision: 'r1', effective: [] },
    evidence: [{ source: 'test-observer', actorId: 'U_1', observedAt: new Date().toISOString(), resourceId: desired.fullName }],
    ...overrides };
}
function port(value) { return { observeSetup: async () => ({ kind: 'verified', value, evidence: value.evidence }) }; }
async function snapshot() { return (await preflightSetup(port(observation({ repository: { exists: true, fullName: desired.fullName, id: 'R_1' } })), desired)).value; }
const evidenceFor = (resourceId, actorId = 'U_1') => [{ ...observation().evidence[0], resourceId, actorId }];
const persisted = async (_, row) => ({ kind: 'verified', value: row, evidence: evidenceFor(row.operationId) });

test('preflight accepts observed eligible maintainer without mutating remote state', async () => {
  assert.equal((await preflightSetup(port(observation()), desired)).kind, 'verified');
});
for (const [name, change, reason] of [
  ['wrong account', { actor: { login: 'other', id: 'U_2' } }, /account/],
  ['wrong repository', { repository: { exists: true, fullName: 'other/repo', id: 'R_2' } }, /repository/],
  ['wrong destination', { destination: { path: '/tmp/wrong', state: 'absent', safeAncestors: true } }, /destination/],
  ['nonempty destination', { destination: { path: desired.destination, state: 'nonempty', safeAncestors: true } }, /destination/],
  ['missing signing', { signing: { localVerified: false, githubAssociationVerified: false } }, /signing/],
  ['untrusted signing association', { signing: { localVerified: true, githubAssociationVerified: false } }, /signing/],
  ['missing project scope', { project: { authorized: false, scopeVerified: false, matches: [] } }, /Project/],
  ['duplicate Project name', { project: { authorized: true, scopeVerified: true, matches: [{ id: 'P1' }, { id: 'P2' }] } }, /Project/],
  ['missing evidence', { evidence: [] }, /evidence/],
]) test(`preflight blocks ${name}`, async () => {
  const result = await preflightSetup(port(observation(change)), desired);
  assert.equal(result.kind, 'blocked'); assert.match(result.reason, reason);
});

test('unknown remote state does not become verified absence', async () => {
  const result = await preflightSetup({ observeSetup: async () => ({ kind: 'uncertain', reason: 'network', evidence: [] }) }, desired);
  assert.equal(result.kind, 'uncertain');
});
test('session needs actual repository ID and same already authenticated actor', async () => {
  const absent = (await preflightSetup(port(observation()), desired)).value;
  assert.equal(openSetupSession(absent, ['README.md'], { login: 'glyad', id: 'U_1' }).kind, 'blocked');
  assert.equal(openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'different' }).kind, 'blocked');
});
test('setup scope rejects product paths and traversal before granting a session', async () => {
  for (const path of ['packages/plugin/index.ts', '../README.md', '/README.md', 'sources/a', 'AGENTS.md']) {
    assert.equal(openSetupSession(await snapshot(), [path], { login: 'glyad', id: 'U_1' }).kind, 'blocked');
  }
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  assert.equal(authorizeSetupPath(session, 'README.md').kind, 'verified');
  assert.equal(authorizeSetupPath(session, 'SECURITY.md').kind, 'blocked');
});
test('failed restoration keeps session open and ordinary work blocked', async () => {
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  const journal = [];
  const result = await closeSetupSession({ appendJournal: async (key, row) => { journal.push(row); return persisted(key, row); },
    restoreSetupProtections: async () => ({ kind: 'uncertain', reason: 'timeout', evidence: [] }),
    observeProtections: async () => ({ kind: 'verified', value: { repositoryId: 'R_1', temporaryBypassAbsent: false, mainForcePushBlocked: true, mainDeletionBlocked: true, routingVerified: true }, evidence: evidenceFor('R_1') }),
  }, session);
  assert.equal(result.kind, 'blocked'); assert.equal(session.state, 'open');
  assert.equal(session.ordinaryWorkAllowed, false); assert.equal(journal.at(-1).phase, 'closure-blocked');
});
test('closure acknowledgement cannot replace effective safeguard readback', async () => {
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  const result = await closeSetupSession({ appendJournal: persisted,
    restoreSetupProtections: async () => ({ kind: 'verified', value: {}, evidence: [] }),
    observeProtections: async () => ({ kind: 'uncertain', reason: 'read unavailable', evidence: [] }),
  }, session);
  assert.equal(result.kind, 'blocked'); assert.equal(session.state, 'open');
});
test('verified restoration closes only setup authority and does not activate ordinary work', async () => {
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  const result = await closeSetupSession({ appendJournal: persisted,
    restoreSetupProtections: async () => ({ kind: 'verified', value: {}, evidence: [] }),
    observeProtections: async () => ({ kind: 'verified', value: { repositoryId: 'R_1', temporaryBypassAbsent: true, mainForcePushBlocked: true, mainDeletionBlocked: true, routingVerified: true }, evidence: evidenceFor('R_1') }),
  }, session);
  assert.equal(result.kind, 'verified'); assert.equal(session.state, 'closed');
  assert.equal(authorizeSetupPath(session, 'README.md').kind, 'blocked');
  assert.equal(session.ordinaryWorkAllowed, false);
});
test('lost repository creation response reconciles exact resource and never retries creation', async () => {
  const created = { id: 'R_1', fullName: desired.fullName, ownerLogin: 'glyad', visibility: 'public' };
  const result = await reconcileRepositoryCreation({
    readJournal: async () => ({ kind: 'verified', value: [{ phase: 'create-intent', operationId: 'op-1', fullName: desired.fullName }], evidence: evidenceFor('op-1') }),
    observeRepository: async () => ({ kind: 'verified', value: created, evidence: evidenceFor('R_1') }),
    apply: async () => assert.fail('blind retry forbidden'),
  }, { operationId: 'op-1', fullName: desired.fullName, actorId: 'U_1' });
  assert.equal(result.kind, 'verified'); assert.equal(result.value.id, 'R_1');
});
test('lost creation response with unresolved absence remains uncertain', async () => {
  const result = await reconcileRepositoryCreation({
    readJournal: async () => ({ kind: 'verified', value: [{ phase: 'create-intent', operationId: 'op-1', fullName: desired.fullName }], evidence: evidenceFor('op-1') }),
    observeRepository: async () => ({ kind: 'verified', value: null, evidence: observation().evidence }),
    apply: async () => assert.fail('blind retry forbidden'),
  }, { operationId: 'op-1', fullName: desired.fullName, actorId: 'U_1' });
  assert.equal(result.kind, 'uncertain');
});
test('destination inspection detects existing content without touching it', async () => {
  const path = await mkdtemp(join(tmpdir(), 'governance-dest-'));
  await mkdir(join(path, 'checkout')); await writeFile(join(path, 'checkout', 'keep'), 'private');
  const result = await inspectDestination(join(path, 'checkout'));
  assert.equal(result.state, 'nonempty');
  assert.equal(await readFile(join(path, 'checkout', 'keep'), 'utf8'), 'private');
});
test('read-only GitHub adapter refuses mutation capability', () => {
  const adapter = createReadOnlyGitHubPort();
  assert.equal(typeof adapter.observeSetup, 'function');
  assert.equal(adapter.apply, undefined); assert.equal(adapter.createKey, undefined);
});

test('existing signing probe blocks missing configured key without creating or uploading one', async () => {
  const calls = [];
  const result = await probeExistingSigning({ actor: { login: 'glyad' }, gh: () => assert.fail('no key API needed'),
    execute: (binary, args) => { calls.push([binary, ...args]); return { ok: args.at(-1) !== 'user.signingkey', stdout: 'existing identity' }; } });
  assert.equal(result.localVerified, false); assert.equal(result.githubAssociationVerified, false);
  assert.ok(calls.every(([binary, ...args]) => binary === 'git' && args[0] === 'config' && args[1] === '--get'));
});
test('GitHub transport failure remains uncertain rather than resource absence', async () => {
  const p = createReadOnlyGitHubPort({ execute: () => ({ ok: false, stdout: '' }) });
  assert.equal((await p.observeRepository(desired.fullName)).kind, 'uncertain');
});
test('GitHub repository response verifies resource identity and preserves ID', async () => {
  const p = createReadOnlyGitHubPort({ execute: (binary, args) => {
    assert.equal(binary, 'gh'); assert.ok(args.includes('GET')); assert.equal(args.at(-1), 'repos/glyad/github-workspace-manager');
    return { ok: true, stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify({ node_id: 'R_live', full_name: desired.fullName, owner: { login: 'glyad' }, visibility: 'public', default_branch: 'main' }) };
  } });
  const result = await p.observeRepository(desired.fullName);
  assert.equal(result.kind, 'verified'); assert.equal(result.value.id, 'R_live');
});
test('mutated desired safeguard requirements cannot close an unsafe session', async () => {
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  session.desiredRules = {};
  const result = await closeSetupSession({ appendJournal: persisted, restoreSetupProtections: async () => {},
    observeProtections: async () => ({ kind: 'verified', value: { repositoryId: 'R_1' }, evidence: evidenceFor('R_1') }),
  }, session);
  assert.equal(result.kind, 'blocked');
});
test('tampered preflight snapshot cannot grant setup authority', async () => {
  const s = await snapshot(); s.signing.localVerified = false;
  assert.equal(openSetupSession(s, ['README.md'], { login: 'glyad', id: 'U_1' }).kind, 'blocked');
});

for (const kind of ['blocked', 'uncertain', 'conflict']) {
  test(`journal intent ${kind} prevents restoration and propagates status`, async () => {
    const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
    let restorationAttempted = false;
    const result = await closeSetupSession({
      appendJournal: async () => ({ kind, reason: 'durable intent unavailable', evidence: [] }),
      restoreSetupProtections: async () => { restorationAttempted = true; },
      observeProtections: async () => assert.fail('no later closure operation allowed'),
    }, session);
    assert.equal(result.kind, kind); assert.match(result.reason, /intent/);
    assert.equal(restorationAttempted, false);
    assert.equal(session.state, 'open'); assert.equal(session.ordinaryWorkAllowed, false);
  });
  test(`final journal ${kind} prevents closure after effective restoration`, async () => {
    const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
    const result = await closeSetupSession({
      appendJournal: async (key, row) => row.phase === 'closure-intent' ? persisted(key, row) : ({ kind, reason: 'durable closure unavailable', evidence: [] }),
      restoreSetupProtections: async () => ({ kind: 'verified', value: {}, evidence: [] }),
      observeProtections: async () => ({ kind: 'verified', value: { repositoryId: 'R_1', temporaryBypassAbsent: true, mainForcePushBlocked: true, mainDeletionBlocked: true, routingVerified: true }, evidence: evidenceFor('R_1') }),
    }, session);
    assert.equal(result.kind, kind); assert.match(result.reason, /closure/);
    assert.equal(session.state, 'open'); assert.equal(session.ordinaryWorkAllowed, false);
  });
}
test('void journal return cannot authorize restoration', async () => {
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  let restorationAttempted = false;
  const result = await closeSetupSession({ appendJournal: async () => {},
    restoreSetupProtections: async () => { restorationAttempted = true; },
  }, session);
  assert.equal(result.kind, 'blocked'); assert.equal(session.state, 'open'); assert.equal(restorationAttempted, false);
});
test('journal verification for a different record cannot authorize restoration', async () => {
  const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
  let restorationAttempted = false;
  const result = await closeSetupSession({
    appendJournal: async (key, row) => persisted(key, { ...row, operationId: 'another-operation' }),
    restoreSetupProtections: async () => { restorationAttempted = true; },
  }, session);
  assert.equal(result.kind, 'blocked'); assert.equal(session.state, 'open'); assert.equal(restorationAttempted, false);
});
for (const kind of ['blocked', 'uncertain', 'conflict']) {
  test(`creation recovery propagates journal read ${kind} without remote observation`, async () => {
    let observed = false;
    const result = await reconcileRepositoryCreation({
      readJournal: async () => ({ kind, reason: 'journal read unavailable', evidence: [] }),
      observeRepository: async () => { observed = true; },
    }, { operationId: 'op-1', fullName: desired.fullName, actorId: 'U_1' });
    assert.equal(result.kind, kind); assert.match(result.reason, /journal read/);
    assert.equal(observed, false);
  });
}

for (const nested of [undefined, evidenceFor('R_OTHER', 'U_OTHER')]) {
  test(`preflight returns validated enclosing evidence when nested evidence is ${nested ? 'contradictory' : 'absent'}`, async () => {
    const value = observation({ repository: { exists: true, fullName: desired.fullName, id: 'R_1' }, evidence: nested });
    const accepted = evidenceFor('R_1');
    const result = await preflightSetup({ observeSetup: async () => ({ kind: 'verified', value, evidence: accepted }) }, desired);
    assert.equal(result.kind, 'verified');
    assert.deepEqual(result.value.evidence, accepted);
    assert.equal(openSetupSession(result.value, ['README.md'], { login: 'glyad', id: 'U_1' }).kind, 'verified');
  });
}
for (const [name, wrongActor, wrongResource] of [['wrong actor', 'U_OTHER', null], ['wrong resource', 'U_1', 'R_OTHER']]) {
  for (const boundary of ['intent', 'protection', 'final journal']) {
    test(`${name} evidence at closure ${boundary} cannot close or authorize restoration`, async () => {
      const session = openSetupSession(await snapshot(), ['README.md'], { login: 'glyad', id: 'U_1' }).value;
      let restored = false;
      const result = await closeSetupSession({
        appendJournal: async (key, row) => {
          const invalid = (boundary === 'intent' && row.phase === 'closure-intent') || (boundary === 'final journal' && row.phase !== 'closure-intent');
          return invalid ? { kind: 'verified', value: row, evidence: evidenceFor(wrongResource ?? key, wrongActor) } : persisted(key, row);
        },
        restoreSetupProtections: async () => { restored = true; },
        observeProtections: async () => ({ kind: 'verified', value: { repositoryId: 'R_1', temporaryBypassAbsent: true, mainForcePushBlocked: true, mainDeletionBlocked: true, routingVerified: true },
          evidence: boundary === 'protection' ? evidenceFor(wrongResource ?? 'R_1', wrongActor) : evidenceFor('R_1') }),
      }, session);
      assert.equal(result.kind, 'blocked'); assert.equal(session.state, 'open');
      assert.equal(session.ordinaryWorkAllowed, false);
      assert.equal(restored, boundary !== 'intent');
    });
  }
  for (const boundary of ['journal', 'repository']) {
    test(`creation recovery rejects ${name} at ${boundary} observation`, async () => {
      let observed = false;
      const result = await reconcileRepositoryCreation({
        readJournal: async () => ({ kind: 'verified', value: [{ phase: 'create-intent', operationId: 'op-1', fullName: desired.fullName }],
          evidence: boundary === 'journal' ? evidenceFor(wrongResource ?? 'op-1', wrongActor) : evidenceFor('op-1') }),
        observeRepository: async () => { observed = true; return { kind: 'verified', value: { id: 'R_1', fullName: desired.fullName, ownerLogin: 'glyad', visibility: 'public' },
          evidence: boundary === 'repository' ? evidenceFor(wrongResource ?? 'R_1', wrongActor) : evidenceFor('R_1') }; },
      }, { operationId: 'op-1', fullName: desired.fullName, actorId: 'U_1' });
      assert.equal(result.kind, 'blocked'); assert.equal(observed, boundary === 'repository');
    });
  }
}
