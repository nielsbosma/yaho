// Build the Dopbase server Yaho bundles, from source, into vendor/dopbase/.
// Dopbase publishes Linux and macOS binaries only, so on Windows we compile it (needs Rust: cargo).
//   node tools/build-dopbase.mjs [version [commit]]
// Yaho uses Dopbase's REST API only; its admin web UI is replaced by a placeholder page.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.argv[2] ?? '0.1.9'; // a tag of github.com/dopbase/dopbase; check `gh release list -R dopbase/dopbase`
// The commit the tag must point at: `git ls-remote https://github.com/dopbase/dopbase 'refs/tags/<version>^{}'`.
const PINNED = { '0.1.9': 'e3e528f0ac652a7d706dc2995ada6b21dda1b5ff' };
const COMMIT = process.argv[3] ?? PINNED[VERSION];
if (!/^[0-9a-f]{40}$/.test(COMMIT ?? '')) throw new Error(`No pinned commit for Dopbase ${VERSION}; pass it: node tools/build-dopbase.mjs ${VERSION} <sha>`);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(tmpdir(), `yaho-dopbase-${VERSION}`);
const exe = process.platform === 'win32' ? 'dopbase.exe' : 'dopbase';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (!existsSync(join(src, 'app', 'Cargo.toml'))) {
  rmSync(src, { recursive: true, force: true });
  run('git', ['clone', '--depth', '1', '--branch', VERSION, 'https://github.com/dopbase/dopbase.git', src]);
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
if (head !== COMMIT) {
  rmSync(src, { recursive: true, force: true });
  throw new Error(`Dopbase ${VERSION} is at ${head}, expected ${COMMIT}: the tag has moved`);
}
// The server embeds ../dist (its admin UI); a placeholder keeps the build self-contained.
mkdirSync(join(src, 'dist'), { recursive: true });
if (!existsSync(join(src, 'dist', 'index.html')))
  writeFileSync(join(src, 'dist', 'index.html'), '<!doctype html><title>Dopbase</title><p>Dopbase bundled with Yaho (API only).</p>\n');

run('cargo', ['build', '--release', '--locked'], join(src, 'app'));

const out = join(repo, 'vendor', 'dopbase');
mkdirSync(out, { recursive: true });
copyFileSync(join(src, 'app', 'target', 'release', exe), join(out, exe));
writeFileSync(join(out, 'VERSION'), `${VERSION}\n`);
console.log(`Dopbase ${VERSION} -> ${join(out, exe)}`);
