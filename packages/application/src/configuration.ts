import {
  boundedJson,
  configurationFailure,
  decodeConfiguration,
  object,
  sameResource,
  validFieldPath,
} from '../../domain/src/configuration.js';
import type { Configuration, Resolved } from '../../domain/src/configuration.js';
import { canonicalJson } from '../../domain/src/identity.js';
import type { FieldIntent, FieldPath, Id, Json, Result } from '../../domain/src/records.js';
const rank = {
  profile: 0,
  'organization-advisory': 1,
  repository: 2,
  'organization-enforced': 3,
} as const;
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const matches = (intent: FieldIntent, constraint: Json) =>
  intent.kind === 'value' && equal(intent.value, constraint);
/** Exact-value restrictions are constraints, never a grant of management or consent. */
export function resolveConfiguration(
  layers: readonly Configuration[],
  githubRestrictions: Record<FieldPath, Json>,
  trustedPolicySourceIds: readonly Id[],
): Result<Resolved> {
  try {
    if (
      !Array.isArray(layers) ||
      !layers.length ||
      !Array.isArray(trustedPolicySourceIds) ||
      !trustedPolicySourceIds.every((id) => typeof id === 'string' && id.length > 0)
    )
      return configurationFailure('INVALID_CONFIGURATION');
    const restrictions = boundedJson(githubRestrictions);
    if (!object(restrictions) || !Object.keys(restrictions).every(validFieldPath))
      return configurationFailure('INVALID_CONFIGURATION');
    const checked: Configuration[] = [];
    for (const layer of layers) {
      const { source, ...document } = layer;
      const result = decodeConfiguration(document, source);
      if (!result.ok) return result;
      if (
        result.value.source.trust === 'organization-enforced' &&
        !trustedPolicySourceIds.includes(result.value.source.id)
      )
        return configurationFailure('UNTRUSTED_POLICY');
      checked.push(result.value);
    }
    checked.sort((a, b) => (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0));
    const first = checked[0]!;
    const remoteIds = new Set(
      checked.flatMap((layer) =>
        layer.resource.remoteId === undefined ? [] : [layer.resource.remoteId],
      ),
    );
    if (
      new Set(checked.map((layer) => layer.source.id)).size !== checked.length ||
      remoteIds.size > 1 ||
      checked.some((layer) => !sameResource(first.resource, layer.resource))
    )
      return configurationFailure('INVALID_CONFIGURATION');
    const remoteId = [...remoteIds][0];
    const resource = remoteId === undefined ? first.resource : { ...first.resource, remoteId };
    const fields: Resolved['fields'] = {};
    const paths = [...new Set(checked.flatMap((layer) => Object.keys(layer.fields)))].sort();
    for (const path of paths) {
      const candidates = checked.filter((layer) => Object.hasOwn(layer.fields, path));
      const enforced = candidates.filter(
        (layer) =>
          layer.source.trust === 'organization-enforced' &&
          layer.fields[path]!.kind !== 'unmanaged',
      );
      const explicit = candidates.filter(
        (layer) => layer.source.trust === 'repository' && layer.fields[path]!.kind !== 'unmanaged',
      );
      const constraints: Json[] = [];
      if (Object.hasOwn(restrictions, path)) constraints.push(restrictions[path]!);
      for (const layer of enforced) {
        const intent = layer.fields[path]!;
        constraints.push(intent.kind === 'value' ? intent.value : { kind: 'reset' });
      }
      if (
        enforced.some((layer) => !equal(layer.fields[path], enforced[0]!.fields[path])) ||
        explicit.some((layer) =>
          enforced.some((policy) => !equal(layer.fields[path], policy.fields[path])),
        )
      )
        return configurationFailure('POLICY_CONFLICT');
      const ordered = candidates
        .filter(
          (layer) =>
            layer.source.trust !== 'organization-enforced' ||
            layer.fields[path]!.kind !== 'unmanaged',
        )
        .sort((a, b) => rank[b.source.trust] - rank[a.source.trust]);
      const winner = ordered[0];
      if (!winner) continue;
      const intent = winner.fields[path]!;
      if (
        ordered.some(
          (layer) =>
            rank[layer.source.trust] === rank[winner.source.trust] &&
            !equal(layer.fields[path], intent),
        )
      )
        return configurationFailure('CONFIGURATION_CONFLICT');
      if (
        intent.kind !== 'unmanaged' &&
        Object.hasOwn(restrictions, path) &&
        !matches(intent, restrictions[path]!)
      )
        return configurationFailure('POLICY_CONFLICT');
      fields[path] = { intent, source: winner.source, constraints };
    }
    return {
      ok: true,
      value: {
        resource,
        fields,
        sources: checked.map((layer) => layer.source),
        issues: [],
      },
    };
  } catch {
    return configurationFailure('INVALID_CONFIGURATION');
  }
}
