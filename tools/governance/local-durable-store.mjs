import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ciClaimId } from './worker-dispatch.mjs';
import { validDispatchClaim } from './worker-transport.mjs';
import { sameExecution } from './worker-results.mjs';
import { digest } from './journal.mjs';
import { verified, boundedId, requestId as validId, validReadinessRequest } from './contracts.mjs';
import {
  snapshotProjectData,
  validateProjectBinding,
  validateProjectRecords,
  validateProjectResolution,
  validateProjectRecoveryResponse,
  projectResultValue,
} from './project-reconciliation.mjs';
import { projectDigest } from './project-baseline.mjs';
import { randomUUID } from 'node:crypto';
import {
  validOperationTransition,
  validResolution,
  validReadinessOperation,
} from './readiness-operation.mjs';
const operationOwners = new Map();
const reviewRoots = new WeakMap();
const projectRoots = new WeakMap();
const projectLeases = new WeakMap();
const projectOwners = new Map();
const projectScopeKey = (r, p) => `project-lifecycle:${r}:${p}`;
const projectUncertain = (reason) => ({ kind: 'uncertain', reason, evidence: [] });
const projectSync = async (path) => {
  const f = await fs.open(path, 'r');
  try {
    await f.sync();
  } finally {
    await f.close();
  }
};
const projectWrite = async (path, value) => {
  const f = await fs.open(path, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
};
const projectRead = async (path) => {
  const body = await fs.readFile(path, 'utf8');
  if (Buffer.byteLength(body) > 8388608) throw Error('Project file bound');
  return snapshotProjectData(JSON.parse(body));
};
/** Local filesystem TEST backend only. No cross-runner/backend selection.
 * Locks have no lease: a crashed holder requires explicit operator recovery.
 * A partial write/corrupt log denies reads; nothing is truncated or refunded.
 */
export class LocalDurableStore {
  constructor(root, { fault = async () => {} } = {}) {
    this.root = root;
    this.fault = fault;
  }
  async initializeProjectLifecycle(input) {
    try {
      input = snapshotProjectData(input);
      if (
        !input ||
        Object.keys(input).sort().join() !== 'projectId,repositoryId' ||
        !boundedId(input.repositoryId) ||
        !boundedId(input.projectId)
      )
        throw Error('Project identity');
      await this.init();
      const key = projectScopeKey(input.repositoryId, input.projectId);
      const path = join(this.root, `${digest(key)}.project-lifecycle`);
      await fs.mkdir(path, { mode: 0o700 });
      const root = await fs.lstat(this.root),
        scope = await fs.lstat(path);
      if (!root.isDirectory() || !scope.isDirectory())
        throw Error('Project root directory required');
      const identity = {
        version: 1,
        ...input,
        rootId: randomUUID(),
        rootDev: root.dev,
        rootIno: root.ino,
        scopeDev: scope.dev,
        scopeIno: scope.ino,
      };
      await projectWrite(join(path, 'identity.json'), identity);
      await projectWrite(join(path, 'index.json'), []);
      await fs.mkdir(join(path, 'operations'), { mode: 0o700 });
      await fs.mkdir(join(path, 'index'), { mode: 0o700 });
      await projectSync(path);
      await this.syncDirectory();
      projectRoots.set(this, structuredClone(identity));
      return verified(structuredClone(identity));
    } catch {
      return projectUncertain('Project root initialization unavailable');
    }
  }
  async bindProjectLifecycle(input) {
    try {
      projectRoots.delete(this);
      const identity = snapshotProjectData(input);
      if (
        Object.keys(identity).sort().join() !==
          'projectId,repositoryId,rootDev,rootId,rootIno,scopeDev,scopeIno,version' ||
        identity.version !== 1 ||
        !boundedId(identity.repositoryId) ||
        !boundedId(identity.projectId) ||
        !boundedId(identity.rootId) ||
        !['rootDev', 'rootIno', 'scopeDev', 'scopeIno'].every((k) =>
          Number.isSafeInteger(identity[k]),
        )
      )
        throw Error('Project identity');
      projectRoots.set(this, identity);
      await this.#verifyProjectLifecycle();
      return verified(structuredClone(identity));
    } catch {
      projectRoots.delete(this);
      return projectUncertain('Project root binding unavailable');
    }
  }
  async #verifyProjectLifecycle() {
    const identity = projectRoots.get(this);
    if (!identity) throw Error('Unbound Project root');
    const path = join(
      this.root,
      `${digest(projectScopeKey(identity.repositoryId, identity.projectId))}.project-lifecycle`,
    );
    const root = await fs.lstat(this.root),
      scope = await fs.lstat(path);
    if (
      !root.isDirectory() ||
      !scope.isDirectory() ||
      root.dev !== identity.rootDev ||
      root.ino !== identity.rootIno ||
      scope.dev !== identity.scopeDev ||
      scope.ino !== identity.scopeIno ||
      projectDigest(await projectRead(join(path, 'identity.json'))) !== projectDigest(identity)
    )
      throw Error('Missing/replaced Project root');
    return path;
  }
  async #projectLifecycleHistory(operationId, allowMissing = false) {
    const path = await this.#verifyProjectLifecycle();
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw Error('Project operation ID');
    if (JSON.stringify(await projectRead(join(path, 'index.json'))) !== '[]')
      throw Error('Project index marker');
    const index = (await fs.readdir(join(path, 'index'))).sort();
    const operations = (await fs.readdir(join(path, 'operations'))).sort();
    if (JSON.stringify(index) !== JSON.stringify(operations) || !index.includes(operationId))
      throw Error('Project operation index');
    const binding = snapshotProjectData(
      await projectRead(join(path, 'operations', operationId, 'binding.json')),
    );
    validateProjectBinding(binding);
    if (
      projectDigest(await projectRead(join(path, 'index', operationId))) !== projectDigest(binding)
    )
      throw Error('Project index binding mismatch');
    const identity = projectRoots.get(this);
    if (
      binding.operationId !== operationId ||
      binding.repositoryId !== identity.repositoryId ||
      binding.projectId !== identity.projectId
    )
      throw Error('Project binding context');
    const dir = join(path, 'operations', operationId);
    const files = (await fs.readdir(join(dir, 'witnesses'))).sort((a, b) => Number(a) - Number(b));
    if (
      files.length > 1000 ||
      index.length > 1000 ||
      index.some((id) => !/^[a-f0-9]{64}$/.test(id))
    )
      throw Error('Project index bound');
    const witnesses = [];
    for (let i = 0; i < files.length; i++) {
      if (files[i] !== String(i)) throw Error('Project witness gap');
      const w = snapshotProjectData(await projectRead(join(dir, 'witnesses', files[i])));
      if (
        Object.keys(w).sort().join() !== 'index,operationId,previousRecordDigest,recordDigest' ||
        w.index !== i ||
        w.operationId !== operationId ||
        !/^[a-f0-9]{64}$/.test(w.recordDigest) ||
        w.previousRecordDigest !== (i ? witnesses[i - 1].recordDigest : null)
      )
        throw Error('Project witness identity');
      witnesses.push(w);
    }
    const records = snapshotProjectData(await this.read(`project-records:${operationId}`));
    validateProjectRecords(binding, records);
    if (
      records.length > witnesses.length ||
      records.some((r, i) => projectDigest(r) !== witnesses[i].recordDigest)
    )
      throw Error('Project witness mismatch');
    if (!allowMissing && (!records.length || records.length !== witnesses.length))
      throw Error('Missing witnessed Project history');
    return {
      binding,
      records,
      journalDigest: projectDigest(records),
      witnesses,
      witnessDigest: projectDigest(witnesses),
      missingWitnesses: witnesses.slice(records.length),
    };
  }
  async readProjectLifecycle(operationId) {
    try {
      const { binding, records, journalDigest } = await this.#projectLifecycleHistory(operationId);
      return verified(snapshotProjectData({ binding, records, journalDigest }));
    } catch {
      return projectUncertain('Project lifecycle history unavailable');
    }
  }
  async #projectJournalMembership(index) {
    const identity = projectRoots.get(this),
      journals = [];
    let count = 0,
      bytes = 0;
    const directory = await fs.opendir(this.root);
    for await (const entry of directory) {
      if (++count > 1000) throw Error('Project root entry bound');
      if (!entry.name.endsWith('.jsonl')) continue;
      const file = join(this.root, entry.name),
        st = await fs.lstat(file);
      bytes += st.size;
      if (!st.isFile() || bytes > 8388608) throw Error('Project journal scan bound');
      const body = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(body) !== st.size) throw Error('Project journal changed');
      const first = JSON.parse(body.split('\n', 1)[0]);
      if (first.previous !== '' || first.hash !== digest(JSON.stringify(['', first.value])))
        throw Error('Project journal prefix unavailable');
      const record = first.value;
      if (record?.operationId && record?.phase) {
        const binding = record.data?.binding;
        validateProjectBinding(binding);
        validateProjectRecords(binding, [record]);
        if (entry.name !== `${digest('project-records:' + binding.operationId)}.jsonl`)
          throw Error('Project journal identity');
        if (
          binding.repositoryId === identity.repositoryId &&
          binding.projectId === identity.projectId &&
          !index.includes(binding.operationId)
        )
          throw Error('Unregistered Project journal');
      }
      // Membership evidence only: journal contents never recreate a binding or lease.
      journals.push({
        name: entry.name,
        dev: st.dev,
        ino: st.ino,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        prefix: first.hash,
      });
    }
    return journals.sort((a, b) => a.name.localeCompare(b.name));
  }
  async #projectNamespace() {
    const path = await this.#verifyProjectLifecycle();
    if (JSON.stringify(await projectRead(join(path, 'index.json'))) !== '[]')
      throw Error('Project index marker');
    const index = (await fs.readdir(join(path, 'index'))).sort();
    const operations = (await fs.readdir(join(path, 'operations'))).sort();
    if (
      index.length > 1000 ||
      JSON.stringify(index) !== JSON.stringify(operations) ||
      index.some((id) => !/^[a-f0-9]{64}$/.test(id))
    )
      throw Error('Project namespace index');
    const metadata = [];
    for (const name of ['index', 'operations']) {
      const st = await fs.lstat(join(path, name));
      if (!st.isDirectory()) throw Error('Project namespace directory');
      metadata.push({ name, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
    }
    const entries = [];
    for (const operationId of index)
      entries.push({ operationId, binding: await projectRead(join(path, 'index', operationId)) });
    const journals = await this.#projectJournalMembership(index);
    return { index, digest: projectDigest({ metadata, entries, journals }) };
  }
  async findProjectLifecycle(input) {
    try {
      const owned = snapshotProjectData(input);
      if (
        Object.keys(owned).sort().join() !== 'inputDigest,projectId,repositoryId' ||
        !boundedId(owned.repositoryId) ||
        !boundedId(owned.projectId) ||
        !/^[a-f0-9]{64}$/.test(owned.inputDigest)
      )
        return { kind: 'blocked', reason: 'Project lookup context', evidence: [] };
      const identity = projectRoots.get(this);
      if (
        !identity ||
        identity.repositoryId !== owned.repositoryId ||
        identity.projectId !== owned.projectId
      )
        return { kind: 'blocked', reason: 'Project lookup root context', evidence: [] };
      const before = await this.#projectNamespace(),
        matches = [];
      for (const operationId of before.index) {
        const h = await this.#projectLifecycleHistory(operationId);
        if (h.records[0].data.plan.inputDigest === owned.inputDigest)
          matches.push({ binding: h.binding, records: h.records, journalDigest: h.journalDigest });
      }
      const after = await this.#projectNamespace();
      if (before.digest !== after.digest) throw Error('Project lookup namespace changed');
      if (matches.length > 1)
        return { kind: 'conflict', reason: 'Ambiguous Project input history', evidence: [] };
      return verified(snapshotProjectData(matches[0] ?? null));
    } catch {
      return projectUncertain('Project lookup history unavailable');
    }
  }
  async withProjectLifecycleLock(input, run) {
    let owner;
    try {
      const binding = snapshotProjectData(input);
      validateProjectBinding(binding);
      const path = await this.#verifyProjectLifecycle(),
        identity = projectRoots.get(this);
      if (
        binding.repositoryId !== identity.repositoryId ||
        binding.projectId !== identity.projectId ||
        typeof run !== 'function'
      )
        throw Error('Project lock context');
      await this.#projectNamespace();
      const lock = join(path, 'lock');
      await fs.mkdir(lock, { mode: 0o700 });
      const st = await fs.stat(lock);
      owner = {
        key: projectScopeKey(binding.repositoryId, binding.projectId),
        operationId: binding.operationId,
        token: randomUUID(),
        pid: process.pid,
        dev: st.dev,
        ino: st.ino,
        birthtimeMs: st.birthtimeMs,
        rootId: identity.rootId,
      };
      await projectWrite(join(lock, 'owner.json'), owner);
      await projectSync(lock);
      await projectSync(path);
      projectOwners.set(owner.token, { store: this, ended: false });
      const { index: operations } = await this.#projectNamespace();
      for (const operationId of operations) {
        const h = await this.#projectLifecycleHistory(operationId);
        const state = validateProjectRecords(h.binding, h.records);
        if (
          operationId !== binding.operationId &&
          (state.pending.size || state.completed.size !== h.binding.stepCount)
        ) {
          await this.#releaseProjectLifecycle(owner);
          owner = undefined;
          return { kind: 'conflict', reason: 'Unfinished earlier Project operation', evidence: [] };
        }
      }
      const registered = operations.includes(binding.operationId);
      if (registered) {
        const h = await this.#projectLifecycleHistory(binding.operationId);
        if (projectDigest(h.binding) !== projectDigest(binding))
          throw Error('Changed Project binding');
      }
      const lease = Object.freeze({});
      projectLeases.set(lease, {
        store: this,
        binding,
        owner,
        active: true,
        recovery: false,
        registered,
        registrationStarted: false,
      });
      let result;
      try {
        result = await run(lease);
      } finally {
        projectLeases.get(lease).active = false;
        projectOwners.get(owner.token).ended = true;
      }
      const leaseState = projectLeases.get(lease);
      if (
        !leaseState.registered &&
        !leaseState.registrationStarted &&
        result?.kind === 'conflict'
      ) {
        await this.#releaseProjectLifecycle(owner);
        owner = undefined;
        return result;
      }
      const h = await this.#projectLifecycleHistory(binding.operationId);
      const state = validateProjectRecords(binding, h.records);
      if (
        result?.kind === 'uncertain' ||
        state.pending.size ||
        state.completed.size !== binding.stepCount
      )
        return result?.kind === 'uncertain'
          ? result
          : projectUncertain('Unfinished Project operation retains lock');
      await this.#releaseProjectLifecycle(owner);
      return result;
    } catch {
      if (owner && projectOwners.has(owner.token)) projectOwners.get(owner.token).ended = true;
      return projectUncertain('Project lifecycle lock or operation unavailable');
    }
  }
  async #checkProjectLifecycleOwner(owner) {
    const path = await this.#verifyProjectLifecycle(),
      lock = join(path, 'lock');
    const st = await fs.stat(lock),
      retained = await projectRead(join(lock, 'owner.json'));
    if (
      st.dev !== owner.dev ||
      st.ino !== owner.ino ||
      st.birthtimeMs !== owner.birthtimeMs ||
      projectDigest(retained) !== projectDigest(owner)
    )
      throw Error('Project lock replaced');
    return path;
  }
  async #releaseProjectLifecycle(owner) {
    const path = await this.#checkProjectLifecycleOwner(owner);
    await fs.unlink(join(path, 'lock', 'owner.json'));
    const st = await fs.stat(join(path, 'lock'));
    if (st.dev !== owner.dev || st.ino !== owner.ino || st.birthtimeMs !== owner.birthtimeMs)
      throw Error('Project lock replaced during release');
    await fs.rmdir(join(path, 'lock'));
    await projectSync(path);
    projectOwners.delete(owner.token);
  }
  async appendProjectLifecycle(lease, input) {
    try {
      const l = projectLeases.get(lease);
      if (!l || l.store !== this || !l.active || l.recovery) throw Error('Project lease');
      const record = snapshotProjectData(input);
      await this.#checkProjectLifecycleOwner(l.owner);
      if (!l.registered) {
        validateProjectRecords(l.binding, [record]);
        if (record.phase !== 'bound' || record.index !== 0)
          throw Error('Missing Project bound record');
        l.registrationStarted = true;
        const path = await this.#verifyProjectLifecycle(),
          dir = join(path, 'operations', l.binding.operationId);
        await projectWrite(join(path, 'index', l.binding.operationId), l.binding);
        await projectSync(join(path, 'index'));
        await fs.mkdir(dir, { mode: 0o700 });
        await projectWrite(join(dir, 'binding.json'), l.binding);
        await fs.mkdir(join(dir, 'witnesses'), { mode: 0o700 });
        await projectSync(dir);
        await projectSync(join(path, 'operations'));
        l.registered = true;
      }
      const h = await this.#projectLifecycleHistory(l.binding.operationId, true);
      if (h.records.length !== h.witnesses.length) throw Error('Unmatched witness');
      validateProjectRecords(l.binding, [...h.records, record]);
      await this.#writeProjectLifecycleRecord(l.binding, record);
      return verified(record);
    } catch {
      return projectUncertain('Project append unavailable');
    }
  }
  async #writeProjectLifecycleRecord(binding, record) {
    const path = await this.#verifyProjectLifecycle();
    const witnesses = join(path, 'operations', binding.operationId, 'witnesses');
    const witness = {
      operationId: binding.operationId,
      index: record.index,
      recordDigest: projectDigest(record),
      previousRecordDigest: record.previousRecordDigest,
    };
    await this.fault('project-before-witness', record);
    await projectWrite(join(witnesses, String(record.index)), witness);
    await projectSync(witnesses);
    await this.fault('project-before-append', record);
    await this.append(`project-records:${binding.operationId}`, record);
    await this.fault('project-after-append', record);
    const h = await this.#projectLifecycleHistory(binding.operationId);
    if (projectDigest(h.records.at(-1)) !== projectDigest(record))
      throw Error('Project append readback');
  }
  async withProjectLifecycleRecovery(input, resolveRecovery, run) {
    let recoveryPath, recoveryIdentity;
    try {
      const owned = snapshotProjectData(input);
      if (
        Object.keys(owned).sort().join() !==
          'operationId,originalInput,recoveryRef,retainedRecords,version' ||
        owned.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(owned.operationId) ||
        !boundedId(owned.recoveryRef) ||
        !Array.isArray(owned.retainedRecords) ||
        owned.retainedRecords.length > 1000 ||
        typeof resolveRecovery !== 'function'
      )
        throw Error('Project recovery input');
      const path = await this.#verifyProjectLifecycle();
      recoveryPath = join(path, 'recovery-lock');
      await fs.mkdir(recoveryPath, { mode: 0o700 });
      recoveryIdentity = await fs.stat(recoveryPath);
      await projectSync(path);
      const owner = snapshotProjectData(await projectRead(join(path, 'lock', 'owner.json')));
      if (owner.operationId !== owned.operationId || owner.rootId !== projectRoots.get(this).rootId)
        throw Error('Project recovery holder');
      await this.#checkProjectLifecycleOwner(owner);
      const expectedOwnerKeys = 'birthtimeMs,dev,ino,key,operationId,pid,rootId,token';
      if (
        Object.keys(owner).sort().join() !== expectedOwnerKeys ||
        owner.key !==
          projectScopeKey(projectRoots.get(this).repositoryId, projectRoots.get(this).projectId) ||
        !boundedId(owner.token) ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !['dev', 'ino'].every((k) => Number.isSafeInteger(owner[k]) && owner[k] >= 0) ||
        !Number.isFinite(owner.birthtimeMs) ||
        owner.birthtimeMs < 0
      )
        throw Error('Project lock identity');
      const local = projectOwners.get(owner.token);
      if (owner.pid === process.pid) {
        if (!local?.ended) throw Error('Live or unknown same-process Project holder');
      } else {
        try {
          process.kill(owner.pid, 0);
          throw Error('Live Project holder');
        } catch (e) {
          if (e.code !== 'ESRCH') throw e;
        }
      }
      const h = await this.#projectLifecycleHistory(owned.operationId, true);
      let complete = [...h.records];
      if (owned.retainedRecords.length > h.missingWitnesses.length)
        throw Error('Missing retained Project suffix');
      for (let i = 0; i < owned.retainedRecords.length; i++) {
        if (projectDigest(owned.retainedRecords[i]) !== h.missingWitnesses[i].recordDigest)
          throw Error('Unwitnessed Project replacement');
        complete.push(owned.retainedRecords[i]);
      }
      const completeEnough = owned.retainedRecords.length === h.missingWitnesses.length;
      const state = validateProjectRecords(h.binding, complete);
      if (
        (completeEnough && !state.plan) ||
        (state.plan && projectDigest(owned.originalInput) !== state.plan.inputDigest)
      )
        throw Error('Original Project input mismatch');
      const snapshot = snapshotProjectData({
        version: 1,
        rootIdentity: projectRoots.get(this),
        binding: h.binding,
        lockIdentity: owner,
        journalDigest: h.journalDigest,
        witnessDigest: h.witnessDigest,
        history: {
          kind: h.missingWitnesses.length ? 'missing-witnessed-suffix' : 'complete',
          records: h.records,
          missingWitnesses: h.missingWitnesses,
        },
        unresolvedIntentIndices: completeEnough
          ? [...state.pending.values()].map((r) => r.index).sort((a, b) => a - b)
          : [],
      });
      const lease = Object.freeze({});
      projectLeases.set(lease, {
        store: this,
        active: true,
        recovery: true,
        owner,
        binding: h.binding,
        input: owned,
        snapshot,
        complete,
        completeEnough,
        resolveRecovery,
      });
      try {
        return await run(lease, snapshot);
      } finally {
        projectLeases.get(lease).active = false;
      }
    } catch (e) {
      return projectUncertain(`Project explicit recovery unavailable: ${e.message}`);
    } finally {
      if (recoveryPath && recoveryIdentity) {
        try {
          const now = await fs.stat(recoveryPath);
          if (
            now.dev === recoveryIdentity.dev &&
            now.ino === recoveryIdentity.ino &&
            now.birthtimeMs === recoveryIdentity.birthtimeMs
          )
            await fs.rmdir(recoveryPath);
        } catch {
          /* Retain competing or replaced exclusion. */
        }
      }
    }
  }
  async appendProjectLifecycleRecovery(lease, input) {
    try {
      const l = projectLeases.get(lease);
      if (!l || l.store !== this || !l.active || !l.recovery || l.used || !l.completeEnough)
        throw Error('Project recovery lease');
      const proposal = snapshotProjectData(input);
      if (Object.keys(proposal).join() !== 'resolutions' || !Array.isArray(proposal.resolutions))
        throw Error('Project recovery proposal');
      const state = validateProjectRecords(l.binding, l.complete);
      const indices = [...state.pending.values()].map((r) => r.index).sort((a, b) => a - b);
      if (
        JSON.stringify(indices) !== JSON.stringify(proposal.resolutions.map((r) => r.intentIndex))
      )
        throw Error('Project intent resolution coverage');
      proposal.resolutions.forEach((r) => validateProjectResolution(l.complete[r.intentIndex], r));
      const request = snapshotProjectData({
        version: 1,
        recoveryRef: l.input.recoveryRef,
        rootIdentity: l.snapshot.rootIdentity,
        binding: l.binding,
        lockIdentity: l.owner,
        journalDigest: l.snapshot.journalDigest,
        witnessDigest: l.snapshot.witnessDigest,
        unresolvedIntentIndices: indices,
        resolutions: proposal.resolutions,
        retainedRecords: l.complete,
      });
      let response;
      for (let pass = 0; pass < 2; pass++) {
        await this.#checkProjectLifecycleOwner(l.owner);
        const h = await this.#projectLifecycleHistory(l.binding.operationId, true);
        if (
          h.journalDigest !== l.snapshot.journalDigest ||
          h.witnessDigest !== l.snapshot.witnessDigest
        )
          throw Error('Project history changed during recovery');
        const value = projectResultValue(await l.resolveRecovery(snapshotProjectData(request)));
        validateProjectRecoveryResponse(request, value);
        if (pass && projectDigest(response) !== projectDigest(value))
          throw Error('Stale Project recovery authority');
        response = value;
      }
      l.used = true;
      // Restore only independently witnessed exact suffix; never replace an existing row.
      for (const r of l.input.retainedRecords)
        await this.append(`project-records:${l.binding.operationId}`, r);
      const record = {
        version: 1,
        operationId: l.binding.operationId,
        index: l.complete.length,
        previousRecordDigest: l.complete.length ? projectDigest(l.complete.at(-1)) : null,
        phase: 'reconciliation',
        stepId: null,
        data: { request, response, resolutions: proposal.resolutions },
      };
      validateProjectRecords(l.binding, [...l.complete, record]);
      await this.#writeProjectLifecycleRecord(l.binding, record);
      const after = await this.#projectLifecycleHistory(l.binding.operationId);
      const receipt = snapshotProjectData({
        operationId: l.binding.operationId,
        lockIdentity: l.owner,
        previousJournalDigest: l.snapshot.journalDigest,
        reconciledJournalDigest: after.journalDigest,
        recoveryAuthorityRef: l.input.recoveryRef,
        resolvedIntentIndices: indices,
        observationRefs: [
          ...new Set(
            proposal.resolutions.flatMap((r) => r.observation.sourceBindings.map((b) => b.ref)),
          ),
        ].sort(),
      });
      await this.#releaseProjectLifecycle(l.owner);
      return verified(receipt);
    } catch (e) {
      return projectUncertain(`Project reconciliation append unavailable: ${e.message}`);
    }
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
  // Review funding is explicitly provisioned once by trusted local TEST setup.
  // The returned identity must be retained separately and rebound on restart.
  async initializeReviewFunding(fundingScope, limitsDigest) {
    if (!validId(fundingScope) || !/^[a-f0-9]{64}$/.test(limitsDigest))
      throw Error('Funding binding');
    await this.init();
    const path = join(this.root, `${digest(fundingScope)}.review`);
    await fs.mkdir(path, { mode: 0o700 });
    const write = async (name, body) => {
      const f = await fs.open(join(path, name), 'wx', 0o600);
      try {
        await f.writeFile(body);
        await f.sync();
      } finally {
        await f.close();
      }
    };
    const binding = { version: 1, fundingScope, limitsDigest };
    const rootStat = await fs.stat(this.root),
      scopeStat = await fs.stat(path);
    const identity = {
      ...binding,
      rootId: randomUUID(),
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      scopeDev: scopeStat.dev,
      scopeIno: scopeStat.ino,
    };
    await fs.mkdir(join(path, 'members'), { mode: 0o700 });
    await fs.mkdir(join(path, 'claims'), { mode: 0o700 });
    for (const name of ['events.jsonl', 'intents.jsonl']) await write(name, '');
    await write('identity', JSON.stringify(identity));
    await write('binding', JSON.stringify(binding));
    const directory = await fs.open(path, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await this.syncDirectory();
    await this.bindReviewFunding(identity);
    return structuredClone(identity);
  }
  async bindReviewFunding(input) {
    const identity = structuredClone(input);
    await this.verifyReviewFunding(identity);
    reviewRoots.set(this, Object.freeze(identity));
    return structuredClone(identity);
  }
  async verifyReviewFunding(identity = reviewRoots.get(this)) {
    if (
      !identity ||
      !validId(identity.fundingScope) ||
      !/^[a-f0-9]{64}$/.test(identity.limitsDigest)
    )
      throw Error('Retained initialized funding root required');
    const path = join(this.root, `${digest(identity.fundingScope)}.review`);
    const rootStat = await fs.stat(this.root),
      scopeStat = await fs.stat(path);
    if (
      rootStat.dev !== identity.rootDev ||
      rootStat.ino !== identity.rootIno ||
      scopeStat.dev !== identity.scopeDev ||
      scopeStat.ino !== identity.scopeIno ||
      (await fs.readFile(join(path, 'identity'), 'utf8')) !== JSON.stringify(identity) ||
      (await fs.readFile(join(path, 'binding'), 'utf8')) !==
        JSON.stringify({
          version: 1,
          fundingScope: identity.fundingScope,
          limitsDigest: identity.limitsDigest,
        })
    )
      throw Error('Missing/replaced funding root');
    return path;
  }
  async withReviewFundingLock(fundingScope, limitsDigest, fn) {
    const path = await this.verifyReviewFunding();
    const identity = reviewRoots.get(this);
    if (identity.fundingScope !== fundingScope || identity.limitsDigest !== limitsDigest)
      throw Error('Funding configuration changed');
    const lock = join(path, 'lock');
    await fs.mkdir(lock, { mode: 0o700 });
    const d = await fs.open(path, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
    // Any exception or uncertainty retains the lock. There is no takeover API.
    const result = await fn();
    if (result?.kind === 'uncertain') return result;
    // Successful removal commits release: no fallible work follows it. A crash
    // before directory persistence may replay the old lock and deny availability;
    // that conservative stale lock never authorizes takeover or restores capacity.
    await fs.rmdir(lock);
    return result;
  }
  async readReviewFunding(fundingScope, limitsDigest) {
    const path = await this.verifyReviewFunding();
    const identity = reviewRoots.get(this);
    if (identity.fundingScope !== fundingScope || identity.limitsDigest !== limitsDigest)
      throw Error('Funding binding mismatch');
    const body = await fs.readFile(join(path, 'events.jsonl'), 'utf8');
    const intents = await fs.readFile(join(path, 'intents.jsonl'), 'utf8');
    if (
      Buffer.byteLength(body) > 8_000_000 ||
      Buffer.byteLength(intents) > 8_000_000 ||
      (body && !body.endsWith('\n')) ||
      (intents && !intents.endsWith('\n'))
    )
      throw Error('Incomplete review history');
    const lines = body ? body.slice(0, -1).split('\n') : [];
    const expected = lines.map((line, i) => `${i + 1}-${digest(line)}`);
    const index = intents ? intents.slice(0, -1).split('\n') : [];
    const members = await fs.readdir(join(path, 'members'));
    if (
      JSON.stringify(expected) !== JSON.stringify(index) ||
      JSON.stringify([...expected].sort()) !== JSON.stringify(members.sort())
    )
      throw Error('Missing review history/index');
    const rows = lines.map((line) => JSON.parse(line));
    let previous = '';
    const claims = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.sequence !== i + 1 || row.previousDigest !== previous)
        throw Error('Review chain binding');
      previous = digest(lines[i]);
      if (row.claim) {
        if (claims.has(row.claim.id) && claims.get(row.claim.id) !== row.reservation.key)
          throw Error('Conflicting claim index');
        claims.set(row.claim.id, row.reservation.key);
      }
    }
    const claimFiles = await fs.readdir(join(path, 'claims'));
    if (JSON.stringify([...claims.keys()].sort()) !== JSON.stringify(claimFiles.sort()))
      throw Error('Missing/extra claim index');
    for (const [id, key] of claims)
      if ((await fs.readFile(join(path, 'claims', id), 'utf8')) !== key)
        throw Error('Wrong claim mapping');
    await this.fault('review-readback', rows.at(-1));
    return rows;
  }
  // Only the ledger's lifecycle code calls this storage primitive under funding.
  async appendReviewFunding(fundingScope, limitsDigest, input) {
    const event = structuredClone(input);
    const path = await this.verifyReviewFunding();
    const rows = await this.readReviewFunding(fundingScope, limitsDigest);
    const previous = rows.length ? digest(JSON.stringify(rows.at(-1))) : '';
    if (event.sequence !== rows.length + 1 || event.previousDigest !== previous)
      throw Error('Review append chain');
    const sync = async (directory) => {
      const d = await fs.open(directory, 'r');
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    };
    const append = async (name, body, flags = 'a') => {
      const f = await fs.open(join(path, name), flags, 0o600);
      try {
        await f.writeFile(body);
        await f.sync();
      } finally {
        await f.close();
      }
    };
    if (event.claim && !rows.some((r) => r.claim?.id === event.claim.id)) {
      if (!/^[a-f0-9]{64}$/.test(event.claim.id)) throw Error('Claim index identity');
      await append(`claims/${event.claim.id}`, event.reservation.key, 'wx');
      await sync(join(path, 'claims'));
    }
    const line = JSON.stringify(event),
      member = `${event.sequence}-${digest(line)}`;
    await append('intents.jsonl', member + '\n');
    await append(`members/${member}`, '', 'wx');
    await sync(join(path, 'members'));
    await sync(path);
    await this.fault('review-before-append', event);
    await append('events.jsonl', line + '\n');
    await sync(path);
    await this.fault('review-after-fsync', event);
    const after = await this.readReviewFunding(fundingScope, limitsDigest);
    if (JSON.stringify(after.at(-1)) !== line) throw Error('Review append readback');
    return event;
  }
}
