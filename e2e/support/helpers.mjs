import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { digestOf, generated } from './data.mjs';

export { assert, generated };

// Registers files on the mock source server and returns the `sources` input.
export async function sources(env, tag, defs) {
  const list = [];
  const info = {};
  for (const def of defs) {
    const data = generated(def.size, def.seed ?? def.name);
    const sha256 = await digestOf(data);
    env.mock.addSource(tag, def.name, data, sha256);
    info[def.name] = { data, sha256, size: def.size };
    list.push({ url: `https://downloads.example.test/artifacts/${tag}/${def.name}`, sha256 });
  }
  return { input: JSON.stringify(list), info, list };
}

export async function localFile(dir, name, size, seed = name) {
  mkdirSync(dir, { recursive: true });
  const data = generated(size, seed);
  const path = join(dir, name);
  await pipeline(data.stream(), createWriteStream(path));
  return { path, sha256: await digestOf(data), size, data };
}

export function storedBlob(env, repo, tag, name) {
  const release = env.mock.release(repo, tag);
  const asset = release?.assets.find((a) => a.name === name);
  return asset ? env.mock.blobs.get(asset.id) : undefined;
}

export async function blobSha(blob) {
  if (blob.sha256) return blob.sha256;
  return digestOf(blob.generated);
}

export const sha256Text = (text) => createHash('sha256').update(text).digest('hex');
export { writeFileSync };
