import { access, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(join(tmpdir(), 'ai-agents-integration-'));
const profile = await mkdtemp(join(tmpdir(), 'ai-agents-test-profile-'));
const testBundle = join(root, 'dist', 'integration.js');
await build({ entryPoints: [join(root, 'test', 'integration.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: testBundle, external: ['vscode'] });
await cp(join(root, 'test', 'fixtures', 'mock-codex.cjs'), join(fixture, 'mock-codex.cjs'));
await cp(join(root, 'test', 'fixtures', 'mock-app-server.cjs'), join(fixture, 'mock-app-server.cjs'));
await cp(join(root, 'test', 'fixtures', 'real', 'runtime-090.json'), join(fixture, 'runtime-090.json'));

let executable = process.env.VSCODE_EXECUTABLE_PATH;
if (!executable && process.platform === 'darwin') {
  const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  try { await access(installed); executable = installed; } catch { /* Download a test copy below. */ }
}
try {
  for (const stage of process.env.AI_AGENTS_RELIABILITY === '1' ? ['initial', 'reload'] : ['normal']) await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: process.env.AI_AGENTS_TEST_EXTENSION_PATH || root,
    extensionTestsPath: testBundle,
    extensionTestsEnv: {
      AI_AGENTS_RELIABILITY: process.env.AI_AGENTS_RELIABILITY,
      AI_AGENTS_RELIABILITY_HOLD: process.env.AI_AGENTS_RELIABILITY_HOLD,
      AI_AGENTS_RELIABILITY_STAGE: stage,
      AI_AGENTS_RELIABILITY_EVIDENCE: process.env.AI_AGENTS_RELIABILITY_EVIDENCE,
      ELECTRON_RUN_AS_NODE: undefined,
      AI_AGENTS_TEST_WORKSPACE: fixture,
      AI_AGENTS_LIVE_TEST: process.env.AI_AGENTS_LIVE_TEST,
      AI_AGENTS_LIVE_MODELS_TEST: process.env.AI_AGENTS_LIVE_MODELS_TEST,
      AI_AGENTS_LIVE_CURSOR_MODELS_TEST: process.env.AI_AGENTS_LIVE_CURSOR_MODELS_TEST,
      AI_AGENTS_LIVE_CURSOR_TEST: process.env.AI_AGENTS_LIVE_CURSOR_TEST,
      AI_AGENTS_LIVE_ACP_TEST: process.env.AI_AGENTS_LIVE_ACP_TEST,
      AI_AGENTS_LIVE_APP_SERVER_TEST: process.env.AI_AGENTS_LIVE_APP_SERVER_TEST,
      AI_AGENTS_REAL_PROTOCOL: process.env.AI_AGENTS_REAL_PROTOCOL,
      AI_AGENTS_LIVE_RUNTIME: process.env.AI_AGENTS_LIVE_RUNTIME,
      AI_AGENTS_UI_HOLD: process.env.AI_AGENTS_UI_HOLD,
      AI_AGENTS_TERMINAL_UI_HOLD: process.env.AI_AGENTS_TERMINAL_UI_HOLD,
    },
    launchArgs: [fixture, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir', join(profile, 'user-data'), '--extensions-dir', join(profile, 'extensions')],
  });
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
