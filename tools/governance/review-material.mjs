import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { types } from 'node:util';
import { v2CandidateFields } from './contracts.mjs';
import { blocked, verified, exactFields, boundedId, validCandidate } from './contracts.mjs';
import { digest, sameCandidate } from './journal.mjs';

// Capture native typed-array accessors once. Public producer properties are not
// trustworthy length/offset/storage evidence, even on a genuine Uint8Array.
const ByteArray = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(ByteArray.prototype);
const intrinsic = (name) => Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get;
const byteLengthOf = intrinsic('byteLength'),
  bufferOf = intrinsic('buffer'),
  offsetOf = intrinsic('byteOffset');
const resizableOf = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable').get;
const copyBytes = typedArrayPrototype.set;
function dataRecord(value, fields) {
  // Proxy rejection precedes reflection; descriptor reads never invoke accessors.
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error('Plain data record required');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== 'string' || !fields.includes(k))
  )
    throw Error('Exact data record required');
  const out = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw Error('Data properties required');
    out[key] = descriptor.value;
  }
  return out;
}
function stableChunk(chunk, maxBytes, done) {
  if (!types.isUint8Array(chunk) || types.isProxy(chunk) || typeof done !== 'boolean')
    throw Error('Native byte view required');
  const size = Reflect.apply(byteLengthOf, chunk, []);
  if (size > maxBytes || (done ? size !== 0 : size === 0)) throw Error('Bounded frame required');
  const buffer = Reflect.apply(bufferOf, chunk, []),
    offset = Reflect.apply(offsetOf, chunk, []);
  if (!types.isArrayBuffer(buffer) || Reflect.apply(resizableOf, buffer, []))
    throw Error('Fixed unshared storage required');
  // No producer code executes between intrinsic size validation and this bounded
  // copy. Only this private stable copy reaches both the hash and the decoder.
  const stable = new ByteArray(size);
  Reflect.apply(copyBytes, stable, [new ByteArray(buffer, offset, size)]);
  return stable;
}
function boundedCompletion(raw, candidate, bodyDigest, totalBytes) {
  const row = dataRecord(raw, ['candidate', 'bodyDigest', 'totalBytes', 'complete', 'evidenceId']);
  const c = dataRecord(row.candidate, v2CandidateFields);
  if (
    !sameCandidate(c, candidate) ||
    row.bodyDigest !== bodyDigest ||
    row.totalBytes !== totalBytes ||
    row.complete !== true ||
    !boundedId(row.evidenceId)
  )
    throw Error('Exact bounded completion required');
  // Retain only validated bounded scalar fields; never clone a producer graph.
  return freeze({ candidate, bodyDigest, totalBytes, complete: true, evidenceId: row.evidenceId });
}
const limitFields = [
  'callsPerAttempt',
  'maxOutputTokens',
  'maxInputBytes',
  'maxRunSeconds',
  'maxConcurrentCalls',
];
const validLimits = (l) =>
  exactFields(l, limitFields) && limitFields.every((k) => Number.isSafeInteger(l[k]) && l[k] > 0);
const validV2 = (c) => validCandidate(c) && c.protocolVersion === 2;
const hash = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const snapshot = (value) => freeze(structuredClone(value));
const uncertain = () => ({
  kind: 'uncertain',
  reason: 'Material pull aborted, timed out or unavailable',
  evidence: [],
});
function parseMaterial(body, candidate) {
  const parsed = JSON.parse(body);
  if (
    !exactFields(parsed, ['base', 'head', 'files']) ||
    parsed.base !== candidate.base ||
    parsed.head !== candidate.head ||
    !Array.isArray(parsed.files) ||
    canonical(parsed) !== body
  )
    throw Error('Canonical exact material required');
  const paths = new Set();
  for (const file of parsed.files) {
    if (
      !exactFields(file, ['path', 'change', 'content']) ||
      typeof file.path !== 'string' ||
      !file.path.length ||
      /[\x00-\x1f\x7f\\]/.test(file.path) ||
      file.path.startsWith('/') ||
      /^[a-z]:/i.test(file.path) ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..') ||
      !boundedId(file.change) ||
      typeof file.content !== 'string'
    )
      throw Error('Inert unambiguous files required');
    const identity = file.path.normalize('NFC').toLowerCase();
    if (paths.has(identity)) throw Error('Duplicate or ambiguous material path');
    paths.add(identity);
  }
  return parsed;
}
/** Synthetic data-only pull protocol. No filesystem, checkout or provider access. */
export async function extractReviewMaterial(candidate, materialTransport, limits, signal) {
  let source,
    cancel,
    cancelled = false,
    timer;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const stop = () => {
    if (cancel && !cancelled) {
      cancelled = true;
      // Cancellation is best effort: do not wait for an unresponsive producer.
      try {
        Promise.resolve(cancel('Material consumer stopped')).catch(() => {});
      } catch {
        /* No retry. */
      }
    }
  };
  // Defer invocation until the abort listener is installed; synchronous abort inside
  // a provider must also win against a provider promise that never resolves.
  const wait = (operation) =>
    new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(Error('aborted'));
      };
      const cleanup = () => controller.signal.removeEventListener('abort', abort);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) return abort();
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw Error('aborted');
          return operation();
        })
        .then(
          (value) => {
            cleanup();
            if (controller.signal.aborted) reject(Error('aborted'));
            else resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
  try {
    if (
      !validV2(candidate) ||
      !validLimits(limits) ||
      !signal ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function' ||
      typeof signal.aborted !== 'boolean'
    )
      return blocked('Exact v2 candidate, limits and abort signal required');
    const c = snapshot(candidate),
      l = snapshot(limits);
    const open = materialTransport?.open?.bind(materialTransport),
      verify = materialTransport?.verifyCompletion?.bind(materialTransport);
    if (!open || !verify) return blocked('Captured material transport required');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) controller.abort();
    // Conservative timer clamp avoids overflowing the host timer API.
    timer = setTimeout(() => controller.abort(), Math.min(l.maxRunSeconds * 1000, 2147483647));
    if (controller.signal.aborted) return uncertain();
    let read, finish;
    const opened = await wait(async () => {
      const result = await open({
        candidate: c,
        maxBytes: l.maxInputBytes,
        maxChunkBytes: 16384,
        signal: controller.signal,
      });
      if (result?.kind === 'verified') {
        source = result.value;
        read = source?.read?.bind(source);
        finish = source?.finish?.bind(source);
        cancel = source?.cancel?.bind(source);
        // A late open still owns a source that must be cancelled, without reads.
        if (controller.signal.aborted) stop();
      }
      return result;
    });
    if (opened?.kind !== 'verified') return blocked('Material source unavailable');
    if (!read || !finish || !cancel) {
      stop();
      return blocked('Pull source required');
    }
    let totalBytes = 0,
      body = '';
    const hasher = createHash('sha256'),
      decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    while (true) {
      const maxBytes = Math.min(16384, l.maxInputBytes - totalBytes);
      const frame = dataRecord(await wait(() => read({ maxBytes, signal: controller.signal })), [
        'chunk',
        'done',
      ]);
      const chunk = stableChunk(frame.chunk, maxBytes, frame.done);
      if (frame.done) break;
      // Count validated private bytes before retaining decoded material text.
      totalBytes += chunk.byteLength;
      hasher.update(chunk);
      body += decoder.decode(chunk, { stream: true });
    }
    body += decoder.decode();
    const bodyDigest = hasher.digest('hex');
    const completion = boundedCompletion(
      await wait(() => finish({ signal: controller.signal })),
      c,
      bodyDigest,
      totalBytes,
    );
    const proof = await wait(() =>
      verify(completion, { candidate: c, bodyDigest, totalBytes, signal: controller.signal }),
    );
    if (proof?.kind !== 'verified' || proof.value !== null) {
      stop();
      return blocked('Independent material completion evidence required');
    }
    parseMaterial(body, c);
    return verified(snapshot({ candidate: c, body, bodyDigest, byteLength: totalBytes }));
  } catch {
    stop();
    return controller.signal.aborted ? uncertain() : blocked('Invalid or incomplete material');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
/** Build the prescribed canonical fake envelope, counting every UTF-8 input byte. */
export function buildReviewInvocation(localConfig, material, limits) {
  try {
    if (
      !validLimits(limits) ||
      !exactFields(localConfig, [
        'executable',
        'childScript',
        'sourceDigest',
        'trustedInstructions',
        'env',
      ]) ||
      !exactFields(material, ['candidate', 'body', 'bodyDigest', 'byteLength']) ||
      !validV2(material.candidate) ||
      typeof material.body !== 'string' ||
      !hash(material.bodyDigest) ||
      !Number.isSafeInteger(material.byteLength) ||
      material.byteLength < 0 ||
      material.byteLength > limits.maxInputBytes ||
      Buffer.byteLength(material.body) !== material.byteLength ||
      digest(material.body) !== material.bodyDigest
    )
      return blocked('Exact bounded material and configuration required');
    const l = snapshot(limits),
      m = snapshot(material),
      config = snapshot(localConfig);
    const boundedString = (s) =>
      typeof s === 'string' &&
      s.length > 0 &&
      Buffer.byteLength(s) <= l.maxInputBytes &&
      !s.includes('\0');
    if (
      !['executable', 'childScript'].every(
        (k) => boundedString(config[k]) && isAbsolute(config[k]),
      ) ||
      !hash(config.sourceDigest) ||
      !boundedString(config.trustedInstructions) ||
      !config.env ||
      typeof config.env !== 'object' ||
      Array.isArray(config.env) ||
      Object.keys(config.env).some(
        (k) =>
          !['PATH', 'LANG', 'TZ'].includes(k) ||
          typeof config.env[k] !== 'string' ||
          Buffer.byteLength(config.env[k]) > l.maxInputBytes ||
          config.env[k].includes('\0'),
      )
    )
      return blocked('Trusted absolute local configuration required');
    const parsed = parseMaterial(m.body, m.candidate);
    const envelope = {
      version: 1,
      model: 'gpt-6-astra',
      effort: 'high',
      fresh: true,
      tools: [],
      maxOutputTokens: l.maxOutputTokens,
      instructions: config.trustedInstructions,
      material: parsed,
    };
    // Compute size without constructing a whole oversized envelope string.
    const overhead = canonical({ ...envelope, instructions: null, material: null });
    let instructionBytes = 2; // JSON string quotes; each temporary is at most one code point.
    for (const character of config.trustedInstructions)
      instructionBytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    const inputBytes = Buffer.byteLength(overhead) - 8 + instructionBytes + m.byteLength;
    if (!Number.isSafeInteger(inputBytes) || inputBytes > l.maxInputBytes)
      return blocked('Whole invocation input byte ceiling exceeded');
    const body = canonical(envelope);
    return verified(
      snapshot({
        candidate: m.candidate,
        materialDigest: m.bodyDigest,
        body,
        bodyDigest: digest(body),
        inputBytes,
        model: envelope.model,
        effort: envelope.effort,
        fresh: true,
        limits: l,
      }),
    );
  } catch {
    return blocked('Invalid material invocation');
  }
}
