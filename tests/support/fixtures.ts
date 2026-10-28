import { canonicalDigest } from '../../packages/domain/src/identity.js';
import { encodeRecord } from '../../packages/domain/src/records.js';
import type {
  Resource,
  Actor,
  Observation,
  Operation,
  Plan,
  Snapshot,
  Event,
  Run,
  Delivery,
} from '../../packages/domain/src/records.js';

const at = '2026-10-19T00:00:00.000Z';
/** Explicit test choices, never product retention/identity defaults. */
export function freezeFixturePlan(plan: Plan): Plan {
  const { fingerprint: _prior, ...semantic } = plan;
  const encoded = encodeRecord('plan', { ...semantic, fingerprint: 'pending' });
  if (!encoded || typeof encoded !== 'object' || Array.isArray(encoded))
    throw new Error('INVALID_FIXTURE_PLAN');
  const { fingerprint: _placeholder, ...inputs } = encoded;
  return { ...structuredClone(plan), fingerprint: canonicalDigest(inputs) };
}
export interface Fixtures {
  resource(overrides?: Partial<Resource>): Resource;
  actor(overrides?: Partial<Actor>): Actor;
  observation(overrides?: Partial<Observation>): Observation;
  operation(overrides?: Partial<Operation>): Operation;
  plan(overrides?: Partial<Plan>): Plan;
  snapshot(overrides?: Partial<Snapshot>): Snapshot;
  event(overrides?: Partial<Event>): Event;
  run(overrides?: Partial<Run>): Run;
  delivery(overrides?: Partial<Delivery>): Delivery;
}
export function createFixtures(): Fixtures {
  const resource = (overrides: Partial<Resource> = {}): Resource => ({
    host: 'github.com',
    owner: 'example',
    name: 'repo',
    ...overrides,
  });
  const actor = (overrides: Partial<Actor> = {}): Actor => ({
    host: 'github.com',
    principalId: 'actor-1',
    login: 'example',
    ...overrides,
  });
  const observation = (overrides: Partial<Observation> = {}): Observation => ({
    resource: resource(),
    actor: actor(),
    exists: true,
    fields: {},
    refs: {},
    permissions: [],
    enforcement: {},
    coverage: { captured: [], omitted: [] },
    concurrency: {},
    observedAt: at,
    ...overrides,
  });
  const operation = (overrides: Partial<Operation> = {}): Operation => ({
    id: 'operation-1',
    action: 'repository.inspect',
    resource: resource(),
    providerId: 'fake',
    actor: actor(),
    parameters: {},
    artifacts: [],
    dependsOn: [],
    preconditions: [],
    postcondition: {},
    backupFields: [],
    reversal: { kind: 'reversible', method: 'none', limitations: [] },
    costIds: [],
    consents: [],
    ...overrides,
  });
  const plan = (overrides: Partial<Plan> = {}): Plan =>
    freezeFixturePlan({
      formatVersion: 1,
      fingerprint: 'pending',
      draftId: 'draft-1',
      draftRevision: 1,
      sources: [],
      resolved: {},
      execution: {
        formatVersion: 1,
        destination: '/fixture/Work/Repo',
        delivery: 'local-commit',
        stateDirectory: '/fixture/state',
        retention: { maxAgeDays: 7, maxBytes: 1024 },
        auditMaxBytes: 1024,
      },
      operations: [operation()],
      costs: [],
      disclosures: {},
      issues: [],
      ...overrides,
    });
  const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
    formatVersion: 1,
    id: 'snapshot-1',
    plan: plan().fingerprint,
    operationId: 'operation-1',
    before: observation(),
    coverage: { captured: [], omitted: [] },
    artifacts: [],
    pinnedBy: [],
    availability: 'available',
    ...overrides,
  });
  const event = (overrides: Partial<Event> = {}): Event => ({
    formatVersion: 1,
    id: 'event-1',
    sequence: 1,
    at,
    category: 'inspection',
    status: 'prepared',
    summary: {},
    refs: [],
    ...overrides,
  });
  const run = (overrides: Partial<Run> = {}): Run => ({
    formatVersion: 1,
    id: 'run-1',
    plan: plan().fingerprint,
    state: 'ready',
    checkpoints: [
      { operationId: 'operation-1', state: 'pending', attemptId: 'attempt-1', snapshotIds: [] },
    ],
    cancelled: false,
    ...overrides,
  });
  const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
    formatVersion: 1,
    id: 'delivery-1',
    plan: plan().fingerprint,
    operationId: 'operation-1',
    contentDigest: canonicalDigest('fixture bytes'),
    base: 'revision-1',
    target: 'develop',
    workingBranch: 'feature/fixture',
    goal: 'local-commit',
    stage: 'approved',
    ...overrides,
  });
  return { resource, actor, observation, operation, plan, snapshot, event, run, delivery };
}
