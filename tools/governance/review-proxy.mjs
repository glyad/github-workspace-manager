import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { blocked, verified, boundedId, v2CandidateFields } from './contracts.mjs';
import { consumeReviewGuard } from './worker-ledger.mjs';

const ByteArray = Uint8Array;
const arrayPrototype = Object.getPrototypeOf(ByteArray.prototype);
const accessor = (name) => Object.getOwnPropertyDescriptor(arrayPrototype, name).get;
const byteLengthOf = accessor('byteLength'),
  bufferOf = accessor('buffer'),
  offsetOf = accessor('byteOffset');
const resizableOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get;
const copyBytes = arrayPrototype.set;
const limitFields = [
  'callsPerAttempt',
  'maxOutputTokens',
  'maxInputBytes',
  'maxRunSeconds',
  'maxConcurrentCalls',
];
function dataRecord(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Plain data required');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== 'string' || !fields.includes(k))
  )
    throw Error('Exact fields required');
  const out = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value')) throw Error('Data properties required');
    out[key] = d.value;
  }
  return out;
}
function stableChunk(chunk, maxBytes, done) {
  if (!types.isUint8Array(chunk) || types.isProxy(chunk) || typeof done !== 'boolean')
    throw Error('Native bytes required');
  const size = Reflect.apply(byteLengthOf, chunk, []);
  if (size > maxBytes || (done ? size !== 0 : size === 0)) throw Error('Bounded frame required');
  const buffer = Reflect.apply(bufferOf, chunk, []),
    offset = Reflect.apply(offsetOf, chunk, []);
  if (!types.isArrayBuffer(buffer) || Reflect.apply(resizableOf, buffer, []))
    throw Error('Fixed unshared storage required');
  const stable = new ByteArray(size);
  Reflect.apply(copyBytes, stable, [new ByteArray(buffer, offset, size)]);
  return stable;
}
function completion(raw, bodyDigest, totalBytes, maxOutputTokens) {
  const row = dataRecord(raw, [
    'bodyDigest',
    'totalBytes',
    'complete',
    'outputTokens',
    'providerOutcome',
    'evidenceId',
  ]);
  if (
    row.bodyDigest !== bodyDigest ||
    row.totalBytes !== totalBytes ||
    row.complete !== true ||
    row.providerOutcome !== 'completed' ||
    !Number.isSafeInteger(row.outputTokens) ||
    row.outputTokens < 0 ||
    row.outputTokens > maxOutputTokens ||
    !boundedId(row.evidenceId)
  )
    throw Error('Exact bounded measured completion required');
  return Object.freeze({
    bodyDigest,
    totalBytes,
    complete: true,
    outputTokens: row.outputTokens,
    providerOutcome: 'completed',
    evidenceId: row.evidenceId,
  });
}
/** Trusted-parent, synthetic transport only. One live guard permits one open. */
export async function requestReview(input, guard, proxyPort, signal) {
  let binding,
    cancel,
    cancelled = false,
    listening = false;
  const stop = () => {
    if (cancel && !cancelled) {
      cancelled = true;
      try {
        Promise.resolve(cancel('Proxy consumer stopped')).catch(() => {});
      } catch {
        /* Cancellation never retries. */
      }
    }
  };
  const wait = (operation) =>
    new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        cleanup();
        reject(Error('aborted'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw Error('aborted');
          return operation();
        })
        .then(
          (value) => {
            cleanup();
            if (signal.aborted) reject(Error('aborted'));
            else resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
  const report = (
    providerOutcome = 'unknown',
    resultBody = null,
    outputTokens = null,
    evidenceId = null,
  ) =>
    verified(
      Object.freeze({
        claimId: binding.claimId,
        candidate: binding.candidate,
        run: binding.run,
        invocationDigest: binding.invocationDigest,
        providerOutcome,
        executionEnded: false,
        resultBody,
        outputTokens,
        evidenceId,
      }),
    );
  try {
    if (!(signal instanceof AbortSignal) || signal.aborted)
      return blocked('Live abort signal required');
    // Snapshot only exact data fields before consuming permission or awaiting I/O.
    const invocation = dataRecord(input, [
      'candidate',
      'materialDigest',
      'body',
      'bodyDigest',
      'inputBytes',
      'model',
      'effort',
      'fresh',
      'limits',
    ]);
    invocation.candidate = Object.freeze(dataRecord(invocation.candidate, v2CandidateFields));
    invocation.limits = Object.freeze(dataRecord(invocation.limits, limitFields));
    if (
      Object.values(invocation.candidate).some(
        (v) => typeof v !== 'string' && typeof v !== 'number',
      ) ||
      Object.values(invocation.limits).some((v) => !Number.isSafeInteger(v) || v <= 0)
    )
      return blocked('Scalar candidate and positive limits required');
    // Guard validates the full canonical envelope, input bytes, digests and claim.
    const open = proxyPort?.open?.bind(proxyPort),
      verify = proxyPort?.verifyCompletion?.bind(proxyPort);
    if (!open || !verify) return blocked('Captured proxy transport required');
    signal.addEventListener('abort', stop, { once: true });
    listening = true;
    if (signal.aborted) return blocked('Live abort signal required');
    const permission = consumeReviewGuard(guard, Object.freeze(invocation));
    if (permission.kind !== 'verified') return permission;
    binding = permission.value;
    let read, finish;
    const opened = await wait(async () => {
      const result = await open({
        body: invocation.body,
        maxOutputTokens: binding.limits.maxOutputTokens,
        maxResponseBytes: 1_000_000,
        maxChunkBytes: 16384,
        signal,
      });
      if (result?.kind === 'verified') {
        const source = result.value;
        // Capture cancellation first so a late-open source has no read permission.
        cancel = source?.cancel?.bind(source);
        if (signal.aborted) {
          stop();
          return result;
        }
        read = source?.read?.bind(source);
        finish = source?.finish?.bind(source);
      }
      return result;
    });
    if (opened?.kind !== 'verified' || !read || !finish || !cancel)
      throw Error('Pull source required');
    let totalBytes = 0,
      body = '';
    const hasher = createHash('sha256'),
      decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    while (true) {
      const maxBytes = Math.min(16384, 1_000_000 - totalBytes);
      const frame = dataRecord(await wait(() => read({ maxBytes, signal })), ['chunk', 'done']);
      const chunk = stableChunk(frame.chunk, maxBytes, frame.done);
      if (frame.done) break;
      totalBytes += chunk.byteLength;
      hasher.update(chunk);
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    const bodyDigest = hasher.digest('hex');
    const row = completion(
      await wait(() => finish({ signal })),
      bodyDigest,
      totalBytes,
      binding.limits.maxOutputTokens,
    );
    const proof = await wait(() =>
      verify(
        row,
        Object.freeze({ bodyDigest, totalBytes, maxOutputTokens: binding.limits.maxOutputTokens }),
      ),
    );
    if (proof?.kind !== 'verified' || proof.value !== null)
      throw Error('Independent measured completion required');
    return report('completed', body, row.outputTokens, row.evidenceId);
  } catch {
    stop();
    return binding ? report() : blocked('Invalid proxy invocation');
  } finally {
    if (listening) signal.removeEventListener('abort', stop);
  }
}
