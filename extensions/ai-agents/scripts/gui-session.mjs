import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = '/private/tmp';
const sessionPrefix = 'ai-agents-gui-acceptance-';
const command = process.argv[2] ?? 'help';
const requestedRoot = process.argv[3];

function inside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertMacOS() {
  if (process.platform !== 'darwin') throw new Error('GUI acceptance sessions are macOS-only. Refusing to start.');
}

function requireRoot(root) {
  const absolute = resolve(root);
  if (!absolute.startsWith(`${temporaryRoot}/${sessionPrefix}`)) {
    throw new Error(`Refusing session operation outside ${temporaryRoot}/${sessionPrefix}*: ${absolute}`);
  }
  return absolute;
}

function processGroupState(pid) {
  try {
    process.kill(-pid, 0);
    return 'running';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'stopped';
    // Sandboxed callers may inspect the receipt but lack permission to probe
    // or signal a GUI process launched from the user's normal Terminal.
    if (error?.code === 'EPERM') return 'running; probe permission denied';
    throw error;
  }
}

async function sessionReceipt(root) {
  const absolute = requireRoot(root);
  const receiptPath = join(absolute, 'session.json');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.sessionRoot !== absolute) throw new Error('Session receipt is invalid.');
  return { absolute, receipt, receiptPath };
}

async function preflight(root, receipt) {
  assertMacOS();
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error(`Session root resolves unexpectedly: ${canonicalRoot}`);
  const paths = receipt.paths;
  for (const key of ['workspace', 'userData', 'extensions', 'sharedData', 'home', 'codexHome', 'cursorHome', 'cache']) {
    const value = await realpath(paths[key]);
    if (!inside(canonicalRoot, value)) throw new Error(`Isolation preflight failed: ${key} escapes disposable root: ${value}`);
  }
  const appBundle = await realpath(paths.appBundle);
  const executable = await realpath(paths.executable);
  if (!inside(canonicalRoot, appBundle) || !inside(appBundle, executable)) {
    throw new Error('Isolation preflight failed: the VS Code application is outside the disposable root.');
  }
  const extension = await realpath(paths.extension);
  if (extension !== await realpath(extensionRoot)) throw new Error('Isolation preflight failed: unexpected extension checkout.');
  if (paths.mockExecutable && paths.fixtureBin) {
    const fixtureExecutable = await realpath(paths.mockExecutable);
    const fixtureBin = await realpath(paths.fixtureBin);
    if (!inside(canonicalRoot, fixtureBin) || !inside(fixtureBin, fixtureExecutable)) {
      throw new Error('Isolation preflight failed: fixture executable escaped the disposable session.');
    }
  }
  const workspace = await realpath(paths.workspace);
  if (workspace !== paths.workspace || !inside(canonicalRoot, workspace)) throw new Error('Isolation preflight failed: workspace escaped the disposable root.');
  const installedExtensions = await readdir(paths.extensions);
  const unexpectedExtensionFiles = installedExtensions.filter((entry) => entry !== 'extensions.json');
  if (unexpectedExtensionFiles.length) throw new Error(`Isolation preflight failed: unexpected entries in the isolated extensions directory: ${unexpectedExtensionFiles.join(', ')}`);
  if (installedExtensions.includes('extensions.json')) {
    const extensionRegistry = JSON.parse(await readFile(join(paths.extensions, 'extensions.json'), 'utf8'));
    if (!Array.isArray(extensionRegistry) || extensionRegistry.length !== 0) {
      throw new Error('Isolation preflight failed: the isolated extensions registry is not empty.');
    }
  }
  const isolatedSharedState = join(paths.sharedData, 'sharedStorage', 'state.vscdb');
  const defaultSharedStates = [
    join(process.env.HOME ?? '', '.vscode-shared', 'sharedStorage', 'state.vscdb'),
    join(paths.home, '.vscode-shared', 'sharedStorage', 'state.vscdb'),
  ];
  if (defaultSharedStates.some((value) => resolve(value) === resolve(isolatedSharedState))) throw new Error('Isolation preflight failed: shared storage is not isolated.');
  const manifest = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
  if (manifest.version !== receipt.extensionVersion) throw new Error('Extension version changed after this session was prepared.');
  return { root: canonicalRoot, appBundle, executable, extension, workspace, isolatedSharedState };
}

function assertCodeSignedApp(appBundle) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'pipe' });
  } catch (error) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(`Refusing to launch a disposable VS Code app whose code signature does not verify${detail ? `: ${detail}` : '.'}`);
  }
}

async function start() {
  assertMacOS();
  if (requestedRoot) throw new Error('start creates a new session; use the printed path with status/stop/cleanup.');
  const root = await mkdtemp(join(temporaryRoot, sessionPrefix));
  const paths = {
    appBundle: '', executable: '', appRoot: '', extension: await realpath(extensionRoot),
    workspace: join(root, 'workspace'), profile: join(root, 'profile'),
    userData: join(root, 'profile', 'user-data'), extensions: join(root, 'profile', 'extensions'),
    sharedData: join(root, 'profile', 'shared-data'), home: join(root, 'isolated-home'),
    codexHome: join(root, 'isolated-home', '.codex'), cursorHome: join(root, 'isolated-home', '.cursor'),
    cache: join(root, 'vscode-cache'), tmp: join(root, 'tmp'), fixtureBin: join(root, 'fixture-bin'),
    mockExecutable: join(root, 'fixture-bin', 'codex-cli'),
  };
  const manifest = JSON.parse(await readFile(join(paths.extension, 'package.json'), 'utf8'));
  const receipt = {
    schemaVersion: 1,
    sessionRoot: root,
    sessionId: root.slice(root.lastIndexOf('/') + 1),
    createdAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    vscodeVersion: null,
    extensionVersion: manifest.version,
    backend: 'deterministic Mock only; no authentication requested',
    credentialsCopied: false,
    launchStatus: 'prepared; not launched',
    paths,
    launchArgs: [],
  };
  const receiptPath = join(root, 'session.json');
  await Promise.all(Object.entries(paths).filter(([key, value]) => value && key !== 'extension' && key !== 'mockExecutable').map(([, value]) => mkdir(value, { recursive: true })));
  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  await writeFile(paths.mockExecutable, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(paths.extension, 'test/fixtures/mock-codex.cjs'))} "$@"\n`, { mode: 0o755 });
  await mkdir(join(paths.userData, 'User'), { recursive: true });
  await writeFile(join(paths.userData, 'User', 'settings.json'), `${JSON.stringify({
    // executablePath has machine scope, so VS Code ignores it in workspace settings.
    'ai-agents.codex.executablePath': paths.mockExecutable,
  }, null, 2)}\n`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const mockBackend = resolve(extensionRoot, 'test/fixtures/mock-codex.cjs');
  const mockRuntime = resolve(extensionRoot, 'test/fixtures/synthetic-runtime.cjs');
  await access(mockBackend); await access(mockRuntime);
  await writeFile(join(paths.workspace, 'README.md'), '# Isolated AI Agents GUI acceptance workspace\n\nDisposable synthetic workspace. No user source files or credentials are copied here.\n');
  await mkdir(join(paths.workspace, '.vscode'), { recursive: true });
  await writeFile(join(paths.workspace, '.vscode', 'settings.json'), `${JSON.stringify({
    'workbench.startupEditor': 'none',
    'workbench.colorTheme': 'Dark Modern',
    'ai-agents.history.enabled': true,
    'ai-agents.defaultProvider': 'codex',
    'ai-agents.autoApprove': false,
  }, null, 2)}\n`);
  await writeFile(join(paths.workspace, '.ai-agents-gui-session.json'), JSON.stringify({
    fixture: 'deterministic-mock-cli', mockBackend, mockRuntime, mockExecutable: paths.mockExecutable, credentialsCopied: false,
  }, null, 2));

  let executable;
  if (process.env.AI_AGENTS_GUI_VSCODE_APP_BUNDLE) {
    const sourceBundle = await realpath(process.env.AI_AGENTS_GUI_VSCODE_APP_BUNDLE);
    if (sourceBundle.startsWith('/Applications/') || !sourceBundle.startsWith(`${temporaryRoot}/`)) {
      throw new Error(`Offline app source must be a previously downloaded disposable app under ${temporaryRoot}: ${sourceBundle}`);
    }
    const sourceProduct = JSON.parse(await readFile(join(sourceBundle, 'Contents/Resources/app/product.json'), 'utf8'));
    const bundleInfo = await readFile(join(sourceBundle, 'Contents/Info.plist'));
    if (!sourceProduct.version || !bundleInfo.length || !sourceBundle.endsWith('.app')) throw new Error('Offline app source is not a complete VS Code app bundle.');
    const appCopy = join(paths.cache, 'local-disposable-app', 'Visual Studio Code.app');
    await mkdir(dirname(appCopy), { recursive: true });
    execFileSync('/bin/cp', ['-cR', sourceBundle, appCopy], { stdio: 'ignore' });
    executable = join(appCopy, 'Contents/MacOS/Code');
  } else {
    executable = await downloadAndUnzipVSCode({
      version: process.env.VSCODE_TEST_VERSION || 'stable',
      platform: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin',
      cachePath: paths.cache,
      extensionDevelopmentPath: paths.extension,
    });
  }
  paths.executable = await realpath(executable);
  paths.appRoot = await realpath(join(dirname(paths.executable), '../Resources/app'));
  paths.appBundle = resolve(paths.appRoot, '../../..');
  const version = JSON.parse(await readFile(join(paths.appRoot, 'product.json'), 'utf8')).version;
  receipt.vscodeVersion = version;
  receipt.launchArgs = [
    paths.workspace, '--new-window', '--disable-extensions', '--disable-updates',
    '--use-inmemory-secretstorage',
    '--skip-welcome', '--skip-release-notes', '--no-cached-data',
    `--user-data-dir=${paths.userData}`, `--extensions-dir=${paths.extensions}`,
    `--shared-data-dir=${paths.sharedData}`, `--extensionDevelopmentPath=${paths.extension}`,
  ];
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const checked = await preflight(root, receipt);
  assertCodeSignedApp(checked.appBundle);
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.home,
    USERPROFILE: paths.home,
    CODEX_HOME: paths.codexHome,
    CURSOR_HOME: paths.cursorHome,
    TMPDIR: paths.tmp,
    LANG: 'en_US.UTF-8',
  };
  const child = spawn(checked.executable, receipt.launchArgs, { cwd: root, env, detached: true, stdio: 'ignore' });
  receipt.processId = child.pid;
  receipt.launchStatus = 'single isolated GUI launch attempt started; awaiting process check';
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const launchOutcome = await new Promise((resolveOutcome, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolveOutcome({ code: null, signal: null }); } }, 4000);
    child.once('error', (error) => { clearTimeout(timer); settled = true; reject(error); });
    child.once('exit', (code, signal) => {
      if (!settled) { clearTimeout(timer); settled = true; resolveOutcome({ code, signal }); }
    });
  });
  child.unref();
  const childProcessGroupState = child.pid ? processGroupState(child.pid) : 'stopped';
  const processGroupAlive = childProcessGroupState !== 'stopped';
  if (launchOutcome.code !== null || launchOutcome.signal) {
    receipt.launchStatus = `GUI process exited during launch check (code=${launchOutcome.code}, signal=${launchOutcome.signal})`;
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    throw new Error(`VS Code exited during the single launch attempt (code=${launchOutcome.code}, signal=${launchOutcome.signal}). Session preserved at ${root}`);
  }
  if (!processGroupAlive) {
    receipt.launchStatus = 'GUI process group exited before isolation could be visually verified';
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    throw new Error(`The VS Code process group exited during the single launch attempt. Session preserved at ${root}`);
  }
  receipt.launchStatus = 'process started; GUI isolation still requires visual verification';
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log('GUI_ISOLATION_PREFLIGHT_PASS', JSON.stringify({
    sessionId: receipt.sessionId, root: checked.root, executable: checked.executable,
    appBundle: checked.appBundle, workspace: checked.workspace, userData: paths.userData,
    extensions: paths.extensions, sharedData: paths.sharedData, extension: checked.extension,
    vscodeVersion: version, extensionVersion: manifest.version, processId: child.pid,
    launchArgs: receipt.launchArgs, credentialsCopied: false,
  }, null, 2));
  console.log(`GUI_SESSION_STARTED ${root}`);
  console.log('Do not clean up until GUI acceptance is complete. Use status, stop, then cleanup explicitly.');
}

async function status() {
  if (!requestedRoot) throw new Error('Usage: node scripts/gui-session.mjs status <session-root>');
  const { absolute, receipt } = await sessionReceipt(requestedRoot);
  const checked = receipt.paths?.executable ? await preflight(absolute, receipt) : null;
  const processGroupStatus = receipt.processId ? processGroupState(receipt.processId) : 'unknown';
  const processGroupAlive = processGroupStatus === 'running' || processGroupStatus === 'running; probe permission denied';
  console.log(JSON.stringify({
    sessionId: receipt.sessionId, sessionRoot: absolute,
    launchStatus: processGroupAlive ? receipt.launchStatus : (receipt.processId ? 'launch process group is no longer running' : receipt.launchStatus ?? 'not started'),
    processId: receipt.processId ?? null, vscodeVersion: receipt.vscodeVersion,
    processGroupAlive, processGroupStatus,
    extensionVersion: receipt.extensionVersion, paths: receipt.paths,
    isolation: checked ? 'path preflight passed; verify window title/process arguments and loaded extension in the GUI' : 'session prepared; VS Code was not launched',
    credentialsCopied: receipt.credentialsCopied,
    sharedDataPath: checked?.isolatedSharedState ?? receipt.paths.sharedData,
  }, null, 2));
}

async function stop() {
  if (!requestedRoot) throw new Error('Usage: node scripts/gui-session.mjs stop <session-root>');
  const { absolute, receipt, receiptPath } = await sessionReceipt(requestedRoot);
  await preflight(absolute, receipt);
  if (!receipt.processId) throw new Error('No recorded GUI process. Quit the disposable VS Code window manually.');
  try { process.kill(-receipt.processId, 'SIGTERM'); }
  catch (error) {
    if (error?.code === 'EPERM') throw new Error(`Cannot signal GUI process group ${receipt.processId} from this caller. Quit the disposable window manually; session retained at ${absolute}.`);
    if (error?.code !== 'ESRCH') throw error;
  }
  receipt.launchStatus = 'stop requested; confirm the disposable window and Extension Host have closed before cleanup';
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`GUI_STOP_REQUESTED ${receipt.processId}`);
  console.log('Confirm in the GUI that only the disposable host closed; run cleanup only after it has fully exited.');
}

async function cleanup() {
  if (!requestedRoot) throw new Error('Usage: node scripts/gui-session.mjs cleanup <session-root>');
  const { absolute, receipt } = await sessionReceipt(requestedRoot);
  const canonicalRoot = await realpath(absolute);
  if (canonicalRoot !== absolute) throw new Error('Refusing cleanup: session root resolves through a symlink.');
  if (receipt.launchStatus === 'process started; GUI isolation still requires visual verification') {
    throw new Error('Refusing cleanup while the GUI may still be open. Stop it and confirm window closure first.');
  }
  if (receipt.processId) {
    const state = processGroupState(receipt.processId);
    if (state !== 'stopped') throw new Error(`Refusing cleanup: disposable GUI process group ${receipt.processId} is ${state}.`);
  }
  if (!inside(temporaryRoot, canonicalRoot) || canonicalRoot === temporaryRoot) throw new Error('Refusing unsafe cleanup path.');
  await rm(canonicalRoot, { recursive: true, force: false });
  console.log(`GUI_SESSION_REMOVED ${canonicalRoot}`);
}

async function help() {
  console.log('Usage:');
  console.log('  node scripts/gui-session.mjs start');
  console.log('  node scripts/gui-session.mjs status <session-root>');
  console.log('  node scripts/gui-session.mjs stop <session-root>');
  console.log('  node scripts/gui-session.mjs cleanup <session-root>');
  console.log('start creates one isolated macOS VS Code app/profile/workspace/shared-data tree and leaves it in place.');
}

try {
  if (command === 'start') await start();
  else if (command === 'status') await status();
  else if (command === 'stop') await stop();
  else if (command === 'cleanup') await cleanup();
  else await help();
} catch (error) {
  console.error(`GUI_SESSION_ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
