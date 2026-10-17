import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const cursorRuntimeHook = 'ai-agents.cursor-background-runtime.v1';
const supportedHash = 'dfda676be168412734925d3803ce712a335a16109ba1e161f437584ab92b8906';
const original = 'this.backgroundShellExecutor.dispose()';

/** One version-checked compatibility change: move background cleanup to the worker lease. */
export function patchCursorRuntime(source, version) {
  if (version !== '1.0.37' || createHash('sha256').update(source).digest('hex') !== supportedHash
    || source.split(original).length !== 2) {
    throw new Error('Unsupported Cursor SDK runtime. Review the background-shell lifecycle adapter before updating the SDK.');
  }
  return source.replace(original, `globalThis[Symbol.for(${JSON.stringify(cursorRuntimeHook)})].release(this.backgroundShellExecutor)`);
}

export async function prepareCursorRuntime(output) {
  const require = createRequire(import.meta.url);
  const cjs = dirname(require.resolve('@cursor/sdk'));
  const sdk = dirname(dirname(cjs));
  const manifest = JSON.parse(await readFile(join(sdk, 'package.json'), 'utf8'));
  const source = await readFile(join(cjs, '464.js'), 'utf8');
  const patched = patchCursorRuntime(source, manifest.version);
  await mkdir(output, { recursive: true });
  await cp(cjs, output, { recursive: true });
  await cp(join(sdk, 'LICENSE.md'), join(output, 'LICENSE.md'));
  await writeFile(join(output, '464.js'), patched);
}
