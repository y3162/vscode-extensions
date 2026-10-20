/** Unit-only Git protocol double. Never creates repositories, index entries or commits.
 * Files remain real so baseline/revert safety is exercised; Git responses are mocked.
 * This is not evidence of integration with the Git executable.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

type Entry = { bytes: Buffer; mode: number };
type Fixture = { revision?: string; trees: Map<string, Map<string, Entry>>; renames: Map<string, string> };
const fixtures = new Map<string, Fixture>();
const cp = createRequire(__filename)('node:child_process') as typeof import('node:child_process');
const original = cp.execFile;

function rootOf(cwd: string): string { return realpathSync(cwd); }
function filesAt(cwd: string, prefix = ''): Map<string, Entry> {
  const rows = new Map<string, Entry>();
  for (const name of readdirSync(path.join(cwd, prefix))) {
    const rel = path.join(prefix, name);
    if (name === '.git') continue;
    const info = lstatSync(path.join(cwd, rel));
    if (info.isDirectory()) for (const [key, value] of filesAt(cwd, rel)) rows.set(key, value);
    else if (info.isFile()) rows.set(rel, { bytes: readFileSync(path.join(cwd, rel)), mode: info.mode & 0o777 });
  }
  return rows;
}
export function createGitFixture(cwd: string): void {
  fixtures.set(rootOf(cwd), { trees: new Map(), renames: new Map() });
}
export function snapshotGitFixture(cwd: string): void {
  const fixture = fixtures.get(rootOf(cwd));
  if (!fixture) throw new Error('Missing Git protocol double');
  fixture.revision = `fixture-${fixture.trees.size + 1}`;
  fixture.trees.set(fixture.revision, filesAt(cwd));
  fixture.renames.clear();
}
export function renameGitFixture(cwd: string, from: string, to: string): void {
  renameSync(path.join(cwd, from), path.join(cwd, to));
  fixtures.get(rootOf(cwd))!.renames.set(to, from);
}
function respond(cwd: string, args: string[]): string {
  const fixture = fixtures.get(rootOf(cwd))!;
  if (args[0] === 'rev-parse') {
    if (!fixture.revision) throw new Error('No fixture revision');
    return fixture.revision + '\n';
  }
  if (args[0] === 'show') {
    const [rev, ...parts] = args[1]!.split(':');
    const entry = fixture.trees.get(rev!)?.get(parts.join(':'));
    if (!entry) throw new Error('No fixture object');
    return entry.bytes.toString('utf8');
  }
  if (args[0] === 'ls-tree') {
    const name = args.at(-1)!;
    const entry = fixture.trees.get(args[2]!)?.get(name);
    return entry ? `${entry.mode & 0o111 ? '100755' : '100644'} blob fixture\t${name}\0` : '';
  }
  if (args[0] === 'diff') return '';
  if (args[0] !== 'status') throw new Error(`Unexpected mocked Git request: ${args[0]}`);
  const current = filesAt(cwd);
  const tree = fixture.trees.get(fixture.revision ?? '') ?? new Map<string, Entry>();
  const ignores = current.get('.gitignore')?.bytes.toString('utf8').split('\n').filter(Boolean) ?? [];
  let result = '';
  const renamed = new Set(fixture.renames.values());
  for (const name of new Set([...tree.keys(), ...current.keys()])) {
    if (renamed.has(name) || ignores.includes(name)) continue;
    const from = fixture.renames.get(name);
    const before = tree.get(name), after = current.get(name);
    if (from) result += `R  ${name}\0${from}\0`;
    else if (!before) result += `?? ${name}\0`;
    else if (!after) result += ` D ${name}\0`;
    else if (!before.bytes.equals(after.bytes) || before.mode !== after.mode) result += ` M ${name}\0`;
  }
  return result;
}
// Intercept only explicitly registered synthetic workspaces. Everything else uses
// the real read-only Git guard installed by the acceptance caller.
cp.execFile = ((command: string, args: string[], options: { cwd?: string }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
  let cwd: string | undefined;
  try { if (options?.cwd) cwd = rootOf(options.cwd); } catch { /* real invocation handles errors */ }
  if (command !== 'git' || !cwd || !fixtures.has(cwd)) return original(command, args, options, callback);
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; kill(): boolean };
  child.stdin = new PassThrough(); child.kill = () => true;
  if (args[0] === 'apply') {
    // One exact replacement fixture exercises success/failure dispatch. No Git
    // command is executed; real Git apply integration remains a separate check.
    let diff = '';
    child.stdin.on('data', (data: Buffer) => { diff += data.toString(); });
    child.stdin.on('end', () => {
      try {
        const name = diff.match(/^\+\+\+ b\/(.+)$/m)?.[1];
        const before = diff.match(/^-(?!-)(.*)$/m)?.[1];
        const after = diff.match(/^\+(?!\+)(.*)$/m)?.[1];
        if (!name || before === undefined || after === undefined || readFileSync(path.join(cwd!, name), 'utf8') !== `${after}\n`) throw new Error('Mock patch context mismatch');
        writeFileSync(path.join(cwd!, name), `${before}\n`); callback(null, '', '');
      } catch (error) { callback(error as Error, '', ''); }
    });
  } else queueMicrotask(() => {
    try { callback(null, respond(cwd!, args), ''); }
    catch (error) { callback(error as Error, '', ''); }
  });
  return child;
}) as typeof cp.execFile;
syncBuiltinESMExports();
