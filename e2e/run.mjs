// End-to-end suite. Usage: node e2e/run.mjs [scenario-id ...]
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Env } from './support/env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);

const out = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const runnerNode = process.env.E2E_RUNNER_NODE || out('npx', ['-y', 'node@24', '-p', 'process.execPath']);
const hostNode = process.env.E2E_HOST_NODE || process.execPath;
const version = (bin) => out(bin, ['--version']);
const stderrOf = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.split('\n').find((l) => /OpenSSH/.test(l))?.trim() ?? 'unknown';
};

const scenarioFiles = readdirSync(join(ROOT, 'e2e/scenarios')).filter((f) => f.endsWith('.mjs')).sort();
const scenarios = [];
for (const file of scenarioFiles) scenarios.push(...(await import(`./scenarios/${file}`)).default);

const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
const artifactDir = join(ROOT, 'artifacts', runId);
mkdirSync(artifactDir, { recursive: true });

// Fail early on a stale bundle: the suite must test what would be published.
out('node', ['scripts/build.mjs', '--check']);

const env = new Env({ runnerNode, hostNode });
const results = [];
let failed = 0;
try {
  await env.start();
  for (const scenario of scenarios) {
    if (only.length > 0 && !only.includes(scenario.id)) continue;
    env.mock.reset();
    env.restoreHost();
    env.setHostConfig({});
    env.leaks = [];
    if (!env.sshd || env.sshd.exitCode !== null) { env.sshd = null; await env.startSshd(); }
    const started = Date.now();
    const saved = {};
    const t = { save: (name, value) => { saved[name] = value; } };
    let error;
    try {
      await scenario.run(env, t);
      const left = readdirSync(env.hostWork);
      if (left.length > 0) env.leaks.push(`host work directory not cleaned: ${left.join(', ')}`);
      if (env.leaks.length > 0) throw new Error(env.leaks.join('; '));
    } catch (e) {
      error = e;
    }
    const entry = { id: scenario.id, passed: !error, durationMs: Date.now() - started };
    if (error) {
      entry.error = String(error.stack || error).slice(0, 4000);
      failed += 1;
    }
    for (const [name, value] of Object.entries(saved)) {
      const file = `${scenario.id}.${name}.json`;
      writeFileSync(join(artifactDir, file), `${JSON.stringify(value, null, 2)}\n`);
      (entry.files ??= []).push(file);
    }
    results.push(entry);
    console.log(`${error ? 'FAIL' : 'ok  '} ${scenario.id} (${(entry.durationMs / 1000).toFixed(1)}s)${error ? `\n${entry.error}` : ''}`);
  }
} finally {
  await env.stop();
}

const coreSha = createHash('sha256').update(readFileSync(join(ROOT, 'lib/mirror-core.mjs'))).digest('hex');
let commit = 'none';
let clean = false;
try {
  commit = out('git', ['rev-parse', 'HEAD']);
  clean = out('git', ['status', '--porcelain']) === '';
} catch {}
const manifest = {
  schema: 1,
  runId,
  command: `node e2e/run.mjs${only.length ? ` ${only.join(' ')}` : ''}`,
  sourceCommit: commit,
  workingTreeClean: clean,
  coreSha256: coreSha,
  versions: { runnerNode: version(runnerNode), hostNode: version(hostNode), ssh: stderrOf('ssh', ['-V']), sshd: stderrOf('/usr/sbin/sshd', ['-V']), os: `${process.platform} ${release()}` },
  scope: {
    gitcode: 'mock server written from the public API pages',
    realGitCodeProof: false,
    githubRunner: 'not used; dist/index.mjs is run with the runner file protocol',
    network: 'real TLS on loopback with a test CA; only the destination of port 443 is redirected',
    ssh: 'real OpenSSH client and sshd on loopback, forced command installed by host/install.sh',
  },
  verify: 'cd <evidence dir> && shasum -a 256 -c SHA256SUMS; cd <repository root at sourceCommit> && shasum -a 256 -c <evidence dir>/SHA256SUMS.source',
  scenarios: results,
  passed: results.filter((r) => r.passed).length,
  failed,
};
writeFileSync(join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Evidence files are listed relative to the evidence directory; the files that
// were tested are listed relative to the repository root, so each list can be
// checked from its own base directory.
const sumLine = (base, full) => `${createHash('sha256').update(readFileSync(full)).digest('hex')}  ${relative(base, full)}`;
const evidence = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (!name.startsWith('SHA256SUMS')) evidence.push(sumLine(artifactDir, full));
  }
};
walk(artifactDir);
writeFileSync(join(artifactDir, 'SHA256SUMS'), `${evidence.join('\n')}\n`);
const tested = ['dist/index.mjs', 'dist/THIRD_PARTY_LICENSES.md', 'lib/mirror-core.mjs', 'lib/host.mjs', 'action.yml', 'host/install.sh'].map((f) => sumLine(ROOT, join(ROOT, f)));
writeFileSync(join(artifactDir, 'SHA256SUMS.source'), `${tested.join('\n')}\n`);
console.log(`\n${manifest.passed} passed, ${failed} failed; evidence in ${relative(ROOT, artifactDir)}`);
process.exit(failed ? 1 : 0);
