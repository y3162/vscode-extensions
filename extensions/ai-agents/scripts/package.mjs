import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVSIX } from '@vscode/vsce';

// Stage a standalone extension so npm's workspace hoisting cannot omit SDKs from the VSIX.
// Keep SDKs as real packages: both SDKs load native binaries/runtime files dynamically.
const extensionRoot = resolve(import.meta.dirname, '..');
const staging = await realpath(await mkdtemp(join(tmpdir(), 'ai-agents-package-')));
try {
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
  delete manifest.scripts;
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2));
  await mkdir(join(staging, 'dist'));
  for (const name of ['dist/extension.js', 'dist/cursor-worker.cjs', 'dist/cursor-sdk', 'dist/webview', 'resources', 'README.md', 'CHANGELOG.md', 'package.nls.json', 'package.nls.ja.json', '.vscodeignore']) {
    await cp(join(extensionRoot, name), join(staging, name), { recursive: true });
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit' });
  const target = `${process.platform}-${process.arch}`;
  const outputDir = join(extensionRoot, 'dist');
  await mkdir(outputDir, { recursive: true });
  await createVSIX({
    cwd: staging,
    packagePath: join(outputDir, `ai-agents-${target}.vsix`),
    target,
    useYarn: false,
    skipLicense: true,
  });
} finally {
  await rm(staging, { recursive: true, force: true });
}
