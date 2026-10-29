import { canonicalJson } from '../../domain/src/identity.js';
import { object } from '../../domain/src/configuration.js';
import type { Json } from '../../domain/src/records.js';

const text: Json = { type: 'string', maxLength: 262144 };
const label: Json = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\u0000-\\u001f\\u007f]+$',
};
const boolean: Json = { type: 'boolean' };
const count: Json = { type: 'integer', minimum: 0 };
const strings: Json = { type: 'array', uniqueItems: true, items: label };
const enumeration = (...values: string[]): Json => ({ type: 'string', enum: values });
const array = (items: Json): Json => ({ type: 'array', uniqueItems: true, items });
const record = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const textInputSchema: Json = {
  oneOf: [text, record({ suppliedText: label }, ['suppliedText'])],
};
export const componentSchemas: Record<string, Json> = {
  'repository.basic': record({
    'basic.name': { type: 'string', pattern: '^(?!\\.{1,2}$)[a-zA-Z0-9_.-]{1,100}$' },
    'basic.description': { type: 'string', maxLength: 350 },
    'basic.visibility': enumeration('public', 'private', 'internal'),
  }),
  'repository.local': record({ 'local.clone': boolean, 'local.initialize': boolean }),
  'repository.readme': record({ 'readme.content': textInputSchema }),
  'repository.license': record({
    'license.selection': record(
      { id: enumeration('MIT'), year: { type: 'string', pattern: '^[0-9]{4}$' }, holder: label },
      ['id', 'year', 'holder'],
    ),
    'license.content': textInputSchema,
  }),
  'repository.gitignore': record({
    'gitignore.templates': array(enumeration('Node')),
    'gitignore.content': textInputSchema,
  }),
  'repository.issue-templates': record({
    'issueTemplates.files': {
      type: 'array',
      maxItems: 100,
      items: {
        oneOf: [
          record(
            {
              path: label,
              content: textInputSchema,
              beforeDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
            ['path', 'content'],
          ),
          record(
            {
              path: label,
              delete: { const: true },
              beforeDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
            ['path', 'delete'],
          ),
        ],
      },
    },
  }),
  'repository.pr-template': record({ 'prTemplate.content': textInputSchema }),
  // Desired behavior belongs exclusively to workflow. These booleans request mappings
  // of those choices to provider enforcement; they do not override the choices.
  'repository.rulesets': record({
    'rulesets.targets': strings,
    'rulesets.enforcement': record({
      requiredApprovals: boolean,
      requiredChecks: boolean,
      signingRequired: boolean,
      mergeMethods: boolean,
    }),
  }),
  // Task 4 resolves cross-field compatibility, existing rules and explicit migration.
  'repository.workflow': record({
    'workflow.standard': enumeration('conventional', 'custom'),
    'workflow.strategy': enumeration('git-flow', 'github-flow', 'trunk', 'custom'),
    'workflow.primary': label,
    'workflow.development': label,
    'workflow.prefixes': record({ feature: label, release: label, hotfix: label }, ['feature']),
    'workflow.types': strings,
    'workflow.scopes': strings,
    'workflow.customMessage': record({ prefix: label, minLength: count, maxLength: count }, [
      'prefix',
      'minLength',
      'maxLength',
    ]),
    'workflow.customRoutes': {
      type: 'object',
      additionalProperties: record({ base: label, target: label, prefix: label }, [
        'base',
        'target',
        'prefix',
      ]),
    },
    'workflow.mergeMethods': {
      ...objectSchema(array(enumeration('merge', 'squash', 'rebase'))),
      minItems: 1,
    },
    'workflow.prTitle': enumeration('commit-message', 'custom'),
    'workflow.customPrTitle': record({ prefix: label, maxLength: count }, ['prefix', 'maxLength']),
    'workflow.requiredApprovals': count,
    'workflow.requiredChecks': strings,
    'workflow.deleteBranchAfterMerge': boolean,
    'workflow.signingRequired': boolean,
    'workflow.signOffRequired': boolean,
  }),
};
function objectSchema(value: Json): Record<string, Json> {
  if (!object(value)) throw new Error('INVALID_BUNDLED_SCHEMA');
  return value as Record<string, Json>;
}
/** Closed subset used only by bundled schemas. Unknown schema keywords fail closed. */
export function matchesSchema(value: Json, schema: Json): boolean {
  if (!object(schema)) return false;
  const allowed = [
    'type',
    'properties',
    'required',
    'additionalProperties',
    'oneOf',
    'const',
    'enum',
    'items',
    'uniqueItems',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'pattern',
  ];
  if (Object.keys(schema).some((key) => !allowed.includes(key))) return false;
  if (Array.isArray(schema.oneOf))
    return schema.oneOf.filter((s) => matchesSchema(value, s as Json)).length === 1;
  if (Object.hasOwn(schema, 'const') && canonicalJson(value) !== canonicalJson(schema.const))
    return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => canonicalJson(item) === canonicalJson(value))
  )
    return false;
  switch (schema.type) {
    case undefined:
      return Object.hasOwn(schema, 'const') || Array.isArray(schema.enum);
    case 'string':
      return (
        typeof value === 'string' &&
        value.length >= Number(schema.minLength ?? 0) &&
        value.length <= Number(schema.maxLength ?? 262144) &&
        (typeof schema.pattern !== 'string' || new RegExp(schema.pattern).test(value))
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= Number(schema.minimum ?? 0)
      );
    case 'array':
      return (
        Array.isArray(value) &&
        value.length >= Number(schema.minItems ?? 0) &&
        value.length <= Number(schema.maxItems ?? 10000) &&
        (!schema.uniqueItems ||
          new Set(value.map((v) => canonicalJson(v))).size === value.length) &&
        value.every((item) => matchesSchema(item, schema.items as Json))
      );
    case 'object': {
      if (!object(value)) return false;
      const properties = object(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      return (
        required.every((key) => typeof key === 'string' && Object.hasOwn(value, key)) &&
        Object.entries(value).every(([key, item]) =>
          Object.hasOwn(properties, key)
            ? matchesSchema(item as Json, properties[key] as Json)
            : object(schema.additionalProperties) &&
              matchesSchema(item as Json, schema.additionalProperties as Json),
        )
      );
    }
    default:
      return false;
  }
}
export function fieldSchemas(schema: Json): Record<string, Json> {
  if (!object(schema) || !object(schema.properties)) throw new Error('INVALID_BUNDLED_SCHEMA');
  return schema.properties as Record<string, Json>;
}
