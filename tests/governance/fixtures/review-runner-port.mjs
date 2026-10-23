import { spawn as spawnProcess, execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// This fixture controls a POSIX process group of fixed trusted test sources.
// It does not establish hostile same-user sandbox isolation.
export function createLocalReviewRunnerPort() {
  const children = new WeakMap();
  const list = () =>
    execFileSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,pgid=,stat='], {
      encoding: 'utf8',
      env: { LANG: 'C' },
      timeout: 500,
      maxBuffer: 1_000_000,
    })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid, pgid, state] = line.trim().split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state };
      });
  let supported = ['darwin', 'linux'].includes(process.platform);
  try {
    if (supported) list();
  } catch {
    supported = false;
  }
  const lookup = (handle) => {
    const state = children.get(handle?.id);
    if (!state) throw Error('Runner-owned handle required');
    return state;
  };
  const snapshotGroup = (state) => {
    const rows = list().filter((row) => row.pgid === state.child.pid);
    for (const row of rows) if (row.pid !== state.child.pid) state.descendants.add(row.pid);
    return rows;
  };
  function reader(stream, state, name) {
    return async ({ maxBytes, signal }) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16384)
        throw Error('Bounded read required');
      while (true) {
        if (signal?.aborted) throw Error('aborted');
        if (stream.readableLength > 0) {
          if (maxBytes === 0 || state[name] >= 1_000_000) throw Error('Pipe ceiling');
          const chunk = stream.read(
            Math.min(maxBytes, stream.readableLength, 1_000_000 - state[name]),
          );
          if (chunk) {
            state[name] += chunk.length;
            return { chunk, done: false };
          }
        }
        if (stream.readableEnded || stream.destroyed)
          return { chunk: new Uint8Array(), done: true };
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            for (const event of ['readable', 'end', 'close']) stream.removeListener(event, ready);
            stream.removeListener('error', error);
            signal?.removeEventListener('abort', abort);
          };
          const ready = () => {
              cleanup();
              resolve();
            },
            error = (e) => {
              cleanup();
              reject(e);
            },
            abort = () => error(Error('aborted'));
          for (const event of ['readable', 'end', 'close']) stream.once(event, ready);
          stream.once('error', error);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    };
  }
  return Object.freeze({
    now: () => performance.now(),
    spawn({ executable, childScript, sourceDigest, env, home, cwd }) {
      if (!supported)
        return { kind: 'blocked', reason: 'Unverified POSIX group control; no child spawned' };
      // Supervisor checks source hash; this trusted fixture source stays immutable during tests.
      const child = spawnProcess(executable, [childScript], {
        env: { ...env },
        cwd,
        detached: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const id = Object.freeze({ token: randomUUID() }),
        state = {
          child,
          id,
          home,
          sourceDigest,
          parentExited: false,
          spawnFailed: false,
          descendants: new Set(),
          stdout: 0,
          stderr: 0,
        };
      children.set(id, state);
      child.on('error', () => {
        if (!Number.isSafeInteger(child.pid)) state.spawnFailed = true;
      });
      child.stdin.on('error', () => {});
      child.on('exit', () => {
        state.parentExited = true;
      });
      const handle = Object.freeze({
        id,
        async writeFrame(bytes, { signal }) {
          if (!(bytes instanceof Uint8Array) || bytes.length > 0xffffffff)
            throw Error('Bounded frame required');
          for (let offset = 0; offset < bytes.length; offset += 16384) {
            if (signal?.aborted) throw Error('aborted');
            const chunk = bytes.subarray(offset, Math.min(offset + 16384, bytes.length));
            await new Promise((resolve, reject) => {
              const abort = () => {
                signal?.removeEventListener('abort', abort);
                reject(Error('aborted'));
              };
              signal?.addEventListener('abort', abort, { once: true });
              child.stdin.write(chunk, (error) => {
                signal?.removeEventListener('abort', abort);
                error ? reject(error) : resolve();
              });
              if (signal?.aborted) abort();
            });
          }
        },
        readStdout: reader(child.stdout, state, 'stdout'),
        readStderr: reader(child.stderr, state, 'stderr'),
        closeInput() {
          child.stdin.end();
        },
      });
      return { kind: 'verified', value: handle };
    },
    async abortGroup(handle) {
      const state = lookup(handle);
      if (state.spawnFailed || !Number.isSafeInteger(state.child.pid)) {
        state.child.stdin.destroy();
        state.child.stdout.destroy();
        state.child.stderr.destroy();
        return { kind: 'blocked', reason: 'No spawned process group to verify' };
      }
      try {
        snapshotGroup(state);
        process.kill(-state.child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH')
          return { kind: 'blocked', reason: 'Group termination unverified' };
      }
      state.child.stdin.destroy();
      state.child.stdout.destroy();
      state.child.stderr.destroy();
      return { kind: 'verified', value: null };
    },
    async joinGroup(handle, { signal } = {}) {
      const state = lookup(handle);
      while (true) {
        if (signal?.aborted) throw Error('aborted');
        if (state.spawnFailed || !Number.isSafeInteger(state.child.pid))
          return { kind: 'blocked', reason: 'No spawned process group to verify' };
        const rows = snapshotGroup(state);
        // A zombie has exited and cannot execute; its OS reaping is outside this fixture.
        const descendantsExited = rows.every(
          (row) => row.pid === state.child.pid || row.state.startsWith('Z'),
        );
        const pipesClosed = [state.child.stdin, state.child.stdout, state.child.stderr].every(
          (s) => s.closed,
        );
        if (state.parentExited && descendantsExited && pipesClosed)
          return {
            kind: 'verified',
            value: Object.freeze({
              handleId: state.id,
              parentExited: true,
              descendantsExited: true,
              pipesClosed: true,
              evidenceId: 'group-' + state.id.token,
            }),
          };
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            error ? reject(error) : resolve();
          };
          const abort = () => finish(Error('aborted'));
          const timer = setTimeout(() => finish(), 10);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    },
    async disposeHome(home) {
      await rm(home, { recursive: true, force: true });
    },
  });
}
