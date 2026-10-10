// The mirroring core. It uploads files to a GitCode Release and proves, by
// downloading them back anonymously, that GitCode holds exactly the bytes that
// were declared. Only Node built-ins are used, so the very same file runs
// inside the Action (direct transport) and on an SSH host (installed there by
// an administrator and bound by SHA-256 to the Action that sends the request).
//
// Derived from the MIT-licensed mirror script in UniClipboard/UniClip
// (see NOTICE.md); it has since been restructured and extended.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import https from 'node:https';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_API_BASE = 'https://api.gitcode.com/api/v5';
const API_HOSTS = ['api.gitcode.com', 'api.atomgit.com'];
const CONTENT_HOSTS = ['gitcode.com', 'atomgit.com'];
const MAX_REDIRECTS = 5;
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;
const POLL_INTERVAL_MS = 3000;
const POLL_ATTEMPTS = 20;
const API_TIMEOUT_MS = 60_000;
// After the whole body is sent, GitCode's object storage may call GitCode back
// before it answers; that wait is bounded separately from the stall timer.
const RESPONSE_WAIT_MS = 300_000;

export class MirrorError extends Error {
  constructor(message, { stage, permanent } = {}) {
    super(message);
    this.stage = stage;
    this.permanent = permanent === true;
  }
}

// ---------------------------------------------------------------- validation

export const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const TAG = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
export const BRANCH = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,127}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const DEFAULT_FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;

export function assertRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY.test(value) || value.includes('..')) {
    throw new MirrorError('repository must look like owner/repo', { permanent: true });
  }
}

export function assertTag(value) {
  if (typeof value !== 'string' || !TAG.test(value) || value.includes('..')) {
    throw new MirrorError('tag contains characters that are not allowed', { permanent: true });
  }
}

export function assertBranch(value) {
  if (typeof value !== 'string' || !BRANCH.test(value) || value.includes('..') || value.endsWith('/')) {
    throw new MirrorError('target-commitish is not a plain branch name', { permanent: true });
  }
}

export function assertSha256(value, label = 'sha256') {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new MirrorError(`${label} must be 64 lowercase hex characters`, { permanent: true });
  }
}

export function assertFileName(value, pattern = DEFAULT_FILE_NAME) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || !pattern.test(value) || value.includes('..')) {
    throw new MirrorError(`file name ${JSON.stringify(String(value).slice(0, 80))} is not allowed`, { permanent: true });
  }
}

// The API base receives the token, so only the two known API hosts qualify.
export function assertApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MirrorError('api-base is not a URL', { permanent: true });
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
    !API_HOSTS.includes(url.hostname) || !/^\/api\/v5\/?$/.test(url.pathname)
  ) {
    throw new MirrorError('api-base must be https://api.gitcode.com/api/v5 or https://api.atomgit.com/api/v5', { permanent: true });
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

function isContentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  return CONTENT_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

// ------------------------------------------------------------------ helpers

export function redact(text, secrets = []) {
  let output = String(text).replace(/access_token=[^&\s"']+/g, 'access_token=***');
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('***');
  }
  return output;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const errorText = (error) => (error instanceof Error ? error.message : String(error));

// One run: a deadline shared by everything, so the step ends by itself and
// still reports, instead of being killed by a job timeout.
function createRun(deadlineMs, stallMs, secrets, log) {
  const deadlineAt = Date.now() + deadlineMs;
  const run = {
    stallMs,
    secrets,
    log: (message) => log(redact(message, secrets)),
    remaining: () => Math.max(1, deadlineAt - Date.now()),
    pastDeadline: () => Date.now() >= deadlineAt,
    deadlineError: (detail) => new MirrorError(`deadline of ${Math.round(deadlineMs / 1000)}s exceeded (${detail})`, { stage: 'deadline', permanent: true }),
    signal: (ms) => AbortSignal.any([AbortSignal.timeout(ms), AbortSignal.timeout(run.remaining())]),
    deadlineSignal: () => AbortSignal.timeout(run.remaining()),
  };
  return run;
}

async function withRetries(run, label, task) {
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if (run.pastDeadline()) throw run.deadlineError(label);
    try {
      return await task(attempt);
    } catch (error) {
      last = error;
      if (error?.permanent) break;
      if (run.pastDeadline()) throw run.deadlineError(`${label}: ${errorText(error)}`);
      if (attempt < ATTEMPTS) await sleep(Math.min(RETRY_DELAY_MS * attempt, run.remaining()));
    }
  }
  const failure = new MirrorError(`${label} failed: ${errorText(last)}`, { stage: last?.stage, permanent: last?.permanent });
  throw failure;
}

function assertSuccess(response, label, body, secrets) {
  if (response.ok) return;
  const snippet = body ? `: ${redact(String(body).slice(0, 300), secrets)}` : '';
  const error = new MirrorError(`${label} returned HTTP ${response.status}${snippet}`);
  // Client errors other than throttling and timeouts do not change on retry.
  if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
    error.permanent = true;
  }
  throw error;
}

// Iterates a response and aborts when no byte arrives for stallMs.
async function* withStallGuard(stream, stallMs, controller, what) {
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new MirrorError(`${what}: no data for ${Math.round(stallMs / 1000)}s`)), stallMs);
  };
  arm();
  try {
    for await (const chunk of stream) {
      arm();
      yield chunk;
    }
  } finally {
    clearTimeout(timer);
  }
}

// One GET without redirects. node:https (not fetch) is used for bodies that can
// be large: it applies backpressure, see putStream. Only connecting and waiting
// for the response headers have a fixed timeout; the body is limited by the
// stall guard and the run's deadline, never by a total transfer time.
function getOnce(url, signal) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent: false }, (response) => {
      clearTimeout(headerTimer);
      resolve(response);
    });
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    const headerTimer = setTimeout(() => request.destroy(new Error(`no response within ${API_TIMEOUT_MS / 1000}s`)), API_TIMEOUT_MS);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    request.on('error', (error) => {
      clearTimeout(headerTimer);
      reject(error);
    });
  });
}

// Follows redirects by hand so every hop can be checked. Nothing here ever
// sends credentials.
async function openFollowing(run, startUrl, { hopAllowed, what }) {
  const chain = [];
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) {
      throw new MirrorError(`${what} redirected to a non-https or credentialed address: ${target.protocol}//${target.host}`, { permanent: true });
    }
    if (hopAllowed && !hopAllowed(url)) {
      throw new MirrorError(`${what} redirected to an address that is not allowed: ${target.origin}`, { permanent: true });
    }
    chain.push(`${target.origin}${target.pathname}`);
    const controller = new AbortController();
    const response = await getOnce(url, AbortSignal.any([controller.signal, run.deadlineSignal()]));
    const status = response.statusCode;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new MirrorError(`${what}: HTTP ${status} without a Location header`, { permanent: true });
      url = new URL(location, url).href;
      continue;
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      const error = new MirrorError(`${what} returned HTTP ${status}`);
      error.permanent = status >= 400 && status < 500 && status !== 429 && status !== 408;
      throw error;
    }
    return { response, controller, chain, finalUrl: url };
  }
  throw new MirrorError(`${what}: too many redirects`, { permanent: true });
}

// Streams a URL into a hash (and optionally a file).
async function fetchDigest(run, url, { hopAllowed, what, destination, maxBytes }) {
  const { response, controller, chain } = await openFollowing(run, url, { hopAllowed, what });
  const lengthHeader = response.headers['content-length'];
  const declared = lengthHeader === undefined ? null : Number(lengthHeader);
  if (maxBytes && declared !== null && declared > maxBytes) {
    response.destroy();
    throw new MirrorError(`${what}: ${declared} bytes exceed the limit of ${maxBytes}`, { permanent: true });
  }
  const hash = createHash('sha256');
  let size = 0;
  async function* counted() {
    for await (const chunk of withStallGuard(response, run.stallMs, controller, what)) {
      size += chunk.length;
      if (maxBytes && size > maxBytes) throw new MirrorError(`${what}: more than ${maxBytes} bytes`, { permanent: true });
      hash.update(chunk);
      yield chunk;
    }
  }
  try {
    if (destination) {
      await pipeline(Readable.from(counted()), createWriteStream(destination, { mode: 0o600 }), { signal: controller.signal });
    } else {
      for await (const chunk of counted()) void chunk;
    }
  } catch (error) {
    throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
  }
  if (response.aborted || (declared !== null && declared !== size)) {
    throw new MirrorError(`${what}: received ${size} bytes but Content-Length was ${declared}`);
  }
  return { size, sha256: hash.digest('hex'), chain };
}

// Node's global fetch reads a streamed request body ahead of the socket and
// ended up holding the whole file in memory (measured: 300 MiB file, 300 MiB
// buffered). node:https applies backpressure, so uploads use it.
function putStream(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    let answerTimer;
    const request = https.request(url, { method: 'PUT', headers, agent: false }, (response) => {
      clearTimeout(answerTimer);
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        if (length < 4096) chunks.push(chunk);
        length += chunk.length;
      });
      response.on('end', () => {
        const status = response.statusCode;
        resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', reject);
    });
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    request.on('error', (error) => {
      clearTimeout(answerTimer);
      reject(error);
    });
    pipeline(body, request)
      .then(() => {
        // Everything is sent; GitCode's storage may now call GitCode back before answering.
        answerTimer = setTimeout(() => request.destroy(new Error(`no answer within ${RESPONSE_WAIT_MS / 1000}s after the whole file was sent`)), RESPONSE_WAIT_MS);
      })
      .catch(reject);
  });
}

// ------------------------------------------------------------------- mirror

/**
 * @param {object} config
 * @param {string} config.repository      GitCode owner/repo
 * @param {string} config.tag
 * @param {boolean} config.prerelease
 * @param {string} config.targetCommitish
 * @param {string} config.apiBase
 * @param {string} config.token
 * @param {Array<{name:string,path?:string,url?:string,sha256?:string}>} config.files
 *        a local `path`, or a `url` together with the `sha256` it must have
 * @param {(url:string)=>boolean} [config.allowSourceUrl] required for `url` files
 * @param {string} config.workDir         existing, private directory for downloads
 * @param {number} config.stallMs
 * @param {number} config.deadlineMs
 * @param {number} [config.maxFileBytes]  limit for downloaded sources
 * @param {(line:string)=>void} config.log
 * @returns {Promise<object>} the receipt; never throws for per-file problems
 */
export async function mirror(config) {
  const { tag, prerelease, token, workDir, log, files, allowSourceUrl, maxFileBytes } = config;
  const run = createRun(config.deadlineMs, config.stallMs, [token], log);
  const startedAt = new Date().toISOString();
  const apiBase = assertApiBase(config.apiBase);
  assertRepository(config.repository);
  assertTag(tag);
  assertBranch(config.targetCommitish);
  const [owner, repo] = config.repository.split('/');
  const receipt = {
    schema: 1,
    repository: config.repository,
    tag,
    apiBase,
    releaseCreated: false,
    startedAt,
    files: [],
  };

  const api = async (method, path, { query = {}, body } = {}) => {
    const url = new URL(`${apiBase}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('access_token', token);
    // Never follow a redirect: the token is in the query string.
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: run.signal(API_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) {
      throw new MirrorError(`GitCode answered with a redirect (HTTP ${response.status}); not following it`, { permanent: true });
    }
    return { response, text, json: () => (text ? JSON.parse(text) : null) };
  };

  const releasePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
  const tagPath = `${releasePath}/${encodeURIComponent(tag)}`;

  const readRelease = () =>
    withRetries(run, 'Reading the GitCode release', async () => {
      const { response, text, json } = await api('GET', `${releasePath}/tags/${encodeURIComponent(tag)}`);
      if (response.status === 404) return null;
      assertSuccess(response, 'Reading the GitCode release', text, run.secrets);
      return json();
    });

  // Creating can race with another run. Whatever the answer, read again: if the
  // release exists now, somebody else created it and that is fine.
  const createRelease = async () => {
    let failure;
    try {
      await withRetries(run, 'Creating the GitCode release', async () => {
        const { response, text } = await api('POST', releasePath, {
          body: {
            tag_name: tag,
            name: tag,
            body: `Release assets for ${tag}.`,
            target_commitish: config.targetCommitish,
            release_status: prerelease ? 'pre' : 'latest',
          },
        });
        assertSuccess(response, 'Creating the GitCode release', text, run.secrets);
      });
    } catch (error) {
      failure = error;
    }
    const release = await readRelease();
    if (!release) throw failure ?? new MirrorError('The GitCode release is not readable after it was created');
    receipt.releaseCreated = !failure;
    return release;
  };

  const findAsset = (release, name) => (release?.assets ?? []).find((asset) => asset.name === name);

  // Anonymous download: no token, no cookies. Candidate addresses are the one
  // GitCode lists and the documented attachment endpoint.
  const verifyOnGitCode = async (release, name, expected) => {
    const candidates = [];
    const listed = findAsset(release, name)?.browser_download_url;
    if (listed && isContentUrl(listed)) candidates.push(listed);
    const apiDownload = `${apiBase}${tagPath}/attach_files/${encodeURIComponent(name)}/download`;
    candidates.push(apiDownload);
    const failures = [];
    for (const candidate of candidates) {
      try {
        const result = await fetchDigest(run, candidate, { what: 'Anonymous download', hopAllowed: null });
        if (result.sha256 !== expected.sha256 || (expected.size !== undefined && result.size !== expected.size)) {
          failures.push(`${new URL(candidate).host}: downloaded ${result.size} bytes with sha256 ${result.sha256}`);
          continue;
        }
        return { ok: true, downloadUrl: candidate, chain: result.chain, size: result.size };
      } catch (error) {
        failures.push(`${new URL(candidate).host}: ${errorText(error)}`);
      }
    }
    return { ok: false, failures };
  };

  const putFile = async (path, size, attempt, entry) => {
    const { response, text, json } = await api('GET', `${tagPath}/upload_url`, { query: { file_name: entry.name } });
    assertSuccess(response, 'Requesting the upload address', text, run.secrets);
    const target = json();
    if (!target?.url) throw new MirrorError('The upload address response has no url');
    const putUrl = new URL(target.url);
    if (putUrl.protocol !== 'https:' || putUrl.username || putUrl.password) {
      throw new MirrorError('The upload address is not a plain https address', { permanent: true });
    }
    const headers = {};
    for (const [key, value] of Object.entries(target.headers ?? {})) {
      // GitCode documents x-obs-* headers and Content-Type; nothing else is forwarded.
      if (/^(x-obs-[a-z0-9-]+|content-type)$/i.test(key) && typeof value === 'string') headers[key] = value;
    }
    headers['content-length'] = String(size);

    let sent = 0;
    let bodyDone = false;
    let lastProgress = Date.now();
    const startedAt = Date.now();
    let lastLogged = startedAt;
    const controller = new AbortController();
    async function* counted() {
      for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
        sent += chunk.length;
        lastProgress = Date.now();
        yield chunk;
      }
      bodyDone = true;
    }
    // The stall timer only watches the body going out. Once everything is sent
    // GitCode may take a while to answer; that has its own bound.
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (!bodyDone && now - lastProgress > run.stallMs) {
        controller.abort(new MirrorError(`upload stalled: no progress for ${Math.round(run.stallMs / 1000)}s (sent ${sent} of ${size} bytes)`));
      }
      if (!bodyDone && now - lastLogged >= 15_000) {
        lastLogged = now;
        const seconds = Math.max(1, Math.round((now - startedAt) / 1000));
        run.log(`  ${entry.name}: ${sent} of ${size} bytes after ${seconds}s (${Math.round(sent / 1024 / seconds)} KiB/s)`);
      }
    }, Math.max(50, Math.min(1000, Math.floor(run.stallMs / 4))));
    try {
      const put = await putStream(
        putUrl,
        headers,
        Readable.from(counted()),
        AbortSignal.any([controller.signal, run.deadlineSignal()]),
      );
      assertSuccess(put, 'Uploading the file', put.text, run.secrets);
    } catch (error) {
      const reason = controller.signal.reason instanceof Error ? controller.signal.reason : error;
      reason.bodySent = bodyDone;
      throw reason;
    } finally {
      clearInterval(watchdog);
    }
    entry.attempts = attempt;
    run.log(`  ${entry.name}: uploaded ${sent} bytes in ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`);
  };

  // The upload is registered asynchronously by GitCode's callback.
  const waitForAsset = async (name, polls) => {
    let release = null;
    for (let poll = 0; poll < polls && !run.pastDeadline(); poll += 1) {
      release = await readRelease();
      if (findAsset(release, name)) return release;
      await sleep(Math.min(POLL_INTERVAL_MS, run.remaining()));
    }
    return findAsset(release, name) ? release : null;
  };

  const mirrorOne = async (file, entry, state) => {
    // 1. Already on GitCode? Then it is verified against the declared hash and
    //    reused, or reported as a conflict. It is never overwritten or deleted.
    let declared = file.sha256;
    let size;
    let localPath = file.path;
    if (localPath) {
      const local = await sha256File(localPath);
      if (declared && declared !== local.sha256) {
        throw new MirrorError(`file ${entry.name} has sha256 ${local.sha256}, expected ${declared}`, { stage: 'source', permanent: true });
      }
      declared = local.sha256;
      size = local.size;
      entry.size = size;
      entry.sha256 = declared;
    } else {
      entry.sha256 = declared;
    }

    if (findAsset(state.release, entry.name)) {
      run.log(`GitCode already has ${entry.name}; checking that it is identical`);
      const verified = await verifyOnGitCode(state.release, entry.name, { sha256: declared, size });
      if (!verified.ok) {
        throw new MirrorError(
          `GitCode already has ${entry.name} but it is not the declared file (${verified.failures.join('; ')}); not overwriting or deleting it`,
          { stage: 'conflict', permanent: true },
        );
      }
      Object.assign(entry, { status: 'reused', size: verified.size, downloadUrl: verified.downloadUrl, redirectChain: verified.chain });
      return;
    }

    // 2. Get the bytes and prove they are the declared ones before GitCode is touched.
    let cleanup;
    if (!localPath) {
      localPath = join(workDir, `source-${state.counter += 1}`);
      cleanup = () => rm(localPath, { force: true });
      run.log(`Downloading ${entry.name}`);
      try {
        const started = Date.now();
        const result = await withRetries(run, `Downloading ${entry.name}`, () =>
          fetchDigest(run, file.url, { hopAllowed: allowSourceUrl, what: 'Source download', destination: localPath, maxBytes: maxFileBytes }),
        );
        const seconds = Math.max(0.001, (Date.now() - started) / 1000);
        run.log(`  ${entry.name}: ${result.size} bytes in ${seconds.toFixed(0)}s (${Math.round(result.size / 1024 / seconds)} KiB/s)`);
        if (result.sha256 !== declared) {
          throw new MirrorError(`source delivered sha256 ${result.sha256}, expected ${declared}`, { stage: 'source', permanent: true });
        }
        size = result.size;
        entry.size = size;
      } catch (error) {
        await cleanup();
        error.stage ??= 'source';
        throw error;
      }
    }

    try {
      if (!state.release) {
        run.log(`Creating GitCode release ${tag}`);
        state.release = await createRelease();
      }
      // 3. Upload. Before every retry look again: a PUT whose answer was lost may have landed.
      let registered = findAsset(state.release, entry.name) ? state.release : null;
      for (let attempt = 1; attempt <= ATTEMPTS && !registered; attempt += 1) {
        if (run.pastDeadline()) throw run.deadlineError(`uploading ${entry.name}`);
        if (attempt > 1) {
          registered = findAsset(state.release, entry.name) ? state.release : null;
          if (registered) break;
        }
        run.log(`Uploading ${entry.name} (attempt ${attempt}/${ATTEMPTS})`);
        try {
          await putFile(localPath, size, attempt, entry);
          break;
        } catch (error) {
          entry.error = errorText(error);
          if (error?.permanent || attempt === ATTEMPTS) {
            throw new MirrorError(`Uploading ${entry.name} failed: ${errorText(error)}`, { stage: 'upload' });
          }
          run.log(`  attempt ${attempt} failed: ${errorText(error)}`);
          // A lost answer after a full body may still have been registered.
          const seen = await waitForAsset(entry.name, error.bodySent ? POLL_ATTEMPTS : 1);
          if (seen) {
            state.release = seen;
            registered = seen;
            entry.attempts = attempt;
            break;
          }
          await sleep(Math.min(RETRY_DELAY_MS * attempt, run.remaining()));
        }
      }
      delete entry.error;
      if (!registered) {
        const seen = await waitForAsset(entry.name, POLL_ATTEMPTS);
        if (!seen) {
          throw run.pastDeadline()
            ? run.deadlineError('the uploaded file did not appear on the GitCode release')
            : new MirrorError('The uploaded file did not appear on the GitCode release', { stage: 'register' });
        }
        state.release = seen;
        registered = seen;
      } else {
        state.release = registered;
      }
      const verified = await verifyOnGitCode(state.release, entry.name, { sha256: declared, size });
      if (!verified.ok) {
        throw new MirrorError(`The uploaded file failed the anonymous download check (${verified.failures.join('; ')})`, { stage: 'verify' });
      }
      Object.assign(entry, { status: 'mirrored', downloadUrl: verified.downloadUrl, redirectChain: verified.chain });
      // Informational only: whether the mirror can resume downloads.
      try {
        const probe = await fetch(verified.downloadUrl, { headers: { range: 'bytes=0-0' }, redirect: 'follow', signal: run.signal(API_TIMEOUT_MS) });
        entry.acceptsRange = probe.status === 206;
        await probe.body?.cancel();
      } catch {
        entry.acceptsRange = null;
      }
    } finally {
      if (cleanup) await cleanup();
    }
  };

  // One entry per file, in order. A failure never stops the other files.
  const state = { release: null, counter: 0 };
  for (const file of files) {
    const entry = { name: file.name, status: 'failed' };
    receipt.files.push(entry);
    try {
      if (!state.release) state.release = await readRelease();
      await mirrorOne(file, entry, state);
    } catch (error) {
      entry.status = 'failed';
      entry.stage = error.stage ?? (run.pastDeadline() ? 'deadline' : 'release');
      entry.error = redact(errorText(error), run.secrets);
      run.log(`FAILED ${entry.name} at ${entry.stage}: ${entry.error}`);
    }
  }
  receipt.finishedAt = new Date().toISOString();
  return receipt;
}
