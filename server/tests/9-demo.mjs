/**
 * SessionHistoryServer functional tests — 9. the bundled demo page
 *
 * The single-file demo at "/demo2.html" is both a showcase and executable
 * protocol documentation. These tests drive it like a user would: pass the
 * authorization box (the master password mints the entityKey), create a
 * session, watch events flow between two browser windows, hold-to-record a
 * tentative event, click events in the feed and on the timeline to inspect
 * their details, ingest the fake camera, add a script processor from
 * the playground, and run the replay.
 *
 * Copyright (c) 2026 Janus Kristensen - CAVI, Center for Advanced
 * Visualization and Interaction - Aarhus University
 * SPDX-License-Identifier: MIT
 */

import assert from 'node:assert/strict';
import { BASE_URL, getBrowser, getMasterPassword, record, sleep } from './helpers.mjs';

async function openDemo(path = '/demo2.html') {
  const browser = await getBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(25000);
  if (process.env.SHS_DEMO_DEBUG) {
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e.message).slice(0, 200)));
    page.on('console', (m) => console.log('   [page]', m.type(), String(m.text()).slice(0, 160)));
  }
  await page.goto(BASE_URL + path, { waitUntil: 'domcontentloaded' });
  return page;
}

/** Wait until the demo feed contains a row matching `substring`. */
function feedHas(page, substring, timeoutMs = 25000) {
  return page.waitForFunction(
    (s) => [...document.querySelectorAll('[data-testid="feed"] .row')]
      .some((r) => r.textContent.includes(s)),
    { timeout: timeoutMs, polling: 250 }, substring);
}

const openPages = new Set(); // closed defensively in after() — a leaked page
// starves rAF in the others (only the active tab gets frames)

/**
 * Join the demo (optionally an existing session) and verify the ingest
 * path with a probe event. The negotiation race
 * leaves some joins without a working data channel — the demo surfaces
 * that as a toast after 25s, we just retry and count it.
 * The demo gates everything behind the authorization box: the master
 * password is typed there, exactly as a user would, and the session
 * options (or the pending ?session= join) only unlock once "Get Access"
 * succeeds (each window joins under its own random entity, so every join
 * logs in anew).
 */
async function joinDemo({ sessionId } = {}, attempts = 3) {
  const masterPassword = getMasterPassword();
  for (let attempt = 1; ; attempt++) {
    const page = await openDemo(sessionId ? `/demo2.html?session=${sessionId}` : '/demo2.html');
    openPages.add(page);
    try {
      if (masterPassword) {
        await page.type('[data-testid="master-password"]', masterPassword);
        await page.click('[data-testid="get-access"]');
      }
      await page.waitForSelector('[data-testid="session-card"]:not(.hidden)');
      if (!sessionId) await page.click('[data-testid="create-session"]');
      await page.waitForSelector('[data-testid="app"]:not(.hidden)');
      await page.click('[data-testid="send-event"]'); // probe event
      await feedHas(page, 'application.demo.note', 8000);
      return page;
    } catch (err) {
      record('demo joins defeated by the ingest negotiation race', 1, 'joins');
      await page.close().catch(() => {});
      openPages.delete(page);
      if (attempt === attempts) throw err;
    }
  }
}

describe('the bundled demo page (single file, zero dependencies)', function () {
  this.timeout(90000);

  let owner;   // the window that created the session
  let sessionId;

  before(async function () {
    if (!getMasterPassword()) {
      return this.skip('no master password — set auth.masterPassword in the repo root config.json (see tests/README.md) or export SHS_MASTER_PASSWORD');
    }
    owner = await joinDemo();
    sessionId = await owner.evaluate(() => new URLSearchParams(location.search).get('session'));
  });

  after(async () => {
    await owner.evaluate(() => { try { window.__sh?.session.websocket.close(); } catch { /* gone */ } }).catch(() => {});
    for (const page of openPages) await page.close().catch(() => {});
    await owner.close().catch(() => {});
  });

  it('creates a session and shows it in the session bar', async () => {
    assert.ok(sessionId, 'the session id must land in the URL');
    assert.match(await owner.$eval('[data-testid="session-bar"]', (el) => el.textContent), /session/);
    assert.equal((await owner.$eval('#entity-name-header', (el) => el.textContent)).length > 0, true,
      'the entity name must be shown');
  });

  it('gates the session options behind the authorization box', async () => {
    const page = await openDemo(); // a fresh tab: its own random entity, no key
    try {
      // pin this tab's identity to a name outside the random pool: a random
      // roll can collide with the one entity the browser remembers a key
      // for, which would boot this tab straight past the gate
      const unique = 'gate-probe-' + Date.now();
      await page.evaluate((name) => sessionStorage.setItem('shsDemoEntity', name), unique);
      await page.reload({ waitUntil: 'domcontentloaded' });

      // before access: only the authorization box, no session options, no app
      await page.waitForSelector('[data-testid="access-card"]:not(.hidden)');
      assert.ok(await page.$eval('#session-card', (el) => el.classList.contains('hidden')),
        'the session options must stay hidden before access');
      assert.ok(await page.$eval('#app', (el) => el.classList.contains('hidden')),
        'the app must stay hidden before access');
      assert.ok(await page.$eval('#landing-hero', (el) => el.classList.contains('hidden')),
        'the landing hero must stay hidden before access — the visitor sees the box and nothing else');

      // a wrong password keeps the box up and surfaces the error
      await page.type('[data-testid="master-password"]', 'definitely-not-the-master-password');
      await page.click('[data-testid="get-access"]');
      await page.waitForFunction(() =>
        document.getElementById('access-error').textContent.length > 0, { timeout: 15000, polling: 250 });
      assert.ok(await page.$eval('#session-card', (el) => el.classList.contains('hidden')),
        'a failed login must not unlock the session options');

      // the right password unlocks the session options (but not the app —
      // that still needs a session)
      await page.$eval('[data-testid="master-password"]', (el) => { el.value = ''; });
      await page.type('[data-testid="master-password"]', getMasterPassword());
      await page.click('[data-testid="get-access"]');
      await page.waitForSelector('[data-testid="session-card"]:not(.hidden)');
      assert.ok(await page.$eval('#access-card', (el) => el.classList.contains('hidden')),
        'the authorization box is done once access is granted');
      assert.ok(await page.$eval('#landing-hero', (el) => !el.classList.contains('hidden')),
        'the hero appears together with the session options');
      assert.ok(await page.$eval('#app', (el) => el.classList.contains('hidden')),
        'the app still waits for a session to be joined');
    } finally {
      await page.close().catch(() => {});
    }
  });

  it('jumps into a ?session= url only once authorized', async () => {
    const page = await openDemo(`/demo2.html?session=${sessionId}`);
    try {
      // pin the identity (as in the gate test), then gate first, jump later
      const unique = 'gate-probe-' + Date.now();
      await page.evaluate((name) => sessionStorage.setItem('shsDemoEntity', name), unique);
      await page.reload({ waitUntil: 'domcontentloaded' });

      // unauthorized: the session id in the URL must NOT open the session
      await page.waitForSelector('[data-testid="access-card"]:not(.hidden)');
      assert.ok(await page.$eval('#app', (el) => el.classList.contains('hidden')),
        'a session in the URL must not open the app before authorization');

      // authorized: the pending join fires and lands in the URL session
      await page.type('[data-testid="master-password"]', getMasterPassword());
      await page.click('[data-testid="get-access"]');
      await page.waitForSelector('[data-testid="app"]:not(.hidden)', { timeout: 30000 });
      assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('session')), sessionId,
        'the guest must end up in the session the URL pointed at');
    } finally {
      await page.evaluate(() => { try { window.__sh?.session.websocket.close(); } catch { /* gone */ } }).catch(() => {});
      await page.close().catch(() => {});
    }
  });

  it('shows sent events in the live feed', async () => {
    await owner.click('[data-testid="send-event"]');
    await feedHas(owner, 'application.demo.note');
    const entity = await owner.$eval('#entity-name-header', (el) => el.textContent);
    await feedHas(owner, entity); // events are attributed to their entity
  });

  it('shows event details when a feed row is clicked', async () => {
    const row = await owner.$('[data-testid="feed"] .row'); // the newest row
    const rowId = await row.evaluate((el) => el.dataset.eventId);
    await row.click(); // elementHandle.click scrolls the row into view
    await owner.waitForSelector('[data-testid="event-details"]:not(.hidden)');
    // value assertions, not label matches: every field must carry the event
    assert.equal(await owner.$eval('#detail-id', (el) => el.textContent), rowId);
    const ownerEntity = await owner.$eval('#entity-name-header', (el) => el.textContent);
    assert.equal(await owner.$eval('#detail-entity', (el) => el.textContent), ownerEntity,
      'the details must show the event entity');
    assert.match(await owner.$eval('#detail-type', (el) => el.textContent), /application\.demo\.note/,
      'the details must show the event type');
    assert.match(await owner.$eval('#detail-data', (el) => el.textContent), /hello world/,
      'the details must show the event data (the probe note)');
    assert.match(await owner.$eval('#detail-start', (el) => el.textContent), /\d{2}:\d{2}:\d{2}/,
      'the start must render (clock time · ISO date)');
    assert.equal(await owner.$eval('#detail-end', (el) => el.textContent), '—',
      'an instant event has no end (—)');
    assert.ok((await owner.$eval('#detail-duration', (el) => el.textContent)).length > 0,
      'the duration must render');
    // the @Meta block needs its async server round-trip
    await owner.waitForSelector('#detail-meta:not(.hidden)', { timeout: 15000 });
    assert.match(await owner.$eval('#detail-meta-json', (el) => el.textContent), /created/,
      'the meta block must show the server creation time');
    await owner.waitForFunction((id) =>
      document.querySelector(`#feed [data-event-id="${CSS.escape(id)}"]`)?.classList.contains('selected'),
      { timeout: 15000, polling: 250 }, rowId);
    // the ✕ clears the selection again
    await owner.click('#detail-close');
    await owner.waitForSelector('[data-testid="event-details"].hidden', { timeout: 15000 });
  });

  it('selects a clicked event on the timeline and clears on empty space', async () => {
    await owner.bringToFront(); // the timeline redraws only while the tab has frames
    // raw mouse clicks do not scroll for you — bring the canvas into view first
    await owner.$eval('#timeline', (el) => el.scrollIntoView({ block: 'center' }));
    // pick a hit target from the page's own hit geometry (rebuilt per frame);
    // events can start before the visible window, so only accept a target
    // safely on the canvas — the first entry may be up to half a lane off
    const target = await owner.evaluate(() => {
      const w = document.getElementById('timeline').clientWidth;
      for (const [id, r] of (window.__sh?.timelineHitRects ?? new Map())) {
        const cx = r.kind === 'rect' ? r.x + r.w / 2 : r.cx;
        const cy = r.kind === 'rect' ? r.y + r.h / 2 : r.cy;
        if (cx >= 10 && cx <= w - 10) return { id, cx, cy };
      }
      return null;
    });
    assert.ok(target, 'the timeline must have at least one event drawn');
    const box = await owner.$eval('#timeline', (el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    await owner.mouse.click(box.x + target.cx, box.y + target.cy);
    await owner.waitForSelector('[data-testid="event-details"]:not(.hidden)');
    assert.equal(await owner.$eval('#detail-id', (el) => el.textContent), target.id,
      'the timeline click must select exactly the clicked event');
    // clicking empty space (the time-label strip below the lanes) clears it
    await owner.mouse.click(box.x + box.w / 2, box.y + box.h - 5);
    await owner.waitForSelector('[data-testid="event-details"].hidden', { timeout: 15000 });
  });

  it('records a hold-to-press duration event and closes it', async () => {
    // center the button first: the previous test leaves the page scrolled,
    // and a button flush under the sticky header eats puppeteer's click
    // (the header overlays it at the same coordinates)
    await owner.$eval('#hold-button', (el) => el.scrollIntoView({ block: 'center' }));
    await owner.click('[data-testid="hold-button"]', { delay: 1200 });
    await feedHas(owner, 'level'); // the sine-wave updates become the event data
    await owner.waitForFunction(() => [...document.querySelectorAll('[data-testid="feed"] .row')]
      .some((r) => r.textContent.includes('level') && !r.classList.contains('tentative')),
      { timeout: 20000 });
    // a closed duration event must show its end time (an instant event shows —)
    const rowId = await owner.evaluate(() => {
      const row = [...document.querySelectorAll('[data-testid="feed"] .row:not(.tentative)')]
        .find((r) => r.textContent.includes('level'));
      return row?.dataset.eventId ?? null;
    });
    assert.ok(rowId, 'the hold event must be in the feed');
    const row = await owner.$(`#feed [data-event-id="${rowId}"]`);
    await row.click();
    await owner.waitForSelector('[data-testid="event-details"]:not(.hidden)');
    assert.notEqual(await owner.$eval('#detail-end', (el) => el.textContent), '—',
      'a closed duration event must show its end time');
    assert.match(await owner.$eval('#detail-duration', (el) => el.textContent), /s$/,
      'a closed duration event must show its length in seconds');
    await owner.click('#detail-close');
  });

  it('syncs events between two windows joined to the same session', async function () {
    this.timeout(240000); // join retries against the negotiation race can be slow
    this.retries(2); // every guest join rolls the race dice — see the measurement
    const guest = await joinDemo({ sessionId });
    try {
      const guestEntity = await guest.$eval('#entity-name-header', (el) => el.textContent);
      assert.notEqual(guestEntity, await owner.$eval('#entity-name-header', (el) => el.textContent),
        'the second window must join under its own entity name');
      await feedHas(owner, guestEntity, 60000); // the owner sees the guest's entity in its feed

      // puppeteer's click needs the tab in front: isIntersectingViewport
      // (IntersectionObserver) never fires in a hidden/backgrounded page
      await owner.bringToFront();
      await owner.click('[data-testid="send-event"]');
      const ownerEntity = await owner.$eval('#entity-name-header', (el) => el.textContent);
      await feedHas(guest, ownerEntity, 60000); // and the guest sees the owner's
    } finally {
      await guest.evaluate(() => { try { window.__sh?.session.websocket.close(); } catch { /* gone */ } }).catch(() => {});
      await guest.close().catch(() => {});
      openPages.delete(guest);
      await owner.bringToFront().catch(() => {});
    }
  });

  it('lists the default processors with remove buttons', async () => {
    await owner.waitForFunction(() =>
      document.querySelectorAll('[data-testid="processor-row"]').length >= 3, { timeout: 20000 });
    const names = await owner.$$eval('[data-testid="processor-name"]', (els) => els.map((e) => e.textContent));
    for (const expected of ['application0', 'voicedetect0', 'transcription0']) {
      assert.ok(names.includes(expected), `expected ${expected} in [${names}]`);
    }
  });

  it('records the fake camera and discovers its Matroska tracks', async () => {
    await owner.click('[data-testid="media-camera"]');
    await owner.waitForFunction(() =>
      [...document.querySelectorAll('#recordings .rec-row')]
        .some((r) => r.textContent.includes('user.demo.cam.video')), { timeout: 30000 });
    const rows = await owner.$$eval('#recordings .rec-row', (els) => els.map((e) => e.textContent));
    assert.ok(rows.some((r) => r.includes('user.demo.cam.audio')),
      `expected the microphone track too, got: ${rows.join(' | ')}`);
    assert.ok(rows.every((r) => r.includes('.mkv')), 'recordings must be served as Matroska');
  });

  it('derives events through the script processor playground', async () => {
    await owner.click('[data-testid="add-processor"]');
    await owner.click('[data-testid="send-event"]'); // default: { "note": "hello world" }
    await feedHas(owner, 'application.demo.exclaim');
    await feedHas(owner, 'HELLO WORLD'); // the default script uppercases the note
  });

  it('narrows the feed with the type filter', async () => {
    await owner.type('#feed-filter', 'zzz-nothing-matches');
    await owner.waitForFunction(() =>
      document.querySelector('[data-testid="feed"]').textContent.includes('no events'),
      { timeout: 15000, polling: 250 });
    await owner.$eval('#feed-filter', (el) => { el.value = ''; el.dispatchEvent(new Event('input')); });
    await owner.waitForFunction(() =>
      document.querySelectorAll('[data-testid="feed"] .row').length > 0, { timeout: 15000 });
  });

  it('replays the timeline with a playhead and a progress bar', async () => {
    await owner.click('[data-testid="replay-button"]');
    await owner.waitForFunction(() =>
      /at \d×/.test(document.getElementById('replay-status').textContent)
      && document.getElementById('replay-progress').firstElementChild.style.width !== '0%',
      { timeout: 20000, polling: 250 });
    const progress = await owner.$eval('#replay-progress .fill', (el) => el.style.width);
    assert.notEqual(progress, '0%', 'the progress bar must advance during replay');
    await owner.click('[data-testid="replay-button"]'); // stop again
    await owner.waitForFunction(() => document.getElementById('replay-button').textContent.includes('Replay'),
      { timeout: 15000, polling: 250 });
  });
});
