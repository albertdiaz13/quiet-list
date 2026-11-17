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
// Collects which sound cues the app asked for, and whether the engine accepted them.
const CUE_RECORDER = () => {
  window.__cues = []; window.__finales = [];
  document.addEventListener('quiet:cue', e => window.__cues.push(e.detail.name + (e.detail.played ? '' : ':skipped')));
  document.addEventListener('quiet:finale', e => window.__finales.push(e.detail.kind + (e.detail.shown ? '' : ':still')));
};
const cues = page => page.evaluate(() => window.__cues.splice(0));
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
  if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) return;      // ONLY=theme node tests/e2e.cjs
  const browser = await chromium.launch();
  const { theme, ...deviceOptions } = contextOptions;
  const context = await browser.newContext(deviceOptions);
  if (contextOptions.theme) await context.addInitScript(theme => { if (!localStorage.getItem('quiet-list-ui')) localStorage.setItem('quiet-list-ui', JSON.stringify({ theme })); }, contextOptions.theme);
  await context.addInitScript(CUE_RECORDER);
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
    results.push(['FAIL', name, error.message.split('\n').slice(0, 22).join('\n   ')]);
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
    && !(n.getAttribute('aria-label') || n.textContent.trim() || (n.id && document.querySelector(`label[for="${n.id}"]`))
      || n.closest('label')?.textContent.trim() || document.getElementById(n.getAttribute('aria-labelledby') || '')?.textContent.trim())).map(n => n.outerHTML.slice(0, 80)));
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
  await page.tap('.tile-row:nth-child(4) .tile-open');
  await page.waitForTimeout(450);
  assert.equal(await page.textContent('#title'), 'Gift ideas');
  assert.equal(await page.getAttribute('#empty', 'data-kind'), 'fresh');
  assert.ok((await page.textContent('#empty-text')).length > 20, 'a new empty list greets you with an encouraging line');
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
  assert.equal(await page.locator('.tile-row').count(), 5);
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--h')), '258');
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
  assert.equal(await page.locator('.tile-row').count(), 4);
  await page.click('#toast-undo');
  assert.equal(await page.locator('.tile-row').count(), 5);
  await page.keyboard.press('[');
  assert.equal(await page.textContent('#title'), 'Gift ideas');

  // done section: show, reopen, clear
  await page.click('.tile-row:nth-child(1) .tile-open');
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
  while (await page.locator('#open .row').count()) { await page.click('#open .row:nth-child(1) .check'); await page.waitForTimeout(80); }
  assert.deepEqual(await page.evaluate(() => window.__finales), ['confetti:still'], 'the finale is not animated');
  assert.equal(await page.isVisible('#finale'), false);
  assert.equal(await page.textContent('#banner-title'), 'Trophy: First Sweep', 'the reward is still given, in words');
  assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length), 0);
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
    await context.addInitScript(CUE_RECORDER);
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource: the server responded with a status of 401/.test(m.text())) problems.push(`${name}: ${m.text()}`); });
    page.on('pageerror', e => problems.push(`${name} pageerror: ${e.message}`));
    await page.goto(base + '/');
    await page.waitForSelector('#open .row, #empty:not([hidden])');
    return { context, page };
  };
  let iphone, pixel;
  const step = async (name, body) => {
    try { await body(); results.push(['ok', name]); }
    catch (error) { results.push(['FAIL', name, error.message.split('\n').slice(0, 26).join('\n   ')]); if (process.env.SHOTS) { await iphone.page.screenshot({ path: process.env.SHOTS + '/syncA.png' }).catch(() => {}); await pixel.page.screenshot({ path: process.env.SHOTS + '/syncB.png' }).catch(() => {}); } throw error; }
  };
  try {
    iphone = await device('iphone', devices['iPhone 13']);
    pixel = await device('pixel', devices['Pixel 7']);
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
      await B.tap('.tile-row:nth-child(2) .tile-open');
      await waitFor(async () => (await openTexts(B))[0] === 'Written before signing in', 'migrated item visible on phone 2');
    });

    await step('A task added on phone 2 appears on phone 1 without a reload', async () => {
      await A.tap('.tile-row:nth-child(2) .tile-open');
      await A.evaluate(() => window.__cues.splice(0));
      await addThought(B, 'Added on the Pixel');
      await waitFor(async () => (await openTexts(A))[0] === 'Added on the Pixel', 'phone 1 receives it');
      assert.deepEqual(await A.evaluate(() => window.__cues), [], 'a change arriving from another device makes no sound');
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

    await step('Insert-at-position, move, Recently deleted and the trophy tally all sync', async () => {
      await A.waitForTimeout(600);
      await B.tap('.tile-row:nth-child(2) .tile-open'); await B.waitForTimeout(500);     // phone 2 was on the Lists screen
      await A.focus('#open .row:nth-child(1) button.text'); await A.keyboard.press('+');
      await A.keyboard.type('Inserted second'); await A.keyboard.press('Enter');
      await waitFor(async () => (await openTexts(B))[1] === 'Inserted second', 'phone 2 sees it in the same position');
      // move it to the first list from phone 2; phone 1 loses it
      await B.tap('#open .row:nth-child(2) button.text'); await B.tap('.tool-move'); await B.waitForTimeout(400);
      await B.tap('#move-targets .target-btn:nth-child(1)');
      await waitFor(async () => !(await openTexts(A)).includes('Inserted second'), 'phone 1 sees the move', 20000);
      // delete a task on phone 1; restore it from the bin on phone 2
      await A.waitForTimeout(500);
      const gone = (await openTexts(A))[0];
      const row = await center(A, '#open .row:nth-child(1) .text');
      await finger(A, [row, { x: row.x - 170, y: row.y }]);
      await waitFor(async () => !(await openTexts(B)).includes(gone), 'phone 2 sees the delete (after the Undo window)', 25000);
      await B.evaluate(() => document.getElementById('back').click()); await B.waitForTimeout(400);
      await B.evaluate(() => document.getElementById('open-settings').click()); await B.waitForTimeout(400);
      assert.equal(await B.textContent('#open-trash'), 'Recently deleted (1)');
      await B.evaluate(() => document.getElementById('open-trash').click()); await B.waitForTimeout(400);
      await B.tap('#trash-list li:nth-child(1) button');
      await waitFor(async () => (await openTexts(A))[0] === gone, 'phone 1 gets the restored task back');
      await B.evaluate(() => { document.getElementById('trash-dialog').close(); document.getElementById('settings-dialog').close(); });
      // clear a list on phone 2; the trophy tally arrives on phone 1 without a sound there
      await B.tap('.tile-row:nth-child(5) .tile-open'); await B.waitForTimeout(400);
      await addThought(B, 'One small thing');
      await B.tap('#title'); await B.tap('#open .row:nth-child(1) .check'); await B.waitForTimeout(1200);
      assert.equal(await B.textContent('#banner-title'), 'Trophy: First Sweep');
      await A.evaluate(() => { window.__cues.splice(0); window.__finales.splice(0); });
      await A.evaluate(() => document.getElementById('back').click()); await A.waitForTimeout(400);
      await waitFor(async () => { await A.evaluate(() => document.getElementById('open-trophies').click()); const n = await A.textContent('#tally-count'); await A.evaluate(() => document.getElementById('trophy-dialog').close()); return n === '1'; }, 'phone 1 shows the same tally');
      assert.deepEqual(await A.evaluate(() => window.__finales), [], 'no finale plays on the other phone');
      await A.tap('.tile-row:nth-child(2) .tile-open'); await A.waitForTimeout(400);
      await B.evaluate(() => document.getElementById('back').click()); await B.waitForTimeout(400);
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
      await B.tap('.tile-row:nth-child(2) .tile-open');
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


/* ---------- this round: paging between lists, list swipes, sound, settings sheet ---------- */
const inView = (page, selector) => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && r.height > 0; }, selector);
const title = page => page.textContent('#title');

const pagingAndSound = async page => {
  // nothing may sound, and no audio engine may exist, before the first touch
  assert.equal(await page.getAttribute('html', 'data-audio'), 'idle');
  assert.deepEqual(await cues(page), []);
  const start = await openTexts(page);
  const blank = async () => { const box = await page.locator('#open').boundingBox(); return { x: 195, y: box.y + box.height + 70 }; };   // empty space under the tasks

  // 1. swipe left on empty space: next list slides in
  let from = await blank();
  await finger(page, [from, { x: from.x - 190, y: from.y + 6 }]);
  assert.equal(await title(page), 'Weekend');
  assert.ok((await cues(page)).includes('nav'), 'list switch has its own cue');
  assert.equal(await page.locator('.pane.ghost').count(), 0, 'the travelling copy is removed');
  assert.equal(await page.evaluate(() => document.getElementById('list').style.transform), '');
  // 2. swipe right on the add field (not focused): back again
  const field = await center(page, '#capture');
  await finger(page, [field, { x: field.x + 190, y: field.y }]);
  assert.equal(await title(page), 'Brain dump');
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'thought', 'the swipe did not open the keyboard');
  // 3. a short or slow sideways nudge springs back
  from = await blank();
  await finger(page, [from, { x: from.x - 60, y: from.y }], { steps: 30 });
  assert.equal(await title(page), 'Brain dump');
  // 4. first list has nothing to its left: resists and stays
  await finger(page, [from, { x: from.x + 200, y: from.y }]);
  assert.equal(await title(page), 'Brain dump');
};

const gestureConflicts = async page => {
  const start = await openTexts(page);
  const blankY = async () => { const box = await page.locator('#open').boundingBox(); return box.y + box.height + 70; };
  // edge start: ignored by list paging
  let y = await blankY();
  await finger(page, [{ x: 10, y }, { x: 250, y }]);
  assert.equal(await title(page), 'Brain dump', 'left-edge start does nothing');
  await finger(page, [{ x: 382, y }, { x: 120, y }]);
  assert.equal(await title(page), 'Brain dump', 'right-edge start does nothing');
  // a sideways swipe that starts ON a task acts on the task, and never changes list
  let row = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [row, { x: row.x - 190, y: row.y }]);
  assert.equal(await title(page), 'Brain dump');
  assert.deepEqual(await openTexts(page), start.slice(1), 'task deleted by its own swipe');
  await page.tap('#toast-undo'); await page.waitForTimeout(500);
  row = await center(page, '#open .row:nth-child(2) .text');
  await finger(page, [row, { x: row.x + 190, y: row.y }]);
  assert.equal(await title(page), 'Brain dump');
  assert.equal((await openTexts(page)).length, start.length - 1, 'task completed by its own swipe');
  // a vertical drag on empty space never changes list, even when it wanders sideways
  y = await blankY();
  await finger(page, [{ x: 200, y }, { x: 150, y: y - 160 }]);
  assert.equal(await title(page), 'Brain dump');
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  // pull-to-add still works from empty space, and does not page
  y = await blankY();
  await finger(page, [{ x: 200, y: y - 40 }, { x: 214, y: y + 170 }]);
  assert.equal(await title(page), 'Brain dump');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'thought', 'pull-to-add focused the add field');
  await page.evaluate(() => document.activeElement.blur());
  // a sideways swipe right after still pages (no gesture got stuck)
  y = await blankY();
  await finger(page, [{ x: 300, y }, { x: 100, y }]);
  assert.equal(await title(page), 'Weekend');
  // hold-to-drag on a task still reorders on the new list
  const names = await openTexts(page);
  const last = await center(page, '#open .row:nth-child(3) .text'), first = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [last, { x: last.x, y: first.y - 14 }], { hold: 560 });
  assert.deepEqual(await openTexts(page), [names[2], names[0], names[1]]);
  assert.equal(await title(page), 'Weekend');
  // dots still work, with the slide
  await page.tap('#pager button:nth-child(4)'); await page.waitForTimeout(600);
  assert.equal(await title(page), 'Gift ideas');
};

const listSwipes = async page => {
  await page.tap('#back'); await page.waitForTimeout(500);
  await cues(page);
  const tile = n => center(page, `.tile-row:nth-child(${n}) .tile-open`);
  // swipe LEFT on a list: asks first, says tasks go too, and Keep it changes nothing
  let t = await tile(2);
  await finger(page, [t, { x: t.x - 170, y: t.y }]);
  assert.equal(await page.isVisible('#confirm-dialog'), true);
  assert.equal(await page.textContent('#confirm-title'), 'Delete “Weekend”?');
  assert.match(await page.textContent('#confirm-text'), /deletes the list and the 3 tasks in it \(3 open, 0 done\)/);
  assert.equal(await page.locator('.tile-row').count(), 4, 'nothing is deleted before the answer');
  assert.ok(await inView(page, '#confirm-yes') && await inView(page, '#confirm-no'));
  await page.tap('#confirm-no'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.tile-row').count(), 4);
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home', 'the swipe did not open the list');
  // confirm: gone, with Undo
  await finger(page, [t, { x: t.x - 170, y: t.y }]);
  await page.tap('#confirm-yes'); await page.waitForTimeout(500);
  assert.deepEqual(await page.$$eval('.tile-name', n => n.map(x => x.textContent)), ['Brain dump', 'Someday', 'Gift ideas']);
  assert.ok((await cues(page)).includes('delete'));
  await page.tap('#toast-undo'); await page.waitForTimeout(500);
  assert.deepEqual(await page.$$eval('.tile-name', n => n.map(x => x.textContent)), ['Brain dump', 'Weekend', 'Someday', 'Gift ideas']);
  assert.equal(await page.textContent('.tile-row:nth-child(2) .tile-count'), '3 open', 'its tasks came back with it');
  // a short swipe springs back and asks nothing
  t = await tile(2);
  await finger(page, [t, { x: t.x - 40, y: t.y }]);
  assert.equal(await page.isVisible('#confirm-dialog'), false);

  // swipe RIGHT on a list: quick add without opening it
  t = await tile(4);
  await finger(page, [t, { x: t.x + 170, y: t.y }]);
  assert.equal(await page.isVisible('#quick-dialog'), true);
  assert.equal(await page.textContent('#quick-title'), 'Add to Gift ideas');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'quick-text');
  await page.keyboard.type('A candle'); await page.keyboard.press('Enter');
  await page.keyboard.type('Good socks'); await page.keyboard.press('Enter');
  assert.match(await page.textContent('#quick-status'), /Added 2 thoughts/);
  assert.ok(await inView(page, '#quick-done'));
  await page.tap('#quick-done'); await page.waitForTimeout(300);
  assert.equal(await page.textContent('.tile-row:nth-child(4) .tile-count'), '2 open');
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  await page.tap('.tile-row:nth-child(4) .tile-open'); await page.waitForTimeout(500);
  assert.deepEqual(await openTexts(page), ['Good socks', 'A candle']);
  // vertical scrolling over the tiles and hold-to-drag reordering still work
  await page.tap('#back'); await page.waitForTimeout(500);
  const a = await tile(1), c = await tile(3);
  await finger(page, [a, { x: a.x, y: c.y + 20 }], { hold: 560 });
  assert.deepEqual(await page.$$eval('.tile-name', n => n.map(x => x.textContent)), ['Weekend', 'Someday', 'Brain dump', 'Gift ideas']);
  assert.equal(await page.isVisible('#confirm-dialog') || await page.isVisible('#quick-dialog'), false);
};

const onlyListCannotGo = async page => {
  await page.click('#open-settings'); await page.click('#reset'); await page.click('#settings-confirm-yes');
  for (let i = 0; i < 3; i++) { await page.focus('.tile-row:nth-child(1) .tile-open'); await page.keyboard.press('Delete'); await page.click('#confirm-yes'); await page.waitForTimeout(250); }
  assert.equal(await page.locator('.tile-row').count(), 1);
  await page.focus('.tile-row .tile-open'); await page.keyboard.press('Delete'); await page.waitForTimeout(200);
  assert.equal(await page.isVisible('#confirm-dialog'), false);
  assert.match(await page.textContent('#toast-text'), /only list/);
  assert.equal(await page.locator('.tile-row').count(), 1);
  // keyboard quick add
  await page.focus('.tile-row .tile-open'); await page.keyboard.press('+');
  await page.keyboard.type('From the keyboard'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  assert.match(await page.textContent('.tile-row .tile-count'), /open/);
};

const soundRules = async page => {
  assert.equal(await page.getAttribute('html', 'data-audio'), 'idle', 'no audio engine before a touch');
  await page.waitForTimeout(600);
  assert.deepEqual(await cues(page), [], 'silent on load');
  await page.tap('#fab');
  await page.keyboard.type('Hear this'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  let heard = await cues(page);
  assert.ok(heard.includes('add') && !heard.some(c => c.endsWith(':skipped')), 'cues play after the first touch: ' + heard);
  assert.notEqual(await page.getAttribute('html', 'data-audio'), 'idle');
  await page.tap('#title');
  await page.tap('#open .row:nth-child(1) .check'); await page.waitForTimeout(900);
  assert.ok((await cues(page)).includes('done'));
  // switch off in Settings: clearly labelled, takes effect at once, survives a reload
  await page.tap('#back'); await page.waitForTimeout(400);
  await page.tap('#open-settings'); await page.waitForTimeout(400);
  assert.equal(await page.getAttribute('#sound-toggle', 'aria-checked'), 'true');
  assert.match(await page.textContent('#sound-label'), /Sound effects/);
  await page.tap('#sound-toggle');
  assert.equal(await page.getAttribute('#sound-toggle', 'aria-checked'), 'false');
  assert.equal(await page.getAttribute('html', 'data-audio'), 'off');
  await page.tap('#settings-close'); await page.waitForTimeout(300);
  await cues(page);
  await page.tap('.tile-row:nth-child(1) .tile-open'); await page.waitForTimeout(400);
  await page.tap('#open .row:nth-child(1) .check'); await page.waitForTimeout(900);
  heard = await cues(page);
  assert.ok(heard.length > 0 && heard.every(c => c.endsWith(':skipped')), 'every cue is skipped when off: ' + heard);
  await page.reload(); await page.waitForSelector('#open .row');
  await page.tap('#fab'); await page.keyboard.type('Still quiet'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  assert.ok((await cues(page)).every(c => c.endsWith(':skipped')), 'still off after reload');
  assert.equal(await page.getAttribute('html', 'data-audio'), 'off');
  // back on: plays a sample
  await page.tap('#title'); await page.tap('#back'); await page.waitForTimeout(400);
  await page.tap('#open-settings'); await page.waitForTimeout(400);
  await page.tap('#sound-toggle');
  assert.ok((await cues(page)).includes('done'), 'turning sound on plays a sample');
};

const settingsSheet = keyboardOpen => async page => {
  await page.tap('#back'); await page.waitForTimeout(450);
  await page.tap('#open-settings'); await page.waitForTimeout(450);
  const m = await page.evaluate(() => { const d = document.getElementById('settings-dialog').getBoundingClientRect(), b = document.getElementById('settings-body'); return { top: d.top, bottom: d.bottom, vh: innerHeight, scrolls: b.scrollHeight > b.clientHeight + 20, dialogScrolls: document.getElementById('settings-dialog').scrollHeight > document.getElementById('settings-dialog').clientHeight + 1 }; });
  assert.ok(m.top >= 0 && m.bottom <= m.vh, `sheet fits the screen (${Math.round(m.top)}..${Math.round(m.bottom)} of ${m.vh})`);
  assert.ok(m.scrolls, 'the middle scrolls');
  assert.ok(!m.dialogScrolls, 'only the middle scrolls, not the whole sheet');
  assert.ok(await inView(page, '#settings-close'), 'Done is on screen without scrolling');
  assert.ok(await inView(page, '#settings-close-x'), 'so is the close button');
  const done = await page.locator('#settings-close').boundingBox();
  assert.ok(done.height >= 44 && done.width >= 64, 'Done is a full-size target');
  // scroll the middle to the very end: Done has not moved, and the last control is reachable
  await page.evaluate(() => { const b = document.getElementById('settings-body'); b.scrollTop = b.scrollHeight; });
  assert.ok(await inView(page, '#settings-close'));
  assert.deepEqual(await page.locator('#settings-close').boundingBox(), done);
  if (!keyboardOpen) { assert.ok(await inView(page, '#reset'), 'bottom of the content can be scrolled into view'); }
  // the page behind does not scroll sideways or grow
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Done really dismisses
  await page.tap('#settings-close'); await page.waitForTimeout(300);
  assert.equal(await page.isVisible('#settings-dialog'), false);
  // so does the X, and so does tapping outside
  await page.tap('#open-settings'); await page.waitForTimeout(300); await page.tap('#settings-close-x'); await page.waitForTimeout(300);
  assert.equal(await page.isVisible('#settings-dialog'), false);
  if (!keyboardOpen) {
    await page.tap('#open-settings'); await page.waitForTimeout(500);
    await page.touchscreen.tap(4, await page.evaluate(() => innerHeight - 3)); await page.waitForTimeout(300);
    assert.equal(await page.isVisible('#settings-dialog'), false, 'tap outside closes');
    // appearance: light theme applies, persists, and keeps text readable
    await page.tap('#open-settings'); await page.waitForTimeout(300);
    await page.check('#theme-light', { force: true });
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await page.tap('#settings-close');
    await page.reload(); await page.waitForSelector('#open .row');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
  }
};

const shrinkLikeKeyboard = async page => {
  // An on-screen keyboard leaves roughly this much of a phone visible.
  await page.setViewportSize({ width: 390, height: 360 });
  await page.waitForTimeout(200);
  await settingsSheet(true)(page);
  // signing in with the keyboard up: the field being typed in and Done are both visible
  await page.tap('#open-settings'); await page.waitForTimeout(300);
  await page.focus('#login-password');
  await page.evaluate(() => document.getElementById('login-password').scrollIntoView({ block: 'center' }));
  assert.ok(await inView(page, '#login-password') && await inView(page, '#settings-close'));
  // the smaller sheets fit too
  await page.tap('#settings-close'); await page.waitForTimeout(300);
  await page.tap('#new-list'); await page.waitForTimeout(300);
  assert.ok(await inView(page, '#list-save') && await inView(page, '#list-name'), 'New list sheet: name and Create visible');
  await page.tap('#list-cancel');
};


/* ---------- this round: two-finger insert, Lists-screen creation, runs, rewards, search, move, bin, themes ---------- */
// Two fingers moving together, through real touch events.
async function twoFingers(page, from, to, { steps = 12 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
  await send('touchStart', [from[0]]);
  await page.waitForTimeout(30);
  await send('touchStart', from);
  for (let i = 1; i <= steps; i++) {
    await send('touchMove', from.map((p, k) => ({ x: p.x + (to[k].x - p.x) * i / steps, y: p.y + (to[k].y - p.y) * i / steps })));
    await page.waitForTimeout(14);
  }
  await page.waitForTimeout(60);
  await send('touchEnd', []);
  await cdp.detach();
  await page.waitForTimeout(650);
}
const tileNames = page => page.$$eval('.tile-name', n => n.map(x => x.textContent));
const zoomLevel = page => page.evaluate(() => window.visualViewport.scale);

const spreadToInsertTask = async page => {
  const start = await openTexts(page);
  const r2 = await center(page, '#open .row:nth-child(2) .text'), r3 = await center(page, '#open .row:nth-child(3) .text');
  // spread apart between rows 2 and 3: a slot opens there and a new task is typed straight into it
  await twoFingers(page, [r2, r3], [{ x: r2.x, y: r2.y - 60 }, { x: r3.x, y: r3.y + 60 }]);
  assert.equal(await page.locator('#open .row.draft').count(), 1, 'a draft row opened');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#open > .row')].findIndex(li => li.classList.contains('draft'))), 2, 'exactly between rows 2 and 3');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'edit-text draft-text');
  assert.equal(await zoomLevel(page), 1, 'the page did not zoom');
  assert.equal(await title(page), 'Brain dump');
  assert.ok((await cues(page)).includes('spread'));
  await page.keyboard.type('Squeezed in between'); await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const after = [start[0], start[1], 'Squeezed in between', start[2], start[3], start[4]];
  assert.deepEqual(await openTexts(page), after);
  // above the first row, and cancelling
  const r1 = await center(page, '#open .row:nth-child(1) .text');
  await twoFingers(page, [{ x: r1.x, y: r1.y - 26 }, { x: r1.x + 30, y: r1.y + 6 }], [{ x: r1.x, y: r1.y - 90 }, { x: r1.x + 30, y: r1.y + 80 }]);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#open > .row')].findIndex(li => li.classList.contains('draft'))), 0);
  await page.tap('.draft-cancel'); await page.waitForTimeout(300);
  assert.deepEqual(await openTexts(page), after, 'cancel adds nothing');
  // things that must NOT insert: a small spread, a pinch-in, a sideways two-finger stretch, two fingers scrolling together
  const a = await center(page, '#open .row:nth-child(2) .text'), b = await center(page, '#open .row:nth-child(3) .text');
  await twoFingers(page, [a, b], [{ x: a.x, y: a.y - 12 }, { x: b.x, y: b.y + 12 }]);
  await twoFingers(page, [{ x: a.x, y: a.y - 60 }, { x: b.x, y: b.y + 60 }], [a, b]);
  await twoFingers(page, [{ x: a.x - 20, y: a.y }, { x: a.x + 20, y: b.y }], [{ x: a.x - 130, y: a.y }, { x: a.x + 130, y: b.y }]);
  await twoFingers(page, [a, b], [{ x: a.x, y: a.y - 80 }, { x: b.x, y: b.y - 80 }]);
  assert.equal(await page.locator('#open .row.draft').count(), 0);
  assert.deepEqual(await openTexts(page), after);
  assert.equal(await zoomLevel(page), 1);
  await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0; });
  // one-finger gestures are unharmed afterwards
  const row = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [row, { x: row.x + 180, y: row.y }]);
  assert.deepEqual(await openTexts(page), after.slice(1), 'swipe-to-complete still works');
  const blank = await page.locator('#open').boundingBox();
  await finger(page, [{ x: 300, y: blank.y + blank.height + 60 }, { x: 90, y: blank.y + blank.height + 60 }]);
  assert.equal(await title(page), 'Weekend', 'paging still works');
  await page.tap('#pager button:nth-child(1)'); await page.waitForTimeout(600);
  // where zoom is kept and where it is given to the gesture
  assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.getElementById('list')).touchAction, getComputedStyle(document.getElementById('open')).touchAction, getComputedStyle(document.getElementById('home')).touchAction]), ['pan-y pinch-zoom', 'pan-y', 'auto']);
  assert.ok(!/user-scalable|maximum-scale/.test(await page.getAttribute('meta[name=viewport]', 'content')), 'browser zoom is not switched off page-wide');
  // without gestures: + on a focused task, and the Insert button on an open task
  await page.focus('#open .row:nth-child(1) button.text'); await page.keyboard.press('+');
  await page.keyboard.type('Keyboard insert'); await page.keyboard.press('Enter'); await page.waitForTimeout(350);
  assert.equal((await openTexts(page))[1], 'Keyboard insert');
  await page.tap('#open .row:nth-child(3) button.text'); await page.tap('.tool-insert'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#open > .row')].findIndex(li => li.classList.contains('draft'))), 3);
  await page.keyboard.type('Button insert'); await page.tap('.draft-add'); await page.waitForTimeout(350);
  const final = await openTexts(page);
  assert.equal(final[3], 'Button insert');
  await page.reload(); await page.waitForSelector('#open .row');
  assert.deepEqual(await openTexts(page), final, 'positions survive a reload');
};

const listsScreenCreation = async page => {
  await page.tap('#back'); await page.waitForTimeout(500);
  const make = async name => { await page.keyboard.type(name); await page.keyboard.press('Enter'); await page.waitForTimeout(500); assert.equal(await title(page), name); await page.tap('#back'); await page.waitForTimeout(500); };
  // pull down: a new list at the top
  const first = await center(page, '.tile-row:nth-child(1) .tile-open');
  await finger(page, [first, { x: first.x + 8, y: first.y + 190 }]);
  assert.equal(await page.isVisible('#list-dialog'), true, 'pull opened New list');
  await make('Top one');
  assert.equal((await tileNames(page))[0], 'Top one');
  // a short pull does nothing
  await finger(page, [first, { x: first.x, y: first.y + 40 }]);
  assert.equal(await page.isVisible('#list-dialog'), false);
  // tap the empty space below the lists: a new list at the end
  const vh = await page.evaluate(() => innerHeight);
  const below = await page.locator('.fineprint').boundingBox();
  assert.ok(below.y + below.height + 40 < vh, 'there is empty space to tap');
  await page.touchscreen.tap(200, Math.min(vh - 20, below.y + below.height + 60)); await page.waitForTimeout(400);
  assert.equal(await page.isVisible('#list-dialog'), true, 'tap on empty space offers a new list');
  await make('Last one');
  assert.equal((await tileNames(page)).at(-1), 'Last one');
  // tapping a list or the gaps between lists does not
  const t2 = await page.locator('.tile-row:nth-child(2)').boundingBox();
  await page.touchscreen.tap(200, t2.y + t2.height + 5); await page.waitForTimeout(300);
  assert.equal(await page.isVisible('#list-dialog'), false, 'the gap between two lists is not "empty space below"');
  // (Phones snap a tap in a narrow gap to the nearest list, so this may have opened one. Go back if so.)
  if (await page.getAttribute('#app', 'data-view') === 'list') { await page.tap('#back'); await page.waitForTimeout(500); }
  await page.evaluate(() => { document.getElementById('home-scroll').scrollTop = 0; });
  // spread two fingers between lists 2 and 3: a new list right there
  const a = await center(page, '.tile-row:nth-child(2) .tile-open'), b = await center(page, '.tile-row:nth-child(3) .tile-open');
  await twoFingers(page, [a, b], [{ x: a.x, y: a.y - 55 }, { x: b.x, y: b.y + 55 }]);
  assert.equal(await page.isVisible('#list-dialog'), true, 'spread opened New list');
  assert.equal(await zoomLevel(page), 1);
  await make('Middle one');
  const names = await tileNames(page);
  assert.deepEqual(names.slice(0, 4), ['Top one', 'Brain dump', 'Middle one', 'Weekend']);
  // the button is still there and still works; a new empty list greets you
  await page.tap('#new-list'); await page.waitForTimeout(300);
  await page.keyboard.type('Via the button'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  assert.equal(await page.getAttribute('#empty', 'data-kind'), 'fresh');
  const words = [await page.textContent('#empty-title'), await page.textContent('#empty-text')];
  assert.ok(words[0].length > 4 && words[1].length > 20, 'encouraging words on a new list: ' + words);
  await page.reload(); await page.waitForSelector('#empty:not([hidden])');
  assert.deepEqual([await page.textContent('#empty-title'), await page.textContent('#empty-text')], words, 'the same words each time for the same list');
  await page.tap('#back'); await page.waitForTimeout(400);
  assert.deepEqual((await tileNames(page)).slice(0, 4), names.slice(0, 4), 'order survives a reload');
  // list swipes still work after all that (the screen had scrolled to show the newest list)
  await page.evaluate(() => { document.getElementById('home-scroll').scrollTop = 0; });
  const t = await center(page, '.tile-row:nth-child(1) .tile-open');
  await finger(page, [t, { x: t.x - 170, y: t.y }]);
  assert.equal(await page.textContent('#confirm-title'), 'Delete “Top one”?');
  await page.tap('#confirm-no');
};

const runsAndRewards = async page => {
  await page.addInitScript(() => { window.__steps = []; document.addEventListener('quiet:cue', e => { if (e.detail.name === 'done' || e.detail.name === 'clear') window.__steps.push(e.detail.step ?? null); }); });
  await page.reload(); await page.waitForSelector('#open .row');
  const tick = async () => { await page.tap('#open .row:nth-child(1) .check'); await page.waitForTimeout(820); };
  await tick(); assert.equal(await page.isVisible('#combo'), false, 'one on its own shows no counter');
  await tick(); assert.equal(await page.textContent('#combo'), '×2');
  await tick(); assert.equal(await page.textContent('#combo'), '×3');
  assert.deepEqual(await page.evaluate(() => window.__steps.splice(0)), [0, 1, 2], 'each completion in the run is one step higher');
  await page.waitForTimeout(3600);
  assert.equal(await page.isVisible('#combo'), false, 'the counter leaves after a pause');
  await tick();
  assert.deepEqual(await page.evaluate(() => window.__steps.splice(0)), [0], 'a pause resets the run');
  // clearing a whole list: finale, banner, trophy, and the tally
  const clearList = async (n, text) => {
    await page.tap('#back'); await page.waitForTimeout(450); await page.tap(`.tile-row:nth-child(${n}) .tile-open`); await page.waitForTimeout(500);
    if (text) { await page.tap('#fab'); await page.keyboard.type(text); await page.keyboard.press('Enter'); await page.waitForTimeout(300); await page.tap('#title'); }
    while (await page.locator('#open .row').count()) { await page.tap('#open .row:nth-child(1) .check'); await page.waitForTimeout(760); }
    await page.waitForTimeout(300);
  };
  await page.evaluate(() => window.__finales.splice(0));
  await clearList(4, 'A candle');
  assert.deepEqual(await page.evaluate(() => window.__finales.splice(0)), ['confetti']);
  assert.equal(await page.textContent('#banner-title'), 'Trophy: First Sweep');
  assert.match(await page.textContent('#banner-text'), /1 list cleared/);
  assert.ok((await cues(page)).includes('trophy'));
  assert.equal(await page.textContent('#empty-title'), 'All clear');
  // un-ticking and re-ticking the same task does not count again
  await page.tap('#done-toggle'); await page.tap('#done .row:nth-child(1) .check'); await page.waitForTimeout(500);
  await page.tap('#open .row:nth-child(1) .check'); await page.waitForTimeout(1000);
  await page.tap('#back'); await page.waitForTimeout(450);
  await page.tap('#open-trophies'); await page.waitForTimeout(400);
  assert.equal(await page.textContent('#tally-count'), '1');
  assert.equal(await page.locator('.trophy.earned').count(), 1);
  assert.equal(await page.isDisabled('#finale-fireworks'), true, 'Fireworks is locked until 3');
  assert.ok(await inView(page, '#trophy-dialog [data-close].solid-btn'));
  await page.tap('#trophy-dialog [data-close].solid-btn'); await page.waitForTimeout(300);
  await page.tap('.tile-row:nth-child(1) .tile-open'); await page.waitForTimeout(400);
  // two more clears unlock a finale
  await clearList(2); assert.match(await page.textContent('#banner-title'), /“Weekend” cleared/);
  await clearList(3); assert.equal(await page.textContent('#banner-title'), 'New finale: Fireworks');
  await page.tap('#back'); await page.waitForTimeout(450);
  await page.tap('#open-trophies'); await page.waitForTimeout(400);
  assert.equal(await page.textContent('#tally-count'), '3');
  assert.equal(await page.isDisabled('#finale-fireworks'), false);
  await page.check('#finale-fireworks', { force: true });
  assert.deepEqual(await page.evaluate(() => window.__finales.splice(0)).then(f => f.at(-1)), 'fireworks', 'choosing a finale previews it');
  await page.reload(); await page.waitForSelector('.tile-row');          // the app reopens on the Lists screen it was left on
  assert.equal(await page.getAttribute('#app', 'data-view'), 'home');
  await page.waitForTimeout(450); await page.tap('#open-trophies'); await page.waitForTimeout(400);
  assert.equal(await page.textContent('#tally-count'), '3', 'the tally survives a reload');
  assert.equal(await page.isChecked('#finale-fireworks'), true, 'so does the chosen finale');
};

const searchMovePickBin = async page => {
  const start = await openTexts(page);
  // pick one for me
  await page.tap('#pick'); await page.waitForTimeout(400);
  const picked = await page.textContent('#pick-task');
  assert.ok(start.includes(picked));
  await page.tap('#pick-again'); await page.waitForTimeout(300);
  const second = await page.textContent('#pick-task');
  assert.ok(start.includes(second) && second !== picked, 'Another gives a different task');
  await page.tap('#pick-done'); await page.waitForTimeout(1000);
  assert.deepEqual(await openTexts(page), start.filter(t => t !== second), '"Done it" completed exactly that task');
  // move a task to another list, and undo it
  let now = await openTexts(page);
  await page.tap('#open .row:nth-child(1) button.text'); await page.tap('.tool-move'); await page.waitForTimeout(400);
  assert.deepEqual(await page.$$eval('#move-targets .target-btn span', n => n.map(x => x.textContent)), ['Weekend', 'Someday', 'Gift ideas']);
  await page.tap('#move-targets .target-btn:nth-child(1)'); await page.waitForTimeout(500);
  assert.deepEqual(await openTexts(page), now.slice(1));
  assert.match(await page.textContent('#toast-text'), /Moved to “Weekend”/);
  await page.tap('#back'); await page.waitForTimeout(450);
  assert.equal(await page.textContent('.tile-row:nth-child(2) .tile-count'), '4 open');
  // search across lists
  await page.fill('#search-text', 'door'); await page.waitForTimeout(200);
  assert.equal(await page.textContent('#results-note'), '1 match');
  assert.equal(await page.isVisible('#lists'), false);
  assert.equal(await page.textContent('#results .result mark'), 'door');
  assert.match(await page.textContent('#results .result small'), /Weekend/);
  await page.fill('#search-text', 'zzzz'); await page.waitForTimeout(200);
  assert.equal(await page.textContent('#results-note'), 'Nothing matches that.');
  await page.fill('#search-text', 'FERN'); await page.waitForTimeout(200);       // a finished task, any letter case
  assert.match(await page.textContent('#results .result small'), /Brain dump · done/);
  await page.tap('#results .result'); await page.waitForTimeout(600);
  assert.equal(await title(page), 'Brain dump');
  assert.equal(await page.locator('#done .row.found').count(), 1, 'the found task is shown and highlighted');
  assert.equal(await page.inputValue('#search-text'), '');
  // recently deleted: a task, then a whole list, restored from the bin
  now = await openTexts(page);
  const row = await center(page, '#open .row:nth-child(1) .text');
  await finger(page, [row, { x: row.x - 180, y: row.y }]);
  assert.deepEqual(await openTexts(page), now.slice(1));
  await page.tap('#back'); await page.waitForTimeout(450);
  await page.focus('.tile-row:nth-child(3) .tile-open'); await page.keyboard.press('Delete'); await page.tap('#confirm-yes'); await page.waitForTimeout(400);
  assert.deepEqual(await tileNames(page), ['Brain dump', 'Weekend', 'Gift ideas']);
  await page.tap('#open-settings'); await page.waitForTimeout(400);
  assert.equal(await page.textContent('#open-trash'), 'Recently deleted (2)');
  await page.evaluate(() => document.getElementById('open-trash').scrollIntoView()); await page.tap('#open-trash'); await page.waitForTimeout(400);
  assert.match(await page.textContent('#trash-list'), /Someday.*A whole list, with 3 tasks/s);
  assert.match(await page.textContent('#trash-list'), new RegExp(now[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*From Brain dump', 's'));
  assert.ok(await inView(page, '#trash-dialog [data-close].solid-btn'));
  await page.tap('#trash-list li:nth-child(1) button'); await page.waitForTimeout(300);
  await page.tap('#trash-list li:nth-child(1) button'); await page.waitForTimeout(300);
  assert.match(await page.textContent('#trash-note'), /Nothing here/);
  await page.tap('#trash-dialog [data-close].solid-btn'); await page.tap('#settings-close'); await page.waitForTimeout(300);
  assert.deepEqual(await tileNames(page), ['Brain dump', 'Weekend', 'Gift ideas', 'Someday'], 'the list is back, with its tasks');
  assert.equal(await page.textContent('.tile-row:nth-child(4) .tile-count'), '3 open');
  await page.tap('.tile-row:nth-child(1) .tile-open'); await page.waitForTimeout(450);
  assert.equal((await openTexts(page))[0], now[0], 'the task is back in its list');
  await page.reload(); await page.waitForSelector('#open .row');
  assert.equal((await openTexts(page))[0], now[0]);
};

const themesAndTextSize = async page => {
  const pairs = () => page.evaluate(() => {
    const lum = c => { const x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1);
      const [r, g, b] = [...x.getImageData(0, 0, 1, 1).data].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
    const worst = {};
    // every list colour, against every surface text sits on
    for (const tile of document.querySelectorAll('.tile-row')) {
      const s = getComputedStyle(tile), v = n => s.getPropertyValue(n).trim();
      const found = { text: ratio(v('--ink'), v('--surface-hi')), textLow: ratio(v('--ink'), v('--surface-lo')), muted: ratio(v('--muted'), v('--bg')), mutedOnSunk: ratio(v('--muted'), v('--sunk')), accent: ratio(v('--on-accent'), v('--accent')), tile: ratio(v('--on-tile'), v('--tile')), tileDeep: ratio(v('--on-tile'), v('--tile2')), accentOnBg: ratio(v('--accent'), v('--bg')) };
      for (const [k, x] of Object.entries(found)) worst[k] = Math.min(worst[k] ?? 99, x);
    }
    return worst;
  });
  await page.tap('#back'); await page.waitForTimeout(450);
  for (const theme of ['jewel', 'noir', 'neon', 'aurora', 'sunset', 'light']) {
    await page.tap('#open-settings'); await page.waitForTimeout(350);
    await page.check('#theme-' + theme, { force: true });
    assert.equal(await page.getAttribute('html', 'data-theme'), theme);
    assert.ok(await inView(page, '#settings-close'));
    await page.tap('#settings-close'); await page.waitForTimeout(350);
    for (const [name, value] of Object.entries(await pairs())) assert.ok(value >= (name === 'accentOnBg' ? 3 : 4.5), `${theme}: ${name} contrast ${value.toFixed(2)}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), theme + ': no sideways scroll');
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/theme-${theme}.png` });
  }
  await page.tap('#open-settings'); await page.waitForTimeout(300);
  await page.check('#theme-neon', { force: true });
  await page.check('#size-xl', { force: true });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), '20px');
  assert.ok(await inView(page, '#settings-close'), 'Done still reachable at the largest text size');
  await page.tap('#settings-close');
  await page.reload(); await page.waitForSelector('#open .row');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'neon');
  assert.equal(await page.getAttribute('html', 'data-size'), 'xl');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'largest text does not overflow sideways');
  await layoutChecks(page);
};

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
  await run('Small phone (320px), dark', { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } }, smallAndDark);
  await run('Phone, light theme contrast', { ...devices['Pixel 7'], theme: 'light' }, smallAndDark);
  await run('Paging between lists by swiping anywhere off a task', devices['iPhone 13'], pagingAndSound);
  await run('Gesture conflicts: tasks, edges, scrolling, pull-to-add, hold-to-drag', devices['iPhone 13'], gestureConflicts);
  await run('List swipes: left asks then deletes, right quick-adds', devices['Pixel 7'], listSwipes);
  await run('Only list cannot be deleted; keyboard equivalents', { viewport: { width: 1280, height: 800 } }, onlyListCannotGo);
  await run('Sound: silent until touched, switch off and on, persists', devices['iPhone 13'], soundRules);
  await run('Two-finger spread inserts a task; zoom, scroll and swipes unaffected', devices['iPhone 13'], spreadToInsertTask);
  await run('Lists screen: pull for top, tap empty space for end, spread for between', devices['Pixel 7'], listsScreenCreation);
  await run('Rising run, combo counter, trophies and finale unlocks', devices['iPhone 13'], runsAndRewards);
  await run('Pick one, move, search and Recently deleted', devices['Pixel 7'], searchMovePickBin);
  await run('Six themes keep contrast; text size; persistence', { ...devices['iPhone 13'], viewport: { width: 375, height: 667 } }, themesAndTextSize);
  await run('Settings sheet on iPhone SE (375x667)', { ...devices['iPhone 13'], viewport: { width: 375, height: 667 } }, settingsSheet(false));
  await run('Settings sheet on a very small phone (320x568)', { ...devices['iPhone 13'], viewport: { width: 320, height: 568 } }, settingsSheet(false));
  await run('Sheets with the keyboard open (390x360 visible)', devices['iPhone 13'], shrinkLikeKeyboard);
  await run('Single-file preview bundle', devices['iPhone 13'], previewBundle, '/preview');
  if (!process.env.ONLY || /account|sync/i.test(process.env.ONLY)) await accountFlows();
  running.server.close(); previewServer.close();
  for (const r of results) console.log(r.join('  '));
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})();
