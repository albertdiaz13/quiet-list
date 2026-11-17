// Browser tests for the primary flows. Needs Playwright with Chromium available to `require`.
// Touch is driven through real touch events (Chrome DevTools Protocol), not synthetic clicks.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/preview') {            // the single-file preview, wrapped the way a host page would wrap it
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>'
      + fs.readFileSync(path.join(root, 'preview/quiet-list.html'), 'utf8') + '</body></html>');
  }
  const file = path.join(root, 'dist', url === '/' ? 'index.html' : url);
  if (!file.startsWith(path.join(root, 'dist')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

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
    await page.goto(base + url);
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
  const unnamed = await page.$$eval('button, input, textarea', nodes => nodes.filter(n => n.type !== 'file'
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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await run('iPhone 13 size, touch flows', devices['iPhone 13'], touchFlows);
  await run('Pixel 7 size, touch flows', devices['Pixel 7'], touchFlows);
  await run('Desktop, keyboard and mouse flows', { viewport: { width: 1280, height: 800 } }, keyboardFlows);
  await run('Reduced motion', { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' }, reducedMotion);
  await run('Small phone (320px), dark', { ...devices['iPhone SE'], viewport: { width: 320, height: 568 }, colorScheme: 'dark' }, smallAndDark);
  await run('Phone, light contrast', devices['Pixel 7'], smallAndDark);
  await run('Single-file preview bundle', devices['iPhone 13'], previewBundle, '/preview');
  server.close();
  for (const r of results) console.log(r.join('  '));
  process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
})();
