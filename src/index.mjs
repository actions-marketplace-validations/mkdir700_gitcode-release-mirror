// The Action entry point: reads the inputs, runs the shared core either here
// (transport "direct") or on an SSH host (transport "ssh"), and reports the
// receipt as outputs and a step summary.
//
// The core is deliberately not bundled: the very file next to this one is hashed
// and sent to the SSH host, which must be running the same bytes.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import {
  DEFAULT_API_BASE,
  DEFAULT_FILE_NAME,
  MirrorError,
  assertApiBase,
  assertBranch,
  assertFileName,
  assertRepository,
  assertSha256,
  assertTag,
  mirror,
  redact,
} from '../lib/mirror-core.mjs';

const CORE_PATH = fileURLToPath(new URL('../lib/mirror-core.mjs', import.meta.url));
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

function integerInput(name, fallback, min, max) {
  const raw = core.getInput(name);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MirrorError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function nameFromUrl(value) {
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.split('/').pop());
  assertFileName(name, DEFAULT_FILE_NAME);
  return name;
}

// `sources` is a JSON array of {"url", "sha256"} and nothing else.
function parseSources(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw new MirrorError('sources is not valid JSON');
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > 50) throw new MirrorError('sources must be a JSON array of 1 to 50 entries');
  const names = new Set();
  return list.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new MirrorError('every sources entry must be an object');
    for (const key of Object.keys(item)) {
      if (key !== 'url' && key !== 'sha256') throw new MirrorError(`sources entry has an unknown field: ${key.slice(0, 40)}`);
    }
    if (typeof item.url !== 'string') throw new MirrorError('sources entry needs a url');
    let parsed;
    try {
      parsed = new URL(item.url);
    } catch {
      throw new MirrorError(`sources url is not a URL: ${item.url.slice(0, 80)}`);
    }
    if (parsed.protocol !== 'https:') throw new MirrorError('sources urls must be https');
    assertSha256(item.sha256, 'sources sha256');
    const name = nameFromUrl(item.url);
    if (names.has(name)) throw new MirrorError(`two sources have the file name ${name}`);
    names.add(name);
    return { name, url: item.url, sha256: item.sha256 };
  });
}

async function localFiles() {
  const patterns = core.getMultilineInput('files').filter(Boolean);
  if (patterns.length === 0) throw new MirrorError('transport "direct" needs the files input');
  const globber = await glob.create(patterns.join('\n'), { followSymbolicLinks: false, implicitDescendants: false, matchDirectories: false });
  const found = await globber.glob();
  const names = new Set();
  const files = found.map((path) => {
    if (!lstatSync(path).isFile()) throw new MirrorError(`${path} is not a regular file`);
    const name = basename(path);
    assertFileName(name, DEFAULT_FILE_NAME);
    if (names.has(name)) throw new MirrorError(`two files have the name ${name}`);
    names.add(name);
    return { name, path };
  });
  if (files.length === 0) throw new MirrorError('files matched nothing');
  return files;
}

function secretLines(text) {
  for (const line of text.split('\n')) {
    if (line.trim().length >= 8) core.setSecret(line.trim());
  }
}

// Runs the request on the host. stdout lines are host output, except the
// single receipt line; every other line is printed with a prefix so that host
// or GitCode text can never be read as a workflow command.
async function viaSsh({ request, secrets }) {
  const host = core.getInput('ssh-host', { required: true });
  const user = core.getInput('ssh-user', { required: true });
  const port = integerInput('ssh-port', 22, 1, 65535);
  const key = core.getInput('ssh-key', { required: true });
  const knownHosts = core.getInput('ssh-known-hosts', { required: true });
  if (!HOST.test(host)) throw new MirrorError('ssh-host is not a plain host name or address');
  if (!USER.test(user)) throw new MirrorError('ssh-user is not a plain account name');
  secretLines(key);

  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'gitcode-mirror-ssh-'));
  try {
    chmodSync(dir, 0o700);
    const keyFile = join(dir, 'key');
    const hostsFile = join(dir, 'known_hosts');
    writeFileSync(keyFile, `${key.replace(/\s+$/, '')}\n`, { mode: 0o600 });
    writeFileSync(hostsFile, `${knownHosts.replace(/\s+$/, '')}\n`, { mode: 0o600 });
    const args = [
      '-F', '/dev/null', '-T', '-i', keyFile,
      '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${hostsFile}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6',
      '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no',
      '-p', String(port), '-l', user, '--', host,
    ];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const killer = setTimeout(() => child.kill('SIGKILL'), (request.deadlineSeconds + 120) * 1000);
    let receipt = null;
    const lineReader = (prefix, handler) => {
      let buffer = '';
      return (chunk) => {
        buffer += chunk.toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          handler(buffer.slice(0, end), prefix);
          buffer = buffer.slice(end + 1);
        }
      };
    };
    const show = (line, prefix) => core.info(`${prefix}${redact(line, secrets)}`);
    child.stdout.on('data', lineReader('host| ', (line, prefix) => {
      if (line.startsWith('::receipt::')) {
        try {
          receipt = JSON.parse(line.slice('::receipt::'.length));
        } catch {
          show('unreadable receipt line', prefix);
        }
      } else {
        show(line, prefix);
      }
    }));
    child.stderr.on('data', lineReader('ssh| ', show));
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(request)}\n`);
    const { code, signal } = await done;
    clearTimeout(killer);
    return { receipt, code, signal };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The host reports; the runner checks. A file only counts as mirrored when the
// receipt names it with exactly the digest that was declared.
function checkHostReceipt(reported, declared, outcome) {
  const byName = new Map((reported?.files ?? []).map((entry) => [entry?.name, entry]));
  return declared.map((file) => {
    const entry = byName.get(file.name);
    if (!entry) {
      const reason = outcome.signal || outcome.code !== 0
        ? `the host did not report this file (ssh ended with ${outcome.signal ?? `status ${outcome.code}`}); the outcome is unknown and a repeat is safe`
        : 'the host did not report this file';
      return { name: file.name, sha256: file.sha256, status: 'failed', stage: 'host', error: reason };
    }
    if ((entry.status === 'mirrored' || entry.status === 'reused') && entry.sha256 !== file.sha256) {
      return { name: file.name, sha256: file.sha256, status: 'failed', stage: 'hash-binding', error: `the host reported sha256 ${String(entry.sha256).slice(0, 64)}, declared ${file.sha256}` };
    }
    return entry;
  });
}

function summary(receipt) {
  const rows = receipt.files.map((f) => `| \`${f.name}\` | ${f.status} | ${f.size ?? ''} | \`${(f.sha256 ?? '').slice(0, 16)}\` | ${f.status === 'failed' ? `${f.stage ?? ''}: ${f.error ?? ''}`.replace(/\|/g, '/') : (f.downloadUrl ?? '')} |`);
  return [
    `### GitCode release mirror: ${receipt.repository} ${receipt.tag}`,
    '',
    `Transport: ${receipt.transport}. These results come from the Action's own checks; nothing here is a third-party attestation.`,
    '',
    '| File | Status | Bytes | SHA-256 | Detail |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

async function run() {
  const transport = core.getInput('transport', { required: true });
  if (transport !== 'direct' && transport !== 'ssh') throw new MirrorError('transport must be "direct" or "ssh"');
  const repository = core.getInput('repository', { required: true });
  const tag = core.getInput('tag', { required: true });
  const token = core.getInput('token', { required: true });
  core.setSecret(token);
  const prerelease = core.getBooleanInput('prerelease');
  const targetCommitish = core.getInput('target-commitish') || 'main';
  const apiBase = assertApiBase(core.getInput('api-base') || DEFAULT_API_BASE);
  const stallSeconds = integerInput('stall-timeout', 120, 1, 3600);
  const deadlineSeconds = integerInput('deadline', 2400, 10, 86_400);
  assertRepository(repository);
  assertTag(tag);
  assertBranch(targetCommitish);

  const coreSha256 = createHash('sha256').update(readFileSync(CORE_PATH)).digest('hex');
  const secrets = [token];
  let receipt;
  if (transport === 'direct') {
    const files = await localFiles();
    const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'gitcode-mirror-'));
    try {
      receipt = await mirror({
        repository, tag, prerelease, targetCommitish, apiBase, token, files, workDir,
        stallMs: stallSeconds * 1000, deadlineMs: deadlineSeconds * 1000, log: (line) => core.info(line),
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  } else {
    if (core.getInput('files')) throw new MirrorError('transport "ssh" takes sources, not files');
    const declared = parseSources(core.getInput('sources', { required: true }));
    const request = {
      version: 1, coreSha256, repository, tag, prerelease, targetCommitish, apiBase, token,
      stallSeconds, deadlineSeconds, sources: declared.map(({ url, sha256 }) => ({ url, sha256 })),
    };
    const outcome = await viaSsh({ request, secrets });
    receipt = {
      schema: 1, repository, tag, apiBase, releaseCreated: outcome.receipt?.releaseCreated ?? false,
      startedAt: outcome.receipt?.startedAt, finishedAt: outcome.receipt?.finishedAt,
      files: checkHostReceipt(outcome.receipt, declared, outcome),
    };
  }
  receipt.transport = transport;
  receipt.coreSha256 = coreSha256;
  receipt.provenance = 'Produced by the Action; mock or real GitCode is not distinguishable from this file.';
  const text = redact(JSON.stringify(receipt), secrets);
  core.setOutput('receipt', text);
  const failed = receipt.files.filter((f) => f.status === 'failed').length;
  core.setOutput('failed-count', String(failed));
  await core.summary.addRaw(redact(summary(receipt), secrets), true).write();
  if (failed > 0) core.setFailed(`${failed} of ${receipt.files.length} file(s) were not mirrored`);
}

run().catch((error) => {
  core.setOutput('failed-count', '-1');
  core.setFailed(redact(error instanceof Error ? error.message : String(error), [core.getInput('token')]));
});
