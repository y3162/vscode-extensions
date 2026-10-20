import { cp, mkdir, watch } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build, context } from 'esbuild';
import { prepareCursorRuntime } from './cursor-runtime-patch.mjs';

const require = createRequire(import.meta.url);
const host = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/extension.js',
  sourcemap: true,
  external: ['vscode', '@cursor/sdk', '@openai/codex-sdk', '@openai/codex'],
  logLevel: 'info',
};
const worker = { ...host, entryPoints: ['src/providers/cursor-worker.ts'], outfile: 'dist/cursor-worker.cjs' };
const managedWorker = { ...host, entryPoints: ['src/providers/managed-worker.ts'], outfile: 'dist/managed-worker.cjs' };
const webview = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  outfile: 'dist/webview/main.js',
  sourcemap: true,
  logLevel: 'info',
};

async function copyAssets() {
  await prepareCursorRuntime('dist/cursor-sdk');
  const codicons = dirname(require.resolve('@vscode/codicons/package.json'));
  await mkdir('dist/webview', { recursive: true });
  await cp(join(codicons, 'dist/codicon.css'), 'dist/webview/codicon.css');
  await cp(join(codicons, 'dist/codicon.ttf'), 'dist/webview/codicon.ttf');
  await cp('src/webview/styles.css', 'dist/webview/main.css');
}

if (process.argv.includes('--watch')) {
  const [hostContext, webviewContext, workerContext, managedContext] = await Promise.all([context(host), context(webview), context(worker), context(managedWorker)]);
  await copyAssets();
  await Promise.all([hostContext.watch(), webviewContext.watch(), workerContext.watch(), managedContext.watch()]);
  const styles = watch('src/webview/styles.css');
  for await (const _event of styles) await copyAssets();
} else {
  await Promise.all([build(host), build(webview), build(worker), build(managedWorker)]);
  await copyAssets();
}
