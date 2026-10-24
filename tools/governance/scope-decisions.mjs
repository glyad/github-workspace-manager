import { types } from 'node:util';
import { blocked, verified, boundedId, exactFields, sha40, validCandidate } from './contracts.mjs';
import { projectDigest } from './project-baseline.mjs';
import { digest, sameCandidate } from './journal.mjs';
import { parseProjectScope, parseProjectLifecycle } from './project-state.mjs';

const check = (condition, reason = 'invalid-scope-input') => {
  if (!condition) throw Error(reason);
};
const exact = (v, keys) => check(exactFields(v, keys));
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const conflict = (reason) => {
  const error = Error(reason);
  error.kind = 'conflict';
  throw error;
};
const failure = (error) =>
  ['conflict', 'uncertain'].includes(error.kind)
    ? { kind: error.kind, reason: error.message, evidence: [] }
    : blocked(error.message);
const equal = (a, b) => projectDigest(a) === projectDigest(b);
const sorted = (values) => [...new Set(values.flat())].sort();
const ids = (v) => Array.isArray(v) && v.every((id, i) => boundedId(id) && (!i || v[i - 1] < id));
const nullableId = (v) => v === null || boundedId(v);
// Only new wrappers are interpreted here. Unit1 remains the sole scope/lifecycle parser.
// Inspect descriptors before reading; no getters, proxy hooks, coercion or toJSON.
function snapshot(input) {
  let nodes = 0,
    bytes = 0;
  const path = new Set();
  function visit(v, depth = 0) {
    check(++nodes <= 4300000 && depth <= 32, 'input-bound');
    if (v === null || typeof v === 'boolean') {
      bytes += 5;
      return v;
    }
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(v));
      check(bytes <= 8388608 && Buffer.byteLength(v) <= 1048576, 'input-bound');
      return v;
    }
    if (typeof v === 'number') {
      check(Number.isSafeInteger(v));
      bytes += String(v).length;
      check(bytes <= 8388608, 'input-bound');
      return v;
    }
    check(v && typeof v === 'object' && !types.isProxy(v) && !path.has(v), 'plain-json-required');
    const array = Array.isArray(v);
    check(array || [Object.prototype, null].includes(Object.getPrototypeOf(v)));
    const keys = Reflect.ownKeys(v);
    check(keys.length <= 1048577, 'input-bound');
    if (array) {
      const d = Object.getOwnPropertyDescriptor(v, 'length');
      check(d && Object.hasOwn(d, 'value') && d.value + 1 === keys.length);
    }
    const out = array ? [] : {};
    path.add(v);
    for (const key of keys) {
      if (array && key === 'length') continue;
      check(typeof key === 'string' && key !== '__proto__' && key.length <= 128);
      if (array) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < keys.length - 1);
      const d = Object.getOwnPropertyDescriptor(v, key);
      check(d && Object.hasOwn(d, 'value') && d.enumerable);
      bytes += array ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2;
      check(bytes <= 8388608, 'input-bound');
      out[key] = visit(d.value, depth + 1);
    }
    path.delete(v);
    return Object.freeze(out);
  }
  return visit(input);
}
function parsed(result) {
  check(result.kind === 'verified', result.reason);
  return result.value;
}
function chainFor(history, oldChain) {
  const { headDigest: _head, ...rest } = oldChain;
  rest.currentRevision = history.current.revision;
  rest.decisionCount = history.steps.length;
  rest.orderedDecisionIds = history.steps.map((s) => s.decision.decisionId);
  const { ref: _ref, kind: _kind, ...head } = rest;
  return { ...rest, headDigest: projectDigest(head) };
}
function mergeSources(a, b) {
  const sources = new Map();
  for (const source of [...a, ...b]) {
    const old = sources.get(source.ref);
    check(!old || equal(old, source), 'source-definition-conflict');
    for (const other of sources.values())
      check(
        other.ref === source.ref ||
          other.sourceKey !== source.sourceKey ||
          other.sourceDigest !== source.sourceDigest,
        'source-alias',
      );
    sources.set(source.ref, source);
  }
  return [...sources.values()].sort((x, y) => compare(x.ref, y.ref));
}
function decisionShape(d) {
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
  check(
    d.version === 1 &&
      ['decisionId', 'repositoryId', 'ownerActorId', 'sourceRef'].every((k) => boundedId(d[k])) &&
      ['sourceDigest', 'beforeScopeDigest', 'afterScopeDigest'].every((k) => hash(d[k])) &&
      ['accept-version', 'reschedule', 'split', 'defer', 'reduce', 'resolve-closed-pr'].includes(
        d.kind,
      ) &&
      ['affectedRequirementIds', 'closedPrNodeIds', 'dispositionRefs'].every((k) => ids(d[k])) &&
      nullableId(d.destinationMilestoneId),
  );
}
function dispositionShape(d) {
  const common = [
    'kind',
    'decisionRef',
    'scopeDigest',
    'requirementIds',
    'coverageIds',
    'targetSha',
  ];
  check(d && ['no-integrated-code', 'code-disposition'].includes(d.kind));
  exact(d, [
    ...common,
    ...(d.kind === 'no-integrated-code'
      ? ['completeObservationRef']
      : [
          'method',
          'sourceSha',
          'changeCandidate',
          'reviewRef',
          'validationRef',
          'incorporationRef',
        ]),
  ]);
  check(
    boundedId(d.decisionRef) &&
      hash(d.scopeDigest) &&
      ids(d.requirementIds) &&
      d.requirementIds.length &&
      ids(d.coverageIds) &&
      d.coverageIds.length &&
      sha40(d.targetSha),
  );
  if (d.kind === 'no-integrated-code') check(boundedId(d.completeObservationRef));
  else
    check(
      ['reviewed-revert', 'feature-control'].includes(d.method) &&
        sha40(d.sourceSha) &&
        validCandidate(d.changeCandidate) &&
        ['reviewRef', 'validationRef', 'incorporationRef'].every((k) => boundedId(d[k])),
    );
}
function lifecycleFor(input, history) {
  const p = parsed(parseProjectLifecycle(input.lifecycle));
  check(
    p.lifecycle.scope.kind === 'accepted' && equal(p.lifecycle.scope.history, history),
    'lifecycle-history-mismatch',
  );
  check(
    sha40(input.targetSha) && p.lifecycle.integrationTarget.sha === input.targetSha,
    'target-mismatch',
  );
  return p.lifecycle;
}
const leaves = (s) => s.requirements.filter((r) => r.role === 'leaf');
const coverage = (s) => new Map(s.coverageCatalog.map((c) => [c.id, c]));
const contains = (outer, inner) =>
  outer.sourceKey === inner.sourceKey &&
  outer.sourceDigest === inner.sourceDigest &&
  outer.startByte <= inner.startByte &&
  outer.endByte >= inner.endByte;
function removedCoverage(before, after) {
  const a = coverage(before),
    b = coverage(after);
  const removed = [];
  for (const old of leaves(before))
    if (old.milestoneId !== null)
      for (const id of old.coverageIds) {
        const unit = a.get(id);
        for (const next of leaves(after))
          for (const nextId of next.coverageIds)
            if (contains(unit, b.get(nextId)) && next.milestoneId !== old.milestoneId)
              removed.push({ requirement: next, coverageId: nextId });
      }
  return removed;
}
function validateDispositions(
  dispositions,
  removed,
  decision,
  scopeRevision,
  target,
  lifecycle,
  dispositionScope = lifecycle.scope.history.current,
) {
  check(Array.isArray(dispositions) && dispositions.length <= 1000);
  const requiredCoverage = sorted(removed.map((x) => x.coverageId));
  const seen = [];
  for (const d of dispositions) {
    dispositionShape(d);
    check(
      d.decisionRef === decision.decisionId &&
        d.scopeDigest === scopeRevision &&
        d.targetSha === target,
      'disposition-context-mismatch',
    );
    check(
      equal(
        d.requirementIds,
        sorted(
          removed
            .filter((x) => d.coverageIds.includes(x.coverageId))
            .map((x) => x.requirement.requirementId),
        ),
      ),
      'disposition-requirement-mismatch',
    );
    check(
      d.coverageIds.every((id) => requiredCoverage.includes(id) && !seen.includes(id)),
      'disposition-coverage-mismatch',
    );
    seen.push(...d.coverageIds);
    const ref = d.kind === 'no-integrated-code' ? d.completeObservationRef : d.incorporationRef;
    check(decision.dispositionRefs.includes(ref), 'unbound-disposition');
    if (d.kind === 'no-integrated-code') {
      const historical = [
        lifecycle.scope.history.acceptedBaseline.snapshot,
        ...lifecycle.scope.history.steps.flatMap((s) => [s.before, s.after]),
      ];
      const units = removed
        .filter((x) => d.coverageIds.includes(x.coverageId))
        .map((x) => coverage(dispositionScope).get(x.coverageId))
        .filter(Boolean);
      check(
        !lifecycle.integration.some(
          (f) =>
            d.requirementIds.includes(f.requirementId) ||
            historical.some((s) =>
              s.requirements.some(
                (r) =>
                  r.requirementId === f.requirementId &&
                  r.coverageIds.some((id) => units.some((u) => contains(coverage(s).get(id), u))),
              ),
            ),
        ),
        'integrated-code-needs-disposition',
      );
    } else
      check(
        d.changeCandidate.repositoryId === lifecycle.repositoryId,
        'disposition-candidate-repository',
      );
  }
  check(equal(sorted(seen), requiredCoverage), 'missing-disposition');
}
function validateLinks(envelope, before, after, changed) {
  exact(envelope, ['repositoryId', 'projectId', 'observationRef', 'links']);
  check(
    envelope.repositoryId === before.repositoryId &&
      envelope.projectId === before.projectId &&
      boundedId(envelope.observationRef) &&
      Array.isArray(envelope.links),
  );
  const beforeById = new Map(before.requirements.map((r) => [r.requirementId, r]));
  const afterById = new Map(after.requirements.map((r) => [r.requirementId, r]));
  const affected = new Set(changed);
  for (const id of changed) {
    for (const s of [before, after]) {
      const r = s.requirements.find((x) => x.requirementId === id);
      if (r) {
        if (r.parentRequirementId) affected.add(r.parentRequirementId);
        for (const dep of r.dependencyRequirementIds) affected.add(dep);
        for (const child of s.requirements.filter((c) => c.parentRequirementId === id))
          affected.add(child.requirementId);
      }
    }
  }
  const expected = sorted(
    [...affected].map((id) => (beforeById.get(id) ?? afterById.get(id)).issueNodeId),
  );
  check(
    equal(
      envelope.links.map((l) => l.issueNodeId),
      expected,
    ),
    'native-link-closure',
  );
  for (const link of envelope.links) {
    exact(link, [
      'repositoryId',
      'projectId',
      'issueNodeId',
      'projectItemId',
      'milestoneId',
      'parentNodeId',
      'dependencyNodeIds',
      'prNodeIds',
      'historyDigest',
      'observationRef',
    ]);
    check(
      link.repositoryId === before.repositoryId &&
        link.projectId === before.projectId &&
        ['issueNodeId', 'projectItemId', 'observationRef'].every((k) => boundedId(link[k])) &&
        nullableId(link.milestoneId) &&
        nullableId(link.parentNodeId) &&
        ids(link.dependencyNodeIds) &&
        ids(link.prNodeIds) &&
        hash(link.historyDigest),
    );
    const existing = before.requirements.filter((r) => r.issueNodeId === link.issueNodeId);
    const group = existing.length
      ? existing
      : after.requirements.filter((r) => r.issueNodeId === link.issueNodeId);
    const table = existing.length ? beforeById : afterById;
    const old = group[0];
    for (const [requirements, index] of [
      [before.requirements, beforeById],
      [after.requirements, afterById],
    ]) {
      const physical = requirements.filter((r) => r.issueNodeId === link.issueNodeId);
      check(
        sorted(
          physical.map((r) =>
            r.parentRequirementId ? index.get(r.parentRequirementId).issueNodeId : 'none',
          ),
        ).length <= 1,
        'unexpressible-native-parent',
      );
    }
    check(
      group.every((r) => link.milestoneId === r.milestoneId) &&
        link.parentNodeId ===
          (old.parentRequirementId ? table.get(old.parentRequirementId).issueNodeId : null) &&
        equal(
          link.dependencyNodeIds,
          sorted(
            group.flatMap((r) => r.dependencyRequirementIds.map((id) => table.get(id).issueNodeId)),
          ),
        ) &&
        equal(link.prNodeIds, sorted(group.flatMap((r) => r.requiredPrNodeIds))),
      'native-link-drift',
    );
  }
  return envelope.links;
}
function preparePlan(input, decision, observedLinks) {
  exact(input, [
    'scope',
    'evidence',
    'proposed',
    'proposedEvidence',
    'lifecycle',
    'dispositions',
    'targetSha',
  ]);
  const base = parsed(parseProjectScope(input.scope, input.evidence));
  check(base.scope.kind === 'accepted', 'accepted-history-required');
  const history = base.scope.history,
    before = history.current;
  parsed(
    parseProjectScope(
      {
        kind: 'intake',
        snapshot: input.proposed,
        nativeObservationRef: observedLinks.observationRef,
      },
      input.proposedEvidence,
    ),
  );
  decisionShape(decision);
  check(
    decision.repositoryId === before.repositoryId &&
      decision.beforeScopeDigest === before.revision &&
      decision.afterScopeDigest === input.proposed.revision,
    'decision-context-mismatch',
  );
  const acknowledgement = equal(before, input.proposed) && decision.kind === 'resolve-closed-pr';
  if (acknowledgement) {
    const closed = lifecycleFor(input, history)
      .prs.filter(
        (p) =>
          p.state === 'closed-unmerged' &&
          before.requirements.some((r) => r.requiredPrNodeIds.includes(p.prNodeId)),
      )
      .map((p) => p.prNodeId)
      .sort();
    check(
      closed.length &&
        equal(closed, decision.closedPrNodeIds) &&
        equal(
          decision.affectedRequirementIds,
          sorted(
            before.requirements
              .filter((r) => r.requiredPrNodeIds.some((id) => closed.includes(id)))
              .map((r) => r.requirementId),
          ),
        ),
      'closed-acknowledgement-mismatch',
    );
  }
  const nextHistory = {
    ...history,
    steps: [...history.steps, { decision, before, after: input.proposed }],
    current: input.proposed,
  };
  const nextEvidence = {
    ...base.evidence,
    sources: mergeSources(base.evidence.sources, input.proposedEvidence.sources),
    chains: [chainFor(nextHistory, base.evidence.chains[0])],
  };
  if (!acknowledgement)
    parsed(parseProjectScope({ kind: 'accepted', history: nextHistory }, nextEvidence));
  const lifecycle = lifecycleFor(input, history);
  for (const table of ['sources', 'chains'])
    for (const item of base.evidence[table])
      check(
        lifecycle.evidence[table].some((other) => equal(item, other)),
        'scope-lifecycle-evidence-mismatch',
      );
  mergeSources(lifecycle.evidence.sources, input.proposedEvidence.sources);
  const beforeIds = new Map(before.requirements.map((r) => [r.requirementId, r]));
  for (const id of decision.affectedRequirementIds) {
    const next = input.proposed.requirements.find((r) => r.requirementId === id),
      old = beforeIds.get(id);
    if (!next || (old && next.milestoneId === old.milestoneId)) continue;
    // A split's new requirement identity does not move its retained bytes. Only
    // coverage leaving an inherited milestone is governed by the destination.
    const inherited =
      !old &&
      decision.kind === 'split' &&
      (next.role === 'aggregate' ||
        next.coverageIds.every((id) => {
          const unit = coverage(input.proposed).get(id);
          return leaves(before).some(
            (owner) =>
              owner.milestoneId === next.milestoneId &&
              owner.coverageIds.some((oldId) => contains(coverage(before).get(oldId), unit)),
          );
        }));
    if (!inherited)
      check(next.milestoneId === decision.destinationMilestoneId, 'destination-mismatch');
  }
  const links = validateLinks(
    observedLinks,
    before,
    input.proposed,
    decision.affectedRequirementIds,
  );
  const removed = removedCoverage(before, input.proposed);
  validateDispositions(
    input.dispositions,
    removed,
    decision,
    before.revision,
    input.targetSha,
    lifecycle,
    input.proposed,
  );
  const closed = lifecycle.prs
    .filter(
      (pr) =>
        pr.state === 'closed-unmerged' &&
        before.requirements.some(
          (r) =>
            decision.affectedRequirementIds.includes(r.requirementId) &&
            r.requiredPrNodeIds.includes(pr.prNodeId),
        ),
    )
    .map((pr) => pr.prNodeId)
    .sort();
  if (closed.length)
    check(
      decision.kind === 'resolve-closed-pr' && equal(closed, decision.closedPrNodeIds),
      'closed-unmerged-manual-resolution',
    );
  else check(decision.closedPrNodeIds.length === 0, 'unobserved-closed-pr');
  const authority = {
    kind: 'scope',
    decision,
    scopeHistoryDigest: projectDigest(history),
    resolutionRef: decision.sourceRef,
  };
  const operations = [];
  for (const next of input.proposed.requirements) {
    const old = beforeIds.get(next.requirementId);
    if (!old) continue;
    const native = links.find((l) => l.issueNodeId === next.issueNodeId);
    if (old.milestoneId !== next.milestoneId)
      operations.push({
        kind: 'set-milestone',
        repositoryId: before.repositoryId,
        projectId: before.projectId,
        issueNodeId: next.issueNodeId,
        projectItemId: native.projectItemId,
        fromMilestoneId: old.milestoneId,
        toMilestoneId: next.milestoneId,
        beforeScopeDigest: before.revision,
        afterScopeDigest: input.proposed.revision,
        authority,
      });
    if (old.parentRequirementId !== next.parentRequirementId)
      operations.push({
        kind: 'reparent',
        repositoryId: before.repositoryId,
        projectId: before.projectId,
        issueNodeId: next.issueNodeId,
        projectItemId: native.projectItemId,
        fromParentNodeId: old.parentRequirementId
          ? beforeIds.get(old.parentRequirementId).issueNodeId
          : null,
        toParentNodeId: next.parentRequirementId
          ? input.proposed.requirements.find((r) => r.requirementId === next.parentRequirementId)
              .issueNodeId
          : null,
        beforeScopeDigest: before.revision,
        afterScopeDigest: input.proposed.revision,
        authority,
      });
  }
  return {
    decisionRef: decision.sourceRef,
    beforeScopeDigest: before.revision,
    afterScopeDigest: input.proposed.revision,
    affectedRequirementIds: decision.affectedRequirementIds,
    scopeOperations: [...new Map(operations.map((op) => [projectDigest(op), op])).values()],
    statusProjection: null,
    statusProjectionReason: 'requires-independent-scope-postconditions',
    preservationRequirements: links,
  };
}
/** Pure consistency only. Neither this result nor its source refs authorize writes. */
export function planScopeChange(scope, ownerDecision, observedLinks) {
  try {
    const [s, d, l] = snapshot([scope, ownerDecision, observedLinks]);
    return verified(preparePlan(s, d, l));
  } catch (error) {
    return failure(error);
  }
}
function prepareAdmission(history, input) {
  exact(input, ['lifecycle', 'dispositions', 'milestoneId', 'targetSha']);
  check(boundedId(input.milestoneId), 'milestone-required');
  const lifecycle = lifecycleFor(input, history),
    current = history.current;
  const snapshots = [history.acceptedBaseline.snapshot, ...history.steps.map((s) => s.after)];
  const obligations = snapshots.flatMap((s) =>
    leaves(s)
      .filter((r) => r.milestoneId === input.milestoneId)
      .flatMap((r) => r.coverageIds.map((id) => coverage(s).get(id))),
  );
  check(obligations.length, 'empty-current-version');
  const required = leaves(current).filter((r) =>
    r.coverageIds.some((id) => obligations.some((o) => contains(o, coverage(current).get(id)))),
  );
  const completed = [],
    deferred = [],
    used = [];
  const removedByDecision = new Map();
  for (const r of required) {
    const closed = lifecycle.prs.filter(
      (pr) => pr.state === 'closed-unmerged' && r.requiredPrNodeIds.includes(pr.prNodeId),
    );
    for (const pr of closed) {
      const resolution = history.steps.some((step) => {
        const d = step.decision;
        if (
          d.kind !== 'resolve-closed-pr' ||
          !d.affectedRequirementIds.includes(r.requirementId) ||
          !d.closedPrNodeIds.includes(pr.prNodeId)
        )
          return false;
        const continued = step.after.requirements.find(
          (next) => next.requirementId === r.requirementId,
        );
        const observedClosed = sorted(
          step.before.requirements
            .filter((old) => d.affectedRequirementIds.includes(old.requirementId))
            .flatMap((old) => old.requiredPrNodeIds)
            .filter((id) =>
              lifecycle.prs.some((p) => p.prNodeId === id && p.state === 'closed-unmerged'),
            ),
        );
        return (
          continued?.requiredPrNodeIds.includes(pr.prNodeId) &&
          equal(d.closedPrNodeIds, observedClosed)
        );
      });
      check(resolution, 'closed-unmerged-manual-resolution');
    }
    if (r.milestoneId === input.milestoneId) {
      check(r.requiredPrNodeIds.length > 0, 'missing-required-pr');
      check(
        lifecycle.activities.some((a) => a.issueNodeId === r.issueNodeId),
        'missing-activity',
      );
      for (const prId of r.requiredPrNodeIds) {
        const pr = lifecycle.prs.find((p) => p.prNodeId === prId);
        check(
          pr?.state === 'merged' &&
            pr.issueNodeIds.includes(r.issueNodeId) &&
            lifecycle.integration.some(
              (f) =>
                f.requirementId === r.requirementId &&
                f.prNodeId === prId &&
                f.targetSha === input.targetSha &&
                f.targetRef === lifecycle.integrationTarget.ref &&
                sameCandidate(f.candidate, pr.candidate),
            ),
          'missing-current-integration',
        );
      }
      completed.push(r.requirementId);
    } else {
      const relevant = [...history.steps]
        .reverse()
        .find((step) =>
          removedCoverage(step.before, step.after).some((x) =>
            r.coverageIds.some((id) =>
              contains(coverage(step.after).get(x.coverageId), coverage(current).get(id)),
            ),
          ),
        );
      check(relevant, 'missing-owner-deferral');
      const group = removedByDecision.get(relevant.decision.decisionId) ?? {
        decision: relevant.decision,
        removed: [],
      };
      group.removed.push(...r.coverageIds.map((coverageId) => ({ requirement: r, coverageId })));
      removedByDecision.set(relevant.decision.decisionId, group);
      deferred.push(r.requirementId);
    }
  }
  for (const { decision, removed } of removedByDecision.values()) {
    const ds = input.dispositions.filter((d) => d.decisionRef === decision.decisionId);
    validateDispositions(ds, removed, decision, current.revision, input.targetSha, lifecycle);
    used.push(...ds);
  }
  check(used.length === input.dispositions.length, 'extra-disposition');
  return {
    scopeDigest: current.revision,
    milestoneId: input.milestoneId,
    candidate: null,
    targetSha: input.targetSha,
    completedRequirementIds: completed.sort(),
    deferredRequirementIds: deferred.sort(),
    evidenceRefs: sorted([
      history.observationRef,
      lifecycle.observationRef,
      ...lifecycle.integration.map((f) => f.observationRef),
      ...used.flatMap(dispositionRefs),
    ]),
  };
}
export function releaseAdmission(scope, evidence) {
  try {
    const [s, e] = snapshot([scope, evidence]);
    return verified(prepareAdmission(s, e));
  } catch (error) {
    return failure(error);
  }
}
const dispositionRefs = (d) =>
  d.kind === 'no-integrated-code'
    ? [d.decisionRef, d.completeObservationRef]
    : [d.decisionRef, d.reviewRef, d.validationRef, d.incorporationRef];
const historyRefs = (h) => [
  h.acceptedBaseline.ref,
  h.acceptedBaseline.decisionRef,
  h.observationRef,
  ...h.steps.map((s) => s.decision.sourceRef),
];
function requestRefs(kind, payload) {
  if (kind === 'scope-history')
    return sorted([
      ...historyRefs(payload.scope.history),
      ...payload.evidence.sources.map((s) => s.ref),
    ]);
  if (kind === 'owner-decision')
    return sorted([
      payload.decision.sourceRef,
      ...payload.proposedEvidence.sources.map((s) => s.ref),
    ]);
  if (kind === 'native-links')
    return sorted([payload.observationRef, ...payload.links.map((l) => l.observationRef)]);
  if (kind === 'disposition') return sorted(dispositionRefs(payload));
  return sorted([
    ...historyRefs(payload.scope.history),
    payload.observationRef,
    ...payload.activities.map((a) => a.observationRef),
    ...payload.prs.map((p) => p.observationRef),
    ...payload.integration.map((f) => f.observationRef),
    ...payload.publication.map((f) => f.observationRef),
    ...payload.evidence.publications.map((p) => p.inclusion.evidenceRef),
    ...payload.evidence.sources.map((s) => s.ref),
  ]);
}
function responseFor(result, request) {
  exact(
    result,
    result.kind === 'verified' ? ['kind', 'value', 'evidence'] : ['kind', 'reason', 'evidence'],
  );
  check(Array.isArray(result.evidence) && result.evidence.length <= 1000);
  for (const e of result.evidence) {
    const keys = [
      'source',
      'actorId',
      'observedAt',
      'resourceId',
      ...['revision', 'digest'].filter((k) => Object.hasOwn(e, k)),
    ];
    exact(e, keys);
    check(
      ['source', 'actorId', 'observedAt', 'resourceId'].every((k) => boundedId(e[k])) &&
        (!Object.hasOwn(e, 'revision') || boundedId(e.revision)) &&
        (!Object.hasOwn(e, 'digest') || hash(e.digest)),
    );
  }
  if (result.kind !== 'verified') {
    check(
      ['blocked', 'conflict', 'uncertain'].includes(result.kind) &&
        typeof result.reason === 'string' &&
        result.reason.length > 0 &&
        result.reason.length <= 8192,
    );
    return result;
  }
  const response = result.value;
  exact(response, ['version', 'requestDigest', 'bindings']);
  check(
    response.version === 1 && response.requestDigest === request.payloadDigest,
    'resolver-request-mismatch',
  );
  check(Array.isArray(response.bindings));
  check(
    equal(
      response.bindings.map((b) => b.ref),
      requestRefs(request.kind, request.payload),
    ),
    'binding-closure',
  );
  for (const binding of response.bindings) {
    exact(binding, ['ref', 'sourceDigest', 'resourceId', 'actorId', 'revision']);
    check(
      ['ref', 'resourceId', 'actorId', 'revision'].every((k) => boundedId(binding[k])) &&
        hash(binding.sourceDigest),
      'invalid-binding',
    );
  }
  if (request.kind === 'owner-decision') {
    const owner = response.bindings.find((b) => b.ref === request.payload.decision.sourceRef);
    check(
      owner.actorId === request.payload.decision.ownerActorId &&
        owner.sourceDigest === request.payload.decision.sourceDigest,
      'owner-binding-mismatch',
    );
  }
  const sources =
    request.kind === 'owner-decision'
      ? request.payload.proposedEvidence.sources
      : request.kind === 'scope-history'
        ? request.payload.evidence.sources
        : request.kind === 'lifecycle'
          ? request.payload.evidence.sources
          : [];
  if (request.kind === 'scope-history' || request.kind === 'lifecycle')
    for (const step of request.payload.scope.history.steps) {
      const owner = response.bindings.find((b) => b.ref === step.decision.sourceRef);
      check(
        owner.actorId === step.decision.ownerActorId &&
          owner.sourceDigest === step.decision.sourceDigest,
        'historical-owner-binding-mismatch',
      );
    }
  for (const source of sources)
    check(
      response.bindings.find((b) => b.ref === source.ref).sourceDigest === source.sourceDigest,
      'source-binding-mismatch',
    );
  return result;
}
/** Explicit offline test composition. A dishonest configured resolver can lie;
 * private ownership cannot authenticate it. No live constructor exists here. */
export function createOfflineScopeDecisionService(options) {
  check(
    options &&
      typeof options === 'object' &&
      !types.isProxy(options) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(options)),
  );
  check(Reflect.ownKeys(options).length === 1 && Object.hasOwn(options, 'resolve'));
  const descriptor = Object.getOwnPropertyDescriptor(options, 'resolve');
  check(
    descriptor &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.enumerable &&
      typeof descriptor.value === 'function',
  );
  const resolve = descriptor.value;
  async function run(inputs, planning) {
    try {
      const owned = snapshot(inputs);
      const [s, e, links] = owned;
      // Preflight rejects malformed inputs before calling the provider.
      if (planning) preparePlan(s, e, links);
      else prepareAdmission(s, e);
      const history = planning ? s.scope.history : s,
        target = planning ? s.targetSha : e.targetSha;
      const context = {
        repositoryId: history.repositoryId,
        projectId: history.projectId,
        currentScopeRevision: history.current.revision,
        proposedScopeRevision: planning ? s.proposed.revision : null,
        targetSha: target,
      };
      const entries = planning
        ? [
            ['scope-history', { scope: s.scope, evidence: s.evidence }],
            [
              'owner-decision',
              {
                decision: e,
                beforeRevision: history.current.revision,
                afterRevision: s.proposed.revision,
                proposed: s.proposed,
                proposedEvidence: s.proposedEvidence,
              },
            ],
            ['native-links', links],
            ['lifecycle', s.lifecycle],
          ]
        : [['lifecycle', e.lifecycle]];
      const dispositions = planning ? s.dispositions : e.dispositions;
      entries.push(
        ...[...dispositions]
          .sort((a, b) => projectDigest(a).localeCompare(projectDigest(b)))
          .map((d) => ['disposition', d]),
      );
      const requests = entries.map(([kind, payload]) => {
        const r = { version: 1, kind, context, payload };
        return snapshot({ ...r, payloadDigest: projectDigest(r) });
      });
      const registered = [];
      const bindings = new Map();
      for (let pass = 0; pass < 2; pass++)
        for (let i = 0; i < requests.length; i++) {
          const request = requests[i];
          const result = responseFor(snapshot(await resolve(snapshot(request))), request);
          if (result.kind !== 'verified') return result;
          if (pass) {
            if (!equal(registered[i], result.value)) conflict('stale-resolution');
          } else registered.push(result.value);
          for (const binding of result.value.bindings) {
            const old = bindings.get(binding.ref);
            if (old && !equal(old, binding)) conflict('conflicting-source-binding');
            bindings.set(binding.ref, binding);
          }
        }
      // Recalculate only from the closure-owned snapshot after both observation passes.
      return planning ? planScopeChange(s, e, links) : releaseAdmission(s, e);
    } catch (error) {
      return failure(error);
    }
  }
  return Object.freeze({
    planScopeChange: async function (scope, ownerDecision, observedLinks) {
      return run([scope, ownerDecision, observedLinks], true);
    },
    releaseAdmission: async function (scope, evidence) {
      return run([scope, evidence], false);
    },
  });
}

/** Lossless local proposal adapter. Native-ID mappings are explicit input data,
 * never evidence issued by this converter. Historical status remains inert. */
export function convertScopeManifest(manifest, nativeIds) {
  try {
    const [original, idsInput] = snapshot([manifest, nativeIds]);
    exact(idsInput, ['repositoryId', 'projectId', 'milestones']);
    check(
      boundedId(idsInput.repositoryId) &&
        boundedId(idsInput.projectId) &&
        Array.isArray(idsInput.milestones),
    );
    const milestones = new Map();
    for (const m of idsInput.milestones) {
      exact(m, ['name', 'id']);
      check(
        boundedId(m.name) &&
          boundedId(m.id) &&
          !milestones.has(m.name) &&
          ![...milestones.values()].includes(m.id),
      );
      milestones.set(m.name, m.id);
    }
    if (original.nativeIds) {
      check(original.nativeIds.projectId === idsInput.projectId, 'manifest-project-id-mismatch');
      if (original.nativeIds.milestoneId)
        check(
          milestones.get(original.version) === original.nativeIds.milestoneId,
          'manifest-milestone-id-mismatch',
        );
    }
    check(Array.isArray(original.entries) && original.entries.length <= 1000);
    const errors = [],
      keys = new Set(),
      requirements = [],
      catalog = [],
      sources = [],
      provenance = [];
    const nativeIssues = new Map(original.entries.map((entry) => [entry.key, entry.issueNodeId]));
    for (const entry of original.entries) {
      const key = entry.key;
      let sourceBasis = 'none',
        text = null;
      if (
        !boundedId(key) ||
        keys.has(key) ||
        !['product', 'setup', 'deferred', 'version'].includes(entry.kind)
      )
        errors.push(String(key));
      keys.add(key);
      if (entry.kind !== 'version') {
        if (Object.hasOwn(entry, 'acceptance')) {
          if (typeof entry.acceptance === 'string' && entry.acceptance.length) {
            text = entry.acceptance;
            sourceBasis = 'acceptance';
          } else errors.push(String(key));
        } else if (
          entry.kind === 'deferred' &&
          typeof entry.body === 'string' &&
          entry.body.length
        ) {
          text = entry.body;
          sourceBasis = 'body';
        } else errors.push(String(key));
      }
      const byteDigest = text === null ? null : digest(text),
        ref = text === null ? null : `manifest:${key}:${sourceBasis}:${byteDigest}`;
      if (ref !== null && !boundedId(ref)) errors.push(String(key));
      if (
        !boundedId(entry.issueNodeId) ||
        (entry.milestone !== null &&
          entry.milestone !== undefined &&
          !milestones.has(entry.milestone))
      )
        errors.push(String(key));
      if (
        Object.hasOwn(entry, 'parentNodeId') &&
        entry.parentNodeId !== (entry.parentKey ? nativeIssues.get(entry.parentKey) : null)
      )
        errors.push(String(key));
      if (
        Object.hasOwn(entry, 'dependencyNodeIds') &&
        (!Array.isArray(entry.dependencies) ||
          !equal(
            sorted(entry.dependencyNodeIds),
            sorted(
              entry.dependencies.map((key) => nativeIssues.get(key) ?? 'unresolved-native-id'),
            ),
          ))
      )
        errors.push(String(key));
      if (Object.hasOwn(entry, 'lifecycleMapping')) {
        const m = entry.lifecycleMapping;
        if (
          !exactFields(m, ['version', 'acceptanceBytesDigest', 'role', 'initialCoverageId']) ||
          m.version !== 1 ||
          m.acceptanceBytesDigest !== byteDigest ||
          m.role !== (entry.kind === 'version' ? 'aggregate' : 'leaf') ||
          m.initialCoverageId !== (entry.kind === 'version' ? null : `${key}:acceptance`) ||
          sourceBasis === 'body'
        )
          errors.push(String(key));
      }
      provenance.push({
        key,
        sourceBasis,
        sourcePath: entry.source ?? null,
        originalSourceDigest: entry.sourceDigest ?? null,
        proposalAcceptanceBytesDigest: byteDigest,
        sourceRef: ref,
      });
      const coverageId = `${key}:acceptance`;
      if (text !== null) {
        catalog.push({
          id: coverageId,
          sourceKey: key,
          sourceDigest: byteDigest,
          startByte: 0,
          endByte: Buffer.byteLength(text),
          textDigest: byteDigest,
          parentCoverageId: null,
        });
        sources.push({
          ref,
          kind: 'source',
          sourceKey: key,
          sourceDigest: byteDigest,
          utf8Bytes: [...Buffer.from(text)],
        });
      }
      requirements.push({
        requirementId: key,
        sourceKey: key,
        sourceDigest: byteDigest ?? digest(''),
        issueNodeId: entry.issueNodeId,
        parentRequirementId: entry.parentKey ?? null,
        role: entry.kind === 'version' ? 'aggregate' : 'leaf',
        coverageIds: text === null ? [] : [coverageId],
        milestoneId: entry.milestone == null ? null : (milestones.get(entry.milestone) ?? null),
        requiredPrNodeIds: [],
        dependencyRequirementIds: sorted(entry.dependencies ?? []),
        acceptanceDigest: byteDigest ?? digest(''),
      });
    }
    check(errors.length === 0, `invalid-manifest-keys:${sorted(errors).join(',')}`);
    for (const aggregate of requirements.filter((r) => r.role === 'aggregate'))
      aggregate.coverageIds = sorted(
        requirements
          .filter((r) => r.parentRequirementId === aggregate.requirementId)
          .flatMap((r) => r.coverageIds),
      );
    const payload = {
      version: 1,
      repositoryId: idsInput.repositoryId,
      projectId: idsInput.projectId,
      requirements: requirements.sort((a, b) => compare(a.requirementId, b.requirementId)),
      coverageCatalog: catalog.sort((a, b) => compare(a.id, b.id)),
      decisionRefs: [],
    };
    const scope = {
      kind: 'intake',
      snapshot: { ...payload, revision: projectDigest(payload) },
      nativeObservationRef: 'manifest:unresolved-native',
    };
    const evidence = {
      version: 1,
      repositoryId: idsInput.repositoryId,
      projectId: idsInput.projectId,
      sources: sources.sort((a, b) => compare(a.ref, b.ref)),
      readiness: [],
      ci: [],
      publications: [],
      chains: [],
    };
    parsed(parseProjectScope(scope, evidence));
    return verified({
      kind: 'unresolved-intake',
      originalManifest: original,
      scope,
      evidence,
      provenance: provenance.sort((a, b) => compare(a.key, b.key)),
    });
  } catch (error) {
    return failure(error);
  }
}
