import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ciClaimId } from './worker-dispatch.mjs';
import { validDispatchClaim } from './worker-transport.mjs';
import { sameExecution } from './worker-results.mjs';
import { digest } from './journal.mjs';
import { verified, requestId as validId, validReadinessRequest } from './contracts.mjs';
import { randomUUID } from 'node:crypto';
import {
  validOperationTransition,
  validResolution,
  validReadinessOperation,
} from './readiness-operation.mjs';
const operationOwners = new Map();
/** Local filesystem TEST backend only. No cross-runner/backend selection.
 * Locks have no lease: a crashed holder requires explicit operator recovery.
 * A partial write/corrupt log denies reads; nothing is truncated or refunded.
 */
export class LocalDurableStore {
  constructor(root, { fault = async () => {} } = {}) {
    this.root = root;
    this.fault = fault;
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async syncDirectory() {
    const d = await fs.open(this.root, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
  async withPrLock(key, fn) {
    await this.init();
    const path = join(this.root, `${digest(key)}.lock`);
    await fs.mkdir(path, { mode: 0o700 });
    // Unknown outcomes retain the lock, including outage before WAL append.
    // Explicit reconciliation is required; no timeout reclaim is implemented.
    await this.syncDirectory();
    const result = await fn();
    // The controller returns uncertainty instead of throwing. It still requires
    // retained ownership, even if storage failed before the first WAL record.
    if (result?.kind === 'uncertain') return result;
    await fs.rmdir(path);
    await this.syncDirectory();
    return result;
  }
  async read(key) {
    await this.init();
    let body;
    try {
      body = await fs.readFile(join(this.root, `${digest(key)}.jsonl`), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    if (Buffer.byteLength(body) > 8_000_000 || !body.endsWith('\n'))
      throw Error('Uncertain durable log');
    let previous = '';
    return body
      .trimEnd()
      .split('\n')
      .map((line) => {
        const row = JSON.parse(line);
        if (
          row.previous !== previous ||
          row.hash !== digest(JSON.stringify([row.previous, row.value]))
        )
          throw Error('Corrupt durable log');
        previous = row.hash;
        return row.value;
      });
  }
  // Caller holds the corresponding lock. Every append is durable before returning.
  async append(key, value) {
    const values = await this.read(key);
    let previous = '';
    for (const v of values) previous = digest(JSON.stringify([previous, v]));
    const row = { previous, value, hash: digest(JSON.stringify([previous, value])) };
    const f = await fs.open(join(this.root, `${digest(key)}.jsonl`), 'a', 0o600);
    try {
      await f.writeFile(JSON.stringify(row) + '\n');
      await f.sync();
    } finally {
      await f.close();
    }
    await this.syncDirectory();
    await this.fault('after-fsync', value);
  }
  async pending(key) {
    const rows = await this.read(key);
    return rows.filter(
      (r) => r.type === 'pending' && !rows.some((s) => s.type === 'resolved' && s.id === r.id),
    );
  }
  // Local TEST evidence: independent append membership precedes each log write.
  // Missing rows/tails retain the slot as uncertainty; no repair or retry exists.
  async readCiClaim(claimId) {
    try {
      if (!validId(claimId)) throw Error('Claim identity');
      const key = `ci-claim:${claimId}`;
      const rows = await this.read(key);
      let members = [];
      try {
        members = await fs.readdir(join(this.root, `${digest(key)}.ci-members`));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const expected = rows.map((r, i) => `${i}-${digest(JSON.stringify(r))}`).sort();
      if (JSON.stringify(expected) !== JSON.stringify(members.sort()))
        throw Error('Missing CI history');
      for (let i = 0; i < rows.length; i++) {
        if (
          !validDispatchClaim(rows[i]) ||
          rows[i].id !== ciClaimId(rows[i].candidate) ||
          rows[i].id !== claimId ||
          !this.validCiTransition(rows[i - 1], rows[i])
        )
          throw Error('CI history binding');
      }
      await this.fault('ci-readback', rows.at(-1));
      return verified(rows.at(-1) ?? null);
    } catch {
      return { kind: 'uncertain', reason: 'Local CI claim unavailable', evidence: [] };
    }
  }
  validCiTransition(previous, next) {
    if (!previous) return next.status === 'pending' && next.run === null && next.start === null;
    const fixed = (c) =>
      JSON.stringify([c.id, c.candidate, c.worker, c.requestId, c.definitionSha]);
    if (fixed(previous) !== fixed(next) || previous.status === 'quarantined') return false;
    if (previous.run && !sameExecution(previous.run, next.run)) return false;
    if (previous.start && JSON.stringify(previous.start) !== JSON.stringify(next.start))
      return false;
    if (previous.status === 'observed' && next.status === 'pending') return false;
    return true;
  }
  async appendCiClaim(input) {
    try {
      const record = structuredClone(input);
      if (!validDispatchClaim(record) || record.id !== ciClaimId(record.candidate))
        throw Error('CI record');
      const previous = await this.readCiClaim(record.id);
      if (previous.kind !== 'verified') return previous;
      if (!this.validCiTransition(previous.value, record)) throw Error('CI transition');
      const key = `ci-claim:${record.id}`;
      const rows = await this.read(key);
      const membership = join(this.root, `${digest(key)}.ci-members`);
      await fs.mkdir(membership, { recursive: true, mode: 0o700 });
      const witness = await fs.open(
        join(membership, `${rows.length}-${digest(JSON.stringify(record))}`),
        'wx',
        0o600,
      );
      await witness.sync();
      await witness.close();
      const directory = await fs.open(membership, 'r');
      await directory.sync();
      await directory.close();
      await this.syncDirectory();
      await this.fault('ci-before-append', record);
      await this.append(key, record);
      const read = await this.readCiClaim(record.id);
      if (read.kind !== 'verified' || JSON.stringify(read.value) !== JSON.stringify(record))
        throw Error('CI append readback');
      return read;
    } catch {
      return { kind: 'uncertain', reason: 'Local CI append unavailable', evidence: [] };
    }
  }
  async appendCiStart(claimId, input) {
    const start = structuredClone(input);
    const read = await this.readCiClaim(claimId);
    if (read.kind !== 'verified' || !read.value)
      return read.kind === 'verified'
        ? { kind: 'blocked', reason: 'Missing claim', evidence: [] }
        : read;
    if (read.value.start !== null)
      return { kind: 'blocked', reason: 'CI start already consumed', evidence: [] };
    return this.appendCiClaim({ ...read.value, start: structuredClone(start) });
  }
  // Operation-only append membership witnesses catch removed tails. These files
  // are local test evidence, not signatures or cross-runner durability proof.
  async readOperationHistory(requestId) {
    try {
      if (!validId(requestId)) throw Error('Invalid request ID');
      await this.fault('operation-before-read');
      const key = `readiness-operation:${requestId}`;
      const rows = await this.read(key);
      let binding = null;
      try {
        binding = JSON.parse(
          await fs.readFile(join(this.root, `${digest(key)}.operation-binding`), 'utf8'),
        );
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (
        (rows.length === 0 && binding !== null) ||
        (rows.length > 0 && JSON.stringify(binding) !== JSON.stringify(rows[0].request))
      )
        throw Error('Missing operation binding/history');
      let members = [];
      try {
        members = await fs.readdir(join(this.root, `${digest(key)}.members`));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const expected = rows.map((row, i) => `${i}-${digest(JSON.stringify(row))}`).sort();
      if (JSON.stringify(expected) !== JSON.stringify(members.sort()))
        throw Error('Missing durable member');
      for (let i = 0; i < rows.length; i++) {
        if (!validOperationTransition(rows[i - 1], rows[i]))
          throw Error('Invalid operation history');
      }
      return verified(rows);
    } catch {
      return { kind: 'uncertain', reason: 'Local operation history unavailable', evidence: [] };
    }
  }
  async readOperation(requestId) {
    const result = await this.readOperationHistory(requestId);
    if (result.kind !== 'verified') return result;
    return verified(result.value.at(-1) ?? null);
  }
  async appendOperation(input) {
    try {
      if (!validReadinessOperation(input)) throw Error('Invalid operation record');
      const record = structuredClone(input);
      if (!validReadinessRequest(record?.request)) throw Error('Invalid operation request');
      await this.init();
      const requestId = record.request.requestId;
      const key = `readiness-operation:${requestId}`;
      const previous = await this.readOperationHistory(requestId);
      if (previous.kind !== 'verified') return previous;
      if (!validOperationTransition(previous.value.at(-1), record))
        throw Error('Invalid operation transition');
      if (
        previous.value.length &&
        JSON.stringify(previous.value[0].request) !== JSON.stringify(record.request)
      )
        throw Error('Immutable operation request');
      if (previous.value.length === 0) {
        const binding = await fs.open(
          join(this.root, `${digest(key)}.operation-binding`),
          'wx',
          0o600,
        );
        try {
          await binding.writeFile(JSON.stringify(record.request));
          await binding.sync();
        } finally {
          await binding.close();
        }
        await this.syncDirectory();
      }
      // Index intent before its log; a missing operation referenced here denies
      // recovery rather than treating an interrupted append as a new request.
      const index = join(
        this.root,
        `${digest(`${record.request.repositoryId}:${record.request.pr}`)}.operations`,
      );
      await fs.mkdir(index, { recursive: true, mode: 0o700 });
      const marker = await fs.open(join(index, requestId), 'a', 0o600);
      await marker.sync();
      await marker.close();
      let directory = await fs.open(index, 'r');
      await directory.sync();
      await directory.close();
      const membership = join(this.root, `${digest(key)}.members`);
      await fs.mkdir(membership, { recursive: true, mode: 0o700 });
      const witness = await fs.open(
        join(membership, `${previous.value.length}-${digest(JSON.stringify(record))}`),
        'wx',
        0o600,
      );
      await witness.sync();
      await witness.close();
      directory = await fs.open(membership, 'r');
      await directory.sync();
      await directory.close();
      await this.syncDirectory();
      await this.fault('operation-before-append', record);
      await this.append(key, record);
      return verified(record);
    } catch {
      return { kind: 'uncertain', reason: 'Local operation append unavailable', evidence: [] };
    }
  }
  async readObligations(key) {
    try {
      await this.init();
      let ids = [];
      try {
        ids = await fs.readdir(join(this.root, `${digest(key)}.operations`));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const bound = [];
      for (const name of await fs.readdir(this.root)) {
        if (!name.endsWith('.operation-binding')) continue;
        const request = JSON.parse(await fs.readFile(join(this.root, name), 'utf8'));
        if (!validReadinessRequest(request)) throw Error('Malformed binding');
        if (`${request.repositoryId}:${request.pr}` === key) bound.push(request.requestId);
      }
      if (JSON.stringify(bound.sort()) !== JSON.stringify(ids.sort()))
        throw Error('Removed operation index');
      const obligations = [];
      for (const id of ids) {
        const read = await this.readOperation(id);
        if (read.kind !== 'verified' || !read.value) throw Error('Incomplete operation');
        if (`${read.value.request.repositoryId}:${read.value.request.pr}` !== key)
          throw Error('Wrong PR');
        if (read.value.state !== 'reconciled') obligations.push(read.value);
      }
      return verified(obligations);
    } catch {
      return { kind: 'uncertain', reason: 'Local obligations unavailable', evidence: [] };
    }
  }

  async registerOperationOwner(request) {
    const key = `${request.repositoryId}:${request.pr}`;
    const stat = await fs.stat(join(this.root, `${digest(key)}.lock`));
    const owner = {
      requestId: request.requestId,
      pid: process.pid,
      token: randomUUID(),
      dev: stat.dev,
      ino: stat.ino,
      birthtimeMs: stat.birthtimeMs,
    };
    const file = await fs.open(join(this.root, `${digest(key)}.operation-owner`), 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
    } finally {
      await file.close();
    }
    await this.syncDirectory();
    operationOwners.set(`${this.root}:${key}`, { ...owner, active: true });
  }
  finishOperationOwner(request) {
    const entry = operationOwners.get(`${this.root}:${request.repositoryId}:${request.pr}`);
    if (entry) entry.active = false;
  }
  // Local TEST backend recovery only. A proof of the original outcome and Draft
  // reconciliation must precede takeover. No timeout or arbitrary unlock exists.
  // A live/unknown process is denied; same-process recovery requires a module-owned
  // record proving the callback ended. Pid reuse denies safely. Production needs
  // its own authenticated ownership/fencing backend, which remains unselected.
  async withOperationReconciliationLock(request, evidence, fn) {
    const key = `${request.repositoryId}:${request.pr}`;
    const read = await this.readOperation(request.requestId);
    if (read.kind !== 'verified' || !read.value)
      return { kind: 'uncertain', reason: 'Missing original operation', evidence: [] };
    const auth = await this.authenticateOperationEvidence?.(evidence, read.value, 'reconciled');
    if (!validResolution(auth, read.value))
      return { kind: 'blocked', reason: 'Resolution unauthenticated', evidence: [] };
    const path = join(this.root, `${digest(key)}.lock`);
    let stat;
    try {
      stat = await fs.stat(path);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const reconcileOwned = async () => {
      await this.registerOperationOwner(request);
      try {
        return await fn();
      } finally {
        this.finishOperationOwner(request);
      }
    };
    if (!stat) return this.withPrLock(key, reconcileOwned);
    // Serializes explicit recovery attempts; never used as a replacement PR lock.
    const recovery = join(this.root, `${digest(key)}.operation-recovery`);
    await fs.mkdir(recovery, { mode: 0o700 });
    try {
      const owner = JSON.parse(
        await fs.readFile(join(this.root, `${digest(key)}.operation-owner`), 'utf8'),
      );
      if (
        owner.requestId !== request.requestId ||
        owner.dev !== stat.dev ||
        owner.ino !== stat.ino ||
        owner.birthtimeMs !== stat.birthtimeMs ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1
      )
        throw Error('Unproven lock owner');
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') dead = true;
        else throw e;
      }
      const local = operationOwners.get(`${this.root}:${key}`);
      if (
        !dead &&
        !(owner.pid === process.pid && local?.token === owner.token && local.active === false)
      )
        return { kind: 'blocked', reason: 'Prior operation holder may still mutate', evidence: [] };
      // Recheck evidence after ownership/liveness checks and before any takeover.
      const latest = await this.readOperation(request.requestId);
      if (latest.kind !== 'verified' || JSON.stringify(latest.value) !== JSON.stringify(read.value))
        throw Error('Changed recovery history');
      const now = await fs.stat(path);
      if (now.dev !== stat.dev || now.ino !== stat.ino || now.birthtimeMs !== stat.birthtimeMs)
        throw Error('Changed lock owner');
      await fs.rmdir(path);
      await this.syncDirectory();
      return await this.withPrLock(key, reconcileOwned);
    } finally {
      await fs.rmdir(recovery);
      await this.syncDirectory();
    }
  }
}
