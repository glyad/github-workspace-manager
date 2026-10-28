import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkFiles } from '../../tools/governance/check-files.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gwm-file-policy-'));
  const paths = [
    'governance/repository.json',
    'package.json',
    'LICENSE',
    '.github/CODEOWNERS',
    'CODE_OF_CONDUCT.md',
    'SECURITY.md',
    '.gitignore',
    ...['feature', 'bug', 'chore', 'documentation', 'hotfix', 'version'].map(
      (name) => `.github/ISSUE_TEMPLATE/${name}.yml`,
    ),
  ];
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path));
  }
  return root;
}
test('product checks require actual source and admit the implemented domain slice without weakening baseline identity', async () => {
  const root = await fixture();
  try {
    assert.ok(
      (await checkFiles(root)).includes('Product checks require actual product implementation'),
    );
    for (const path of [
      'packages/domain/src/identity.ts',
      'packages/domain/src/records.ts',
      'tests/unit/identity.test.ts',
      'tsconfig.json',
    ]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path));
    }
    assert.deepEqual(await checkFiles(root), []);
    await writeFile(join(root, 'LICENSE'), 'wrong copyright');
    assert.ok((await checkFiles(root)).includes('Missing approved copyright'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
