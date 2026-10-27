import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { payloadDigest } from '../../tools/governance/reviewer-app-publish.mjs';
import { handoff, createHandoffPort } from '../../tools/governance/reviewer-app-handoff.mjs';
const p = {
  version: 1,
  operationId: 'handoff-test-001',
  repository: 'glyad/github-workspace-manager',
  repositoryId: 1427426748,
  prNumber: 12,
  prId: 333,
  baseRepositoryId: 1427426748,
  headRepositoryId: 1427426748,
  baseRef: 'develop',
  headRef: 'chore/test',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  reviewer: { model: 'gpt-6-astra', effort: 'high', evidence: 'review-001' },
  operation: { type: 'reply', commentId: 77, body: 'Rechecked.' },
};
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'review-handoff-'));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('prepared checkpoint is atomic, immutable by operation id, and resumes without redispatch', () =>
  fixture(async (directory) => {
    const calls = [];
    const port = {
      observe: async () => ({ current: true, runs: [] }),
      dispatch: async () => {
        calls.push('dispatch');
      },
      result: async () => null,
    };
    assert.equal(
      (await handoff({ payload: p, directory, port, prepareOnly: true })).state,
      'prepared',
    );
    assert.equal(calls.length, 0);
    assert.equal((await handoff({ payload: p, directory, port })).state, 'dispatched');
    assert.equal((await handoff({ payload: p, directory, port })).state, 'uncertain');
    assert.equal(calls.length, 1);
    await assert.rejects(
      handoff({
        payload: { ...p, operation: { ...p.operation, body: 'Changed' } },
        directory,
        port,
      }),
    );
    assert.equal(
      JSON.parse(await readFile(join(directory, p.operationId + '.json'), 'utf8')).digest.length,
      64,
    );
  }));
test('dispatch timeout discovers run and reads verified receipt; cancelled run never redispatches', () =>
  fixture(async (directory) => {
    let dispatched = false;
    const run = { id: 200, status: 'completed', conclusion: 'success' };
    const port = {
      observe: async () => ({ current: true, runs: dispatched ? [run] : [] }),
      dispatch: async () => {
        dispatched = true;
        throw Error('private failure');
      },
      result: async (item) => ({
        operationId: p.operationId,
        digest: item.digest,
        state: 'verified',
        nativeId: 99,
        revoked: true,
      }),
    };
    const result = await handoff({ payload: p, directory, port });
    assert.equal(result.state, 'verified');
    assert.equal(result.runId, 200);
  }));
test('changed candidate marks old item stale, failed/cancelled run remains uncertain', () =>
  fixture(async (directory) => {
    const port = {
      observe: async () => ({ current: false, runs: [] }),
      dispatch: async () => assert.fail('must not dispatch'),
    };
    assert.equal((await handoff({ payload: p, directory, port })).state, 'stale');
  }));

test('observed stale checkpoint stays stale when refs return to the original pair', () =>
  fixture(async (directory) => {
    let current = false;
    const port = {
      observe: async () => ({ current, runs: [] }),
      dispatch: async () => assert.fail('stale item must never dispatch'),
    };
    assert.equal((await handoff({ payload: p, directory, port })).state, 'stale');
    current = true;
    assert.equal((await handoff({ payload: p, directory, port })).state, 'stale');
  }));

test('real handoff adapter retains authenticated remote stale receipt despite a currently matching old pair', () =>
  fixture(async (directory) => {
    const digest = payloadDigest(p),
      bot = { id: 348541410, login: 'glyad-workspace-reviewer[bot]', type: 'Bot' };
    const root = '/repos/' + p.repository;
    const receipt = {
      version: 1,
      operationId: p.operationId,
      digest,
      state: 'stale',
      nativeId: 99,
      authorId: bot.id,
      revoked: true,
      baseSha: p.baseSha,
      headSha: p.headSha,
    };
    const comment = {
      id: 99,
      user: bot,
      in_reply_to_id: 77,
      pull_request_url: 'https://api.github.com' + root + '/pulls/12',
      body: `${p.operation.body}\n\nLocal ${p.reviewer.model}/${p.reviewer.effort}; base ${p.baseSha}; head ${p.headSha}.\n<!-- local-review:${p.operationId}:${digest} -->`,
    };
    const calls = [];
    const command = async (args) => {
      calls.push(args);
      if (args[0] === 'run')
        return (
          'publish\t2026-10-27T00:00:00Z LOCAL_REVIEW_RECEIPT ' + JSON.stringify(receipt) + '\n'
        );
      const path = args.at(-1);
      let value;
      if (path === root + '/pulls/12')
        value = {
          id: p.prId,
          number: p.prNumber,
          state: 'open',
          draft: false,
          base: {
            repo: { id: p.baseRepositoryId, full_name: p.repository },
            ref: p.baseRef,
            sha: p.baseSha,
          },
          head: { repo: { id: p.headRepositoryId }, ref: p.headRef, sha: p.headSha },
        };
      else if (path.endsWith('/git/ref/heads/develop')) value = { object: { sha: p.baseSha } };
      else if (path.endsWith('/actions/workflows/reviewer-app-publish.yml'))
        value = { id: 56, path: '.github/workflows/reviewer-app-publish.yml' };
      else if (path.includes('/actions/workflows/56/runs?'))
        value = {
          total_count: 1,
          workflow_runs: [
            {
              id: 200,
              display_title: 'Local review ' + p.operationId,
              workflow_id: 56,
              path: '.github/workflows/reviewer-app-publish.yml',
              event: 'workflow_dispatch',
              head_branch: 'main',
              repository: { id: p.repositoryId },
              actor: { id: 4238205, login: 'glyad' },
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        };
      else if (path.startsWith('/users/')) value = bot;
      else if (path.endsWith('/pulls/comments/77'))
        value = {
          id: 77,
          pull_request_url: comment.pull_request_url,
          original_commit_id: 'd'.repeat(40),
        };
      else if (path.includes('/pulls/12/comments?')) value = [comment];
      else if (path.endsWith('/pulls/comments/99')) value = comment;
      else assert.fail('Unexpected command path ' + path);
      return JSON.stringify(value);
    };
    const port = createHandoffPort({ command });
    const item = await handoff({ payload: p, directory, port });
    assert.equal(item.state, 'stale');
    assert.equal(item.receipt.state, 'stale');
    assert.equal(item.receipt.nativeId, 99);
    assert.equal((await handoff({ payload: p, directory, port })).state, 'stale');
    assert.equal(calls.filter((args) => args[0] === 'run').length, 1);
    assert.ok(calls.every((args) => !args.includes('POST')));
  }));
