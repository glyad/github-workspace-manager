import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { digest } from './journal.mjs';
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
}
