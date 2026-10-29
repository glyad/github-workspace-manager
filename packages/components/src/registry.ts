import { boundedJson, decodeConfiguration, object } from '../../domain/src/configuration.js';
import type { Configuration } from '../../domain/src/configuration.js';
import type { Component } from '../../domain/src/components.js';
import type { FieldIntent, Issue, Json } from '../../domain/src/records.js';
import { componentSchemas, fieldSchemas, matchesSchema } from './schemas.js';

const definitions = [
  {
    id: 'repository.basic',
    prerequisites: ['selected-owner-and-repository-identity'],
    permissions: ['repository:create-or-admin'],
    actions: ['repository.create', 'repository.settings.update'],
    costTriggers: [
      'private/internal visibility may require entitlement; repository creation consumes account limits',
    ],
    reversalLimits: [
      'Restore captured settings with fresh approval; repository creation is not automatically undone.',
    ],
  },
  {
    id: 'repository.local',
    prerequisites: ['repository-identity-or-local-initialization'],
    permissions: ['local:git', 'local:workspace-write'],
    actions: ['git.initialize', 'git.clone'],
    costTriggers: ['Local storage and clone transfer usage must be preflighted.'],
    reversalLimits: [
      'Local history or work may have changed; do not remove directories or discard unrelated work.',
    ],
  },
  ...['readme', 'license', 'gitignore', 'issue-templates', 'pr-template'].map((name) => ({
    id: `repository.${name}`,
    prerequisites: ['repository-existing-or-planned', 'compliant-git-delivery'],
    permissions: ['repository:contents-write', 'local:git'],
    actions: ['files.deliver'],
    costTriggers: [
      'Delivered commits/pushes can trigger existing Actions, integrations and storage usage.',
    ],
    reversalLimits: [
      'Restore captured file bytes through a compliant revert commit; preserve intervening changes and shared history.',
    ],
  })),
  {
    id: 'repository.rulesets',
    prerequisites: [
      'repository-existing-or-planned',
      'workflow-desired-rules',
      'provider-ruleset-capability',
    ],
    permissions: ['repository:administration-write'],
    actions: ['repository.rulesets.reconcile'],
    costTriggers: [
      'Ruleset features depend on visibility, account plan and supported entitlements.',
    ],
    reversalLimits: [
      'Restore only captured managed enforcement mappings; unavailable provider capability or changed protection may block reversal.',
    ],
  },
  {
    id: 'repository.workflow',
    prerequisites: ['existing-workflow-discovery'],
    permissions: ['repository:read', 'local:git'],
    actions: ['workflow.resolve', 'workflow.validate-delivery'],
    costTriggers: [
      'Chosen delivery can trigger checks/integrations; remote enforcement may require entitlement.',
    ],
    reversalLimits: [
      'Changing desired conventions cannot rewrite already delivered history or revoke external effects; migration needs explicit approval.',
    ],
  },
];
/** Fresh copies protect trusted registry data from caller mutations. */
export function bundledComponents(): readonly Component[] {
  return definitions.map((definition) => {
    const schema = boundedJson(componentSchemas[definition.id]);
    const ownedFields = Object.keys(fieldSchemas(schema));
    return {
      ...definition,
      schema,
      ownedFields,
      backupFields: [...ownedFields],
      prerequisites: [...definition.prerequisites],
      permissions: [...definition.permissions],
      actions: [...definition.actions],
      costTriggers: [...definition.costTriggers],
      reversalLimits: [...definition.reversalLimits],
    };
  });
}
export function componentIssue(code: string, path?: string): Issue {
  return { code, ...(path ? { path } : {}), message: code, blocking: true };
}
/** Validates mutations only. Omissions and unmanaged fields never acquire an owner. */
export function validateManagedFields(
  fields: Record<string, FieldIntent>,
  selected?: readonly string[],
): Issue[] {
  const issues: Issue[] = [];
  const registry = bundledComponents();
  const owners = new Map(registry.flatMap((c) => c.ownedFields.map((path) => [path, c] as const)));
  for (const [path, intent] of Object.entries(fields)) {
    if (intent.kind === 'unmanaged') continue;
    const owner = owners.get(path);
    if (!owner) {
      issues.push(componentIssue('UNKNOWN_COMPONENT_FIELD', path));
      continue;
    }
    if (selected && !selected.includes(owner.id))
      issues.push(componentIssue('COMPONENT_NOT_SELECTED', path));
    if (intent.kind === 'value' && !matchesSchema(intent.value, fieldSchemas(owner.schema)[path]!))
      issues.push(componentIssue('INVALID_COMPONENT_VALUE', path));
    if (intent.kind === 'reset' && path === 'issueTemplates.files')
      issues.push(componentIssue('EXPLICIT_PATHS_REQUIRED', path));
  }
  for (const pair of [
    ['license.selection', 'license.content'],
    ['gitignore.templates', 'gitignore.content'],
  ]) {
    if (pair.every((path) => fields[path] && fields[path]?.kind !== 'unmanaged'))
      issues.push(componentIssue('CONFLICTING_ASSET_RECIPES', pair[0]));
  }
  return issues;
}
export function validateComponents(config: Configuration): Issue[] {
  try {
    // Reuse Task 2's hostile-input and intent boundary instead of trusting TS types.
    const copy = boundedJson(config);
    if (!object(copy)) return [componentIssue('INVALID_CONFIGURATION')];
    const { source, ...document } = copy;
    const decoded = decodeConfiguration(document, source as Configuration['source']);
    if (!decoded.ok) return decoded.issues;
    const registry = bundledComponents();
    const unknown = decoded.value.components
      .filter((id) => !registry.some((c) => c.id === id))
      .map((id) => componentIssue('UNKNOWN_COMPONENT', id));
    return [...unknown, ...validateManagedFields(decoded.value.fields, decoded.value.components)];
  } catch {
    return [componentIssue('INVALID_CONFIGURATION')];
  }
}
