import { createHandler } from '../netlify/server/handler.mjs';

export function fakeWebsite(initial = { trip: null, rev: 0 }) {
  let saved = structuredClone(initial);
  const uploads = [];
  const dependencies = {
    readTrip: async () => structuredClone(saved),
    writeTrip: async (trip, base) => {
      if (saved.rev !== base) return null;
      saved = { trip: structuredClone(trip), rev: base + 1 };
      return structuredClone(saved);
    },
    storeImage: async (source) => { uploads.push(source); return '/api/images/' + 'a'.repeat(64) + '.jpg'; },
    readImage: async () => null,
  };
  return {
    handler: createHandler(dependencies), dependencies, uploads,
    get saved() { return structuredClone(saved); },
  };
}

export const exampleTrip = () => ({
  title: 'Family trip', start: '2026-12-05',
  maps: [{ id: 1, name: 'Map 1' }], mapimgs: {},
  events: [{ id: 1, title: 'Arrive', day: 1, time: '14:00', loc: 'Hotel', pin: null }],
});

export const put = (trip, base = 0, extraHeaders = {}) => new Request('https://trip.example/api/trip', {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://trip.example', ...extraHeaders },
  body: JSON.stringify({ trip, base }),
});
