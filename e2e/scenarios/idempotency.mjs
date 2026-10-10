import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, blobSha, generated, localFile, sources, storedBlob } from '../support/helpers.mjs';
import { digestOf } from '../support/data.mjs';
import { TOKEN } from '../support/env.mjs';

const MiB = 1024 * 1024;

export default [
  {
    id: 'direct-happy-and-rerun',
    async run(env, t) {
      const dir = env.path('direct-files');
      const a = await localFile(dir, 'a.bin', 3 * MiB);
      const b = await localFile(dir, 'b.bin', 5000);
      await localFile(dir, 'ignored.txt', 10);
      const inputs = { transport: 'direct', repository: 'acme/mirror', tag: 'v2.0.0', token: TOKEN, files: `${dir}/*.bin`, 'stall-timeout': '10' };
      const first = await env.runAction(inputs);
      t.save('first', first.receipt);
      assert.equal(first.code, 0, first.stdout + first.stderr);
      assert.deepEqual(first.receipt.files.map((f) => f.status).sort(), ['mirrored', 'mirrored']);
      assert.equal(await blobSha(storedBlob(env, 'acme/mirror', 'v2.0.0', 'a.bin')), a.sha256);
      assert.equal(await blobSha(storedBlob(env, 'acme/mirror', 'v2.0.0', 'b.bin')), b.sha256);
      assert.equal(env.mock.release('acme/mirror', 'v2.0.0').assets.length, 2, 'ignored.txt must not be uploaded');
      const puts = env.mock.count('put');
      const second = await env.runAction(inputs);
      t.save('second', second.receipt);
      assert.equal(second.code, 0, second.stdout + second.stderr);
      assert.deepEqual(second.receipt.files.map((f) => f.status).sort(), ['reused', 'reused']);
      assert.equal(env.mock.count('put'), puts);
    },
  },
  {
    id: 'direct-symlink-and-empty-glob-rejected',
    async run(env) {
      const dir = env.path('direct-links');
      const real = await localFile(dir, 'real.bin', 100);
      symlinkSync(real.path, join(dir, 'link.bin'));
      const base = { transport: 'direct', repository: 'acme/mirror', tag: 'v2.1.0', token: TOKEN };
      const linked = await env.runAction({ ...base, files: `${dir}/link.bin` });
      assert.notEqual(linked.code, 0);
      assert.match(linked.stdout, /not a regular file/);
      const none = await env.runAction({ ...base, files: `${dir}/*.nothing` });
      assert.notEqual(none.code, 0);
      assert.match(none.stdout, /matched nothing/);
      assert.equal(env.mock.gitcodeRequests().length, 0);
    },
  },
  {
    id: 'same-name-different-bytes',
    async run(env, t) {
      const other = generated(1000, 'someone-else');
      await env.mock.seedAsset('acme/mirror', 'v1.0.0', 'a.bin', other, await digestOf(other));
      const src = await sources(env, 'v1.0.0', [{ name: 'a.bin', size: 2048 }, { name: 'b.bin', size: 2048 }]);
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.outputs['failed-count'], '1');
      const [a, b] = result.receipt.files;
      assert.equal(a.status, 'failed');
      assert.equal(a.stage, 'conflict');
      assert.equal(b.status, 'mirrored');
      assert.equal(env.mock.count('put'), 1, 'only b.bin was uploaded');
      assert.ok(!env.mock.requests.some((r) => r.method === 'DELETE'), 'nothing is ever deleted');
      assert.equal(await blobSha(storedBlob(env, 'acme/mirror', 'v1.0.0', 'a.bin')), await digestOf(other));
    },
  },
  {
    id: 'concurrent-same-tag',
    async run(env, t) {
      const src = await sources(env, 'v1.0.0', [{ name: 'one.bin', size: 6 * MiB }, { name: 'two.bin', size: 3 * MiB }]);
      // 1. the answer a loser of the creation race gets
      env.mock.faults.raceCreate = true;
      const raced = await env.runAction(env.sshInputs({ sources: src.input }));
      assert.equal(raced.code, 0, raced.stdout + raced.stderr);
      assert.equal(raced.receipt.releaseCreated, false, 'another run created it');
      // 2. two real runs at once, on a fresh tag
      const src2 = await sources(env, 'v1.1.0', [{ name: 'one.bin', size: 6 * MiB }, { name: 'two.bin', size: 3 * MiB }]);
      const inputs = env.sshInputs({ sources: src2.input, tag: 'v1.1.0' });
      const [x, y] = await Promise.all([env.runAction(inputs), env.runAction(inputs)]);
      t.save('x', x.receipt);
      t.save('y', y.receipt);
      assert.equal(x.code, 0, x.stdout + x.stderr);
      assert.equal(y.code, 0, y.stdout + y.stderr);
      assert.equal(env.mock.repos.get('acme/mirror').size, 2, 'one release per tag');
      for (const name of ['one.bin', 'two.bin']) {
        assert.equal(await blobSha(storedBlob(env, 'acme/mirror', 'v1.1.0', name)), src2.info[name].sha256);
      }
    },
  },
  {
    id: 'concurrent-different-bytes',
    async run(env, t) {
      const a = await sources(env, 'srcA', [{ name: 'x.bin', size: 8 * MiB, seed: 'A' }]);
      const b = await sources(env, 'srcB', [{ name: 'x.bin', size: 8 * MiB, seed: 'B' }]);
      const [ra, rb] = await Promise.all([
        env.runAction(env.sshInputs({ sources: a.input })),
        env.runAction(env.sshInputs({ sources: b.input })),
      ]);
      t.save('a', ra.receipt);
      t.save('b', rb.receipt);
      const stored = await blobSha(storedBlob(env, 'acme/mirror', 'v1.0.0', 'x.bin'));
      assert.ok([a.info['x.bin'].sha256, b.info['x.bin'].sha256].includes(stored), 'GitCode holds exactly one declared version');
      assert.ok(ra.code === 0 || rb.code === 0, 'at least one run succeeds');
      for (const r of [ra, rb]) {
        const f = r.receipt.files[0];
        if (f.status === 'failed') assert.ok(['conflict', 'verify'].includes(f.stage), `unexpected failure stage ${f.stage}: ${f.error}`);
      }
    },
  },
];
