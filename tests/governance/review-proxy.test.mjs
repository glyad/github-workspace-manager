import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requestReview } from '../../tools/governance/review-proxy.mjs';
import * as worker from '../../tools/governance/worker-ledger.mjs';
import { LocalDurableStore } from '../../tools/governance/local-durable-store.mjs';
import { digest } from '../../tools/governance/journal.mjs';
import { reserveReviewBudget } from '../../tools/governance/review-budget.mjs';
import {
  candidate,
  limits,
  registration,
  observation,
  createReviewAuthorityFixture,
  canonical,
} from './fixtures/review-authority-fixture.mjs';
const material = { base: candidate.base, head: candidate.head, files: [] };
const body = canonical({
  version: 1,
  model: 'gpt-6-astra',
  effort: 'high',
  fresh: true,
  tools: [],
  maxOutputTokens: limits.maxOutputTokens,
  instructions: 'Review fixture',
  material,
});
const invocation = {
  candidate,
  materialDigest: digest(canonical(material)),
  body,
  bodyDigest: digest(body),
  inputBytes: Buffer.byteLength(body),
  model: 'gpt-6-astra',
  effort: 'high',
  fresh: true,
  limits,
};
async function execute(t, callback, claimedInvocation = invocation) {
  const root = await fs.mkdtemp(join(tmpdir(), 'review-proxy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalDurableStore(root);
  await store.initializeReviewFunding(
    'proxy-fixture',
    digest(JSON.stringify(['review-limits-v1', ...Object.values(limits)])),
  );
  const fixture = createReviewAuthorityFixture({ registrations: [registration()], outcomes: [] });
  const ledger = worker.createLocalReviewLedger({
    store,
    fundingScope: 'proxy-fixture',
    approvedLimits: limits,
    observeUnderPrLock: async (c) => observation(c),
    ...fixture,
  });
  const receipt = fixture.originAuthority.resolve({
    candidate,
    reservationRequestId: 'paid-1',
  }).value;
  const reserved = await reserveReviewBudget(
    { candidate, requestId: 'paid-1', observed: observation() },
    limits,
    ledger.forOrigin(receipt),
  );
  assert.equal(reserved.kind, 'verified');
  const claimed = await worker.claimReservation(
    reserved.value.key,
    {
      originReceipt: receipt,
      materialDigest: claimedInvocation.materialDigest,
      invocationDigest: claimedInvocation.bodyDigest,
    },
    ledger,
  );
  assert.equal(claimed.kind, 'verified');
  let failure;
  const result = await worker.withClaimedReview(claimed.value.id, ledger, async (...args) => {
    try {
      return await callback(...args);
    } catch (error) {
      failure = error;
      throw error;
    }
  });
  if (failure) throw failure;
  assert.equal(
    result.kind,
    'verified',
    'guarded assertions must not be swallowed by lifecycle uncertainty',
  );
  return result;
}
// Synthetic token recipe: one generated ASCII byte is one declared synthetic token.
// Only requested chunks are allocated; no hidden whole-response buffer exists.
function producer({ tokens = 3, read, finish, verify, open } = {}) {
  const stats = {
    opens: 0,
    reads: 0,
    cancels: 0,
    finishes: 0,
    verifies: 0,
    generated: 0,
    events: [],
    timeline: [],
  };
  const event = (name) => {
    stats.events.push(name);
    stats.timeline.push({
      sequence: stats.timeline.length + 1,
      event: name,
      at: performance.now(),
    });
  };
  let measured = 0,
    hash = createHash('sha256'),
    retained;
  const key = 'in-memory-fake-key';
  const source = {
    async read(args) {
      stats.reads++;
      event('read');
      if (read) return read(args, stats);
      const n = Math.min(
        args.maxBytes,
        tokens - measured,
        stats.request.maxOutputTokens - measured,
        stats.request.maxResponseBytes - measured,
      );
      if (n === 0) return { chunk: new Uint8Array(), done: true };
      const chunk = new Uint8Array(n).fill(120);
      hash.update(chunk);
      measured += n;
      stats.generated += n;
      return { chunk, done: false };
    },
    async finish(args) {
      stats.finishes++;
      event('finish');
      retained = Object.freeze({
        bodyDigest: hash.digest('hex'),
        totalBytes: measured,
        complete: true,
        outputTokens: measured,
        providerOutcome: 'completed',
        evidenceId: 'fake-response-1',
      });
      return finish ? finish({ ...retained }, args) : retained;
    },
    async cancel() {
      stats.cancels++;
      event('cancel');
    },
  };
  const port = {
    async open(args) {
      assert.equal(key, 'in-memory-fake-key');
      stats.opens++;
      stats.request = args;
      event('open');
      return open ? open(args, source) : { kind: 'verified', value: source };
    },
    async verifyCompletion(row, binding) {
      stats.verifies++;
      return verify
        ? verify(row, binding)
        : canonical(row) === canonical(retained) &&
            row.outputTokens === measured &&
            binding.totalBytes === measured
          ? { kind: 'verified', value: null }
          : { kind: 'blocked' };
    },
  };
  return { port, stats, source };
}
const signal = () => new AbortController().signal;
function completed(result) {
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.providerOutcome, 'completed');
  assert.equal(result.value.executionEnded, false);
}
function unknown(result) {
  assert.equal(result.kind, 'verified');
  assert.equal(result.value.providerOutcome, 'unknown');
  assert.equal(result.value.executionEnded, false);
  assert.equal(result.value.resultBody, null);
  assert.equal(result.value.outputTokens, null);
  assert.equal(result.value.evidenceId, null);
}
test('copied_claim_cannot_send and guard_replay_sends_once', async (t) => {
  await execute(t, async (claim, guard) => {
    const f = producer();
    assert.equal(
      (await requestReview(invocation, structuredClone(claim), f.port, signal())).kind,
      'blocked',
    );
    const r = await requestReview(invocation, guard, f.port, signal());
    completed(r);
    assert.equal(r.value.claimId, claim.id);
    assert.deepEqual(r.value.run, claim.run);
    assert.equal(r.value.resultBody, 'xxx');
    assert.equal((await requestReview(invocation, guard, f.port, signal())).kind, 'blocked');
    assert.equal(f.stats.opens, 1);
    assert.equal(f.stats.request.body, body);
    assert.deepEqual(
      Object.keys(f.stats.request).sort(),
      ['body', 'maxOutputTokens', 'maxResponseBytes', 'maxChunkBytes', 'signal'].sort(),
    );
    return r;
  });
});
test('encoded_input_over_limit_sends_zero; redirect_retry_and_tool_requests_denied', async (t) => {
  await execute(t, async (_claim, guard) => {
    const f = producer();
    for (const patch of [
      { inputBytes: limits.maxInputBytes + 1 },
      { body: body + ' ' },
      { redirect: true },
      { retry: 1 },
      ...['tools', 'redirect', 'retry'].map((k) => {
        const e = JSON.parse(body);
        e[k] = k === 'tools' ? ['shell'] : true;
        const b = canonical(e);
        return { body: b, bodyDigest: digest(b), inputBytes: Buffer.byteLength(b) };
      }),
    ])
      assert.equal(
        (await requestReview({ ...invocation, ...patch }, guard, f.port, signal())).kind,
        'blocked',
      );
    assert.equal(f.stats.opens, 0);
    completed(await requestReview(invocation, guard, f.port, signal()));
  });
});
test('output_token_limit_reaches_transport and producer enforces actual synthetic ceiling', async (t) => {
  await execute(t, async (_c, g) => {
    const f = producer({ tokens: limits.maxOutputTokens + 20 });
    const r = await requestReview(invocation, g, f.port, signal());
    completed(r);
    assert.equal(f.stats.request.maxOutputTokens, limits.maxOutputTokens);
    assert.equal(r.value.outputTokens, limits.maxOutputTokens);
    assert.equal(f.stats.generated, limits.maxOutputTokens);
    assert.equal(Buffer.byteLength(r.value.resultBody), limits.maxOutputTokens);
  });
});
test('missing_or_excess_output_tokens_unknown and independent measured usage required', async (t) => {
  for (const mutate of [
    (r) => {
      delete r.outputTokens;
      return r;
    },
    (r) => ({ ...r, outputTokens: -1 }),
    (r) => ({ ...r, outputTokens: 1.5 }),
    (r) => ({ ...r, outputTokens: limits.maxOutputTokens + 1 }),
    (r) => ({ ...r, outputTokens: 2 }),
    (r) => ({ ...r, totalBytes: 4 }),
    (r) => ({ ...r, complete: false }),
    (r) => ({ ...r, providerOutcome: 'redirect' }),
  ])
    await execute(t, async (_c, g) => {
      const f = producer({ finish: mutate });
      unknown(await requestReview(invocation, g, f.port, signal()));
      assert.equal(f.stats.cancels, 1);
    });
});
test('response_infinite_source_bounded and oversized_response_stops_reading', async (t) => {
  await execute(t, async (_c, g) => {
    const f = producer({
      read: ({ maxBytes }) => ({ chunk: new Uint8Array(maxBytes || 1).fill(120), done: false }),
    });
    unknown(await requestReview(invocation, g, f.port, signal()));
    assert.equal(f.stats.reads, Math.ceil(1_000_000 / 16384) + 1);
    assert.equal(f.stats.finishes, 0);
    assert.equal(f.stats.cancels, 1);
    assert.equal(f.stats.events.at(-1), 'cancel');
    assert.ok(
      f.stats.timeline.every((e, i, a) => e.sequence === i + 1 && (i === 0 || e.at >= a[i - 1].at)),
    );
    t.diagnostic(
      JSON.stringify({
        cancellationTimeline: f.stats.timeline.slice(-3),
        reads: f.stats.reads,
        opens: f.stats.opens,
      }),
    );
  });
});
test('response_oversized_chunk_not_copied ignores shadow length and copy hooks', async (t) => {
  let hooks = 0;
  const bytes = new Uint8Array(16385);
  for (const k of ['byteLength', 'buffer', 'byteOffset', 'slice', 'subarray'])
    Object.defineProperty(bytes, k, {
      get() {
        hooks++;
        throw Error('hook');
      },
    });
  await execute(t, async (_c, g) => {
    const f = producer({ read: () => ({ chunk: bytes, done: false }) });
    unknown(await requestReview(invocation, g, f.port, signal()));
    assert.equal(hooks, 0);
    assert.equal(f.stats.reads, 1);
    assert.equal(f.stats.cancels, 1);
  });
});
test('rejects accessor/proxy frames and shared/resizable byte views without executing traps', async (t) => {
  let hooks = 0;
  const get = () => {
    hooks++;
    throw Error('untrusted');
  };
  const bad = [
    Object.defineProperty({ done: false }, 'chunk', { get }),
    new Proxy({ chunk: new Uint8Array([1]), done: false }, { ownKeys: get }),
    { chunk: new Uint8Array(new SharedArrayBuffer(1)), done: false },
    { chunk: new Uint8Array(new ArrayBuffer(1, { maxByteLength: 2 })), done: false },
    { chunk: new Proxy(new Uint8Array([1]), {}), done: false },
    { chunk: new Uint8Array(), done: false },
    { chunk: new Uint8Array([1]), done: true },
  ];
  for (const frame of bad)
    await execute(t, async (_c, g) => {
      const f = producer({ read: () => frame });
      unknown(await requestReview(invocation, g, f.port, signal()));
      assert.equal(f.stats.reads, 1);
      assert.equal(f.stats.cancels, 1);
    });
  assert.equal(hooks, 0);
});
test('completion extras/accessors/proxies rejected before graph cloning or verifier', async (t) => {
  let hooks = 0;
  const trap = () => {
    hooks++;
    throw Error('trap');
  };
  for (const mutate of [
    (r) => ({ ...r, extra: { huge: 'x'.repeat(100_000) } }),
    (r) => Object.defineProperty(r, 'outputTokens', { get: trap }),
    (r) => new Proxy(r, { ownKeys: trap }),
    (r) => ({
      ...r,
      evidenceId: {
        get x() {
          return trap();
        },
      },
    }),
  ])
    await execute(t, async (_c, g) => {
      const f = producer({ finish: mutate });
      unknown(await requestReview(invocation, g, f.port, signal()));
      assert.equal(f.stats.verifies, 0);
    });
  assert.equal(hooks, 0);
});
test('stable copied bytes feed both digest and UTF8 decoder', async (t) => {
  await execute(t, async (_c, g) => {
    let reads = 0;
    const chunk = new Uint8Array([120]);
    Object.defineProperty(chunk, 'byteLength', {
      get() {
        throw Error('shadow');
      },
    });
    const f = producer({
      read: () =>
        ++reads === 1 ? { chunk, done: false } : { chunk: new Uint8Array(), done: true },
      finish: () => ({
        bodyDigest: digest('x'),
        totalBytes: 1,
        complete: true,
        outputTokens: 1,
        providerOutcome: 'completed',
        evidenceId: 'stable',
      }),
      verify: (r) => {
        chunk[0] = 121;
        return { kind: r.bodyDigest === digest('x') ? 'verified' : 'blocked', value: null };
      },
    });
    const r = await requestReview(invocation, g, f.port, signal());
    completed(r);
    assert.equal(r.value.resultBody, 'x');
  });
});
test('partial_stream_timeout_is_unknown; post_cancel_yields_never_read', async (t) => {
  await execute(t, async (_c, g) => {
    const ac = new AbortController();
    let reads = 0;
    const f = producer({
      read: () => {
        reads++;
        if (reads === 1) return { chunk: new Uint8Array([120]), done: false };
        ac.abort();
        return new Promise((resolve) =>
          setTimeout(() => resolve({ chunk: new Uint8Array([121]), done: false }), 5),
        );
      },
    });
    unknown(await requestReview(invocation, g, f.port, ac.signal));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.stats.reads, 2);
    assert.equal(f.stats.cancels, 1);
    assert.equal(f.stats.finishes, 0);
  });
});
test('unresponsive_proxy_open_aborted and late source cancelled without reads', async (t) => {
  await execute(t, async (_c, g) => {
    const ac = new AbortController();
    let release;
    const f = producer({
      open: () =>
        new Promise((r) => {
          release = r;
          ac.abort();
        }),
    });
    unknown(await requestReview(invocation, g, f.port, ac.signal));
    release({ kind: 'verified', value: f.source });
    await new Promise((r) => setImmediate(r));
    assert.equal(f.stats.reads, 0);
    assert.equal(f.stats.cancels, 1);
  });
});
test('unresponsive finish verify and cancel do not hold deadline', async (t) => {
  for (const phase of ['finish', 'verify'])
    await execute(t, async (_c, g) => {
      const ac = new AbortController(),
        hang = () => {
          ac.abort();
          return new Promise(() => {});
        };
      const f = producer(phase === 'finish' ? { finish: hang } : { verify: hang });
      f.source.cancel = () => {
        f.stats.cancels++;
        return new Promise(() => {});
      };
      unknown(await requestReview(invocation, g, f.port, ac.signal));
      assert.equal(f.stats.cancels, 1);
    });
});
test('aborted signal sends zero and does not consume permission', async (t) => {
  await execute(t, async (_c, g) => {
    const f = producer(),
      ac = new AbortController();
    ac.abort();
    assert.equal((await requestReview(invocation, g, f.port, ac.signal)).kind, 'blocked');
    assert.equal(f.stats.opens, 0);
    completed(await requestReview(invocation, g, f.port, signal()));
  });
});
test('open failure consumes guard without retry, redirect following or second send', async (t) => {
  for (const open of [
    () => {
      throw Error('lost response');
    },
    () => ({ kind: 'blocked', reason: 'redirect' }),
    () => ({ kind: 'verified', value: {} }),
  ])
    await execute(t, async (_c, g) => {
      const f = producer({ open });
      unknown(await requestReview(invocation, g, f.port, signal()));
      assert.equal((await requestReview(invocation, g, f.port, signal())).kind, 'blocked');
      assert.equal(f.stats.opens, 1);
    });
});
test('expired waiting open returns within caller deadline', async (t) => {
  await execute(t, async (_c, g) => {
    const ac = new AbortController(),
      start = performance.now();
    const timer = setTimeout(() => ac.abort(), 15);
    try {
      const f = producer({ open: () => new Promise(() => {}) });
      unknown(await requestReview(invocation, g, f.port, ac.signal));
      assert.ok(performance.now() - start < 1000);
      assert.equal(f.stats.opens, 1);
      assert.equal(f.stats.reads, 0);
    } finally {
      clearTimeout(timer);
    }
  });
});
test('zero measured usage is valid; assertion-only or changed retained evidence is unknown', async (t) => {
  await execute(t, async (_c, g) => {
    const f = producer({ tokens: 0 });
    const r = await requestReview(invocation, g, f.port, signal());
    completed(r);
    assert.equal(r.value.outputTokens, 0);
    assert.equal(r.value.resultBody, '');
  });
  for (const options of [
    { finish: (r) => ({ ...r, evidenceId: 'forged-evidence' }) },
    { verify: () => ({ kind: 'blocked' }) },
    { verify: () => ({ kind: 'verified', value: { asserted: true } }) },
  ])
    await execute(t, async (_c, g) => {
      const f = producer(options);
      unknown(await requestReview(invocation, g, f.port, signal()));
      assert.equal(f.stats.cancels, 1);
    });
});
test('invocation/source/port methods snapshot before awaits and transport receives only prescribed data', async (t) => {
  await execute(t, async (_c, g) => {
    const input = structuredClone(invocation),
      f = producer();
    const originalRead = f.source.read.bind(f.source);
    const originalOpen = f.port.open.bind(f.port);
    let reads = 0;
    f.source.read = async (args) => {
      reads++;
      f.source.read = () => {
        throw Error('changed read');
      };
      f.source.finish = () => {
        throw Error('changed finish');
      };
      return originalRead(args);
    };
    f.port.open = async (args) => {
      input.body = 'tampered';
      input.limits.maxOutputTokens = 1;
      f.port.verifyCompletion = () => {
        throw Error('changed verify');
      };
      return originalOpen(args);
    };
    const r = await requestReview(input, g, f.port, signal());
    completed(r);
    assert.equal(reads, 2);
    assert.equal(f.stats.request.maxOutputTokens, limits.maxOutputTokens);
    assert.equal(f.stats.request.body, body);
    assert.equal(f.stats.request.maxResponseBytes, 1_000_000);
    assert.equal(f.stats.request.maxChunkBytes, 16384);
  });
});
test('accessor invocation rejected before getters or send and actual envelope overhead is counted', async (t) => {
  await execute(t, async (_c, g) => {
    let gets = 0;
    const bad = { ...invocation };
    Object.defineProperty(bad, 'body', {
      get() {
        gets++;
        return body;
      },
    });
    const f = producer();
    assert.equal((await requestReview(bad, g, f.port, signal())).kind, 'blocked');
    assert.equal(gets, 0);
    assert.equal(f.stats.opens, 0);
    assert.equal(
      (
        await requestReview(
          { ...invocation, inputBytes: Buffer.byteLength(canonical(material)) },
          g,
          f.port,
          signal(),
        )
      ).kind,
      'blocked',
    );
    assert.equal(f.stats.opens, 0);
    completed(await requestReview(invocation, g, f.port, signal()));
  });
});
test('encoded envelope including escaped instructions over actual input ceiling sends zero', async (t) => {
  const envelope = { ...JSON.parse(body), instructions: '"'.repeat(limits.maxInputBytes) };
  const encoded = canonical(envelope);
  const oversized = {
    ...invocation,
    body: encoded,
    bodyDigest: digest(encoded),
    inputBytes: Buffer.byteLength(encoded),
  };
  assert.ok(oversized.inputBytes > limits.maxInputBytes);
  await execute(
    t,
    async (_c, g) => {
      const f = producer();
      assert.equal((await requestReview(oversized, g, f.port, signal())).kind, 'blocked');
      assert.equal(f.stats.opens, 0);
    },
    oversized,
  );
});
