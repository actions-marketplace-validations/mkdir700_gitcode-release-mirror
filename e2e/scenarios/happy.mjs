import { assert, blobSha, sources, storedBlob } from '../support/helpers.mjs';

const MiB = 1024 * 1024;

export default [
  {
    id: 'ssh-happy',
    async run(env, t) {
      const src = await sources(env, 'v1.0.0', [{ name: 'small.bin', size: 4096 }, { name: 'big.bin', size: 24 * MiB }]);
      const result = await env.runAction(env.sshInputs({ sources: src.input, prerelease: 'true' }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.outputs['failed-count'], '0');
      assert.deepEqual(result.receipt.files.map((f) => f.status), ['mirrored', 'mirrored']);
      for (const name of ['small.bin', 'big.bin']) {
        const blob = storedBlob(env, 'acme/mirror', 'v1.0.0', name);
        assert.equal(await blobSha(blob), src.info[name].sha256, `${name} bytes on the mock`);
        assert.equal(blob.size, src.info[name].size);
      }
      assert.equal(env.mock.count('release.create'), 1);
      assert.equal(env.mock.release('acme/mirror', 'v1.0.0').status, 'pre');
      assert.equal(env.mock.count('upload_url'), 2);
      assert.equal(env.mock.count('put'), 2);
      assert.ok(result.receipt.files.every((f) => f.downloadUrl?.startsWith('https://gitcode.com/acme/mirror/')));
      assert.match(result.summary, /small\.bin/);
    },
  },
  {
    id: 'ssh-rerun-reuse',
    async run(env, t) {
      const src = await sources(env, 'v1.0.0', [{ name: 'small.bin', size: 4096 }, { name: 'big.bin', size: 6 * MiB }]);
      const inputs = env.sshInputs({ sources: src.input });
      const first = await env.runAction(inputs);
      assert.equal(first.code, 0, first.stdout + first.stderr);
      const putsBefore = env.mock.count('put');
      const sourceBefore = env.mock.count('source');
      const second = await env.runAction(inputs);
      t.save('receipt', second.receipt);
      assert.equal(second.code, 0, second.stdout + second.stderr);
      assert.deepEqual(second.receipt.files.map((f) => f.status), ['reused', 'reused']);
      assert.equal(env.mock.count('put'), putsBefore, 'no new upload');
      assert.equal(env.mock.count('source'), sourceBefore, 'sources not downloaded again');
      assert.equal(env.mock.count('release.create'), 1);
    },
  },
];
