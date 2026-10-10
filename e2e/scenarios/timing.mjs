import { assert, blobSha, sources, storedBlob } from '../support/helpers.mjs';
import { TOKEN } from '../support/env.mjs';

const MiB = 1024 * 1024;
const one = async (env, size, name = 'f.bin') => sources(env, 'v1.0.0', [{ name, size }]);

export default [
  {
    id: 'upload-stall-retry',
    async run(env, t) {
      const src = await one(env, 48 * MiB);
      env.mock.faults.putStall = 1;
      const result = await env.runAction(env.sshInputs({ sources: src.input, 'stall-timeout': '3' }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.receipt.files[0].status, 'mirrored');
      assert.equal(result.receipt.files[0].attempts, 2);
      assert.equal(env.mock.count('upload_url'), 2, 'a fresh upload address for the retry');
      assert.equal(await blobSha(storedBlob(env, 'acme/mirror', 'v1.0.0', 'f.bin')), src.info['f.bin'].sha256);
      assert.match(result.stdout, /stalled/);
    },
  },
  {
    id: 'upload-stall-forever',
    async run(env, t) {
      const src = await one(env, 48 * MiB);
      env.mock.faults.putStall = Infinity;
      const result = await env.runAction(env.sshInputs({ sources: src.input, 'stall-timeout': '3', deadline: '90' }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].status, 'failed');
      assert.equal(result.receipt.files[0].stage, 'upload');
      assert.equal(env.mock.count('put'), 3, 'bounded retries');
      assert.ok(result.durationMs < 90_000);
    },
  },
  {
    id: 'body-sent-answer-late',
    async run(env, t) {
      const src = await one(env, 6 * MiB);
      env.mock.faults.answerDelayMs = 8000; // longer than the stall timeout
      const result = await env.runAction(env.sshInputs({ sources: src.input, 'stall-timeout': '3' }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(env.mock.count('put'), 1, 'a slow answer after a full body is not a stall');
    },
  },
  {
    id: 'answer-lost-after-registration',
    async run(env, t) {
      const src = await one(env, 6 * MiB);
      env.mock.faults.dropAnswer = 1;
      const result = await env.runAction(env.sshInputs({ sources: src.input, 'stall-timeout': '3' }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(env.mock.count('put'), 1, 'the registered upload is found and verified, not repeated');
      assert.equal(result.receipt.files[0].status, 'mirrored');
    },
  },
  {
    id: 'callback-late',
    async run(env, t) {
      const src = await one(env, 1 * MiB);
      env.mock.faults.callbackDelayMs = 7000;
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.receipt.files[0].status, 'mirrored');
      assert.equal(env.mock.count('put'), 1);
    },
  },
  {
    id: 'callback-never',
    async run(env, t) {
      const src = await one(env, 1 * MiB);
      env.mock.faults.callbackNever = true;
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].stage, 'register');
      assert.match(result.receipt.files[0].error, /did not appear/);
    },
  },
  {
    id: 'deadline',
    async run(env, t) {
      const src = await one(env, 1 * MiB);
      env.mock.faults.callbackNever = true;
      const result = await env.runAction(env.sshInputs({ sources: src.input, deadline: '12' }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].stage, 'deadline');
      assert.ok(result.durationMs < 30_000, `ended by itself at the deadline, took ${result.durationMs} ms`);
      assert.ok(result.receipt, 'a receipt is still produced');
    },
  },
  {
    id: 'retry-classification',
    async run(env, t) {
      const src = await one(env, 1024);
      // transient answers are retried
      env.mock.faults.status = { 'release.get': [429, 503], upload_url: [503] };
      const ok = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('transient', ok.receipt);
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.equal(env.mock.count('release.get') >= 3, true);
      // permanent answers are not
      for (const status of [401, 403]) {
        env.mock.reset();
        const again = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 1024 }]);
        env.mock.faults.status = { 'release.get': [status] };
        const bad = await env.runAction(env.sshInputs({ sources: again.input }));
        assert.equal(bad.code, 1);
        assert.equal(env.mock.count('release.get'), 1, `HTTP ${status} is not retried`);
        assert.equal(bad.receipt.files[0].status, 'failed');
      }
      // a wrong token
      env.mock.reset();
      const wrong = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 1024 }]);
      const denied = await env.runAction(env.sshInputs({ sources: wrong.input, token: `${TOKEN}-wrong` }));
      assert.equal(denied.code, 1);
      assert.equal(env.mock.count('unauthorized'), 1);
      // a repository GitCode does not know
      env.mock.reset();
      const missing = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 1024 }]);
      env.mock.faults.repositories = ['someone/else'];
      const notFound = await env.runAction(env.sshInputs({ sources: missing.input }));
      assert.equal(notFound.code, 1);
      assert.equal(notFound.receipt.files[0].status, 'failed');
    },
  },
];
