// Separate trusted posting fixture: only validated result data enters stdin.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
let total = 0;
const hash = createHash('sha256');
for await (const chunk of process.stdin) {
  total += chunk.length;
  if (total > 1_000_000) throw Error('result limit');
  hash.update(chunk);
}
process.stdout.write(
  JSON.stringify({
    resultDigest: hash.digest('hex'),
    total,
    argv: process.argv,
    env: process.env,
    emptyHome: (await readdir(process.env.HOME)).length === 0,
    privateCwd: process.cwd() === process.env.HOME,
  }),
);
