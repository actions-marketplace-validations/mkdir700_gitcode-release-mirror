// The SSH forced command. sshd runs this file for the CI key and for nothing
// else; stdin carries exactly one JSON request line. The host stores no GitCode
// credential: the token arrives with the request and lives only in memory.
//
// Everything that decides what this host may fetch and where it may upload is in
// the administrator's config file (see docs/host-setup.md), never in the request.
//
// Usage (authorized_keys):  restrict,command="/path/to/node /opt/gitcode-release-mirror/host.mjs /etc/gitcode-release-mirror/config.json" ssh-ed25519 ...

import { createHash } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(HERE, 'mirror-core.mjs');
const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_KEYS = [
  'version', 'coreSha256', 'repository', 'tag', 'prerelease', 'targetCommitish', 'apiBase',
  'token', 'stallSeconds', 'deadlineSeconds', 'sources',
];
const CONFIG_KEYS = ['allowedRepositories', 'allowedSourcePrefixes', 'fileNamePattern', 'maxFileBytes', 'maxDeadlineSeconds', 'tmpDir'];

class Rejected extends Error {}

const reject = (message) => {
  throw new Rejected(message);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertKeys(object, allowed, what) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) reject(`${what} has an unknown field: ${key.slice(0, 40)}`);
  }
}

// The files that decide behaviour must not be writable by the user that runs them.
function assertProtected(path) {
  for (const target of [path, dirname(path)]) {
    let writable = true;
    try {
      accessSync(target, constants.W_OK);
    } catch {
      writable = false;
    }
    if (writable || (statSync(target).mode & 0o022) !== 0) {
      reject(`${target} is writable by the account running the forced command; install it root-owned and read-only`);
    }
  }
}

function loadConfig(path, core) {
  if (!path) reject('the config file path is missing from the forced command');
  assertProtected(path);
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    reject(`cannot read the config file: ${error.message}`);
  }
  if (!isPlainObject(config)) reject('the config file must be a JSON object');
  assertKeys(config, CONFIG_KEYS, 'the config file');
  const repositories = config.allowedRepositories;
  if (!Array.isArray(repositories) || repositories.length === 0 || !repositories.every((r) => typeof r === 'string' && core.REPOSITORY.test(r))) {
    reject('allowedRepositories must be a non-empty list of owner/repo');
  }
  const prefixes = config.allowedSourcePrefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0) reject('allowedSourcePrefixes must be a non-empty list');
  const parsedPrefixes = prefixes.map((prefix) => {
    let url;
    try {
      url = new URL(prefix);
    } catch {
      reject(`allowedSourcePrefixes entry is not a URL: ${String(prefix).slice(0, 80)}`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !url.pathname.endsWith('/')) {
      reject(`allowedSourcePrefixes entry must be an https URL with a path ending in "/": ${prefix}`);
    }
    return url;
  });
  let fileName = core.DEFAULT_FILE_NAME;
  if (config.fileNamePattern !== undefined) {
    try {
      fileName = new RegExp(config.fileNamePattern);
    } catch {
      reject('fileNamePattern is not a valid regular expression');
    }
  }
  const integer = (value, fallback, min, max, label) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) reject(`${label} must be an integer from ${min} to ${max}`);
    return value;
  };
  return {
    repositories,
    prefixes: parsedPrefixes,
    fileName,
    maxFileBytes: integer(config.maxFileBytes, 2 * 1024 ** 3, 1, 64 * 1024 ** 3, 'maxFileBytes'),
    maxDeadlineSeconds: integer(config.maxDeadlineSeconds, 7200, 10, 86_400, 'maxDeadlineSeconds'),
    tmpDir: config.tmpDir === undefined ? tmpdir() : String(config.tmpDir),
  };
}

async function readRequest() {
  const chunks = [];
  let total = 0;
  // A client that authenticates and then never finishes its request must not hold a process forever.
  const timer = setTimeout(() => {
    process.stdout.write('mirror-host rejected: the request was not completed within 30 seconds\n');
    process.exit(2);
  }, 30_000);
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) reject('the request is too large');
    chunks.push(chunk);
  }
  clearTimeout(timer);
  const text = Buffer.concat(chunks).toString('utf8');
  const lineEnd = text.indexOf('\n');
  if (lineEnd === -1 || text.slice(lineEnd + 1).trim() !== '') reject('the request must be exactly one JSON line');
  let request;
  try {
    request = JSON.parse(text.slice(0, lineEnd));
  } catch {
    reject('the first line is not valid JSON');
  }
  if (!isPlainObject(request)) reject('the request must be a JSON object');
  return request;
}

function sourceAllowed(value, prefixes) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  if (/%2f|%5c/i.test(url.pathname)) return false;
  return prefixes.some((prefix) => url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname));
}

function validate(request, config, core) {
  assertKeys(request, REQUEST_KEYS, 'the request');
  if (request.version !== 1) reject('unsupported request version');
  try {
    core.assertSha256(request.coreSha256, 'coreSha256');
    core.assertRepository(request.repository);
    core.assertTag(request.tag);
    core.assertBranch(request.targetCommitish);
    core.assertApiBase(request.apiBase);
  } catch (error) {
    reject(error.message);
  }
  if (!config.repositories.includes(request.repository)) reject(`repository ${request.repository} is not allowed on this host`);
  if (typeof request.prerelease !== 'boolean') reject('prerelease must be a boolean');
  if (typeof request.token !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(request.token)) reject('token has an invalid shape');
  if (!Number.isInteger(request.stallSeconds) || request.stallSeconds < 1 || request.stallSeconds > 3600) reject('stallSeconds is out of range');
  if (!Number.isInteger(request.deadlineSeconds) || request.deadlineSeconds < 10 || request.deadlineSeconds > config.maxDeadlineSeconds) {
    reject(`deadlineSeconds must be from 10 to ${config.maxDeadlineSeconds}`);
  }
  if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 50) reject('sources must list 1 to 50 files');
  const names = new Set();
  const files = request.sources.map((source) => {
    if (!isPlainObject(source)) reject('every source must be an object');
    assertKeys(source, ['url', 'sha256'], 'a source');
    if (typeof source.url !== 'string' || source.url.length > 2048 || !sourceAllowed(source.url, config.prefixes)) {
      reject(`source address is not allowed: ${String(source.url).slice(0, 120)}`);
    }
    try {
      core.assertSha256(source.sha256, 'source sha256');
    } catch (error) {
      reject(error.message);
    }
    const last = new URL(source.url).pathname.split('/').pop();
    let name;
    try {
      name = decodeURIComponent(last);
      core.assertFileName(name, config.fileName);
    } catch (error) {
      reject(error instanceof core.MirrorError ? error.message : 'source file name is not decodable');
    }
    if (names.has(name)) reject(`two sources have the file name ${name}`);
    names.add(name);
    return { name, url: source.url, sha256: source.sha256 };
  });
  return files;
}

async function main() {
  if (process.env.SSH_ORIGINAL_COMMAND) reject('this key only runs the mirror; a command was requested');
  assertProtected(fileURLToPath(import.meta.url));
  assertProtected(CORE_PATH);
  const request = await readRequest();

  // The Action and this host must run the same core, byte for byte. This is
  // checked before the core is loaded or trusted with anything else.
  const installed = createHash('sha256').update(readFileSync(CORE_PATH)).digest('hex');
  if (typeof request.coreSha256 !== 'string' || installed !== request.coreSha256) {
    reject(`the installed core is out of date (installed ${installed}, the Action sent ${String(request.coreSha256).slice(0, 64)}); redeploy from the matching release`);
  }
  const core = await import(pathToFileURL(CORE_PATH).href);
  const config = loadConfig(process.argv[2], core);
  const files = validate(request, config, core);

  const workDir = mkdtempSync(join(config.tmpDir, 'gitcode-mirror-'));
  let receipt;
  try {
    receipt = await core.mirror({
      repository: request.repository,
      tag: request.tag,
      prerelease: request.prerelease,
      targetCommitish: request.targetCommitish,
      apiBase: request.apiBase,
      token: request.token,
      files,
      allowSourceUrl: (url) => sourceAllowed(url, config.prefixes),
      workDir,
      stallMs: request.stallSeconds * 1000,
      deadlineMs: request.deadlineSeconds * 1000,
      maxFileBytes: config.maxFileBytes,
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  process.stdout.write(`::receipt::${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.files.every((file) => file.status !== 'failed') ? 0 : 1;
}

main().catch((error) => {
  const message = error instanceof Rejected ? `rejected: ${error.message}` : `failed: ${error?.message ?? error}`;
  process.stdout.write(`mirror-host ${message}\n`);
  process.exit(error instanceof Rejected ? 2 : 3);
});
