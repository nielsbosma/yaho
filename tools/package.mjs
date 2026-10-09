// Build a Windows installer: bundle every process, stage them side by side, run electron-builder.
//   node tools/package.mjs            -> apps/desktop/release/Yaho Setup <version>.exe
//   node tools/package.mjs --dir      -> unpacked app only (faster, for testing)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(repo, 'apps/desktop');
const stage = join(desktop, 'build/app');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const dirOnly = process.argv.includes('--dir');
const require = createRequire(join(desktop, 'package.json'));

// vp's own launcher; spawning it through node avoids shell shims.
const vp = (args, cwd = repo) =>
  execFileSync(process.execPath, [join(repo, 'node_modules/vite-plus/bin/vp'), ...args], { cwd, stdio: 'inherit' });
// The core and CLI bundle with no config; Electron's main and preload use apps/desktop's (it keeps 'electron' external).
const pack = (entry, outDir, extra = [], cwd = repo) =>
  vp(
    [
      'pack',
      entry,
      ...(cwd === repo ? ['--no-config'] : []),
      '--platform',
      'node',
      '--target',
      'node22',
      '--out-dir',
      outDir,
      '--no-clean',
      '--fail-on-warn=false',
      ...extra,
    ],
    cwd,
  );

rmSync(join(desktop, 'build'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log('\n== renderer');
vp(['build'], desktop);
cpSync(join(desktop, 'dist/renderer'), join(stage, 'renderer'), { recursive: true });

console.log('\n== core, cli, main, preload');
pack(join(repo, 'core/src/main.ts'), join(stage, 'core'));
pack(join(repo, 'cli/src/main.ts'), join(stage, 'cli'));
pack(join(desktop, 'src/main/index.ts'), join(stage, 'main'), [], desktop);
pack(join(desktop, 'src/preload/index.cts'), join(stage, 'preload'), ['--format', 'cjs'], desktop);
for (const [dir, want] of [
  ['core', 'main.mjs'],
  ['cli', 'main.mjs'],
  ['main', 'index.mjs'],
  ['preload', 'index.cjs'],
]) {
  if (!existsSync(join(stage, dir, want))) throw new Error(`expected ${dir}/${want} after bundling`);
}

cpSync(join(repo, 'briefings'), join(stage, 'briefings'), { recursive: true });

console.log('\n== dopbase');
const dopbaseExe = process.platform === 'win32' ? 'dopbase.exe' : 'dopbase';
if (!existsSync(join(repo, 'vendor/dopbase', dopbaseExe)))
  execFileSync(process.execPath, [join(repo, 'tools/build-dopbase.mjs')], { stdio: 'inherit' });
cpSync(join(repo, 'vendor/dopbase'), join(stage, 'dopbase'), { recursive: true });
cpSync(join(repo, 'examples'), join(stage, 'examples'), { recursive: true });

const electronVersion = require('electron/package.json').version;
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'yaho',
      productName: 'Yaho',
      version,
      description: 'Yet Another Harness Orchestrator',
      author: 'Niels Bosma',
      license: 'MIT',
      type: 'module',
      main: 'main/index.mjs',
    },
    null,
    2,
  ),
);

console.log('\n== electron-builder');
const config = {
  appId: 'com.nielsbosma.yaho',
  productName: 'Yaho',
  electronVersion,
  directories: { app: stage, output: join(desktop, 'release') },
  // Everything is bundled; never let electron-builder pull in a node_modules from the workspace.
  files: ['**/*', '!node_modules{,/**}'],
  // The core and the CLI run as plain Node scripts with ELECTRON_RUN_AS_NODE; keep them as real files.
  asar: false,
  win: { target: dirOnly ? 'dir' : 'nsis' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
};
writeFileSync(join(desktop, 'build/electron-builder.json'), JSON.stringify(config, null, 2));
const builder = join(desktop, 'node_modules/electron-builder/cli.js');
// electron-builder runs npm through cmd.exe, which truncates a PATH over 8191 characters; hand it a tidy one.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const seen = new Set();
const tidyPath = (process.env[pathKey] ?? '')
  .split(delimiter)
  .filter((d) => {
    const key = d.toLowerCase().replace(/[\\/]+$/, '');
    if (!d || seen.has(key) || !existsSync(d)) return false;
    seen.add(key);
    return true;
  })
  .join(delimiter);
execFileSync(
  process.execPath,
  [builder, '--config', join(desktop, 'build/electron-builder.json'), '--win', ...(dirOnly ? ['--dir'] : [])],
  {
    cwd: desktop,
    stdio: 'inherit',
    env: { ...process.env, [pathKey]: tidyPath },
  },
);
console.log(`\nDone: ${join(desktop, 'release')}`);
