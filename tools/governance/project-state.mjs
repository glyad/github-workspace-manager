import { types } from 'node:util';
import { blocked, verified, boundedId, exactFields, sha40, validCandidate } from './contracts.mjs';
import { projectDigest } from './project-baseline.mjs';
import { digest, sameCandidate } from './journal.mjs';

// Reflection never invokes producer accessors, proxies, iterators, species or toJSON.
// Bound the complete graph before any schema hashing or equality comparison.
function snapshotData(input) {
  let nodes = 0,
    bytes = 0;
  const path = new Set();
  function visit(value, depth = 0, byteArray = false, copying = false) {
    if (++nodes > 4300000 || depth > 32) throw Error('Input graph bound');
    if (value === null || typeof value === 'boolean') {
      bytes += 5;
      return value;
    }
    if (typeof value === 'string') {
      const size = Buffer.byteLength(value);
      if (size > 1048576) throw Error('Input string bound');
      bytes += Buffer.byteLength(JSON.stringify(value));
      return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      bytes += String(value).length;
      return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || path.has(value))
      throw Error('Plain bounded JSON data required');
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw Error('Plain data record required');
    const keys = Reflect.ownKeys(value);
    if (keys.length > (array ? (byteArray ? 1048577 : 4097) : 64)) throw Error('Input width bound');
    let length = 0;
    if (array) {
      const d = Object.getOwnPropertyDescriptor(value, 'length');
      if (!d || !Object.hasOwn(d, 'value') || keys.length !== d.value + 1)
        throw Error('Dense bounded array required');
      length = d.value;
    }
    const out = copying ? (array ? [] : {}) : null;
    bytes += 2;
    path.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        key.length > 128 ||
        key === '__proto__' ||
        (array && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        throw Error('Data keys required');
      if (array && Number(key) >= length) throw Error('Exact array indices required');
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !Object.hasOwn(d, 'value') || !d.enumerable)
        throw Error('Enumerable data descriptors required');
      if (byteArray && (!Number.isInteger(d.value) || d.value < 0 || d.value > 255))
        throw Error('Intrinsic byte value required');
      bytes += array ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
      const child = visit(d.value, depth + 1, key === 'utf8Bytes', copying);
      if (bytes > 8388608) throw Error('Input byte bound');
      if (copying) out[key] = child;
    }
    path.delete(value);
    return out;
  }
  // A complete descriptor/bounds pass precedes allocation of the defensive graph.
  visit(input);
  nodes = bytes = 0;
  return visit(input, 0, false, true);
}
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requireThat = (condition, code = 'invalid-evidence') => {
  if (!condition) throw Error(code);
};
const exact = (value, keys) => requireThat(exactFields(value, keys));
const ids = (values) =>
  Array.isArray(values) && values.every((v, i) => boundedId(v) && (i === 0 || values[i - 1] < v));
const nullableId = (value) => value === null || boundedId(value);
const eq = (a, b) => projectDigest(a) === projectDigest(b);
const union = (values) => [...new Set(values.flat())].sort();
const requirementFields = [
  'requirementId',
  'sourceKey',
  'sourceDigest',
  'issueNodeId',
  'parentRequirementId',
  'role',
  'coverageIds',
  'milestoneId',
  'requiredPrNodeIds',
  'dependencyRequirementIds',
  'acceptanceDigest',
];
const coverageFields = [
  'id',
  'sourceKey',
  'sourceDigest',
  'startByte',
  'endByte',
  'textDigest',
  'parentCoverageId',
];
function validateSnapshot(scope) {
  exact(scope, [
    'version',
    'repositoryId',
    'projectId',
    'revision',
    'requirements',
    'coverageCatalog',
    'decisionRefs',
  ]);
  requireThat(
    scope.version === 1 &&
      boundedId(scope.repositoryId) &&
      boundedId(scope.projectId) &&
      hash(scope.revision) &&
      ids(scope.decisionRefs),
  );
  requireThat(Array.isArray(scope.requirements) && Array.isArray(scope.coverageCatalog));
  const { revision, ...payload } = scope;
  requireThat(revision === projectDigest(payload), 'scope-digest-mismatch');
  const requirements = new Map(),
    coverage = new Map();
  for (const r of scope.requirements) {
    exact(r, requirementFields);
    requireThat(
      ['requirementId', 'sourceKey', 'issueNodeId'].every((k) => boundedId(r[k])) &&
        hash(r.sourceDigest) &&
        hash(r.acceptanceDigest) &&
        nullableId(r.parentRequirementId) &&
        nullableId(r.milestoneId) &&
        ['leaf', 'aggregate'].includes(r.role) &&
        ['coverageIds', 'requiredPrNodeIds', 'dependencyRequirementIds'].every((k) => ids(r[k])),
    );
    requireThat(!requirements.has(r.requirementId), 'duplicate-requirement');
    requirements.set(r.requirementId, r);
  }
  requireThat(ids([...requirements.keys()]), 'noncanonical-requirements');
  for (const c of scope.coverageCatalog) {
    exact(c, coverageFields);
    requireThat(
      boundedId(c.id) &&
        boundedId(c.sourceKey) &&
        hash(c.sourceDigest) &&
        hash(c.textDigest) &&
        nullableId(c.parentCoverageId) &&
        Number.isSafeInteger(c.startByte) &&
        Number.isSafeInteger(c.endByte) &&
        c.startByte >= 0 &&
        c.endByte > c.startByte,
    );
    requireThat(!coverage.has(c.id), 'duplicate-coverage');
    coverage.set(c.id, c);
  }
  requireThat(ids([...coverage.keys()]), 'noncanonical-coverage');
  for (const c of coverage.values()) {
    const seen = new Set([c.id]);
    let node = c;
    while (node.parentCoverageId !== null) {
      const parent = coverage.get(node.parentCoverageId);
      requireThat(parent && !seen.has(parent.id), 'coverage-cycle-or-undefined');
      requireThat(
        node.sourceKey === parent.sourceKey &&
          node.sourceDigest === parent.sourceDigest &&
          node.startByte >= parent.startByte &&
          node.endByte <= parent.endByte,
        'coverage-source-migration',
      );
      seen.add(parent.id);
      node = parent;
    }
  }
  const leafOwnership = new Map(),
    issueMilestones = new Map();
  const walked = { parent: new Set(), dependency: new Set() };
  const walk = (id, key, seen = new Set()) => {
    requireThat(!seen.has(id), 'requirement-cycle');
    if (walked[key].has(id)) return;
    const r = requirements.get(id);
    requireThat(r, 'undefined-requirement');
    const next = new Set([...seen, id]);
    for (const linked of key === 'parent'
      ? r.parentRequirementId === null
        ? []
        : [r.parentRequirementId]
      : r.dependencyRequirementIds)
      walk(linked, key, next);
    walked[key].add(id);
  };
  for (const r of requirements.values()) {
    walk(r.requirementId, 'parent');
    walk(r.requirementId, 'dependency');
    if (r.parentRequirementId !== null)
      requireThat(
        requirements.get(r.parentRequirementId)?.role === 'aggregate',
        'nonaggregate-parent',
      );
    for (const id of r.coverageIds) requireThat(coverage.has(id), 'undefined-coverage');
    if (r.role !== 'leaf') continue;
    requireThat(r.coverageIds.length > 0, 'empty-leaf-coverage');
    if (issueMilestones.has(r.issueNodeId))
      requireThat(issueMilestones.get(r.issueNodeId) === r.milestoneId, 'unexpressible-split');
    issueMilestones.set(r.issueNodeId, r.milestoneId);
    for (const id of r.coverageIds) {
      const c = coverage.get(id);
      requireThat(
        c.sourceKey === r.sourceKey && c.sourceDigest === r.sourceDigest,
        'coverage-source-migration',
      );
      requireThat(!leafOwnership.has(id), 'duplicate-active-coverage');
      leafOwnership.set(id, r.requirementId);
    }
  }
  const active = [...leafOwnership.keys()].map((id) => coverage.get(id));
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i],
        b = active[j];
      requireThat(
        a.sourceKey !== b.sourceKey ||
          a.sourceDigest !== b.sourceDigest ||
          a.endByte <= b.startByte ||
          b.endByte <= a.startByte,
        'overlapping-active-coverage',
      );
    }
  const descendants = (id) =>
    [...requirements.values()]
      .filter((r) => r.parentRequirementId === id)
      .flatMap((r) => (r.role === 'leaf' ? [r] : descendants(r.requirementId)));
  for (const r of requirements.values())
    if (r.role === 'aggregate')
      requireThat(
        eq(r.coverageIds, union(descendants(r.requirementId).map((leaf) => leaf.coverageIds))) &&
          r.requiredPrNodeIds.length === 0,
        'aggregate-coverage-mismatch',
      );
  return { requirements, coverage, leafOwnership, descendants };
}

/** Pure policy evaluation only; no resolver or mutation authority is created here. */

const snapshotOf = (lifecycle) =>
  lifecycle.scope.kind === 'accepted' ? lifecycle.scope.history.current : lifecycle.scope.snapshot;
function validateEvidence(lifecycle) {
  const evidence = lifecycle.evidence;
  exact(evidence, [
    'version',
    'repositoryId',
    'projectId',
    'sources',
    'readiness',
    'ci',
    'publications',
    'chains',
  ]);
  requireThat(
    evidence.version === 1 &&
      evidence.repositoryId === lifecycle.repositoryId &&
      evidence.projectId === lifecycle.projectId,
  );
  const tables = ['sources', 'readiness', 'ci', 'publications', 'chains'];
  let count = 0,
    sourceSize = 0;
  const refs = new Map(),
    sources = new Map(),
    used = new Set();
  for (const key of tables) {
    const table = evidence[key];
    requireThat(Array.isArray(table) && table.length <= 1000 && (count += table.length) <= 2000);
    requireThat(ids(table.map((row) => row.ref)), 'noncanonical-evidence');
    for (const row of table) {
      requireThat(!refs.has(row.ref), 'duplicate-evidence-ref');
      refs.set(row.ref, row);
      if (key === 'sources') {
        exact(row, ['ref', 'kind', 'sourceKey', 'sourceDigest', 'utf8Bytes']);
        requireThat(
          row.kind === 'source' &&
            boundedId(row.sourceKey) &&
            hash(row.sourceDigest) &&
            Array.isArray(row.utf8Bytes) &&
            row.utf8Bytes.length <= 1048576 &&
            (sourceSize += row.utf8Bytes.length) <= 4194304,
        );
        requireThat(
          row.utf8Bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
        );
        // All byte descriptors and limits were checked before this allocation.
        const bytes = Uint8Array.from(row.utf8Bytes);
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        requireThat(
          Buffer.from(text, 'utf8').equals(Buffer.from(bytes)) &&
            digest(bytes) === row.sourceDigest,
          'source-byte-mismatch',
        );
        const identity = projectDigest([row.sourceKey, row.sourceDigest]);
        requireThat(!sources.has(identity), 'duplicate-source');
        sources.set(identity, { ref: row.ref, bytes });
      } else if (key === 'readiness' || key === 'ci') {
        exact(
          row,
          key === 'readiness'
            ? [
                'ref',
                'kind',
                'repositoryId',
                'prNodeId',
                'candidate',
                'eventKind',
                'observationRef',
              ]
            : [
                'ref',
                'kind',
                'repositoryId',
                'prNodeId',
                'candidate',
                'conclusion',
                'runId',
                'checkId',
                'observationRef',
              ],
        );
        requireThat(
          row.kind === key &&
            row.repositoryId === lifecycle.repositoryId &&
            boundedId(row.prNodeId) &&
            validCandidate(row.candidate) &&
            row.candidate.repositoryId === lifecycle.repositoryId &&
            boundedId(row.observationRef),
        );
        requireThat(
          key === 'readiness'
            ? row.eventKind === 'ready_for_review'
            : row.conclusion === 'success' && boundedId(row.runId) && boundedId(row.checkId),
        );
      } else if (key === 'publications') {
        exact(row, ['ref', 'kind', 'inclusion', 'snapshot']);
        requireThat(row.kind === 'publication-inclusion');
        const inclusion = row.inclusion;
        exact(inclusion, [
          'publicationId',
          'repositoryId',
          'projectId',
          'acceptedScopeRevision',
          'coverageIds',
          'tagSha',
          'candidateSha',
          'evidenceRef',
        ]);
        requireThat(
          boundedId(inclusion.publicationId) &&
            inclusion.repositoryId === lifecycle.repositoryId &&
            inclusion.projectId === lifecycle.projectId &&
            hash(inclusion.acceptedScopeRevision) &&
            ids(inclusion.coverageIds) &&
            inclusion.coverageIds.length > 0 &&
            sha40(inclusion.tagSha) &&
            sha40(inclusion.candidateSha) &&
            boundedId(inclusion.evidenceRef),
        );
      } else {
        exact(row, [
          'ref',
          'kind',
          'repositoryId',
          'projectId',
          'baselineRef',
          'baselineRevision',
          'currentRevision',
          'decisionCount',
          'orderedDecisionIds',
          'headDigest',
        ]);
        requireThat(
          row.kind === 'scope-chain' &&
            row.repositoryId === lifecycle.repositoryId &&
            row.projectId === lifecycle.projectId &&
            boundedId(row.baselineRef) &&
            hash(row.baselineRevision) &&
            hash(row.currentRevision) &&
            hash(row.headDigest) &&
            Number.isSafeInteger(row.decisionCount) &&
            row.decisionCount >= 0 &&
            row.decisionCount <= 1000 &&
            Array.isArray(row.orderedDecisionIds) &&
            row.orderedDecisionIds.every(boundedId) &&
            new Set(row.orderedDecisionIds).size === row.orderedDecisionIds.length &&
            row.decisionCount === row.orderedDecisionIds.length,
        );
        const { ref: _ref, kind: _kind, headDigest, ...head } = row;
        requireThat(headDigest === projectDigest(head), 'chain-head-mismatch');
      }
    }
  }
  const resolve = (ref, kind) => {
    const row = refs.get(ref);
    requireThat(row && row.kind === kind, 'missing-or-wrong-evidence');
    used.add(ref);
    return row;
  };
  const checkScope = (scope) => {
    requireThat(
      scope.repositoryId === lifecycle.repositoryId && scope.projectId === lifecycle.projectId,
      'scope-identity-mismatch',
    );
    const parsed = validateSnapshot(scope);
    for (const c of parsed.coverage.values()) {
      const source = sources.get(projectDigest([c.sourceKey, c.sourceDigest]));
      requireThat(source && c.endByte <= source.bytes.length, 'missing-source-or-byte-bounds');
      if (c.parentCoverageId === null)
        requireThat(
          c.startByte === 0 && c.endByte === source.bytes.length,
          'incomplete-root-coverage',
        );
      used.add(source.ref);
      const slice = source.bytes.slice(c.startByte, c.endByte);
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(slice);
      requireThat(digest(slice) === c.textDigest, 'coverage-byte-digest-mismatch');
    }
    return parsed;
  };
  return {
    refs,
    used,
    resolve,
    checkScope,
    complete() {
      requireThat(used.size === refs.size, 'unreferenced-evidence');
    },
  };
}
function validateHistory(history, evidence) {
  exact(history, [
    'version',
    'repositoryId',
    'projectId',
    'acceptedBaseline',
    'steps',
    'current',
    'observationRef',
  ]);
  requireThat(
    history.version === 1 &&
      Array.isArray(history.steps) &&
      history.steps.length <= 1000 &&
      boundedId(history.observationRef),
  );
  exact(history.acceptedBaseline, ['ref', 'decisionRef', 'snapshot']);
  requireThat(
    boundedId(history.acceptedBaseline.ref) && boundedId(history.acceptedBaseline.decisionRef),
  );
  const baseline = history.acceptedBaseline.snapshot;
  requireThat(
    history.repositoryId === baseline.repositoryId &&
      history.projectId === baseline.projectId &&
      baseline.decisionRefs.includes(history.acceptedBaseline.decisionRef),
  );
  const chain = evidence.resolve(history.observationRef, 'scope-chain');
  requireThat(
    chain.baselineRef === history.acceptedBaseline.ref &&
      chain.baselineRevision === baseline.revision &&
      chain.currentRevision === history.current.revision &&
      chain.decisionCount === history.steps.length &&
      eq(
        chain.orderedDecisionIds,
        history.steps.map((step) => step.decision.decisionId),
      ),
    'history-chain-mismatch',
  );
  let previous = baseline,
    prior = evidence.checkScope(baseline);
  requireThat(
    [...prior.coverage.values()].every((c) => c.parentCoverageId === null),
    'baseline-coverage-parent',
  );
  requireThat(
    [...prior.coverage.keys()].every((id) => prior.leafOwnership.has(id)),
    'unowned-baseline-coverage',
  );
  const historical = new Map([[baseline.revision, baseline]]);
  for (const step of history.steps) {
    exact(step, ['decision', 'before', 'after']);
    const d = step.decision;
    exact(d, [
      'version',
      'decisionId',
      'repositoryId',
      'ownerActorId',
      'sourceRef',
      'sourceDigest',
      'beforeScopeDigest',
      'afterScopeDigest',
      'kind',
      'affectedRequirementIds',
      'destinationMilestoneId',
      'closedPrNodeIds',
      'dispositionRefs',
    ]);
    requireThat(
      d.version === 1 &&
        ['decisionId', 'repositoryId', 'ownerActorId', 'sourceRef'].every((k) => boundedId(d[k])) &&
        ['sourceDigest', 'beforeScopeDigest', 'afterScopeDigest'].every((k) => hash(d[k])) &&
        ['accept-version', 'reschedule', 'split', 'defer', 'reduce', 'resolve-closed-pr'].includes(
          d.kind,
        ) &&
        ['affectedRequirementIds', 'closedPrNodeIds', 'dispositionRefs'].every((k) => ids(d[k])) &&
        nullableId(d.destinationMilestoneId),
    );
    requireThat(
      d.repositoryId === history.repositoryId &&
        eq(previous, step.before) &&
        d.beforeScopeDigest === step.before.revision &&
        d.afterScopeDigest === step.after.revision,
      'history-discontinuity',
    );
    evidence.checkScope(step.before);
    const next = evidence.checkScope(step.after);
    requireThat(
      eq(step.after.decisionRefs, union([step.before.decisionRefs, [d.decisionId]])),
      'decision-reference-mismatch',
    );
    const changed = union([[...prior.requirements.keys()], [...next.requirements.keys()]]).filter(
      (id) => !eq(prior.requirements.get(id) ?? null, next.requirements.get(id) ?? null),
    );
    requireThat(eq(changed, d.affectedRequirementIds), 'affected-set-mismatch');
    for (const [id, old] of prior.requirements) {
      const current = next.requirements.get(id);
      requireThat(
        current &&
          current.issueNodeId === old.issueNodeId &&
          current.sourceKey === old.sourceKey &&
          current.sourceDigest === old.sourceDigest &&
          current.acceptanceDigest === old.acceptanceDigest,
        'requirement-identity-loss',
      );
    }
    for (const [id, old] of prior.coverage)
      requireThat(eq(next.coverage.get(id) ?? null, old), 'coverage-identity-loss');
    for (const [id, old] of prior.requirements) {
      if (old.role === 'leaf' && next.requirements.get(id).role === 'aggregate')
        requireThat(d.kind === 'split', 'unapproved-role-split');
    }
    for (const [id, owner] of prior.leafOwnership) {
      if (next.leafOwnership.has(id) && next.leafOwnership.get(id) !== owner)
        requireThat(d.kind === 'split', 'unapproved-coverage-transfer');
    }
    const introduced = [...next.coverage.values()].filter((c) => !prior.coverage.has(c.id));
    for (const c of introduced) {
      if (c.parentCoverageId === null)
        requireThat(
          d.kind === 'accept-version' &&
            next.leafOwnership.has(c.id) &&
            ![...prior.coverage.values()].some(
              (old) => old.sourceKey === c.sourceKey || old.sourceDigest === c.sourceDigest,
            ),
          'unapproved-coverage-addition',
        );
      else
        requireThat(
          d.kind === 'split' &&
            prior.leafOwnership.has(c.parentCoverageId) &&
            prior.coverage.has(c.parentCoverageId),
          'skipped-parent-or-unapproved-split',
        );
    }
    for (const parentId of new Set(
      introduced.map((c) => c.parentCoverageId).filter((id) => id !== null),
    )) {
      const parent = prior.coverage.get(parentId);
      const children = introduced
        .filter((c) => c.parentCoverageId === parentId)
        .sort((a, b) => a.startByte - b.startByte);
      requireThat(
        children.length >= 2 &&
          children[0].startByte === parent.startByte &&
          children.at(-1).endByte === parent.endByte &&
          children.every((c, i) => i === 0 || children[i - 1].endByte === c.startByte) &&
          !next.leafOwnership.has(parentId) &&
          children.every((c) => next.leafOwnership.has(c.id)),
        'unexpressible-split',
      );
    }
    // Compare actual intervals, keeping each pre-existing byte exactly once.
    for (const id of prior.leafOwnership.keys()) {
      const old = prior.coverage.get(id);
      const parts = [...next.leafOwnership.keys()]
        .map((key) => next.coverage.get(key))
        .filter(
          (c) =>
            c.sourceKey === old.sourceKey &&
            c.sourceDigest === old.sourceDigest &&
            c.startByte >= old.startByte &&
            c.endByte <= old.endByte,
        )
        .sort((a, b) => a.startByte - b.startByte);
      requireThat(
        parts.length &&
          parts[0].startByte === old.startByte &&
          parts.at(-1).endByte === old.endByte &&
          parts.every((c, i) => i === 0 || parts[i - 1].endByte === c.startByte),
        'coverage-conservation-failure',
      );
    }
    previous = step.after;
    prior = next;
    historical.set(previous.revision, previous);
  }
  requireThat(eq(previous, history.current), 'history-current-mismatch');
  return { parsed: evidence.checkScope(history.current), historical };
}
function validateLifecycle(lifecycle) {
  exact(lifecycle, [
    'version',
    'scope',
    'projection',
    'repositoryId',
    'projectId',
    'integrationTarget',
    'activities',
    'prs',
    'integration',
    'publication',
    'observationRef',
    'evidence',
  ]);
  requireThat(
    lifecycle.version === 1 &&
      boundedId(lifecycle.repositoryId) &&
      boundedId(lifecycle.projectId) &&
      boundedId(lifecycle.observationRef),
  );
  requireThat(lifecycle.scope && ['accepted', 'intake'].includes(lifecycle.scope.kind));
  exact(
    lifecycle.scope,
    lifecycle.scope.kind === 'accepted'
      ? ['kind', 'history']
      : ['kind', 'snapshot', 'nativeObservationRef'],
  );
  if (lifecycle.scope.kind === 'intake')
    requireThat(boundedId(lifecycle.scope.nativeObservationRef));
  exact(lifecycle.integrationTarget, ['ref', 'sha']);
  requireThat(
    lifecycle.integrationTarget.ref === 'refs/heads/develop' &&
      sha40(lifecycle.integrationTarget.sha),
  );
  const projection = lifecycle.projection;
  exact(projection, [
    'repositoryId',
    'projectId',
    'issueNodeId',
    'scopeRevision',
    'coverageIds',
    'milestoneId',
  ]);
  requireThat(
    projection.repositoryId === lifecycle.repositoryId &&
      projection.projectId === lifecycle.projectId &&
      boundedId(projection.issueNodeId) &&
      hash(projection.scopeRevision) &&
      ids(projection.coverageIds) &&
      nullableId(projection.milestoneId),
  );
  for (const key of ['activities', 'prs', 'integration', 'publication'])
    requireThat(Array.isArray(lifecycle[key]));
  requireThat(
    ids(lifecycle.activities.map((a) => a.issueNodeId)),
    'duplicate-or-noncanonical-activity',
  );
  for (const a of lifecycle.activities) {
    exact(a, ['issueNodeId', 'kind', 'observationRef']);
    requireThat(['active', 'inactive'].includes(a.kind) && boundedId(a.observationRef));
  }
  requireThat(ids(lifecycle.prs.map((p) => p.prNodeId)), 'duplicate-or-noncanonical-pr');
  const numbers = new Set();
  for (const p of lifecycle.prs) {
    exact(p, [
      'prNodeId',
      'issueNodeIds',
      'state',
      'draft',
      'candidate',
      'readinessRef',
      'ciRef',
      'observationRef',
    ]);
    requireThat(
      ids(p.issueNodeIds) &&
        p.issueNodeIds.length > 0 &&
        ['open', 'merged', 'closed-unmerged'].includes(p.state) &&
        typeof p.draft === 'boolean' &&
        nullableId(p.readinessRef) &&
        nullableId(p.ciRef) &&
        boundedId(p.observationRef),
    );
    if (p.candidate !== null) {
      requireThat(
        validCandidate(p.candidate) &&
          p.candidate.repositoryId === lifecycle.repositoryId &&
          !numbers.has(p.candidate.pr),
        'invalid-or-duplicate-candidate',
      );
      numbers.add(p.candidate.pr);
    }
  }
  const integrationIds = new Set();
  for (const fact of lifecycle.integration) {
    exact(fact, [
      'requirementId',
      'prNodeId',
      'candidate',
      'mergeSha',
      'targetRef',
      'targetSha',
      'validationRefs',
      'observationRef',
    ]);
    requireThat(
      boundedId(fact.requirementId) &&
        boundedId(fact.prNodeId) &&
        validCandidate(fact.candidate) &&
        fact.candidate.repositoryId === lifecycle.repositoryId &&
        sha40(fact.mergeSha) &&
        sha40(fact.targetSha) &&
        fact.targetRef === 'refs/heads/develop' &&
        ids(fact.validationRefs) &&
        fact.validationRefs.length > 0 &&
        boundedId(fact.observationRef),
    );
    const identity = projectDigest([
      fact.requirementId,
      fact.prNodeId,
      fact.candidate,
      fact.targetSha,
    ]);
    requireThat(!integrationIds.has(identity), 'duplicate-integration');
    integrationIds.add(identity);
  }
  const publicationIds = new Set();
  for (const fact of lifecycle.publication) {
    exact(fact, [
      'requirementId',
      'kind',
      'releaseId',
      'tagRef',
      'tagSha',
      'candidateSha',
      'inclusionRef',
      'observationRef',
    ]);
    requireThat(
      ['requirementId', 'releaseId', 'tagRef', 'inclusionRef', 'observationRef'].every((k) =>
        boundedId(fact[k]),
      ) &&
        ['normal', 'rc', 'hotfix'].includes(fact.kind) &&
        sha40(fact.tagSha) &&
        sha40(fact.candidateSha),
    );
    const identity = projectDigest([fact.requirementId, fact.releaseId]);
    requireThat(!publicationIds.has(identity), 'duplicate-publication');
    publicationIds.add(identity);
  }
}
function evaluate(requirements, integration, publication, lifecycle, select = false) {
  validateLifecycle(lifecycle);
  const evidence = validateEvidence(lifecycle);
  const accepted = lifecycle.scope.kind === 'accepted';
  let parsed, historical;
  if (accepted) ({ parsed, historical } = validateHistory(lifecycle.scope.history, evidence));
  else {
    requireThat(
      lifecycle.evidence.chains.length === 0 &&
        lifecycle.evidence.readiness.length === 0 &&
        lifecycle.evidence.ci.length === 0 &&
        lifecycle.evidence.publications.length === 0 &&
        lifecycle.publication.length === 0 &&
        lifecycle.prs.every((p) => p.readinessRef === null && p.ciRef === null),
      'intake-authority-data',
    );
    parsed = evidence.checkScope(lifecycle.scope.snapshot);
    historical = new Map();
  }
  const scope = snapshotOf(lifecycle),
    projection = lifecycle.projection;
  requireThat(projection.scopeRevision === scope.revision, 'projection-revision-mismatch');
  const roots = [...parsed.requirements.values()].filter(
    (r) => r.issueNodeId === projection.issueNodeId,
  );
  requireThat(roots.length > 0, 'unknown-projection-issue');
  let leaves = [
    ...new Map(
      roots
        .flatMap((r) => (r.role === 'leaf' ? [r] : parsed.descendants(r.requirementId)))
        .map((r) => [r.requirementId, r]),
    ).values(),
  ];
  leaves = leaves
    .filter((r) => projection.milestoneId === null || r.milestoneId === projection.milestoneId)
    .sort((a, b) => a.requirementId.localeCompare(b.requirementId));
  requireThat(
    leaves.length > 0 && eq(projection.coverageIds, union(leaves.map((r) => r.coverageIds))),
    'projection-coverage-mismatch',
  );
  const selectedIds = new Set(roots.map((r) => r.requirementId));
  for (const leaf of leaves) {
    let node = leaf;
    while (!selectedIds.has(node.requirementId)) {
      selectedIds.add(node.requirementId);
      if (node.parentRequirementId === null) break;
      node = parsed.requirements.get(node.parentRequirementId);
    }
  }
  const expectedRequirements = scope.requirements.filter((r) => selectedIds.has(r.requirementId));
  const expectedIntegration = lifecycle.integration.filter((f) => selectedIds.has(f.requirementId));
  const expectedPublication = lifecycle.publication.filter((f) => selectedIds.has(f.requirementId));
  if (select) {
    requirements = expectedRequirements;
    integration = expectedIntegration;
    publication = expectedPublication;
  } else
    requireThat(
      eq(requirements, expectedRequirements) &&
        eq(integration, expectedIntegration) &&
        eq(publication, expectedPublication),
      'argument-mismatch',
    );
  const blockers = [];
  const add = (code, requirementIds, evidenceRefs = []) =>
    blockers.push({
      code,
      requirementIds: union([requirementIds]),
      evidenceRefs: union([evidenceRefs]),
    });
  const readiness = new Map(),
    ci = new Map();
  for (const p of lifecycle.prs) {
    for (const [field, kind, target] of [
      ['readinessRef', 'readiness', readiness],
      ['ciRef', 'ci', ci],
    ]) {
      if (p[field] === null) continue;
      const row = evidence.resolve(p[field], kind);
      requireThat(
        row.prNodeId === p.prNodeId && row.repositoryId === lifecycle.repositoryId,
        'cross-pr-evidence',
      );
      if (
        leaves.some((r) => r.requiredPrNodeIds.includes(p.prNodeId)) &&
        (!sameCandidate(row.candidate, p.candidate) || row.observationRef !== p.observationRef)
      )
        add(
          'stale-' + kind,
          leaves
            .filter((r) => r.requiredPrNodeIds.includes(p.prNodeId))
            .map((r) => r.requirementId),
          [row.ref],
        );
      target.set(p.prNodeId, row);
    }
  }
  const publicationCoverage = new Map();
  const releaseBindings = new Map();
  for (const fact of lifecycle.publication) {
    const row = evidence.resolve(fact.inclusionRef, 'publication-inclusion');
    const past = evidence.checkScope(row.snapshot),
      inclusion = row.inclusion;
    requireThat(
      inclusion.acceptedScopeRevision === row.snapshot.revision &&
        historical.has(row.snapshot.revision) &&
        eq(historical.get(row.snapshot.revision), row.snapshot),
      'disconnected-publication-scope',
    );
    requireThat(
      inclusion.publicationId === fact.releaseId &&
        inclusion.tagSha === fact.tagSha &&
        inclusion.candidateSha === fact.candidateSha,
      'publication-identity-mismatch',
    );
    const binding = {
      kind: fact.kind,
      releaseId: fact.releaseId,
      tagRef: fact.tagRef,
      tagSha: fact.tagSha,
      candidateSha: fact.candidateSha,
    };
    if (releaseBindings.has(fact.inclusionRef))
      requireThat(
        eq(releaseBindings.get(fact.inclusionRef), binding),
        'publication-reference-conflict',
      );
    releaseBindings.set(fact.inclusionRef, binding);
    requireThat(
      inclusion.coverageIds.every((id) => past.leafOwnership.has(id)),
      'inactive-publication-coverage',
    );
    const included = inclusion.coverageIds.map((id) => past.coverage.get(id));
    const r = past.requirements.get(fact.requirementId);
    requireThat(
      r && r.coverageIds.every((id) => intervalCovered(past.coverage.get(id), included)),
      'publication-requirement-mismatch',
    );
    if (fact.kind !== 'rc') {
      const identity = projectDigest(binding);
      if (!publicationCoverage.has(identity)) publicationCoverage.set(identity, []);
      publicationCoverage.get(identity).push(...included);
    }
  }
  const mappedScopes = accepted ? [...historical.values()] : [scope];
  for (const fact of lifecycle.integration)
    requireThat(
      mappedScopes.some((snapshot) =>
        snapshot.requirements.some(
          (r) =>
            r.requirementId === fact.requirementId && r.requiredPrNodeIds.includes(fact.prNodeId),
        ),
      ),
      'unmapped-integration',
    );
  evidence.complete();
  let anyActive = false,
    allIntegrated = true,
    allReview = true,
    outstanding = 0;
  const prs = new Map(lifecycle.prs.map((p) => [p.prNodeId, p]));
  const activities = new Map(lifecycle.activities.map((a) => [a.issueNodeId, a]));
  for (const r of leaves) {
    const activity = activities.get(r.issueNodeId);
    if (!activity) add('missing-activity', [r.requirementId], [lifecycle.observationRef]);
    else if (activity.kind === 'active') anyActive = true;
    if (r.requiredPrNodeIds.length === 0) {
      add('empty-required-prs', [r.requirementId], [lifecycle.observationRef]);
      allIntegrated = allReview = false;
    }
    for (const id of r.requiredPrNodeIds) {
      const p = prs.get(id);
      if (!p || !p.issueNodeIds.includes(r.issueNodeId)) {
        add('missing-pr', [r.requirementId], [lifecycle.observationRef]);
        allIntegrated = allReview = false;
        outstanding++;
        continue;
      }
      if (p.state === 'open') anyActive = true;
      if (p.state === 'closed-unmerged')
        add('closed-unmerged', [r.requirementId], [p.observationRef]);
      const facts = lifecycle.integration.filter(
        (f) => f.requirementId === r.requirementId && f.prNodeId === id,
      );
      const integrated =
        accepted &&
        p.state === 'merged' &&
        facts.some(
          (fact) =>
            sameCandidate(fact.candidate, p.candidate) &&
            fact.targetSha === lifecycle.integrationTarget.sha,
        );
      if (integrated) {
        anyActive = true;
        continue;
      }
      if (facts.length)
        add(
          'stale-integration',
          [r.requirementId],
          facts.map((fact) => fact.observationRef),
        );
      if (p.state === 'merged' && facts.length === 0)
        add('missing-integration', [r.requirementId], [p.observationRef]);
      allIntegrated = false;
      outstanding++;
      const ready = readiness.get(id),
        check = ci.get(id);
      const matches = (row) =>
        row &&
        row.repositoryId === lifecycle.repositoryId &&
        row.prNodeId === id &&
        row.observationRef === p.observationRef &&
        sameCandidate(row.candidate, p.candidate);
      const currentBase =
        p.candidate &&
        p.candidate.base === lifecycle.integrationTarget.sha &&
        (p.candidate.protocolVersion !== 2 ||
          p.candidate.baseRef === lifecycle.integrationTarget.ref);
      if (ready && !matches(ready)) add('stale-readiness', [r.requirementId], [ready.ref]);
      if (check && !matches(check)) add('stale-ci', [r.requirementId], [check.ref]);
      if (p.state === 'open' && p.candidate && !currentBase)
        add('stale-base', [r.requirementId], [p.observationRef]);
      if (!(
        accepted &&
        p.state === 'open' &&
        !p.draft &&
        currentBase &&
        matches(ready) &&
        matches(check)
      ))
        allReview = false;
    }
  }
  const released =
    accepted &&
    [...publicationCoverage.values()].some((intervals) =>
      projection.coverageIds.every((id) => intervalCovered(parsed.coverage.get(id), intervals)),
    );
  const status = released
    ? 'Released'
    : accepted && allIntegrated && blockers.length === 0
      ? 'Integrated'
      : accepted && outstanding > 0 && allReview && blockers.length === 0
        ? 'In review'
        : anyActive
          ? 'In progress'
          : accepted
            ? 'Planned'
            : 'Backlog';
  const closureEligible = accepted && allIntegrated && blockers.length === 0;
  const projectState = {
    status,
    projection,
    requirementIds: [...selectedIds].sort(),
    integrationFacts: integration,
    publicationFacts: publication,
    closure: {
      kind: closureEligible ? 'eligible' : 'blocked',
      reasonRefs: union([
        [...(closureEligible ? [] : [lifecycle.observationRef])],
        ...blockers.map((b) => b.evidenceRefs),
      ]),
    },
    blockers,
  };
  return select
    ? {
        lifecycle,
        requirements,
        integrationFacts: integration,
        publicationFacts: publication,
        projectState,
      }
    : projectState;
}
function intervalCovered(unit, intervals) {
  if (!unit) return false;
  const candidates = intervals
    .filter(
      (c) =>
        c.sourceKey === unit.sourceKey &&
        c.sourceDigest === unit.sourceDigest &&
        c.startByte < unit.endByte &&
        c.endByte > unit.startByte,
    )
    .sort((a, b) => a.startByte - b.startByte);
  let end = unit.startByte;
  for (const c of candidates) {
    if (c.startByte > end) return false;
    end = Math.max(end, c.endByte);
  }
  return end >= unit.endByte;
}
/** Normalized fixtures exercise policy only. No source authentication, receipt or write authority. */
export function deriveProjectState(requirements, integrationFacts, publicationFacts, lifecycle) {
  try {
    const [r, i, p, l] = snapshotData([
      requirements,
      integrationFacts,
      publicationFacts,
      lifecycle,
    ]);
    return evaluate(r, i, p, l);
  } catch (error) {
    return {
      status: 'Backlog',
      projection: null,
      requirementIds: [],
      integrationFacts: [],
      publicationFacts: [],
      closure: { kind: 'blocked', reasonRefs: [] },
      blockers: [
        {
          code: error instanceof Error ? error.message : 'invalid-evidence',
          requirementIds: [],
          evidenceRefs: [],
        },
      ],
    };
  }
}

/** Defensive pure parsing shared by later units. Verified means consistent data,
 * never authenticated provenance or permission to construct a live adapter. */
export function parseProjectLifecycle(lifecycle) {
  try {
    return verified(evaluate(null, null, null, snapshotData(lifecycle), true));
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'invalid-evidence');
  }
}

/** Validate an intake proposal or accepted history without fabricating activity.
 * The same evidence envelope carries sources and (only if accepted) its chain. */
export function parseProjectScope(scope, evidence) {
  try {
    const [s, e] = snapshotData([scope, evidence]);
    requireThat(s && ['accepted', 'intake'].includes(s.kind));
    exact(
      s,
      s.kind === 'accepted' ? ['kind', 'history'] : ['kind', 'snapshot', 'nativeObservationRef'],
    );
    const snapshot = s.kind === 'accepted' ? s.history.current : s.snapshot;
    const checked = validateEvidence({
      repositoryId: snapshot.repositoryId,
      projectId: snapshot.projectId,
      evidence: e,
    });
    requireThat(
      e.readiness.length === 0 && e.ci.length === 0 && e.publications.length === 0,
      'scope-only-evidence-required',
    );
    if (s.kind === 'accepted') validateHistory(s.history, checked);
    else {
      requireThat(boundedId(s.nativeObservationRef) && e.chains.length === 0);
      checked.checkScope(s.snapshot);
    }
    checked.complete();
    return verified({ scope: s, evidence: e });
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'invalid-evidence');
  }
}
