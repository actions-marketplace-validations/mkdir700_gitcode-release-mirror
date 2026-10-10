// A mock of the parts of GitCode (API, object storage, download CDN) and of a
// source file server that the code under test talks to. It is a model written
// from the public API pages, not a recording of the real service.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { generated } from './data.mjs';

const FILE_ID = (n) => `f${n}`;

export class Mock {
  constructor({ tls, dataDir, token }) {
    this.tls = tls;
    this.dataDir = dataDir;
    this.token = token;
    this.counter = 0;
    this.reset();
  }

  reset() {
    this.repos = new Map();
    this.blobs = new Map();
    this.uploads = new Map();
    this.sourceFiles = new Map();
    this.requests = [];
    this.faults = {};
    this.activeSockets = new Set();
  }

  count(kind) {
    return this.requests.filter((r) => r.kind === kind).length;
  }

  gitcodeRequests() {
    return this.requests.filter((r) => r.host.endsWith('gitcode.com') || r.host.endsWith('atomgit.com'));
  }

  release(repo, tag) {
    return this.repos.get(repo)?.get(tag);
  }

  seedAsset(repo, tag, name, source, sha256, { prerelease = false } = {}) {
    if (!this.repos.has(repo)) this.repos.set(repo, new Map());
    const releases = this.repos.get(repo);
    if (!releases.has(tag)) releases.set(tag, { tag, prerelease, assets: [] });
    return this.storeAsset(releases.get(tag), name, { generated: source, sha256, size: source.size });
  }

  storeAsset(release, name, blob) {
    const id = FILE_ID((this.counter += 1));
    this.blobs.set(id, blob);
    release.assets = release.assets.filter((a) => a.name !== name);
    release.assets.push({ name, id });
    return id;
  }

  async start() {
    mkdirSync(this.dataDir, { recursive: true });
    this.server = createServer(this.tls, (req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(`mock error: ${error.message}`);
      });
    });
    this.server.on('connection', (socket) => {
      this.activeSockets.add(socket);
      socket.on('close', () => this.activeSockets.delete(socket));
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  async stop() {
    for (const socket of this.activeSockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  takeStatus(kind) {
    const queue = this.faults.status?.[kind];
    return queue && queue.length > 0 ? queue.shift() : null;
  }

  async handle(req, res) {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const url = new URL(req.url, `https://${host}`);
    const record = { host, method: req.method, path: url.pathname, kind: 'other' };
    this.requests.push(record);
    if (host === 'api.gitcode.com' || host === 'api.atomgit.com') return this.api(req, res, url, record);
    if (host === 'upload.gitcode.com') return this.put(req, res, url, record);
    if (host === 'gitcode.com') return this.download(req, res, url, record);
    if (host === 'file-cdn.gitcode.com') return this.cdn(req, res, url, record);
    if (host === 'downloads.example.test') return this.source(req, res, url, record);
    this.json(res, 404, { message: 'unknown host' });
  }

  // ---- GitCode API --------------------------------------------------------
  async api(req, res, url, record) {
    const given = url.searchParams.get('access_token');
    if (given !== this.token) {
      record.kind = 'unauthorized';
      // A careless server that repeats what it was sent; the code under test must still not print it.
      return this.json(res, 401, { message: `invalid token ${given}` });
    }
    const m = url.pathname.match(/^\/api\/v5\/repos\/([^/]+)\/([^/]+)\/releases(?:\/(.*))?$/);
    if (!m) return this.json(res, 404, { message: 'not found' });
    const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
    const rest = m[3] === undefined ? [] : m[3].split('/').map(decodeURIComponent);
    const releases = this.repos.get(repo);
    const knownRepo = this.faults.repositories ? this.faults.repositories.includes(repo) : true;
    if (!knownRepo) return this.json(res, 404, { message: 'repository not found' });

    const injected = (kind) => {
      record.kind = kind;
      const status = this.takeStatus(kind);
      if (status) {
        this.json(res, status, { message: `injected ${status} for ${kind}` });
        return true;
      }
      return false;
    };

    if (req.method === 'GET' && rest[0] === 'tags' && rest.length === 2) {
      if (injected('release.get')) return;
      const release = releases?.get(rest[1]);
      if (!release) return this.json(res, 404, { message: 'release not found' });
      return this.json(res, 200, this.view(repo, release));
    }
    if (req.method === 'POST' && rest.length === 0) {
      if (injected('release.create')) return;
      const body = JSON.parse(await readAll(req));
      if (this.faults.raceCreate) {
        // Another run created the release between the caller's read and its create.
        this.faults.raceCreate = false;
        if (!this.repos.has(repo)) this.repos.set(repo, new Map());
        this.repos.get(repo).set(body.tag_name, { tag: body.tag_name, prerelease: body.release_status === 'pre', assets: [] });
        return this.json(res, this.faults.raceCreateStatus ?? 400, { message: 'release already exists (mock-defined answer)' });
      }
      if (!this.repos.has(repo)) this.repos.set(repo, new Map());
      const existing = this.repos.get(repo);
      if (existing.has(body.tag_name)) return this.json(res, 400, { message: 'release already exists (mock-defined answer)' });
      existing.set(body.tag_name, { tag: body.tag_name, prerelease: body.release_status === 'pre', status: body.release_status, assets: [], created: body });
      return this.json(res, 200, this.view(repo, existing.get(body.tag_name)));
    }
    if (req.method === 'GET' && rest.length === 2 && rest[1] === 'upload_url') {
      if (injected('upload_url')) return;
      const release = releases?.get(rest[0]);
      if (!release) return this.json(res, 404, { message: 'release not found' });
      const id = `u${(this.counter += 1)}`;
      this.uploads.set(id, { repo, tag: rest[0], name: url.searchParams.get('file_name') });
      return this.json(res, 200, {
        url: `https://upload.gitcode.com/put/${id}`,
        headers: {
          'x-obs-meta-project-id': '12345',
          'x-obs-acl': 'public-read',
          'x-obs-callback': 'mock-callback-descriptor',
          'Content-Type': 'application/octet-stream',
        },
      });
    }
    if (req.method === 'GET' && rest.length === 4 && rest[1] === 'attach_files' && rest[3] === 'download') {
      record.kind = 'api.download';
      return this.redirectToCdn(res, repo, rest[0], rest[2]);
    }
    return this.json(res, 404, { message: 'not found' });
  }

  view(repo, release) {
    const [owner, name] = repo.split('/');
    return {
      tag_name: release.tag,
      prerelease: release.prerelease,
      release_status: release.status,
      assets: release.assets.map((a) => ({
        name: a.name,
        type: 'attach',
        browser_download_url: `https://gitcode.com/${owner}/${name}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(a.name)}`,
      })),
    };
  }

  redirectToCdn(res, repo, tag, name) {
    const asset = this.release(repo, tag)?.assets.find((a) => a.name === name);
    if (!asset) return this.json(res, 404, { message: 'no such asset' });
    const f = this.faults.readback;
    if (f === 'http') {
      res.writeHead(302, { location: `http://file-cdn.gitcode.com/blob/${asset.id}?sig=mock` });
      return res.end();
    }
    if (f === 'loop') {
      res.writeHead(302, { location: `https://gitcode.com/loop/${Date.now()}` });
      return res.end();
    }
    if (f === 'outside') {
      res.writeHead(302, { location: `https://evil.example.test/blob/${asset.id}` });
      return res.end();
    }
    res.writeHead(302, { location: `https://file-cdn.gitcode.com/blob/${asset.id}?sig=mock-signature` });
    return res.end();
  }

  download(req, res, url, record) {
    record.kind = 'download';
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/);
    if (url.pathname.startsWith('/loop/')) {
      res.writeHead(302, { location: `https://gitcode.com/loop/${Date.now()}` });
      return res.end();
    }
    if (!m) return this.json(res, 404, {});
    return this.redirectToCdn(res, `${m[1]}/${m[2]}`, decodeURIComponent(m[3]), decodeURIComponent(m[4]));
  }

  async cdn(req, res, url, record) {
    record.kind = 'cdn';
    const blob = this.blobs.get(url.pathname.replace('/blob/', ''));
    if (!blob) return this.json(res, 404, {});
    const range = req.headers.range;
    if (range) {
      res.writeHead(206, { 'content-range': `bytes 0-0/${blob.size}`, 'content-length': 1 });
      return res.end(Buffer.alloc(1));
    }
    res.writeHead(200, { 'content-length': blob.size, 'content-type': 'application/octet-stream' });
    const corrupt = this.faults.readback === 'corrupt';
    const stream = blob.generated ? blob.generated.stream() : createReadStream(blob.path);
    let first = true;
    for await (const chunk of stream) {
      if (corrupt && first) chunk[0] ^= 0xff;
      first = false;
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  // ---- object storage -----------------------------------------------------
  async put(req, res, url, record) {
    record.kind = 'put';
    const id = url.pathname.replace('/put/', '');
    const upload = this.uploads.get(id);
    if (!upload) return this.json(res, 403, {});
    for (const header of ['x-obs-meta-project-id', 'x-obs-acl', 'x-obs-callback']) {
      if (!req.headers[header]) return this.json(res, 400, { message: `missing ${header}` });
    }
    if (req.headers.authorization || url.search.includes('access_token')) {
      record.leakedCredential = true;
    }
    const putNumber = this.count('put');
    const stall = this.faults.putStall; // number of leading PUTs that stall, or Infinity
    if (stall && putNumber <= stall) {
      let got = 0;
      req.on('data', (chunk) => {
        got += chunk.length;
        if (got > 256 * 1024) req.pause();
      });
      req.on('error', () => {});
      return; // never answers; the client has to give up
    }
    const file = join(this.dataDir, `${id}.bin`);
    const hash = createHash('sha256');
    let size = 0;
    req.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    await pipeline(req, createWriteStream(file));
    const blob = { path: file, size, sha256: hash.digest('hex') };
    record.received = size;
    const register = () => {
      const release = this.release(upload.repo, upload.tag);
      if (release) this.storeAsset(release, upload.name, blob);
    };
    if (this.faults.callbackNever) {
      // stored by the object store but never announced to GitCode
    } else if (this.faults.callbackDelayMs) {
      setTimeout(register, this.faults.callbackDelayMs).unref();
    } else {
      register();
    }
    if (this.faults.dropAnswer && putNumber <= this.faults.dropAnswer) {
      req.socket.destroy();
      return;
    }
    if (this.faults.answerDelayMs) await new Promise((r) => setTimeout(r, this.faults.answerDelayMs));
    res.writeHead(200);
    res.end();
  }

  // ---- source file server -------------------------------------------------
  addSource(tag, name, data, sha256) {
    this.sourceFiles.set(`${tag}/${name}`, { data, sha256 });
  }

  async source(req, res, url, record) {
    record.kind = 'source';
    let m = url.pathname.match(/^\/redir\/(in|out|http|loop)\/(.+)$/);
    if (m) {
      const target = {
        in: `https://downloads.example.test/artifacts/${m[2]}`,
        out: `https://evil.example.test/artifacts/${m[2]}`,
        http: `http://downloads.example.test/artifacts/${m[2]}`,
        loop: `https://downloads.example.test/redir/loop/${Date.now()}`,
      }[m[1]];
      res.writeHead(302, { location: target });
      return res.end();
    }
    m = url.pathname.match(/^\/artifacts\/([^/]+)\/([^/]+)$/);
    const entry = m && this.sourceFiles.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`);
    if (!entry) return this.json(res, 404, {});
    const fault = this.faults.source?.[decodeURIComponent(m[2])];
    let data = entry.data;
    if (fault === 'wrong') data = generated(entry.data.size, `${entry.data.seed}-other`);
    res.writeHead(200, { 'content-length': data.size, 'content-type': 'application/octet-stream' });
    let sent = 0;
    for await (const chunk of data.stream()) {
      if (fault === 'short' && sent > data.size / 2) return res.destroy();
      sent += chunk.length;
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }
}

async function readAll(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}
