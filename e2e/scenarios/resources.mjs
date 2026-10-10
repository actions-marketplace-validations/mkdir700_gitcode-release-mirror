import { readdirSync, readFileSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { assert, blobSha, localFile, sources, storedBlob, visible } from '../support/helpers.mjs';
import { TOKEN } from '../support/env.mjs';

const MiB = 1024 * 1024;
const LARGE = Number(process.env.E2E_LARGE_MIB || 400) * MiB;

function walkText(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walkText(full));
    else found.push([full, readFileSync(full, 'latin1')]);
  }
  return found;
}

export default [
  {
    id: 'secret-hygiene',
    async run(env, t) {
      const wrong = 'WRONGTOKEN_SENTINEL_91b7c2';
      const keyLines = env.clientKey.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'));
      assert.ok(keyLines.length >= 3);
      const src = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 4096 }]);
      const dir = env.path('hygiene');
      const local = await localFile(dir, 'f.bin', 4096);
      const runs = [
        // the mock repeats the token it was given inside its 401 answer
        await env.runAction(env.sshInputs({ sources: src.input, token: wrong })),
        await env.runAction({ transport: 'direct', repository: 'acme/mirror', tag: 'v1.0.0', token: wrong, files: local.path }),
        // successful runs with the real token
        await env.runAction(env.sshInputs({ sources: src.input })),
        await env.runAction({ transport: 'direct', repository: 'acme/mirror', tag: 'v9.0.0', token: TOKEN, files: local.path }),
      ];
      assert.notEqual(runs[0].code, 0);
      assert.notEqual(runs[1].code, 0);
      assert.equal(runs[2].code, 0);
      assert.equal(runs[3].code, 0);
      const secrets = [wrong, TOKEN, ...keyLines];
      const texts = [];
      for (const [i, r] of runs.entries()) {
        texts.push([`run${i} stdout`, visible(r.stdout)], [`run${i} stderr`, r.stderr], [`run${i} summary`, r.summary], [`run${i} ssh argv`, r.sshArgv]);
        for (const [k, v] of Object.entries(r.outputs)) texts.push([`run${i} output ${k}`, v]);
        for (const [file, text] of walkText(r.runDir)) if (!file.endsWith('/output')) texts.push([file, text]);
        assert.equal(readdirSync(r.tempDir).length, 0, 'the key file and temp directories are removed');
      }
      texts.push(['sshd log', env.sshdLog]);
      for (const [where, text] of texts) {
        for (const secret of secrets) assert.ok(!text.includes(secret), `a secret appears in ${where}`);
      }
      assert.ok(!env.mock.requests.some((r) => r.leakedCredential), 'no credential was sent to the object store');
      // the argv the runner gave ssh holds no secret and no token-shaped argument
      assert.ok(runs[2].sshArgv.includes('BatchMode=yes') && runs[2].sshArgv.includes('StrictHostKeyChecking=yes'));
      t.save('summary', { checked: texts.length, secretsChecked: secrets.length });
    },
  },
  {
    // Peak memory must not follow the file size. (Absolute numbers include the
    // runtime's own footprint, so the test compares a small and a large file.)
    id: 'large-file-streaming',
    async run(env, t) {
      const mem = {};
      const sizes = { small: 64 * MiB, large: LARGE };
      const timeFile = env.path('host-time.txt');
      for (const [label, size] of Object.entries(sizes)) {
        const file = await localFile(env.path('large'), `${label}.bin`, size, `direct-${label}`);
        const direct = await env.runAction(
          { transport: 'direct', repository: 'acme/mirror', tag: `v3.${label}`, token: TOKEN, files: file.path, 'stall-timeout': '60' },
          { measure: true },
        );
        assert.equal(direct.code, 0, direct.stdout + direct.stderr);
        assert.equal(await blobSha(storedBlob(env, 'acme/mirror', `v3.${label}`, `${label}.bin`)), file.sha256);
        mem[`direct${label}MiB`] = Math.round(direct.maxRssBytes / MiB);

        env.setForcedCommand(env.defaultHostCommand(`/usr/bin/time -l -o ${timeFile} `));
        const src = await sources(env, `v4.${label}`, [{ name: `${label}.bin`, size, seed: `host-${label}` }]);
        const viaHost = await env.runAction(env.sshInputs({ sources: src.input, tag: `v4.${label}`, 'stall-timeout': '60', deadline: '900' }));
        t.save(`receipt-${label}`, viaHost.receipt);
        assert.equal(viaHost.code, 0, viaHost.stdout + viaHost.stderr);
        assert.equal(await blobSha(storedBlob(env, 'acme/mirror', `v4.${label}`, `${label}.bin`)), src.info[`${label}.bin`].sha256);
        mem[`host${label}MiB`] = Math.round(Number(/(\d+)\s+maximum resident set size/.exec(readFileSync(timeFile, 'utf8'))[1]) / MiB);
      }
      t.save('memory', { fileMiB: { small: sizes.small / MiB, large: sizes.large / MiB }, ...mem, allowedGrowthMiB: 64 });
      assert.ok(mem.directlargeMiB - mem.directsmallMiB < 64, `direct run grew from ${mem.directsmallMiB} to ${mem.directlargeMiB} MiB`);
      assert.ok(mem.hostlargeMiB - mem.hostsmallMiB < 64, `host run grew from ${mem.hostsmallMiB} to ${mem.hostlargeMiB} MiB`);
    },
  },
  {
    id: 'ssh-transport-failure',
    async run(env, t) {
      const src = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 1024 }]);
      await env.stopSshd();
      const down = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('sshd-down', down.receipt);
      assert.equal(down.code, 1);
      assert.equal(down.receipt.files[0].status, 'failed');
      assert.equal(down.receipt.files[0].stage, 'host');
      assert.match(down.receipt.files[0].error, /outcome is unknown/);
      await env.startSshd();
      env.setForcedCommand(`sh -c 'echo partial output; exit 3'`);
      const dies = await env.runAction(env.sshInputs({ sources: src.input }));
      t.save('host-dies', dies.receipt);
      assert.equal(dies.code, 1);
      assert.equal(dies.receipt.files[0].stage, 'host');
      assert.equal(dies.outputs['failed-count'], '1');
    },
  },
  {
    id: 'port-forwarding-refused',
    async run(env) {
      const listener = await new Promise((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
      let touched = false;
      listener.on('connection', (s) => { touched = true; s.destroy(); });
      const local = await new Promise((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
      });
      await env.rawSsh(''); // makes sure rawssh/known_hosts exists
      const ssh = spawn('/usr/bin/ssh', ['-F', '/dev/null', '-N', '-i', env.path('sshd/client'), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${env.path('rawssh/known_hosts')}`, '-o', 'GlobalKnownHostsFile=/dev/null',
        '-L', `${local}:127.0.0.1:${listener.address().port}`, '-p', String(env.sshPort), '-l', userInfo().username, '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ssh.stderr.on('data', (d) => { stderr += d; });
      await new Promise((r) => setTimeout(r, 1500));
      const reply = await new Promise((resolve) => {
        const c = connect(local, '127.0.0.1');
        let got = false;
        c.on('data', () => { got = true; });
        c.on('error', () => resolve({ got, error: true }));
        c.on('close', () => resolve({ got, closed: true }));
        c.write('GET / HTTP/1.0\r\n\r\n');
        setTimeout(() => { c.destroy(); resolve({ got, timeout: true }); }, 4000);
      });
      ssh.kill();
      listener.close();
      assert.match(stderr, /administratively prohibited/, `the server did not refuse the forward (or it was never attempted): ${JSON.stringify(reply)} ${stderr}`);
      assert.equal(touched, false, `the forwarded connection reached its target (${JSON.stringify(reply)} ${stderr})`);
    },
  },
];
