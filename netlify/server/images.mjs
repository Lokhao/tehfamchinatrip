import { createHash } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { PublicError } from './errors.mjs';

export const imageKey = /^[a-f0-9]{64}\.(jpg|png|webp)$/;
const types = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const store = () => getStore({ name: 'trip-images', consistency: 'strong' });

export async function storeImage(source) {
  if (/^\/api\/images\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(source)) return source;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match) throw new PublicError('Choose a JPEG, PNG, or WebP picture.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 4 * 1024 * 1024) {
    throw new PublicError('A picture is too large. Choose a smaller picture.', 413);
  }
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const valid = ext === 'jpg' ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new PublicError('This picture could not be read.');
  const key = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  await store().set(key, bytes);
  return `/api/images/${key}`;
}

export async function readImage(key) {
  if (!imageKey.test(key)) return null;
  const bytes = await store().get(key, { type: 'arrayBuffer' });
  return bytes ? { bytes, type: types[key.split('.').pop()] } : null;
}
