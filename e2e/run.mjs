// End-to-end suite. Usage: node e2e/run.mjs [scenario-id ...]
import { execFileSync } from 'node:child_process';
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
    env.setHostConfig({});
    const started = Date.now();
    const saved = {};
    const t = { save: (name, value) => { saved[name] = value; } };
    let error;
    try {
      await scenario.run(env, t);
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
  versions: { runnerNode: version(runnerNode), hostNode: version(hostNode), ssh: execFileSync('ssh', ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || 'see stderr', os: `${process.platform} ${release()}` },
  scope: {
    gitcode: 'mock server written from the public API pages',
    realGitCodeProof: false,
    githubRunner: 'not used; dist/index.mjs is run with the runner file protocol',
    network: 'real TLS on loopback with a test CA; only the destination of port 443 is redirected',
    ssh: 'real OpenSSH client and sshd on loopback, forced command installed by host/install.sh',
  },
  scenarios: results,
  passed: results.filter((r) => r.passed).length,
  failed,
};
writeFileSync(join(artifactDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const lines = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name !== 'SHA256SUMS') lines.push(`${createHash('sha256').update(readFileSync(full)).digest('hex')}  ${relative(ROOT, full)}`);
  }
};
walk(artifactDir);
for (const file of ['dist/index.mjs', 'lib/mirror-core.mjs', 'lib/host.mjs', 'action.yml']) {
  lines.push(`${createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')}  ${file}`);
}
writeFileSync(join(artifactDir, 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(`\n${manifest.passed} passed, ${failed} failed; evidence in ${relative(ROOT, artifactDir)}`);
process.exit(failed ? 1 : 0);
