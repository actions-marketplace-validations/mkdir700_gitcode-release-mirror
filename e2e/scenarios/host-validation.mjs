import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assert, sources, visible } from '../support/helpers.mjs';
import { TOKEN } from '../support/env.mjs';

const CORE = createHash('sha256').update(readFileSync(new URL('../../lib/mirror-core.mjs', import.meta.url))).digest('hex');
const GOOD_URL = 'https://downloads.example.test/artifacts/v1.0.0/f.bin';
const SHA = 'a'.repeat(64);

const valid = (overrides = {}) => ({
  version: 1, coreSha256: CORE, repository: 'acme/mirror', tag: 'v1.0.0', prerelease: false, targetCommitish: 'main',
  apiBase: 'https://api.gitcode.com/api/v5', token: TOKEN, stallSeconds: 10, deadlineSeconds: 60,
  sources: [{ url: GOOD_URL, sha256: SHA }], ...overrides,
});
const line = (request) => `${JSON.stringify(request)}\n`;

// Every case must be refused by the host before any outbound request.
async function refused(env, label, stdin) {
  const before = env.mock.requests.length;
  const result = await env.rawSsh(stdin);
  assert.equal(result.code, 2, `${label}: expected a rejection, got ${result.code}: ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /mirror-host rejected:/, label);
  assert.equal(env.mock.requests.length, before, `${label}: the host made a network request`);
  assert.ok(!result.stdout.includes(TOKEN), `${label}: the token was echoed`);
}

const withSources = (...urls) => valid({ sources: urls.map((url) => ({ url, sha256: SHA })) });
const base = 'https://downloads.example.test/artifacts/v1.0.0/';

export default [
  {
    id: 'host-bad-names',
    async run(env) {
      const names = [
        '..%2Fx', 'a%2Fb', 'a%5Cb', '%2e%2e', '.hidden', 'a%00b', 'a%20b', 'x%3Brm', '%24%28touch%20CANARY%29', 'a'.repeat(200),
        '', '-rf', 'a%0Ab', 'caf%C3%A9.bin', 'a..b',
      ];
      for (const name of names) await refused(env, `name ${JSON.stringify(name).slice(0, 30)}`, line(withSources(`${base}${name}`)));
      await refused(env, 'duplicate names', line(withSources(`${base}f.bin`, `${base}f.bin`)));
    },
  },
  {
    id: 'host-bad-urls',
    async run(env) {
      const urls = [
        'http://downloads.example.test/artifacts/v1.0.0/f.bin',
        'https://evil.example.test/artifacts/v1.0.0/f.bin',
        'https://u:p@downloads.example.test/artifacts/v1.0.0/f.bin',
        'https://downloads.example.test:8443/artifacts/v1.0.0/f.bin',
        `${GOOD_URL}#fragment`,
        'https://downloads.example.test/artifacts/../secret/f.bin',
        'https://downloads.example.test/artifacts/%2e%2e/secret/f.bin',
        'https://downloads.example.test/artifacts/v1%2f..%2f/f.bin',
        'https://downloads.example.test/artifacts-evil/f.bin',
        'https://downloads.example.test.evil.example.test/artifacts/v1.0.0/f.bin',
        'ftp://downloads.example.test/artifacts/f.bin',
        'file:///etc/passwd',
        `${base}${'a'.repeat(3000)}`,
      ];
      for (const url of urls) await refused(env, `url ${url.slice(0, 60)}`, line(withSources(url)));
    },
  },
  {
    id: 'host-bad-target',
    async run(env) {
      const cases = {
        'repository not allowed': { repository: 'other/repo' },
        'repository malformed': { repository: 'bad repo' },
        'repository traversal': { repository: '../x/y' },
        'tag traversal': { tag: '../x' },
        'tag shell': { tag: 'v1;touch CANARY' },
        'tag substitution': { tag: 'v1$(touch CANARY)' },
        'branch option': { targetCommitish: '--evil' },
        'branch traversal': { targetCommitish: 'a/../b' },
        'api base other host': { apiBase: 'https://evil.example.test/api/v5' },
        'api base http': { apiBase: 'http://api.gitcode.com/api/v5' },
        'api base port': { apiBase: 'https://api.gitcode.com:8443/api/v5' },
        'api base lookalike': { apiBase: 'https://api.gitcode.com.evil.example.test/api/v5' },
        'api base userinfo': { apiBase: 'https://x@api.gitcode.com/api/v5' },
        'api base query': { apiBase: 'https://api.gitcode.com/api/v5?x=1' },
      };
      for (const [label, overrides] of Object.entries(cases)) await refused(env, label, line(valid(overrides)));
    },
  },
  {
    id: 'host-bad-request',
    async run(env) {
      const good = valid();
      const cases = {
        'not json': 'hello\n',
        'empty': '',
        'no newline': JSON.stringify(good),
        'two lines': `${line(good)}${line(good)}`,
        'trailing data': `${line(good)}rm -rf /\n`,
        'array': '[]\n',
        'unknown field': line({ ...good, extra: 1 }),
        'unknown source field': line(valid({ sources: [{ url: GOOD_URL, sha256: SHA, name: 'x' }] })),
        'version 2': line({ ...good, version: 2 }),
        'prerelease string': line({ ...good, prerelease: 'yes' }),
        'stall zero': line({ ...good, stallSeconds: 0 }),
        'deadline small': line({ ...good, deadlineSeconds: 5 }),
        'deadline huge': line({ ...good, deadlineSeconds: 999999 }),
        'token space': line({ ...good, token: 'a b' }),
        'token newline': line({ ...good, token: 'a\nb' }),
        'token missing': line({ ...good, token: undefined }),
        'no sources': line({ ...good, sources: [] }),
        'too many sources': line({ ...good, sources: Array.from({ length: 51 }, (_, i) => ({ url: `${base}f${i}.bin`, sha256: SHA })) }),
        'uppercase digest': line(valid({ sources: [{ url: GOOD_URL, sha256: 'A'.repeat(64) }] })),
        'short digest': line(valid({ sources: [{ url: GOOD_URL, sha256: 'abc' }] })),
        'core digest short': line({ ...good, coreSha256: 'abc' }),
        'oversized': `${'x'.repeat(70 * 1024)}\n`,
      };
      for (const [label, stdin] of Object.entries(cases)) await refused(env, label, stdin);
    },
  },
  {
    id: 'host-injection',
    async run(env) {
      const canary = env.path('CANARY');
      const hostile = ['v1$(touch %s)', 'v1`touch %s`', 'v1;touch %s', 'v1|touch %s', 'v1&&touch %s', 'v1\ntouch %s'];
      for (const pattern of hostile) {
        const tag = pattern.replace('%s', canary);
        await refused(env, `tag ${JSON.stringify(pattern)}`, line(valid({ tag })));
        await refused(env, `file ${JSON.stringify(pattern)}`, line(withSources(`${base}${encodeURIComponent(pattern.replace('%s', canary))}`)));
      }
      // with a command: the key only ever runs the forced command
      const result = await env.rawSsh(line(valid()), { command: `touch ${canary}` });
      assert.equal(result.code, 2);
      assert.match(result.stdout, /only runs the mirror/);
      assert.ok(!existsSync(canary), 'nothing from the requests was executed');
    },
  },
  {
    id: 'forced-command-only',
    async run(env) {
      const canary = env.path('CANARY-FORCED');
      const attempts = [
        { label: 'other command', opts: { command: `touch ${canary}` } },
        { label: 'shell via command', opts: { command: 'sh -c "touch ' + canary + '"' } },
        { label: 'agent forwarding', opts: { args: ['-A'] } },
        { label: 'X11 forwarding', opts: { args: ['-X'] } },
      ];
      for (const { label, opts } of attempts) {
        const result = await env.rawSsh('', opts);
        assert.equal(result.code, 2, `${label}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /mirror-host rejected:/, label);
      }
      const pty = await env.rawSsh('', { args: ['-tt'] });
      assert.notEqual(pty.code, 0);
      assert.match(pty.stderr, /PTY allocation request failed/);
      assert.ok(!existsSync(canary));
      assert.equal(env.mock.requests.length, 0);
    },
  },
  {
    id: 'ssh-option-injection',
    async run(env) {
      const canary = env.path('CANARY-OPTION');
      const src = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 1024 }]);
      const cases = [
        { 'ssh-host': `-oProxyCommand=touch ${canary}` },
        { 'ssh-host': `127.0.0.1 -oProxyCommand=touch ${canary}` },
        { 'ssh-host': `host;touch ${canary}` },
        { 'ssh-user': `-oProxyCommand=touch ${canary}` },
        { 'ssh-user': 'root; touch x' },
        { 'ssh-port': '22; touch x' },
        { 'ssh-port': '70000' },
      ];
      for (const extra of cases) {
        const result = await env.runAction(env.sshInputs({ sources: src.input, ...extra }));
        assert.notEqual(result.code, 0, JSON.stringify(extra));
        assert.equal(result.sshArgv, '', `ssh must not even start for ${JSON.stringify(extra)}`);
      }
      assert.ok(!existsSync(canary));
    },
  },
  {
    id: 'ssh-identity',
    async run(env) {
      const src = await sources(env, 'v1.0.0', [{ name: 'f.bin', size: 1024 }]);
      const marker = env.path('host-invocations.log');
      // the forced command records every time sshd actually starts it
      env.setForcedCommand(`sh -c 'echo started >> ${marker}'`);
      const wrongKey = await env.runAction(env.sshInputs({ sources: src.input, 'ssh-key': env.otherKey }));
      const wrongHost = await env.runAction(env.sshInputs({ sources: src.input, 'ssh-known-hosts': env.wrongKnownHosts }));
      const noHosts = await env.runAction(env.sshInputs({ sources: src.input, 'ssh-known-hosts': '' }));
      for (const [label, r] of [['wrong key', wrongKey], ['wrong host key', wrongHost], ['no known_hosts', noHosts]]) {
        assert.notEqual(r.code, 0, label);
        assert.ok(!visible(r.stdout).includes(TOKEN) && !r.stderr.includes(TOKEN), label);
      }
      assert.match(wrongHost.stdout + wrongHost.stderr, /Host key verification failed|REMOTE HOST IDENTIFICATION/);
      assert.match(wrongKey.stdout + wrongKey.stderr, /Permission denied/);
      assert.ok(!existsSync(marker), 'the host command never ran for a wrong identity');
      assert.equal(env.mock.requests.length, 0);
    },
  },
];
