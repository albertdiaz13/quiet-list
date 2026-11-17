// Bundles dist/ into one self-contained HTML fragment for a private preview page.
// The fragment has no <html>/<head>/<body>; the preview host supplies them.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = name => readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
const stripModuleSyntax = source => source
  .replace(/^import\s[\s\S]*?from\s+'[^']+';\n/gm, '')
  .replace(/^export\s+/gm, '');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'));
const fonts = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&display=swap">';
const script = ['model.js', 'store.js', 'sync.js', 'sound.js', 'app.js'].map(read).map(stripModuleSyntax).join('\n')
  .replace('const STANDALONE = false;', 'const STANDALONE = true;');

const page = `<title>Quiet List</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${read('style.css').replace(/@font-face \{[\s\S]*?\}\n/, '')}</style>
${body.trim()}
<script type="module">
${script}</script>
`;
mkdirSync(new URL('../preview/', import.meta.url), { recursive: true });
writeFileSync(new URL('../preview/quiet-list.html', import.meta.url), page);
console.log(`preview/quiet-list.html ${(page.length / 1024).toFixed(1)} kB`);
