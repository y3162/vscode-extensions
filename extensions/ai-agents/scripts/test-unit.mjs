import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file));
    else if (entry.isFile() && file.endsWith('.test.ts') && !file.includes(`${path.sep}live${path.sep}`)) files.push(file);
  }
  return files.sort();
}

const tests = await filesUnder(path.join(root, 'test'));
const result = spawnSync(process.execPath, [
  '--import', 'tsx', '--import', './test/support/register-vscode.mjs', '--test', '--test-concurrency=4',
  ...tests.map((file) => path.relative(root, file)),
], { cwd: root, stdio: 'inherit' });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
