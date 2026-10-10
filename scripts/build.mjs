// Bundles the Action entry into dist/index.mjs with its dependencies and writes
// the licences of everything that was bundled. `--check` rebuilds in memory and
// fails if dist/ differs from the committed files.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const result = await build({
  entryPoints: [join(root, 'src/index.mjs')],
  outfile: join(root, 'dist/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['../lib/mirror-core.mjs'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none',
  metafile: true,
  write: false,
  logLevel: 'warning',
});

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.set(match[1], true);
}
let notices = '# Third-party licences bundled into dist/index.mjs\n';
for (const dir of [...packages.keys()].sort()) {
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].map((f) => join(root, dir, f)).find(existsSync);
  notices += `\n## ${manifest.name} ${manifest.version} (${manifest.license})\n\n${licenseFile ? readFileSync(licenseFile, 'utf8').trim() : '(no licence file shipped)'}\n`;
}

const outputs = new Map([
  ['dist/index.mjs', result.outputFiles[0].text],
  ['dist/THIRD_PARTY_LICENSES.md', notices],
]);
let stale = false;
for (const [path, text] of outputs) {
  const full = join(root, path);
  if (check) {
    if (!existsSync(full) || readFileSync(full, 'utf8') !== text) {
      console.error(`${relative(root, full)} is out of date; run npm run build`);
      stale = true;
    }
  } else {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}
if (stale) process.exit(1);
console.log(check ? 'dist is up to date' : `built ${[...outputs.keys()].join(', ')}`);
