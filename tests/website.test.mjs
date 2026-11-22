import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fakeWebsite, exampleTrip } from './helpers.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail('The website did not reach the expected state.');
}
async function browser(site, { cached, intercept, edit = false, settings } = {}) {
  const errors = [];
  const console = new VirtualConsole(); console.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, {
    url: 'https://trip.example', runScripts: 'dangerously', virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = () => {};
      window.AbortSignal = AbortSignal;
      window.fetch = (path, options) => {
        const request = new Request(new URL(path, window.location.href), options);
        return intercept ? intercept(request, site.handler) : site.handler(request);
      };
      if (cached) window.localStorage.setItem('tripplanner:v1', JSON.stringify(cached));
      if (settings) window.localStorage.setItem('tripplanner:set', JSON.stringify(settings));
    },
  });
  const document = dom.window.document;
  const status = () => document.querySelector('#save-status').textContent;
  await until(() => !status().includes('Loading'));
  assert.deepEqual(errors, []);
  if (edit) {
    document.querySelector('[data-tab="set"]').click();
    document.querySelector('[data-mode="edit"]').click();
    document.querySelector('[data-tab="plan"]').click();
  }
  return {
    dom, document, status,
    input(selector, value) {
      const element = document.querySelector(selector); element.value = value;
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    },
    click(selector) { document.querySelector(selector).click(); },
    submit(selector) { document.querySelector(selector).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); },
    cache() { return JSON.parse(dom.window.localStorage.getItem('tripplanner:v1')); },
    close() { dom.window.close(); },
  };
}

test('adding an event saves it for a fresh visitor and survives a reload', async () => {
  const site = fakeWebsite(); const first = await browser(site, { edit: true });
  first.input('#f-t', 'Visit the museum'); first.input('#f-l', 'City museum'); first.submit('#addf');
  await until(() => first.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.events.length, 4);
  assert.equal(first.cache().dirty, false);
  const second = await browser(site);
  assert.match(second.document.querySelector('#view').textContent, /Visit the museum/);
  const reloaded = await browser(site, { cached: first.cache() });
  assert.match(reloaded.document.querySelector('#view').textContent, /Visit the museum/);
  first.close(); second.close(); reloaded.close();
});

test('event edits, deletions, title and event details save through the website', async () => {
  const site = fakeWebsite({ trip: exampleTrip(), rev: 1 }); const page = await browser(site, { edit: true });
  page.click('[data-act="menu"]'); page.click('[data-act="edit"]');
  page.input('#e-t', 'Arrive at hotel'); page.submit('#editf');
  await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.events[0].title, 'Arrive at hotel');
  page.input('#title', 'China family trip');
  assert.ok(page.document.querySelector('[data-act="publish"]'));
  page.click('[data-act="publish"]'); await until(() => page.status().includes('Saved to the website'));
  page.click('[data-act="open"]'); page.input('#d-text', 'Booking reference: FAMILY');
  page.click('[data-act="publish"]'); await until(() => page.status().includes('Saved to the website'));
  page.input('#d-text', 'Updated details after saving'); page.click('[data-act="publish"]');
  await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.title, 'China family trip');
  assert.equal(site.saved.trip.events[0].text, 'Updated details after saving');
  page.click('[data-act="back"]'); page.click('[data-act="menu"]'); page.click('[data-act="del"]');
  page.click('[data-act="publish"]'); await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.events.length, 0); page.close();
});

test('a failed save keeps the draft and retries successfully', async () => {
  const site = fakeWebsite(); let fail = true;
  const page = await browser(site, { edit: true, intercept: async (request, handler) => {
    if (request.method === 'PUT' && fail) throw new TypeError('Network unavailable');
    return handler(request);
  } });
  page.input('#f-t', 'Dinner'); page.submit('#addf');
  await until(() => page.status().includes('Couldn’t save'));
  assert.equal(page.cache().dirty, true); assert.equal(site.saved.rev, 0);
  fail = false; page.click('[data-act="publish"]');
  await until(() => page.status().includes('Saved to the website'));
  assert.ok(site.saved.trip.events.some((event) => event.title === 'Dinner')); page.close();
});

test('concurrent visitors keep a conflicting draft and can load the saved version', async () => {
  const site = fakeWebsite({ trip: exampleTrip(), rev: 1 });
  const first = await browser(site, { edit: true }); const second = await browser(site, { edit: true });
  first.input('#f-t', 'Museum'); first.submit('#addf');
  await until(() => first.status().includes('Saved to the website'));
  second.input('#f-t', 'Dinner'); second.submit('#addf');
  await until(() => second.status().includes('newer changes'));
  assert.ok(second.cache().events.some((event) => event.title === 'Dinner'));
  assert.ok(!site.saved.trip.events.some((event) => event.title === 'Dinner'));
  const reload = await browser(site, { cached: second.cache() });
  assert.match(reload.status(), /newer changes/);
  assert.ok(reload.cache().events.some((event) => event.title === 'Dinner'));
  second.click('[data-act="loadsite"]'); await until(() => !second.status().includes('Loading'));
  assert.match(second.document.querySelector('#view').textContent, /Museum/);
  assert.equal(second.cache().dirty, false);
  first.close(); second.close(); reload.close();
});

test('changes made while a save is in flight stay dirty and later event saves queue', async () => {
  const site = fakeWebsite(); let release;
  const page = await browser(site, { edit: true, intercept: async (request, handler) => {
    if (request.method === 'PUT') await new Promise((resolve) => { release = resolve; });
    return handler(request);
  } });
  page.input('#f-t', 'Museum'); page.submit('#addf');
  await until(() => release);
  page.input('#title', 'New title while saving');
  page.input('#f-t', 'Unsubmitted next event');
  release(); await until(() => page.status().includes('newer changes to save'));
  assert.equal(page.cache().dirty, true);
  assert.equal(page.document.querySelector('#f-t').value, 'Unsubmitted next event');
  page.submit('#addf'); await tick();
  page.input('#f-t', 'One more event'); page.submit('#addf');
  const firstRelease = release; release = null; firstRelease();
  await until(() => release); release();
  await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.events.length, 6);
  assert.equal(site.saved.trip.title, 'New title while saving');
  assert.equal(page.cache().dirty, false); page.close();
});

test('failed initial loading prevents overwrites and reconnecting preserves local changes', async () => {
  const site = fakeWebsite({ trip: exampleTrip(), rev: 4 }); let fail = true;
  const page = await browser(site, { edit: true, intercept: async (request, handler) => {
    if (fail) throw new TypeError('Offline'); return handler(request);
  } });
  assert.match(page.status(), /Couldn’t load/);
  page.input('#f-t', 'Offline addition'); page.submit('#addf');
  assert.equal(site.saved.rev, 4); assert.equal(page.cache().dirty, true);
  fail = false; page.click('[data-act="retry"]'); await until(() => !page.status().includes('Loading'));
  assert.match(page.status(), /newer changes/);
  assert.ok(page.cache().events.some((event) => event.title === 'Offline addition')); page.close();
});

test('view mode is the default and preserves readable details and personal settings', async () => {
  const trip = exampleTrip();
  trip.events[0].text = 'Booking reference: FAMILY\nCheck in at reception';
  trip.events[0].pics = ['/api/images/' + 'a'.repeat(64) + '.jpg'];
  trip.events[0].titleZh = '到酒店';
  const site = fakeWebsite({ trip, rev: 1 });
  const page = await browser(site, { settings: { theme: 'dark', defLang: 'en' } });
  assert.equal(page.document.querySelector('#title').readOnly, true);
  assert.equal(page.document.querySelector('#addf'), null);
  assert.equal(page.document.querySelector('[data-act="menu"]'), null);
  page.input('#title', 'Accidental change');
  assert.equal(page.cache().title, 'Family trip');
  assert.equal(page.cache().dirty, false);
  page.click('[data-act="lang"]');
  assert.match(page.document.querySelector('#view').textContent, /到酒店/);
  page.click('[data-act="open"]');
  assert.equal(page.document.querySelector('.details-text').textContent, trip.events[0].text);
  assert.equal(page.document.querySelector('.gal img').getAttribute('src'), trip.events[0].pics[0]);
  assert.equal(page.document.querySelector('#d-text'), null);
  assert.equal(page.document.querySelector('#d-pics'), null);
  assert.equal(page.document.querySelector('[data-act="delpic"]'), null);
  page.click('[data-tab="time"]');
  assert.match(page.document.querySelector('#view').textContent, /到酒店/);
  page.click('[data-tab="set"]');
  assert.equal(page.document.querySelector('[data-mode="view"]').getAttribute('aria-pressed'), 'true');
  assert.equal(page.document.querySelector('[data-mode="edit"]').getAttribute('aria-pressed'), 'false');
  assert.equal(page.document.querySelector('[data-startdate]'), null);
  assert.equal(page.dom.window.document.documentElement.dataset.theme, 'dark');
  page.click('[data-set="theme"][data-v="light"]');
  assert.equal(page.dom.window.document.documentElement.dataset.theme, 'light');
  assert.equal(page.cache().dirty, false);
  assert.equal(site.saved.rev, 1);
  page.close();
});

test('view mode allows map browsing and selection without moving or creating pins', async () => {
  const trip = exampleTrip();
  trip.maps.push({ id: 2, name: 'City centre' });
  trip.events[0].pin = { x: 25, y: 40 }; trip.events[0].map = 1;
  trip.events.push({ id: 2, title: 'Museum', day: 2, pin: null });
  const site = fakeWebsite({ trip, rev: 1 }); const page = await browser(site);
  page.click('[data-act="map"][data-id="1"]');
  assert.ok(page.document.querySelector('.pin.sel'));
  for (const selector of ['#mapname', '#mapfile', '#clrimg', '#place', '#rmpin', '#custom', '[data-lab]', '[data-act="addmap"]', '[data-act="delmap"]']) {
    assert.equal(page.document.querySelector(selector), null, selector);
  }
  const pin = page.document.querySelector('.pin');
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) pin.dispatchEvent(new page.dom.window.MouseEvent(type, { bubbles: true, clientX: 80, clientY: 90 }));
  page.click('.pin');
  assert.equal(page.document.querySelector('.side [data-sel="1"]').getAttribute('aria-current'), 'true');
  page.click('[data-map="2"]');
  assert.match(page.document.querySelector('#view').textContent, /City centre/);
  page.click('[data-tab="plan"]'); page.click('[data-act="map"][data-id="2"]');
  assert.equal(page.document.querySelector('#mapbox').classList.contains('placing'), false);
  page.click('#mapbox');
  assert.match(page.document.querySelector('#view').textContent, /No pin has been added/);
  assert.deepEqual(page.cache().events[0].pin, { x: 25, y: 40 });
  assert.equal(page.cache().events[1].pin, null);
  assert.equal(page.cache().dirty, false);
  assert.equal(site.saved.rev, 1);
  page.close();
});

test('switching modes preserves drafts and edit mode remains available for saving', async () => {
  const site = fakeWebsite({ trip: exampleTrip(), rev: 1 }); const page = await browser(site);
  page.click('[data-tab="set"]'); page.click('[data-mode="edit"]');
  assert.equal(page.document.querySelector('[data-mode="edit"]').getAttribute('aria-pressed'), 'true');
  const start = page.document.querySelector('[data-startdate]');
  start.value = '2026-12-06'; start.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  page.click('[data-tab="plan"]');
  assert.ok(page.document.querySelector('#addf'));
  assert.equal(page.document.querySelector('#title').readOnly, false);
  page.input('#title', 'Updated family trip');
  page.click('[data-act="menu"]'); page.click('[data-act="edit"]');
  assert.ok(page.document.querySelector('#editf'));
  page.click('[data-tab="set"]'); page.click('[data-mode="view"]');
  assert.equal(page.document.querySelector('[data-act="publish"]'), null);
  assert.match(page.status(), /unsaved trip changes/);
  assert.equal(page.cache().dirty, true);
  page.click('[data-tab="plan"]');
  assert.equal(page.document.querySelector('#editf'), null);
  assert.equal(page.document.querySelector('#addf'), null);
  assert.equal(page.document.querySelector('#title').value, 'Updated family trip');
  const reloaded = await browser(site, { cached: page.cache() });
  assert.equal(reloaded.document.querySelector('#title').readOnly, true);
  assert.equal(reloaded.cache().dirty, true);
  assert.match(reloaded.status(), /unsaved trip changes/);
  reloaded.close();
  page.click('[data-tab="set"]'); page.click('[data-mode="edit"]');
  page.click('[data-act="publish"]'); await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.title, 'Updated family trip');
  assert.equal(site.saved.trip.start, '2026-12-06');
  assert.equal(page.cache().dirty, false);
  const fresh = await browser(site);
  assert.equal(fresh.document.querySelector('#addf'), null);
  assert.equal(fresh.document.querySelector('#title').value, 'Updated family trip');
  page.close(); fresh.close();
});

test('resetting settings returns to view mode and cancels pin placement', async () => {
  const site = fakeWebsite({ trip: exampleTrip(), rev: 1 }); const page = await browser(site, { edit: true });
  page.click('[data-act="map"]');
  assert.ok(page.document.querySelector('#mapbox.placing'));
  page.click('[data-tab="set"]'); page.click('[data-set="reset"]');
  assert.equal(page.document.querySelector('[data-mode="view"]').getAttribute('aria-pressed'), 'true');
  page.click('[data-tab="map"]');
  assert.equal(page.document.querySelector('#mapbox.placing'), null);
  assert.equal(page.document.querySelector('#place'), null);
  assert.equal(page.cache().dirty, false);
  assert.equal(site.saved.rev, 1);
  page.close();
});

test('event language switches notes and details together without changing the saved trip', async () => {
  const trip = exampleTrip();
  Object.assign(trip.events[0], {
    notes: 'Bring passports', notesZh: '带上护照',
    text: 'Booking: FAMILY\nCheck in at reception', textZh: '预订：FAMILY\n请在前台办理入住',
  });
  const site = fakeWebsite({ trip, rev: 1 }); const page = await browser(site);
  assert.match(page.document.querySelector('.ev p').textContent, /Bring passports/);
  page.click('[data-act="lang"]');
  assert.match(page.document.querySelector('.ev p').textContent, /带上护照/);
  assert.doesNotMatch(page.document.querySelector('.ev p').textContent, /Bring passports/);
  page.click('[data-act="open"]');
  assert.equal(page.document.querySelector('.event-notes').textContent, trip.events[0].notesZh);
  assert.equal(page.document.querySelector('h3 + .details-text').textContent, trip.events[0].textZh);
  page.click('[data-act="lang"]');
  assert.equal(page.document.querySelector('.event-notes').textContent, trip.events[0].notes);
  assert.equal(page.document.querySelector('h3 + .details-text').textContent, trip.events[0].text);
  page.click('[data-tab="time"]');
  assert.equal(page.document.querySelector('.event-notes').textContent, trip.events[0].notes);
  page.click('[data-act="lang"]');
  assert.equal(page.document.querySelector('.event-notes').textContent, trip.events[0].notesZh);
  assert.equal(page.cache().dirty, false);
  assert.equal(site.saved.rev, 1);
  page.close();
});

test('Chinese-only notes display and missing Chinese details fall back to English', async () => {
  const trip = exampleTrip();
  Object.assign(trip.events[0], { notes: '', notesZh: '带上护照', text: 'Keep your booking reference' });
  const site = fakeWebsite({ trip, rev: 1 });
  const page = await browser(site, { settings: { defLang: 'zh' } });
  assert.match(page.document.querySelector('.ev p').textContent, /带上护照/);
  page.click('[data-act="open"]');
  assert.equal(page.document.querySelector('h3 + .details-text').textContent, trip.events[0].text);
  page.click('[data-act="lang"]');
  assert.equal(page.document.querySelector('.event-notes'), null);
  assert.equal(page.document.querySelector('h3 + .details-text').textContent, trip.events[0].text);
  page.close();
});

test('the details editor replaces English with Chinese and saves each version independently', async () => {
  const site = fakeWebsite({ trip: exampleTrip(), rev: 1 }); const page = await browser(site, { edit: true });
  page.click('[data-act="open"]');
  const english = 'Booking <FAMILY>\nArrive before 3pm';
  const chinese = '预订 <FAMILY>\n下午三点前到达';
  page.input('#d-text', english);
  page.click('[data-act="lang"]');
  assert.equal(page.document.querySelectorAll('textarea').length, 1);
  assert.equal(page.document.querySelector('#d-text').getAttribute('lang'), 'zh');
  assert.equal(page.document.querySelector('#d-text').value, '');
  page.input('#d-text', chinese);
  page.click('[data-act="lang"]');
  assert.equal(page.document.querySelector('#d-text').getAttribute('lang'), 'en');
  assert.equal(page.document.querySelector('#d-text').value, english);
  page.click('[data-act="lang"]');
  assert.equal(page.document.querySelector('#d-text').value, chinese);
  assert.doesNotMatch(page.document.querySelector('#d-text').value, /Arrive before/);
  page.click('[data-act="publish"]'); await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.events[0].text, english);
  assert.equal(site.saved.trip.events[0].textZh, chinese);
  const fresh = await browser(site, { settings: { defLang: 'zh' } });
  fresh.click('[data-act="open"]');
  assert.equal(fresh.document.querySelector('h3 + .details-text').textContent, chinese);
  assert.equal(fresh.document.querySelector('h3 + .details-text').children.length, 0);
  fresh.click('[data-act="lang"]');
  assert.equal(fresh.document.querySelector('h3 + .details-text').textContent, english);
  page.input('#d-text', ''); page.click('[data-act="publish"]');
  await until(() => page.status().includes('Saved to the website'));
  assert.equal(site.saved.trip.events[0].text, english);
  assert.equal(site.saved.trip.events[0].textZh, '');
  page.close(); fresh.close();
});
