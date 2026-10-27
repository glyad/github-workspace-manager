import { readFile, writeFile, rename, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import {
  validatePayload,
  payloadDigest,
  dispatchBody,
  publishOperation,
  repository,
} from './reviewer-app-publish.mjs';
const root = `/repos/${repository}`;
const workflowPath = `${root}/actions/workflows/reviewer-app-publish.yml`;
const runName = (p) => `Local review ${p.operationId}`;
const fail = () => {
  throw Error('Local handoff validation failed');
};

/** One local writer; checkpoint before dispatch makes a crash conservative. No automatic redispatch. */
export async function handoff({ payload, directory, port, prepareOnly = false }) {
  const p = validatePayload(payload),
    digest = payloadDigest(p);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(join(directory, '.lock'), 'wx', 0o600);
  try {
    const path = join(directory, `${p.operationId}.json`);
    let item;
    try {
      item = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (
      item &&
      (item.digest !== digest ||
        payloadDigest(item.payload) !== digest ||
        item.operationId !== p.operationId ||
        !['prepared', 'dispatched', 'verified', 'stale', 'uncertain'].includes(item.state))
    )
      fail();
    item ??= { version: 1, operationId: p.operationId, digest, payload: p, state: 'prepared' };
    const save = async () => {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(item, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, path);
      return item;
    };
    await save();
    if (prepareOnly) return item;
    const observe = async () => {
      const seen = await port.observe(p);
      if (
        !seen ||
        typeof seen.current !== 'boolean' ||
        !Array.isArray(seen.runs) ||
        seen.runs.length > 1
      )
        fail();
      if (!seen.current) {
        item.state = 'stale';
        return null;
      }
      return seen;
    };
    let seen = await observe();
    if (!seen || item.state === 'stale') return save();
    // Always inspect GitHub, including on a locally completed checkpoint.
    if (!seen.runs.length && item.state === 'prepared') {
      item.state = 'dispatched';
      await save();
      try {
        await port.dispatch(p);
      } catch {
        item.state = 'uncertain';
      }
      try {
        seen = await observe();
      } catch {
        item.state = 'uncertain';
        return save();
      }
      if (!seen) return save();
    } else if (!seen.runs.length) {
      item.state = 'uncertain';
      return save();
    }
    const run = seen.runs[0];
    if (!run) return save();
    if (!Number.isSafeInteger(run.id) || run.id <= 0 || (item.runId && item.runId !== run.id))
      fail();
    item.runId = run.id;
    await save();
    if (run.status !== 'completed') {
      item.state = 'dispatched';
      return save();
    }
    // A failed/cancelled run may have published. Inspect its receipt and native readback too.
    let receipt;
    try {
      receipt = await port.result(item, run);
    } catch {
      /* Preserve uncertainty. */
    }
    if (
      receipt?.operationId === p.operationId &&
      receipt.digest === digest &&
      receipt.state === 'verified' &&
      receipt.revoked === true
    ) {
      item.state = 'verified';
      item.receipt = receipt;
    } else if (receipt?.state === 'stale') {
      item.state = 'stale';
      item.receipt = receipt;
    } else item.state = 'uncertain';
    return save();
  } finally {
    await lock.close();
    await unlink(join(directory, '.lock'));
  }
}
async function gh(args, input) {
  // No shell interpolation, credential inspection, or local App-key handling.
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) =>
        error ? reject(Error('GitHub observation unavailable')) : resolve(stdout),
    );
    child.stdin.end(input ?? '');
  });
}
export function createHandoffPort({ command = gh, readyWorkflow } = {}) {
  const api = async (method, path, body) => {
    if (method !== 'GET') fail();
    return JSON.parse(await command(['api', '--hostname', 'github.com', path]));
  };
  return {
    async observe(p) {
      const pr = await api('GET', `${root}/pulls/${p.prNumber}`);
      const base = await api('GET', `${root}/git/ref/heads/develop`);
      const workflow = await api('GET', workflowPath);
      if (
        !Number.isSafeInteger(workflow?.id) ||
        workflow.path !== '.github/workflows/reviewer-app-publish.yml'
      )
        fail();
      const runs = [];
      for (let page = 1; page <= 15; page++) {
        const response = await api(
          'GET',
          `${root}/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main&per_page=20&page=${page}`,
        );
        if (!Array.isArray(response.workflow_runs) || response.workflow_runs.length > 20) fail();
        for (const run of response.workflow_runs)
          if (run.display_title === runName(p)) {
            if (
              run.workflow_id !== workflow.id ||
              run.path !== workflow.path ||
              run.event !== 'workflow_dispatch' ||
              run.head_branch !== 'main' ||
              run.repository?.id !== p.repositoryId ||
              run.actor?.id !== 4238205 ||
              run.actor?.login !== 'glyad'
            )
              fail();
            runs.push(run);
          }
        if (response.workflow_runs.length < 20) break;
        if (page === 15) fail();
      }
      return {
        current:
          pr.id === p.prId &&
          pr.state === 'open' &&
          (p.operation.type === 'reply' || pr.draft === false) &&
          ['base', 'head'].every(
            (k) =>
              pr[k]?.repo?.id === p[`${k}RepositoryId`] &&
              pr[k]?.ref === p[`${k}Ref`] &&
              pr[k]?.sha === p[`${k}Sha`],
          ) &&
          base.object?.sha === p.baseSha,
        runs,
      };
    },
    async dispatch(p) {
      await command(
        [
          'api',
          '--hostname',
          'github.com',
          '--method',
          'POST',
          `${workflowPath}/dispatches`,
          '--input',
          '-',
        ],
        dispatchBody(p),
      );
    },
    async result(item, run) {
      const log = await command(['run', 'view', String(run.id), '--repo', repository, '--log']);
      const receipts = log
        .split('\n')
        .filter((line) => line.includes('LOCAL_REVIEW_RECEIPT '))
        .map((line) =>
          JSON.parse(
            line.slice(line.indexOf('LOCAL_REVIEW_RECEIPT ') + 'LOCAL_REVIEW_RECEIPT '.length),
          ),
        );
      if (receipts.length !== 1) fail();
      const receipt = receipts[0];
      if (
        receipt.operationId !== item.operationId ||
        receipt.digest !== item.digest ||
        receipt.revoked !== true
      )
        fail();
      // Reconcile only: the local API adapter cannot POST or repeat an uncertain write.
      const native = await publishOperation(item.payload, api, {
        readyWorkflow,
        reconcileOnly: true,
      });
      if (native.nativeId !== receipt.nativeId || native.authorId !== receipt.authorId) fail();
      return {
        ...native,
        state: receipt.state === 'stale' ? 'stale' : native.state,
        revoked: true,
      };
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, input, directory] = process.argv.slice(2);
    if (
      !['prepare', 'send', 'resume'].includes(mode) ||
      !input ||
      !directory ||
      process.argv.length !== 5
    )
      fail();
    const value = JSON.parse(await readFile(resolve(input), 'utf8'));
    const payload = mode === 'resume' ? value.payload : value;
    const item = await handoff({
      payload,
      directory: resolve(directory),
      prepareOnly: mode === 'prepare',
      port: createHandoffPort({
        readyWorkflow: await readFile(
          new URL('../../.github/workflows/ready-ci.yml', import.meta.url),
          'utf8',
        ),
      }),
    });
    console.log(
      JSON.stringify({
        operationId: item.operationId,
        digest: item.digest,
        state: item.state,
        ...(item.runId ? { runId: item.runId } : {}),
      }),
    );
    if (!['prepared', 'dispatched', 'verified'].includes(item.state)) process.exitCode = 1;
  } catch {
    console.error(
      'Local handoff failed; inspect the retained checkpoint and GitHub before retrying',
    );
    process.exitCode = 1;
  }
}
