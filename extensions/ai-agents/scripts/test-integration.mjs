import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = resolve(import.meta.dirname, '..');
const repoRoot = resolve(root, '../..');
const developmentPath = resolve(process.env.AI_AGENTS_TEST_EXTENSION_PATH || root);
const evidence = process.env.AI_AGENTS_RELIABILITY_EVIDENCE;
if (evidence) {
  const resolved = resolve(evidence);
  if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${sep}`)) {
    throw new Error('AI_AGENTS_RELIABILITY_EVIDENCE must be outside the repository. Set it to a temporary directory.');
  }
}
const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
const fixture = await mkdtemp(join(temporaryRoot, 'ai-agents-integration-'));
const profile = await mkdtemp(join(temporaryRoot, 'ai-agents-test-profile-'));
const userData = join(profile, 'user-data');
const extensions = join(profile, 'extensions');
const sharedData = join(profile, 'shared-data');
const vscodeCache = join(profile, 'vscode-cache');
const evidencePath = join(profile, 'isolation-receipt.json');
const successPath = join(profile, 'test-success.json');
await Promise.all([mkdir(userData, { recursive: true }), mkdir(extensions, { recursive: true }), mkdir(sharedData, { recursive: true }), mkdir(vscodeCache, { recursive: true })]);
const testBundle = join(root, 'dist', 'integration.js');
await build({ entryPoints: [join(root, 'test', 'integration', 'extension-host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: testBundle, external: ['vscode'] });
await cp(join(root, 'test', 'fixtures', 'mock-codex.cjs'), join(fixture, 'mock-codex.cjs'));
await cp(join(root, 'test', 'fixtures', 'mock-app-server.cjs'), join(fixture, 'mock-app-server.cjs'));
await cp(join(root, 'test', 'fixtures', 'synthetic-runtime.cjs'), join(fixture, 'synthetic-runtime.cjs'));

let executable = process.env.VSCODE_EXECUTABLE_PATH;
if (!executable && process.platform === 'darwin') {
  // Never spawn the user's installed VS Code as a fallback. A disposable copy
  // keeps GUI startup and profile state separate from normal VS Code windows.
  executable = await downloadAndUnzipVSCode({
    version: process.env.VSCODE_TEST_VERSION || 'stable',
    platform: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin',
    cachePath: vscodeCache,
    extensionDevelopmentPath: developmentPath,
  });
}
const launchArgs = [fixture, '--new-window', '--disable-extensions', '--user-data-dir', userData,
  '--extensions-dir', extensions, '--shared-data-dir', sharedData, '--use-inmemory-secretstorage'];
const vscodeTestArguments = [
  ...launchArgs,
  '--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
  '--no-cached-data', '--disable-workspace-trust', `--extensionTestsPath=${testBundle}`, `--extensionDevelopmentPath=${developmentPath}`,
];
let appRoot = '';
let appBundle = '';
if (process.platform === 'darwin') {
  if (!executable) throw new Error('A local macOS VS Code executable is required for GUI and Extension Host acceptance.');
  const resolvedExecutable = await realpath(executable);
  const applicationsDirectory = await realpath('/Applications');
  const executableRelativeToApplications = relative(applicationsDirectory, resolvedExecutable);
  const executableIsUnderApplications = executableRelativeToApplications === ''
    || (executableRelativeToApplications !== '..' && !executableRelativeToApplications.startsWith(`..${sep}`));
  if (executableIsUnderApplications) {
    throw new Error(`Refusing to launch a VS Code executable from /Applications; use a disposable test app: ${resolvedExecutable}`);
  }
  appRoot = await realpath(join(dirname(resolvedExecutable), '../Resources/app'));
  appBundle = resolve(appRoot, '../../..');
  const profileRoot = await realpath(profile);
  for (const target of [userData, extensions, sharedData]) {
    const resolved = await realpath(target);
    const rel = relative(profileRoot, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(profileRoot, rel) !== resolved) {
      throw new Error(`Refusing to launch: VS Code isolation directory escapes temporary profile: ${target}`);
    }
  }
  const sharedState = join(sharedData, 'sharedStorage', 'state.vscdb');
  const defaultSharedState = join(process.env.HOME || '', '.vscode-shared', 'sharedStorage', 'state.vscdb');
  if (resolve(sharedState) === resolve(defaultSharedState)) throw new Error('Refusing to launch: shared storage is not isolated.');
  const installedExtensions = await readdir(extensions);
  if (installedExtensions.length) throw new Error('Refusing to launch: isolated extensions directory is not empty.');
  const evidenceRelative = relative(profile, evidencePath);
  if (evidenceRelative === '..' || evidenceRelative.startsWith(`..${sep}`)) throw new Error('Refusing to write isolation receipt outside temporary profile.');
  console.log('ISOLATION_PREFLIGHT', JSON.stringify({
    executable: resolvedExecutable,
    appRoot,
    appBundle,
    argv: [resolvedExecutable, ...vscodeTestArguments],
    workspace: await realpath(fixture),
    userData: await realpath(userData),
    extensions: await realpath(extensions),
    sharedData: await realpath(sharedData),
  }));
}
try {
  for (const stage of process.env.AI_AGENTS_RELIABILITY === '1' ? ['initial', 'reload'] : ['normal']) await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: developmentPath,
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
      AI_AGENTS_REWIND_UI_HOLD: process.env.AI_AGENTS_REWIND_UI_HOLD,
      AI_AGENTS_REWIND_UI_MOCK: process.env.AI_AGENTS_REWIND_UI_MOCK,
      AI_AGENTS_GUI_MOCK_HOLD: process.env.AI_AGENTS_GUI_MOCK_HOLD,
      AI_AGENTS_SUBAGENT_GUI_HOLD: process.env.AI_AGENTS_SUBAGENT_GUI_HOLD,
      AI_AGENTS_SUBAGENT_GUI_FINAL_HOLD: process.env.AI_AGENTS_SUBAGENT_GUI_FINAL_HOLD,
      AI_AGENTS_TERMINAL_UI_HOLD: process.env.AI_AGENTS_TERMINAL_UI_HOLD,
      AI_AGENTS_ISOLATION_CHECK: process.platform === 'darwin' ? '1' : undefined,
      AI_AGENTS_EXPECTED_EXTENSION_PATH: process.platform === 'darwin' ? developmentPath : undefined,
      AI_AGENTS_EXPECTED_WORKSPACE: process.platform === 'darwin' ? fixture : undefined,
      AI_AGENTS_EXPECTED_USER_DATA: process.platform === 'darwin' ? userData : undefined,
      AI_AGENTS_EXPECTED_SHARED_DATA: process.platform === 'darwin' ? sharedData : undefined,
      AI_AGENTS_EXPECTED_APP_ROOT: process.platform === 'darwin' ? appRoot : undefined,
      AI_AGENTS_EXPECTED_APP_BUNDLE: process.platform === 'darwin' ? resolve(appRoot, '../../..') : undefined,
      AI_AGENTS_ISOLATION_EVIDENCE: process.platform === 'darwin' ? evidencePath : undefined,
      AI_AGENTS_TEST_SUCCESS_EVIDENCE: process.platform === 'darwin' ? successPath : undefined,
    },
    launchArgs,
  });
  if (process.platform === 'darwin') {
    const receipt = JSON.parse(await readFile(evidencePath, 'utf8'));
    assert.equal(receipt.platform, 'darwin');
    assert.equal(receipt.extensionPath, await realpath(developmentPath));
    assert.equal(receipt.workspacePath, await realpath(fixture));
    assert.equal(receipt.userDataPath, await realpath(userData));
    assert.equal(receipt.sharedDataPath, await realpath(sharedData));
    assert.equal(receipt.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
    // The Extension Host test runner keeps VS Code shared storage in memory. The
    // interactive Development Host writes sharedStorage/state.vscdb under this
    // --shared-data-dir; this test verifies the isolated directory argument/receipt.
    console.log('ISOLATION_RUNTIME_PASS', JSON.stringify(receipt));
    if (process.env.AI_AGENTS_RELIABILITY !== '1') {
      const testSuccess = JSON.parse(await readFile(successPath, 'utf8'));
      assert.equal(testSuccess.status, 'passed', 'VS Code must finish every Extension Host integration assertion');
      console.log('INTEGRATION_ASSERTIONS_PASS', JSON.stringify(testSuccess));
    }
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
