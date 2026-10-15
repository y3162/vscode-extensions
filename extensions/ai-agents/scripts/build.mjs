import { build, context } from 'esbuild';

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/extension.js',
  sourcemap: true,
  external: ['vscode', '@cursor/sdk', '@openai/codex-sdk'],
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const builder = await context(options);
  await builder.watch();
} else {
  await build(options);
}
