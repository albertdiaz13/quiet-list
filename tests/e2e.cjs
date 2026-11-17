// Browser tests for the primary flows. Needs Playwright with Chromium available to `require`.
// Touch is driven through real touch events (Chrome DevTools Protocol), not synthetic clicks.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const root = path.join(__dirname, '..');
const SETUP = 'e2e-setup-code-not-a-real-secret';
// The single-file preview, wrapped the way a host page would wrap it (no server behind it).
const previewServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>'
    + fs.readFileSync(path.join(root, 'preview/quiet-list.html'), 'utf8') + '</body></html>');
});
let previewBase;

const results = [];
let base;
const openTexts = page => page.$$eval('#open .row .t, #open .row .edit-text', nodes => nodes.map(n => n.value ?? n.textContent));
const center = async (page, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
};
// Moves one finger through the given points.
async function finger(page, points, { hold = 0, steps = 10 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y }] : [] });
  await send('touchStart', points[0]);
  if (hold) await page.waitForTimeout(hold);
  for (let i = 1; i < points.length; i++) {
    for (let s = 1; s <= steps; s++) {
      await send('touchMove', { x: points[i - 1].x + (points[i].x - points[i - 1].x) * s / steps, y: points[i - 1].y + (points[i].y - points[i - 1].y) * s / steps });
      await page.waitForTimeout(12);
    }
  }
  await page.waitForTimeout(40);
  await send('touchEnd');
  await cdp.detach();
  await page.waitForTimeout(700);
}

async function run(name, contextOptions, body, url = '/') {
  const browser = await chromium.launch();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const problems = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  try {
    await page.goto(url === '/preview' ? previewBase : base + url);
    await page.waitForSelector('#open .row');
    await page.waitForTimeout(450);
    await body(page);
    assert.deepEqual(problems, [], 'console errors or CSP violations');
    results.push(['ok', name]);
  } catch (error) {
    results.push(['FAIL', name, error.message.split('\n').slice(0, 6).join('\n   ')]);
    await page.screenshot({ path: path.join(root, 'tests', `fail-${name.replace(/\W+/g, '-')}.png` ) }).catch(() => {});
  }
  await browser.close();
}

const layoutChecks = async page => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, 'no sideways scroll');
  const small = await page.$$eval('#list button, #list input', nodes => nodes.filter(n => n.offsetParent && !n.closest('[inert]'))
    .map(n => { const target = n.closest('label') || n; const r = target.getBoundingClientRect(); return { id: n.id || n.className, w: r.width, h: r.height }; })
    .filter(r => (r.w < 44 || r.h < 44) && !/^$/.test(r.id) && r.id !== 'add-btn' && !/pager/.test(r.id)));
  const realSmall = small.filter(r => r.w < 28 || r.h < 28);
  assert.deepEqual(realSmall, [], 'touch targets');
  const unnamed = await page.$$eval('button, input, textarea', nodes => nodes.filter(n => n.type !== 'file' && !n.hidden
    && !(n.getAttribute('aria-label') || n.textContent.trim() || (n.id && document.querySelector(`label[for="${n.id}"]`)))).map(n => n.outerHTML.slice(0, 80)));
  assert.deepEqual(unnamed, [], 'every control has an accessible name');
};

const touchFlows = async page => {
  await layoutChecks(page);
  const start = await openTexts(page);
  assert.equal(start.length, 5);

  // add with the + button
  await page.tap('#fab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought');
  await page.keyboard.type('Buy stamps');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert.equal((await openTexts(page))[0], 'Buy stamps');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought', 'stays ready for the next thought');
  await page.locator('#title').tap();

  // pull down to add
  await page.evaluate(() => document.activeElement.blur());
  const top = await center(page, '#open .row:nth-child(2) .text');
  await finger(page, [top, { x: top.x, y: top.y + 190 }]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought', 'pull focuses the capture field');
  await page.evaluate(() => document.activeElement.blur());
  // a short pull does nothing
  await finger(page, [top, { x: top.x, y: top.y + 50 }]);
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'thought');

  // swipe right completes
  let row = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [row, { x: row.x + 170, y: row.y + 4 }]);
  assert.deepEqual(await openTexts(page), start);
  assert.match(await page.textContent('#count'), /5 open · 2 done/);
  // a short swipe springs back
  row = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [row, { x: row.x + 40, y: row.y }]);
  assert.deepEqual(await openTexts(page), start);

  // swipe left deletes, Undo restores
  await finger(page, [row, { x: row.x - 170, y: row.y }]);
  assert.deepEqual(await openTexts(page), start.slice(1));
  assert.equal(await page.isVisible('#toast'), true);
  await page.tap('#toast-undo');
  await page.waitForTimeout(400);
  assert.deepEqual(await openTexts(page), start);

  // vertical scroll gesture must not swipe or edit anything
  await finger(page, [row, { x: row.x + 6, y: row.y - 120 }]);
  assert.deepEqual(await openTexts(page), start);
  assert.equal(await page.locator('.card.editing').count(), 0);
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });

  // drag by the grip: first item to third place
  const grip = await center(page, '#open .row:nth-child(1) .handle');
  const third = await center(page, '#open .row:nth-child(3) .handle');
  await finger(page, [grip, { x: grip.x, y: third.y + 12 }]);
  assert.deepEqual(await openTexts(page), [start[1], start[2], start[0], start[3], start[4]]);

  // press and hold, then drag: last item to the top
  const last = await center(page, '#open .row:nth-child(5) .text');
  const first = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [last, { x: last.x, y: first.y - 14 }], { hold: 560 });
  assert.deepEqual(await openTexts(page), [start[4], start[1], start[2], start[0], start[3]]);
  assert.equal(await page.locator('.card.editing').count(), 0, 'drag does not open the editor');

  // tap to edit in place
  await page.tap('#open .row:nth-child(1) button.text');
  await page.keyboard.type(' today');
  await page.tap('.tool-save');
  assert.equal((await openTexts(page))[0], start[4] + ' today');

  // swipe the title bar to change list, and back
  const bar = await center(page, '#title');
  await finger(page, [bar, { x: bar.x - 150, y: bar.y }]);
  assert.equal(await page.textContent('#title'), 'Weekend');
  await finger(page, [bar, { x: bar.x + 150, y: bar.y }]);
  assert.equal(await page.textContent('#title'), 'Brain dump');

  // home and back, including the browser's own Back
  await page.tap('#back');
  await page.waitForTimeout(450);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  assert.equal(await page.evaluate(() => document.getElementById('list').inert), true);
  await layoutChecks(page);
  await page.tap('.tile:nth-child(4) .tile-open');
  await page.waitForTimeout(450);
  assert.equal(await page.textContent('#title'), 'Gift ideas');
  assert.equal(await page.textContent('#empty-title'), 'Nothing here yet');
  await page.goBack();
  await page.waitForTimeout(450);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  await page.goForward();
  await page.waitForTimeout(450);
  assert.equal(await page.textContent('#title'), 'Gift ideas');

  // finishing the only item shows the cleared state
  await page.tap('#thought');
  await page.keyboard.type('A candle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.tap('#open .check');
  await page.waitForTimeout(900);
  assert.equal(await page.textContent('#empty-title'), 'All clear');
  assert.match(await page.textContent('#done-toggle'), /1 done/);

  // survives a reload, in this browser
  await page.reload();
  await page.waitForSelector('#done-wrap:not([hidden])');
  assert.equal(await page.textContent('#title'), 'Gift ideas');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('quiet-list-v1')).lists[0].tasks.filter(t => !t.done)[0].text), start[4] + ' today');
};

const keyboardFlows = async page => {
  await layoutChecks(page);
  const start = await openTexts(page);
  await page.keyboard.press('n');
  await page.keyboard.type('<img src=x onerror="document.title=\'pwned\'"><b>bold</b>');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert.equal((await openTexts(page))[0], '<img src=x onerror="document.title=\'pwned\'"><b>bold</b>');
  assert.equal(await page.locator('#open img, #open b').count(), 0, 'typed markup stays text');
  assert.doesNotMatch(await page.title(), /pwned/);

  // tick with the keyboard
  await page.keyboard.press('Tab'); // Add button is hidden when empty, so this lands on the first tick box
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Done: <img/);
  await page.keyboard.press('Space');
  await page.waitForTimeout(900);
  assert.deepEqual(await openTexts(page), start);
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY', 'focus is not lost');

  // reorder with arrows on the grip
  await page.focus('#open .row:nth-child(1) .handle');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(350);
  assert.deepEqual(await openTexts(page), [start[1], start[2], start[0], start[3], start[4]]);
  assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), /^Reorder: Find the charger/);
  assert.match(await page.textContent('#live'), /Moved to 3 of 5/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await openTexts(page), start);

  // edit: Enter saves, Escape discards, emptying deletes (with undo)
  await page.focus('#open .row:nth-child(2) button.text');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' neatly');
  await page.keyboard.press('Enter');
  assert.equal((await openTexts(page))[1], start[1] + ' neatly');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' zzz');
  await page.keyboard.press('Escape');
  assert.equal((await openTexts(page))[1], start[1] + ' neatly');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  assert.equal((await openTexts(page)).length, 4);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  assert.equal((await openTexts(page)).length, 5);

  // mouse click outside saves an open edit without eating the click
  await page.click('#open .row:nth-child(1) button.text');
  await page.keyboard.type('!');
  await page.click('#open .row:nth-child(3) button.text');
  assert.equal((await openTexts(page))[0], start[0] + '!');
  assert.equal(await page.locator('#open .row:nth-child(3) .card.editing').count(), 1);
  await page.keyboard.press('Escape');

  // lists: create, rename, recolour, delete, undo
  await page.click('#new-list');
  await page.keyboard.type('Errands');
  await page.check('#color-sky');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert.equal(await page.textContent('#title'), 'Errands');
  assert.equal(await page.locator('.tile').count(), 5);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--h')), '240');
  await page.click('#list-more');
  await page.fill('#list-name', '   ');
  await page.click('#list-save');
  assert.match(await page.textContent('#list-error'), /name/);
  await page.fill('#list-name', 'Errands & bits');
  await page.click('#list-save');
  assert.equal(await page.textContent('#title'), 'Errands & bits');
  await page.click('#list-more');
  await page.click('#list-delete');
  await page.click('#list-confirm-yes');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.tile').count(), 4);
  await page.click('#toast-undo');
  assert.equal(await page.locator('.tile').count(), 5);
  await page.keyboard.press('[');
  assert.equal(await page.textContent('#title'), 'Gift ideas');

  // done section: show, reopen, clear
  await page.click('.tile:nth-child(1) .tile-open');
  await page.click('#done-toggle');
  assert.equal(await page.locator('#done .row').count(), 2);
  await page.click('#done .row:nth-child(1) .check');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#done .row').count(), 1);
  await page.click('#clear-done');
  assert.equal(await page.isVisible('#done-wrap'), false);

  // pasting several lines adds them in order
  await page.focus('#thought');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text', '- milk\n- eggs\n\n3. flour');
    document.getElementById('thought').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  assert.deepEqual((await openTexts(page)).slice(0, 3), ['milk', 'eggs', 'flour']);

  // a second tab in the same browser picks the change up
  const other = await page.context().newPage();
  await other.goto(page.url());
  await other.waitForSelector('#open .row');
  await other.keyboard.press('n');
  await other.keyboard.type('From another tab');
  await other.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert.equal((await openTexts(page))[0], 'From another tab');
  await other.close();

  // restore: a bad file is refused, the sample reset asks first
  await page.click('#open-settings');
  await page.setInputFiles('#file', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":2,"lists":[{"id":"a"}]}') });
  await page.waitForTimeout(200);
  assert.match(await page.textContent('#settings-status'), /Invalid list/);
  assert.equal(await page.isVisible('#settings-confirm'), false);
  await page.click('#reset');
  await page.click('#settings-confirm-yes');
  assert.equal((await openTexts(page)).length, 5);
};

const reducedMotion = async page => {
  await page.click('#open .row:nth-child(1) .check');
  await page.waitForTimeout(60);
  assert.equal((await openTexts(page)).length, 4, 'completes at once');
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'nothing animates');
  const row = await center(page, '#open .row:nth-child(1) .text');
  await page.mouse.move(row.x, row.y); await page.mouse.down(); await page.mouse.move(row.x + 80, row.y, { steps: 4 }); await page.mouse.move(row.x + 200, row.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(80);
  assert.equal((await openTexts(page)).length, 3, 'swipe still works');
};

const previewBundle = async page => {
  await layoutChecks(page);
  await page.tap('#fab');
  await page.keyboard.type('Works in the bundle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  assert.equal((await openTexts(page))[0], 'Works in the bundle');
};

const smallAndDark = async page => {
  await layoutChecks(page);
  await page.tap('#open .row:nth-child(1) button.text');
  await layoutChecks(page);
  const contrast = await page.evaluate(() => {
    // rough WCAG contrast of body text against the row surface, computed by the browser
    const lum = c => { const x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1);
      const [r, g, b] = [...x.getImageData(0, 0, 1, 1).data].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
    const s = getComputedStyle(document.documentElement);
    const v = n => s.getPropertyValue(n).trim();
    return { text: ratio(v('--ink'), v('--surface')), muted: ratio(v('--muted'), v('--bg')), accent: ratio(v('--on-accent'), v('--accent')), tile: ratio(v('--on-tile'), v('--tile')) };
  });
  for (const [name, value] of Object.entries(contrast)) assert.ok(value >= 4.5, `${name} contrast ${value.toFixed(2)}`);
};


/* ---------- account, sync and assistant flows (sample data only) ---------- */
const waitFor = async (check, label, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { if (await check()) return; if (Date.now() > end) throw Error('timed out: ' + label); await new Promise(r => setTimeout(r, 250)); }
};
const titles = page => page.$$eval('.tile-name', nodes => nodes.map(n => n.textContent));
async function signIn(page, { create = false } = {}) {
  await page.evaluate(() => document.getElementById('open-settings').click());
  await page.waitForSelector('#login-form:not([hidden])');
  if (create) await page.click('#signup-toggle');
  await page.fill('#login-name', 'sample-owner');
  await page.fill('#login-password', 'correct horse battery staple');
  if (create) await page.fill('#login-setup', SETUP);
  await page.click('#login-submit');
  await page.waitForSelector('#account-in:not([hidden])');
}
const closeSettings = page => page.evaluate(() => document.getElementById('settings-dialog').close());
const addThought = async (page, text) => { await page.fill('#thought', text); await page.keyboard.press('Enter'); await page.waitForTimeout(350); };

async function accountFlows() {
  const browser = await chromium.launch();
  const problems = [];
  const device = async (name, options) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource: the server responded with a status of 401/.test(m.text())) problems.push(`${name}: ${m.text()}`); });
    page.on('pageerror', e => problems.push(`${name} pageerror: ${e.message}`));
    await page.goto(base + '/');
    await page.waitForSelector('#open .row, #empty:not([hidden])');
    return { context, page };
  };
  const step = async (name, body) => {
    try { await body(); results.push(['ok', name]); }
    catch (error) { results.push(['FAIL', name, error.message.split('\n').slice(0, 5).join('\n   ')]); throw error; }
  };
  try {
    const iphone = await device('iphone', devices['iPhone 13']);
    const pixel = await device('pixel', devices['Pixel 7']);
    const A = iphone.page, B = pixel.page;

    await step('Installable: manifest, icons and offline worker are served', async () => {
      const manifest = await A.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
      assert.equal(manifest.display, 'standalone');
      for (const icon of manifest.icons) assert.equal(await A.evaluate(async src => (await fetch(src)).status, icon.src), 200);
      assert.ok(manifest.icons.some(i => i.sizes === '192x192') && manifest.icons.some(i => i.sizes === '512x512'));
      await A.evaluate(() => navigator.serviceWorker.ready);
      assert.equal(await A.evaluate(async () => (await fetch(document.querySelector('link[rel=apple-touch-icon]').href)).status), 200);
    });

    await step('Before sign-in: lists are local, and the app says so', async () => {
      await addThought(A, 'Written before signing in');
      await A.evaluate(() => document.getElementById('back').click());
      assert.match(await A.textContent('#sync-line'), /this browser only/);
      assert.equal(await A.isVisible('#sync-action'), true);
    });

    await step('Create account on phone 1; local lists are offered, copied, and kept', async () => {
      const localBefore = await A.evaluate(() => localStorage.getItem('quiet-list-v1'));
      await signIn(A, { create: true });
      await A.waitForSelector('#migrate:not([hidden])');
      assert.match(await A.textContent('#migrate-text'), /4 lists with 13 items/);
      await A.click('#migrate-yes');
      await waitFor(async () => (await titles(A)).length === 5, 'copied lists appear');
      assert.deepEqual(await titles(A), ['Brain dump', 'Brain dump', 'Weekend', 'Someday', 'Gift ideas']);
      assert.equal(await A.evaluate(() => localStorage.getItem('quiet-list-v1')), localBefore, 'browser-local lists untouched');
      await closeSettings(A);
      await waitFor(async () => /Synced to your account \(sample-owner\)/.test(await A.textContent('#sync-line')), 'synced status');
    });

    await step('Phone 2 signs in and sees the same lists', async () => {
      await signIn(B);
      await closeSettings(B);
      await waitFor(async () => (await titles(B)).length === 5, 'lists on second device');
      await B.evaluate(() => document.getElementById('back').click());
      await B.tap('.tile:nth-child(2) .tile-open');
      await waitFor(async () => (await openTexts(B))[0] === 'Written before signing in', 'migrated item visible on phone 2');
    });

    await step('A task added on phone 2 appears on phone 1 without a reload', async () => {
      await A.tap('.tile:nth-child(2) .tile-open');
      await addThought(B, 'Added on the Pixel');
      await waitFor(async () => (await openTexts(A))[0] === 'Added on the Pixel', 'phone 1 receives it');
    });

    await step('Swipe-complete on phone 1 shows as done on phone 2', async () => {
      await A.waitForTimeout(500);                 // let the arrival animation finish before aiming a finger at the row
      assert.equal((await openTexts(A))[0], 'Added on the Pixel');
      const row = await center(A, '#open .row:nth-child(1) .text');
      await finger(A, [row, { x: row.x + 170, y: row.y }]);
      await waitFor(async () => !(await openTexts(B)).includes('Added on the Pixel'), 'phone 2 sees completion');
      assert.match(await B.textContent('#count'), /2 done/);
    });

    await step('Delete then Undo on phone 1 never reaches the server', async () => {
      await A.waitForTimeout(500);
      const before = await openTexts(A);
      const row = await center(A, '#open .row:nth-child(1) .text');
      await finger(A, [row, { x: row.x - 170, y: row.y }]);
      assert.equal((await openTexts(A)).length, before.length - 1);
      await A.tap('#toast-undo');
      await A.waitForTimeout(1500);
      assert.deepEqual(await openTexts(A), before);
      assert.deepEqual(await openTexts(B), before);
    });

    await step('Offline on phone 2: app reopens, change waits, then syncs', async () => {
      await pixel.context.setOffline(true);
      await B.reload();
      await B.waitForSelector('#open .row');
      await addThought(B, 'Thought while offline');
      await B.evaluate(() => document.getElementById('back').click());
      await waitFor(async () => /Offline\. 1 change waiting/.test(await B.textContent('#sync-line')), 'offline status');
      assert.ok(!(await openTexts(A)).includes('Thought while offline'));
      await pixel.context.setOffline(false);
      await B.evaluate(() => dispatchEvent(new Event('online')));
      await waitFor(async () => (await openTexts(A))[0] === 'Thought while offline', 'phone 1 receives the offline change');
      await waitFor(async () => /Synced to your account/.test(await B.textContent('#sync-line')), 'synced again');
    });

    let tokens, clientId, listId;
    await step('Assistant connects through the consent screen (OAuth + PKCE)', async () => {
      const crypto = require('node:crypto');
      const redirectUri = previewBase + 'callback';      // stands in for the assistant's own return page
      const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Sample Assistant', redirect_uris: [redirectUri] }) })).json();
      clientId = reg.client_id;
      const verifier = crypto.randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's1', scope: 'lists:read lists:write', resource: base + '/mcp' });
      const tab = await iphone.context.newPage();
      await tab.goto(`${base}/oauth/authorize?${query}`);
      assert.match(await tab.textContent('h1'), /Connect Sample Assistant\?/);
      assert.match(await tab.textContent('main'), /cannot delete/);
      await tab.click('button[value=allow]');
      await tab.waitForURL(url => url.href.startsWith(redirectUri), { timeout: 8000 });
      const returned = new URL(tab.url());
      assert.equal(returned.searchParams.get('iss'), base);
      assert.equal(returned.searchParams.get('state'), 's1');
      const res = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: returned.searchParams.get('code'), client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }) });
      assert.equal(res.status, 200);
      tokens = await res.json();
      await tab.close();
    });

    const call = async (name, args = {}) => {
      const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return res.status === 200 ? (await res.json()).result : { status: res.status };
    };
    await step('Assistant reads lists, adds, edits and completes; both phones show it', async () => {
      const lists = (await call('list_lists')).structuredContent.lists;
      assert.equal(lists.length, 5);
      listId = lists[1].id;
      const tasks = (await call('get_list', { list_id: listId })).structuredContent.tasks;
      assert.equal(tasks[0].text, 'Thought while offline');
      const added = (await call('add_task', { list_id: listId, text: 'Added by the assistant' })).structuredContent.added;
      await waitFor(async () => (await openTexts(A))[0] === 'Added by the assistant', 'phone 1 shows assistant task');
      await call('edit_task', { list_id: listId, task_id: added.id, text: 'Edited by the assistant' });
      await waitFor(async () => (await openTexts(A))[0] === 'Edited by the assistant', 'phone 1 shows the edit');
      await call('complete_task', { list_id: listId, task_id: tasks[0].id });
      await waitFor(async () => !(await openTexts(A)).includes('Thought while offline'), 'phone 1 shows completion');
      await B.tap('.tile:nth-child(2) .tile-open');
      await waitFor(async () => (await openTexts(B))[0] === 'Edited by the assistant', 'phone 2 too');
    });

    await step('Owner sees the connection and can cut it off', async () => {
      await A.evaluate(() => document.getElementById('open-settings').click());
      await A.waitForSelector('#connections button');
      assert.match(await A.textContent('#connections'), /Sample Assistant.*Can read, add, edit and complete.*returns to 127\.0\.0\.1/s);
      assert.equal(await A.textContent('#mcp-url'), base + '/mcp');
      await A.click('#connections button');
      await waitFor(async () => /No assistant is connected/.test(await A.textContent('#connections')), 'disconnected');
      assert.equal((await call('list_lists')).status, 401);
    });

    await step('Sign out removes the account copy from the device and brings back local lists', async () => {
      await A.click('#logout');
      await waitFor(async () => (await titles(A)).length === 4, 'local lists return');
      assert.equal(await A.evaluate(() => localStorage.getItem('quiet-list-account')), null);
      await closeSettings(A);
      await A.evaluate(() => document.querySelector('.tile-open').click());
      await waitFor(async () => (await openTexts(A))[0] === 'Written before signing in', 'local item still there');
      const cookies = await iphone.context.cookies();
      assert.equal(cookies.length, 0, 'session cookie cleared');
      const other = await pixel.context.cookies();
      assert.ok(other[0].httpOnly && other[0].sameSite === 'Lax', 'session cookie is HttpOnly, SameSite=Lax');
      assert.equal((await B.evaluate(() => document.cookie)), '', 'page scripts cannot read the session');
    });

    assert.deepEqual(problems, [], 'console errors');
  } catch { /* recorded by step */ }
  if (problems.length) results.push(['FAIL', 'console clean', problems.slice(0, 5).join('\n   ')]);
  await browser.close();
}

(async () => {
  const { startServer } = await import('../server/node.js');
  const running = await startServer({ port: 0, setupCode: SETUP, passwordIterations: 1000 });
  base = running.url.replace('127.0.0.1', 'localhost');     // localhost is a secure context, so the offline worker runs
  await new Promise(resolve => previewServer.listen(0, '127.0.0.1', resolve));
  previewBase = `http://127.0.0.1:${previewServer.address().port}/`;
  await run('iPhone 13 size, touch flows', devices['iPhone 13'], touchFlows);
  await run('Pixel 7 size, touch flows', devices['Pixel 7'], touchFlows);
  await run('Desktop, keyboard and mouse flows', { viewport: { width: 1280, height: 800 } }, keyboardFlows);
  await run('Reduced motion', { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }, reducedMotion);
  await run('Small phone (320px), dark', { ...devices['iPhone SE'], viewport: { width: 320, height: 568 }, colorScheme: 'dark' }, smallAndDark);
  await run('Phone, light contrast', devices['Pixel 7'], smallAndDark);
  await run('Single-file preview bundle', devices['iPhone 13'], previewBundle, '/preview');
  await accountFlows();
  running.server.close(); previewServer.close();
  for (const r of results) console.log(r.join('  '));
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})();
