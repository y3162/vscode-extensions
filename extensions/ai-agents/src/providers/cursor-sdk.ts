import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { cursorBackgroundRuntime } from './cursor-background-runtime.js';

export function loadPublishedCursorSdk(): typeof import('@cursor/sdk') {
  return createRequire(__filename)('@cursor/sdk') as typeof import('@cursor/sdk');
}

/** Selects the SDK entry without coupling worker routing tests to built artifacts. */
export function cursorSdkRuntimeEntry(
  runtimeAvailable: boolean,
  directory: string,
  fileExists: (file: string) => boolean = existsSync,
): string | undefined {
  if (!runtimeAvailable) return undefined;
  const packaged = path.join(directory, 'cursor-sdk', 'index.js');
  return fileExists(packaged) ? packaged : path.resolve(directory, '../../dist/cursor-sdk/index.js');
}

interface CursorSdkLoaderDependencies {
  runtimeAvailable: () => boolean;
  directory: string;
  fileExists: (file: string) => boolean;
  loadPublished: () => typeof import('@cursor/sdk');
  loadEntry: (entry: string) => typeof import('@cursor/sdk');
}

/** Injects the worker boundary while retaining the production entry selection and loader. */
export function createCursorSdkLoader(dependencies: CursorSdkLoaderDependencies): () => Promise<typeof import('@cursor/sdk')> {
  return async () => {
    const entry = cursorSdkRuntimeEntry(dependencies.runtimeAvailable(), dependencies.directory, dependencies.fileExists);
    return entry ? dependencies.loadEntry(entry) : dependencies.loadPublished();
  };
}

const loadFromRuntime = createCursorSdkLoader({
  runtimeAvailable: () => Boolean(cursorBackgroundRuntime()),
  directory: __dirname,
  fileExists: existsSync,
  loadPublished: loadPublishedCursorSdk,
  loadEntry: loadCursorSdkEntry,
});

export function loadCursorSdkEntry(entry: string): typeof import('@cursor/sdk') {
  return createRequire(__filename)(entry) as typeof import('@cursor/sdk');
}

export async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  // Only the isolated worker loads the compatibility runtime. Catalog/auth callers
  // keep using the published SDK; all native execution and sandboxing remain SDK-owned.
  return loadFromRuntime();
}
