// The test environment: private CA, mock servers, a throw-away sshd with the
// real forced-command installation, and a way to run the Action like a runner.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Mock } from './mock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TOKEN = 'gcp_TESTTOKEN_7f3a9c1e5b2d4a6f';
export const KEY_SENTINEL = 'SENTINELKEYBODYzzzz0123456789abcdef';
const NAMES = ['api.gitcode.com', 'api.atomgit.com', 'gitcode.com', 'file-cdn.gitcode.com', 'upload.gitcode.com', 'downloads.example.test', 'evil.example.test'];

const sh = (file, args, options = {}) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

export class Env {
  constructor({ runnerNode, hostNode }) {
    this.runnerNode = runnerNode;
    this.hostNode = hostNode;
    this.root = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'gcrm-e2e-'));
    this.processes = [];
  }

  path(...parts) {
    return join(this.root, ...parts);
  }

  async start() {
    this.makePki();
    this.mock = new Mock({
      tls: { key: readFileSync(this.path('pki/server.key')), cert: readFileSync(this.path('pki/server.pem')) },
      dataDir: this.path('mock-data'),
      token: TOKEN,
    });
    await this.mock.start();
    this.preload = join(ROOT, 'e2e/support/preload.mjs');
    this.installHost();
    await this.startSshd();
  }

  makePki() {
    const dir = this.path('pki');
    mkdirSync(dir, { recursive: true });
    const run = (args) => sh('openssl', args, { cwd: dir });
    run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=gcrm-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE']);
    run(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=gcrm-test-server']);
    writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=${NAMES.map((n) => `DNS:${n}`).join(',')}\nbasicConstraints=CA:FALSE\n`);
    run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'ext.cnf']);
    this.caFile = join(dir, 'ca.pem');
  }

  // Runs the shipped installer; only the verification-friendly permissions differ from production.
  installHost() {
    this.hostDir = this.path('host/opt');
    this.hostConfigDir = this.path('host/etc');
    this.hostWork = this.path('host/tmp');
    mkdirSync(this.hostWork, { recursive: true });
    const output = sh('sh', [join(ROOT, 'host/install.sh'), '--prefix', this.hostDir, '--config-dir', this.hostConfigDir], { env: { ...process.env, PATH: `${dirname(this.hostNode)}:${process.env.PATH}` } }).toString();
    this.installerOutput = output;
    this.authorizedTemplate = output.split('\n').find((l) => l.startsWith('restrict,command='));
    this.setHostConfig({});
  }

  lock(paths) {
    for (const p of paths) chmodSync(p, existsSync(p) && p.endsWith('.json') ? 0o444 : 0o555);
  }

  setHostConfig(overrides) {
    chmodSync(this.hostConfigDir, 0o755);
    const config = {
      allowedRepositories: ['acme/mirror'],
      allowedSourcePrefixes: ['https://downloads.example.test/artifacts/'],
      tmpDir: this.hostWork,
      ...overrides,
    };
    const file = join(this.hostConfigDir, 'config.json');
    if (existsSync(file)) chmodSync(file, 0o644);
    writeFileSync(file, JSON.stringify(config, null, 2));
    chmodSync(file, 0o444);
    chmodSync(this.hostConfigDir, 0o555);
    chmodSync(this.hostDir, 0o555);
  }

  // Replaces the installed core with other bytes (and restores the real one).
  swapInstalledCore(text) {
    chmodSync(this.hostDir, 0o755);
    const file = join(this.hostDir, 'mirror-core.mjs');
    chmodSync(file, 0o644);
    writeFileSync(file, text ?? readFileSync(join(ROOT, 'lib/mirror-core.mjs')));
    chmodSync(file, 0o444);
    chmodSync(this.hostDir, 0o555);
    this.coreSwapped = text !== undefined;
  }

  async startSshd() {
    const dir = this.path('sshd');
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'hostkey'))) {
      sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'hostkey')]);
      sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gcrm-e2e-client', '-f', join(dir, 'client')]);
      sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gcrm-e2e-other', '-f', join(dir, 'other')]);
      sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'wronghostkey')]);
    }
    this.sshPort ??= await freePort();
    const publicKey = readFileSync(join(dir, 'client.pub'), 'utf8').trim();
    this.publicKey = publicKey;
    this.setForcedCommand(null);
    writeFileSync(join(dir, 'sshd_config'), [
      `Port ${this.sshPort}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'hostkey')}`,
      `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`, `PidFile ${join(dir, 'sshd.pid')}`,
      'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes',
      'StrictModes no', 'LogLevel ERROR', '',
    ].join('\n'));
    this.sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.sshdLog = '';
    this.sshd.once('exit', (code, signal) => { this.sshdExit = { code, signal }; });
    this.sshd.stderr.on('data', (d) => { this.sshdLog += d; });
    await new Promise((resolveWait, reject) => {
      const deadline = Date.now() + 10_000;
      const probe = () => {
        const socket = createServer();
        socket.once('error', () => resolveWait()); // port taken: sshd is listening
        socket.listen(this.sshPort, '127.0.0.1', () => socket.close(() => (Date.now() > deadline ? reject(new Error('sshd did not start')) : setTimeout(probe, 100))));
      };
      probe();
    });
    this.knownHosts = `[127.0.0.1]:${this.sshPort} ${readFileSync(join(dir, 'hostkey.pub'), 'utf8').trim()}\n`;
    this.wrongKnownHosts = `[127.0.0.1]:${this.sshPort} ${readFileSync(join(dir, 'wronghostkey.pub'), 'utf8').trim()}\n`;
    this.clientKey = readFileSync(join(dir, 'client'), 'utf8');
    this.otherKey = readFileSync(join(dir, 'other'), 'utf8');
  }

  // The default is the line host/install.sh prints, plus the environment that points the host process at the test CA and mock.
  // A custom command stands in for the host in the scenarios that need a different or instrumented one.
  setForcedCommand(command) {
    const prefix = `env NODE_OPTIONS='--import ${this.preload}' NODE_EXTRA_CA_CERTS=${this.caFile} MOCK_PORT=${this.mock.port} `;
    const line = command
      ? `restrict,command="${command.replace(/"/g, '\\"')}" ${this.publicKey}`
      : this.authorizedTemplate.replace('command="', `command="${prefix}`).replace('<ssh-ed25519 public key>', this.publicKey);
    writeFileSync(this.path('sshd/authorized_keys'), `${line}\n`, { mode: 0o600 });
  }

  // The default forced command, optionally behind a wrapper (for example /usr/bin/time).
  defaultHostCommand(wrapper = '') {
    const m = /^restrict,command="([^"]*)"/.exec(this.authorizedTemplate);
    const [nodeBin, ...rest] = m[1].split(' ');
    const env = `env NODE_OPTIONS='--import ${this.preload}' NODE_EXTRA_CA_CERTS=${this.caFile} MOCK_PORT=${this.mock.port}`;
    return `${wrapper}${env} ${nodeBin} ${rest.join(' ')}`;
  }

  // Talks to the host the way the Action does, without the Action: raw bytes on stdin.
  rawSsh(stdin, { key = 'client', knownHosts = this.knownHosts, args = [], command } = {}) {
    const dir = this.path('rawssh');
    mkdirSync(dir, { recursive: true });
    const hosts = join(dir, 'known_hosts');
    writeFileSync(hosts, knownHosts);
    const sshArgs = ['-F', '/dev/null', '-i', this.path('sshd', key), '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=10',
      ...args, '-p', String(this.sshPort), '-l', userInfo().username, '127.0.0.1', ...(command ? [command] : [])];
    return new Promise((done) => {
      const child = spawn('/usr/bin/ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
  }

  restoreHost() {
    this.setForcedCommand(null);
    if (this.coreSwapped) this.swapInstalledCore();
    this.coreSwapped = false;
  }

  async stopSshd() {
    if (!this.sshd) return;
    const child = this.sshd;
    this.sshd = null;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((done) => {
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    });
  }

  sshInputs(extra = {}) {
    return {
      transport: 'ssh',
      repository: 'acme/mirror',
      tag: 'v1.0.0',
      token: TOKEN,
      'ssh-host': '127.0.0.1',
      'ssh-user': userInfo().username,
      'ssh-port': String(this.sshPort),
      'ssh-key': this.clientKey,
      'ssh-known-hosts': this.knownHosts,
      'stall-timeout': '10',
      deadline: '120',
      ...extra,
    };
  }

  // Runs dist/index.mjs the way the GitHub runner does.
  async runAction(inputs, { env = {}, timeoutMs = 600_000, wrapSsh = true, measure = false } = {}) {
    const runDir = mkdtempSync(join(this.root, 'run-'));
    const files = { out: join(runDir, 'output'), summary: join(runDir, 'summary.md'), temp: join(runDir, 'temp'), argv: join(runDir, 'ssh-argv.log') };
    mkdirSync(files.temp);
    writeFileSync(files.out, '');
    writeFileSync(files.summary, '');
    writeFileSync(files.argv, '');
    const shimDir = join(runDir, 'shim');
    mkdirSync(shimDir);
    const realSsh = '/usr/bin/ssh';
    writeFileSync(join(shimDir, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${files.argv}"\nexec ${realSsh} "$@"\n`, { mode: 0o755 });
    const childEnv = {
      PATH: `${wrapSsh ? shimDir + ':' : ''}${process.env.PATH}`,
      HOME: process.env.HOME,
      GITHUB_OUTPUT: files.out,
      GITHUB_STEP_SUMMARY: files.summary,
      RUNNER_TEMP: files.temp,
      GITHUB_ACTIONS: 'true',
      NODE_OPTIONS: `--import ${this.preload}`,
      NODE_EXTRA_CA_CERTS: this.caFile,
      MOCK_PORT: String(this.mock.port),
      ...env,
    };
    // The runner fills in the defaults declared in action.yml.
    const declared = parseYaml(readFileSync(join(ROOT, 'action.yml'), 'utf8')).inputs;
    const all = { ...Object.fromEntries(Object.entries(declared).filter(([, v]) => v.default !== undefined).map(([k, v]) => [k, v.default])), ...inputs };
    for (const [name, value] of Object.entries(all)) {
      if (value !== undefined) childEnv[`INPUT_${name.toUpperCase()}`] = String(value);
    }
    const started = Date.now();
    const entry = [join(ROOT, 'dist/index.mjs')];
    const child = measure
      ? spawn('/usr/bin/time', ['-l', '-o', join(runDir, 'time.txt'), this.runnerNode, ...entry], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: runDir })
      : spawn(this.runnerNode, entry, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: runDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const code = await new Promise((done) => child.on('close', done));
    clearTimeout(timer);
    const outputs = parseOutputs(readFileSync(files.out, 'utf8'));
    const left = readdirSync(files.temp);
    if (left.length > 0) (this.leaks ??= []).push(`runner temp not cleaned: ${left.join(', ')}`);
    return {
      code, stdout, stderr, outputs, runDir, tempDir: files.temp, durationMs: Date.now() - started,
      summary: readFileSync(files.summary, 'utf8'),
      sshArgv: readFileSync(files.argv, 'utf8'),
      maxRssBytes: measure ? Number(/(\d+)\s+maximum resident set size/.exec(readFileSync(join(runDir, 'time.txt'), 'utf8'))?.[1]) : undefined,
      receipt: outputs.receipt ? JSON.parse(outputs.receipt) : null,
    };
  }

  async stop() {
    await this.stopSshd();
    await this.mock?.stop();
    for (const dir of [this.hostDir, this.hostConfigDir]) if (dir) try { chmodSync(dir, 0o755); } catch {}
    rmSync(this.root, { recursive: true, force: true });
  }
}

function parseOutputs(text) {
  const result = {};
  const re = /^([^\n<]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  let m;
  while ((m = re.exec(text))) result[m[1]] = m[3];
  return result;
}
