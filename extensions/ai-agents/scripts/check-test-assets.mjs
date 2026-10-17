// Fails when generated evidence, raw captures, or likely secrets are tracked.
// Small synthetic JSON may be added to jsonAllowlist with a reason. The list is empty.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../../..');
const extension = path.join(repo, 'extensions/ai-agents');
const jsonAllowlist = new Set();
const failures = [];
const files = [
  ...execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString().split('\0'),
  ...execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: repo }).toString().split('\0'),
].filter((file) => file && existsSync(path.join(repo, file)));

const banned = [
  { pattern: /(?:^|\/)test\/fixtures\/real\//, reason: 'raw captured fixtures are not tracked' },
  { pattern: /(?:^|\/)docs\/evidence\//, reason: 'verification evidence is local only' },
  { pattern: /(?:^|\/)docs\/screenshots\//, reason: 'screenshots are local only' },
  { pattern: /(?:^|\/)[^/]*runtime-0\d/, reason: 'version-stamped runtime captures are not tracked' },
  { pattern: /(?:^|\/)[^/]*reliability-0\d/, reason: 'version-stamped reliability artifacts are not tracked' },
  { pattern: /RELIABILITY_\d/, reason: 'version-stamped reliability artifacts are not tracked' },
  { pattern: /\.vsix$/, reason: 'VSIX packages are build output' },
];

for (const file of files) {
  for (const rule of banned) if (rule.pattern.test(file)) failures.push(`${file}: ${rule.reason}`);
  if (!file.includes('/test/') || !file.endsWith('.json') || jsonAllowlist.has(file)) continue;
  const size = statSync(path.join(repo, file)).size;
  if (size > 8 * 1024) failures.push(`${file}: tracked test JSON is ${size} bytes; keep synthetic fixtures small`);
}

const secret = /\bsk-[A-Za-z0-9]{20,}\b|(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*['"][^'"]{20,}['"]/i;
for (const file of files) {
  if (!/\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/.test(file)) continue;
  const lines = readFileSync(path.join(repo, file), 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.includes('\\b') || line.includes('{8,}') || line.includes('[redacted]')) return;
    if (secret.test(line)) failures.push(`${file}:${index + 1}: looks like a secret`);
  });
}

const fixtureRoot = path.join(extension, 'test/fixtures');
const fixtureFiles = readdirSync(fixtureRoot, { recursive: true }).flatMap((entry) => {
  const relative = String(entry);
  return statSync(path.join(fixtureRoot, relative)).isFile() ? [relative] : [];
});
const referenced = files
  .filter((file) => file.startsWith('extensions/ai-agents/') && /\.(?:ts|mjs|cjs|md)$/.test(file))
  .map((file) => readFileSync(path.join(repo, file), 'utf8'))
  .join('\n');
for (const fixture of fixtureFiles) {
  const name = path.basename(fixture);
  if (!referenced.includes(name)) failures.push(`extensions/ai-agents/test/fixtures/${fixture}: fixture is not referenced`);
}
for (const match of referenced.matchAll(/fixtures\/(?:real\/)?([A-Za-z0-9._-]+\.(?:json|cjs|mjs))/g)) {
  const name = match[1];
  if (!fixtureFiles.some((fixture) => path.basename(fixture) === name)) failures.push(`missing fixture ${name}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Test assets look clean (${files.length} files).`);
