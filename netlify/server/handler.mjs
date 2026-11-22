import { validateSave } from './validation.mjs';
import { PublicError } from './errors.mjs';

const MAX_BODY = 12 * 1024 * 1024;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new PublicError('Send the trip as JSON.', 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PublicError('The save request is empty.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new PublicError('The trip has too many pictures for one save. Remove some pictures and try again.', 413);
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PublicError('The save request is invalid.'); }
}

export function createHandler({ readTrip, writeTrip, storeImage, readImage }) {
  return async function handler(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/images/')) {
        if (request.method !== 'GET') return json({ message: 'Method not allowed.' }, 405);
        const image = await readImage(url.pathname.slice('/api/images/'.length));
        if (!image) return json({ message: 'Picture not found.' }, 404);
        return new Response(image.bytes, { headers: { 'Content-Type': image.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (url.pathname !== '/api/trip') return json({ message: 'Not found.' }, 404);
      if (request.method === 'GET') return json(await readTrip());
      if (request.method !== 'PUT') return json({ message: 'Method not allowed.' }, 405);
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return json({ message: 'Save changes from the trip website.' }, 403);
      const { trip, base } = validateSave(await readBody(request));
      const current = await readTrip();
      if (current.rev !== base) return json({ ...current, message: 'The website has newer changes.' }, 409);
      for (const event of trip.events) {
        if (event.pics) event.pics = await Promise.all(event.pics.map(storeImage));
      }
      for (const [key, value] of Object.entries(trip.mapimgs)) trip.mapimgs[key] = await storeImage(value);
      const saved = await writeTrip(trip, base);
      if (!saved) return json({ ...await readTrip(), message: 'The website has newer changes.' }, 409);
      return json(saved);
    } catch (error) {
      // Do not expose database or platform errors, which can contain credentials.
      return json({ message: error instanceof PublicError ? error.message : 'The website could not save or load the trip. Please try again.' }, error instanceof PublicError ? error.status : 503);
    }
  };
}
