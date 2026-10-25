import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { open, mkdir, lstat, readFile, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { blocked, verified } from './contracts.mjs';
import { isEvidenceFor, isSetupPath } from './validate.mjs';
import { probeExistingSigning } from './github.mjs';
/** @typedef {import('./contracts.mjs').Evidence} Evidence */
/** @template T @typedef {import('./contracts.mjs').Result<T>} Result */
/** @typedef {{operationId:string,phase:string,fullName?:string,repositoryId?:string,evidence?:Evidence[]}} JournalRecord */
/** @typedef {{repositoryId:string,verified:true,fileManifest:Record<string,string>,settings:object}} BaselineEvidence */
const hash = (value) => createHash('sha256').update(value).digest('hex');
const failure = (reason) => ({ kind: 'uncertain', reason, evidence: [] });
const validKey = (key) => typeof key === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(key);
const fields = new Set([
  'operationId',
  'phase',
  'fullName',
  'repositoryId',
  'evidence',
  'fileManifest',
  'settings',
]);
function validRecord(record, key) {
  return (
    record &&
    record.operationId === key &&
    typeof record.phase === 'string' &&
    record.phase.length < 100 &&
    Object.keys(record).every((k) => fields.has(k)) &&
    JSON.stringify(record).length <= 100_000 &&
    !/gh[pousr]_[A-Za-z0-9_]{20,}|sk-proj-|BEGIN .*PRIVATE KEY/.test(JSON.stringify(record))
  );
}
/** Local trusted maintainer storage; not authenticity proof against that same OS user. */
export function createSetupJournal({ root, actorId }) {
  root = realpathSync(root);
  const directory = join(root, '.governance-local', 'setup');
  const evidence = (key, digest) => [
    {
      source: 'local-fsync-journal',
      actorId,
      resourceId: key,
      observedAt: new Date().toISOString(),
      digest,
    },
  ];
  async function prepare() {
    let cursor = resolve(root);
    while (true) {
      const s = await lstat(cursor);
      if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Unsafe ancestor');
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    for (const path of [join(resolve(root), '.governance-local'), directory]) {
      await mkdir(path, { mode: 0o700 }).catch((e) => {
        if (e.code !== 'EEXIST') throw e;
      });
      const s = await lstat(path);
      if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o700)
        throw Error('Unsafe journal directory');
      const parent = await open(dirname(path), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
  async function load(key) {
    const path = join(directory, `${key}.jsonl`);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = await handle.stat();
      if (!s.isFile() || s.size > 2_000_000 || (s.mode & 0o777) !== 0o600)
        throw Error('Unsafe journal');
      const text = await handle.readFile('utf8');
      if (text && !text.endsWith('\n')) throw Error('Incomplete journal');
      let previous = '0'.repeat(64);
      const rows = [];
      for (const line of text.trimEnd().split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (
          row.sequence !== rows.length + 1 ||
          row.previous !== previous ||
          !validRecord(row.record, key) ||
          row.digest !==
            hash(
              JSON.stringify({
                sequence: row.sequence,
                previous: row.previous,
                record: row.record,
              }),
            )
        )
          throw Error('Corrupt journal');
        previous = row.digest;
        rows.push(row.record);
      }
      return { rows, previous };
    } catch (e) {
      if (e.code === 'ENOENT') return { rows: [], previous: '0'.repeat(64) };
      throw e;
    } finally {
      await handle?.close();
    }
  }
  return {
    async readJournal(key) {
      if (!validKey(key) || !actorId) return blocked('Invalid journal identity');
      try {
        await prepare();
        const { rows, previous } = await load(key);
        return verified(rows, evidence(key, previous));
      } catch {
        return blocked('Journal unsafe, missing integrity or unavailable');
      }
    },
    async appendJournal(key, record) {
      if (!validKey(key) || !actorId || !validRecord(record, key))
        return blocked('Invalid or unsanitized journal record');
      let lock, handle;
      try {
        await prepare();
        lock = await open(join(directory, `${key}.lock`), 'wx', 0o600);
        const { rows, previous } = await load(key);
        const body = { sequence: rows.length + 1, previous, record };
        const digest = hash(JSON.stringify(body));
        handle = await open(
          join(directory, `${key}.jsonl`),
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(`${JSON.stringify({ ...body, digest })}\n`);
        await handle.sync();
        await handle.close();
        handle = null;
        const dir = await open(directory, 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
        const observed = await load(key);
        if (observed.previous !== digest) throw Error('Readback failed');
        return verified(record, evidence(key, digest));
      } catch {
        return blocked('Durable journal append unverified; reconcile before mutation');
      } finally {
        await handle?.close();
        if (lock) {
          await lock.close();
          await unlink(join(directory, `${key}.lock`));
        }
      }
    },
  };
}
const identity = (r) =>
  r?.id &&
  r.fullName === 'glyad/github-workspace-manager' &&
  r.ownerLogin === 'glyad' &&
  r.visibility === 'public';
/** Only an attributable persisted creation result permits observed-resource reconciliation. */
export async function ensureRepository(port, operation) {
  if (
    operation?.fullName !== 'glyad/github-workspace-manager' ||
    !validKey(operation.operationId) ||
    !operation.actorId
  )
    return blocked('Approved creation identity required');
  try {
    const actor = await port.observeActor();
    if (
      actor.kind !== 'verified' ||
      actor.value?.login !== 'glyad' ||
      actor.value.id !== operation.actorId ||
      !isEvidenceFor(actor.evidence, operation.actorId, [operation.actorId])
    )
      return blocked('Authenticated maintainer unverified');
    const journal = await port.readJournal(operation.operationId);
    if (
      journal.kind !== 'verified' ||
      !isEvidenceFor(journal.evidence, operation.actorId, [operation.operationId]) ||
      !Array.isArray(journal.value)
    )
      return blocked('Trusted creation journal required');
    const persist = async (phase, repositoryId, evidence) => {
      const record = {
        operationId: operation.operationId,
        fullName: operation.fullName,
        phase,
        ...(repositoryId ? { repositoryId } : {}),
        ...(evidence ? { evidence } : {}),
      };
      const saved = await port.appendJournal(operation.operationId, record);
      return saved.kind === 'verified' &&
        isEvidenceFor(saved.evidence, operation.actorId, [operation.operationId]) &&
        JSON.stringify(saved.value) === JSON.stringify(record)
        ? saved
        : blocked('Exact creation record not durably verified');
    };
    if (journal.value.some((r) => r.phase === 'create-precondition-conflict'))
      return {
        kind: 'conflict',
        reason: 'Creation precondition conflict requires explicit adoption decision',
        evidence: journal.evidence,
      };
    const intent = journal.value.some(
      (r) => r.phase === 'create-intent' && r.fullName === operation.fullName,
    );
    let bound = journal.value.find(
      (r) =>
        ['create-result', 'create-response'].includes(r.phase) && r.fullName === operation.fullName,
    );
    let observed = await port.observeRepository(operation.fullName);
    const checked = () =>
      observed.kind === 'verified' &&
      isEvidenceFor(observed.evidence, operation.actorId, [
        observed.value?.id ?? operation.fullName,
      ]);
    if (!checked()) return blocked('Repository observation unverified');
    const prior = journal.value.find((r) => r.phase === 'create-verified');
    if (prior && prior.repositoryId !== observed.value?.id)
      return {
        kind: 'conflict',
        reason: 'Repository ID changed since verified creation',
        evidence: observed.evidence,
      };
    if (intent && !bound)
      return failure(
        'Creation has no attributable persisted result; explicit adoption decision required, no retry',
      );
    if (!intent) {
      if (observed.value)
        return {
          kind: 'conflict',
          reason: 'Existing repository requires explicit adoption decision',
          evidence: observed.evidence,
        };
      const saved = await persist('create-intent');
      if (saved.kind !== 'verified') return saved;
      observed = await port.observeRepository(operation.fullName);
      if (!checked() || observed.value) {
        const conflict = await persist('create-precondition-conflict');
        return conflict.kind === 'verified'
          ? {
              kind: 'conflict',
              reason: 'Creation precondition changed; explicit adoption required',
              evidence: observed.evidence ?? [],
            }
          : conflict;
      }
      const attempted = await persist('create-attempt');
      if (attempted.kind !== 'verified') return attempted;
      let result;
      try {
        result = await port.createRepository(operation);
      } catch {
        result = failure('Creation response lost');
      }
      if (
        result?.kind !== 'verified' ||
        !identity(result.value) ||
        !isEvidenceFor(result.evidence, operation.actorId, [result.value.id])
      ) {
        const reread = await port.readJournal(operation.operationId);
        const receipt =
          reread.kind === 'verified' &&
          isEvidenceFor(reread.evidence, operation.actorId, [operation.operationId])
            ? reread.value.find(
                (r) =>
                  r.phase === 'create-response' &&
                  r.fullName === operation.fullName &&
                  typeof r.repositoryId === 'string',
              )
            : null;
        observed = await port.observeRepository(operation.fullName);
        if (!receipt)
          return failure(
            'Creation response lacks attributable exact result; reconcile with explicit adoption decision, no retry',
          );
        bound = receipt;
      } else {
        const persisted = await persist('create-result', result.value.id, result.evidence);
        if (persisted.kind !== 'verified') return persisted;
        bound = persisted.value;
        observed = await port.observeRepository(operation.fullName);
      }
    }
    if (!checked() || !identity(observed.value))
      return failure('Creation identity or outcome unresolved; no retry');
    if (bound.repositoryId !== observed.value.id)
      return {
        kind: 'conflict',
        reason: 'Observed repository differs from attributable creation result',
        evidence: observed.evidence,
      };
    const saved = await persist('create-verified', observed.value.id, observed.evidence);
    return saved.kind === 'verified' ? observed : saved;
  } catch {
    return failure('Creation reconciliation unavailable; no automatic retry');
  }
}
/** @param {object} port @param {import('./contracts.mjs').SetupSession} session @param {Record<string,string>} fileManifest @returns {Promise<Result<BaselineEvidence>>} */
export async function applyBaseline(port, session, fileManifest) {
  if (
    session?.state !== 'open' ||
    session.actor?.login !== 'glyad' ||
    !session.repositoryId ||
    session.fullName !== 'glyad/github-workspace-manager' ||
    !fileManifest ||
    !Object.keys(fileManifest).length
  )
    return blocked('Open identified baseline session required');
  try {
    for (const [path, digest] of Object.entries(fileManifest)) {
      if (
        !(isSetupPath(path) && session.approvedPaths.includes(path)) &&
        !(path === 'AGENTS.md' && session.supplementalAgentsDigest === digest)
      )
        return blocked('File outside reviewed baseline scope');
      if (!/^[a-f0-9]{64}$/.test(digest)) return blocked('Invalid file digest');
      const target = join(session.destination, path);
      let cursor = target;
      while (cursor !== dirname(cursor)) {
        const part = await lstat(cursor);
        if (part.isSymbolicLink()) return blocked('Symlink in frozen file path');
        cursor = dirname(cursor);
      }
      const s = await lstat(target);
      if (!s.isFile() || s.isSymbolicLink() || hash(await readFile(target)) !== digest)
        return blocked('Frozen file manifest changed');
    }
    const actor = await port.observeActor();
    if (
      actor.kind !== 'verified' ||
      actor.value?.login !== 'glyad' ||
      actor.value.id !== session.actor.id ||
      !isEvidenceFor(actor.evidence, session.actor.id, [session.actor.id])
    )
      return blocked('Fresh authenticated owner required');
    const before = await port.observeRepository(session.fullName);
    if (
      before.kind !== 'verified' ||
      before.value?.id !== session.repositoryId ||
      !identity(before.value) ||
      !isEvidenceFor(before.evidence, session.actor.id, [session.repositoryId])
    )
      return blocked('Repository precondition unverified');
    const intent = await port.appendJournal(session.operationId, {
      operationId: session.operationId,
      phase: 'baseline-intent',
      repositoryId: session.repositoryId,
      fileManifest,
    });
    if (
      intent.kind !== 'verified' ||
      !isEvidenceFor(intent.evidence, session.actor.id, [session.operationId])
    )
      return blocked('Baseline intent not durable');
    try {
      await port.applySettings(session);
    } catch {
      /* read back effective settings */
    }
    const observed = await port.observeBaseline(session, fileManifest);
    if (
      observed.kind !== 'verified' ||
      observed.value?.verified !== true ||
      observed.value.repositoryId !== session.repositoryId ||
      !isEvidenceFor(observed.evidence, session.actor.id, [session.repositoryId])
    )
      return failure('Baseline settings, files or signature readback unverified');
    const saved = await port.appendJournal(session.operationId, {
      operationId: session.operationId,
      phase: 'baseline-verified',
      repositoryId: session.repositoryId,
      evidence: observed.evidence,
    });
    return saved.kind === 'verified' ? observed : saved;
  } catch {
    return blocked('Baseline file, setting or journal verification failed');
  }
}
/** REST adapter always uses JSON stdin. Credential material and stderr never enter evidence. */
export function createBaselineGitHubPort({ root, actorId, execute = execFileSync }) {
  const journal = createSetupJournal({ root, actorId });
  const evidence = (id) => [
    {
      source: 'authenticated-gh-api',
      actorId,
      resourceId: id,
      observedAt: new Date().toISOString(),
    },
  ];
  function request(endpoint, method = 'GET', body) {
    try {
      const args = ['api', '--hostname', 'github.com', '--include', endpoint, '--method', method];
      if (body) args.push('--input', '-');
      const stdout = execute('gh', args, {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: 2_000_000,
      });
      return {
        status: Number(/^HTTP\/\S+\s+(\d+)/m.exec(stdout)?.[1]),
        body: JSON.parse(
          stdout
            .split(/\r?\n\r?\n/)
            .slice(1)
            .join('\n\n'),
        ),
      };
    } catch (error) {
      const stdout = typeof error.stdout === 'string' ? error.stdout : '';
      return { status: Number(/^HTTP\/\S+\s+(\d+)/m.exec(stdout)?.[1]) };
    }
  }
  return {
    ...journal,
    async observeActor() {
      const r = request('user');
      return r.status === 200
        ? verified({ id: r.body.node_id, login: r.body.login }, evidence(r.body.node_id))
        : failure('Actor observation unavailable');
    },
    async observeRepository(fullName) {
      if (fullName !== 'glyad/github-workspace-manager') return blocked('Wrong repository');
      const r = request(`repos/${fullName}`);
      if (r.status === 404) return verified(null, evidence(fullName));
      return r.status === 200
        ? verified(
            {
              id: r.body.node_id,
              fullName: r.body.full_name,
              ownerLogin: r.body.owner?.login,
              visibility: r.body.visibility,
            },
            evidence(r.body.node_id),
          )
        : failure('Repository observation unavailable');
    },
    async createRepository(operation) {
      if (
        !operation ||
        !validKey(operation.operationId) ||
        operation.actorId !== actorId ||
        operation.fullName !== 'glyad/github-workspace-manager'
      )
        return blocked('Approved identified creation operation required before request');
      const actor = await this.observeActor();
      if (
        actor.kind !== 'verified' ||
        actor.value?.login !== 'glyad' ||
        actor.value.id !== actorId ||
        !isEvidenceFor(actor.evidence, actorId, [actorId])
      )
        return blocked('Authenticated creation actor unverified before request');
      const response = request('user/repos', 'POST', {
        name: 'github-workspace-manager',
        description: 'Portable AI-assisted GitHub provisioning and configuration management',
        private: false,
        auto_init: false,
        has_issues: true,
        has_wiki: false,
      });
      if (response.status !== 201 || !response.body?.node_id)
        return failure('Creation response unavailable; explicit adoption decision required');
      const responseIdentity = {
        id: response.body.node_id,
        fullName: response.body.full_name,
        ownerLogin: response.body.owner?.login,
        visibility: response.body.visibility,
      };
      if (
        !identity(responseIdentity) ||
        operation?.actorId !== actorId ||
        !validKey(operation.operationId)
      )
        return blocked('Creation response identity or operation invalid');
      const record = {
        operationId: operation.operationId,
        phase: 'create-response',
        fullName: responseIdentity.fullName,
        repositoryId: responseIdentity.id,
      };
      const saved = await journal.appendJournal(operation.operationId, record);
      if (
        saved.kind !== 'verified' ||
        !isEvidenceFor(saved.evidence, actorId, [operation.operationId]) ||
        JSON.stringify(saved.value) !== JSON.stringify(record)
      )
        return blocked('Creation response receipt not durable');
      const observed = await this.observeRepository('glyad/github-workspace-manager');
      return observed.kind === 'verified' &&
        identity(observed.value) &&
        observed.value.id === response.body.node_id
        ? observed
        : failure('Creation exact response identity not independently verified');
    },
    async observeBaseline(session, fileManifest) {
      const r = request('repos/glyad/github-workspace-manager');
      const expected = {
        full_name: 'glyad/github-workspace-manager',
        description: 'Portable AI-assisted GitHub provisioning and configuration management',
        has_projects: true,
        visibility: 'public',
        default_branch: 'main',
        has_issues: true,
        has_discussions: true,
        has_wiki: false,
        has_pages: false,
        is_template: false,
        allow_merge_commit: true,
        allow_squash_merge: false,
        allow_rebase_merge: false,
        allow_auto_merge: false,
        delete_branch_on_merge: true,
        merge_commit_title: 'PR_TITLE',
        merge_commit_message: 'PR_BODY',
      };
      if (
        r.status !== 200 ||
        r.body.node_id !== session.repositoryId ||
        Object.entries(expected).some(([k, v]) => r.body[k] !== v)
      )
        return blocked('Effective repository settings differ');
      const commit = request('repos/glyad/github-workspace-manager/commits/main');
      if (
        commit.status !== 200 ||
        commit.body.commit?.verification?.verified !== true ||
        commit.body.commit.verification.reason !== 'valid'
      )
        return blocked('GitHub commit signature unverified');
      const develop = request('repos/glyad/github-workspace-manager/git/ref/heads/develop');
      if (develop.status !== 200 || develop.body.object?.sha !== commit.body.sha)
        return blocked('Develop baseline differs from main');
      const tree = request(
        `repos/glyad/github-workspace-manager/git/trees/${commit.body.commit.tree.sha}?recursive=1`,
      );
      if (tree.status !== 200 || tree.body.truncated !== false || !Array.isArray(tree.body.tree))
        return blocked('Full remote tree unavailable');
      const allowedDirectories = new Set();
      for (const path of Object.keys(fileManifest)) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++) allowedDirectories.add(parts.slice(0, i).join('/'));
      }
      const seen = new Set();
      for (const entry of tree.body.tree) {
        if (seen.has(entry.path)) return blocked('Duplicate remote tree path');
        seen.add(entry.path);
        if (entry.type === 'tree') {
          if (entry.mode !== '040000' || !allowedDirectories.has(entry.path))
            return blocked('Unapproved remote directory');
        } else if (
          entry.type !== 'blob' ||
          entry.mode !== '100644' ||
          !Object.hasOwn(fileManifest, entry.path)
        )
          return blocked('Unapproved remote tree entry');
      }
      if ([...allowedDirectories].some((path) => !seen.has(path)))
        return blocked('Missing remote directory');
      const blobs = tree.body.tree.filter((e) => e.type === 'blob');
      if (blobs.length !== Object.keys(fileManifest).length)
        return blocked('Remote tree differs from frozen file set');
      for (const [path, digest] of Object.entries(fileManifest)) {
        const bytes = await readFile(join(session.destination, path));
        if (hash(bytes) !== digest) return blocked('Local frozen manifest changed during readback');
        const gitHash = createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex');
        if (!blobs.some((e) => e.path === path && e.sha === gitHash && e.mode === '100644'))
          return blocked('Remote content differs from frozen manifest');
      }
      return verified(
        {
          repositoryId: session.repositoryId,
          verified: true,
          fileManifest,
          settings: expected,
          mainSha: commit.body.sha,
          developSha: develop.body.object.sha,
        },
        evidence(session.repositoryId),
      );
    },
    async applySettings() {
      request('repos/glyad/github-workspace-manager', 'PATCH', {
        description: 'Portable AI-assisted GitHub provisioning and configuration management',
        default_branch: 'main',
        has_issues: true,
        has_discussions: true,
        has_wiki: false,
        has_projects: true,
        is_template: false,
        allow_merge_commit: true,
        allow_squash_merge: false,
        allow_rebase_merge: false,
        allow_auto_merge: false,
        delete_branch_on_merge: true,
        merge_commit_title: 'PR_TITLE',
        merge_commit_message: 'PR_BODY',
      });
      return failure('Settings require independent observation');
    },
  };
}

/** Preserve existing repo-local signing/verification programs in the disposable probe. Never read key bytes. */
export async function probeBaselineSigning({ actor, gh, root, execute }) {
  const run = (binary, args, options = {}) => {
    try {
      return {
        ok: true,
        stdout: execFileSync(binary, args, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
          ...options,
        }),
      };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
  const invoke = execute ?? run;
  const additional = [];
  for (const key of ['gpg.ssh.allowedSignersFile', 'gpg.ssh.program', 'gpg.program']) {
    const result = invoke('git', ['config', '--get', key]);
    if (result.ok && result.stdout.trim()) additional.push('-c', `${key}=${result.stdout.trim()}`);
  }
  return probeExistingSigning({
    actor,
    gh,
    execute: (binary, args, options) =>
      invoke(
        binary,
        binary === 'git' && args[0] === '-C' ? [...additional, ...args] : args,
        options,
      ),
  });
}
