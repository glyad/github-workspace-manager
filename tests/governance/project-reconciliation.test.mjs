import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { createOfflineProjectController } from '../../tools/governance/project-reconciliation.mjs';
import { parseProjectScope, parseProjectLifecycle } from '../../tools/governance/project-state.mjs';
import {
  releaseAdmission,
  createOfflineScopeDecisionService,
} from '../../tools/governance/scope-decisions.mjs';
import { projectDigest } from '../../tools/governance/project-baseline.mjs';

const vector = {
  version: 1,
  repositoryId: 'R_test',
  projectId: 'P_test',
  planDigest: '0'.repeat(64),
  authorityDigest: '1'.repeat(64),
  stepCount: 2,
};
test('logical operation fixed vector excludes storage identity', () => {
  assert.equal(
    projectDigest(vector),
    'f8617d0ed84e3c87d7450d974487edd3418c35348b90ec3ec271506fa6a39936',
  );
});
test('lifecycle root initialization is explicit, exclusive and restart requires retained identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-'));
  try {
    const store = new LocalDurableStore(root);
    assert.equal(typeof store.initializeProjectLifecycle, 'function');
    const first = await store.initializeProjectLifecycle({
      repositoryId: 'R_test',
      projectId: 'P_test',
    });
    assert.equal(first.kind, 'verified');
    assert.equal(
      (await store.initializeProjectLifecycle({ repositoryId: 'R_test', projectId: 'P_test' }))
        .kind,
      'uncertain',
    );
    const restart = new LocalDurableStore(root);
    assert.equal((await restart.bindProjectLifecycle(first.value)).kind, 'verified');
    assert.equal(
      (await restart.bindProjectLifecycle({ ...first.value, rootId: 'wrong' })).kind,
      'uncertain',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lifecycle namespace lock retains uncertainty and prevents operation aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-lifecycle-'));
  try {
    const store = new LocalDurableStore(root);
    await store.initializeProjectLifecycle({ repositoryId: 'R_test', projectId: 'P_test' });
    assert.equal(typeof store.withProjectLifecycleLock, 'function');
    const binding = { ...vector, operationId: projectDigest(vector) };
    assert.equal(
      (
        await store.withProjectLifecycleLock(binding, async () => ({
          kind: 'uncertain',
          reason: 'lost',
          evidence: [],
        }))
      ).kind,
      'uncertain',
    );
    assert.notEqual(
      (
        await store.withProjectLifecycleLock(binding, async () => ({
          kind: 'verified',
          value: null,
          evidence: [],
        }))
      ).kind,
      'verified',
    );
    const changed = { ...vector, planDigest: '2'.repeat(64) };
    assert.notEqual(
      (
        await store.withProjectLifecycleLock(
          { ...changed, operationId: projectDigest(changed) },
          async () => ({ kind: 'verified', value: null, evidence: [] }),
        )
      ).kind,
      'verified',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('offline controller construction exists without default dependencies', async () => {
  const module = await import('../../tools/governance/project-reconciliation.mjs').catch(
    () => ({}),
  );
  assert.equal(typeof module.createOfflineProjectController, 'function');
  assert.throws(() => module.createOfflineProjectController({}));
});

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

function simulator(f) {
  const native = {
    links: clone(f.links.links),
    revision: 1,
    optionId: 'option-backlog',
    events: new Map(),
    calls: [],
    observations: [],
    hooks: {},
    fieldId: 'status-field',
  };
  const binding = (ref, data) => ({
    ref,
    sourceDigest: projectDigest(data),
    resourceId: ref,
    actorId: 'fixture-observer',
    revision: 'native-r1',
  });
  const originals = resolverFixture(f);
  const status = () => {
    const ref = `status-${native.revision}`;
    const data = {
      version: 1,
      kind: 'status-target',
      repositoryId: 'repo',
      projectId: 'project',
      issueNodeId: 'issue',
      projectItemId: 'item',
      fieldId: native.fieldId,
      fieldName: 'Status',
      options: ['Backlog', 'Planned', 'In progress', 'In review', 'Integrated', 'Released'].map(
        (name) => ({ name, id: 'option-' + name.toLowerCase().replaceAll(' ', '-') }),
      ),
      currentOptionId: native.optionId,
      revision: `revision-${native.revision}`,
      observationRef: ref,
    };
    return { ...data, sourceBindings: [binding(ref, data)] };
  };
  const port = {
    async observe(q) {
      if (native.hooks.observe) await native.hooks.observe(q);
      if (q.kind === 'status-target') return { kind: 'verified', value: status(), evidence: [] };
      const s = q.step,
        link = native.links.find((l) => l.issueNodeId === s.issueNodeId);
      const payload =
        s.kind === 'set-status'
          ? { ...s.before, fieldId: native.fieldId, optionId: native.optionId }
          : s.kind === 'set-milestone'
            ? { ...s.before, milestoneId: link.milestoneId }
            : { ...s.before, parentNodeId: link.parentNodeId };
      const links = native.links.map((l) => ({
        ...l,
        observationRef: `${l.issueNodeId}-native-${native.revision}`,
        historyDigest: projectDigest([...native.events.keys()]),
      }));
      const historyRefs = ['original-native-history', ...native.events.keys()].sort();
      const sourceBindings = [
        ...links.map((l) => binding(l.observationRef, l)),
        binding('original-native-history', 'original-native-history'),
        ...[...native.events.values()].map((v) => v.sourceBinding),
      ].sort((a, b) => a.ref.localeCompare(b.ref));
      const value = {
        version: 1,
        kind: 'step',
        repositoryId: q.repositoryId,
        projectId: q.projectId,
        operationId: q.operationId,
        stepId: q.stepId,
        revision: `revision-${native.revision}`,
        payload,
        links,
        historyRefs,
        sourceBindings,
      };
      native.observations.push(clone(value));
      return { kind: 'verified', value, evidence: [] };
    },
    async apply(q) {
      native.calls.push(clone(q));
      if (native.hooks.apply) await native.hooks.apply(q);
      if (q.expectedRevision !== `revision-${native.revision}`)
        return { kind: 'conflict', reason: 'simulator CAS mismatch', evidence: [] };
      const s = q.step,
        link = native.links.find((l) => l.issueNodeId === s.issueNodeId);
      if (s.kind === 'set-status') native.optionId = s.after.optionId;
      else if (s.kind === 'set-milestone') link.milestoneId = s.after.milestoneId;
      else link.parentNodeId = s.after.parentNodeId;
      native.revision++;
      const receiptRef = `receipt-${q.stepId}`;
      const receipt = {
        version: 1,
        repositoryId: q.repositoryId,
        projectId: q.projectId,
        operationId: q.operationId,
        stepId: q.stepId,
        resourceId: s.kind === 'set-status' ? s.after.projectItemId : s.issueNodeId,
        requestDigest: projectDigest(q),
        receiptRef,
        sourceBinding: binding(receiptRef, q),
      };
      native.events.set(receiptRef, receipt);
      if (native.hooks.afterApply) await native.hooks.afterApply(q);
      return { kind: 'verified', value: receipt, evidence: [] };
    },
  };
  const sourceBinding = (ref) => {
    const original = originals.originals.get(ref);
    return (
      original && {
        ref,
        sourceDigest: digest(original.bytes),
        resourceId: original.resourceId,
        actorId: original.actorId,
        revision: original.revision,
      }
    );
  };
  const requiredOriginals = new Map();
  async function resolve(q) {
    if (q.kind !== 'project-step') {
      const result = await originals.resolve(q);
      if (result.kind === 'verified' && q.kind !== 'native-links')
        result.value.bindings.forEach((b) => requiredOriginals.set(b.ref, b));
      return result;
    }
    if (native.hooks.resolveStep) await native.hooks.resolveStep(q);
    const o = q.payload.observation;
    const request = {
      version: 1,
      kind: 'step',
      repositoryId: o.repositoryId,
      projectId: o.projectId,
      operationId: o.operationId,
      stepId: o.stepId,
      step: q.payload.plan.steps[q.payload.stepIndex],
      knownReceipt: null,
    };
    const current = (await port.observe(request)).value;
    const nativeOnly = {
      ...o,
      sourceBindings: o.sourceBindings.filter((b) => !requiredOriginals.has(b.ref)),
    };
    if (!equalFixture(current, nativeOnly))
      return { kind: 'conflict', reason: 'native original changed', evidence: [] };
    const bindings = new Map(requiredOriginals);
    for (const b of o.sourceBindings) bindings.set(b.ref, b);
    return {
      kind: 'verified',
      value: {
        version: 1,
        requestDigest: q.payloadDigest,
        bindings: [...bindings.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
      },
      evidence: [],
    };
  }
  async function resolveRecovery(q) {
    if (native.hooks.recovery) return native.hooks.recovery(q);
    const bindings = new Map();
    function add(b) {
      if (b) bindings.set(b.ref, b);
    }
    for (const r of q.retainedRecords) {
      add(binding(`record:${r.operationId}:${r.index}`, r));
      const all =
        r.phase === 'intent'
          ? r.data.before.sourceBindings
          : r.phase === 'verified'
            ? r.data.observation.sourceBindings
            : r.phase === 'receipt'
              ? [r.data.receipt.sourceBinding]
              : r.phase === 'bound'
                ? (r.data.statusTarget?.sourceBindings ?? [])
                : [r.data.response.operatorBinding, ...r.data.response.recordBindings];
      all.forEach(add);
    }
    for (const r of q.resolutions) {
      r.observation.sourceBindings.forEach(add);
      if (r.receipt) add(r.receipt.sourceBinding);
      for (const ref of r.attributionRefs) {
        const event = native.events.get(ref);
        if (!event || event.requestDigest !== r.requestDigest)
          return { kind: 'uncertain', reason: 'unattributed native event', evidence: [] };
      }
    }
    for (const ref of [...bindings.keys()]) if (sourceBinding(ref)) add(sourceBinding(ref));
    return {
      kind: 'verified',
      value: {
        version: 1,
        requestDigest: projectDigest(q),
        operatorBinding: binding(q.recoveryRef, {
          authorization: 'explicit operator resolution',
          request: projectDigest(q),
        }),
        recordBindings: [...bindings.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
      },
      evidence: [],
    };
  }
  return { native, port, resolve, resolveRecovery, originals, binding };
}
async function setup(t, f = planning(), fault) {
  const root = await mkdtemp(join(tmpdir(), 'project-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root, { fault });
  const identity = (
    await store.initializeProjectLifecycle({ repositoryId: 'repo', projectId: 'project' })
  ).value;
  const sim = simulator(f);
  const controller = createOfflineProjectController({
    store,
    ...Object.fromEntries(['port', 'resolve', 'resolveRecovery'].map((k) => [k, sim[k]])),
  });
  const input = {
    version: 1,
    kind: 'scope',
    scope: f.input,
    ownerDecision: f.decision,
    observedLinks: f.links,
  };
  return { root, store, identity, sim, controller, input, f };
}

test('status starts solely from public lifecycle plus native Status query', async (t) => {
  const { controller, sim, f } = await setup(t);
  const out = await controller.reconcile({ version: 1, kind: 'status', lifecycle: f.lifecycle });
  assert.equal(out.kind, 'verified', out.reason);
  assert.equal(sim.native.optionId, 'option-in-progress');
  assert.equal(sim.native.calls.length, 1);
  assert.equal(sim.native.calls[0].step.authorityKind, 'projection');
});
test('milestone mutation uses exact IDs and independently preserves links', async (t) => {
  const { controller, sim, input } = await setup(t);
  const out = await controller.reconcile(input);
  assert.equal(out.kind, 'verified', out.reason);
  assert.equal(sim.native.links[0].milestoneId, 'v2');
  assert.equal(sim.native.calls.length, 1);
  assert.deepEqual(sim.native.links[0].prNodeIds, ['pr1']);
});
test('existing child reparent detaches and verifies before attaching with unchanged identities', async (t) => {
  const { controller, sim, input } = await setup(t, reparenting());
  const before = clone(sim.native.links);
  const out = await controller.reconcile(input);
  assert.equal(out.kind, 'verified', out.reason);
  assert.deepEqual(
    sim.native.calls.map((c) => c.step.kind),
    ['detach-parent', 'attach-parent'],
  );
  const child = sim.native.links.find((l) => l.issueNodeId === 'issue');
  assert.equal(child.parentNodeId, 'parent-issue-b');
  for (const key of ['issueNodeId', 'projectItemId', 'dependencyNodeIds', 'prNodeIds'])
    assert.deepEqual(child[key], before.find((l) => l.issueNodeId === 'issue')[key]);
});

async function restarted(env) {
  const store = new LocalDurableStore(env.root);
  assert.equal((await store.bindProjectLifecycle(env.identity)).kind, 'verified');
  return {
    store,
    controller: createOfflineProjectController({
      store,
      port: env.sim.port,
      resolve: env.sim.resolve,
      resolveRecovery: env.sim.resolveRecovery,
    }),
  };
}
for (const phase of ['project-before-witness', 'project-before-append', 'project-after-append'])
  test(`fault ${phase} at receipt retains lock; exact suffix and explicit applied recovery survive second restart`, async (t) => {
    let tripped = false,
      attemptedRecord;
    const env = await setup(t, reparenting(), async (name, row) => {
      if (!tripped && name === phase && row.phase === 'receipt') {
        tripped = true;
        attemptedRecord = clone(row);
        throw Error('crash');
      }
    });
    const out = await env.controller.reconcile(env.input);
    assert.equal(out.kind, 'uncertain');
    assert.equal(env.sim.native.calls.length, 1);
    const operationId = env.sim.native.calls[0].operationId;
    let restart = await restarted(env);
    assert.equal((await restart.controller.reconcile(env.input)).kind, 'uncertain');
    const retainedRecords = [];
    // The fixture independently retained the exact attempted record before its failure.
    // No private filesystem state is used by controller recovery.
    if (phase === 'project-before-append') {
      retainedRecords.push(attemptedRecord);
    }
    const recovered = await restart.controller.recover({
      version: 1,
      operationId,
      originalInput: env.input,
      recoveryRef: 'operator-explicit',
      retainedRecords,
    });
    assert.equal(recovered.kind, 'verified', recovered.reason);
    restart = await restarted(env);
    const resumed = await restart.controller.reconcile(env.input);
    assert.equal(resumed.kind, 'verified', resumed.reason);
    assert.equal(env.sim.native.calls.length, 2);
    assert.deepEqual(
      env.sim.native.calls.map((c) => c.step.kind),
      ['detach-parent', 'attach-parent'],
    );
    assert.equal(
      env.sim.native.links.find((l) => l.issueNodeId === 'issue').parentNodeId,
      'parent-issue-b',
    );
  });
test('complete operation can be independently rechecked after another restart without duplicate mutation', async (t) => {
  const env = await setup(t, reparenting());
  assert.equal((await env.controller.reconcile(env.input)).kind, 'verified');
  const restart = await restarted(env);
  const out = await restart.controller.reconcile(env.input);
  assert.equal(out.kind, 'verified', out.reason);
  assert.equal(env.sim.native.calls.length, 2);
});

test('confirmed nonexecution survives recovery and second restart; old reconciliation cannot clear a newer intent', async (t) => {
  const env = await setup(t);
  let failures = 0;
  env.sim.native.hooks.apply = async (q) => {
    if (failures++ < 2) {
      const ref = `not-executed-${failures}`;
      env.sim.native.revision++;
      env.sim.native.events.set(ref, {
        requestDigest: projectDigest(q),
        sourceBinding: env.sim.binding(ref, { nonexecution: true, request: projectDigest(q) }),
      });
      throw Error('simulator records positive nonexecution');
    }
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  let next = await restarted(env);
  const recovery = {
    version: 1,
    operationId,
    originalInput: env.input,
    recoveryRef: 'operator-nonexecution-1',
    retainedRecords: [],
  };
  const firstRecovery = await next.controller.recover(recovery);
  assert.equal(firstRecovery.kind, 'verified', firstRecovery.reason);
  next = await restarted(env);
  assert.equal((await next.controller.reconcile(env.input)).kind, 'uncertain');
  assert.equal(env.sim.native.calls.length, 2);
  const rows = await next.store.readProjectLifecycle(operationId);
  assert.equal(rows.kind, 'verified');
  assert.equal(rows.value.records.filter((r) => r.phase === 'intent').length, 2);
  assert.equal((await next.controller.reconcile(env.input)).kind, 'uncertain');
  assert.equal(env.sim.native.calls.length, 2);
  assert.equal(
    (await next.controller.recover({ ...recovery, recoveryRef: 'operator-nonexecution-2' })).kind,
    'verified',
  );
  next = await restarted(env);
  const done = await next.controller.reconcile(env.input);
  assert.equal(done.kind, 'verified', done.reason);
  assert.equal(env.sim.native.calls.length, 3);
});
for (const drift of [
  'source',
  'owner',
  'field',
  'options',
  'revision',
  'membership',
  'PR',
  'dependency',
  'history',
])
  test(`fresh ${drift} drift after intent prevents native apply`, async (t) => {
    let env,
      changed = false;
    env = await setup(t, planning(), async (name, row) => {
      if (!changed && name === 'project-after-append' && row.phase === 'intent') {
        changed = true;
        const n = env.sim.native;
        if (drift === 'source') env.sim.originals.originals.get('source').bytes += 'changed';
        if (drift === 'owner')
          env.sim.originals.originals.get('human-original').actorId = 'different-owner';
        if (drift === 'field') n.fieldId = 'different-field';
        if (drift === 'revision') n.revision++;
        if (drift === 'membership') n.links[0].projectItemId = 'different-item';
        if (drift === 'PR') n.links[0].prNodeIds = [];
        if (drift === 'dependency') n.links[0].dependencyNodeIds = ['unexpected'];
        if (drift === 'history')
          n.events.set('lost-history', {
            sourceBinding: env.sim.binding('lost-history', 'unexpected event'),
          });
        if (drift === 'options')
          n.hooks.observe = (q) => {
            if (q.kind === 'status-target') n.fieldId = 'changed-option-config';
          };
      }
    });
    const input = ['field', 'options'].includes(drift)
      ? { version: 1, kind: 'status', lifecycle: env.f.lifecycle }
      : env.input;
    const out = await env.controller.reconcile(input);
    assert.notEqual(out.kind, 'verified');
    assert.equal(env.sim.native.calls.length, 0);
  });
test('provider accessor and caller accessor are rejected without executing them', async (t) => {
  const env = await setup(t);
  let accessed = 0;
  const input = { ...env.input };
  Object.defineProperty(input, 'scope', {
    enumerable: true,
    get() {
      accessed++;
      return env.input.scope;
    },
  });
  assert.notEqual((await env.controller.reconcile(input)).kind, 'verified');
  assert.equal(accessed, 0);
  const store = new LocalDurableStore(env.root);
  const identity = { ...env.identity };
  Object.defineProperty(identity, 'rootId', {
    enumerable: true,
    get() {
      accessed++;
      return env.identity.rootId;
    },
  });
  assert.notEqual((await store.bindProjectLifecycle(identity)).kind, 'verified');
  assert.equal(accessed, 0);
});
test('recovery authority cannot change native state while authorizing recovery', async (t) => {
  const env = await setup(t);
  env.sim.native.hooks.afterApply = () => {
    throw Error('lost response');
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  const original = env.sim.resolveRecovery;
  const next = new LocalDurableStore(env.root);
  await next.bindProjectLifecycle(env.identity);
  const controller = createOfflineProjectController({
    store: next,
    port: env.sim.port,
    resolve: env.sim.resolve,
    resolveRecovery: async (q) => {
      const result = await original(q);
      env.sim.native.links[0].milestoneId = 'foreign-target';
      env.sim.native.revision++;
      return result;
    },
  });
  const out = await controller.recover({
    version: 1,
    operationId,
    originalInput: env.input,
    recoveryRef: 'explicit-recovery',
    retainedRecords: [],
  });
  assert.notEqual(out.kind, 'verified');
});

for (const artifact of ['log', 'tail', 'binding', 'witness', 'index', 'root'])
  test(`removed ${artifact} cannot become a fresh operation or release retained ownership`, async (t) => {
    const env = await setup(t);
    env.sim.native.hooks.afterApply = () => {
      throw Error('unknown native response');
    };
    assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
    const operationId = env.sim.native.calls[0].operationId;
    const { readFile, writeFile } = await import('node:fs/promises');
    const scope = join(env.root, `${digest('project-lifecycle:repo:project')}.project-lifecycle`);
    const log = join(env.root, `${digest('project-records:' + operationId)}.jsonl`);
    if (artifact === 'log') await rm(log);
    if (artifact === 'tail') {
      const body = await readFile(log, 'utf8');
      await writeFile(log, body.split('\n').slice(0, -2).join('\n') + '\n');
    }
    if (artifact === 'binding') await rm(join(scope, 'operations', operationId, 'binding.json'));
    if (artifact === 'witness') await rm(join(scope, 'operations', operationId, 'witnesses', '1'));
    if (artifact === 'index') await rm(join(scope, 'index', operationId));
    if (artifact === 'root') {
      await rm(scope, { recursive: true });
    }
    const restart = new LocalDurableStore(env.root);
    const rebound = await restart.bindProjectLifecycle(env.identity);
    if (artifact === 'root') assert.equal(rebound.kind, 'uncertain');
    else assert.equal(rebound.kind, 'verified');
    assert.equal((await restart.readProjectLifecycle(operationId)).kind, 'uncertain');
    const controller = createOfflineProjectController({
      store: restart,
      port: env.sim.port,
      resolve: env.sim.resolve,
      resolveRecovery: env.sim.resolveRecovery,
    });
    assert.notEqual((await controller.reconcile(env.input)).kind, 'verified');
    assert.notEqual(
      (
        await controller.recover({
          version: 1,
          operationId,
          originalInput: env.input,
          recoveryRef: 'explicit',
          retainedRecords: [],
        })
      ).kind,
      'verified',
    );
    assert.equal(env.sim.native.calls.length, 1);
  });
test('missing whole log restores only independently retained exact witnessed records through public recovery', async (t) => {
  const retained = [];
  const env = await setup(t, planning(), async (name, row) => {
    if (name === 'project-after-append') retained.push(clone(row));
  });
  env.sim.native.hooks.afterApply = () => {
    throw Error('unknown response');
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  await rm(join(env.root, `${digest('project-records:' + operationId)}.jsonl`));
  const restart = await restarted(env);
  const recovered = await restart.controller.recover({
    version: 1,
    operationId,
    originalInput: env.input,
    recoveryRef: 'operator-restore-exact-suffix',
    retainedRecords: retained,
  });
  assert.equal(recovered.kind, 'verified', recovered.reason);
  const again = await restarted(env);
  assert.equal((await again.controller.reconcile(env.input)).kind, 'verified');
  assert.equal(env.sim.native.calls.length, 1);
});
test('matching current value without attributable execution stays uncertain across restart', async (t) => {
  const env = await setup(t);
  env.sim.native.hooks.afterApply = () => {
    env.sim.native.events.clear();
    throw Error('unattributed response');
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  const restart = await restarted(env);
  const out = await restart.controller.recover({
    version: 1,
    operationId,
    originalInput: env.input,
    recoveryRef: 'owner-cannot-invent-native-proof',
    retainedRecords: [],
  });
  assert.notEqual(out.kind, 'verified');
  assert.equal((await restart.controller.reconcile(env.input)).kind, 'uncertain');
  assert.equal(env.sim.native.calls.length, 1);
});
test('status mutation preserves native milestone and parent relations', async (t) => {
  const env = await setup(t);
  env.sim.native.hooks.afterApply = () => {
    env.sim.native.links[0].milestoneId = 'unexpected-move';
  };
  const out = await env.controller.reconcile({
    version: 1,
    kind: 'status',
    lifecycle: env.f.lifecycle,
  });
  assert.notEqual(out.kind, 'verified');
});
test('copied or other-instance ordinary leases cannot append or recover', async (t) => {
  const env = await setup(t);
  const binding = { ...vector, operationId: projectDigest(vector) };
  const other = new LocalDurableStore(env.root);
  await other.bindProjectLifecycle(env.identity);
  assert.equal((await other.appendProjectLifecycle({}, {})).kind, 'uncertain');
  assert.equal(
    (await other.appendProjectLifecycleRecovery({}, { resolutions: [] })).kind,
    'uncertain',
  );
  assert.equal(
    (
      await env.store.withProjectLifecycleLock(binding, async (lease) =>
        other.appendProjectLifecycle(lease, {}),
      )
    ).kind,
    'uncertain',
  );
});

for (const [name, alter] of Object.entries({
  'wrong Project': (o) => (o.projectId = 'foreign-project'),
  'wrong Issue': (o) => (o.issueNodeId = 'foreign-issue'),
  'missing item': (o) => (o.projectItemId = ''),
  'unknown option': (o) => (o.options[0].name = 'Unknown'),
  'duplicate option': (o) => (o.options[1].id = o.options[0].id),
  'incomplete options': (o) => o.options.pop(),
  'missing observation binding': (o) => (o.sourceBindings = []),
  'extra authority flag': (o) => (o.verified = true),
}))
  test(`Status observation rejects ${name} without mutation`, async (t) => {
    const env = await setup(t);
    const port = {
      apply: env.sim.port.apply,
      observe: async (q) => {
        const result = await env.sim.port.observe(q);
        if (q.kind === 'status-target') alter(result.value);
        return result;
      },
    };
    const controller = createOfflineProjectController({
      store: env.store,
      port,
      resolve: env.sim.resolve,
      resolveRecovery: env.sim.resolveRecovery,
    });
    assert.notEqual(
      (await controller.reconcile({ version: 1, kind: 'status', lifecycle: env.f.lifecycle })).kind,
      'verified',
    );
    assert.equal(env.sim.native.calls.length, 0);
  });
for (const name of [
  'extra opcode',
  'scope/projection cross-use',
  'cycle',
  'sparse array',
  'oversized string',
  'accessor',
  'symbol',
  'proxy',
])
  test(`controller snapshots reject ${name} before calling providers`, async (t) => {
    const env = await setup(t);
    let input = clone(env.input),
      calls = 0;
    const resolve = async (q) => {
      calls++;
      return env.sim.resolve(q);
    };
    if (name === 'extra opcode') input.steps = [{ kind: 'delete-issue' }];
    if (name === 'scope/projection cross-use') input.kind = 'status';
    if (name === 'cycle') input.scope.self = input.scope;
    if (name === 'sparse array') input.scope.dispositions = new Array(2);
    if (name === 'oversized string') input.ownerDecision.sourceRef = 'x'.repeat(16385);
    if (name === 'accessor')
      Object.defineProperty(input, 'kind', {
        enumerable: true,
        get() {
          throw Error('must not execute');
        },
      });
    if (name === 'symbol') input[Symbol('extra')] = true;
    if (name === 'proxy') input = new Proxy(input, {});
    const controller = createOfflineProjectController({
      store: env.store,
      port: env.sim.port,
      resolve,
      resolveRecovery: env.sim.resolveRecovery,
    });
    assert.notEqual((await controller.reconcile(input)).kind, 'verified');
    assert.equal(calls, 0);
  });
test('uncertain outcome, live holder and simultaneous recovery never grant ordinary lock takeover', async (t) => {
  const env = await setup(t);
  let started, finish;
  const entered = new Promise((r) => (started = r)),
    hold = new Promise((r) => (finish = r));
  env.sim.native.hooks.apply = async () => {
    started();
    await hold;
    throw Error('native outcome unknown');
  };
  const running = env.controller.reconcile(env.input);
  await entered;
  const operationId = env.sim.native.calls[0].operationId;
  const restart = await restarted(env);
  const recovery = {
    version: 1,
    operationId,
    originalInput: env.input,
    recoveryRef: 'explicit-while-live',
    retainedRecords: [],
  };
  assert.notEqual((await restart.controller.recover(recovery)).kind, 'verified');
  assert.equal((await restart.controller.reconcile(env.input)).kind, 'uncertain');
  finish();
  assert.equal((await running).kind, 'uncertain');
});
test('recovery lock replacement cannot remove another holder or report successful handoff', async (t) => {
  const env = await setup(t);
  env.sim.native.hooks.afterApply = () => {
    throw Error('lost response');
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  const { readFile, writeFile } = await import('node:fs/promises');
  const lock = join(
    env.root,
    `${digest('project-lifecycle:repo:project')}.project-lifecycle`,
    'lock',
    'owner.json',
  );
  const original = env.sim.resolveRecovery;
  const store = new LocalDurableStore(env.root);
  await store.bindProjectLifecycle(env.identity);
  let replaced = false;
  const controller = createOfflineProjectController({
    store,
    port: env.sim.port,
    resolve: env.sim.resolve,
    resolveRecovery: async (q) => {
      const out = await original(q);
      if (!replaced) {
        replaced = true;
        const owner = JSON.parse(await readFile(lock, 'utf8'));
        owner.token = 'another-holder';
        await writeFile(lock, JSON.stringify(owner));
      }
      return out;
    },
  });
  assert.notEqual(
    (
      await controller.recover({
        version: 1,
        operationId,
        originalInput: env.input,
        recoveryRef: 'explicit-recovery',
        retainedRecords: [],
      })
    ).kind,
    'verified',
  );
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'another-holder');
});
test('unresolved scope cannot be bypassed by a Status plan in the same namespace', async (t) => {
  const env = await setup(t);
  env.sim.native.hooks.afterApply = () => {
    throw Error('unknown scope result');
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const out = await env.controller.reconcile({
    version: 1,
    kind: 'status',
    lifecycle: env.f.lifecycle,
  });
  assert.equal(out.kind, 'uncertain');
  assert.equal(env.sim.native.calls.length, 1);
});

test('store owns and exposes an incomplete witnessed recovery snapshot without permitting append or release', async (t) => {
  const env = await setup(t, planning(), async (name, row) => {
    if (name === 'project-before-append' && row.phase === 'intent')
      throw Error('witness survived without log row');
  });
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const { readdir, readFile } = await import('node:fs/promises');
  const scope = join(env.root, `${digest('project-lifecycle:repo:project')}.project-lifecycle`);
  const operationId = (await readdir(join(scope, 'index')))[0];
  const next = await restarted(env);
  let called = false;
  const out = await next.store.withProjectLifecycleRecovery(
    {
      version: 1,
      operationId,
      originalInput: env.input,
      recoveryRef: 'observe-missing-suffix',
      retainedRecords: [],
    },
    env.sim.resolveRecovery,
    async (lease, snapshot) => {
      called = true;
      assert.equal(snapshot.history.kind, 'missing-witnessed-suffix');
      assert.equal(snapshot.history.records.length, 1);
      assert.equal(snapshot.history.missingWitnesses.length, 1);
      assert.deepEqual(snapshot.unresolvedIntentIndices, []);
      assert.equal((await next.store.appendProjectLifecycle(lease, {})).kind, 'uncertain');
      return next.store.appendProjectLifecycleRecovery(lease, { resolutions: [] });
    },
  );
  assert.equal(called, true);
  assert.notEqual(out.kind, 'verified');
  assert.equal(
    JSON.parse(await readFile(join(scope, 'lock', 'owner.json'), 'utf8')).operationId,
    operationId,
  );
});

for (const recovered of [false, true])
  test(`restart retains every durable native history reference (${recovered ? 'applied reconciliation' : 'verified prefix'})`, async (t) => {
    let trip = false;
    const env = await setup(t, reparenting(), async (name, row) => {
      if (recovered && !trip && name === 'project-before-witness' && row.phase === 'receipt') {
        trip = true;
        throw Error('receipt interrupted');
      }
    });
    const first = await env.controller.reconcile(env.input);
    assert.equal(first.kind, recovered ? 'uncertain' : 'verified');
    const operationId = env.sim.native.calls[0].operationId;
    if (recovered) {
      const restart = await restarted(env);
      assert.equal(
        (
          await restart.controller.recover({
            version: 1,
            operationId,
            originalInput: env.input,
            recoveryRef: 'explicit-history-preservation',
            retainedRecords: [],
          })
        ).kind,
        'verified',
      );
    }
    const calls = env.sim.native.calls.length;
    env.sim.native.events.clear();
    const restart = await restarted(env);
    const resumed = await restart.controller.reconcile(env.input);
    assert.notEqual(resumed.kind, 'verified');
    assert.equal(env.sim.native.calls.length, calls);
  });
test('rejected alias releases only its fresh prebinding lock and leaves original resumable', async (t) => {
  const env = await setup(t);
  let failed = false;
  env.sim.native.hooks.apply = async (q) => {
    if (failed) return;
    failed = true;
    env.sim.native.revision++;
    const ref = 'positively-not-executed-original';
    env.sim.native.events.set(ref, {
      requestDigest: projectDigest(q),
      sourceBinding: env.sim.binding(ref, { nonexecution: true, request: projectDigest(q) }),
    });
    throw Error('positive nonexecution');
  };
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  const restart = await restarted(env);
  assert.equal(
    (
      await restart.controller.recover({
        version: 1,
        operationId,
        originalInput: env.input,
        recoveryRef: 'release-for-original-resume',
        retainedRecords: [],
      })
    ).kind,
    'verified',
  );
  const logical = { ...vector, repositoryId: 'repo', projectId: 'project' };
  const alias = { ...logical, operationId: projectDigest(logical) };
  const rejected = await restart.store.withProjectLifecycleLock(alias, async () => {
    throw Error('must not enter alias execution');
  });
  assert.notEqual(rejected.kind, 'verified');
  assert.equal((await restart.store.readProjectLifecycle(alias.operationId)).kind, 'uncertain');
  const next = await restarted(env);
  const resumed = await next.controller.reconcile(env.input);
  assert.equal(resumed.kind, 'verified', resumed.reason);
  assert.equal(env.sim.native.calls.length, 2);
  assert.equal(env.sim.native.calls[1].operationId, operationId);
});

test('Status confirmed nonexecution resumes the immutable operation after release and another restart', async (t) => {
  const env = await setup(t);
  const input = { version: 1, kind: 'status', lifecycle: env.f.lifecycle };
  let failed = false;
  env.sim.native.hooks.apply = async (q) => {
    if (failed) return;
    failed = true;
    env.sim.native.revision++;
    const ref = 'status-positive-nonexecution';
    env.sim.native.events.set(ref, {
      requestDigest: projectDigest(q),
      sourceBinding: env.sim.binding(ref, { nonexecution: true, request: projectDigest(q) }),
    });
    throw Error('positive Status nonexecution');
  };
  assert.equal((await env.controller.reconcile(input)).kind, 'uncertain');
  const original = clone(env.sim.native.calls[0]);
  let next = await restarted(env);
  assert.equal(
    (
      await next.controller.recover({
        version: 1,
        operationId: original.operationId,
        originalInput: input,
        recoveryRef: 'status-confirmed-nonexecution',
        retainedRecords: [],
      })
    ).kind,
    'verified',
  );
  next = await restarted(env);
  const resumed = await next.controller.reconcile(input);
  assert.equal(resumed.kind, 'verified', resumed.reason);
  assert.equal(env.sim.native.calls.length, 2);
  assert.equal(env.sim.native.calls[1].operationId, original.operationId);
  assert.equal(env.sim.native.calls[1].stepId, original.stepId);
  assert.equal(env.sim.native.optionId, 'option-in-progress');
});
function enforceCurrentNativeLinks(env) {
  const resolve = env.sim.resolve;
  env.sim.resolve = async (request) => {
    if (
      request.kind === 'native-links' &&
      request.payload.links.some((link) => {
        const current = env.sim.native.links.find((v) => v.issueNodeId === link.issueNodeId);
        return (
          !current ||
          ['parentNodeId', 'milestoneId', 'projectItemId', 'prNodeIds', 'dependencyNodeIds'].some(
            (key) => !equalFixture(current[key], link[key]),
          )
        );
      })
    )
      return { kind: 'conflict', reason: 'Unit2 current native links changed', evidence: [] };
    return resolve(request);
  };
  env.controller = createOfflineProjectController({
    store: env.store,
    port: env.sim.port,
    resolve: env.sim.resolve,
    resolveRecovery: env.sim.resolveRecovery,
  });
}
test('current-native resolver permits recovered owned detach resume without replaying original native-before planning', async (t) => {
  let tripped = false;
  const env = await setup(t, reparenting(), async (name, row) => {
    if (!tripped && name === 'project-before-witness' && row.phase === 'receipt') {
      tripped = true;
      throw Error('receipt interrupted');
    }
  });
  enforceCurrentNativeLinks(env);
  assert.equal((await env.controller.reconcile(env.input)).kind, 'uncertain');
  const operationId = env.sim.native.calls[0].operationId;
  let next = await restarted(env);
  assert.equal(
    (
      await next.controller.recover({
        version: 1,
        operationId,
        originalInput: env.input,
        recoveryRef: 'current-native-detach-recovery',
        retainedRecords: [],
      })
    ).kind,
    'verified',
  );
  next = await restarted(env);
  const resumed = await next.controller.reconcile(env.input);
  assert.equal(resumed.kind, 'verified', resumed.reason);
  assert.deepEqual(
    env.sim.native.calls.map((q) => q.step.kind),
    ['detach-parent', 'attach-parent'],
  );
  assert.equal(env.sim.native.calls[1].operationId, operationId);
  assert.equal(
    env.sim.native.links.find((l) => l.issueNodeId === 'issue').parentNodeId,
    'parent-issue-b',
  );
});

const lookupFor = (input) => ({
  repositoryId: 'repo',
  projectId: 'project',
  inputDigest: projectDigest(input),
});
test('lookup verifies empty namespace as null and rejects malformed/wrong/unbound contexts', async (t) => {
  const env = await setup(t);
  assert.deepEqual((await env.store.findProjectLifecycle(lookupFor(env.input))).value, null);
  for (const query of [
    { ...lookupFor(env.input), extra: true },
    { ...lookupFor(env.input), projectId: 'foreign' },
    { ...lookupFor(env.input), inputDigest: 'wrong' },
  ])
    assert.notEqual((await env.store.findProjectLifecycle(query)).kind, 'verified');
  assert.notEqual(
    (await new LocalDurableStore(env.root).findProjectLifecycle(lookupFor(env.input))).kind,
    'verified',
  );
});
async function bindEmptyFixturePlan(store, inputDigest, authorityDigest, projectId = 'project') {
  const plan = {
    version: 1,
    repositoryId: 'repo',
    projectId,
    inputDigest,
    authorityDigest,
    steps: [],
  };
  const logical = {
    version: 1,
    repositoryId: 'repo',
    projectId,
    planDigest: projectDigest(plan),
    authorityDigest,
    stepCount: 0,
  };
  const binding = { ...logical, operationId: projectDigest(logical) };
  return store.withProjectLifecycleLock(binding, async (lease) => {
    const append = await store.appendProjectLifecycle(lease, {
      version: 1,
      operationId: binding.operationId,
      index: 0,
      previousRecordDigest: null,
      phase: 'bound',
      stepId: null,
      data: { binding, plan, statusTarget: null },
    });
    return append.kind === 'verified' ? { kind: 'verified', value: null, evidence: [] } : append;
  });
}
test('lookup includes completed and unfinished history and conflicts on two valid matching plans', async (t) => {
  const env = await setup(t),
    digest = projectDigest(env.input);
  assert.equal((await bindEmptyFixturePlan(env.store, digest, 'a'.repeat(64))).kind, 'verified');
  const one = await env.store.findProjectLifecycle(lookupFor(env.input));
  assert.equal(one.kind, 'verified');
  assert.equal(one.value.records[0].data.plan.inputDigest, digest);
  assert.equal((await bindEmptyFixturePlan(env.store, digest, 'b'.repeat(64))).kind, 'verified');
  assert.equal((await env.store.findProjectLifecycle(lookupFor(env.input))).kind, 'conflict');
});
for (const missing of ['index-directory', 'index-entry', 'binding', 'whole-log', 'tail', 'witness'])
  test(`lookup never turns missing ${missing} into absence`, async (t) => {
    const env = await setup(t);
    assert.equal((await env.controller.reconcile(env.input)).kind, 'verified');
    const operationId = env.sim.native.calls[0].operationId;
    const scope = join(env.root, `${digest('project-lifecycle:repo:project')}.project-lifecycle`),
      log = join(env.root, `${digest('project-records:' + operationId)}.jsonl`);
    const { readFile, writeFile } = await import('node:fs/promises');
    if (missing === 'index-directory') await rm(join(scope, 'index'), { recursive: true });
    if (missing === 'index-entry') await rm(join(scope, 'index', operationId));
    if (missing === 'binding') await rm(join(scope, 'operations', operationId, 'binding.json'));
    if (missing === 'whole-log') await rm(log);
    if (missing === 'tail') {
      const body = await readFile(log, 'utf8');
      await writeFile(log, body.split('\n').slice(0, -2).join('\n') + '\n');
    }
    if (missing === 'witness') await rm(join(scope, 'operations', operationId, 'witnesses', '1'));
    assert.equal((await env.store.findProjectLifecycle(lookupFor(env.input))).kind, 'uncertain');
    assert.equal(
      (
        await env.store.findProjectLifecycle({
          ...lookupFor(env.input),
          inputDigest: 'f'.repeat(64),
        })
      ).kind,
      'uncertain',
    );
  });
test('paired metadata loss with independent lifecycle log retained blocks lookup, fresh binding and reconciliation', async (t) => {
  const env = await setup(t);
  const inputDigest = projectDigest(env.input);
  assert.equal(
    (await bindEmptyFixturePlan(env.store, inputDigest, 'a'.repeat(64))).kind,
    'verified',
  );
  const before = await env.store.findProjectLifecycle(lookupFor(env.input));
  const operationId = before.value.binding.operationId;
  const scope = join(env.root, `${digest('project-lifecycle:repo:project')}.project-lifecycle`);
  const { readFile } = await import('node:fs/promises');
  const log = join(env.root, `${digest('project-records:' + operationId)}.jsonl`);
  const retained = await readFile(log);
  await rm(join(scope, 'index', operationId));
  await rm(join(scope, 'operations', operationId), { recursive: true });
  const next = await restarted(env); // Original root and separately retained identity survive.
  for (const query of [
    lookupFor(env.input),
    { ...lookupFor(env.input), inputDigest: 'f'.repeat(64) },
  ])
    assert.equal((await next.store.findProjectLifecycle(query)).kind, 'uncertain');
  let entered = false;
  assert.equal(
    (
      await next.store.withProjectLifecycleLock(before.value.binding, async () => {
        entered = true;
        return { kind: 'verified', value: null, evidence: [] };
      })
    ).kind,
    'uncertain',
  );
  assert.equal(entered, false);
  assert.equal((await next.controller.reconcile(env.input)).kind, 'uncertain');
  assert.equal(env.sim.native.calls.length, 0);
  assert.deepEqual(await readFile(log), retained);
});

test('journal completeness preserves independent Project contexts and generic store logs', async (t) => {
  const env = await setup(t);
  assert.equal(
    (await bindEmptyFixturePlan(env.store, projectDigest(env.input), 'a'.repeat(64))).kind,
    'verified',
  );
  const other = new LocalDurableStore(env.root);
  assert.equal(
    (await other.initializeProjectLifecycle({ repositoryId: 'repo', projectId: 'other-project' }))
      .kind,
    'verified',
  );
  assert.equal(
    (await bindEmptyFixturePlan(other, 'f'.repeat(64), 'b'.repeat(64), 'other-project')).kind,
    'verified',
  );
  await other.append('unrelated-generic-log', { fixture: true });
  const next = await restarted(env);
  assert.equal((await next.store.findProjectLifecycle(lookupFor(env.input))).kind, 'verified');
  assert.equal(
    (
      await next.store.findProjectLifecycle({
        ...lookupFor(env.input),
        inputDigest: 'e'.repeat(64),
      })
    ).value,
    null,
  );
  assert.equal(
    (await bindEmptyFixturePlan(next.store, 'e'.repeat(64), 'c'.repeat(64))).kind,
    'verified',
  );
});

test('same-input creation between discovery and acquisition reuses retained plan without duplicate registration', async (t) => {
  const env = await setup(t),
    input = { version: 1, kind: 'status', lifecycle: env.f.lifecycle };
  const peer = env.controller,
    find = env.store.findProjectLifecycle.bind(env.store);
  let raced = false;
  env.store.findProjectLifecycle = async (q) => {
    const result = await find(q);
    if (!raced && result.kind === 'verified' && result.value === null) {
      raced = true;
      assert.equal((await peer.reconcile(input)).kind, 'verified');
    }
    return result;
  };
  const controller = createOfflineProjectController({
    store: env.store,
    port: env.sim.port,
    resolve: env.sim.resolve,
    resolveRecovery: env.sim.resolveRecovery,
  });
  const resumed = await controller.reconcile(input);
  assert.equal(resumed.kind, 'verified', resumed.reason);
  assert.equal(env.sim.native.calls.length, 1);
  assert.equal(resumed.value.operationId, env.sim.native.calls[0].operationId);
  const { readdir } = await import('node:fs/promises');
  assert.equal(
    (
      await readdir(
        join(env.root, `${digest('project-lifecycle:repo:project')}.project-lifecycle`, 'index'),
      )
    ).length,
    1,
  );
});
test('resumed operation still rejects changed immutable original source revision', async (t) => {
  const env = await setup(t);
  assert.equal((await env.controller.reconcile(env.input)).kind, 'verified');
  env.sim.originals.originals.get('source').revision = 'changed-source-revision';
  const next = await restarted(env);
  assert.notEqual((await next.controller.reconcile(env.input)).kind, 'verified');
  assert.equal(env.sim.native.calls.length, 1);
});

function distinctStatusPort(env, options = {}) {
  return {
    apply: env.sim.port.apply,
    observe: async (request) => {
      const result = await env.sim.port.observe(request);
      if (request.kind === 'status-target') {
        result.value.revision = 'status-view-' + result.value.revision + (options.suffix ?? '');
        if (options.changedOption) result.value.options[5].id = 'changed-released-option';
        const { sourceBindings: _sourceBindings, ...data } = result.value;
        result.value.sourceBindings = [env.sim.binding(result.value.observationRef, data)];
      }
      return result;
    },
  };
}
async function controllerWithStatusPort(env, port) {
  const store = new LocalDurableStore(env.root);
  assert.equal((await store.bindProjectLifecycle(env.identity)).kind, 'verified');
  return createOfflineProjectController({
    store,
    port,
    resolve: env.sim.resolve,
    resolveRecovery: env.sim.resolveRecovery,
  });
}
test('distinct revision domains permit fresh Status mutation and completed restart without duplicate apply', async (t) => {
  const env = await setup(t),
    port = distinctStatusPort(env),
    input = { version: 1, kind: 'status', lifecycle: env.f.lifecycle };
  const first = await (await controllerWithStatusPort(env, port)).reconcile(input);
  assert.equal(first.kind, 'verified', first.reason);
  assert.equal(env.sim.native.calls.length, 1);
  const again = await (await controllerWithStatusPort(env, port)).reconcile(input);
  assert.equal(again.kind, 'verified', again.reason);
  assert.equal(again.value.operationId, first.value.operationId);
  assert.equal(env.sim.native.calls.length, 1);
});
async function recoveredDistinctStatus(t, options = {}) {
  const env = await setup(t),
    port = distinctStatusPort(env, options),
    input = { version: 1, kind: 'status', lifecycle: env.f.lifecycle };
  let failed = false;
  env.sim.native.hooks.apply = async (request) => {
    if (failed) return;
    failed = true;
    env.sim.native.revision++;
    const ref = 'distinct-view-positive-nonexecution';
    env.sim.native.events.set(ref, {
      requestDigest: projectDigest(request),
      sourceBinding: env.sim.binding(ref, { nonexecution: true, request: projectDigest(request) }),
    });
    throw Error('positive nonexecution with distinct views');
  };
  const initial = await (await controllerWithStatusPort(env, port)).reconcile(input);
  assert.equal(initial.kind, 'uncertain');
  assert.equal(env.sim.native.calls.length, 1);
  const original = clone(env.sim.native.calls[0]);
  const recovered = await (
    await controllerWithStatusPort(env, port)
  ).recover({
    version: 1,
    operationId: original.operationId,
    originalInput: input,
    recoveryRef: 'distinct-view-nonexecution-recovery',
    retainedRecords: [],
  });
  assert.equal(recovered.kind, 'verified', recovered.reason);
  return { env, port, input, original };
}
test('distinct revision domains permit confirmed nonexecution release and second-restart immutable Status resume', async (t) => {
  const { env, port, input, original } = await recoveredDistinctStatus(t);
  const resumed = await (await controllerWithStatusPort(env, port)).reconcile(input);
  assert.equal(resumed.kind, 'verified', resumed.reason);
  assert.equal(env.sim.native.calls.length, 2);
  assert.equal(env.sim.native.calls[1].operationId, original.operationId);
  assert.equal(env.sim.native.calls[1].stepId, original.stepId);
  assert.equal(env.sim.native.optionId, 'option-in-progress');
});
for (const change of ['field', 'options', 'unexplained-step-revision', 'stale-original-source'])
  test(`distinct revision resume still rejects ${change}`, async (t) => {
    const options = {},
      { env, port, input } = await recoveredDistinctStatus(t, options);
    if (change === 'field') env.sim.native.fieldId = 'wrong-status-field';
    if (change === 'options') options.changedOption = true;
    if (change === 'unexplained-step-revision') env.sim.native.revision++;
    if (change === 'stale-original-source')
      env.sim.originals.originals.get('source').revision = 'changed-immutable-original';
    const resumed = await (await controllerWithStatusPort(env, port)).reconcile(input);
    assert.notEqual(resumed.kind, 'verified');
    assert.equal(env.sim.native.calls.length, 1);
  });
test('distinct revision domains retain within-attempt public Status query freshness', async (t) => {
  const options = {};
  let env;
  env = await setup(t, planning(), async (name, row) => {
    if (name === 'project-after-append' && row.phase === 'intent') options.suffix = '-changed-view';
  });
  const port = distinctStatusPort(env, options),
    input = { version: 1, kind: 'status', lifecycle: env.f.lifecycle };
  const controller = createOfflineProjectController({
    store: env.store,
    port,
    resolve: env.sim.resolve,
    resolveRecovery: env.sim.resolveRecovery,
  });
  const result = await controller.reconcile(input);
  assert.notEqual(result.kind, 'verified');
  assert.equal(env.sim.native.calls.length, 0);
});

// The composition catches loss of partitioned obligations across durable resume,
// or projection/admission accidentally using the pre-decision scope.
function composedSplit() {
  const f = reparenting(),
    after = f.input.proposed;
  const original = clone(f.snapshot.requirements.find((r) => r.requirementId === 'work'));
  const bytes = Buffer.from(f.bytes);
  after.coverageCatalog.push(
    ...[
      ['a', 0, 8],
      ['b', 8, bytes.length],
    ].map(([suffix, startByte, endByte]) => ({
      ...clone(after.coverageCatalog[0]),
      id: 'coverage-' + suffix,
      startByte,
      endByte,
      textDigest: digest(bytes.subarray(startByte, endByte)),
      parentCoverageId: 'coverage',
    })),
  );
  after.requirements.find((r) => r.requirementId === 'parent-a').coverageIds = ['coverage-b'];
  after.requirements.find((r) => r.requirementId === 'parent-b').coverageIds = ['coverage-a'];
  after.requirements.find((r) => r.requirementId === 'work').coverageIds = ['coverage-a'];
  after.requirements.push({
    ...original,
    requirementId: 'work-b',
    issueNodeId: 'issue-b',
    coverageIds: ['coverage-b'],
    milestoneId: 'v2',
    requiredPrNodeIds: ['pr-b'],
  });
  seal(after);
  f.humanInstruction =
    'split exact acceptance bytes; retain work in v1 under existing parent-b and defer work-b to v2 using reviewed feature-control for coverage-b';
  Object.assign(f.decision, {
    sourceDigest: digest(f.humanInstruction),
    afterScopeDigest: after.revision,
    affectedRequirementIds: ['parent-a', 'parent-b', 'work', 'work-b'],
    destinationMilestoneId: 'v2',
    dispositionRefs: ['incorporation'],
  });
  f.input.dispositions = [
    {
      kind: 'code-disposition',
      decisionRef: 'move',
      scopeDigest: f.snapshot.revision,
      requirementIds: ['work-b'],
      coverageIds: ['coverage-b'],
      targetSha: sha('a'),
      method: 'feature-control',
      sourceSha: sha('b'),
      changeCandidate: candidate(3),
      reviewRef: 'review',
      validationRef: 'tested',
      incorporationRef: 'incorporation',
    },
  ];
  f.links.links.push({
    ...clone(f.links.links.find((l) => l.issueNodeId === 'issue')),
    issueNodeId: 'issue-b',
    projectItemId: 'item-b',
    milestoneId: 'v2',
    prNodeIds: ['pr-b'],
    observationRef: 'child-b-read',
  });
  f.links.links.sort((a, b) => a.issueNodeId.localeCompare(b.issueNodeId));
  return f;
}
test('composed conserved split deferral recovers exact child then projects and admits current version', async (t) => {
  let trip = false;
  const f = composedSplit();
  assert.equal(parseProjectScope(f.input.scope, f.input.evidence).kind, 'verified');
  const env = await setup(t, f, async (name, row) => {
    if (!trip && name === 'project-before-witness' && row.phase === 'receipt') {
      trip = true;
      throw Error('composed detached child receipt fault');
    }
  });
  const originals = env.sim.originals.originals;
  const add = (ref, bytes, actorId = 'native-observer') =>
    originals.set(ref, { bytes, actorId, resourceId: ref, revision: 'retained-r1' });
  add('move', f.humanInstruction, 'owner-node');
  add('child-b-read', JSON.stringify(f.links.links.find((l) => l.issueNodeId === 'issue-b')));
  const d = f.input.dispositions[0];
  add('review', JSON.stringify({ candidate: d.changeCandidate, findings: [] }));
  add('tested', JSON.stringify({ candidate: d.changeCandidate, failures: [] }));
  add(
    'incorporation',
    JSON.stringify({
      candidate: d.changeCandidate,
      targetSha: d.targetSha,
      sourceSha: d.sourceSha,
      coverageIds: d.coverageIds,
      method: d.method,
      disabledBehaviors: [
        { coverageId: 'coverage-b', behavior: 'deferred acceptance behavior disabled' },
      ],
    }),
  );
  enforceCurrentNativeLinks(env);
  const stable = clone(env.sim.native.links);
  const first = await env.controller.reconcile(env.input);
  assert.equal(first.kind, 'uncertain', first.reason);
  assert.equal(env.sim.native.calls.length, 1);
  const operationId = env.sim.native.calls[0].operationId;
  let next = await restarted(env);
  assert.equal((await next.controller.reconcile(env.input)).kind, 'uncertain');
  assert.equal(
    (
      await next.controller.recover({
        version: 1,
        operationId,
        originalInput: env.input,
        recoveryRef: 'composed-exact-detach-recovery',
        retainedRecords: [],
      })
    ).kind,
    'verified',
  );
  next = await restarted(env);
  const resumed = await next.controller.reconcile(env.input);
  assert.equal(resumed.kind, 'verified', resumed.reason);
  assert.equal(resumed.value.operationId, operationId);
  assert.deepEqual(
    env.sim.native.calls.map((q) => q.step.kind),
    ['detach-parent', 'attach-parent'],
  );
  for (const child of env.sim.native.links) {
    const old = stable.find((l) => l.issueNodeId === child.issueNodeId);
    for (const key of ['issueNodeId', 'projectItemId', 'dependencyNodeIds', 'prNodeIds'])
      assert.deepEqual(child[key], old[key]);
  }
  assert.equal(
    env.sim.native.links.find((l) => l.issueNodeId === 'issue').parentNodeId,
    'parent-issue-b',
  );
  const sourceBytes = Buffer.from(f.bytes);
  const partitions = f.input.proposed.coverageCatalog.filter(
    (c) => c.parentCoverageId === 'coverage',
  );
  assert.deepEqual(
    Buffer.concat(partitions.map((c) => sourceBytes.subarray(c.startByte, c.endByte))),
    sourceBytes,
  );
  const accepted = JSON.parse(JSON.stringify(f));
  accepted.history.steps = [
    { decision: clone(f.decision), before: clone(f.snapshot), after: clone(f.input.proposed) },
  ];
  accepted.history.current = accepted.snapshot = clone(f.input.proposed);
  accepted.lifecycle.scope = { kind: 'accepted', history: accepted.history };
  accepted.lifecycle.projection.coverageIds = ['coverage-a'];
  accepted.lifecycle.activities.push({
    issueNodeId: 'issue-b',
    kind: 'inactive',
    observationRef: 'activity-b',
  });
  accepted.lifecycle.prs.push({
    ...clone(accepted.lifecycle.prs[0]),
    prNodeId: 'pr-b',
    issueNodeIds: ['issue-b'],
    candidate: candidate(2),
    observationRef: 'pr-b-observation',
  });
  accepted.lifecycle.prs[0].state = 'merged';
  accepted.lifecycle.integration = [
    {
      requirementId: 'work',
      prNodeId: 'pr1',
      candidate: candidate(),
      mergeSha: sha('b'),
      targetRef: 'refs/heads/develop',
      targetSha: sha('a'),
      validationRefs: ['validation'],
      observationRef: 'integrated-work',
    },
  ];
  accepted.lifecycle.prs.sort((a, b) => a.prNodeId.localeCompare(b.prNodeId));
  refresh(accepted);
  const parsed = parseProjectLifecycle(accepted.lifecycle);
  assert.equal(parsed.kind, 'verified', parsed.reason);
  assert.equal(parsed.value.projectState.status, 'Integrated');
  const disposition = {
    ...clone(f.input.dispositions[0]),
    scopeDigest: accepted.snapshot.revision,
  };
  const evidence = {
    lifecycle: accepted.lifecycle,
    dispositions: [disposition],
    milestoneId: 'v1',
    targetSha: sha('a'),
  };
  // A later complete lifecycle observation is separate from the immutable scope operation.
  const projected = simulator({
    ...accepted,
    decision: f.decision,
    links: { ...f.links, links: clone(env.sim.native.links) },
  });
  for (const ref of ['activity-b', 'pr-b-observation', 'integrated-work'])
    projected.originals.originals.set(ref, {
      bytes: ref,
      actorId: 'fixture-observer',
      resourceId: ref,
      revision: 'retained-r1',
    });
  const controller = createOfflineProjectController({
    store: next.store,
    port: projected.port,
    resolve: projected.resolve,
    resolveRecovery: projected.resolveRecovery,
  });
  const status = await controller.reconcile({
    version: 1,
    kind: 'status',
    lifecycle: accepted.lifecycle,
  });
  assert.equal(status.kind, 'verified', status.reason);
  assert.equal(projected.native.optionId, 'option-integrated');
  for (const ref of ['move', 'review', 'tested', 'incorporation'])
    projected.originals.originals.set(ref, clone(originals.get(ref)));
  const admission = releaseAdmission(accepted.history, evidence);
  assert.equal(admission.kind, 'verified', admission.reason);
  assert.deepEqual(admission.value.completedRequirementIds, ['work']);
  assert.deepEqual(admission.value.deferredRequirementIds, ['work-b']);
  assert.equal(
    releaseAdmission(accepted.history, { ...evidence, dispositions: [] }).kind,
    'blocked',
  );
  const missing = clone(accepted.lifecycle);
  missing.scope = { kind: 'intake', snapshot: accepted.snapshot, nativeObservationRef: 'native' };
  missing.evidence.chains = [];
  assert.equal(
    releaseAdmission(accepted.history, { ...evidence, lifecycle: missing }).kind,
    'blocked',
  );
  const resolvedAdmission = await createOfflineScopeDecisionService({
    resolve: projected.resolve,
  }).releaseAdmission(accepted.history, evidence);
  assert.equal(resolvedAdmission.kind, 'verified', resolvedAdmission.reason);
  assert.deepEqual(resolvedAdmission.value.completedRequirementIds, ['work']);
  assert.deepEqual(resolvedAdmission.value.deferredRequirementIds, ['work-b']);
});
