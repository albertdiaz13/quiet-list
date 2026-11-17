// Renders the app icon set from one original SVG drawing. Needs Playwright with Chromium.
//   node tools/build-icons.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const out = path.join(__dirname, '..', 'dist', 'icons');

// The mark: a heavy ring whose tail is a tick ("Q" + "done"), lit like polished metal on a jewel ground.
// `inset` shrinks the mark for maskable icons, whose outer 10% may be cropped by the phone.
const art = (size, { radius = 0, inset = 0 } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="ground" cx="28%" cy="18%" r="105%">
      <stop offset="0" stop-color="#6a3fd0"/><stop offset=".42" stop-color="#2c1668"/><stop offset="1" stop-color="#0c061d"/>
    </radialGradient>
    <radialGradient id="ember" cx="88%" cy="96%" r="70%">
      <stop offset="0" stop-color="#ff5fa2" stop-opacity=".55"/><stop offset="1" stop-color="#ff5fa2" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="metal" x1="18%" y1="8%" x2="86%" y2="96%">
      <stop offset="0" stop-color="#fff6e0"/><stop offset=".38" stop-color="#ffd27a"/><stop offset=".72" stop-color="#ff9f6b"/><stop offset="1" stop-color="#ff6fae"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <filter id="depth" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#05020f" flood-opacity=".6"/>
    </filter>
    <clipPath id="shape"><rect width="512" height="512" rx="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#shape)">
    <rect width="512" height="512" fill="url(#ground)"/>
    <rect width="512" height="512" fill="url(#ember)"/>
    <rect width="512" height="256" fill="url(#sheen)"/>
    <g transform="translate(256 256) scale(${1 - inset}) translate(-256 -256)">
      <g filter="url(#depth)" fill="none" stroke="url(#metal)" stroke-width="58" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="232" cy="238" r="124"/>
        <path d="M236 300 L300 374 L424 214"/>
      </g>
      <g fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="7" stroke-linecap="round">
        <path d="M134 196 A106 106 0 0 1 250 130"/>
      </g>
    </g>
  </g>
</svg>`;

(async () => {
  const browser = await chromium.launch();
  const render = async (name, size, options) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<body style="margin:0;background:transparent">${art(size, options)}</body>`);
    await page.screenshot({ path: path.join(out, name), omitBackground: true });
    await page.close();
  };
  await render('icon-192.png', 192, { radius: 116 });
  await render('icon-512.png', 512, { radius: 116 });
  await render('maskable-512.png', 512, { inset: 0.2 });       // full bleed; the phone applies its own shape
  await render('apple-touch-icon.png', 180, { inset: 0.06 });  // iOS rounds the corners itself
  fs.writeFileSync(path.join(out, 'icon.svg'), art(512, { radius: 116 }).trim() + '\n');
  await browser.close();
  console.log('icons written to dist/icons');
})();
