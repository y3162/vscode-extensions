import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ImageAttachment } from './types.js';

const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const maxBytes = 5 * 1024 * 1024;
const maxImages = 4;

export function sanitizeImages(input: unknown): ImageAttachment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('画像の形式が不正です。');
  const images: ImageAttachment[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('画像の形式が不正です。');
    const record = item as Record<string, unknown>;
    let mimeType = record.mimeType;
    if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
    const data = typeof record.data === 'string' ? record.data.replace(/\s/g, '') : '';
    const name = typeof record.name === 'string' ? record.name.slice(0, 120) : undefined;
    if (typeof mimeType !== 'string' || !allowed.has(mimeType) || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      throw new Error('画像は PNG / JPEG / GIF / WebP を4枚まで、1枚5MB以下にしてください。');
    }
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > maxBytes) {
      throw new Error('画像は PNG / JPEG / GIF / WebP を4枚まで、1枚5MB以下にしてください。');
    }
    images.push({ mimeType, data, ...(name ? { name } : {}) });
    if (images.length > maxImages) throw new Error('画像は PNG / JPEG / GIF / WebP を4枚まで、1枚5MB以下にしてください。');
  }
  return images;
}

export async function writeImageFiles(images: ImageAttachment[]): Promise<string[]> {
  if (!images.length) return [];
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-agents-images-'));
  const paths: string[] = [];
  for (const [index, image] of images.entries()) {
    const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.slice('image/'.length);
    const file = path.join(directory, `${index}.${extension}`);
    await writeFile(file, Buffer.from(image.data, 'base64'));
    paths.push(file);
  }
  return paths;
}
