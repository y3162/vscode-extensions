import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { expandPrompt, parseFrontmatter, suggestionToken, type SlashCommand } from '../../src/context-text.js';

test('prompt expansion skips empty files and symlinks outside the workspace without losing other context', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-agents-context-branches-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ai-agents-context-outside-'));
  try {
    const folder = path.join(root, 'folder');
    await mkdir(folder);
    await writeFile(path.join(folder, 'empty.ts'), '');
    await writeFile(path.join(folder, 'visible.md'), 'safe workspace text');
    await writeFile(path.join(outside, 'secret.ts'), 'outside secret');
    await symlink(path.join(outside, 'secret.ts'), path.join(folder, 'escape.ts'));

    const expanded = await expandPrompt('@folder', root);
    assert.match(expanded, /visible\.md[\s\S]*safe workspace text/);
    assert.doesNotMatch(expanded, /outside secret/);
    assert.doesNotMatch(expanded, /empty\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('frontmatter defaults missing fields and slash expansion ignores builtins, unknown commands, and empty bodies', async () => {
  assert.deepEqual(parseFrontmatter('---\ndescription: only description\n---\nbody'), {
    title: '', description: 'only description', body: 'body',
  });
  const commands: SlashCommand[] = [
    { name: 'empty', title: 'Empty', description: '', kind: 'skill', body: '' },
  ];
  const prompt = '/clear\n/unknown command\n/empty';
  assert.equal(await expandPrompt(prompt, '/workspace', commands), prompt);
  assert.equal(suggestionToken('x @', 3)?.query, '');
  assert.equal(suggestionToken('x /', 3), undefined, 'slash commands require a non-empty command name');
});
