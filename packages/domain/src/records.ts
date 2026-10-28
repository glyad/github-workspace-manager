export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Id = string;
export type Digest = string;
export type Revision = string;
export type FieldPath = string;
export type FieldIntent =
  { kind: 'unmanaged' } | { kind: 'value'; value: Json } | { kind: 'reset' };
export type Resource = { host: string; owner: string; name: string; remoteId?: Id };
export type Actor = { host: string; principalId: Id; login: string };
export type Source = {
  id: Id;
  kind: 'repository' | 'central' | 'local';
  resource?: Resource;
  location: string;
  ref: string;
  revision: Revision;
  authority: 'remote-ref' | 'local-commit';
  trust: 'repository' | 'organization-enforced' | 'organization-advisory' | 'profile';
};
export type Issue = { code: string; path?: FieldPath; message: string; blocking: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };
export type Artifact = { digest: Digest; size: number; mediaType: string };
export type Coverage = { captured: FieldPath[]; omitted: { path: FieldPath; reason: string }[] };
export type Observation = {
  resource: Resource;
  actor: Actor;
  exists: boolean;
  fields: Record<FieldPath, Json>;
  refs: Record<string, Revision>;
  permissions: string[];
  enforcement: Json;
  coverage: Coverage;
  concurrency: Json;
  observedAt: string;
};
export type Evidence = {
  resource: Resource;
  actor: Actor;
  requestId?: string;
  commit?: Revision;
  branch?: string;
  prId?: Id;
  head?: Revision;
  observed: Json;
  artifactRefs: Artifact[];
};
export type ProviderResult<T> =
  | { kind: 'success'; value: T }
  | {
      kind: 'unsupported' | 'denied' | 'conflict' | 'rate-limited' | 'unavailable' | 'uncertain';
      dispatched: 'no' | 'yes' | 'unknown';
      retryAfterMs?: number;
      issues: Issue[];
    };
export type Capability = {
  providerId: Id;
  family: 'official-mcp' | 'native' | 'octokit' | 'guided';
  actor: Actor;
  actions: string[];
  guarantees: string[];
  limitations: string[];
  observedAt: string;
};
export type Precondition = {
  resource: Resource;
  paths: FieldPath[];
  expected: Json;
  afterOperations: Id[];
  conditionalToken?: string;
};
export type Cost = {
  id: Id;
  classification:
    'no-additional-charge-established' | 'existing-usage' | 'additional-entitlement' | 'unresolved';
  billingOwner: string;
  action: string;
  source: string;
  observedAt: string;
  basis: string;
  limits?: string;
  uncertainty: string;
  bounded: boolean;
};
export type ConsentCategory = 'plan' | 'sensitive' | 'financial' | 'irreversible';
export type DeliveryStage = 'local-commit' | 'branch-push' | 'pull-request' | 'merged';
export type ExecutionConfig = {
  formatVersion: 1;
  destination: string;
  delivery: DeliveryStage;
  stateDirectory: string;
  retention: { maxAgeDays: number; maxBytes: number };
  auditMaxBytes: number;
};
export type Operation = {
  id: Id;
  action: string;
  resource: Resource;
  providerId: Id;
  actor: Actor;
  parameters: Json;
  artifacts: Artifact[];
  dependsOn: Id[];
  preconditions: Precondition[];
  postcondition: Json;
  deliveryStage?: DeliveryStage;
  backupFields: FieldPath[];
  reversal: {
    kind: 'reversible' | 'partial' | 'irreversible';
    method: string;
    limitations: string[];
  };
  costIds: Id[];
  consents: ConsentCategory[];
};
export type Plan = {
  formatVersion: 1;
  fingerprint: Digest;
  draftId: Id;
  draftRevision: number;
  sources: Source[];
  resolved: Json;
  execution: ExecutionConfig;
  operations: Operation[];
  costs: Cost[];
  disclosures: Json;
  issues: Issue[];
};
export type Decision = {
  plan: Digest;
  category: ConsentCategory;
  operationIds: Id[];
  disclosureDigest: Digest;
  actor: string;
  channel: string;
  decidedAt: string;
};
export type Authorization = Decision & { receiptId: Id };
export type Snapshot = {
  formatVersion: 1;
  id: Id;
  plan: Digest;
  operationId: Id;
  before: Observation;
  coverage: Coverage;
  artifacts: Artifact[];
  expiresAt?: string;
  pinnedBy: Id[];
  after?: Evidence;
  availability: 'available' | 'expired' | 'missing';
};
export type Event = {
  formatVersion: 1;
  id: Id;
  sequence: number;
  at: string;
  category: string;
  status: string;
  plan?: Digest;
  runId?: Id;
  operationId?: Id;
  resource?: Resource;
  actor?: Actor;
  providerId?: Id;
  summary: Json;
  refs: Id[];
};
export type Checkpoint = {
  operationId: Id;
  state:
    | 'pending'
    | 'prepared'
    | 'dispatched'
    | 'verified'
    | 'no-op'
    | 'uncertain'
    | 'blocked'
    | 'failed';
  attemptId: Id;
  snapshotIds: Id[];
  evidence?: Evidence;
  lastEventId?: Id;
};
export type Run = {
  formatVersion: 1;
  id: Id;
  plan: Digest;
  state:
    | 'ready'
    | 'running'
    | 'verifying'
    | 'completed'
    | 'blocked'
    | 'failed'
    | 'cancelled'
    | 'pending';
  checkpoints: Checkpoint[];
  cancelled: boolean;
};
export type Delivery = {
  formatVersion: 1;
  id: Id;
  plan: Digest;
  operationId: Id;
  contentDigest: Digest;
  base: Revision;
  target: string;
  workingBranch: string;
  goal: DeliveryStage;
  stage:
    | 'approved'
    | 'written'
    | 'committed'
    | 'pushed'
    | 'pr-open'
    | 'awaiting-checks-reviews'
    | 'merged';
  evidence?: Evidence;
};

import { canonicalJson, resourceKey } from './identity.js';
type Schema = (value: unknown) => boolean;
const string: Schema = (value) => typeof value === 'string' && value.length > 0;
const boolean: Schema = (value) => typeof value === 'boolean';
const integer: Schema = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive: Schema = (value) => integer(value) && Number(value) > 0;
const json: Schema = (value) => {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
};
const literal =
  (...values: (string | number)[]): Schema =>
  (value) =>
    values.some((candidate) => candidate === value);
const list =
  (schema: Schema): Schema =>
  (value) =>
    Array.isArray(value) && value.every(schema);
const dictionary =
  (schema: Schema): Schema =>
  (value) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(schema);
const shape =
  (required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema =>
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
    return (
      Object.entries(required).every(
        ([key, schema]) => Object.hasOwn(fields, key) && schema(fields[key]),
      ) &&
      Object.entries(fields).every(
        ([key, field]) => (required[key] ?? optional[key])?.(field) === true,
      )
    );
  };
const resource: Schema = (value) => {
  if (!shape({ host: string, owner: string, name: string }, { remoteId: string })(value))
    return false;
  try {
    resourceKey(value as Resource);
    return true;
  } catch {
    return false;
  }
};
const actor = shape({ host: string, principalId: string, login: string });
const issue = shape({ code: string, message: string, blocking: boolean }, { path: string });
const artifact = shape({ digest: string, size: integer, mediaType: string });
const coverage = shape({
  captured: list(string),
  omitted: list(shape({ path: string, reason: string })),
});
const source = shape(
  {
    id: string,
    kind: literal('repository', 'central', 'local'),
    location: string,
    ref: string,
    revision: string,
    authority: literal('remote-ref', 'local-commit'),
    trust: literal('repository', 'organization-enforced', 'organization-advisory', 'profile'),
  },
  { resource },
);
const observation = shape({
  resource,
  actor,
  exists: boolean,
  fields: dictionary(json),
  refs: dictionary(string),
  permissions: list(string),
  enforcement: json,
  coverage,
  concurrency: json,
  observedAt: string,
});
const evidence = shape(
  { resource, actor, observed: json, artifactRefs: list(artifact) },
  { requestId: string, commit: string, branch: string, prId: string, head: string },
);
const precondition = shape(
  { resource, paths: list(string), expected: json, afterOperations: list(string) },
  { conditionalToken: string },
);
const cost = shape(
  {
    id: string,
    classification: literal(
      'no-additional-charge-established',
      'existing-usage',
      'additional-entitlement',
      'unresolved',
    ),
    billingOwner: string,
    action: string,
    source: string,
    observedAt: string,
    basis: string,
    uncertainty: (value) => typeof value === 'string',
    bounded: boolean,
  },
  { limits: string },
);
const deliveryStage = literal('local-commit', 'branch-push', 'pull-request', 'merged');
const consentCategory = literal('plan', 'sensitive', 'financial', 'irreversible');
const execution = shape({
  formatVersion: literal(1),
  destination: string,
  delivery: deliveryStage,
  stateDirectory: string,
  retention: shape({ maxAgeDays: positive, maxBytes: positive }),
  auditMaxBytes: positive,
});
const operation = shape(
  {
    id: string,
    action: string,
    resource,
    providerId: string,
    actor,
    parameters: json,
    artifacts: list(artifact),
    dependsOn: list(string),
    preconditions: list(precondition),
    postcondition: json,
    backupFields: list(string),
    reversal: shape({
      kind: literal('reversible', 'partial', 'irreversible'),
      method: string,
      limitations: list(string),
    }),
    costIds: list(string),
    consents: list(consentCategory),
  },
  { deliveryStage },
);
const checkpoint = shape(
  {
    operationId: string,
    state: literal(
      'pending',
      'prepared',
      'dispatched',
      'verified',
      'no-op',
      'uncertain',
      'blocked',
      'failed',
    ),
    attemptId: string,
    snapshotIds: list(string),
  },
  { evidence, lastEventId: string },
);
const schemas = {
  resource,
  actor,
  observation,
  operation,
  execution,
  plan: shape({
    formatVersion: literal(1),
    fingerprint: string,
    draftId: string,
    draftRevision: integer,
    sources: list(source),
    resolved: json,
    execution,
    operations: list(operation),
    costs: list(cost),
    disclosures: json,
    issues: list(issue),
  }),
  snapshot: shape(
    {
      formatVersion: literal(1),
      id: string,
      plan: string,
      operationId: string,
      before: observation,
      coverage,
      artifacts: list(artifact),
      pinnedBy: list(string),
      availability: literal('available', 'expired', 'missing'),
    },
    { expiresAt: string, after: evidence },
  ),
  event: shape(
    {
      formatVersion: literal(1),
      id: string,
      sequence: integer,
      at: string,
      category: string,
      status: string,
      summary: json,
      refs: list(string),
    },
    { plan: string, runId: string, operationId: string, resource, actor, providerId: string },
  ),
  run: shape({
    formatVersion: literal(1),
    id: string,
    plan: string,
    state: literal(
      'ready',
      'running',
      'verifying',
      'completed',
      'blocked',
      'failed',
      'cancelled',
      'pending',
    ),
    checkpoints: list(checkpoint),
    cancelled: boolean,
  }),
  delivery: shape(
    {
      formatVersion: literal(1),
      id: string,
      plan: string,
      operationId: string,
      contentDigest: string,
      base: string,
      target: string,
      workingBranch: string,
      goal: deliveryStage,
      stage: literal(
        'approved',
        'written',
        'committed',
        'pushed',
        'pr-open',
        'awaiting-checks-reviews',
        'merged',
      ),
    },
    { evidence },
  ),
};
export type RecordTypes = {
  resource: Resource;
  actor: Actor;
  observation: Observation;
  operation: Operation;
  execution: ExecutionConfig;
  plan: Plan;
  snapshot: Snapshot;
  event: Event;
  run: Run;
  delivery: Delivery;
};
export type RecordKind = keyof RecordTypes;
/** Validate untrusted data, reject unknown fields, and return an independent JSON copy. */
export function decodeRecord<K extends RecordKind>(kind: K, value: unknown): RecordTypes[K] {
  const encoded = canonicalJson(value);
  if (!schemas[kind](value)) throw new Error('INVALID_RECORD:' + kind);
  // This conversion follows complete runtime validation, never a record-to-Json cast.
  return JSON.parse(encoded) as RecordTypes[K];
}
export function encodeRecord<K extends RecordKind>(kind: K, value: RecordTypes[K]): Json {
  return JSON.parse(canonicalJson(decodeRecord(kind, value))) as Json;
}
