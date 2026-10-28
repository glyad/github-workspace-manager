import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Validate public seed policy, not historical plan examples or product scaffolding. */
export async function checkFiles(root) {
  const errors = [];
  const read = async (path) => readFile(join(root, path), 'utf8');
  try {
    const repo = JSON.parse(await read('governance/repository.json'));
    const pkg = JSON.parse(await read('package.json'));
    if (
      repo.fullName !== 'glyad/github-workspace-manager' ||
      repo.visibility !== 'public' ||
      pkg.license !== 'MIT' ||
      pkg.repository?.url !== 'https://github.com/glyad/github-workspace-manager.git'
    )
      errors.push('Repository identity or license differs from approved baseline');
    if (!(await read('LICENSE')).includes('Copyright (c) 2026 David Kossoglyad'))
      errors.push('Missing approved copyright');
    if ((await read('.github/CODEOWNERS')).trim() !== '* @glyad')
      errors.push('CODEOWNERS must preserve sole owner');
    for (const name of ['CODE_OF_CONDUCT.md', 'SECURITY.md'])
      if (!(await read(name)).includes('david@logoui.co.il'))
        errors.push(`${name}: missing real reporting contact`);
    if (!(await read('.gitignore')).split('\n').includes('.governance-local/'))
      errors.push('Private governance state must be ignored');
    for (const file of ['feature', 'bug', 'chore', 'documentation', 'hotfix', 'version']) {
      const form = JSON.parse(await read(`.github/ISSUE_TEMPLATE/${file}.yml`));
      if (!form.name || !form.description || !Array.isArray(form.body))
        errors.push(`${file}: invalid issue form`);
      for (const id of ['scope', 'acceptance', 'dependencies', 'version'])
        if (
          !form.body.some(
            (f) => f.id === id && f.validations?.required === true && f.attributes?.label,
          )
        )
          errors.push(`${file}: required ${id} missing`);
    }
    if (Object.keys(pkg.scripts).some((k) => ['build', 'typecheck', 'test:product'].includes(k))) {
      // Product development supersedes the setup-only script prohibition.
      // Keep rejecting advertised product checks without their actual source.
      const productFiles = [
        'packages/domain/src/identity.ts',
        'packages/domain/src/records.ts',
        'tests/unit/identity.test.ts',
        'tsconfig.json',
      ];
      const present = await Promise.all(
        productFiles.map(async (path) => {
          try {
            return (await read(path)).trim().length > 0;
          } catch {
            return false;
          }
        }),
      );
      if (present.some((value) => !value))
        errors.push('Product checks require actual product implementation');
    }
    const walk = async (dir = '') => {
      for (const name of await readdir(join(root, dir))) {
        if (['node_modules', '.git', '.governance-local'].includes(name)) continue;
        const rel = dir ? `${dir}/${name}` : name;
        const stat = await lstat(join(root, rel));
        if (stat.isSymbolicLink()) {
          errors.push(`${rel}: public seed symlink forbidden`);
          continue;
        }
        if (stat.isDirectory()) {
          await walk(rel);
          continue;
        }
        if (stat.size > 2_000_000) {
          errors.push(`${rel}: unexpected large seed file`);
          continue;
        }
        const content = await read(rel);
        if (
          /-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{20,}/.test(
            content,
          )
        )
          errors.push(`${rel}: possible credential material`);
        if (rel.endsWith('.md') && !/\[[^\]]+\]\(#[^)]+\)/.test(content))
          errors.push(`${rel}: linked table of contents missing`);
      }
    };
    await walk();
  } catch {
    errors.push('Required baseline file missing or malformed');
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkFiles(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Public baseline policy verified');
}
