// Fixed trusted local fixture. Input is data, never imported or executed.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
const mode = typeof fixtureMode === 'string' ? fixtureMode : 'normal';
if (mode === 'hang' || mode === 'parent-exit') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { HOME: process.env.HOME },
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  process.stderr.write(`parent:${process.pid} descendant:${descendant.pid}\n`);
  if (mode === 'parent-exit') process.exit(0);
  setInterval(() => {}, 1000);
} else if (mode === 'stdout-flood' || mode === 'stderr-flood') {
  const stream = mode === 'stdout-flood' ? process.stdout : process.stderr;
  const chunk = Buffer.alloc(16384, 120);
  const pump = () => {
    while (stream.write(chunk)) {}
    stream.once('drain', pump);
  };
  pump();
} else {
  const maxFrame = 1_100_000;
  let pending = Buffer.alloc(0),
    frames = 0,
    valid = true;
  for await (const chunk of process.stdin) {
    if (pending.length + chunk.length > maxFrame + 4) throw Error('frame overflow');
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);
      if (length > maxFrame) throw Error('frame overflow');
      const frame = JSON.parse(pending.subarray(4, 4 + length).toString('utf8'));
      if (Object.keys(frame).sort().join(',') !== 'body,type') throw Error('fields');
      valid &&=
        frames === 0
          ? frame.type === 'invocation' && typeof frame.body === 'string'
          : frames === 1 &&
            frame.type === 'result' &&
            (frame.body === null || typeof frame.body === 'string');
      frames++;
      pending = pending.subarray(4 + length);
    }
  }
  valid &&= pending.length === 0 && frames === 2;
  valid &&= Object.keys(process.env).every((k) =>
    [
      'HOME',
      'PATH',
      'LANG',
      'TZ',
      ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
    ].includes(k),
  );
  valid &&= (await readdir(process.env.HOME)).length === 0 && process.cwd() === process.env.HOME;
  const body = Buffer.from(
    JSON.stringify({
      type: mode === 'unknown-diagnostic' ? 'upstream-request' : 'diagnostic',
      ok: valid,
    }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  process.stdout.write(header);
  process.stdout.write(body);
  if (mode === 'extra-diagnostic') {
    process.stdout.write(header);
    process.stdout.write(body);
  }
}
