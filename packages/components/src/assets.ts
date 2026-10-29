import {
  boundedJson,
  decodeConfiguration,
  decodeConfigurationSource,
  object,
} from '../../domain/src/configuration.js';
import type { Configuration, Resolved } from '../../domain/src/configuration.js';
import { artifactDigest } from '../../domain/src/components.js';
import type { FileChange } from '../../domain/src/components.js';
import type { ArtifactStore } from '../../domain/src/ports.js';
import { decodeRecord } from '../../domain/src/records.js';
import type { Artifact, FieldIntent, Issue, Json, Result } from '../../domain/src/records.js';
import { componentIssue, validateManagedFields } from './registry.js';
import licenses from '../assets/licenses.json' with { type: 'json' };
import ignores from '../assets/gitignore.json' with { type: 'json' };

type Recipe = { path: string; text?: string; beforeDigest?: string };
const fixedPaths: Record<string, string> = {
  'readme.content': 'README.md',
  'license.selection': 'LICENSE',
  'license.content': 'LICENSE',
  'gitignore.templates': '.gitignore',
  'gitignore.content': '.gitignore',
  'prTemplate.content': '.github/PULL_REQUEST_TEMPLATE.md',
};
/** One portable basename in the trusted template directory, excluding config.yml. */
function issueTemplatePath(path: string): boolean {
  const prefix = '.github/ISSUE_TEMPLATE/';
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return (
    /^(?!\.)(?!.*\.\.)(?!config\.ya?ml$)[a-z0-9][a-z0-9_.-]*\.(md|yml|yaml)$/i.test(name) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(name) &&
    path.length <= 240
  );
}
function textInput(input: Json, supplied: Record<string, string>): string {
  if (typeof input === 'string') return input;
  if (
    object(input) &&
    typeof input.suppliedText === 'string' &&
    Object.hasOwn(supplied, input.suppliedText) &&
    typeof supplied[input.suppliedText] === 'string'
  )
    return supplied[input.suppliedText]!;
  throw new Error('SUPPLIED_TEXT_REQUIRED');
}
/** Verify each bundled data file's pinned raw template hash before rendering. */
function checkedTemplate(template: string, digest: string): string {
  if (artifactDigest(new TextEncoder().encode(template)) !== digest)
    throw new Error('BUNDLED_ASSET_INTEGRITY');
  return template;
}
function licenseText(input: Json): string {
  if (
    !object(input) ||
    input.id !== 'MIT' ||
    typeof input.year !== 'string' ||
    typeof input.holder !== 'string'
  )
    throw new Error('INVALID_COMPONENT_VALUE');
  return checkedTemplate(licenses.MIT.template, licenses.MIT.sha256)
    .replace('[year]', () => input.year as string)
    .replace('[fullname]', () => input.holder as string);
}
function ignoreText(input: Json): string {
  if (!Array.isArray(input)) throw new Error('INVALID_COMPONENT_VALUE');
  return input
    .map((id) => {
      if (id !== 'Node') throw new Error('INVALID_COMPONENT_VALUE');
      return checkedTemplate(ignores.Node.template, ignores.Node.sha256);
    })
    .join('\n');
}
function validatedFields(config: Resolved): Result<Record<string, FieldIntent>> {
  try {
    const copy = boundedJson(config);
    if (
      !object(copy) ||
      Object.keys(copy).some((k) => !['resource', 'fields', 'sources', 'issues'].includes(k)) ||
      !object(copy.fields) ||
      !Array.isArray(copy.sources) ||
      !Array.isArray(copy.issues)
    )
      throw new Error('INVALID_RESOLVED');
    decodeRecord('resource', copy.resource);
    const issues: Issue[] = [];
    for (const issue of copy.issues) {
      if (
        !object(issue) ||
        typeof issue.code !== 'string' ||
        typeof issue.message !== 'string' ||
        typeof issue.blocking !== 'boolean'
      )
        throw new Error('INVALID_RESOLVED');
      if (issue.blocking) issues.push({ code: issue.code, message: issue.code, blocking: true });
    }
    if (issues.length) return { ok: false, issues };
    for (const source of copy.sources)
      if (!decodeConfigurationSource(source).ok) throw new Error('INVALID_RESOLVED');
    const fields: Record<string, FieldIntent> = {};
    for (const [path, field] of Object.entries(copy.fields)) {
      if (
        !object(field) ||
        Object.keys(field).sort().join(',') !== 'constraints,intent,source' ||
        !Array.isArray(field.constraints)
      )
        throw new Error('INVALID_RESOLVED');
      const decoded = decodeConfiguration(
        {
          formatVersion: 1,
          resource: copy.resource,
          fields: { [path]: field.intent },
          components: [],
        },
        field.source as Configuration['source'],
      );
      if (!decoded.ok) return decoded;
      fields[path] = decoded.value.fields[path]!;
    }
    const invalid = validateManagedFields(fields);
    return invalid.length ? { ok: false, issues: invalid } : { ok: true, value: fields };
  } catch {
    return { ok: false, issues: [componentIssue('INVALID_RESOLVED')] };
  }
}
/** Pure recipes, then immutable byte capture. No repository, filesystem, model or provider writes. */
export async function renderAssets(
  config: Resolved,
  suppliedText: Record<string, string>,
  artifacts: ArtifactStore,
): Promise<Result<FileChange[]>> {
  const validated = validatedFields(config);
  if (!validated.ok) return validated;
  const recipes: Recipe[] = [];
  try {
    // Copy caller-owned prose before the first await, preventing later changes from
    // silently replacing already selected content while artifact persistence runs.
    const supplied = boundedJson(suppliedText);
    if (!object(supplied) || !Object.values(supplied).every((v) => typeof v === 'string'))
      throw new Error('INVALID_SUPPLIED_TEXT');
    for (const [field, intent] of Object.entries(validated.value)) {
      if (intent.kind === 'unmanaged') continue;
      if (field === 'issueTemplates.files' && intent.kind === 'value') {
        if (!Array.isArray(intent.value)) throw new Error('INVALID_COMPONENT_VALUE');
        for (const item of intent.value) {
          if (!object(item) || typeof item.path !== 'string' || !issueTemplatePath(item.path))
            throw new Error('UNSAFE_ASSET_PATH');
          const before =
            typeof item.beforeDigest === 'string' ? { beforeDigest: item.beforeDigest } : {};
          recipes.push({
            path: item.path,
            ...before,
            ...(item.delete === true
              ? {}
              : { text: textInput(item.content as Json, supplied as Record<string, string>) }),
          });
        }
        continue;
      }
      const path = fixedPaths[field];
      if (!path) continue;
      if (intent.kind === 'reset') {
        recipes.push({ path });
        continue;
      }
      const text =
        field === 'license.selection'
          ? licenseText(intent.value)
          : field === 'gitignore.templates'
            ? ignoreText(intent.value)
            : textInput(intent.value, supplied as Record<string, string>);
      recipes.push({ path, text });
    }
    recipes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (new Set(recipes.map((r) => r.path.toLowerCase())).size !== recipes.length)
      throw new Error('DUPLICATE_ASSET_PATH');
    let total = 0;
    const prepared = recipes.map((recipe) => {
      if (recipe.text === undefined) return { recipe };
      const bytes = new TextEncoder().encode(recipe.text);
      total += bytes.length;
      if (bytes.length > 262144 || total > 4194304) throw new Error('ASSET_SIZE_LIMIT');
      if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== recipe.text)
        throw new Error('INVALID_ASSET_TEXT');
      return { recipe, bytes, digest: artifactDigest(bytes) };
    });
    // Complete all recipe/path validation before any persistence.
    const changes: FileChange[] = [];
    for (const { recipe, bytes, digest } of prepared) {
      const change: FileChange = {
        path: recipe.path,
        ...(recipe.beforeDigest ? { beforeDigest: recipe.beforeDigest } : {}),
      };
      if (bytes && digest) {
        const mediaType = 'text/plain; charset=utf-8';
        let ref: Artifact;
        try {
          ref = await artifacts.put(bytes.slice(), mediaType);
          if (
            !ref ||
            Object.keys(ref).sort().join(',') !== 'digest,mediaType,size' ||
            ref.digest !== digest ||
            ref.size !== bytes.length ||
            ref.mediaType !== mediaType
          )
            throw new Error('ARTIFACT_MISMATCH');
          const readback = await artifacts.get({ ...ref });
          if (
            !(readback instanceof Uint8Array) ||
            readback.length !== bytes.length ||
            artifactDigest(readback) !== digest
          )
            throw new Error('ARTIFACT_MISMATCH');
        } catch {
          return { ok: false, issues: [componentIssue('ARTIFACT_FREEZE_FAILED', recipe.path)] };
        }
        change.after = { digest, size: bytes.length, mediaType };
      }
      changes.push(change);
    }
    return { ok: true, value: changes };
  } catch (error) {
    const allowed = [
      'SUPPLIED_TEXT_REQUIRED',
      'BUNDLED_ASSET_INTEGRITY',
      'INVALID_COMPONENT_VALUE',
      'INVALID_SUPPLIED_TEXT',
      'UNSAFE_ASSET_PATH',
      'DUPLICATE_ASSET_PATH',
      'ASSET_SIZE_LIMIT',
      'INVALID_ASSET_TEXT',
    ];
    const code =
      error instanceof Error && allowed.includes(error.message)
        ? error.message
        : 'INVALID_ASSET_INPUT';
    return { ok: false, issues: [componentIssue(code)] };
  }
}
