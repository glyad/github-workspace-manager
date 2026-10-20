export function validateDesired(d) {
  return d?.host === 'github.com' && d.owner === 'glyad' && d.name === 'github-workspace-manager' && d.fullName === 'glyad/github-workspace-manager' && d.destination === '/Users/davidkossoglyad/Documents/GitHub/glyad/github-workspace-manager' && d.visibility === 'public' && d.protocol === 'https' && d.signedCommitsRequired === true ? null : 'Desired repository/account/destination differs from approved setup';
}
export function isEvidence(items) {
  const now = Date.now();
  return Array.isArray(items) && items.length > 0 && items.every((e) => e && ['source', 'actorId', 'resourceId', 'observedAt'].every((key) => typeof e[key] === 'string' && e[key].length > 0) && Number.isFinite(Date.parse(e.observedAt)) && now - Date.parse(e.observedAt) >= -30_000 && now - Date.parse(e.observedAt) <= 300_000);
}
export function isEvidenceFor(items, actorId, resourceIds) {
  return typeof actorId === 'string' && actorId.length > 0 &&
    Array.isArray(resourceIds) && resourceIds.length > 0 &&
    resourceIds.every((id) => typeof id === 'string' && id.length > 0) &&
    isEvidence(items) && items.every((item) => item.actorId === actorId && resourceIds.includes(item.resourceId));
}
export function validateSnapshot(s) {
  const d = s?.desired;
  if (validateDesired(d)) return 'Desired repository/account/destination differs from approved setup';
  if (!isEvidence(s.evidence)) return 'Missing or stale preflight evidence';
  if (s.host !== d.host || s.actor?.login !== d.owner || !s.actor.id || s.protocol !== 'https') return 'Wrong account, host or HTTPS access';
  if (s.evidence.some((e) => e.actorId !== s.actor.id)) return 'Preflight evidence account mismatch';
  if (s.repository?.fullName !== d.fullName || typeof s.repository.exists !== 'boolean' || (s.repository.exists && !s.repository.id)) return 'Wrong or unresolved repository identity';
  if (!isEvidenceFor(s.evidence, s.actor.id, [d.fullName, ...(s.repository.id ? [s.repository.id] : [])])) return 'Preflight evidence repository identity mismatch';
  if (s.destination?.path !== d.destination || !s.destination.safeAncestors || !['absent', 'empty'].includes(s.destination.state)) return 'Unsafe or nonempty destination; inspect existing checkout manually';
  if (s.signing?.localVerified !== true || s.signing.githubAssociationVerified !== true || !s.signing.fingerprint) return 'Existing signing identity and GitHub signing association must be verified';
  if (s.project?.authorized !== true || s.project.scopeVerified !== true || !Array.isArray(s.project.matches) || s.project.matches.length > 1) return 'Project authorization or exact Project identity unresolved';
  if (s.rules?.supported !== true || !s.rules.revision || !Array.isArray(s.rules.effective)) return 'Effective rules and safe temporary control unresolved';
  return null;
}
const rootFiles = new Set(['README.md', 'LICENSE', 'CONTRIBUTING.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md', 'BACKLOG.md', '.gitignore', '.gitattributes', '.editorconfig', '.node-version', '.npmrc', 'package.json', 'package-lock.json', 'eslint.config.mjs', '.prettierrc.json']);
const taskTools = new Set(['contracts.mjs', 'validate.mjs', 'github.mjs', 'setup.mjs', 'baseline.mjs', 'check-files.mjs', 'project-baseline.mjs', 'protections.mjs', 'verify-baseline.mjs']);
export function isSetupPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || /[\0\r\n]/.test(path)) return false;
  if (rootFiles.has(path)) return true;
  if (/^governance\/(repository|project|labels|activation|scope|checks)\.json$/.test(path)) return true;
  if (path.startsWith('tools/governance/')) return taskTools.has(path.slice('tools/governance/'.length));
  if (/^tests\/governance\/(setup|baseline|project-baseline|protections|verify-baseline)\.test\.mjs$/.test(path)) return true;
  if (/^\.github\/(CODEOWNERS|PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/(feature|bug|chore|documentation|hotfix|version|config)\.yml)$/.test(path)) return true;
  return /^docs\/[A-Za-z0-9_./-]+\.md$/.test(path);
}
