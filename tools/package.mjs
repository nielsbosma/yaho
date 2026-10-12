// Build Yaho for the OS this runs on: bundle every process, stage them side by side, run electron-builder.
//   node tools/package.mjs            -> the installer: Yaho Setup <version>.exe, Yaho-<version>.dmg or an AppImage
//   node tools/package.mjs --dir      -> the unpacked app only (faster, for testing)
//   node tools/package.mjs --npm      -> also the two npm packages, from the unpacked app, in apps/desktop/release/npm:
//                                        @bosmainteractive/yaho (launcher + CLI) and @bosmainteractive/yaho-<os>-<arch>
// Signing happens inside electron-builder when CI provides the identity (see .github/workflows/release.yml).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(repo, 'apps/desktop');
const stage = join(desktop, 'build/app');
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const npmPackages = process.argv.includes('--npm');
const dirOnly = process.argv.includes('--dir');
const platformId = `${process.platform}-${process.arch}`;
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
cpSync(join(repo, 'assets/logo/yaho.ico'), join(stage, 'yaho.ico'));
cpSync(join(repo, 'assets/logo/mark-256.png'), join(stage, 'yaho.png'));

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
  // The UI is in English; Chromium's other translations are 45 MB that nobody sees.
  electronLanguages: ['en-US'],
  // The Yaho mark for the exe, the installer and the shortcuts (Windows takes the taskbar icon from these).
  win: {
    target: dirOnly ? 'dir' : 'nsis',
    icon: join(repo, 'assets/logo/yaho.ico'),
    // Sign with Azure Artifact Signing through our hook (CI only; see tools/sign-windows.cjs), every exe and dll,
    // the bundled Dopbase included.
    signtoolOptions: { sign: join(repo, 'tools/sign-windows.cjs'), publisherName: ['Bosma Interactive AB'] },
    signExts: ['.exe', '.dll'],
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  // macOS: hardened runtime and Electron's entitlements, needed for notarization. CI sets the identity
  // (CSC_LINK, CSC_KEY_PASSWORD) and the notary key (APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER).
  mac: {
    target: dirOnly ? 'dir' : 'dmg',
    icon: join(repo, 'assets/logo/mark-1024.png'),
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    entitlements: join(repo, 'tools/entitlements.mac.plist'),
    entitlementsInherit: join(repo, 'tools/entitlements.mac.plist'),
    notarize: !!process.env.APPLE_API_KEY_ID,
  },
  linux: { target: dirOnly ? 'dir' : 'AppImage', icon: join(repo, 'assets/logo/mark-1024.png'), executableName: 'yaho', category: 'Development' },
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
  [
    builder,
    '--config',
    join(desktop, 'build/electron-builder.json'),
    { win32: '--win', darwin: '--mac', linux: '--linux' }[process.platform],
    ...(dirOnly ? ['--dir'] : []),
  ],
  {
    cwd: desktop,
    stdio: 'inherit',
    env: { ...process.env, [pathKey]: tidyPath },
  },
);
if (npmPackages) writeNpmPackages();
console.log(`\nDone: ${join(desktop, 'release')}`);

/**
 * The two npm packages: the app for this platform (what electron-builder made, unpacked; on macOS the .app zipped with
 * ditto, since npm cannot hold its symlinks) and the launcher, which every platform builds the same way.
 */
function writeNpmPackages() {
  const release = join(desktop, 'release');
  const out = join(release, 'npm');
  rmSync(out, { recursive: true, force: true });
  const meta = {
    version,
    license: 'MIT',
    author: 'Bosma Interactive AB',
    homepage: 'https://github.com/nielsbosma/yaho',
    repository: { type: 'git', url: 'git+https://github.com/nielsbosma/yaho.git' },
  };

  const appPkg = join(out, `yaho-${platformId}`);
  mkdirSync(appPkg, { recursive: true });
  let manifest;
  if (process.platform === 'darwin') {
    const macDir = readdirSync(release).find((d) => d.startsWith('mac') && existsSync(join(release, d, 'Yaho.app')));
    if (!macDir) throw new Error('no Yaho.app in the release folder');
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(release, macDir, 'Yaho.app'), join(appPkg, 'Yaho.app.zip')], {
      stdio: 'inherit',
    });
    manifest = { zip: 'Yaho.app.zip' };
  } else {
    const unpacked = readdirSync(release).find((d) => d.endsWith('-unpacked'));
    if (!unpacked) throw new Error('no unpacked app in the release folder');
    cpSync(join(release, unpacked), join(appPkg, 'app'), { recursive: true });
    manifest = { exe: process.platform === 'win32' ? 'app/Yaho.exe' : 'app/yaho' };
  }
  const appJson = {
    name: `@bosmainteractive/yaho-${platformId}`,
    description: `The Yaho app for ${platformId}. Install @bosmainteractive/yaho instead.`,
    ...meta,
    os: [process.platform],
    cpu: [process.arch],
    yaho: manifest,
  };
  writeFileSync(join(appPkg, 'package.json'), JSON.stringify(appJson, null, 2));
  writeFileSync(
    join(appPkg, 'README.md'),
    `# Yaho for ${platformId}\n\nThe signed Yaho app for this platform. Install @bosmainteractive/yaho instead:\n\n    npm i -g @bosmainteractive/yaho\n`,
  );
  cpSync(join(repo, 'LICENSE'), join(appPkg, 'LICENSE'));

  const launcherPkg = join(out, 'yaho');
  mkdirSync(launcherPkg, { recursive: true });
  cpSync(join(stage, 'cli'), join(launcherPkg, 'cli'), { recursive: true });
  const platforms = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
  const launcherJson = {
    name: '@bosmainteractive/yaho',
    description: 'Yet Another Harness Orchestrator: long-lived, self-improving agents on a schedule, with a human in the loop.',
    ...meta,
    type: 'module',
    bin: { yaho: 'cli/main.mjs' },
    engines: { node: '>=22.17.0' },
    optionalDependencies: Object.fromEntries(platforms.map((p) => [`@bosmainteractive/yaho-${p}`, version])),
  };
  writeFileSync(join(launcherPkg, 'package.json'), JSON.stringify(launcherJson, null, 2));
  cpSync(join(repo, 'README.md'), join(launcherPkg, 'README.md'));
  cpSync(join(repo, 'LICENSE'), join(launcherPkg, 'LICENSE'));
  console.log(`\nnpm packages: ${out}`);
}
