import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

/** Parse imports, including TS type imports and dynamic imports; no text matching. */
export async function checkBoundaries(root = process.cwd()) {
  const errors = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`${relative(root, file)}: source symlink forbidden`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const path = relative(root, file).replaceAll('\\', '/');
      if (!path.includes('/src/')) continue;
      const layer = path.split('/')[1];
      let ast;
      try {
        ast = parse(await readFile(file, 'utf8'), {
          sourceType: 'module',
          plugins: ['typescript', 'jsx'],
        });
      } catch {
        errors.push(`${path}: source cannot be parsed`);
        continue;
      }
      function check(source) {
        if (typeof source !== 'string') {
          errors.push(`${path}: computed module loading forbidden`);
          return;
        }
        const target = source.startsWith('.')
          ? relative(root, resolve(dirname(file), source)).replaceAll('\\', '/')
          : source;
        const targetLayer = target.startsWith('packages/')
          ? target.split('/')[1]
          : source.startsWith('@github-workspace-manager/')
            ? source.split('/')[1]
            : undefined;
        const testImport = /(^|\/)tests?\//.test(target);
        const inside = target.startsWith(`packages/${layer}/src/`);
        const allowedExternal =
          layer === 'domain' && /^@noble\/hashes\/(sha2|utils)\.js$/.test(source);
        const allowedApplication =
          ['application', 'components'].includes(layer) && targetLayer === 'domain';
        const allowedBundledAsset =
          layer === 'components' &&
          /^packages\/components\/assets\/(licenses|gitignore)\.json$/.test(target);
        if (
          testImport ||
          (['domain', 'application', 'components'].includes(layer) &&
            !inside &&
            !allowedExternal &&
            !allowedApplication &&
            !allowedBundledAsset)
        )
          errors.push(`${path}: forbidden import ${source}`);
      }
      function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (
          ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(
            node.type,
          ) &&
          node.source
        )
          check(node.source.value);
        if (node.type === 'ImportExpression')
          check(node.source?.type === 'StringLiteral' ? node.source.value : undefined);
        if (node.type === 'TSImportType')
          check(node.source?.type === 'StringLiteral' ? node.source.value : undefined);
        if (node.type === 'TSExternalModuleReference')
          check(node.expression?.type === 'StringLiteral' ? node.expression.value : undefined);
        if (
          node.type === 'CallExpression' &&
          (node.callee?.type === 'Import' || node.callee?.name === 'require')
        )
          check(node.arguments[0]?.type === 'StringLiteral' ? node.arguments[0].value : undefined);
        for (const [key, value] of Object.entries(node))
          if (key !== 'loc') {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
          }
      }
      visit(ast);
    }
  }
  await walk(resolve(root, 'packages'));
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkBoundaries();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Product dependency boundaries verified');
}
