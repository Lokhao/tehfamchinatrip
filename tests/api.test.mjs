import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeWebsite, exampleTrip, put } from './helpers.mjs';
import { createHandler } from '../netlify/server/handler.mjs';
import { storeImage } from '../netlify/server/images.mjs';

test('saves a trip and serves it to another visitor without login', async () => {
  const site = fakeWebsite();
  assert.deepEqual(await (await site.handler(new Request('https://trip.example/api/trip'))).json(), { trip: null, rev: 0 });
  const response = await site.handler(put(exampleTrip()));
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.rev, 1);
  const read = await site.handler(new Request('https://trip.example/api/trip'));
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json(), saved);
  const updated = exampleTrip(); updated.events[0].title = 'Check in';
  assert.equal((await site.handler(put(updated, 1))).status, 200);
  assert.equal(site.saved.rev, 2);
  updated.events = [];
  assert.equal((await site.handler(put(updated, 2))).status, 200);
  assert.equal(site.saved.trip.events.length, 0);
});

test('rejects stale and simultaneous saves without overwriting the winner', async () => {
  const site = fakeWebsite();
  const trips = [exampleTrip(), exampleTrip()]; trips[1].title = 'Second visitor';
  const responses = await Promise.all(trips.map((trip) => site.handler(put(trip))));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const stale = await site.handler(put(exampleTrip(), 0));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).rev, 1);
  assert.equal(site.saved.rev, 1);
});

test('stores event and map pictures separately and saves their URLs', async () => {
  const site = fakeWebsite(); const trip = exampleTrip();
  trip.events[0].pics = ['data:image/jpeg;base64,/9j/'];
  trip.mapimgs = { 1: 'data:image/jpeg;base64,/9j/' };
  const response = await site.handler(put(trip));
  assert.equal(response.status, 200);
  assert.equal(site.uploads.length, 2);
  assert.match(site.saved.trip.events[0].pics[0], /^\/api\/images\//);
  assert.match(site.saved.trip.mapimgs[1], /^\/api\/images\//);
});

test('rejects invalid requests and cross-site saves before writing data', async () => {
  const site = fakeWebsite();
  assert.equal((await site.handler(put(exampleTrip(), 0, { Origin: 'https://unrelated.example' }))).status, 403);
  for (const mutate of [
    (trip) => { trip.events[0].day = -1; },
    (trip) => { trip.start = '2026-02-31'; },
    (trip) => { trip.events[0].time = '25:00'; },
    (trip) => { trip.events[0].textZh = { invalid: 'details' }; },
    (trip) => { trip.events[0].textZh = '中'.repeat(200001); },
    (trip) => { trip.events.push({ ...trip.events[0] }); },
    (trip) => { trip.events[0].pics = ['javascript:alert(1)']; },
    (trip) => { trip.events[0].pin = { x: 10, y: 20 }; trip.events[0].map = 99; },
  ]) {
    const trip = exampleTrip(); mutate(trip);
    assert.equal((await site.handler(put(trip))).status, 400);
  }
  const badJSON = new Request('https://trip.example/api/trip', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await site.handler(badJSON)).status, 400);
  const oversized = new Request('https://trip.example/api/trip', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(12 * 1024 * 1024 + 1) });
  assert.equal((await site.handler(oversized)).status, 413);
  assert.equal(site.saved.rev, 0);
});

test('returns a retryable error without exposing platform error messages', async () => {
  const site = fakeWebsite();
  const handler = createHandler({ ...site.dependencies, readTrip: async () => { throw Object.assign(new Error('private provider details'), { status: 401 }); } });
  const response = await handler(new Request('https://trip.example/api/trip'));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private provider/);
});

test('serves images with an explicit type, and rejects unsafe uploads', async () => {
  const site = fakeWebsite();
  const handler = createHandler({ ...site.dependencies, readImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), type: 'image/jpeg' }) });
  const response = await handler(new Request('https://trip.example/api/images/' + 'a'.repeat(64) + '.jpg'));
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /immutable/);
  await assert.rejects(() => storeImage('data:image/svg+xml;base64,PHN2Zz4='));
  await assert.rejects(() => storeImage('data:image/jpeg;base64,PGh0bWw+'));
  const existing = '/api/images/' + 'a'.repeat(64) + '.jpg';
  assert.equal(await storeImage(existing), existing);
});
