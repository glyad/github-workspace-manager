import { canonicalJson, resourceKey } from './identity.js';
import { decodeRecord } from './records.js';
import type {
  FieldIntent,
  FieldPath,
  Id,
  Issue,
  Json,
  Resource,
  Result,
  Source,
} from './records.js';

export type Configuration = {
  formatVersion: 1;
  resource: Resource;
  fields: Record<FieldPath, FieldIntent>;
  components: string[];
  source: Source;
};
export type Resolved = {
  resource: Resource;
  fields: Record<FieldPath, { intent: FieldIntent; source: Source; constraints: Json[] }>;
  sources: Source[];
  issues: Issue[];
};
export const configurationLimits = { bytes: 262144, nodes: 10000, depth: 32 } as const;
const forbidden = new Set(['__proto__', 'constructor', 'prototype', '<<']);
const executionFields = new Set([
  'execution',
  'destination',
  'stateDirectory',
  'retention',
  'auditMaxBytes',
]);
export function configurationFailure<T>(code: string): Result<T> {
  return { ok: false, issues: [{ code, message: code, blocking: true }] };
}
export function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !/[\u0000-\u001f\u007f]/.test(value);
export function validFieldPath(value: string): boolean {
  const segments = value.split('.');
  return (
    value.length <= 256 &&
    segments.every(
      (segment) =>
        /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(segment) &&
        !forbidden.has(segment) &&
        !executionFields.has(segment),
    )
  );
}
/** Portable JSON validation with a resource budget before recursive canonical encoding. */
export function boundedJson(value: unknown): Json {
  let count = 0;
  const seen = new Set<object>();
  function check(input: unknown, depth: number): void {
    if (++count > configurationLimits.nodes || depth > configurationLimits.depth)
      throw new Error('CONFIGURATION_LIMIT');
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean' ||
      (typeof input === 'number' && Number.isFinite(input))
    )
      return;
    if (typeof input !== 'object' || seen.has(input) || (!Array.isArray(input) && !object(input)))
      throw new Error('INVALID_CONFIGURATION');
    seen.add(input);
    if (Object.getOwnPropertySymbols(input).length) throw new Error('INVALID_CONFIGURATION');
    for (const key of Object.keys(input)) {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (forbidden.has(key) || !property || !('value' in property))
        throw new Error('INVALID_CONFIGURATION');
      check(property.value, depth + 1);
    }
    seen.delete(input);
  }
  check(value, 0);
  return JSON.parse(canonicalJson(value)) as Json;
}
/** Metadata is supplied by a trusted source adapter, never by document content. */
export function decodeConfigurationSource(value: unknown): Result<Source> {
  try {
    const copy = boundedJson(value);
    if (
      !object(copy) ||
      !keys(
        copy,
        ['id', 'kind', 'location', 'ref', 'revision', 'authority', 'trust'],
        ['resource'],
      ) ||
      !['id', 'location', 'ref', 'revision'].every((key) => nonempty(copy[key])) ||
      typeof copy.kind !== 'string' ||
      !['repository', 'central', 'local'].includes(copy.kind) ||
      typeof copy.authority !== 'string' ||
      !['remote-ref', 'local-commit'].includes(copy.authority) ||
      typeof copy.trust !== 'string' ||
      !['repository', 'organization-enforced', 'organization-advisory', 'profile'].includes(
        copy.trust,
      )
    )
      return configurationFailure('INVALID_SOURCE');
    const location = String(copy.location);
    if (
      location.includes('\\') ||
      location.split('/').some((part) => !part || part === '.' || part === '..') ||
      /^[a-zA-Z]:/.test(location)
    )
      return configurationFailure('INVALID_SOURCE');
    if (
      copy.trust.startsWith('organization-') &&
      (copy.kind !== 'central' || copy.authority !== 'remote-ref')
    )
      return configurationFailure('UNTRUSTED_POLICY');
    if (copy.kind === 'local' ? copy.authority !== 'local-commit' : copy.authority !== 'remote-ref')
      return configurationFailure('INVALID_SOURCE');
    if (copy.resource !== undefined) decodeRecord('resource', copy.resource);
    else if (copy.kind !== 'local') return configurationFailure('INVALID_SOURCE');
    return { ok: true, value: copy as Source };
  } catch {
    return configurationFailure('INVALID_SOURCE');
  }
}
/** JSON schema boundary; YAML parsing remains in the format adapter. */
export function decodeConfiguration(value: unknown, source: Source): Result<Configuration> {
  const provenance = decodeConfigurationSource(source);
  if (!provenance.ok) return provenance;
  try {
    const copy = boundedJson(value);
    if (object(copy) && ['source', 'trust', 'authority'].some((key) => Object.hasOwn(copy, key)))
      return configurationFailure('UNTRUSTED_POLICY');
    if (
      !object(copy) ||
      !keys(copy, ['formatVersion', 'resource', 'fields', 'components']) ||
      copy.formatVersion !== 1 ||
      !object(copy.fields) ||
      !Array.isArray(copy.components) ||
      !copy.components.every(
        (component) =>
          nonempty(component) && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(component),
      ) ||
      new Set(copy.components).size !== copy.components.length
    )
      return configurationFailure('INVALID_CONFIGURATION');
    const resource = decodeRecord('resource', copy.resource);
    const fields: Record<FieldPath, FieldIntent> = {};
    for (const [path, intent] of Object.entries(copy.fields)) {
      if (
        !validFieldPath(path) ||
        !object(intent) ||
        typeof intent.kind !== 'string' ||
        !['value', 'reset', 'unmanaged'].includes(intent.kind) ||
        !keys(intent, intent.kind === 'value' ? ['kind', 'value'] : ['kind'])
      )
        return configurationFailure('INVALID_CONFIGURATION');
      fields[path] = intent as FieldIntent;
    }
    return {
      ok: true,
      value: {
        formatVersion: 1,
        resource,
        fields,
        components: copy.components as string[],
        source: provenance.value,
      },
    };
  } catch {
    return configurationFailure('INVALID_CONFIGURATION');
  }
}
export function encodeConfiguration(configuration: Configuration): Json {
  const { source, ...document } = configuration;
  const decoded = decodeConfiguration(document, source);
  if (!decoded.ok) throw new Error('INVALID_CONFIGURATION');
  return boundedJson(decoded.value);
}
export function sameResource(left: Resource, right: Resource): boolean {
  return (
    resourceKey(left) === resourceKey(right) &&
    (!left.remoteId || !right.remoteId || left.remoteId === right.remoteId)
  );
}
export type TrustedPolicySourceIds = readonly Id[];
