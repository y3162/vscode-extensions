import assert from 'node:assert/strict';

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import path from 'node:path';

import { test } from 'node:test';

import { builtinCommand, expandPrompt, parseFrontmatter, resolveInside, suggestionToken, type SlashCommand } from '../../src/context-text.js';

const mode = 0o644;

async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test('prompt expansion respects workspace boundaries, caps, and missing files', async () => {
  const root = await tempDir('ai-agents-context-gap-');
  const outside = await tempDir('ai-agents-context-out-');
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'secret', { mode: 0o600 });
    await writeFile(path.join(root, 'readme.md'), 'hello context');
    await writeFile(path.join(root, 'note.txt'), 'quoted');
    await writeFile(path.join(root, 'big.bin'), Buffer.from([0x61, 0, 0x62]));
    await writeFile(path.join(root, 'exact.txt'), 'e'.repeat(40_000));
    await writeFile(path.join(root, 'over.txt'), 'o'.repeat(40_001));
    await writeFile(path.join(root, 'bytes.txt'), 'b'.repeat(160_000));
    await writeFile(path.join(root, 'too-big.txt'), 'z'.repeat(160_001));
    await mkdir(path.join(root, 'sub', 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'ok.ts'), 'export const ok = 1;\n');
    await writeFile(path.join(root, 'sub', 'node_modules', 'secret.ts'), 'export const hidden = 1;\n');
    await mkdir(path.join(root, 'sub', 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'a', 'b', 'c', 'deep.ts'), 'export const deep = 1;\n');
    await mkdir(path.join(root, 'sub', 'a', 'b', 'c', 'd'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'a', 'b', 'c', 'd', 'too.ts'), 'export const too = 1;\n');
    const many = path.join(root, 'many');
    await mkdir(many);
    for (let index = 0; index < 21; index += 1) await writeFile(path.join(many, `f${String(index).padStart(2, '0')}.md`), `body ${index}`);
    const names = path.join(root, 'names');
    await mkdir(names);
    for (let index = 0; index < 51; index += 1) await writeFile(path.join(names, `n${String(index).padStart(2, '0')}.dat`), 'x');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    await mkdir(path.join(root, 'locked'));
    await writeFile(path.join(root, 'locked', 'file.txt'), 'hidden');
    await chmod(path.join(root, 'locked'), 0o000);
    const expanded = await expandPrompt('See @readme.md and @"note.txt" plus @missing.ts @../secret.txt @escape.txt @locked/file.txt', root);
    assert.match(expanded, /hello context/);
    assert.match(expanded, /quoted/);
    assert.match(expanded, /missing\.ts[\s\S]*\(missing\)/);
    assert.match(expanded, /outside the workspace/);
    assert.doesNotMatch(expanded, /```\nsecret\n```/);
    assert.doesNotMatch(expanded, /hidden/);
    const folder = await expandPrompt('@sub', root);
    assert.match(folder, /ok\.ts/);
    assert.match(folder, /deep\.ts/);
    assert.doesNotMatch(folder, /hidden/);
    assert.doesNotMatch(folder, /too\.ts/);
    const capped = await expandPrompt('@many', root);
    assert.equal(capped.match(/body \d+/g)?.length, 20);
    const listed = await expandPrompt('@names', root);
    assert.equal(listed.split('\n').filter((line) => line.startsWith('n')).length, 50);
    assert.match(await expandPrompt('@big.bin', root), /```\n\n```/);
    assert.match(await expandPrompt('@exact.txt', root), new RegExp(`e{${40_000}}`));
    assert.doesNotMatch(await expandPrompt('@exact.txt', root), /truncated/);
    assert.match(await expandPrompt('@over.txt', root), /truncated/);
    assert.match(await expandPrompt('@bytes.txt', root), /truncated/);
    assert.match(await expandPrompt('@too-big.txt', root), /```\n\n```/);
    assert.equal(resolveInside(root, ''), undefined);
    assert.equal(resolveInside(root, 'a\0b'), undefined);
    assert.equal(resolveInside(root, '../secret.txt'), undefined);
    assert.equal(parseFrontmatter('no header').title, '');
    assert.equal(parseFrontmatter('---\nname: "Quoted"\n').body, '---\nname: "Quoted"\n');
    const front = parseFrontmatter('---\nname: "Quoted"\ndescription: \'Desc\'\n---\nBody');
    assert.equal(front.title, 'Quoted');
    assert.equal(front.description, 'Desc');
    assert.equal(front.body, 'Body');
    assert.equal(builtinCommand('hello'), undefined);
    assert.deepEqual(builtinCommand('/Diagnostics'), { name: 'diagnostics', rest: '' });
    const long = 'y'.repeat(20_001);
    const commands: SlashCommand[] = [{ name: 'Ship', title: 'Ship', description: '', kind: 'command', body: long }];
    const slash = await expandPrompt('/Ship now', root, commands);
    assert.equal(slash.includes('y'.repeat(20_001)), false);
    assert.match(slash, new RegExp(`y{${20_000}}`));
    const blocks = Array.from({ length: 10 }, (_item, index) => ({ name: `c${index}`, title: '', description: '', kind: 'skill' as const, body: 'x'.repeat(20_000) }));
    const huge = await expandPrompt(blocks.map((item) => `/${item.name}`).join('\n'), root, blocks);
    assert.equal(huge.length, 180_000 + '\n…(context truncated)'.length);
    assert.match(huge, /context truncated/);
    const small = await expandPrompt('/c0', root, [blocks[0]!]);
    assert.equal(small.includes('context truncated'), false);
    assert.deepEqual(suggestionToken('look @src/a', 11), { kind: 'file', query: 'src/a', start: 5 });
    assert.deepEqual(suggestionToken('hello\n/rev', 10), { kind: 'slash', query: 'rev', start: 6 });
    assert.equal(suggestionToken('plain', 5), undefined);
    assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
    assert.equal((await stat(path.join(outside, 'secret.txt'))).mode & 0o777, 0o600);
  } finally {
    await chmod(path.join(root, 'locked'), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});;
