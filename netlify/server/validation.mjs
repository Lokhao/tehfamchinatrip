import { PublicError } from './errors.mjs';

const bad = (message) => { throw new PublicError(message); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => Number.isSafeInteger(value) && value > 0;
function text(value, max = 2000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) bad('A field is too long or invalid.');
  return value;
}
function date(value) {
  const result = text(value, 10);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result)) bad('Choose a valid trip date.');
  return result;
}
function time(value) {
  const result = text(value, 5);
  if (result && !/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) bad('Choose a valid event time.');
  return result;
}
function picture(value) {
  if (typeof value !== 'string' || value.length > 6 * 1024 * 1024 || !/^(data:image\/(jpeg|png|webp);base64,|\/api\/images\/[a-f0-9]{64}\.(jpg|png|webp)$)/.test(value)) bad('A picture is invalid.');
  return value;
}

export function validateSave(body) {
  if (!object(body) || !Number.isSafeInteger(body.base) || body.base < 0 || body.base >= 2147483647 || !object(body.trip)) bad('The save request is invalid.');
  const input = body.trip;
  if (!Array.isArray(input.maps) || !input.maps.length || input.maps.length > 100 || !Array.isArray(input.events) || input.events.length > 2000) bad('The trip must contain maps and a valid event list.');
  const maps = input.maps.map((map) => {
    if (!object(map) || !id(map.id)) bad('A map is invalid.');
    return { id: map.id, name: text(map.name) };
  });
  const mapIds = new Set(maps.map((map) => map.id));
  if (mapIds.size !== maps.length) bad('Map IDs must be unique.');
  const events = input.events.map((event) => {
    if (!object(event) || !id(event.id) || !Number.isInteger(event.day) || event.day < 1 || event.day > 36500 || !text(event.title).trim()) bad('Each event needs a title and a valid day.');
    const result = { id: event.id, day: event.day, time: time(event.time), end: time(event.end), pin: null };
    for (const field of ['title', 'loc', 'notes', 'titleZh', 'locZh', 'notesZh', 'label', 'text', 'textZh']) {
      result[field] = text(event[field], field === 'text' || field === 'textZh' ? 200000 : 20000);
    }
    if (event.pin != null) {
      if (!object(event.pin) || ![event.pin.x, event.pin.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 100) || !mapIds.has(event.map)) bad('An event has an invalid map pin.');
      result.pin = { x: event.pin.x, y: event.pin.y };
      result.map = event.map;
    }
    if (event.pics != null) {
      if (!Array.isArray(event.pics) || event.pics.length > 50) bad('An event has too many pictures.');
      result.pics = event.pics.map(picture);
    }
    return result;
  });
  if (new Set(events.map((event) => event.id)).size !== events.length) bad('Event IDs must be unique.');
  const mapimgs = {};
  if (input.mapimgs != null) {
    if (!object(input.mapimgs)) bad('The map pictures are invalid.');
    for (const [key, value] of Object.entries(input.mapimgs)) {
      if (!mapIds.has(Number(key)) || String(Number(key)) !== key) bad('A map picture has no map.');
      mapimgs[key] = picture(value);
    }
  }
  return { base: body.base, trip: { title: text(input.title), start: date(input.start), maps, events, mapimgs } };
}
