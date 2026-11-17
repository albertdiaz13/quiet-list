// End-to-end smoke check against an already-running copy (used for the local Cloudflare Workers
// runtime: `npx wrangler dev --local`). Creates a throwaway sample account.
//   BASE=http://127.0.0.1:8799 SETUP_CODE=... node tests/worker-smoke.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const base = process.env.BASE, setupCode = process.env.SETUP_CODE;
const name = 'smoke-' + randomBytes(4).toString('hex');
const password = 'correct horse battery';
const json = { 'content-type': 'application/json', 'x-quiet': '1' };
const cookieOf = res => res.headers.getSetCookie()[0].split(';')[0];

let res = await fetch(base + '/');
assert.equal(res.status, 200);
assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
for (const file of ['/app.js', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/fonts/bricolage-grotesque-latin.woff2']) assert.equal((await fetch(base + file)).status, 200, file);

res = await fetch(base + '/api/signup', { method: 'POST', headers: json, body: JSON.stringify({ username: name, password, setupCode }) });
assert.equal(res.status, 201);
const phone = cookieOf(res);
res = await fetch(base + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ username: name, password }) });
const tablet = cookieOf(res);
assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ username: name, password: 'wrong wrong wrong' }) })).status, 401);

const state = async cookie => (await fetch(base + '/api/state', { headers: { cookie } })).json();
const list = (await state(phone)).doc.lists[0];
const itemId = randomUUID();
res = await fetch(base + '/api/ops', { method: 'POST', headers: { ...json, cookie: phone }, body: JSON.stringify({ ops: [{ opId: randomUUID(), op: { type: 'add_item', listId: list.id, id: itemId, text: 'Buy stamps', top: true } }] }) });
assert.equal((await res.json()).results[0].ok, true);
assert.deepEqual((await state(tablet)).doc.lists[0].tasks.map(t => t.text), ['Buy stamps']);
assert.equal((await fetch(base + '/api/state')).status, 401);

assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
const redirectUri = 'https://assistant.example/callback';
const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Smoke Assistant', redirect_uris: [redirectUri] }) })).json();
const verifier = randomBytes(32).toString('base64url');
const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: base + '/mcp' };
const consent = await (await fetch(base + '/oauth/authorize?' + new URLSearchParams(params), { headers: { cookie: phone } })).text();
const csrf = consent.match(/name="csrf" value="([0-9a-f]+)"/)[1];
res = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(base).origin, cookie: phone }, body: new URLSearchParams({ ...params, csrf, decision: 'allow', allow_write: '1' }) });
const code = new URL(res.headers.get('location')).searchParams.get('code');
const tokens = await (await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier }) })).json();
const call = async (toolName, args) => (await (await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }) })).json()).result;
assert.equal((await call('list_lists', {})).structuredContent.lists[0].open, 1);
const added = (await call('add_task', { list_id: list.id, text: 'From the assistant' })).structuredContent.added;
await call('edit_task', { list_id: list.id, task_id: added.id, text: 'From the assistant, edited' });
await call('complete_task', { list_id: list.id, task_id: itemId });
assert.deepEqual((await state(tablet)).doc.lists[0].tasks.map(t => [t.text, t.done]), [['From the assistant, edited', false], ['Buy stamps', true]]);
const t0 = Date.now();
await fetch(base + '/api/login', { method: 'POST', headers: json, body: JSON.stringify({ username: name, password }) });
console.log(`smoke ok against ${base} (sign-in took ${Date.now() - t0} ms)`);
