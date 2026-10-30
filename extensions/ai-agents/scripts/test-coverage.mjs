import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ai-agents-coverage-'));
const runtime = path.join(temporary, 'runtime');

async function filesUnder(directory, predicate) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file, predicate));
    else if (entry.isFile() && predicate(file)) files.push(file);
  }
  return files;
}

try {
  const sourceFiles = await filesUnder(path.join(root, 'src'), (file) => file.endsWith('.ts'));
  const executableSources = [];
  for (const source of sourceFiles) {
    const result = await esbuild.transform(await readFile(source, 'utf8'), {
      loader: 'ts', format: 'esm', target: 'node22', sourcefile: source,
    });
    if (result.code.trim()) executableSources.push(source);
  }
  const testFiles = await filesUnder(path.join(root, 'test'), (file) => file.endsWith('.ts') && !file.includes(`${path.sep}live${path.sep}`));
  await mkdir(runtime, { recursive: true });

  const buildOptions = {
    outbase: root,
    platform: 'node',
    target: 'node22',
    bundle: false,
    sourcemap: 'linked',
    sourceRoot: pathToFileURL(root.endsWith(path.sep) ? root : `${root}${path.sep}`).href,
    sourcesContent: true,
    logLevel: 'silent',
  };
  await esbuild.build({ ...buildOptions, entryPoints: [...sourceFiles, ...testFiles], outdir: runtime, format: 'cjs' });

  await Promise.all([
    cp(path.join(root, 'package.json'), path.join(runtime, 'package.json')),
    cp(path.join(root, 'scripts'), path.join(runtime, 'scripts'), { recursive: true }),
    cp(path.join(root, 'test', 'fixtures'), path.join(runtime, 'test', 'fixtures'), { recursive: true }),
    cp(path.join(root, 'src', 'webview', 'styles.css'), path.join(runtime, 'src', 'webview', 'styles.css')),
  ]);
  for (const source of await filesUnder(path.join(root, 'test', 'support'), (file) => file.endsWith('.mjs'))) {
    await cp(source, path.join(runtime, path.relative(root, source)));
  }
  await writeFile(path.join(runtime, 'test', 'support', 'register-vscode.mjs'), `
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
const stubPath = fileURLToPath(new URL('./vscode-stub.js', import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  return specifier === 'vscode' ? nextResolve(stubPath, context) : nextResolve(specifier, context);
} });
`);
  await symlink(path.resolve(root, '../../node_modules'), path.join(runtime, 'node_modules'), 'dir');

  const testPaths = [
    ...(await filesUnder(path.join(runtime, 'test'), (file) => file.endsWith('.test.js') && !file.includes(`${path.sep}webview${path.sep}`))),
    ...(await filesUnder(path.join(runtime, 'test', 'webview'), (file) => file.endsWith('.test.js'))),
  ];
  const c8 = path.resolve(root, '../../node_modules/.bin/c8');
  const args = [
    '--include=**/src/**/*.js', '--allowExternal',
    `--reports-dir=${path.join(temporary, 'report')}`,
    `--temp-directory=${path.join(temporary, 'raw')}`,
    '--reporter=json', '--reporter=text-summary', '--reporter=text', process.execPath,
    '--import', './test/support/register-vscode.mjs', '--test', '--test-concurrency=4', ...testPaths,
  ];
  const existingNodeOptions = process.env.NODE_OPTIONS?.trim();
  const result = spawnSync(c8, args, {
    cwd: runtime,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: [existingNodeOptions, '--enable-source-maps'].filter(Boolean).join(' ') },
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const reportPath = path.join(temporary, 'report', 'coverage-final.json');
    const coverage = JSON.parse(await readFile(reportPath, 'utf8'));
    const normalizeCoveragePath = (file) => file.replaceAll('\\', '/');
    const coveredFiles = Object.keys(coverage).map(normalizeCoveragePath);
    const missing = executableSources.filter((file) => {
      const relative = normalizeCoveragePath(path.relative(root, file));
      return !coveredFiles.some((covered) => covered === relative || covered.endsWith(`/${relative}`));
    });
    if (missing.length) {
      process.stderr.write(`Executable production modules absent from coverage:\n${missing.map((file) => `- ${path.relative(root, file)}`).join('\n')}\n`);
      process.stderr.write(`Reported files: ${coveredFiles.slice(0, 5).join(', ')}\n`);
      process.exitCode = 1;
    } else {
      const typeOnly = sourceFiles.filter((file) => !executableSources.includes(file));
      process.stdout.write(`Coverage inventory: ${executableSources.length} executable production modules; ${typeOnly.length} type-only modules emit no JavaScript.\n`);
      if (process.argv.includes('--branch-gaps')) {
        for (const [file, result] of Object.entries(coverage)) {
          const missed = [];
          const source = process.argv.includes('--branch-context') ? await readFile(file, 'utf8').then((text) => text.split(/\r?\n/u)) : undefined;
          for (const [id, counts] of Object.entries(result.b)) {
            const branch = result.branchMap[id];
            counts.forEach((count, index) => {
              if (count === 0) {
                const location = branch.locations[index] ?? branch.loc;
                const text = source?.[location.start.line - 1]?.trim();
                missed.push(`${location.start.line}:${location.start.column} (${branch.type} ${index})${text ? ` ${text}` : ''}`);
              }
            });
          }
          if (missed.length) process.stdout.write(`${path.relative(root, file)} branches missed (${missed.length}): ${missed.join(', ')}\n`);
        }
      }
      if (process.argv.includes('--function-gaps')) {
        for (const [file, result] of Object.entries(coverage)) {
          const missed = Object.entries(result.f).flatMap(([id, count]) => {
            if (count !== 0) return [];
            const fn = result.fnMap[id];
            const location = fn?.decl ?? fn?.loc;
            return location ? [`${location.start.line}:${location.start.column} ${fn.name || '(anonymous)'}`] : [];
          });
          if (missed.length) process.stdout.write(`${path.relative(root, file)} functions missed (${missed.length}): ${missed.join(', ')}\n`);
        }
      }
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
