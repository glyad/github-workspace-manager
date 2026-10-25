import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProjectScope } from '../../tools/governance/project-state.mjs';
import { projectDigest } from '../../tools/governance/project-baseline.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import {
  planScopeChange,
  releaseAdmission,
  createOfflineScopeDecisionService,
  convertScopeManifest,
} from '../../tools/governance/scope-decisions.mjs';
const sha = (letter) => letter.repeat(40);
const candidate = (pr = 1) => ({
  repositoryId: 'repo',
  pr,
  base: sha('a'),
  head: sha('b'),
  attempt: 'attempt',
  baseRef: 'refs/heads/develop',
  requestId: 'request',
  protocolVersion: 2,
});
const seal = (snapshot) => {
  const { revision: _revision, ...payload } = snapshot;
  snapshot.revision = projectDigest(payload);
  return snapshot;
};
function fixture({ accepted = true } = {}) {
  const bytes = 'approved acceptance';
  const sourceDigest = digest(bytes);
  const requirement = {
    requirementId: 'work',
    sourceKey: 'work',
    sourceDigest,
    issueNodeId: 'issue',
    parentRequirementId: null,
    role: 'leaf',
    coverageIds: ['coverage'],
    milestoneId: 'v1',
    requiredPrNodeIds: ['pr1'],
    dependencyRequirementIds: [],
    acceptanceDigest: sourceDigest,
  };
  const snapshot = seal({
    version: 1,
    repositoryId: 'repo',
    projectId: 'project',
    requirements: [requirement],
    coverageCatalog: [
      {
        id: 'coverage',
        sourceKey: 'work',
        sourceDigest,
        startByte: 0,
        endByte: Buffer.byteLength(bytes),
        textDigest: sourceDigest,
        parentCoverageId: null,
      },
    ],
    decisionRefs: ['accept'],
  });
  const history = {
    version: 1,
    repositoryId: 'repo',
    projectId: 'project',
    acceptedBaseline: { ref: 'baseline', decisionRef: 'accept', snapshot },
    steps: [],
    current: snapshot,
    observationRef: 'history',
  };
  const lifecycle = {
    version: 1,
    scope: accepted
      ? { kind: 'accepted', history }
      : { kind: 'intake', snapshot, nativeObservationRef: 'native' },
    projection: {
      repositoryId: 'repo',
      projectId: 'project',
      issueNodeId: 'issue',
      scopeRevision: snapshot.revision,
      coverageIds: ['coverage'],
      milestoneId: null,
    },
    repositoryId: 'repo',
    projectId: 'project',
    integrationTarget: { ref: 'refs/heads/develop', sha: sha('a') },
    activities: [{ issueNodeId: 'issue', kind: 'inactive', observationRef: 'activity' }],
    prs: [
      {
        prNodeId: 'pr1',
        issueNodeIds: ['issue'],
        state: 'open',
        draft: true,
        candidate: candidate(),
        readinessRef: null,
        ciRef: null,
        observationRef: 'pr-observation',
      },
    ],
    integration: [],
    publication: [],
    observationRef: 'lifecycle',
  };
  const chain = {
    ref: 'history',
    kind: 'scope-chain',
    repositoryId: 'repo',
    projectId: 'project',
    baselineRef: 'baseline',
    baselineRevision: snapshot.revision,
    currentRevision: snapshot.revision,
    decisionCount: 0,
    orderedDecisionIds: [],
  };
  const { ref: _ref, kind: _kind, ...head } = chain;
  chain.headDigest = projectDigest(head);
  lifecycle.evidence = {
    version: 1,
    repositoryId: 'repo',
    projectId: 'project',
    sources: [
      {
        ref: 'source',
        kind: 'source',
        sourceKey: 'work',
        sourceDigest,
        utf8Bytes: [...Buffer.from(bytes)],
      },
    ],
    readiness: [],
    ci: [],
    publications: [],
    chains: accepted ? [chain] : [],
  };
  return { lifecycle, snapshot, history, bytes };
}
function refresh(f) {
  seal(f.snapshot);
  f.lifecycle.projection.scopeRevision = f.snapshot.revision;
  if (f.lifecycle.scope.kind === 'accepted') {
    const chain = f.lifecycle.evidence.chains[0];
    chain.baselineRevision = f.history.acceptedBaseline.snapshot.revision;
    chain.currentRevision = f.snapshot.revision;
    chain.decisionCount = f.history.steps.length;
    chain.orderedDecisionIds = f.history.steps.map((s) => s.decision.decisionId);
    const { ref: _ref, kind: _kind, headDigest: _digest, ...head } = chain;
    chain.headDigest = projectDigest(head);
  }
}

const clone = (v) => structuredClone(v);
function planning() {
  const f = fixture();
  const proposed = clone(f.snapshot);
  proposed.requirements[0].milestoneId = 'v2';
  proposed.decisionRefs.push('defer');
  seal(proposed);
  const decision = {
    version: 1,
    decisionId: 'defer',
    repositoryId: 'repo',
    ownerActorId: 'owner-node',
    sourceRef: 'human-original',
    sourceDigest: digest('defer exact work to v2'),
    beforeScopeDigest: f.snapshot.revision,
    afterScopeDigest: proposed.revision,
    kind: 'defer',
    affectedRequirementIds: ['work'],
    destinationMilestoneId: 'v2',
    closedPrNodeIds: [],
    dispositionRefs: ['absence'],
  };
  const disposition = {
    kind: 'no-integrated-code',
    decisionRef: 'defer',
    scopeDigest: f.snapshot.revision,
    requirementIds: ['work'],
    coverageIds: ['coverage'],
    targetSha: sha('a'),
    completeObservationRef: 'absence',
  };
  const evidence = clone(f.lifecycle.evidence);
  const proposedEvidence = { ...clone(evidence), chains: [] };
  const input = {
    scope: clone(f.lifecycle.scope),
    evidence,
    proposed,
    proposedEvidence,
    lifecycle: f.lifecycle,
    dispositions: [disposition],
    targetSha: sha('a'),
  };
  const links = {
    repositoryId: 'repo',
    projectId: 'project',
    observationRef: 'native',
    links: [
      {
        repositoryId: 'repo',
        projectId: 'project',
        issueNodeId: 'issue',
        projectItemId: 'item',
        milestoneId: 'v1',
        parentNodeId: null,
        dependencyNodeIds: [],
        prNodeIds: ['pr1'],
        historyDigest: digest('original history'),
        observationRef: 'issue-read',
      },
    ],
  };
  return { ...f, input, decision, links };
}
const plan = (f) => planScopeChange(f.input, f.decision, f.links);
test('public APIs have exact arities and facade has no production selection', () => {
  assert.equal(planScopeChange.length, 3);
  assert.equal(releaseAdmission.length, 2);
  const service = createOfflineScopeDecisionService({
    resolve: async () => ({ kind: 'blocked', reason: 'unavailable', evidence: [] }),
  });
  assert.deepEqual(Object.keys(service).sort(), ['planScopeChange', 'releaseAdmission']);
  assert.equal(service.planScopeChange.length, 3);
  assert.equal(service.releaseAdmission.length, 2);
  for (const extra of ['production', 'trusted', 'writer', 'token'])
    assert.throws(() => createOfflineScopeDecisionService({ resolve: () => {}, [extra]: true }));
  let read = 0;
  assert.throws(() =>
    createOfflineScopeDecisionService(
      Object.defineProperty({}, 'resolve', {
        enumerable: true,
        get() {
          read++;
          return () => {};
        },
      }),
    ),
  );
  assert.equal(read, 0);
});
test('positive no-code policy produces data-only milestone plan without native write authority', () => {
  const f = planning(),
    r = plan(f);
  assert.equal(r.kind, 'verified', r.reason);
  assert.equal(r.value.scopeOperations[0].kind, 'set-milestone');
  assert.equal(r.value.statusProjection, null);
  assert.equal(r.value.beforeScopeDigest, f.snapshot.revision);
  assert.equal('write' in r.value, false);
});
for (const [name, mutate] of Object.entries({
  'absent decision': (f) => (f.decision = null),
  'wrong repository': (f) => (f.decision.repositoryId = 'other'),
  'stale decision': (f) => (f.decision.beforeScopeDigest = digest('old')),
  'omitted affected requirement': (f) => (f.decision.affectedRequirementIds = []),
  'missing positive absence': (f) => (f.input.dispositions = []),
  'wrong target': (f) => (f.input.dispositions[0].targetSha = sha('b')),
  'wrong coverage': (f) => (f.input.dispositions[0].coverageIds = ['other']),
  'extra native issue': (f) =>
    f.links.links.push({ ...clone(f.links.links[0]), issueNodeId: 'other' }),
  'native milestone drift': (f) => (f.links.links[0].milestoneId = 'v2'),
  'missing original PR link': (f) => (f.links.links[0].prNodeIds = []),
  'forged owner flag': (f) => (f.decision.trusted = true),
  'missing source bytes': (f) => (f.input.proposedEvidence.sources = []),
  'intake cannot plan': (f) =>
    (f.input.scope = { kind: 'intake', snapshot: f.snapshot, nativeObservationRef: 'native' }),
  'no-code contradicted by integrated history': (f) => {
    f.lifecycle.prs[0].state = 'merged';
    f.lifecycle.integration.push({
      requirementId: 'work',
      prNodeId: 'pr1',
      candidate: candidate(),
      mergeSha: sha('b'),
      targetRef: 'refs/heads/develop',
      targetSha: sha('a'),
      validationRefs: ['validation'],
      observationRef: 'integration',
    });
  },
}))
  test('planner blocks ' + name, () => {
    const f = planning();
    mutate(f);
    assert.notEqual(plan(f).kind, 'verified');
  });
test('caller accessors are rejected without evaluation', () => {
  const f = planning();
  let called = 0;
  Object.defineProperty(f.input, 'targetSha', {
    enumerable: true,
    get() {
      called++;
      return sha('a');
    },
  });
  assert.equal(plan(f).kind, 'blocked');
  assert.equal(called, 0);
});
test('empty PR mapping cannot vacuously admit, but exact merged validated work can', () => {
  const f = fixture();
  const e = { lifecycle: f.lifecycle, dispositions: [], milestoneId: 'v1', targetSha: sha('a') };
  assert.notEqual(releaseAdmission(f.history, e).kind, 'verified');
  f.lifecycle.prs[0].state = 'merged';
  f.lifecycle.integration = [
    {
      requirementId: 'work',
      prNodeId: 'pr1',
      candidate: candidate(),
      mergeSha: sha('b'),
      targetRef: 'refs/heads/develop',
      targetSha: sha('a'),
      validationRefs: ['validation'],
      observationRef: 'integration',
    },
  ];
  const r = releaseAdmission(f.history, e);
  assert.equal(r.kind, 'verified', r.reason);
  assert.deepEqual(r.value.completedRequirementIds, ['work']);
});
test('actual manifest preserves all 48 entries and exact bytes as unresolved intake only', () => {
  const manifest = JSON.parse(readFileSync('governance/scope.json', 'utf8'));
  const before = clone(manifest);
  const nativeIds = {
    repositoryId: 'R_kgDOVRTNvA',
    projectId: manifest.nativeIds.projectId,
    milestones: [{ name: manifest.version, id: manifest.nativeIds.milestoneId }],
  };
  const r = convertScopeManifest(manifest, nativeIds);
  assert.equal(r.kind, 'verified', r.reason);
  const v = r.value;
  assert.equal(v.kind, 'unresolved-intake');
  assert.equal(v.scope.kind, 'intake');
  assert.deepEqual(v.originalManifest, before);
  assert.deepEqual(manifest, before);
  assert.equal(v.scope.snapshot.requirements.length, 48);
  assert.equal(v.evidence.sources.length, 47);
  assert.equal(v.provenance.filter((p) => p.sourceBasis === 'body').length, 12);
  assert.equal(v.provenance.filter((p) => p.sourceBasis === 'acceptance').length, 35);
  assert.equal(
    v.scope.snapshot.requirements
      .filter((r) => r.requirementId.startsWith('deferred-'))
      .every((r) => r.milestoneId === null),
    true,
  );
  assert.equal(parseProjectScope(v.scope, v.evidence).kind, 'verified');
  for (const entry of manifest.entries) {
    const req = v.scope.snapshot.requirements.find((r) => r.requirementId === entry.key);
    assert.equal(req.issueNodeId, entry.issueNodeId);
    if (entry.acceptance) assert.equal(req.sourceDigest, digest(entry.acceptance));
  }
  assert.notEqual(
    convertScopeManifest(manifest, { ...nativeIds, milestones: [] }).kind,
    'verified',
  );
});

// These retained source records model an offline trusted composition. The resolver
// checks actual human bytes and complete code observations; no trusted:true input.
function resolverFixture(f) {
  const originalDecision = clone(f.decision);
  const originals = new Map();
  const add = (ref, bytes, actor = 'native-observer', resource = ref) =>
    originals.set(ref, { bytes, actorId: actor, resourceId: resource, revision: 'retained-r1' });
  for (const ref of [
    'baseline',
    'accept',
    'history',
    'native',
    'issue-read',
    'lifecycle',
    'activity',
    'pr-observation',
  ])
    add(ref, `retained original ${ref}`);
  add('source', f.bytes, 'source-owner', 'approved-source');
  add(
    'human-original',
    f.humanInstruction ?? 'defer exact work to v2',
    'owner-node',
    'retained-chat-message',
  );
  add(
    'defer',
    f.humanInstruction ?? 'defer exact work to v2',
    'owner-node',
    'retained-chat-message',
  );
  const absence = {
    targetSha: sha('a'),
    scopeRevision: f.snapshot.revision,
    requirements: ['work'],
    coverage: ['coverage'],
    requiredPrNodeIds: ['pr1'],
    observedPrs: [{ prNodeId: 'pr1', state: 'open', mergeSha: null }],
    integrationHistory: { throughSha: sha('a'), commits: [], directIntegrations: [] },
    attribution: [{ coverageId: 'coverage', paths: [] }],
  };
  add('absence', JSON.stringify(absence));
  const retainedHistory = clone(f.lifecycle.scope.history);
  const retainedLifecycle = clone(f.lifecycle);
  const retainedLinks = clone(f.links);
  add(
    'baseline',
    JSON.stringify(retainedHistory.acceptedBaseline.snapshot),
    'source-owner',
    'baseline-resource',
  );
  add(
    'accept',
    JSON.stringify({
      instruction: 'accept exact original acceptance',
      snapshot: retainedHistory.acceptedBaseline.snapshot,
    }),
    'owner-node',
    'baseline-human-message',
  );
  add(
    'history',
    JSON.stringify({ history: retainedHistory, chain: retainedLifecycle.evidence.chains[0] }),
    'chain-observer',
    'scope-chain-resource',
  );
  add('native', JSON.stringify(retainedLinks), 'native-observer', 'complete-native-links');
  add('lifecycle', JSON.stringify(retainedLifecycle), 'native-observer', 'complete-lifecycle');
  const requests = [];
  const refs = (request) => {
    const p = request.payload,
      h = p.scope?.history;
    const hs = h
      ? [
          h.acceptedBaseline.ref,
          h.acceptedBaseline.decisionRef,
          h.observationRef,
          ...h.steps.map((s) => s.decision.sourceRef),
        ]
      : [];
    if (request.kind === 'scope-history') return [...hs, ...p.evidence.sources.map((s) => s.ref)];
    if (request.kind === 'owner-decision')
      return [p.decision.sourceRef, ...p.proposedEvidence.sources.map((s) => s.ref)];
    if (request.kind === 'native-links')
      return [p.observationRef, ...p.links.map((l) => l.observationRef)];
    if (request.kind === 'lifecycle')
      return [
        ...hs,
        p.observationRef,
        ...p.activities.map((a) => a.observationRef),
        ...p.prs.map((a) => a.observationRef),
        ...p.integration.map((a) => a.observationRef),
        ...p.publication.map((a) => a.observationRef),
        ...p.evidence.sources.map((s) => s.ref),
        ...p.evidence.publications.map((s) => s.inclusion.evidenceRef),
      ];
    return p.kind === 'no-integrated-code'
      ? [p.decisionRef, p.completeObservationRef]
      : [p.decisionRef, p.reviewRef, p.validationRef, p.incorporationRef];
  };
  const resolve = async (request) => {
    requests.push(request);
    const p = request.payload;
    if (request.kind === 'scope-history' && !equalFixture(p.scope.history, retainedHistory))
      return { kind: 'conflict', reason: 'current-chain-changed', evidence: [] };
    if (request.kind === 'native-links' && !equalFixture(p, retainedLinks))
      return { kind: 'conflict', reason: 'native-state-changed', evidence: [] };
    if (request.kind === 'lifecycle' && !equalFixture(p, retainedLifecycle))
      return { kind: 'conflict', reason: 'lifecycle-state-changed', evidence: [] };
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(p), true);
    const { payloadDigest, ...unsigned } = request;
    assert.equal(payloadDigest, projectDigest(unsigned));
    if (request.kind === 'owner-decision') {
      const human = originals.get(p.decision.sourceRef);
      if (
        !human ||
        human.actorId !== p.decision.ownerActorId ||
        digest(human.bytes) !== p.decision.sourceDigest
      )
        return { kind: 'blocked', reason: 'unresolved-original-owner', evidence: [] };
      if (!equalFixture(p.decision, originalDecision))
        return { kind: 'blocked', reason: 'unapproved-interpretation', evidence: [] };
    }
    if (request.kind === 'disposition') {
      if (p.kind === 'no-integrated-code') {
        const original = originals.get(p.completeObservationRef);
        if (!original) return { kind: 'uncertain', reason: 'missing-history', evidence: [] };
        const o = JSON.parse(original.bytes);
        if (
          o.targetSha !== p.targetSha ||
          o.scopeRevision !== p.scopeDigest ||
          !equalFixture(o.requirements, p.requirementIds) ||
          !equalFixture(o.coverage, p.coverageIds) ||
          o.requiredPrNodeIds.some(
            (id) =>
              !o.observedPrs.some(
                (pr) => pr.prNodeId === id && pr.state === 'open' && pr.mergeSha === null,
              ),
          ) ||
          o.integrationHistory.throughSha !== p.targetSha ||
          o.integrationHistory.commits.length ||
          o.integrationHistory.directIntegrations.length ||
          o.attribution.some((a) => a.paths.length)
        )
          return { kind: 'blocked', reason: 'absence-not-established', evidence: [] };
      } else {
        const review = originals.get(p.reviewRef),
          validation = originals.get(p.validationRef),
          incorporation = originals.get(p.incorporationRef);
        if (!review || !validation || !incorporation)
          return { kind: 'blocked', reason: 'missing-code-observation', evidence: [] };
        const r = JSON.parse(review.bytes),
          v = JSON.parse(validation.bytes),
          i = JSON.parse(incorporation.bytes);
        if (
          !equalFixture(r.candidate, p.changeCandidate) ||
          !equalFixture(v.candidate, p.changeCandidate) ||
          !equalFixture(i.candidate, p.changeCandidate) ||
          i.targetSha !== p.targetSha ||
          !equalFixture(i.coverageIds, p.coverageIds) ||
          i.sourceSha !== p.sourceSha ||
          i.method !== p.method ||
          i.disabledBehaviors.length !== p.coverageIds.length ||
          p.coverageIds.some(
            (id) =>
              !i.disabledBehaviors.some(
                (b) =>
                  b.coverageId === id && typeof b.behavior === 'string' && b.behavior.length > 0,
              ),
          ) ||
          v.failures.length ||
          r.findings.length
        )
          return { kind: 'blocked', reason: 'ineffective-code-disposition', evidence: [] };
      }
    }
    const bindings = [];
    for (const ref of [...new Set(refs(request))].sort()) {
      const record = originals.get(ref);
      if (!record) return { kind: 'uncertain', reason: 'unavailable-source', evidence: [] };
      const sources =
        request.kind === 'owner-decision'
          ? p.proposedEvidence.sources
          : (p.evidence?.sources ?? []);
      const source = sources.find((s) => s.ref === ref);
      if (source && digest(Buffer.from(source.utf8Bytes)) !== digest(record.bytes))
        return { kind: 'conflict', reason: 'source-original-mismatch', evidence: [] };
      bindings.push({
        ref,
        sourceDigest: digest(record.bytes),
        resourceId: record.resourceId,
        actorId: record.actorId,
        revision: record.revision,
      });
    }
    return {
      kind: 'verified',
      value: { version: 1, requestDigest: payloadDigest, bindings },
      evidence: [],
    };
  };
  return { resolve, originals, requests, absence, add };
}
const equalFixture = (a, b) => projectDigest(a) === projectDigest(b);
const serviceFor = (f, r) =>
  createOfflineScopeDecisionService({ resolve: r.resolve }).planScopeChange(
    f.input,
    f.decision,
    f.links,
  );
test('offline facade resolves originals in deterministic order twice, without authority outside callback', async () => {
  const f = planning(),
    r = resolverFixture(f),
    out = await serviceFor(f, r);
  assert.equal(out.kind, 'verified', out.reason);
  assert.deepEqual(
    r.requests.map((r) => r.kind),
    [
      'scope-history',
      'owner-decision',
      'native-links',
      'lifecycle',
      'disposition',
      'scope-history',
      'owner-decision',
      'native-links',
      'lifecycle',
      'disposition',
    ],
  );
  assert.equal(out.value.statusProjection, null);
});
for (const [name, alter] of Object.entries({
  'same login different immutable actor': (r) =>
    (r.originals.get('human-original').actorId = 'login-glyad-but-other-node'),
  'missing complete integration history': (r) => r.originals.delete('absence'),
  'known direct implementation': (r) => {
    r.absence.integrationHistory.directIntegrations = ['direct-commit'];
    r.originals.get('absence').bytes = JSON.stringify(r.absence);
  },
  'incomplete mapped PR observations': (r) => {
    r.absence.observedPrs = [];
    r.originals.get('absence').bytes = JSON.stringify(r.absence);
  },
  'untracked implementation attribution': (r) => {
    r.absence.attribution[0].paths = ['implementation.mjs'];
    r.originals.get('absence').bytes = JSON.stringify(r.absence);
  },
  'unavailable original acceptance': (r) => r.originals.delete('source'),
}))
  test('configured resolver rejects ' + name, async () => {
    const f = planning(),
      r = resolverFixture(f);
    alter(r);
    assert.notEqual((await serviceFor(f, r)).kind, 'verified');
  });
for (const [name, alter] of Object.entries({
  'wrong digest': (v) => (v.value.requestDigest = digest('foreign-call')),
  'wrong version': (v) => (v.value.version = 2),
  'missing binding': (v) => v.value.bindings.pop(),
  'extra binding': (v) =>
    v.value.bindings.push({
      ref: 'unasked',
      sourceDigest: digest('x'),
      resourceId: 'x',
      actorId: 'x',
      revision: 'x',
    }),
  'wrong owner digest': (v, q) => {
    if (q.kind === 'owner-decision')
      v.value.bindings.find((b) => b.ref === 'human-original').sourceDigest =
        digest('invented human bytes');
  },
  'extra replacement payload': (v) => (v.value.payload = {}),
}))
  test('facade blocks malformed response ' + name, async () => {
    const f = planning(),
      r = resolverFixture(f),
      resolve = r.resolve;
    r.resolve = async (q) => {
      const v = await resolve(q);
      alter(v, q);
      return v;
    };
    assert.notEqual((await serviceFor(f, r)).kind, 'verified');
  });
test('bounded defensive call snapshot survives caller mutation while awaiting resolver', async () => {
  const f = planning(),
    r = resolverFixture(f),
    resolve = r.resolve;
  let first = true;
  r.resolve = async (q) => {
    if (first) {
      first = false;
      f.input.targetSha = sha('b');
      f.decision.ownerActorId = 'forged';
      f.links.links.length = 0;
      await Promise.resolve();
    }
    return resolve(q);
  };
  const out = await serviceFor(f, r);
  assert.equal(out.kind, 'verified', out.reason);
  assert.equal(out.value.beforeScopeDigest, f.snapshot.revision);
});
test('provider response mutation cannot change registered snapshot', async () => {
  const f = planning(),
    r = resolverFixture(f),
    resolve = r.resolve;
  let last;
  r.resolve = async (q) => {
    if (last) last.value.bindings[0].revision = 'mutated-provider-object';
    last = await resolve(q);
    return last;
  };
  assert.equal((await serviceFor(f, r)).kind, 'verified');
});
for (const change of ['source', 'target', 'unavailable'])
  test('second-pass ' + change + ' change cannot use first-pass success', async () => {
    const f = planning(),
      r = resolverFixture(f),
      resolve = r.resolve;
    let count = 0;
    r.resolve = async (q) => {
      if (++count === 6) {
        if (change === 'unavailable') r.originals.delete('source');
        else if (change === 'source') r.originals.get('source').revision = 'r2';
        else {
          r.absence.targetSha = sha('b');
          r.originals.get('absence').bytes = JSON.stringify(r.absence);
        }
      }
      return resolve(q);
    };
    assert.notEqual((await serviceFor(f, r)).kind, 'verified');
  });
test('copied response cannot register in another call or appear in input', async () => {
  const f = planning(),
    r = resolverFixture(f);
  let copied;
  const resolve = r.resolve;
  r.resolve = async (q) => {
    const v = await resolve(q);
    copied ??= clone(v);
    return v;
  };
  assert.equal((await serviceFor(f, r)).kind, 'verified');
  const foreign = createOfflineScopeDecisionService({ resolve: async () => copied });
  assert.notEqual((await foreign.planScopeChange(f.input, f.decision, f.links)).kind, 'verified');
  f.input.receipt = copied;
  assert.equal(plan(f).kind, 'blocked');
});
test('code disposition requires actual exact reviewed/tested incorporated disabled behavior records', async () => {
  const f = planning();
  f.humanInstruction = 'defer exact work to v2 using reviewed feature-control for coverage';
  f.decision.sourceDigest = digest(f.humanInstruction);
  f.decision.dispositionRefs = ['incorporation'];
  const d = {
    kind: 'code-disposition',
    decisionRef: 'defer',
    scopeDigest: f.snapshot.revision,
    requirementIds: ['work'],
    coverageIds: ['coverage'],
    method: 'feature-control',
    sourceSha: sha('b'),
    targetSha: sha('a'),
    changeCandidate: candidate(2),
    reviewRef: 'review',
    validationRef: 'tested',
    incorporationRef: 'incorporation',
  };
  f.input.dispositions = [d];
  const r = resolverFixture(f);
  r.add('review', JSON.stringify({ candidate: d.changeCandidate, findings: [] }));
  r.add('tested', JSON.stringify({ candidate: d.changeCandidate, failures: [] }));
  r.add(
    'incorporation',
    JSON.stringify({
      candidate: d.changeCandidate,
      targetSha: d.targetSha,
      coverageIds: d.coverageIds,
      sourceSha: d.sourceSha,
      method: d.method,
      disabledBehaviors: [
        { coverageId: 'coverage', behavior: 'covered behavior explicitly disabled' },
      ],
    }),
  );
  assert.equal((await serviceFor(f, r)).kind, 'verified');
  const review = JSON.parse(r.originals.get('review').bytes);
  review.candidate.head = sha('c');
  r.originals.get('review').bytes = JSON.stringify(review);
  assert.notEqual((await serviceFor(f, r)).kind, 'verified');
});

function acceptRoot() {
  const f = planning();
  f.input.dispositions = [];
  f.humanInstruction = 'accept new exact source and add root to v1';
  f.decision.sourceDigest = digest(f.humanInstruction);
  f.decision.kind = 'accept-version';
  f.decision.decisionId = 'add';
  f.decision.destinationMilestoneId = 'v1';
  f.decision.dispositionRefs = [];
  const text = 'new original acceptance 🌱\n';
  const sourceDigest = digest(text);
  f.input.proposed = clone(f.snapshot);
  f.input.proposed.decisionRefs.push('add');
  f.input.proposed.requirements.unshift({
    ...clone(f.snapshot.requirements[0]),
    requirementId: 'new',
    sourceKey: 'new',
    sourceDigest,
    acceptanceDigest: sourceDigest,
    issueNodeId: 'new-issue',
    coverageIds: ['new-coverage'],
    requiredPrNodeIds: [],
  });
  f.input.proposed.coverageCatalog.push({
    id: 'new-coverage',
    sourceKey: 'new',
    sourceDigest,
    startByte: 0,
    endByte: Buffer.byteLength(text),
    textDigest: sourceDigest,
    parentCoverageId: null,
  });
  seal(f.input.proposed);
  f.decision.afterScopeDigest = f.input.proposed.revision;
  f.decision.affectedRequirementIds = ['new'];
  f.input.proposedEvidence.sources.unshift({
    ref: 'new-source',
    kind: 'source',
    sourceKey: 'new',
    sourceDigest,
    utf8Bytes: [...Buffer.from(text)],
  });
  f.links.links = [
    {
      ...clone(f.links.links[0]),
      issueNodeId: 'new-issue',
      projectItemId: 'new-item',
      prNodeIds: [],
    },
  ];
  return { f, text };
}
test('new accepted root binds actual proposed source bytes, and missing source provenance blocks', async () => {
  const { f, text } = acceptRoot(),
    r = resolverFixture(f);
  r.add('new-source', text, 'source-owner', 'new-original-resource');
  assert.equal(plan(f).kind, 'verified');
  assert.equal((await serviceFor(f, r)).kind, 'verified');
  r.originals.delete('new-source');
  assert.notEqual((await serviceFor(f, r)).kind, 'verified');
});
test('changing proposed bytes and catalog changes owner request and cannot borrow original source binding', async () => {
  const { f, text } = acceptRoot(),
    r = resolverFixture(f);
  r.add('new-source', text);
  await serviceFor(f, r);
  const first = r.requests.find((q) => q.kind === 'owner-decision').payloadDigest;
  const next = text + 'changed';
  const sd = digest(next);
  const req = f.input.proposed.requirements.find((r) => r.requirementId === 'new');
  req.sourceDigest = req.acceptanceDigest = sd;
  Object.assign(
    f.input.proposed.coverageCatalog.find((c) => c.id === 'new-coverage'),
    { sourceDigest: sd, textDigest: sd, endByte: Buffer.byteLength(next) },
  );
  Object.assign(f.input.proposedEvidence.sources[0], {
    sourceDigest: sd,
    utf8Bytes: [...Buffer.from(next)],
  });
  seal(f.input.proposed);
  f.decision.afterScopeDigest = f.input.proposed.revision;
  const second = resolverFixture(f);
  second.add('new-source', text);
  assert.notEqual((await serviceFor(f, second)).kind, 'verified');
  assert.notEqual(second.requests.find((q) => q.kind === 'owner-decision').payloadDigest, first);
});
test('retained source alias and unobserved new Issue identity cannot enter proposal', () => {
  const { f } = acceptRoot();
  f.links.links = [];
  assert.notEqual(plan(f).kind, 'verified');
  const g = planning();
  g.input.proposedEvidence.sources[0].ref = 'borrowed-alias';
  assert.notEqual(plan(g).kind, 'verified');
});
test('unchanged owner acknowledgement of closed-unmerged is a no-op and cannot admit delivery', () => {
  const f = planning();
  f.lifecycle.prs[0].state = 'closed-unmerged';
  f.input.proposed = clone(f.snapshot);
  f.decision.kind = 'resolve-closed-pr';
  f.decision.afterScopeDigest = f.snapshot.revision;
  f.decision.closedPrNodeIds = ['pr1'];
  f.decision.dispositionRefs = [];
  f.input.dispositions = [];
  const r = plan(f);
  assert.equal(r.kind, 'verified', r.reason);
  assert.deepEqual(r.value.scopeOperations, []);
  assert.equal(r.value.statusProjection, null);
  assert.notEqual(
    releaseAdmission(f.history, {
      lifecycle: f.lifecycle,
      dispositions: [],
      milestoneId: 'v1',
      targetSha: sha('a'),
    }).kind,
    'verified',
  );
  for (const [key, value] of [
    ['closedPrNodeIds', ['wrong-pr']],
    ['affectedRequirementIds', []],
    ['afterScopeDigest', digest('old')],
  ]) {
    const g = clone(f);
    g.decision[key] = value;
    assert.notEqual(plan(g).kind, 'verified');
  }
});
function deferredHistory() {
  const f = planning(),
    before = clone(f.snapshot),
    after = clone(f.input.proposed);
  f.history.steps = [{ decision: clone(f.decision), before, after }];
  f.history.current = after;
  f.lifecycle.scope = { kind: 'accepted', history: f.history };
  f.snapshot = after;
  refresh(f);
  f.input.dispositions[0].scopeDigest = after.revision;
  return f;
}
test('admission preserves baseline version obligations after native milestone movement', () => {
  const f = deferredHistory(),
    e = {
      lifecycle: f.lifecycle,
      dispositions: f.input.dispositions,
      milestoneId: 'v1',
      targetSha: sha('a'),
    };
  const r = releaseAdmission(f.history, e);
  assert.equal(r.kind, 'verified', r.reason);
  assert.deepEqual(r.value.deferredRequirementIds, ['work']);
  assert.deepEqual(r.value.completedRequirementIds, []);
  assert.notEqual(releaseAdmission(f.history, { ...e, dispositions: [] }).kind, 'verified');
  assert.notEqual(releaseAdmission(f.history, { ...e, targetSha: sha('b') }).kind, 'verified');
  const changed = clone(f.history);
  changed.current.requirements = [];
  assert.notEqual(releaseAdmission(changed, e).kind, 'verified');
});
test('admission rejects stale integrated candidate although merged flag and target match', () => {
  const f = fixture();
  f.lifecycle.prs[0].state = 'merged';
  f.lifecycle.integration = [
    {
      requirementId: 'work',
      prNodeId: 'pr1',
      candidate: { ...candidate(), head: sha('c') },
      mergeSha: sha('b'),
      targetRef: 'refs/heads/develop',
      targetSha: sha('a'),
      validationRefs: ['validation'],
      observationRef: 'integration',
    },
  ];
  assert.notEqual(
    releaseAdmission(f.history, {
      lifecycle: f.lifecycle,
      dispositions: [],
      milestoneId: 'v1',
      targetSha: sha('a'),
    }).kind,
    'verified',
  );
});
test('manifest malformed entries report all keys without a partial result; Unicode bytes are literal', () => {
  const m = JSON.parse(readFileSync('governance/scope.json', 'utf8')),
    native = {
      repositoryId: 'repo',
      projectId: m.nativeIds.projectId,
      milestones: [{ name: m.version, id: m.nativeIds.milestoneId }],
    };
  m.entries.find((e) => e.key === 'deferred-01').acceptance = '';
  m.entries.find((e) => e.key === 'deferred-02').kind = 'unsupported';
  const bad = convertScopeManifest(m, native);
  assert.equal(bad.kind, 'blocked');
  assert.ok(bad.reason.includes('deferred-01') && bad.reason.includes('deferred-02'));
  assert.equal('value' in bad, false);
  const one = {
    entries: [
      {
        key: 'unicode',
        kind: 'deferred',
        body: '\ufeffשלום 🌱\r\n',
        issueNodeId: 'issue',
        dependencies: [],
        milestone: null,
      },
    ],
  };
  const r = convertScopeManifest(one, {
    repositoryId: 'repo',
    projectId: 'project',
    milestones: [],
  });
  assert.equal(r.kind, 'verified', r.reason);
  assert.deepEqual(r.value.evidence.sources[0].utf8Bytes, [...Buffer.from(one.entries[0].body)]);
  assert.equal(r.value.originalManifest.entries[0].sourceDigest, undefined);
});
function reparenting() {
  const f = planning(),
    r = f.snapshot.requirements[0];
  const aggregate = (id, issue, coverageIds) => ({
    ...clone(r),
    requirementId: id,
    sourceKey: id,
    sourceDigest: digest(''),
    acceptanceDigest: digest(''),
    issueNodeId: issue,
    parentRequirementId: null,
    role: 'aggregate',
    coverageIds,
    requiredPrNodeIds: [],
  });
  r.parentRequirementId = 'parent-a';
  f.snapshot.requirements.unshift(
    aggregate('parent-a', 'parent-issue-a', ['coverage']),
    aggregate('parent-b', 'parent-issue-b', []),
  );
  refresh(f);
  f.input.scope = clone(f.lifecycle.scope);
  f.input.evidence = clone(f.lifecycle.evidence);
  f.input.proposed = clone(f.snapshot);
  f.input.proposed.requirements.find((r) => r.requirementId === 'parent-a').coverageIds = [];
  f.input.proposed.requirements.find((r) => r.requirementId === 'parent-b').coverageIds = [
    'coverage',
  ];
  f.input.proposed.requirements.find((r) => r.requirementId === 'work').parentRequirementId =
    'parent-b';
  f.input.proposed.decisionRefs.push('move');
  seal(f.input.proposed);
  f.input.proposedEvidence = { ...clone(f.lifecycle.evidence), chains: [] };
  f.input.dispositions = [];
  Object.assign(f.decision, {
    decisionId: 'move',
    kind: 'split',
    beforeScopeDigest: f.snapshot.revision,
    afterScopeDigest: f.input.proposed.revision,
    affectedRequirementIds: ['parent-a', 'parent-b', 'work'],
    destinationMilestoneId: null,
    dispositionRefs: [],
  });
  const leaf = f.links.links[0];
  leaf.parentNodeId = 'parent-issue-a';
  f.links.links = [
    {
      ...clone(leaf),
      issueNodeId: 'parent-issue-a',
      projectItemId: 'parent-item-a',
      parentNodeId: null,
      prNodeIds: [],
    },
    {
      ...clone(leaf),
      issueNodeId: 'parent-issue-b',
      projectItemId: 'parent-item-b',
      parentNodeId: null,
      prNodeIds: [],
    },
    leaf,
  ].sort((a, b) => (a.issueNodeId < b.issueNodeId ? -1 : 1));
  return f;
}
test('split reparent plan retains the same child, PR, membership and history identities', () => {
  const f = reparenting(),
    r = plan(f);
  assert.equal(r.kind, 'verified', r.reason);
  assert.equal(r.value.scopeOperations.length, 1);
  assert.equal(r.value.scopeOperations[0].kind, 'reparent');
  assert.equal(r.value.scopeOperations[0].issueNodeId, 'issue');
  assert.equal(r.value.scopeOperations[0].fromParentNodeId, 'parent-issue-a');
  assert.equal(r.value.scopeOperations[0].toParentNodeId, 'parent-issue-b');
  assert.deepEqual(
    r.value.preservationRequirements.find((l) => l.issueNodeId === 'issue').prNodeIds,
    ['pr1'],
  );
  const bad = clone(f);
  bad.input.proposed.requirements.find((r) => r.requirementId === 'work').issueNodeId =
    'cloned-child';
  seal(bad.input.proposed);
  bad.decision.afterScopeDigest = bad.input.proposed.revision;
  assert.notEqual(plan(bad).kind, 'verified');
});
test('missing parent observation or changed dependency/PR/member IDs blocks reparenting', () => {
  for (const mutate of [
    (f) => f.links.links.shift(),
    (f) => (f.links.links.find((l) => l.issueNodeId === 'issue').dependencyNodeIds = ['unmapped']),
    (f) => (f.links.links.find((l) => l.issueNodeId === 'issue').projectItemId = ''),
    (f) => (f.links.links.find((l) => l.issueNodeId === 'issue').prNodeIds = []),
  ]) {
    const f = reparenting();
    mutate(f);
    assert.notEqual(plan(f).kind, 'verified');
  }
});
test('facade admission resolves lifecycle and dispositions twice with full historical version obligation', async () => {
  const f = deferredHistory(),
    r = resolverFixture(f);
  r.absence.scopeRevision = f.snapshot.revision;
  r.originals.get('absence').bytes = JSON.stringify(r.absence);
  r.add('integration', 'retained native integration');
  const service = createOfflineScopeDecisionService({ resolve: r.resolve });
  const result = await service.releaseAdmission(f.history, {
    lifecycle: f.lifecycle,
    dispositions: f.input.dispositions,
    milestoneId: 'v1',
    targetSha: sha('a'),
  });
  assert.equal(result.kind, 'verified', result.reason);
  assert.deepEqual(
    r.requests.map((r) => r.kind),
    ['lifecycle', 'disposition', 'lifecycle', 'disposition'],
  );
});
test('different refs cannot alias one retained source identity across lifecycle and proposal', () => {
  const f = planning();
  f.input.proposedEvidence.sources[0].ref = 'alias';
  assert.notEqual(plan(f).kind, 'verified');
});

function splitFixture() {
  const f = fixture();
  const before = structuredClone(f.snapshot);
  const sourceDigest = before.requirements[0].sourceDigest;
  f.history.acceptedBaseline.snapshot = before;
  const root = f.snapshot.requirements[0];
  root.role = 'aggregate';
  root.requiredPrNodeIds = [];
  root.coverageIds = ['coverage-a', 'coverage-b'];
  const makeLeaf = (suffix, milestoneId) => ({
    ...structuredClone(before.requirements[0]),
    requirementId: 'work-' + suffix,
    issueNodeId: 'issue-' + suffix,
    parentRequirementId: 'work',
    coverageIds: ['coverage-' + suffix],
    milestoneId,
    requiredPrNodeIds: ['pr-' + suffix],
  });
  f.snapshot.requirements.push(makeLeaf('a', 'v1'), makeLeaf('b', 'v2'));
  const makeCoverage = (suffix, startByte, endByte) => ({
    id: 'coverage-' + suffix,
    sourceKey: 'work',
    sourceDigest,
    startByte,
    endByte,
    textDigest: digest(Buffer.from(f.bytes).subarray(startByte, endByte)),
    parentCoverageId: 'coverage',
  });
  f.snapshot.coverageCatalog.push(
    makeCoverage('a', 0, 8),
    makeCoverage('b', 8, Buffer.byteLength(f.bytes)),
  );
  f.snapshot.decisionRefs.push('split');
  seal(f.snapshot);
  const decision = {
    version: 1,
    decisionId: 'split',
    repositoryId: 'repo',
    ownerActorId: 'owner-id',
    sourceRef: 'human-original',
    sourceDigest: digest('split decision'),
    beforeScopeDigest: before.revision,
    afterScopeDigest: f.snapshot.revision,
    kind: 'split',
    affectedRequirementIds: ['work', 'work-a', 'work-b'],
    destinationMilestoneId: null,
    closedPrNodeIds: [],
    dispositionRefs: [],
  };
  f.history.steps = [{ decision, before, after: f.snapshot }];
  f.lifecycle.projection.coverageIds = ['coverage-a', 'coverage-b'];
  f.lifecycle.activities = ['a', 'b'].map((suffix) => ({
    issueNodeId: 'issue-' + suffix,
    kind: 'inactive',
    observationRef: 'activity-' + suffix,
  }));
  f.lifecycle.prs = ['a', 'b'].map((suffix, i) => ({
    prNodeId: 'pr-' + suffix,
    issueNodeIds: ['issue-' + suffix],
    state: 'open',
    draft: true,
    candidate: candidate(i + 1),
    readinessRef: null,
    ciRef: null,
    observationRef: 'pr-observation-' + suffix,
  }));
  refresh(f);
  return f;
}

test('mixed-version parent admission completes current child and retains exact deferred byte obligation', () => {
  const f = splitFixture();
  f.history.steps[0].decision.dispositionRefs = ['absence'];
  f.lifecycle.prs[0].state = 'merged';
  f.lifecycle.integration = [
    {
      requirementId: 'work-a',
      prNodeId: 'pr-a',
      candidate: candidate(1),
      mergeSha: sha('b'),
      targetRef: 'refs/heads/develop',
      targetSha: sha('a'),
      validationRefs: ['validation'],
      observationRef: 'integrated-a',
    },
  ];
  const d = {
    kind: 'no-integrated-code',
    decisionRef: 'split',
    scopeDigest: f.snapshot.revision,
    requirementIds: ['work-b'],
    coverageIds: ['coverage-b'],
    targetSha: sha('a'),
    completeObservationRef: 'absence',
  };
  const evidence = {
    lifecycle: f.lifecycle,
    dispositions: [d],
    milestoneId: 'v1',
    targetSha: sha('a'),
  };
  const result = releaseAdmission(f.history, evidence);
  assert.equal(result.kind, 'verified', result.reason);
  assert.deepEqual(result.value.completedRequirementIds, ['work-a']);
  assert.deepEqual(result.value.deferredRequirementIds, ['work-b']);
  assert.notEqual(releaseAdmission(f.history, { ...evidence, dispositions: [] }).kind, 'verified');
});

test('actual manifest rejects invented IDs and inconsistent retained native relationships', () => {
  const m = JSON.parse(readFileSync('governance/scope.json', 'utf8')),
    native = {
      repositoryId: 'repo',
      projectId: m.nativeIds.projectId,
      milestones: [{ name: m.version, id: m.nativeIds.milestoneId }],
    };
  assert.notEqual(
    convertScopeManifest(m, {
      ...native,
      milestones: [{ name: m.version, id: 'invented-milestone' }],
    }).kind,
    'verified',
  );
  const changed = clone(m);
  changed.entries.find((e) => e.key === 'product-02').dependencyNodeIds = ['invented-dependency'];
  assert.notEqual(convertScopeManifest(changed, native).kind, 'verified');
});
test('resolver callback remains the trusted offline boundary; public data is never cryptographic identity', async () => {
  const f = planning(),
    r = resolverFixture(f);
  let captured;
  const resolve = async (q) => {
    const result = await r.resolve(q);
    captured = result;
    return result;
  };
  const out = await createOfflineScopeDecisionService({ resolve }).planScopeChange(
    f.input,
    f.decision,
    f.links,
  );
  assert.equal(out.kind, 'verified');
  assert.equal(captured.kind, 'verified');
  // The callback authors these assertions: a malicious configured callback could
  // fabricate all originals and lie. No returned result exposes a writer or token.
  assert.equal(Object.hasOwn(out.value, 'token'), false);
  assert.equal(Object.hasOwn(out.value, 'write'), false);
});

test('shared Issue maps complete PR union and yields one physical milestone intent', () => {
  const f = planning();
  f.snapshot.requirements = ['a', 'b'].map((suffix) => ({
    ...clone(f.snapshot.requirements[0]),
    requirementId: 'work-' + suffix,
    sourceKey: 'work-' + suffix,
    sourceDigest: digest(suffix),
    acceptanceDigest: digest(suffix),
    coverageIds: ['coverage-' + suffix],
    requiredPrNodeIds: ['pr-' + suffix],
  }));
  f.snapshot.coverageCatalog = ['a', 'b'].map((suffix) => ({
    id: 'coverage-' + suffix,
    sourceKey: 'work-' + suffix,
    sourceDigest: digest(suffix),
    startByte: 0,
    endByte: 1,
    textDigest: digest(suffix),
    parentCoverageId: null,
  }));
  f.lifecycle.evidence.sources = ['a', 'b'].map((suffix) => ({
    ref: 'source-' + suffix,
    kind: 'source',
    sourceKey: 'work-' + suffix,
    sourceDigest: digest(suffix),
    utf8Bytes: [...Buffer.from(suffix)],
  }));
  f.lifecycle.prs = ['a', 'b'].map((suffix, i) => ({
    ...clone(f.lifecycle.prs[0]),
    prNodeId: 'pr-' + suffix,
    candidate: candidate(i + 1),
    observationRef: 'read-pr-' + suffix,
  }));
  f.lifecycle.projection.coverageIds = ['coverage-a', 'coverage-b'];
  refresh(f);
  f.input.scope = clone(f.lifecycle.scope);
  f.input.evidence = clone(f.lifecycle.evidence);
  f.input.proposed = clone(f.snapshot);
  f.input.proposed.requirements.forEach((r) => (r.milestoneId = 'v2'));
  f.input.proposed.decisionRefs.push('defer');
  seal(f.input.proposed);
  f.input.proposedEvidence = { ...clone(f.lifecycle.evidence), chains: [] };
  Object.assign(f.decision, {
    beforeScopeDigest: f.snapshot.revision,
    afterScopeDigest: f.input.proposed.revision,
    affectedRequirementIds: ['work-a', 'work-b'],
  });
  Object.assign(f.input.dispositions[0], {
    scopeDigest: f.snapshot.revision,
    requirementIds: ['work-a', 'work-b'],
    coverageIds: ['coverage-a', 'coverage-b'],
  });
  f.links.links[0].prNodeIds = ['pr-a', 'pr-b'];
  const result = plan(f);
  assert.equal(result.kind, 'verified', result.reason);
  assert.equal(result.value.scopeOperations.length, 1);
  assert.deepEqual(result.value.preservationRequirements[0].prNodeIds, ['pr-a', 'pr-b']);
  f.links.links[0].prNodeIds = ['pr-a'];
  assert.notEqual(plan(f).kind, 'verified');
});

function mixedSplitPlanning() {
  const split = splitFixture(),
    f = fixture();
  f.input = {
    scope: clone(f.lifecycle.scope),
    evidence: clone(f.lifecycle.evidence),
    proposed: clone(split.snapshot),
    proposedEvidence: { ...clone(f.lifecycle.evidence), chains: [] },
    lifecycle: f.lifecycle,
    dispositions: [
      {
        kind: 'no-integrated-code',
        decisionRef: 'split',
        scopeDigest: f.snapshot.revision,
        requirementIds: ['work-b'],
        coverageIds: ['coverage-b'],
        targetSha: sha('a'),
        completeObservationRef: 'absence',
      },
    ],
    targetSha: sha('a'),
  };
  f.humanInstruction =
    'split exact conserved acceptance into existing children: retain work-a in v1 and defer work-b to v2';
  f.decision = {
    ...clone(split.history.steps[0].decision),
    ownerActorId: 'owner-node',
    sourceDigest: digest(f.humanInstruction),
    destinationMilestoneId: 'v2',
    dispositionRefs: ['absence'],
  };
  f.links = {
    repositoryId: 'repo',
    projectId: 'project',
    observationRef: 'native',
    links: [
      {
        repositoryId: 'repo',
        projectId: 'project',
        issueNodeId: 'issue',
        projectItemId: 'item',
        milestoneId: 'v1',
        parentNodeId: null,
        dependencyNodeIds: [],
        prNodeIds: ['pr1'],
        historyDigest: digest('root history'),
        observationRef: 'issue-read',
      },
      ...['a', 'b'].map((s) => ({
        repositoryId: 'repo',
        projectId: 'project',
        issueNodeId: 'issue-' + s,
        projectItemId: 'item-' + s,
        milestoneId: s === 'a' ? 'v1' : 'v2',
        parentNodeId: 'issue',
        dependencyNodeIds: [],
        prNodeIds: ['pr-' + s],
        historyDigest: digest('child history ' + s),
        observationRef: 'child-read-' + s,
      })),
    ],
  };
  return f;
}
test('mixed-version conserved split plans retained and moved children with exact owner/native/R3 sources', async () => {
  const f = mixedSplitPlanning(),
    pure = plan(f);
  assert.equal(pure.kind, 'verified', pure.reason);
  assert.equal(
    f.input.proposed.requirements.find((r) => r.requirementId === 'work-a').milestoneId,
    'v1',
  );
  assert.equal(
    f.input.proposed.requirements.find((r) => r.requirementId === 'work-b').milestoneId,
    'v2',
  );
  const r = resolverFixture(f);
  r.absence.requirements = ['work-b'];
  r.absence.coverage = ['coverage-b'];
  r.absence.attribution = [{ coverageId: 'coverage-b', paths: [] }];
  r.originals.get('absence').bytes = JSON.stringify(r.absence);
  r.add('split', f.humanInstruction, 'owner-node', 'retained-chat-message');
  for (const s of ['a', 'b'])
    r.add(
      'child-read-' + s,
      JSON.stringify(f.links.links.find((l) => l.issueNodeId === 'issue-' + s)),
    );
  const facade = await serviceFor(f, r);
  assert.equal(facade.kind, 'verified', facade.reason);
  assert.equal(facade.value.statusProjection, null);
});
for (const [name, mutate] of Object.entries({
  'wrong moved destination': (f) => (f.decision.destinationMilestoneId = 'v1'),
  'null moved destination': (f) => (f.decision.destinationMilestoneId = null),
  'missing child native identity': (f) => f.links.links.pop(),
  'missing deferred-part disposition': (f) => (f.input.dispositions = []),
  'wrong child disposition': (f) => {
    f.input.dispositions[0].requirementIds = ['work-a'];
    f.input.dispositions[0].coverageIds = ['coverage-a'];
  },
}))
  test('mixed split rejects ' + name, () => {
    const f = mixedSplitPlanning();
    mutate(f);
    assert.notEqual(plan(f).kind, 'verified');
  });

function closedDeferredAdmission() {
  const f = deferredHistory();
  f.lifecycle.prs[0].state = 'closed-unmerged';
  return {
    f,
    e: {
      lifecycle: f.lifecycle,
      dispositions: f.input.dispositions,
      milestoneId: 'v1',
      targetSha: sha('a'),
    },
  };
}
test('deferred obligation preserves manual gate when its required PR subsequently closes unmerged', async () => {
  const { f, e } = closedDeferredAdmission();
  const pure = releaseAdmission(f.history, e);
  assert.equal(pure.kind, 'blocked');
  assert.equal(pure.reason, 'closed-unmerged-manual-resolution');
  const r = resolverFixture(f),
    facade = await createOfflineScopeDecisionService({ resolve: r.resolve }).releaseAdmission(
      f.history,
      e,
    );
  assert.equal(facade.kind, 'blocked');
  assert.equal(facade.reason, 'closed-unmerged-manual-resolution');
});
function explicitlyResolvedDeferred() {
  const { f } = closedDeferredAdmission(),
    before = clone(f.snapshot),
    after = clone(f.snapshot);
  after.requirements[0].milestoneId = 'v3';
  after.decisionRefs.push('resolve');
  seal(after);
  const instruction =
    'resolve closed-unmerged pr1 for work: keep required mapping and defer exact coverage to v3 with positive no-code disposition';
  const decision = {
    ...clone(f.decision),
    decisionId: 'resolve',
    sourceRef: 'resolution-original',
    sourceDigest: digest(instruction),
    kind: 'resolve-closed-pr',
    beforeScopeDigest: before.revision,
    afterScopeDigest: after.revision,
    destinationMilestoneId: 'v3',
    closedPrNodeIds: ['pr1'],
    affectedRequirementIds: ['work'],
    dispositionRefs: ['resolved-absence'],
  };
  f.history.steps.push({ decision, before, after });
  f.history.current = after;
  f.snapshot = after;
  refresh(f);
  const d = {
    ...clone(f.input.dispositions[0]),
    decisionRef: 'resolve',
    scopeDigest: after.revision,
    completeObservationRef: 'resolved-absence',
  };
  return {
    f,
    decision,
    instruction,
    e: { lifecycle: f.lifecycle, dispositions: [d], milestoneId: 'v1', targetSha: sha('a') },
  };
}
test('explicit owner-resolved continuing mapping plus exact disposition permits deferred admission', async () => {
  const { f, e, decision, instruction } = explicitlyResolvedDeferred();
  const pure = releaseAdmission(f.history, e);
  assert.equal(pure.kind, 'verified', pure.reason);
  assert.deepEqual(pure.value.deferredRequirementIds, ['work']);
  assert.deepEqual(pure.value.completedRequirementIds, []);
  assert.deepEqual(f.snapshot.requirements[0].requiredPrNodeIds, ['pr1']);
  const r = resolverFixture(f);
  r.add('resolution-original', instruction, decision.ownerActorId, 'retained-resolution-message');
  r.add('resolve', instruction, decision.ownerActorId, 'retained-resolution-message');
  r.add('resolved-absence', JSON.stringify(r.absence));
  const facade = await createOfflineScopeDecisionService({ resolve: r.resolve }).releaseAdmission(
    f.history,
    e,
  );
  assert.equal(facade.kind, 'verified', facade.reason);
});
for (const [name, mutate] of Object.entries({
  'wrong closed PR': (x) => (x.f.history.steps.at(-1).decision.closedPrNodeIds = ['other-pr']),
  'ordinary defer is not closed resolution': (x) =>
    (x.f.history.steps.at(-1).decision.kind = 'defer'),
  'missing disposition after resolution': (x) => (x.e.dispositions = []),
}))
  test('deferred closed-PR resolution rejects ' + name, () => {
    const x = explicitlyResolvedDeferred();
    mutate(x);
    assert.notEqual(releaseAdmission(x.f.history, x.e).kind, 'verified');
  });
test('no-op acknowledgement alone still does not discharge deferred closed-PR admission', () => {
  const { f, e } = closedDeferredAdmission();
  const input = {
    scope: clone(f.lifecycle.scope),
    evidence: clone(f.lifecycle.evidence),
    proposed: clone(f.snapshot),
    proposedEvidence: { ...clone(f.lifecycle.evidence), chains: [] },
    lifecycle: f.lifecycle,
    dispositions: [],
    targetSha: sha('a'),
  };
  const decision = {
    ...clone(f.decision),
    decisionId: 'acknowledge',
    kind: 'resolve-closed-pr',
    beforeScopeDigest: f.snapshot.revision,
    afterScopeDigest: f.snapshot.revision,
    closedPrNodeIds: ['pr1'],
    dispositionRefs: [],
  };
  const links = {
    repositoryId: 'repo',
    projectId: 'project',
    observationRef: 'native',
    links: [{ ...clone(f.links.links[0]), milestoneId: 'v2' }],
  };
  const acknowledged = planScopeChange(input, decision, links);
  assert.equal(acknowledged.kind, 'verified', acknowledged.reason);
  assert.deepEqual(acknowledged.value.scopeOperations, []);
  assert.equal(releaseAdmission(f.history, e).kind, 'blocked');
});
