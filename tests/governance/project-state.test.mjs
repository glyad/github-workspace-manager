import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveProjectState,
  parseProjectLifecycle,
  parseProjectScope,
} from '../../tools/governance/project-state.mjs';
import { projectDigest } from '../../tools/governance/project-baseline.mjs';
import { digest } from '../../tools/governance/journal.mjs';

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
const derive = (f) =>
  deriveProjectState(
    f.snapshot.requirements,
    f.lifecycle.integration,
    f.lifecycle.publication,
    f.lifecycle,
  );

test('intake remains Backlog with imported decision references, and positive activity gives In progress', () => {
  const f = fixture({ accepted: false });
  f.lifecycle.prs = [];
  assert.equal(derive(f).status, 'Backlog');
  f.lifecycle.activities[0].kind = 'active';
  assert.equal(derive(f).status, 'In progress');
  assert.equal(derive(f).closure.kind, 'blocked');
});
test('accepted mapping is Planned until positive work evidence; Draft is In progress', () => {
  const f = fixture();
  f.lifecycle.prs[0].state = 'closed-unmerged';
  assert.equal(derive(f).status, 'Planned');
  assert.equal(derive(f).closure.kind, 'blocked');
  f.lifecycle.prs[0].state = 'open';
  assert.equal(derive(f).status, 'In progress');
});
test('closed-unmerged required PR blocks completion and records exact requirement and evidence', () => {
  const f = fixture();
  f.lifecycle.prs[0].state = 'closed-unmerged';
  const state = derive(f);
  assert.ok(
    state.blockers.some(
      (b) =>
        b.code === 'closed-unmerged' &&
        b.requirementIds.includes('work') &&
        b.evidenceRefs.includes('pr-observation'),
    ),
  );
  assert.equal(state.closure.kind, 'blocked');
});
test('missing required PR and activity cannot promote or close', () => {
  const f = fixture();
  f.lifecycle.prs = [];
  f.lifecycle.activities = [];
  const state = derive(f);
  assert.equal(state.status, 'Planned');
  assert.ok(state.blockers.some((b) => b.code === 'missing-pr'));
  assert.ok(state.blockers.some((b) => b.code === 'missing-activity'));
  assert.equal(state.closure.kind, 'blocked');
});
test('argument disagreement prevents new promotion', () => {
  const f = fixture();
  const state = deriveProjectState([], [], [], f.lifecycle);
  assert.equal(state.status, 'Backlog');
  assert.ok(state.blockers.some((b) => b.code === 'argument-mismatch'));
});
test('accessors and proxies are rejected without executing producer code', () => {
  let calls = 0;
  const f = fixture();
  Object.defineProperty(f.lifecycle, 'scope', {
    get() {
      calls++;
      throw Error('producer');
    },
    enumerable: true,
  });
  assert.equal(derive(f).status, 'Backlog');
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        throw Error('producer');
      },
    },
  );
  assert.equal(deriveProjectState([], [], [], proxy).status, 'Backlog');
  assert.equal(calls, 0);
});
test('zero-required-PR leaves do not vacuously complete or close', () => {
  const f = fixture();
  f.snapshot.requirements[0].requiredPrNodeIds = [];
  refresh(f);
  f.lifecycle.prs = [];
  const state = derive(f);
  assert.equal(state.status, 'Planned');
  assert.equal(state.closure.kind, 'blocked');
  assert.ok(state.blockers.some((b) => b.code === 'empty-required-prs'));
});
for (const [name, change] of [
  [
    'wrong projection issue',
    (f) => {
      f.lifecycle.projection.issueNodeId = 'other';
    },
  ],
  [
    'missing projection coverage',
    (f) => {
      f.lifecycle.projection.coverageIds = [];
    },
  ],
  [
    'wrong projection revision',
    (f) => {
      f.lifecycle.projection.scopeRevision = 'c'.repeat(64);
    },
  ],
  [
    'unknown envelope field',
    (f) => {
      f.lifecycle.trusted = true;
    },
  ],
  [
    'wrong repository',
    (f) => {
      f.lifecycle.repositoryId = 'other';
    },
  ],
  [
    'duplicate native PR',
    (f) => {
      f.lifecycle.prs.push(structuredClone(f.lifecycle.prs[0]));
    },
  ],
  [
    'duplicate activity',
    (f) => {
      f.lifecycle.activities.push(structuredClone(f.lifecycle.activities[0]));
    },
  ],
  [
    'unknown PR discriminant',
    (f) => {
      f.lifecycle.prs[0].state = 'closed';
    },
  ],
  [
    'nonboolean Draft',
    (f) => {
      f.lifecycle.prs[0].draft = 'false';
    },
  ],
  [
    'candidate extra field',
    (f) => {
      f.lifecycle.prs[0].candidate.trusted = true;
    },
  ],
])
  test(`${name} fails closed`, () => {
    const f = fixture();
    change(f);
    const state = derive(f);
    assert.equal(state.status, 'Backlog');
    assert.ok(state.blockers.length > 0);
    assert.equal(state.closure.kind, 'blocked');
  });
for (const [name, change] of [
  [
    'duplicate requirement',
    (s) => {
      s.requirements.push(structuredClone(s.requirements[0]));
    },
  ],
  [
    'duplicate catalog ID',
    (s) => {
      s.coverageCatalog.push(structuredClone(s.coverageCatalog[0]));
    },
  ],
  [
    'undefined coverage ID',
    (s) => {
      s.requirements[0].coverageIds = ['absent'];
    },
  ],
  [
    'cyclic coverage',
    (s) => {
      s.coverageCatalog[0].parentCoverageId = 'coverage';
    },
  ],
  [
    'cyclic dependency',
    (s) => {
      s.requirements[0].dependencyRequirementIds = ['work'];
    },
  ],
  [
    'unknown mapping field',
    (s) => {
      s.requirements[0].completed = true;
    },
  ],
  [
    'changed source identity',
    (s) => {
      s.coverageCatalog[0].sourceKey = 'replacement';
    },
  ],
])
  test(`${name} cannot create accepted state`, () => {
    const f = fixture();
    change(f.snapshot);
    seal(f.snapshot);
    f.lifecycle.projection.scopeRevision = f.snapshot.revision;
    assert.equal(derive(f).status, 'Backlog');
    assert.equal(derive(f).closure.kind, 'blocked');
  });
test('output is a defensive snapshot and mutation never alters the input', () => {
  const f = fixture();
  const before = structuredClone(f);
  const state = derive(f);
  assert.deepEqual(f, before);
  assert.deepEqual(state.projection, f.lifecycle.projection);
  state.projection.coverageIds.push('tampered');
  assert.deepEqual(f.lifecycle.projection.coverageIds, ['coverage']);
});

function ready(f, pr = f.lifecycle.prs[0]) {
  pr.draft = false;
  pr.readinessRef = 'ready-' + pr.prNodeId;
  pr.ciRef = 'ci-' + pr.prNodeId;
  f.lifecycle.evidence.readiness.push({
    ref: pr.readinessRef,
    kind: 'readiness',
    repositoryId: 'repo',
    prNodeId: pr.prNodeId,
    candidate: structuredClone(pr.candidate),
    eventKind: 'ready_for_review',
    observationRef: pr.observationRef,
  });
  f.lifecycle.evidence.ci.push({
    ref: pr.ciRef,
    kind: 'ci',
    repositoryId: 'repo',
    prNodeId: pr.prNodeId,
    candidate: structuredClone(pr.candidate),
    conclusion: 'success',
    runId: 'run-' + pr.prNodeId,
    checkId: 'check-' + pr.prNodeId,
    observationRef: pr.observationRef,
  });
}
function integrate(f, requirementId = 'work', pr = f.lifecycle.prs[0]) {
  pr.state = 'merged';
  f.lifecycle.integration.push({
    requirementId,
    prNodeId: pr.prNodeId,
    candidate: structuredClone(pr.candidate),
    mergeSha: sha('d'),
    targetRef: 'refs/heads/develop',
    targetSha: f.lifecycle.integrationTarget.sha,
    validationRefs: ['validation'],
    observationRef: 'integration-' + pr.prNodeId,
  });
}
function publish(
  f,
  {
    requirementId = 'work',
    kind = 'hotfix',
    coverageIds = f.snapshot.requirements.find((r) => r.requirementId === requirementId)
      .coverageIds,
    snapshot = f.snapshot,
  } = {},
) {
  const fact = {
    requirementId,
    kind,
    releaseId: 'release',
    tagRef: 'refs/tags/v1',
    tagSha: sha('c'),
    candidateSha: sha('b'),
    inclusionRef: 'publication',
    observationRef: 'published',
  };
  f.lifecycle.publication.push(fact);
  f.lifecycle.evidence.publications.push({
    ref: 'publication',
    kind: 'publication-inclusion',
    inclusion: {
      publicationId: fact.releaseId,
      repositoryId: 'repo',
      projectId: 'project',
      acceptedScopeRevision: snapshot.revision,
      coverageIds,
      tagSha: fact.tagSha,
      candidateSha: fact.candidateSha,
      evidenceRef: 'included',
    },
    snapshot: structuredClone(snapshot),
  });
}
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
function projected(f) {
  const selected = f.snapshot.requirements.filter(
    (r) =>
      r.issueNodeId === f.lifecycle.projection.issueNodeId ||
      (r.role === 'leaf' &&
        (f.lifecycle.projection.milestoneId === null ||
          r.milestoneId === f.lifecycle.projection.milestoneId)),
  );
  const keys = new Set(selected.map((r) => r.requirementId));
  return deriveProjectState(
    selected,
    f.lifecycle.integration.filter((x) => keys.has(x.requirementId)),
    f.lifecycle.publication.filter((x) => keys.has(x.requirementId)),
    f.lifecycle,
  );
}

test('In review requires exact Ready and passing CI; nondraft alone stays In progress', () => {
  const f = fixture();
  f.lifecycle.prs[0].draft = false;
  assert.equal(derive(f).status, 'In progress');
  ready(f);
  assert.equal(derive(f).status, 'In review');
  assert.equal(derive(f).closure.kind, 'blocked');
});
for (const [name, mutate] of [
  [
    'CI head changed',
    (f) => {
      f.lifecycle.evidence.ci[0].candidate.head = sha('c');
    },
  ],
  [
    'CI base changed',
    (f) => {
      f.lifecycle.evidence.ci[0].candidate.base = sha('c');
    },
  ],
  [
    'Ready head changed',
    (f) => {
      f.lifecycle.evidence.readiness[0].candidate.head = sha('c');
    },
  ],
  [
    'Ready window changed',
    (f) => {
      f.lifecycle.evidence.readiness[0].observationRef = 'previous';
    },
  ],
  [
    'CI window changed',
    (f) => {
      f.lifecycle.evidence.ci[0].observationRef = 'previous';
    },
  ],
  [
    'native base advanced',
    (f) => {
      f.lifecycle.integrationTarget.sha = sha('c');
    },
  ],
  [
    'Draft revision',
    (f) => {
      f.lifecycle.prs[0].draft = true;
    },
  ],
])
  test(`${name} cannot promote In review`, () => {
    const f = fixture();
    ready(f);
    mutate(f);
    assert.equal(derive(f).status, 'In progress');
    assert.equal(derive(f).closure.kind, 'blocked');
  });
test('all required PRs must be Ready or integrated, each with distinct candidate', () => {
  const f = fixture();
  const second = {
    ...structuredClone(f.lifecycle.prs[0]),
    prNodeId: 'pr2',
    candidate: candidate(2),
    observationRef: 'pr2-observation',
  };
  f.lifecycle.prs.push(second);
  f.snapshot.requirements[0].requiredPrNodeIds.push('pr2');
  refresh(f);
  ready(f);
  assert.equal(derive(f).status, 'In progress');
  ready(f, second);
  assert.equal(derive(f).status, 'In review');
  integrate(f);
  assert.equal(derive(f).status, 'In review');
  integrate(f, 'work', second);
  assert.equal(derive(f).status, 'Integrated');
  assert.equal(derive(f).closure.kind, 'eligible');
  second.state = 'closed-unmerged';
  assert.equal(derive(f).status, 'In progress');
  assert.equal(derive(f).closure.kind, 'blocked');
});
test('hotfix Released before integration remains Released after integration and later blockers', () => {
  const f = fixture();
  publish(f);
  assert.equal(derive(f).status, 'Released');
  assert.equal(derive(f).closure.kind, 'blocked');
  integrate(f);
  assert.equal(derive(f).status, 'Released');
  assert.equal(derive(f).closure.kind, 'eligible');
  f.lifecycle.integrationTarget.sha = sha('f');
  assert.equal(derive(f).status, 'Released');
  assert.equal(derive(f).closure.kind, 'blocked');
  assert.equal(derive(f).publicationFacts.length, 1);
});
test('RC-only evidence is retained without Released status', () => {
  const f = fixture();
  publish(f, { kind: 'rc' });
  integrate(f);
  assert.equal(derive(f).status, 'Integrated');
  assert.equal(derive(f).publicationFacts[0].kind, 'rc');
});
test('integration must cover exact develop target and have independent validation evidence', () => {
  const f = fixture();
  integrate(f);
  assert.equal(derive(f).status, 'Integrated');
  f.lifecycle.integration[0].targetSha = sha('f');
  assert.notEqual(derive(f).status, 'Integrated');
  f.lifecycle.integration[0].targetSha = sha('a');
  f.lifecycle.integration[0].validationRefs = [];
  assert.equal(derive(f).status, 'Backlog');
});
test('mixed-version parent follows leaf coverage; a published child slice does not release parent', () => {
  const f = splitFixture();
  assert.equal(derive(f).status, 'In progress');
  publish(f, { requirementId: 'work-a', coverageIds: ['coverage-a'] });
  assert.equal(derive(f).status, 'In progress');
  assert.equal(derive(f).publicationFacts.length, 1);
  f.lifecycle.projection.milestoneId = 'v1';
  f.lifecycle.projection.coverageIds = ['coverage-a'];
  assert.equal(projected(f).status, 'Released');
  assert.deepEqual(projected(f).requirementIds, ['work', 'work-a']);
  f.lifecycle.projection.milestoneId = 'v2';
  f.lifecycle.projection.coverageIds = ['coverage-b'];
  assert.notEqual(projected(f).status, 'Released');
});
test('historical publication transfers over accepted exact split after serialization/reload', () => {
  const f = splitFixture();
  publish(f, {
    requirementId: 'work',
    coverageIds: ['coverage'],
    snapshot: f.history.acceptedBaseline.snapshot,
  });
  assert.equal(derive(JSON.parse(JSON.stringify(f))).status, 'Released');
  assert.deepEqual(
    f.snapshot.requirements.slice(1).map((r) => r.issueNodeId),
    ['issue-a', 'issue-b'],
  );
});
test('selected slice rejects caller omission, extra mappings and wrong fact subset', () => {
  const f = splitFixture();
  f.lifecycle.projection.milestoneId = 'v1';
  f.lifecycle.projection.coverageIds = ['coverage-a'];
  assert.equal(
    deriveProjectState([f.snapshot.requirements[0]], [], [], f.lifecycle).status,
    'Backlog',
  );
  assert.equal(derive(f).status, 'Backlog');
  integrate(f, 'work-b', f.lifecycle.prs[1]);
  assert.equal(
    deriveProjectState(
      f.snapshot.requirements.slice(0, 2),
      f.lifecycle.integration,
      [],
      f.lifecycle,
    ).status,
    'Backlog',
  );
  assert.equal(projected(f).status, 'In progress');
});

function repairStep(f) {
  for (const step of f.history.steps) {
    seal(step.before);
    seal(step.after);
    step.decision.beforeScopeDigest = step.before.revision;
    step.decision.afterScopeDigest = step.after.revision;
  }
  refresh(f);
}
for (const [name, mutate] of [
  [
    'overlapping partition',
    (f) => {
      f.snapshot.coverageCatalog[2].startByte = 7;
      f.snapshot.coverageCatalog[2].textDigest = digest(Buffer.from(f.bytes).subarray(7));
    },
  ],
  [
    'gapped partition',
    (f) => {
      f.snapshot.coverageCatalog[2].startByte = 9;
      f.snapshot.coverageCatalog[2].textDigest = digest(Buffer.from(f.bytes).subarray(9));
    },
  ],
  [
    'inactive ancestor changed',
    (f) => {
      f.snapshot.coverageCatalog[0].textDigest = digest('altered');
    },
  ],
  [
    'ancestor catalog omitted',
    (f) => {
      f.snapshot.coverageCatalog.shift();
    },
  ],
  [
    'skipped split parent',
    (f) => {
      f.snapshot.coverageCatalog[1].parentCoverageId = 'coverage-b';
    },
  ],
  [
    'same Issue split across milestones',
    (f) => {
      f.snapshot.requirements[2].issueNodeId = 'issue-a';
    },
  ],
  [
    'child Issue cloned from old identity',
    (f) => {
      f.snapshot.requirements[0].issueNodeId = 'new-parent-identity';
    },
  ],
  [
    'affected set omits child',
    (f) => {
      f.history.steps[0].decision.affectedRequirementIds = ['work', 'work-a'];
    },
  ],
  [
    'no owner split decision',
    (f) => {
      f.history.steps[0].decision.kind = 'reschedule';
    },
  ],
  [
    'original requirement removed',
    (f) => {
      f.snapshot.requirements.shift();
      f.snapshot.requirements.forEach((r) => {
        r.parentRequirementId = null;
      });
    },
  ],
  [
    'catalog source migrated',
    (f) => {
      f.snapshot.coverageCatalog[1].sourceDigest = digest('new-source');
    },
  ],
  [
    'aggregate double counts ancestor',
    (f) => {
      f.snapshot.requirements[0].coverageIds = ['coverage', 'coverage-a', 'coverage-b'];
    },
  ],
])
  test(`${name} is rejected after fresh digests`, () => {
    const f = splitFixture();
    mutate(f);
    repairStep(f);
    assert.equal(derive(f).status, 'Backlog');
    assert.equal(derive(f).closure.kind, 'blocked');
  });
test('accepted chain detects omitted, reordered and duplicated decisions against retained observation', () => {
  for (const mutate of [
    (f) => {
      f.history.steps = [];
    },
    (f) => {
      f.lifecycle.evidence.chains[0].orderedDecisionIds = ['different'];
    },
    (f) => {
      f.history.steps.push(structuredClone(f.history.steps[0]));
    },
    (f) => {
      f.history.steps[0].before.decisionRefs = [];
      seal(f.history.steps[0].before);
    },
  ]) {
    const f = splitFixture();
    mutate(f);
    assert.equal(derive(f).status, 'Backlog');
  }
});
function addedFixture() {
  const f = fixture();
  const before = structuredClone(f.snapshot);
  f.history.acceptedBaseline.snapshot = before;
  const bytes = Buffer.from('new acceptance');
  const sourceDigest = digest(bytes);
  f.snapshot.requirements.push({
    ...structuredClone(f.snapshot.requirements[0]),
    requirementId: 'work-new',
    sourceKey: 'new-source',
    sourceDigest,
    acceptanceDigest: sourceDigest,
    coverageIds: ['coverage-new'],
    issueNodeId: 'issue-new',
    parentRequirementId: null,
    requiredPrNodeIds: [],
  });
  f.snapshot.coverageCatalog.push({
    id: 'coverage-new',
    sourceKey: 'new-source',
    sourceDigest,
    startByte: 0,
    endByte: bytes.length,
    textDigest: sourceDigest,
    parentCoverageId: null,
  });
  f.lifecycle.evidence.sources.push({
    ref: 'source-new',
    kind: 'source',
    sourceKey: 'new-source',
    sourceDigest,
    utf8Bytes: [...bytes],
  });
  f.snapshot.decisionRefs = ['accept', 'new-acceptance'];
  seal(f.snapshot);
  const decision = {
    version: 1,
    decisionId: 'new-acceptance',
    repositoryId: 'repo',
    ownerActorId: 'owner-id',
    sourceRef: 'human-addition',
    sourceDigest: digest('accept new source'),
    beforeScopeDigest: before.revision,
    afterScopeDigest: f.snapshot.revision,
    kind: 'accept-version',
    affectedRequirementIds: ['work-new'],
    destinationMilestoneId: 'v1',
    closedPrNodeIds: [],
    dispositionRefs: [],
  };
  f.history.steps = [{ decision, before, after: f.snapshot }];
  refresh(f);
  return f;
}
test('new root acceptance is explicit, retains prior obligations, and inherits no old publication', () => {
  const f = addedFixture();
  const r = f.snapshot.requirements[1];
  f.lifecycle.projection.issueNodeId = r.issueNodeId;
  f.lifecycle.projection.coverageIds = r.coverageIds;
  const state = deriveProjectState([r], [], [], f.lifecycle);
  assert.equal(state.status, 'Planned');
  publish(f, { snapshot: f.history.acceptedBaseline.snapshot, coverageIds: ['coverage'] });
  assert.notEqual(deriveProjectState([r], [], [], f.lifecycle).status, 'Released');
  f.history.steps[0].decision.kind = 'reschedule';
  assert.equal(deriveProjectState([r], [], [], f.lifecycle).status, 'Backlog');
});
for (const [name, mutate] of [
  [
    'missing source',
    (f) => {
      f.lifecycle.evidence.sources = [];
    },
  ],
  [
    'extra source',
    (f) => {
      f.lifecycle.evidence.sources.push({
        ...structuredClone(f.lifecycle.evidence.sources[0]),
        ref: 'source2',
        sourceKey: 'extra',
      });
    },
  ],
  [
    'duplicate source identity',
    (f) => {
      f.lifecycle.evidence.sources.push({
        ...structuredClone(f.lifecycle.evidence.sources[0]),
        ref: 'source2',
      });
    },
  ],
  [
    'duplicate global ref',
    (f) => {
      ready(f);
      f.lifecycle.evidence.ci[0].ref = f.lifecycle.evidence.readiness[0].ref;
    },
  ],
  [
    'missing Ready payload',
    (f) => {
      f.lifecycle.prs[0].readinessRef = 'missing';
    },
  ],
  [
    'wrong evidence kind',
    (f) => {
      f.lifecycle.prs[0].readinessRef = 'source';
    },
  ],
  [
    'unknown evidence field',
    (f) => {
      f.lifecycle.evidence.trusted = true;
    },
  ],
  [
    'source digest mismatch',
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes[0] = 65;
    },
  ],
  [
    'negative byte',
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes[0] = -1;
    },
  ],
  [
    'fractional byte',
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes[0] = 0.5;
    },
  ],
  [
    'large byte',
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes[0] = 256;
    },
  ],
  [
    'sparse bytes',
    (f) => {
      delete f.lifecycle.evidence.sources[0].utf8Bytes[0];
    },
  ],
  [
    'native typed bytes outside JSON seam',
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes = new Uint8Array([1]);
    },
  ],
  [
    'unreferenced Ready',
    (f) => {
      ready(f);
      f.lifecycle.prs[0].readinessRef = null;
    },
  ],
  [
    'reused numeric PR identity',
    (f) => {
      f.lifecycle.prs.push({ ...structuredClone(f.lifecycle.prs[0]), prNodeId: 'pr2' });
    },
  ],
])
  test(`${name} fails evidence validation`, () => {
    const f = fixture();
    mutate(f);
    assert.equal(derive(f).status, 'Backlog');
  });
test('invalid UTF-8 bytes never become accepted even with a matching declared byte digest', () => {
  const f = fixture();
  const bytes = [0xc0, 0x80];
  const sourceDigest = digest(Uint8Array.from(bytes));
  Object.assign(f.lifecycle.evidence.sources[0], { utf8Bytes: bytes, sourceDigest });
  Object.assign(f.snapshot.requirements[0], { sourceDigest, acceptanceDigest: sourceDigest });
  Object.assign(f.snapshot.coverageCatalog[0], {
    sourceDigest,
    textDigest: sourceDigest,
    endByte: 2,
  });
  refresh(f);
  assert.equal(derive(f).status, 'Backlog');
});
test('valid BOM and multibyte acceptance bytes are preserved; split inside a code point is rejected', () => {
  const f = fixture();
  const bytes = Buffer.from('\ufeffé🙂');
  const sourceDigest = digest(bytes);
  Object.assign(f.lifecycle.evidence.sources[0], { utf8Bytes: [...bytes], sourceDigest });
  Object.assign(f.snapshot.requirements[0], { sourceDigest, acceptanceDigest: sourceDigest });
  Object.assign(f.snapshot.coverageCatalog[0], {
    sourceDigest,
    textDigest: sourceDigest,
    endByte: bytes.length,
  });
  refresh(f);
  assert.equal(derive(f).status, 'In progress');
  f.snapshot.coverageCatalog[0].startByte = 1;
  f.snapshot.coverageCatalog[0].textDigest = digest(bytes.subarray(1));
  refresh(f);
  assert.equal(derive(f).status, 'Backlog');
});
for (const [name, mutate] of [
  [
    'disconnected historical revision',
    (f) => {
      f.lifecycle.evidence.publications[0].snapshot.decisionRefs.push('other');
      seal(f.lifecycle.evidence.publications[0].snapshot);
      f.lifecycle.evidence.publications[0].inclusion.acceptedScopeRevision =
        f.lifecycle.evidence.publications[0].snapshot.revision;
    },
  ],
  [
    'wrong publication tag',
    (f) => {
      f.lifecycle.evidence.publications[0].inclusion.tagSha = sha('d');
    },
  ],
  [
    'wrong publication identity',
    (f) => {
      f.lifecycle.evidence.publications[0].inclusion.publicationId = 'other';
    },
  ],
  [
    'wrong historical coverage',
    (f) => {
      f.lifecycle.evidence.publications[0].inclusion.coverageIds = ['absent'];
    },
  ],
  [
    'changed historical catalog',
    (f) => {
      f.lifecycle.evidence.publications[0].snapshot.coverageCatalog[0].endByte--;
    },
  ],
])
  test(`${name} cannot project Released`, () => {
    const f = fixture();
    publish(f);
    mutate(f);
    assert.equal(derive(f).status, 'Backlog');
  });

test('bounds, symbols, cycles and producer byte descriptors fail before callbacks or coercion', () => {
  let calls = 0;
  const changes = [
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes = new Array(1048577).fill(0);
    },
    (f) => {
      f.lifecycle.evidence.sources = new Array(1001).fill(f.lifecycle.evidence.sources[0]);
    },
    (f) => {
      f.lifecycle.observationRef = 'x'.repeat(1048577);
    },
    (f) => {
      f.lifecycle[Symbol('hidden')] = 'data';
    },
    (f) => {
      f.lifecycle.evidence.cycle = f.lifecycle;
    },
    (f) => {
      Object.defineProperty(f.lifecycle.evidence.sources[0].utf8Bytes, '0', {
        get() {
          calls++;
          return 1;
        },
        enumerable: true,
      });
    },
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes[0] = {
        valueOf() {
          calls++;
          return 1;
        },
      };
    },
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes = new Proxy([], {
        ownKeys() {
          calls++;
          return [];
        },
      });
    },
    (f) => {
      f.lifecycle.evidence.sources[0].utf8Bytes.toJSON = () => {
        calls++;
        return [];
      };
    },
    (f) => {
      Object.setPrototypeOf(f.lifecycle, {
        toJSON() {
          calls++;
          return {};
        },
      });
    },
    (f) => {
      let nested = {};
      f.lifecycle.evidence.nested = nested;
      for (let i = 0; i < 33; i++) {
        nested.child = {};
        nested = nested.child;
      }
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.equal(derive(f).status, 'Backlog');
  }
  assert.equal(calls, 0);
});
test('In review cannot be promoted by cross-PR readiness reference reuse', () => {
  const f = fixture();
  ready(f);
  const p = { ...structuredClone(f.lifecycle.prs[0]), prNodeId: 'pr2', candidate: candidate(2) };
  f.lifecycle.prs.push(p);
  f.snapshot.requirements[0].requiredPrNodeIds.push('pr2');
  refresh(f);
  assert.notEqual(derive(f).status, 'In review');
});
test('intake cannot import acceptance, readiness, integration or publication into advanced state', () => {
  for (const mutate of [
    (f) => {
      ready(f);
    },
    (f) => {
      integrate(f);
    },
    (f) => {
      publish(f);
    },
  ]) {
    const f = fixture({ accepted: false });
    mutate(f);
    assert.ok(['Backlog', 'In progress'].includes(derive(f).status));
    assert.equal(derive(f).closure.kind, 'blocked');
  }
});
test('missing activity blocks even otherwise complete integration without erasing observed work', () => {
  const f = fixture();
  integrate(f);
  f.lifecycle.activities = [];
  assert.equal(derive(f).status, 'In progress');
  assert.equal(derive(f).closure.kind, 'blocked');
  assert.ok(derive(f).blockers.some((b) => b.code === 'missing-activity'));
});
test('merged flag without inclusion/validation and closed counts do not establish integration', () => {
  const f = fixture();
  f.lifecycle.prs[0].state = 'merged';
  assert.equal(derive(f).status, 'Planned');
  assert.equal(derive(f).closure.kind, 'blocked');
  assert.ok(derive(f).blockers.some((b) => b.code === 'missing-integration'));
});

test('new exact integration proof can coexist with retained earlier target facts', () => {
  const f = fixture();
  integrate(f);
  f.lifecycle.integrationTarget.sha = sha('f');
  assert.notEqual(derive(f).status, 'Integrated');
  integrate(f);
  assert.equal(derive(f).status, 'Integrated');
  assert.equal(derive(f).integrationFacts.length, 2);
});

test('shared pure parsers return defensive normalized data and exact selected subsets only', () => {
  const f = splitFixture();
  const parsedScope = parseProjectScope(f.lifecycle.scope, f.lifecycle.evidence);
  assert.equal(parsedScope.kind, 'verified');
  assert.deepEqual(parsedScope.value.scope, f.lifecycle.scope);
  f.lifecycle.projection.milestoneId = 'v1';
  f.lifecycle.projection.coverageIds = ['coverage-a'];
  const parsed = parseProjectLifecycle(f.lifecycle);
  assert.equal(parsed.kind, 'verified');
  assert.deepEqual(
    parsed.value.requirements.map((r) => r.requirementId),
    ['work', 'work-a'],
  );
  assert.deepEqual(
    deriveProjectState(
      parsed.value.requirements,
      parsed.value.integrationFacts,
      parsed.value.publicationFacts,
      parsed.value.lifecycle,
    ),
    parsed.value.projectState,
  );
  parsed.value.lifecycle.projection.coverageIds.push('changed');
  assert.deepEqual(f.lifecycle.projection.coverageIds, ['coverage-a']);
  parsedScope.value.scope.history.current.requirements[0].issueNodeId = 'changed';
  assert.equal(f.snapshot.requirements[0].issueNodeId, 'issue');
});
test('scope-only parser rejects readiness data and preserves intake without fabricated baseline', () => {
  const f = fixture({ accepted: false });
  assert.equal(parseProjectScope(f.lifecycle.scope, f.lifecycle.evidence).kind, 'verified');
  const accepted = fixture();
  ready(accepted);
  assert.equal(
    parseProjectScope(accepted.lifecycle.scope, accepted.lifecycle.evidence).kind,
    'blocked',
  );
  accepted.lifecycle.projection.scopeRevision = 'f'.repeat(64);
  assert.equal(parseProjectLifecycle(accepted.lifecycle).kind, 'blocked');
});

// Review round 1: four policy regressions, each with a positive counterpart.
for (const evidenceKind of ['readiness', 'ci']) {
  for (const slice of [true, false]) {
    test(`unselected stale ${evidenceKind} does not block ${slice ? 'milestone slice' : 'complete child Issue'}`, () => {
      const f = splitFixture();
      integrate(f, 'work-a', f.lifecycle.prs[0]);
      f.lifecycle.projection.coverageIds = ['coverage-a'];
      if (slice) f.lifecycle.projection.milestoneId = 'v1';
      else f.lifecycle.projection.issueNodeId = 'issue-a';
      ready(f, f.lifecycle.prs[1]);
      f.lifecycle.evidence[evidenceKind][0].candidate.head = sha('e');
      const parsed = parseProjectLifecycle(f.lifecycle);
      assert.equal(parsed.kind, 'verified');
      assert.equal(parsed.value.projectState.status, 'Integrated');
      assert.equal(parsed.value.projectState.closure.kind, 'eligible');
      assert.deepEqual(parsed.value.projectState.blockers, []);
      const { requirements, integrationFacts, publicationFacts, lifecycle } = parsed.value;
      assert.deepEqual(
        deriveProjectState(requirements, integrationFacts, publicationFacts, lifecycle),
        parsed.value.projectState,
      );
      f.lifecycle.projection.issueNodeId = 'issue';
      f.lifecycle.projection.milestoneId = null;
      f.lifecycle.projection.coverageIds = ['coverage-a', 'coverage-b'];
      assert.ok(
        derive(f).blockers.some(
          (b) => b.code === 'stale-' + evidenceKind && b.requirementIds.includes('work-b'),
        ),
      );
      f.lifecycle.projection.issueNodeId = 'issue-a';
      f.lifecycle.projection.coverageIds = ['coverage-a'];
      f.lifecycle.evidence[evidenceKind][0].extra = true;
      assert.equal(parseProjectLifecycle(f.lifecycle).kind, 'blocked');
    });
  }
}
function secondPublication(f, { sameIdentity = false } = {}) {
  const fact = structuredClone(f.lifecycle.publication[0]);
  const row = structuredClone(f.lifecycle.evidence.publications[0]);
  fact.requirementId = 'work-b';
  fact.inclusionRef = row.ref = 'publication-2';
  row.inclusion.coverageIds = ['coverage-b'];
  if (!sameIdentity) {
    fact.releaseId = row.inclusion.publicationId = 'release-2';
    fact.tagRef = 'refs/tags/v2';
    fact.tagSha = row.inclusion.tagSha = sha('e');
    fact.candidateSha = row.inclusion.candidateSha = sha('f');
  }
  f.lifecycle.publication.push(fact);
  f.lifecycle.evidence.publications.push(row);
}
test('unrelated final publication artifacts cannot jointly release a parent', () => {
  const f = splitFixture();
  publish(f, { requirementId: 'work-a', coverageIds: ['coverage-a'] });
  secondPublication(f);
  assert.equal(derive(f).status, 'In progress');
  assert.equal(derive(f).publicationFacts.length, 2);
  f.lifecycle.projection.milestoneId = 'v1';
  f.lifecycle.projection.coverageIds = ['coverage-a'];
  assert.equal(projected(f).status, 'Released');
  f.lifecycle.projection.milestoneId = 'v2';
  f.lifecycle.projection.coverageIds = ['coverage-b'];
  assert.equal(projected(f).status, 'Released');
});
test('one immutable final publication can cover the whole parent through distinct inclusion records', () => {
  const f = splitFixture();
  publish(f, { requirementId: 'work-a', coverageIds: ['coverage-a'] });
  secondPublication(f, { sameIdentity: true });
  assert.equal(derive(f).status, 'Released');
  assert.equal(derive(f).publicationFacts.length, 2);
});
function unchangedCatalogTransfer(kind) {
  const f = fixture();
  const before = structuredClone(f.snapshot);
  f.history.acceptedBaseline.snapshot = before;
  f.snapshot.requirements[0].role = 'aggregate';
  f.snapshot.requirements[0].requiredPrNodeIds = [];
  f.snapshot.requirements.push({
    ...structuredClone(before.requirements[0]),
    requirementId: 'work-child',
    issueNodeId: 'issue-child',
    parentRequirementId: 'work',
  });
  f.snapshot.decisionRefs.push('transfer');
  seal(f.snapshot);
  f.history.steps = [
    {
      before,
      after: f.snapshot,
      decision: {
        version: 1,
        decisionId: 'transfer',
        repositoryId: 'repo',
        ownerActorId: 'owner-id',
        sourceRef: 'human-original',
        sourceDigest: digest('transfer'),
        beforeScopeDigest: before.revision,
        afterScopeDigest: f.snapshot.revision,
        kind,
        affectedRequirementIds: ['work', 'work-child'],
        destinationMilestoneId: 'v1',
        closedPrNodeIds: [],
        dispositionRefs: [],
      },
    },
  ];
  f.lifecycle.activities[0].issueNodeId = 'issue-child';
  f.lifecycle.prs[0].issueNodeIds = ['issue-child'];
  integrate(f, 'work-child');
  refresh(f);
  return f;
}
for (const kind of ['reschedule', 'accept-version'])
  test(`${kind} cannot convert leaf or transfer unchanged catalog ownership`, () => {
    const f = unchangedCatalogTransfer(kind);
    assert.equal(parseProjectScope(f.lifecycle.scope, f.lifecycle.evidence).kind, 'blocked');
    assert.equal(derive(f).status, 'Backlog');
  });
test('explicit split may transfer whole conserved coverage to an existing child without catalog subdivision', () => {
  const f = unchangedCatalogTransfer('split');
  assert.equal(parseProjectScope(f.lifecycle.scope, f.lifecycle.evidence).kind, 'verified');
  assert.equal(derive(f).status, 'Integrated');
  assert.equal(derive(f).closure.kind, 'eligible');
});
test('pre-split integration and final publication survive reload without completing new children', () => {
  const before = fixture();
  integrate(before);
  publish(before);
  const f = splitFixture();
  f.lifecycle.integration = structuredClone(before.lifecycle.integration);
  f.lifecycle.publication = structuredClone(before.lifecycle.publication);
  f.lifecycle.evidence.publications = structuredClone(before.lifecycle.evidence.publications);
  const loaded = JSON.parse(JSON.stringify(f));
  const state = derive(loaded);
  assert.equal(state.status, 'Released');
  assert.equal(state.closure.kind, 'blocked');
  assert.equal(state.integrationFacts.length, 1);
  assert.equal(state.publicationFacts.length, 1);
  assert.equal(parseProjectLifecycle(loaded.lifecycle).kind, 'verified');
  const currentPrs = loaded.lifecycle.prs;
  loaded.lifecycle.prs = [];
  assert.equal(derive(loaded).status, 'Released');
  assert.ok(
    derive(loaded).blockers.some(
      (b) => b.code === 'missing-pr' && b.requirementIds.includes('work-a'),
    ),
  );
  loaded.lifecycle.prs = currentPrs;
  loaded.lifecycle.publication = [];
  loaded.lifecycle.evidence.publications = [];
  assert.notEqual(derive(loaded).status, 'Integrated');
  integrate(loaded, 'work-a', loaded.lifecycle.prs[0]);
  integrate(loaded, 'work-b', loaded.lifecycle.prs[1]);
  assert.equal(derive(loaded).status, 'Integrated');
  assert.equal(derive(loaded).closure.kind, 'eligible');
  loaded.lifecycle.integration[0].prNodeId = 'never-mapped';
  assert.equal(derive(loaded).status, 'Backlog');
});
