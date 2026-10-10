import { createCipheriv, createHash } from 'node:crypto';
import { Readable } from 'node:stream';

// Deterministic pseudo-random bytes: the same (seed, size) is always the same stream.
export function generated(size, seed) {
  const key = createHash('sha256').update(String(seed)).digest().subarray(0, 16);
  const stream = () => {
    const cipher = createCipheriv('aes-128-ctr', key, Buffer.alloc(16));
    const chunk = 1024 * 1024;
    return Readable.from((async function* () {
      let left = size;
      while (left > 0) {
        const n = Math.min(chunk, left);
        yield cipher.update(Buffer.alloc(n));
        left -= n;
      }
    })());
  };
  return { size, seed, stream };
}

export async function digestOf(source) {
  const hash = createHash('sha256');
  for await (const chunk of source.stream()) hash.update(chunk);
  return hash.digest('hex');
}
