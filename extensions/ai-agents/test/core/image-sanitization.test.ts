import assert from 'node:assert/strict';

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { test } from 'node:test';

import { sanitizeImages, writeImageFiles } from '../../src/images.js';

test('image sanitizing enforces mime, base64, name, count, and size boundaries before writing', async () => {
  assert.deepEqual(sanitizeImages(undefined), []);
  assert.deepEqual(sanitizeImages(null), []);
  assert.throws(() => sanitizeImages('nope'), /画像の形式が不正です/);
  assert.throws(() => sanitizeImages([null]), /画像の形式が不正です/);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: '=' }]), /5MB/);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: '***' }]), /5MB/);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: 42 }]), /5MB/);
  assert.throws(() => sanitizeImages([{ mimeType: 'text/plain', data: Buffer.from('a').toString('base64') }]), /5MB/);
  const exact = Buffer.alloc(5 * 1024 * 1024, 1);
  const over = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  const one = sanitizeImages([{ mimeType: 'image/jpg', data: exact.toString('base64'), name: `${'n'.repeat(121)}.png` }]);
  assert.equal(one[0]?.mimeType, 'image/jpeg');
  assert.equal(one[0]?.name?.length, 120);
  assert.throws(() => sanitizeImages([{ mimeType: 'image/png', data: over.toString('base64') }]), /5MB/);
  const four = [0, 1, 2, 3].map((index) => ({ mimeType: index === 1 ? 'image/jpeg' : index === 2 ? 'image/gif' : index === 3 ? 'image/webp' : 'image/png', data: Buffer.from(`img${index}`).toString('base64'), name: index === 0 ? '' : `f${index}` }));
  assert.equal(sanitizeImages(four).length, 4);
  assert.equal(sanitizeImages(four)[0]?.name, undefined);
  assert.throws(() => sanitizeImages([...four, four[0]!]), /4枚まで/);
  assert.deepEqual(await writeImageFiles([]), []);
  const paths = await writeImageFiles(sanitizeImages(four));
  try {
    assert.deepEqual(paths.map((file) => path.extname(file)), ['.png', '.jpg', '.gif', '.webp']);
    assert.equal(await readFile(paths[1]!, 'utf8'), 'img1');
  } finally { await rm(path.dirname(paths[0]!), { recursive: true, force: true }); }
});;
