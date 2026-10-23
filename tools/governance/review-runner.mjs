import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { types } from 'node:util';
import { blocked, verified, v2CandidateFields, boundedId, validCandidate } from './contracts.mjs';
import { digest, sameCandidate } from './journal.mjs';
import { sameExecution } from './worker-results.mjs';
import { buildReviewInvocation } from './review-material.mjs';
import { requestReview } from './review-proxy.mjs';

const limitsFields = [
  'callsPerAttempt',
  'maxOutputTokens',
  'maxInputBytes',
  'maxRunSeconds',
  'maxConcurrentCalls',
];
const runFields = [
  'id',
  'attempt',
  'repositoryId',
  'actorId',
  'workflowId',
  'sha',
  'executionSha',
  'ref',
  'event',
];
const ByteArray = Uint8Array,
  prototype = Object.getPrototypeOf(ByteArray.prototype);
const getter = (name) => Object.getOwnPropertyDescriptor(prototype, name).get;
const sizeOf = getter('byteLength'),
  bufferOf = getter('buffer'),
  offsetOf = getter('byteOffset'),
  copy = prototype.set;
const resizableOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get;
function record(value, fields) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Plain record required');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== 'string' || !fields.includes(k))
  )
    throw Error('Exact fields required');
  const out = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !Object.hasOwn(d, 'value')) throw Error('Data fields required');
    out[key] = d.value;
  }
  return out;
}
function scalarRecord(value, fields) {
  const out = record(value, fields);
  if (Object.values(out).some((v) => !['string', 'number', 'boolean'].includes(typeof v)))
    throw Error('Scalars required');
  return Object.freeze(out);
}
function bytes(raw, maxBytes, done) {
  if (!types.isUint8Array(raw) || types.isProxy(raw) || typeof done !== 'boolean')
    throw Error('Native bytes required');
  const size = Reflect.apply(sizeOf, raw, []);
  if (size > maxBytes || (done ? size !== 0 : size === 0))
    throw Error('Bounded pipe chunk required');
  const storage = Reflect.apply(bufferOf, raw, []),
    offset = Reflect.apply(offsetOf, raw, []);
  if (!types.isArrayBuffer(storage) || Reflect.apply(resizableOf, storage, []))
    throw Error('Fixed unshared storage required');
  const stable = new ByteArray(size);
  Reflect.apply(copy, stable, [new ByteArray(storage, offset, size)]);
  return stable;
}
function methods(raw, fields) {
  const out = record(raw, fields);
  for (const k of fields) {
    if (typeof out[k] !== 'function') throw Error('Captured methods required');
    out[k] = out[k].bind(raw);
  }
  return out;
}
function wait(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(Error('deadline'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    Promise.resolve()
      .then(() => {
        if (signal.aborted) throw Error('deadline');
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          signal.aborted ? reject(Error('deadline')) : resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
  });
}
function encodeFrame(type, body, bound) {
  // Count escaped JSON bytes before allocating the whole frame.
  let length = Buffer.byteLength(`{"type":"${type}","body":}`) + (body === null ? 4 : 2);
  if (body !== null) for (const c of body) length += Buffer.byteLength(JSON.stringify(c)) - 2;
  if (!Number.isSafeInteger(length) || length + 4 > bound || length > 0xffffffff)
    throw Error('Control frame ceiling');
  const frame = Buffer.alloc(length + 4);
  frame.writeUInt32BE(length);
  frame.write(JSON.stringify({ type, body }), 4);
  return frame;
}
/** Local synthetic supervisor. Runtime-owned deadline/guard never cross a pipe. */
export async function runBoundedReview(claimInput, invocationInput, guard, options) {
  let claim,
    invocation,
    runner,
    deadline,
    home,
    handle,
    proxyReport,
    group = null,
    failed = false,
    spawnAttempted = false,
    noChild = false;
  const report = () =>
    verified(
      Object.freeze({
        claimId: claim.id,
        candidate: claim.candidate,
        run: claim.run,
        invocationDigest: claim.invocationDigest,
        providerOutcome: failed ? 'unknown' : (proxyReport?.providerOutcome ?? 'not-sent'),
        executionEnded: !!group || noChild,
        resultBody: failed ? null : (proxyReport?.resultBody ?? null),
        outputTokens: failed ? null : (proxyReport?.outputTokens ?? null),
        evidenceId: failed ? null : (proxyReport?.evidenceId ?? null),
        groupEvidenceId: group?.evidenceId ?? null,
      }),
    );
  const check = () => {
    if (
      deadline.signal.aborted ||
      deadline.remainingMs() <= 0 ||
      runner.now() >= deadline.expiresAt
    )
      throw Error('Expired execution budget');
  };
  const groupProof = (raw) => {
    const r = record(raw, [
      'handleId',
      'parentExited',
      'descendantsExited',
      'pipesClosed',
      'evidenceId',
    ]);
    if (
      r.handleId !== handle.id ||
      r.parentExited !== true ||
      r.descendantsExited !== true ||
      r.pipesClosed !== true ||
      !boundedId(r.evidenceId)
    )
      throw Error('Full group and pipe evidence required');
    return Object.freeze(r);
  };
  try {
    const opts = record(options, ['runnerPort', 'proxyPort', 'localConfig', 'deadline']);
    runner = methods(opts.runnerPort, ['now', 'spawn', 'abortGroup', 'joinGroup', 'disposeHome']);
    const d = record(opts.deadline, ['signal', 'expiresAt', 'remainingMs', 'cancel']);
    if (
      !(d.signal instanceof AbortSignal) ||
      !Number.isFinite(d.expiresAt) ||
      typeof d.remainingMs !== 'function' ||
      typeof d.cancel !== 'function'
    )
      return blocked('Runtime-owned live deadline required');
    deadline = Object.freeze({
      ...d,
      remainingMs: d.remainingMs.bind(opts.deadline),
      cancel: d.cancel.bind(opts.deadline),
    });
    claim = record(claimInput, [
      'id',
      'reservationKey',
      'candidate',
      'requestId',
      'limits',
      'run',
      'materialDigest',
      'invocationDigest',
      'start',
    ]);
    claim.candidate = scalarRecord(claim.candidate, v2CandidateFields);
    claim.limits = scalarRecord(claim.limits, limitsFields);
    claim.run = scalarRecord(claim.run, runFields);
    const start = record(claim.start, ['state', 'claimId', 'run']);
    start.run = scalarRecord(start.run, runFields);
    if (
      start.state !== 'consumed' ||
      start.claimId !== claim.id ||
      !sameExecution(start.run, claim.run) ||
      !validCandidate(claim.candidate) ||
      claim.candidate.protocolVersion !== 2 ||
      !boundedId(claim.id) ||
      !boundedId(claim.reservationKey) ||
      !boundedId(claim.requestId) ||
      !sameExecution(claim.run, claim.run)
    )
      return blocked('Consumed immutable claim required');
    claim.start = Object.freeze(start);
    claim = Object.freeze(claim);
    invocation = record(invocationInput, [
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
    invocation.candidate = scalarRecord(invocation.candidate, v2CandidateFields);
    invocation.limits = scalarRecord(invocation.limits, limitsFields);
    if (
      !limitsFields.every(
        (k) =>
          Number.isSafeInteger(claim.limits[k]) &&
          claim.limits[k] > 0 &&
          claim.limits[k] === invocation.limits[k],
      ) ||
      !sameCandidate(claim.candidate, invocation.candidate) ||
      typeof invocation.body !== 'string' ||
      !Number.isSafeInteger(invocation.inputBytes) ||
      invocation.inputBytes < 0 ||
      invocation.inputBytes > claim.limits.maxInputBytes ||
      Buffer.byteLength(invocation.body) !== invocation.inputBytes ||
      digest(invocation.body) !== claim.invocationDigest ||
      invocation.bodyDigest !== claim.invocationDigest ||
      invocation.materialDigest !== claim.materialDigest
    )
      return blocked('Exact bounded invocation required');
    const frameBound = claim.limits.maxInputBytes + 1_000_000 + 65_536;
    if (!Number.isSafeInteger(frameBound)) return blocked('Control frame overflow');
    const config = record(opts.localConfig, [
      'executable',
      'childScript',
      'sourceDigest',
      'trustedInstructions',
      'env',
    ]);
    if (!config.env || types.isProxy(config.env)) throw Error('Allowlisted environment required');
    const envKeys = Reflect.ownKeys(config.env);
    if (envKeys.length > 3 || envKeys.some((key) => !['PATH', 'LANG', 'TZ'].includes(key)))
      return blocked('Allowlisted environment required');
    config.env = scalarRecord(config.env, envKeys);
    if (
      Object.keys(config.env).some(
        (k) =>
          !['PATH', 'LANG', 'TZ'].includes(k) ||
          typeof config.env[k] !== 'string' ||
          config.env[k].includes('\0') ||
          Buffer.byteLength(config.env[k]) > claim.limits.maxInputBytes,
      ) ||
      !['executable', 'childScript'].every(
        (k) =>
          typeof config[k] === 'string' &&
          isAbsolute(config[k]) &&
          !config[k].includes('\0') &&
          Buffer.byteLength(config[k]) <= claim.limits.maxInputBytes,
      ) ||
      typeof config.trustedInstructions !== 'string' ||
      !config.trustedInstructions.length ||
      config.trustedInstructions.includes('\0') ||
      Buffer.byteLength(config.trustedInstructions) > claim.limits.maxInputBytes ||
      typeof config.sourceDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.sourceDigest)
    )
      return blocked('Trusted configuration required');
    const envelope = JSON.parse(invocation.body);
    // Rebuild using the authoritative Unit 3 canonical material serializer shape.
    const canonical = (value) =>
      Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : value && typeof value === 'object'
          ? '{' +
            Object.keys(value)
              .sort()
              .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
              .join(',') +
            '}'
          : JSON.stringify(value);
    const body = canonical(envelope.material);
    const rebuilt = buildReviewInvocation(
      config,
      {
        candidate: claim.candidate,
        body,
        bodyDigest: digest(body),
        byteLength: Buffer.byteLength(body),
      },
      claim.limits,
    );
    if (rebuilt.kind !== 'verified' || rebuilt.value.body !== invocation.body)
      return blocked('Invocation must match trusted instructions');
    invocation = Object.freeze(invocation);
    const proxy = methods(opts.proxyPort, ['open', 'verifyCompletion']);
    check();
    const hasher = createHash('sha256');
    await wait(async () => {
      for await (const chunk of createReadStream(config.childScript, { highWaterMark: 16384 })) {
        check();
        hasher.update(chunk);
      }
    }, deadline.signal);
    if (hasher.digest('hex') !== config.sourceDigest) return blocked('Child source hash mismatch');
    check();
    home = mkdtempSync(join(tmpdir(), 'review-home-'));
    chmodSync(home, 0o700);
    home = realpathSync(home);
    check();
    spawnAttempted = true;
    // Spawn is synchronous by contract. No authority is issued by a child PID.
    const result = runner.spawn({
      executable: config.executable,
      childScript: config.childScript,
      sourceDigest: config.sourceDigest,
      env: Object.freeze({ ...config.env, HOME: home }),
      home,
      cwd: home,
    });
    if (result?.kind === 'blocked') {
      record(result, ['kind', 'reason']);
      noChild = true;
      return report();
    }
    record(result, ['kind', 'value']);
    if (result.kind !== 'verified') throw Error('Synchronous spawn result required');
    handle = result.value;
    const h = record(handle, ['id', 'writeFrame', 'readStdout', 'readStderr', 'closeInput']);
    for (const k of ['writeFrame', 'readStdout', 'readStderr', 'closeInput']) {
      if (typeof h[k] !== 'function') throw Error('Child methods required');
      h[k] = h[k].bind(handle);
    }
    handle = Object.freeze(h);
    const drain = async (read, stdout) => {
      let total = 0,
        retained = Buffer.alloc(0);
      while (true) {
        const frame = record(
          await wait(
            () => read({ maxBytes: Math.min(16384, 1_000_000 - total), signal: deadline.signal }),
            deadline.signal,
          ),
          ['chunk', 'done'],
        );
        const chunk = bytes(frame.chunk, Math.min(16384, 1_000_000 - total), frame.done);
        if (frame.done) break;
        total += chunk.byteLength;
        if (stdout) {
          if (total > 65536) throw Error('Diagnostic frame ceiling');
          retained = Buffer.concat([retained, chunk]);
        }
      }
      if (stdout) {
        if (retained.length < 4 || retained.readUInt32BE(0) !== retained.length - 4)
          throw Error('One diagnostic frame required');
        const row = record(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(retained.subarray(4))),
          ['type', 'ok'],
        );
        if (row.type !== 'diagnostic' || row.ok !== true) throw Error('Invalid child diagnostic');
      }
    };
    // Install rejection handlers immediately: flood/invalid diagnostics cancel upstream.
    const pipeTask = Promise.all([
      drain(handle.readStdout, true),
      drain(handle.readStderr, false),
    ]).catch((error) => {
      deadline.cancel('Invalid or overflowing child pipe');
      throw error;
    });
    pipeTask.catch(() => {});
    check();
    await wait(
      () =>
        handle.writeFrame(encodeFrame('invocation', invocation.body, frameBound), {
          signal: deadline.signal,
        }),
      deadline.signal,
    );
    check();
    const proxyResult = await requestReview(invocation, guard, proxy, deadline.signal);
    if (proxyResult.kind !== 'verified') throw Error('Guarded proxy denied');
    proxyReport = proxyResult.value;
    if (
      proxyReport.claimId !== claim.id ||
      !sameCandidate(proxyReport.candidate, claim.candidate) ||
      !sameExecution(proxyReport.run, claim.run) ||
      proxyReport.invocationDigest !== claim.invocationDigest
    )
      throw Error('Original proxy/claim binding required');
    check();
    await wait(
      () =>
        handle.writeFrame(encodeFrame('result', proxyReport.resultBody, frameBound), {
          signal: deadline.signal,
        }),
      deadline.signal,
    );
    await wait(() => handle.closeInput(), deadline.signal);
    await wait(() => pipeTask, deadline.signal);
    check();
    const joined = await wait(
      () => runner.joinGroup(handle, { signal: deadline.signal }),
      deadline.signal,
    );
    if (joined?.kind !== 'verified') throw Error('Termination evidence unavailable');
    group = groupProof(joined.value);
  } catch {
    failed = true;
    if (deadline) deadline.cancel('Supervisor stopped');
    if (!spawnAttempted) noChild = true;
  } finally {
    // One fixed cleanup window; never another provider budget or AbortController.
    const cleanupUntil = performance.now() + 1000;
    const cleanup = async (operation) => {
      const remaining = cleanupUntil - performance.now();
      if (remaining <= 0) throw Error('cleanup expired');
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('cleanup expired')), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (handle && !group && runner) {
      try {
        await cleanup(() => runner.abortGroup(handle));
        try {
          Promise.resolve(handle.closeInput()).catch(() => {});
        } catch {
          /* Teardown remains owned by runner. */
        }
        const joined = await cleanup(() => runner.joinGroup(handle, {}));
        if (joined?.kind === 'verified') group = groupProof(joined.value);
      } catch {
        /* Unknown execution retains an explicit runner teardown obligation. */
      }
    }
    if (home && runner && (group || noChild || !spawnAttempted))
      try {
        await cleanup(() => runner.disposeHome(home));
      } catch {
        /* Fixture teardown retains home obligation. */
      }
  }
  return claim ? report() : blocked('Invalid supervisor inputs');
}
