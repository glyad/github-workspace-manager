import { types } from 'node:util';
import { boundedId, exactFields, verified, blocked } from './contracts.mjs';
import { projectDigest } from './project-baseline.mjs';
import { parseProjectLifecycle, deriveProjectState } from './project-state.mjs';
import { createOfflineScopeDecisionService, planScopeChange } from './scope-decisions.mjs';

const check = (ok, message = 'Invalid Project data') => {
  if (!ok) throw Error(message);
};
const exact = (value, keys) => check(exactFields(value, keys));
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const equal = (a, b) => projectDigest(a) === projectDigest(b);
const ids = (a) =>
  Array.isArray(a) && a.length <= 1000 && a.every((v, i) => boundedId(v) && (!i || a[i - 1] < v));
const sorted = (a) => [...new Set(a)].sort();
const nullable = (v) => v === null || boundedId(v);
const failure = (e) => ({ kind: e.kind ?? 'blocked', reason: e.message, evidence: [] });
const uncertain = (reason) => ({ kind: 'uncertain', reason, evidence: [] });
const fail = (reason, kind = 'conflict') => {
  const e = Error(reason);
  e.kind = kind;
  throw e;
};

/** Data-only bounded ownership for the controller and its TEST storage adapter. */
export function snapshotProjectData(input) {
  let bytes = 0,
    nodes = 0;
  const path = new Set();
  function visit(v, depth = 0) {
    check(++nodes <= 4300000 && depth <= 32, 'Project data bound');
    if (v === null || typeof v === 'boolean') {
      bytes += 5;
      return v;
    }
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(v));
      check(bytes <= 8388608 && Buffer.byteLength(v) <= 16384, 'Project string bound');
      return v;
    }
    if (typeof v === 'number') {
      check(Number.isFinite(v));
      bytes += String(v).length;
      return v;
    }
    check(
      v && typeof v === 'object' && !types.isProxy(v) && !path.has(v),
      'Plain Project JSON required',
    );
    const array = Array.isArray(v);
    check(array || [Object.prototype, null].includes(Object.getPrototypeOf(v)));
    const keys = Reflect.ownKeys(v);
    check(keys.length <= 1048577);
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
      bytes += array ? 1 : Buffer.byteLength(key) + 3;
      check(bytes <= 8388608);
      out[key] = visit(d.value, depth + 1);
    }
    path.delete(v);
    return Object.freeze(out);
  }
  const owned = visit(input);
  check(Buffer.byteLength(JSON.stringify(owned)) <= 8388608, 'Project data bound');
  return owned;
}
export function validateProjectBinding(b) {
  exact(b, [
    'version',
    'operationId',
    'repositoryId',
    'projectId',
    'planDigest',
    'authorityDigest',
    'stepCount',
  ]);
  check(
    b.version === 1 &&
      boundedId(b.repositoryId) &&
      boundedId(b.projectId) &&
      hash(b.planDigest) &&
      hash(b.authorityDigest) &&
      Number.isSafeInteger(b.stepCount) &&
      b.stepCount >= 0 &&
      b.stepCount <= 1000,
  );
  const { operationId, ...logical } = b;
  check(
    hash(operationId) && operationId === projectDigest(logical),
    'Logical Project operation mismatch',
  );
}
function bindingShape(b) {
  exact(b, ['ref', 'sourceDigest', 'resourceId', 'actorId', 'revision']);
  check(
    ['ref', 'resourceId', 'actorId', 'revision'].every((k) => boundedId(b[k])) &&
      hash(b.sourceDigest),
  );
}
function bindingsShape(a) {
  check(Array.isArray(a) && a.length <= 1000 && ids(a.map((b) => b.ref)));
  a.forEach(bindingShape);
}
function payloadShape(p) {
  const shapes = {
    milestone: ['kind', 'issueNodeId', 'milestoneId'],
    parent: ['kind', 'issueNodeId', 'parentNodeId'],
    status: ['kind', 'issueNodeId', 'projectItemId', 'fieldId', 'optionId'],
  };
  check(shapes[p?.kind]);
  exact(p, shapes[p.kind]);
  check(boundedId(p.issueNodeId));
  if (p.kind === 'milestone') check(nullable(p.milestoneId));
  if (p.kind === 'parent') check(nullable(p.parentNodeId));
  if (p.kind === 'status')
    check(boundedId(p.projectItemId) && boundedId(p.fieldId) && nullable(p.optionId));
}
function stepShape(s) {
  exact(s, ['index', 'kind', 'issueNodeId', 'authorityKind', 'before', 'after']);
  check(
    Number.isSafeInteger(s.index) && s.index >= 0 && s.index < 1000 && boundedId(s.issueNodeId),
  );
  payloadShape(s.before);
  payloadShape(s.after);
  check(
    s.before.issueNodeId === s.issueNodeId &&
      s.after.issueNodeId === s.issueNodeId &&
      s.before.kind === s.after.kind,
  );
  check(
    (s.kind === 'set-milestone' && s.before.kind === 'milestone' && s.authorityKind === 'scope') ||
      (['detach-parent', 'attach-parent'].includes(s.kind) &&
        s.before.kind === 'parent' &&
        s.authorityKind === 'scope' &&
        (s.kind === 'detach-parent'
          ? s.before.parentNodeId !== null && s.after.parentNodeId === null
          : s.before.parentNodeId === null && s.after.parentNodeId !== null)) ||
      (s.kind === 'set-status' &&
        s.before.kind === 'status' &&
        s.authorityKind === 'projection' &&
        s.before.projectItemId === s.after.projectItemId &&
        s.before.fieldId === s.after.fieldId &&
        boundedId(s.after.optionId)),
  );
}
function linkShape(l) {
  exact(l, [
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
    ['repositoryId', 'projectId', 'issueNodeId', 'projectItemId', 'observationRef'].every((k) =>
      boundedId(l[k]),
    ) &&
      nullable(l.milestoneId) &&
      nullable(l.parentNodeId) &&
      ids(l.dependencyNodeIds) &&
      ids(l.prNodeIds) &&
      hash(l.historyDigest),
  );
}
function observationShape(o) {
  exact(o, [
    'version',
    'kind',
    'repositoryId',
    'projectId',
    'operationId',
    'stepId',
    'revision',
    'payload',
    'links',
    'historyRefs',
    'sourceBindings',
  ]);
  check(
    o.version === 1 &&
      o.kind === 'step' &&
      ['repositoryId', 'projectId', 'revision'].every((k) => boundedId(o[k])) &&
      hash(o.operationId) &&
      hash(o.stepId),
  );
  payloadShape(o.payload);
  check(Array.isArray(o.links) && ids(o.links.map((l) => l.issueNodeId)));
  o.links.forEach(linkShape);
  check(ids(o.historyRefs));
  bindingsShape(o.sourceBindings);
  for (const l of o.links)
    check(
      l.repositoryId === o.repositoryId &&
        l.projectId === o.projectId &&
        o.sourceBindings.some((b) => b.ref === l.observationRef),
    );
  for (const ref of o.historyRefs) check(o.sourceBindings.some((b) => b.ref === ref));
}
function applyShape(a) {
  exact(a, [
    'version',
    'repositoryId',
    'projectId',
    'operationId',
    'stepId',
    'step',
    'expectedRevision',
    'expectedPayloadDigest',
    'authorityDigest',
  ]);
  check(
    a.version === 1 &&
      ['repositoryId', 'projectId', 'expectedRevision'].every((k) => boundedId(a[k])) &&
      ['operationId', 'stepId', 'expectedPayloadDigest', 'authorityDigest'].every((k) =>
        hash(a[k]),
      ),
  );
  stepShape(a.step);
}
function receiptShape(r) {
  exact(r, [
    'version',
    'repositoryId',
    'projectId',
    'operationId',
    'stepId',
    'resourceId',
    'requestDigest',
    'receiptRef',
    'sourceBinding',
  ]);
  check(
    r.version === 1 &&
      ['repositoryId', 'projectId', 'resourceId', 'receiptRef'].every((k) => boundedId(r[k])) &&
      ['operationId', 'stepId', 'requestDigest'].every((k) => hash(r[k])),
  );
  bindingShape(r.sourceBinding);
  check(r.receiptRef === r.sourceBinding.ref);
}
const statuses = ['Backlog', 'Planned', 'In progress', 'In review', 'Integrated', 'Released'];
function statusShape(o) {
  exact(o, [
    'version',
    'kind',
    'repositoryId',
    'projectId',
    'issueNodeId',
    'projectItemId',
    'fieldId',
    'fieldName',
    'options',
    'currentOptionId',
    'revision',
    'observationRef',
    'sourceBindings',
  ]);
  check(
    o.version === 1 &&
      o.kind === 'status-target' &&
      o.fieldName === 'Status' &&
      [
        'repositoryId',
        'projectId',
        'issueNodeId',
        'projectItemId',
        'fieldId',
        'revision',
        'observationRef',
      ].every((k) => boundedId(o[k])),
  );
  check(
    Array.isArray(o.options) &&
      o.options.length === 6 &&
      o.options.every((option, i) => {
        exact(option, ['name', 'id']);
        return option.name === statuses[i] && boundedId(option.id);
      }) &&
      new Set(o.options.map((v) => v.id)).size === 6 &&
      (o.currentOptionId === null || o.options.some((v) => v.id === o.currentOptionId)),
  );
  bindingsShape(o.sourceBindings);
  check(o.sourceBindings.some((b) => b.ref === o.observationRef));
}
function planShape(p) {
  exact(p, ['version', 'repositoryId', 'projectId', 'inputDigest', 'authorityDigest', 'steps']);
  check(
    p.version === 1 &&
      boundedId(p.repositoryId) &&
      boundedId(p.projectId) &&
      hash(p.inputDigest) &&
      hash(p.authorityDigest) &&
      Array.isArray(p.steps) &&
      p.steps.length <= 1000,
  );
  p.steps.forEach((s, i) => {
    stepShape(s);
    check(s.index === i);
  });
}
const stepId = (operationId, step) => projectDigest({ operationId, index: step.index, step });
function receiptMatches(r, a) {
  receiptShape(r);
  check(
    ['repositoryId', 'projectId', 'operationId', 'stepId'].every((k) => r[k] === a[k]) &&
      r.requestDigest === projectDigest(a) &&
      r.resourceId ===
        (a.step.kind === 'set-status' ? a.step.after.projectItemId : a.step.issueNodeId),
    'Unattributed native receipt',
  );
}
/** Parser shared by ordinary append, restart and explicit recovery. It grants no authority. */
export function validateProjectRecords(binding, records) {
  validateProjectBinding(binding);
  check(Array.isArray(records) && records.length <= 1000);
  const completed = new Set(),
    pending = new Map(),
    receipts = new Map(),
    resolutions = [];
  let plan;
  records.forEach((r, i) => {
    exact(r, [
      'version',
      'operationId',
      'index',
      'previousRecordDigest',
      'phase',
      'stepId',
      'data',
    ]);
    check(
      r.version === 1 &&
        r.operationId === binding.operationId &&
        r.index === i &&
        r.previousRecordDigest === (i ? projectDigest(records[i - 1]) : null),
    );
    if (!i) {
      check(r.phase === 'bound' && r.stepId === null);
      exact(r.data, ['binding', 'plan', 'statusTarget']);
      check(equal(r.data.binding, binding));
      plan = r.data.plan;
      planShape(plan);
      check(
        projectDigest(plan) === binding.planDigest &&
          plan.authorityDigest === binding.authorityDigest &&
          plan.steps.length === binding.stepCount &&
          plan.repositoryId === binding.repositoryId &&
          plan.projectId === binding.projectId,
      );
      if (r.data.statusTarget !== null) {
        const t = r.data.statusTarget;
        statusShape(t);
        check(
          plan.steps.length === 1 &&
            plan.steps[0].kind === 'set-status' &&
            t.repositoryId === binding.repositoryId &&
            t.projectId === binding.projectId &&
            t.issueNodeId === plan.steps[0].issueNodeId &&
            t.projectItemId === plan.steps[0].before.projectItemId &&
            t.fieldId === plan.steps[0].before.fieldId &&
            t.currentOptionId === plan.steps[0].before.optionId &&
            t.options.some((o) => o.id === plan.steps[0].after.optionId),
        );
      } else check(plan.steps.every((s) => s.authorityKind === 'scope'));
      return;
    }
    check(r.phase !== 'bound');
    if (r.phase === 'reconciliation') {
      check(r.stepId === null);
      exact(r.data, ['request', 'response', 'resolutions']);
      check(
        equal(r.data.request.resolutions, r.data.resolutions) &&
          equal(r.data.request.binding, binding),
      );
      validateProjectRecoveryResponse(r.data.request, r.data.response);
      const expected = [...pending.values()].map((v) => v.index).sort((a, b) => a - b);
      check(
        equal(expected, r.data.request.unresolvedIntentIndices) &&
          equal(
            expected,
            r.data.resolutions.map((v) => v.intentIndex),
          ),
      );
      for (const resolution of r.data.resolutions) {
        const intent = [...pending.values()].find((v) => v.index === resolution.intentIndex);
        validateProjectResolution(intent, resolution);
        pending.delete(intent.stepId);
        receipts.delete(intent.stepId);
        if (resolution.outcome === 'applied') completed.add(intent.stepId);
      }
      resolutions.push(r);
      return;
    }
    const s = plan.steps.find((s) => stepId(binding.operationId, s) === r.stepId);
    check(s && !completed.has(r.stepId), 'Unknown or already terminal step');
    check(
      plan.steps.slice(0, s.index).every((s) => completed.has(stepId(binding.operationId, s))),
      'Unverified earlier step',
    );
    if (r.phase === 'intent') {
      exact(r.data, ['step', 'before', 'applyRequest']);
      check(!pending.has(r.stepId) && equal(r.data.step, s));
      observationShape(r.data.before);
      applyShape(r.data.applyRequest);
      check(
        equal(r.data.before.payload, s.before) &&
          equal(r.data.applyRequest.step, s) &&
          r.data.before.repositoryId === binding.repositoryId &&
          r.data.before.projectId === binding.projectId &&
          r.data.before.operationId === binding.operationId &&
          r.data.before.stepId === r.stepId &&
          r.data.applyRequest.repositoryId === binding.repositoryId &&
          r.data.applyRequest.projectId === binding.projectId &&
          r.data.applyRequest.operationId === binding.operationId &&
          r.data.applyRequest.stepId === r.stepId &&
          r.data.applyRequest.authorityDigest === binding.authorityDigest &&
          r.data.applyRequest.expectedRevision === r.data.before.revision &&
          r.data.applyRequest.expectedPayloadDigest === projectDigest(s.before),
      );
      pending.set(r.stepId, r);
    } else if (r.phase === 'receipt') {
      exact(r.data, ['receipt']);
      const intent = pending.get(r.stepId);
      check(intent && !receipts.has(r.stepId));
      receiptMatches(r.data.receipt, intent.data.applyRequest);
      receipts.set(r.stepId, r.data.receipt);
    } else if (r.phase === 'verified') {
      exact(r.data, ['observation', 'outcome']);
      observationShape(r.data.observation);
      const o = r.data.observation;
      check(
        o.repositoryId === binding.repositoryId &&
          o.projectId === binding.projectId &&
          o.operationId === binding.operationId &&
          o.stepId === r.stepId &&
          equal(o.payload, s.after),
      );
      if (r.data.outcome === 'applied') {
        const receipt = receipts.get(r.stepId);
        check(receipt && o.sourceBindings.some((b) => equal(b, receipt.sourceBinding)));
      } else check(r.data.outcome === 'already-present' && !pending.has(r.stepId));
      pending.delete(r.stepId);
      receipts.delete(r.stepId);
      completed.add(r.stepId);
    } else check(false, 'Unknown Project phase');
  });
  return { completed, pending, receipts, resolutions, plan };
}
function resolutionRefs(records, resolutions) {
  return sorted([
    ...records.flatMap((r) => [
      `record:${r.operationId}:${r.index}`,
      ...(r.phase === 'bound' ? (r.data.statusTarget?.sourceBindings.map((b) => b.ref) ?? []) : []),
      ...(r.phase === 'intent' ? r.data.before.sourceBindings.map((b) => b.ref) : []),
      ...(r.phase === 'receipt' ? [r.data.receipt.receiptRef] : []),
      ...(r.phase === 'verified' ? r.data.observation.sourceBindings.map((b) => b.ref) : []),
      ...(r.phase === 'reconciliation'
        ? [r.data.request.recoveryRef, ...r.data.response.recordBindings.map((b) => b.ref)]
        : []),
    ]),
    ...resolutions.flatMap((r) => [
      ...r.observation.sourceBindings.map((b) => b.ref),
      ...r.attributionRefs,
      ...(r.receipt ? [r.receipt.receiptRef] : []),
    ]),
  ]);
}
export function validateProjectResolution(intent, r) {
  exact(r, [
    'intentIndex',
    'stepId',
    'requestDigest',
    'outcome',
    'observation',
    'receipt',
    'attributionRefs',
  ]);
  check(
    intent &&
      r.intentIndex === intent.index &&
      r.stepId === intent.stepId &&
      r.requestDigest === projectDigest(intent.data.applyRequest) &&
      ['applied', 'confirmed-not-applied'].includes(r.outcome) &&
      ids(r.attributionRefs) &&
      r.attributionRefs.length,
  );
  observationShape(r.observation);
  check(
    r.observation.repositoryId === intent.data.applyRequest.repositoryId &&
      r.observation.projectId === intent.data.applyRequest.projectId &&
      r.observation.operationId === intent.operationId &&
      r.observation.stepId === intent.stepId &&
      equal(r.observation.payload, intent.data.step[r.outcome === 'applied' ? 'after' : 'before']),
  );
  if (r.receipt !== null) receiptMatches(r.receipt, intent.data.applyRequest);
  for (const ref of r.attributionRefs)
    check(r.observation.sourceBindings.some((b) => b.ref === ref));
}
export function validateProjectRecoveryResponse(request, response) {
  exact(request, [
    'version',
    'recoveryRef',
    'rootIdentity',
    'binding',
    'lockIdentity',
    'journalDigest',
    'witnessDigest',
    'unresolvedIntentIndices',
    'resolutions',
    'retainedRecords',
  ]);
  check(
    request.version === 1 &&
      boundedId(request.recoveryRef) &&
      hash(request.journalDigest) &&
      hash(request.witnessDigest),
  );
  validateProjectBinding(request.binding);
  const root = request.rootIdentity,
    lock = request.lockIdentity;
  exact(root, [
    'version',
    'repositoryId',
    'projectId',
    'rootId',
    'rootDev',
    'rootIno',
    'scopeDev',
    'scopeIno',
  ]);
  check(
    root.version === 1 &&
      root.repositoryId === request.binding.repositoryId &&
      root.projectId === request.binding.projectId &&
      boundedId(root.rootId) &&
      ['rootDev', 'rootIno', 'scopeDev', 'scopeIno'].every(
        (k) => Number.isSafeInteger(root[k]) && root[k] >= 0,
      ),
  );
  exact(lock, ['key', 'operationId', 'token', 'pid', 'dev', 'ino', 'birthtimeMs', 'rootId']);
  check(
    lock.key === `project-lifecycle:${root.repositoryId}:${root.projectId}` &&
      lock.operationId === request.binding.operationId &&
      lock.rootId === root.rootId &&
      boundedId(lock.token) &&
      Number.isSafeInteger(lock.pid) &&
      lock.pid > 0 &&
      ['dev', 'ino'].every((k) => Number.isSafeInteger(lock[k]) && lock[k] >= 0) &&
      Number.isFinite(lock.birthtimeMs) &&
      lock.birthtimeMs >= 0,
  );
  check(
    Array.isArray(request.unresolvedIntentIndices) &&
      request.unresolvedIntentIndices.length <= 1000 &&
      request.unresolvedIntentIndices.every(
        (v, i) =>
          Number.isSafeInteger(v) && v >= 0 && (!i || request.unresolvedIntentIndices[i - 1] < v),
      ) &&
      Array.isArray(request.resolutions) &&
      request.resolutions.length <= 1000 &&
      Array.isArray(request.retainedRecords) &&
      request.retainedRecords.length <= 1000,
  );
  exact(response, ['version', 'requestDigest', 'operatorBinding', 'recordBindings']);
  check(response.version === 1 && response.requestDigest === projectDigest(request));
  bindingShape(response.operatorBinding);
  check(response.operatorBinding.ref === request.recoveryRef);
  bindingsShape(response.recordBindings);
  check(
    equal(
      response.recordBindings.map((b) => b.ref),
      resolutionRefs(request.retainedRecords, request.resolutions),
    ),
    'Recovery binding closure',
  );
  const all = [
    ...request.retainedRecords.flatMap((r) =>
      r.phase === 'intent'
        ? r.data.before.sourceBindings
        : r.phase === 'verified'
          ? r.data.observation.sourceBindings
          : r.phase === 'receipt'
            ? [r.data.receipt.sourceBinding]
            : r.phase === 'bound'
              ? (r.data.statusTarget?.sourceBindings ?? [])
              : [],
    ),
    ...request.resolutions.flatMap((r) => [
      ...r.observation.sourceBindings,
      ...(r.receipt ? [r.receipt.sourceBinding] : []),
    ]),
  ];
  for (const b of all)
    check(
      response.recordBindings.some((other) => equal(b, other)),
      'Recovery original binding mismatch',
    );
}
function lifecycleRefs(l) {
  const h = l.scope.kind === 'accepted' ? l.scope.history : null;
  return sorted([
    ...(h
      ? [
          h.acceptedBaseline.ref,
          h.acceptedBaseline.decisionRef,
          h.observationRef,
          ...h.steps.map((s) => s.decision.sourceRef),
        ]
      : []),
    l.observationRef,
    ...l.activities.map((v) => v.observationRef),
    ...l.prs.map((v) => v.observationRef),
    ...l.integration.map((v) => v.observationRef),
    ...l.publication.map((v) => v.observationRef),
    ...l.evidence.sources.map((v) => v.ref),
    ...l.evidence.publications.map((v) => v.inclusion.evidenceRef),
  ]);
}
function originalRequests(input) {
  const l = input.kind === 'scope' ? input.scope.lifecycle : input.lifecycle;
  const h = l.scope.kind === 'accepted' ? l.scope.history : null;
  const context = {
    repositoryId: l.repositoryId,
    projectId: l.projectId,
    currentScopeRevision: l.projection.scopeRevision,
    proposedScopeRevision: input.kind === 'scope' ? input.scope.proposed.revision : null,
    targetSha: l.integrationTarget.sha,
  };
  let entries = [['lifecycle', l, lifecycleRefs(l)]];
  if (input.kind === 'scope') {
    const s = input.scope;
    entries = [
      [
        'scope-history',
        { scope: s.scope, evidence: s.evidence },
        sorted([
          h.acceptedBaseline.ref,
          h.acceptedBaseline.decisionRef,
          h.observationRef,
          ...h.steps.map((v) => v.decision.sourceRef),
          ...s.evidence.sources.map((v) => v.ref),
        ]),
      ],
      [
        'owner-decision',
        {
          decision: input.ownerDecision,
          beforeRevision: h.current.revision,
          afterRevision: s.proposed.revision,
          proposed: s.proposed,
          proposedEvidence: s.proposedEvidence,
        },
        sorted([input.ownerDecision.sourceRef, ...s.proposedEvidence.sources.map((v) => v.ref)]),
      ],
      ...entries,
      ...[...s.dispositions]
        .sort((a, b) => projectDigest(a).localeCompare(projectDigest(b)))
        .map((d) => [
          'disposition',
          d,
          sorted(
            d.kind === 'no-integrated-code'
              ? [d.decisionRef, d.completeObservationRef]
              : [d.decisionRef, d.reviewRef, d.validationRef, d.incorporationRef],
          ),
        ]),
    ];
  }
  return { context, entries };
}
function requestFor(kind, payload, context) {
  const request = { version: 1, kind, context, payload };
  return snapshotProjectData({ ...request, payloadDigest: projectDigest(request) });
}
export function projectResultValue(result) {
  const owned = snapshotProjectData(result);
  exact(
    owned,
    owned.kind === 'verified' ? ['kind', 'value', 'evidence'] : ['kind', 'reason', 'evidence'],
  );
  check(Array.isArray(owned.evidence) && owned.evidence.length <= 1000);
  for (const e of owned.evidence) {
    exact(e, [
      'source',
      'actorId',
      'observedAt',
      'resourceId',
      ...['revision', 'digest'].filter((k) => Object.hasOwn(e, k)),
    ]);
    check(
      ['source', 'actorId', 'observedAt', 'resourceId'].every((k) => boundedId(e[k])) &&
        (!Object.hasOwn(e, 'revision') || boundedId(e.revision)) &&
        (!Object.hasOwn(e, 'digest') || hash(e.digest)),
    );
  }
  if (owned.kind !== 'verified') {
    check(
      ['blocked', 'conflict', 'uncertain'].includes(owned.kind) &&
        typeof owned.reason === 'string' &&
        owned.reason.length > 0 &&
        owned.reason.length <= 8192,
    );
    fail(owned.reason, owned.kind);
  }
  return owned.value;
}
function resolutionResponse(result, request, refs) {
  const response = projectResultValue(result);
  exact(response, ['version', 'requestDigest', 'bindings']);
  check(response.version === 1 && response.requestDigest === request.payloadDigest);
  bindingsShape(response.bindings);
  check(
    equal(
      response.bindings.map((b) => b.ref),
      refs,
    ),
    'Project resolver binding closure',
  );
  return response.bindings;
}
function mergeBindings(map, bindings) {
  for (const binding of bindings) {
    if (map.has(binding.ref) && !equal(map.get(binding.ref), binding))
      fail('Changed Project source binding');
    map.set(binding.ref, binding);
  }
}
function ownDependencies(options) {
  check(
    options &&
      typeof options === 'object' &&
      !types.isProxy(options) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(options)),
  );
  const names = ['store', 'port', 'resolve', 'resolveRecovery'];
  check(Reflect.ownKeys(options).length === names.length);
  const result = {};
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(options, name);
    check(d && Object.hasOwn(d, 'value') && d.enumerable);
    result[name] = d.value;
  }
  check(typeof result.resolve === 'function' && typeof result.resolveRecovery === 'function');
  for (const [key, names] of [
    ['port', ['observe', 'apply']],
    [
      'store',
      [
        'findProjectLifecycle',
        'withProjectLifecycleLock',
        'readProjectLifecycle',
        'appendProjectLifecycle',
        'withProjectLifecycleRecovery',
        'appendProjectLifecycleRecovery',
      ],
    ],
  ]) {
    check(result[key] && !types.isProxy(result[key]));
    const captured = {};
    for (const name of names) {
      let target = result[key],
        d;
      while (target) {
        check(!types.isProxy(target));
        d = Object.getOwnPropertyDescriptor(target, name);
        if (d) break;
        target = Object.getPrototypeOf(target);
      }
      check(d && Object.hasOwn(d, 'value') && typeof d.value === 'function');
      captured[name] = d.value.bind(result[key]);
    }
    result[key] = Object.freeze(captured);
  }
  return result;
}
/** Explicit fixture composition only. Configured providers are the trust boundary;
 * neither this constructor nor JSON binding records authenticate real GitHub access. */
export function createOfflineProjectController(options) {
  const { store, port, resolve, resolveRecovery } = ownDependencies(options);
  async function originals(input, expected = null) {
    const { context, entries } = originalRequests(input),
      bindings = new Map();
    for (const [kind, payload, refs] of entries) {
      const request = requestFor(kind, payload, context);
      const rows = resolutionResponse(await resolve(snapshotProjectData(request)), request, refs);
      mergeBindings(bindings, rows);
      const sources =
        kind === 'scope-history' || kind === 'lifecycle'
          ? payload.evidence.sources
          : kind === 'owner-decision'
            ? payload.proposedEvidence.sources
            : [];
      for (const s of sources)
        check(
          bindings.get(s.ref)?.sourceDigest === s.sourceDigest,
          'Project source digest mismatch',
        );
      const decisions =
        kind === 'owner-decision'
          ? [payload.decision]
          : ['scope-history', 'lifecycle'].includes(kind) && payload.scope.kind === 'accepted'
            ? payload.scope.history.steps.map((s) => s.decision)
            : [];
      for (const d of decisions)
        check(
          bindings.get(d.sourceRef)?.actorId === d.ownerActorId &&
            bindings.get(d.sourceRef)?.sourceDigest === d.sourceDigest,
          'Project owner original mismatch',
        );
    }
    if (expected)
      for (const [ref, b] of expected)
        check(bindings.has(ref) && equal(bindings.get(ref), b), 'Stale Project authority');
    return { context, bindings };
  }
  async function statusTarget(l) {
    const request = snapshotProjectData({
      version: 1,
      kind: 'status-target',
      repositoryId: l.repositoryId,
      projectId: l.projectId,
      issueNodeId: l.projection.issueNodeId,
    });
    const result = projectResultValue(await port.observe(request));
    statusShape(result);
    check(
      ['repositoryId', 'projectId', 'issueNodeId'].every((k) => result[k] === request[k]),
      'Wrong Status target',
    );
    return result;
  }
  function validateInput(input) {
    exact(
      input,
      input.kind === 'scope'
        ? ['version', 'kind', 'scope', 'ownerDecision', 'observedLinks']
        : ['version', 'kind', 'lifecycle'],
    );
    check(input.version === 1 && ['scope', 'status'].includes(input.kind));
    const l = input.kind === 'scope' ? input.scope.lifecycle : input.lifecycle;
    projectResultValue(parseProjectLifecycle(l));
    if (input.kind === 'scope')
      projectResultValue(planScopeChange(input.scope, input.ownerDecision, input.observedLinks));
    else check(l.projection.milestoneId === null, 'Complete Issue projection required');
    return l;
  }
  async function prepare(input, retained = null) {
    exact(
      input,
      input.kind === 'scope'
        ? ['version', 'kind', 'scope', 'ownerDecision', 'observedLinks']
        : ['version', 'kind', 'lifecycle'],
    );
    check(input.version === 1 && ['scope', 'status'].includes(input.kind));
    let steps = [],
      authority,
      target = null,
      preservation;
    const l = input.kind === 'scope' ? input.scope.lifecycle : input.lifecycle;
    const parsed = projectResultValue(parseProjectLifecycle(l));
    const state = deriveProjectState(
      parsed.requirements,
      parsed.integrationFacts,
      parsed.publicationFacts,
      l,
    );
    if (input.kind === 'scope') {
      projectResultValue(planScopeChange(input.scope, input.ownerDecision, input.observedLinks));
      const service = createOfflineScopeDecisionService({ resolve });
      const change = retained
        ? projectResultValue(planScopeChange(input.scope, input.ownerDecision, input.observedLinks))
        : projectResultValue(
            await service.planScopeChange(input.scope, input.ownerDecision, input.observedLinks),
          );
      preservation = change.preservationRequirements;
      authority = {
        kind: 'scope',
        decision: input.ownerDecision,
        scopeHistoryDigest: projectDigest(input.scope.scope.history),
        resolutionRef: input.ownerDecision.sourceRef,
      };
      for (const op of change.scopeOperations) {
        check(equal(op.authority, authority));
        if (op.kind === 'set-milestone')
          steps.push({
            kind: 'set-milestone',
            issueNodeId: op.issueNodeId,
            authorityKind: 'scope',
            before: {
              kind: 'milestone',
              issueNodeId: op.issueNodeId,
              milestoneId: op.fromMilestoneId,
            },
            after: {
              kind: 'milestone',
              issueNodeId: op.issueNodeId,
              milestoneId: op.toMilestoneId,
            },
          });
        else if (op.kind === 'reparent') {
          if (op.fromParentNodeId !== null)
            steps.push({
              kind: 'detach-parent',
              issueNodeId: op.issueNodeId,
              authorityKind: 'scope',
              before: {
                kind: 'parent',
                issueNodeId: op.issueNodeId,
                parentNodeId: op.fromParentNodeId,
              },
              after: { kind: 'parent', issueNodeId: op.issueNodeId, parentNodeId: null },
            });
          if (op.toParentNodeId !== null)
            steps.push({
              kind: 'attach-parent',
              issueNodeId: op.issueNodeId,
              authorityKind: 'scope',
              before: { kind: 'parent', issueNodeId: op.issueNodeId, parentNodeId: null },
              after: {
                kind: 'parent',
                issueNodeId: op.issueNodeId,
                parentNodeId: op.toParentNodeId,
              },
            });
        } else fail('Unsupported scope operation', 'blocked');
      }
    } else {
      check(l.projection.milestoneId === null, 'Complete Issue projection required');
      target = retained ? retained.records[0].data.statusTarget : await statusTarget(l);
      statusShape(target);
      const optionId = target.options.find((o) => o.name === state.status).id;
      authority = {
        kind: 'projection',
        projectionDigest: projectDigest(l.projection),
        lifecycleObservationRef: l.observationRef,
        scopeHistoryDigest: projectDigest(l.scope.kind === 'accepted' ? l.scope.history : l.scope),
        issueNodeId: target.issueNodeId,
        projectItemId: target.projectItemId,
        fieldId: target.fieldId,
        fromOptionId: target.currentOptionId,
        toOptionId: optionId,
      };
      steps = [
        {
          kind: 'set-status',
          issueNodeId: target.issueNodeId,
          authorityKind: 'projection',
          before: {
            kind: 'status',
            issueNodeId: target.issueNodeId,
            projectItemId: target.projectItemId,
            fieldId: target.fieldId,
            optionId: target.currentOptionId,
          },
          after: {
            kind: 'status',
            issueNodeId: target.issueNodeId,
            projectItemId: target.projectItemId,
            fieldId: target.fieldId,
            optionId,
          },
        },
      ];
    }
    steps = steps.map((s, index) => ({ index, ...s }));
    const plan = snapshotProjectData({
      version: 1,
      repositoryId: l.repositoryId,
      projectId: l.projectId,
      inputDigest: projectDigest(input),
      authorityDigest: projectDigest({ authority, statusTarget: target }),
      steps,
    });
    planShape(plan);
    const logical = {
      version: 1,
      repositoryId: plan.repositoryId,
      projectId: plan.projectId,
      planDigest: projectDigest(plan),
      authorityDigest: plan.authorityDigest,
      stepCount: steps.length,
    };
    const binding = snapshotProjectData({ ...logical, operationId: projectDigest(logical) });
    if (retained) {
      validateProjectRecords(retained.binding, retained.records);
      check(
        equal(plan, retained.records[0].data.plan) && equal(binding, retained.binding),
        'Retained Project plan mismatch',
      );
    }
    return {
      plan: retained ? retained.records[0].data.plan : plan,
      binding: retained ? retained.binding : binding,
      target,
      preservation,
    };
  }
  function expectedLinks(input, plan, records) {
    if (input.kind !== 'scope') return null;
    const links = structuredClone(input.observedLinks.links),
      state = validateProjectRecords(records[0].data.binding, records);
    for (const s of plan.steps)
      if (state.completed.has(stepId(records[0].operationId, s))) {
        const l = links.find((l) => l.issueNodeId === s.issueNodeId);
        check(l);
        if (s.kind === 'set-milestone') l.milestoneId = s.after.milestoneId;
        else l.parentNodeId = s.after.parentNodeId;
      }
    return links;
  }
  function preserve(o, expected, previous = null) {
    if (expected) {
      check(
        equal(
          o.links.map((l) => l.issueNodeId),
          expected.map((l) => l.issueNodeId),
        ),
        'Changed preservation endpoints',
      );
      for (const l of o.links) {
        const old = expected.find((v) => v.issueNodeId === l.issueNodeId);
        for (const key of [
          'repositoryId',
          'projectId',
          'issueNodeId',
          'projectItemId',
          'milestoneId',
          'parentNodeId',
          'dependencyNodeIds',
          'prNodeIds',
        ])
          check(equal(l[key], old[key]), 'Native preservation mismatch');
      }
    }
    if (previous) {
      check(
        equal(
          previous.links.map((l) => l.issueNodeId),
          o.links.map((l) => l.issueNodeId),
        ),
        'Native preservation set changed',
      );
      check(
        previous.historyRefs.every((ref) => o.historyRefs.includes(ref)),
        'Native history lost',
      );
      for (const old of previous.links) {
        const l = o.links.find((v) => v.issueNodeId === old.issueNodeId);
        check(l, 'Native endpoint lost');
        for (const key of [
          'projectItemId',
          'dependencyNodeIds',
          'prNodeIds',
          ...(expected ? [] : ['milestoneId', 'parentNodeId']),
        ])
          check(equal(l[key], old[key]), 'Native relations lost');
      }
    }
  }
  function retainedObservations(records) {
    return records.flatMap((record) =>
      record.phase === 'intent'
        ? [record.data.before]
        : record.phase === 'verified'
          ? [record.data.observation]
          : record.phase === 'reconciliation'
            ? record.data.resolutions.map((resolution) => resolution.observation)
            : [],
    );
  }
  function checkOriginalBindings(bindings, records) {
    for (const observation of retainedObservations(records))
      for (const previous of observation.sourceBindings)
        if (bindings.has(previous.ref))
          check(
            equal(bindings.get(previous.ref), previous),
            'Retained original source binding changed',
          );
    return bindings;
  }
  function preserveRetained(observation, expected, records) {
    for (const previous of retainedObservations(records)) preserve(observation, expected, previous);
  }
  async function observe(plan, binding, s, receipt = null) {
    const id = stepId(binding.operationId, s);
    const o = projectResultValue(
      await port.observe(
        snapshotProjectData({
          version: 1,
          kind: 'step',
          repositoryId: plan.repositoryId,
          projectId: plan.projectId,
          operationId: binding.operationId,
          stepId: id,
          step: s,
          knownReceipt: receipt,
        }),
      ),
    );
    observationShape(o);
    check(
      o.repositoryId === plan.repositoryId &&
        o.projectId === plan.projectId &&
        o.operationId === binding.operationId &&
        o.stepId === id,
      'Wrong native observation',
    );
    return o;
  }
  async function authenticate(input, plan, index, records, o, baseline) {
    const current = await originals(input, baseline);
    const required = new Map(current.bindings);
    mergeBindings(required, o.sourceBindings);
    const owned = snapshotProjectData({
      ...o,
      sourceBindings: [...required.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    });
    const request = requestFor(
      'project-step',
      { plan, stepIndex: index, records, observation: owned },
      current.context,
    );
    const rows = resolutionResponse(
      await resolve(snapshotProjectData(request)),
      request,
      [...required.keys()].sort(),
    );
    for (const row of rows)
      check(equal(required.get(row.ref), row), 'Changed Project step evidence');
    return owned;
  }
  async function reauthenticateHistory(records) {
    for (const r of records)
      if (r.phase === 'reconciliation') {
        const response = projectResultValue(
          await resolveRecovery(snapshotProjectData(r.data.request)),
        );
        validateProjectRecoveryResponse(r.data.request, response);
        check(equal(response, r.data.response), 'Recovered evidence changed');
      }
  }
  async function checkedStatus(input, target, records, expectedOption) {
    const current = await statusTarget(input.lifecycle);
    for (const key of [
      'repositoryId',
      'projectId',
      'issueNodeId',
      'projectItemId',
      'fieldId',
      'fieldName',
      'options',
    ])
      check(equal(current[key], target[key]), 'Status configuration changed');
    check(current.currentOptionId === expectedOption, 'Unexpected current Status option');
    // Status-target and step revisions are independent opaque domains. Before
    // attributable progress, retain the original Status-target snapshot. After
    // verified/reconciled progress, its revision remains historical provenance;
    // current Status-query freshness is checked against this attempt's query.
    const progressed = records.some(
      (record) =>
        (record.phase === 'verified' && record.data.observation.payload.kind === 'status') ||
        (record.phase === 'reconciliation' &&
          record.data.resolutions.some(
            (resolution) => resolution.observation.payload.kind === 'status',
          )),
    );
    if (!progressed) check(equal(current, target), 'Status configuration changed');
    return current;
  }
  function checkStatusStepRevision(observation, records) {
    if (observation.payload.kind !== 'status') return;
    const previous = retainedObservations(records)
      .filter(
        (retained) =>
          retained.operationId === observation.operationId &&
          retained.stepId === observation.stepId,
      )
      .at(-1);
    if (previous)
      check(observation.revision === previous.revision, 'Unexplained Status step revision');
  }
  async function reconcile(raw, retry = 0) {
    try {
      const input = snapshotProjectData(raw),
        lifecycle = validateInput(input);
      const lookup = {
        repositoryId: lifecycle.repositoryId,
        projectId: lifecycle.projectId,
        inputDigest: projectDigest(input),
      };
      const retained = projectResultValue(
        await store.findProjectLifecycle(snapshotProjectData(lookup)),
      );
      const { plan, binding, target } = await prepare(input, retained);
      const result = await store.withProjectLifecycleLock(binding, async (lease) => {
        const found = projectResultValue(
          await store.findProjectLifecycle(snapshotProjectData(lookup)),
        );
        if (found && !equal(found.binding, binding))
          return {
            kind: 'conflict',
            reason: 'Project discovery changed; rediscover',
            evidence: [],
          };
        if (retained && !found) return uncertain('Retained Project operation disappeared');
        let records = [];
        if (found) {
          const read = projectResultValue(await store.readProjectLifecycle(binding.operationId));
          check(
            equal(read.binding, binding) && equal(read.records[0].data.plan, plan),
            'Project plan changed under lock',
          );
          records = [...read.records];
        }
        async function append(phase, id, data) {
          const record = snapshotProjectData({
            version: 1,
            operationId: binding.operationId,
            index: records.length,
            previousRecordDigest: records.length ? projectDigest(records.at(-1)) : null,
            phase,
            stepId: id,
            data,
          });
          projectResultValue(await store.appendProjectLifecycle(lease, record));
          records.push(record);
        }
        if (!records.length) await append('bound', null, { binding, plan, statusTarget: target });
        validateProjectRecords(binding, records);
        const baseline = checkOriginalBindings((await originals(input)).bindings, records),
          observations = [];
        await reauthenticateHistory(records);
        for (const s of plan.steps) {
          const state = validateProjectRecords(binding, records),
            id = stepId(binding.operationId, s);
          if (state.pending.size)
            return uncertain('Unresolved Project intent requires explicit recovery');
          if (state.completed.has(id)) {
            if (target) await checkedStatus(input, target, records, s.after.optionId);
            const o = await observe(plan, binding, s);
            if (target) checkStatusStepRevision(o, records);
            const latest = [...plan.steps]
              .reverse()
              .find(
                (v) =>
                  v.issueNodeId === s.issueNodeId &&
                  v.after.kind === s.after.kind &&
                  state.completed.has(stepId(binding.operationId, v)),
              );
            check(equal(o.payload, latest.after), 'Completed native step drift');
            preserveRetained(o, expectedLinks(input, plan, records), records);
            await authenticate(input, plan, s.index, records, o, baseline);
            observations.push(o);
            continue;
          }
          const currentStatus = target
            ? await checkedStatus(input, target, records, s.before.optionId)
            : null;
          let before = await observe(plan, binding, s);
          if (target) checkStatusStepRevision(before, records);
          const expected = expectedLinks(input, plan, records);
          if (expected && equal(before.payload, s.after)) {
            const l = expected.find((v) => v.issueNodeId === s.issueNodeId);
            if (s.kind === 'set-milestone') l.milestoneId = s.after.milestoneId;
            else l.parentNodeId = s.after.parentNodeId;
          }
          preserveRetained(before, expected, records);
          preserve(before, expected, observations.at(-1));
          before = await authenticate(input, plan, s.index, records, before, baseline);
          if (equal(before.payload, s.after)) {
            await append('verified', id, { observation: before, outcome: 'already-present' });
            observations.push(before);
            continue;
          }
          check(equal(before.payload, s.before), 'Unexpected native before state');
          const request = snapshotProjectData({
            version: 1,
            repositoryId: plan.repositoryId,
            projectId: plan.projectId,
            operationId: binding.operationId,
            stepId: id,
            step: s,
            expectedRevision: before.revision,
            expectedPayloadDigest: projectDigest(before.payload),
            authorityDigest: plan.authorityDigest,
          });
          await append('intent', id, { step: s, before, applyRequest: request });
          let final = await observe(plan, binding, s);
          if (target)
            check(
              equal(await checkedStatus(input, target, records, s.before.optionId), currentStatus),
              'Status configuration changed',
            );
          final = await authenticate(input, plan, s.index, records, final, baseline);
          check(equal(final, before), 'Native state changed after intent');
          const receipt = projectResultValue(await port.apply(snapshotProjectData(request)));
          receiptMatches(receipt, request);
          await append('receipt', id, { receipt });
          const observedAfter = await observe(plan, binding, s, receipt);
          const postBindings = new Map(baseline);
          mergeBindings(postBindings, observedAfter.sourceBindings);
          const after = snapshotProjectData({
            ...observedAfter,
            sourceBindings: [...postBindings.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
          });
          check(equal(after.payload, s.after), 'Native postcondition unknown');
          const postLinks = expected && structuredClone(expected);
          if (postLinks) {
            const l = postLinks.find((l) => l.issueNodeId === s.issueNodeId);
            if (s.kind === 'set-milestone') l.milestoneId = s.after.milestoneId;
            else l.parentNodeId = s.after.parentNodeId;
          }
          preserve(after, postLinks, before);
          check(
            after.sourceBindings.some((b) => equal(b, receipt.sourceBinding)),
            'Readback lacks attributable receipt',
          );
          await append('verified', id, { observation: after, outcome: 'applied' });
          observations.push(after);
        }
        const state = validateProjectRecords(binding, records);
        return verified(
          snapshotProjectData({
            operationId: binding.operationId,
            planDigest: binding.planDigest,
            verifiedStepIds: plan.steps
              .map((s) => stepId(binding.operationId, s))
              .filter((id) => state.completed.has(id)),
            pendingStepIds: plan.steps
              .map((s) => stepId(binding.operationId, s))
              .filter((id) => !state.completed.has(id)),
            observations,
          }),
        );
      });
      if (
        !retained &&
        retry < 1 &&
        result.kind === 'conflict' &&
        ['Project discovery changed; rediscover', 'Unfinished earlier Project operation'].includes(
          result.reason,
        )
      )
        return reconcile(input, retry + 1);
      return result;
    } catch (e) {
      return failure(e);
    }
  }
  async function recover(raw) {
    try {
      const input = snapshotProjectData(raw);
      let recoveryRecords;
      const checkedRecovery = async (request) => {
        for (const resolution of request.resolutions) {
          const intent = request.retainedRecords[resolution.intentIndex];
          const current = await observe(
            request.retainedRecords[0].data.plan,
            request.binding,
            intent.data.step,
            resolution.receipt,
          );
          const baseline = checkOriginalBindings(
            (await originals(input.originalInput)).bindings,
            request.retainedRecords,
          );
          const authenticated = await authenticate(
            input.originalInput,
            request.retainedRecords[0].data.plan,
            intent.data.step.index,
            recoveryRecords ?? request.retainedRecords,
            current,
            baseline,
          );
          check(
            equal(authenticated, resolution.observation),
            'Native recovery postcondition changed',
          );
        }
        const result = snapshotProjectData(await resolveRecovery(snapshotProjectData(request)));
        for (const resolution of request.resolutions) {
          const intent = request.retainedRecords[resolution.intentIndex];
          const current = await observe(
            request.retainedRecords[0].data.plan,
            request.binding,
            intent.data.step,
            resolution.receipt,
          );
          const baseline = checkOriginalBindings(
            (await originals(input.originalInput)).bindings,
            request.retainedRecords,
          );
          const authenticated = await authenticate(
            input.originalInput,
            request.retainedRecords[0].data.plan,
            intent.data.step.index,
            recoveryRecords ?? request.retainedRecords,
            current,
            baseline,
          );
          check(
            equal(authenticated, resolution.observation),
            'Native recovery postcondition changed',
          );
        }
        return result;
      };
      return await store.withProjectLifecycleRecovery(
        input,
        checkedRecovery,
        async (lease, snapshot) => {
          const records = [...snapshot.history.records, ...input.retainedRecords];
          recoveryRecords = records;
          const state = validateProjectRecords(snapshot.binding, records),
            plan = state.plan;
          check(plan && plan.inputDigest === projectDigest(input.originalInput));
          await reauthenticateHistory(records);
          const baseline = checkOriginalBindings(
            (await originals(input.originalInput)).bindings,
            records,
          );
          const resolutions = [];
          for (const intent of [...state.pending.values()].sort((a, b) => a.index - b.index)) {
            const s = intent.data.step,
              receipt = state.receipts.get(intent.stepId) ?? null;
            let o = await observe(plan, snapshot.binding, s, receipt);
            const outcome = equal(o.payload, s.after)
              ? 'applied'
              : equal(o.payload, s.before)
                ? 'confirmed-not-applied'
                : null;
            if (!outcome) return uncertain('Native Project recovery outcome unknown');
            const expected = expectedLinks(input.originalInput, plan, records);
            if (expected && outcome === 'applied') {
              const link = expected.find((l) => l.issueNodeId === s.issueNodeId);
              if (s.kind === 'set-milestone') link.milestoneId = s.after.milestoneId;
              else link.parentNodeId = s.after.parentNodeId;
            }
            preserve(o, expected, intent.data.before);
            o = await authenticate(input.originalInput, plan, s.index, records, o, baseline);
            // Attributed native event refs are independently resolved by recovery authority.
            const attributionRefs = o.historyRefs.filter(
              (ref) => !intent.data.before.historyRefs.includes(ref),
            );
            if (!attributionRefs.length)
              return uncertain('Missing positive native execution/nonexecution attribution');
            const r = {
              intentIndex: intent.index,
              stepId: intent.stepId,
              requestDigest: projectDigest(intent.data.applyRequest),
              outcome,
              observation: o,
              receipt,
              attributionRefs,
            };
            validateProjectResolution(intent, r);
            const again = await authenticate(
              input.originalInput,
              plan,
              s.index,
              records,
              await observe(plan, snapshot.binding, s, receipt),
              baseline,
            );
            check(equal(again, o), 'Native recovery state changed');
            await authenticate(input.originalInput, plan, s.index, records, again, baseline);
            resolutions.push(r);
          }
          return store.appendProjectLifecycleRecovery(lease, snapshotProjectData({ resolutions }));
        },
      );
    } catch (e) {
      return failure(e);
    }
  }
  return Object.freeze({ reconcile, recover });
}
