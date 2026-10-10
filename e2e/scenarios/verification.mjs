import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assert, blobSha, generated, sources, storedBlob } from '../support/helpers.mjs';
import { digestOf } from '../support/data.mjs';

const MiB = 1024 * 1024;
const one = (env, size = 2048, name = 'f.bin') => sources(env, 'v1.0.0', [{ name, size }]);

export default [
  {
    id: 'source-hash-mismatch',
    async run(env, t) {
      const src = await one(env);
      env.mock.faults.source = { 'f.bin': 'wrong' };
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].stage, 'source');
      assert.match(result.receipt.files[0].error, /expected/);
      assert.equal(env.mock.count('put'), 0);
      assert.equal(env.mock.count('release.create'), 0, 'nothing verified, so GitCode is not touched');
    },
  },
  {
    id: 'source-lies-about-length',
    async run(env, t) {
      const src = await one(env, 8 * MiB);
      env.mock.faults.source = { 'f.bin': 'short' };
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].stage, 'source');
      assert.equal(env.mock.count('put'), 0);
    },
  },
  {
    id: 'host-core-mismatch',
    async run(env, t) {
      const src = await one(env);
      env.swapInstalledCore('// not the core the Action ships\n');
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.match(result.stdout, /out of date/);
      assert.match(result.receipt.files[0].error, /rejected the request/);
      assert.doesNotMatch(result.receipt.files[0].error, /repeating is safe/);
      assert.equal(env.mock.requests.length, 0, 'the host did nothing before refusing');
    },
  },
  {
    id: 'host-claims-wrong-hash',
    async run(env, t) {
      const src = await one(env);
      const lie = `${JSON.stringify({ files: [{ name: 'f.bin', status: 'mirrored', sha256: '0'.repeat(64), size: 2048 }] })}`;
      env.setForcedCommand(`printf '%s\\n' '::receipt::${lie}'`);
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].status, 'failed');
      assert.equal(result.receipt.files[0].stage, 'hash-binding');
    },
  },
  {
    id: 'dist-integrity',
    async run(env, t) {
      const src = await one(env);
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const core = createHash('sha256').update(readFileSync(fileURLToPath(new URL('../../lib/mirror-core.mjs', import.meta.url)))).digest('hex');
      const installed = createHash('sha256').update(readFileSync(`${env.hostDir}/mirror-core.mjs`)).digest('hex');
      assert.equal(result.receipt.coreSha256, core);
      assert.equal(installed, core, 'the installed host core is the shipped core');
      t.save('hashes', { core, installed });
    },
  },
  {
    id: 'readback-corrupt',
    async run(env, t) {
      const src = await one(env);
      env.mock.faults.readback = 'corrupt';
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].stage, 'verify');
      assert.equal(result.receipt.files[0].downloadUrl, undefined);
      assert.ok(storedBlob(env, 'acme/mirror', 'v1.0.0', 'f.bin'), 'the asset is left alone, not deleted');
      assert.ok(!env.mock.requests.some((r) => r.method === 'DELETE'));
    },
  },
  {
    id: 'readback-redirect-http',
    async run(env, t) {
      const src = await one(env);
      env.mock.faults.readback = 'http';
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.equal(result.receipt.files[0].stage, 'verify');
      assert.match(result.receipt.files[0].error, /non-https/);
    },
  },
  {
    id: 'readback-redirect-loop',
    async run(env, t) {
      const src = await one(env);
      env.mock.faults.readback = 'loop';
      const result = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('receipt', result.receipt);
      assert.equal(result.code, 1);
      assert.match(result.receipt.files[0].error, /too many redirects/);
    },
  },
  {
    id: 'source-redirect-rules',
    async run(env, t) {
      const make = async (kind, name) => {
        const data = generated(4096, name);
        const sha = await digestOf(data);
        env.mock.addSource(kind, name, data, sha);
        return { url: `https://downloads.example.test/redir/${kind}/${kind}/${name}`, sha256: sha };
      };
      const run = async (prefixes, kind) => {
        env.mock.reset();
        env.setHostConfig({ allowedSourcePrefixes: prefixes });
        const entry = await make(kind, `${kind}.bin`);
        // redirect "in" lands on /artifacts/in/<name>
        env.mock.addSource(kind, `${kind}.bin`, generated(4096, `${kind}.bin`), entry.sha256);
        return env.runAction(env.sshInputs({ sources: JSON.stringify([entry]) }));
      };
      const redirectOnly = ['https://downloads.example.test/redir/'];
      const both = [...redirectOnly, 'https://downloads.example.test/artifacts/'];
      const followed = await run(both, 'in');
      t.save('followed', followed.receipt);
      assert.equal(followed.code, 0, followed.stdout + followed.stderr);
      for (const kind of ['in', 'out', 'http', 'loop']) {
        const denied = kind === 'in' ? await run(redirectOnly, 'in') : await run(both, kind);
        t.save(`denied-${kind}`, denied.receipt);
        assert.equal(denied.code, 1, `${kind} must be refused`);
        assert.equal(denied.receipt.files[0].stage, 'source');
        assert.equal(env.mock.count('put'), 0);
      }
    },
  },
];
