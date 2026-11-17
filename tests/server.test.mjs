// Server tests: accounts, owner isolation, sync, OAuth, and the MCP endpoint.
// Uses a real HTTP server with an in-memory database and invented sample data only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../server/node.js';

let base, running;
const SETUP = 'test-setup-code-not-a-real-secret';
before(async () => { running = await startServer({ port: 0, setupCode: SETUP, passwordIterations: 1000 }); base = running.url; });
after(() => { running.server.close(); running.db.close(); });

const b64url = buffer => buffer.toString('base64url');
class Browser {            // a minimal cookie-keeping client, standing in for one device
  cookie = '';
  async call(method, path, body, headers = {}) {
    const res = await fetch(base + path, { method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-quiet': '1' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set[0].split(';')[0].endsWith('=') ? '' : set[0].split(';')[0];
    return res;
  }
  async json(method, path, body, headers) { const res = await this.call(method, path, body, headers); return { status: res.status, body: res.status === 304 ? null : await res.json(), headers: res.headers }; }
  async form(path, fields) {
    return fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: new URLSearchParams(fields) });
  }
}
async function account(name) {
  const device = new Browser();
  const res = await device.json('POST', '/api/signup', { username: name, password: 'correct horse battery', setupCode: SETUP });
  assert.equal(res.status, 201);
  return device;
}
const op = change => ({ opId: randomUUID(), op: change });
async function firstList(device) { return (await device.json('GET', '/api/state')).body.doc.lists[0]; }

// Walks the OAuth flow the way an assistant would, and returns its tokens.
async function connect(device, { allowWrite = true, redirectUri = 'https://assistant.example/callback' } = {}) {
  const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Assistant', redirect_uris: [redirectUri] }) })).json();
  const verifier = b64url(randomBytes(32));
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 'xyz', scope: 'lists:read lists:write', resource: base + '/mcp' };
  const consent = await device.call('GET', '/oauth/authorize?' + new URLSearchParams(params));
  const html = await consent.text();
  const csrf = html.match(/name="csrf" value="([0-9a-f]+)"/)?.[1];
  const decided = await device.form('/oauth/authorize', { ...params, csrf, decision: 'allow', ...(allowWrite ? { allow_write: '1' } : {}) });
  const back = new URL(decided.headers.get('location'));
  const code = back.searchParams.get('code');
  const token = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier }) });
  return { reg, verifier, params, code, back, html, csrf, tokens: await token.json(), tokenStatus: token.status };
}
let rpcId = 0;
async function mcp(token, method, params) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: res.status, headers: res.headers, body: res.status === 200 ? await res.json() : null };
}
const tool = async (token, name, args = {}) => (await mcp(token, 'tools/call', { name, arguments: args })).body.result;

test('sign-up needs the setup code and a real password; sign-in works; secrets are not echoed', async () => {
  const d = new Browser();
  assert.equal((await d.json('POST', '/api/signup', { username: 'sam', password: 'correct horse battery', setupCode: 'wrong' })).status, 403);
  assert.equal((await d.json('POST', '/api/signup', { username: 'sam', password: 'short', setupCode: SETUP })).status, 400);
  const made = await d.json('POST', '/api/signup', { username: 'Sam', password: 'correct horse battery', setupCode: SETUP });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body, { user: { username: 'sam' } });
  assert.match(made.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  assert.equal((await d.json('POST', '/api/signup', { username: 'sam', password: 'correct horse battery', setupCode: SETUP })).status, 409);
  const other = new Browser();
  assert.equal((await other.json('GET', '/api/state')).status, 401);
  assert.equal((await other.json('POST', '/api/login', { username: 'sam', password: 'wrong wrong wrong' })).status, 401);
  assert.equal((await other.json('POST', '/api/login', { username: 'nobody', password: 'wrong wrong wrong' })).status, 401);
  assert.equal((await other.json('POST', '/api/login', { username: 'sam', password: 'correct horse battery' })).status, 200);
  assert.equal((await other.json('GET', '/api/session')).body.user.username, 'sam');
  const stored = await running.db.get('SELECT * FROM users WHERE username = ?', 'sam');
  assert.ok(!JSON.stringify(stored).includes('correct horse'));
  const session = await running.db.get('SELECT token_hash FROM sessions LIMIT 1');
  assert.ok(!other.cookie.includes(session.token_hash), 'only a hash of the session token is stored');
  await other.json('POST', '/api/logout');
  assert.equal((await other.json('GET', '/api/state')).status, 401);
});

test('repeated wrong passwords are locked out', async () => {
  await account('locky');
  const d = new Browser();
  for (let i = 0; i < 8; i++) assert.equal((await d.json('POST', '/api/login', { username: 'locky', password: 'nope nope nope' })).status, 401);
  assert.equal((await d.json('POST', '/api/login', { username: 'locky', password: 'correct horse battery' })).status, 429);
  await running.db.run('DELETE FROM throttle');
});

test('two devices on one account see each other\'s changes; retries do not duplicate', async () => {
  const phone = await account('twodev');
  const tablet = new Browser();
  await tablet.json('POST', '/api/login', { username: 'twodev', password: 'correct horse battery' });
  const list = await firstList(phone);
  const itemId = randomUUID();
  const add = op({ type: 'add_item', listId: list.id, id: itemId, text: 'Buy stamps', top: true });
  const first = await phone.json('POST', '/api/ops', { ops: [add] });
  assert.equal(first.body.results[0].ok, true);
  const again = await phone.json('POST', '/api/ops', { ops: [add] });           // the same change, re-sent
  assert.equal(again.body.results[0].repeat, true);
  assert.equal(again.body.version, first.body.version);
  const seen = await tablet.json('GET', '/api/state');
  assert.deepEqual(seen.body.doc.lists[0].tasks.map(t => t.text), ['Buy stamps']);
  assert.equal((await tablet.json('GET', '/api/state', undefined, { 'if-none-match': `"${seen.body.version}"` })).status, 304);
  await tablet.json('POST', '/api/ops', { ops: [op({ type: 'update_item', listId: list.id, itemId, done: true })] });
  assert.equal((await phone.json('GET', '/api/state')).body.doc.lists[0].tasks[0].done, true);
  // a bad change is refused on its own and does not block the good one beside it
  const mixed = await phone.json('POST', '/api/ops', { ops: [op({ type: 'add_item', listId: 'nope', id: randomUUID(), text: 'x' }), op({ type: 'drop_everything' }), op({ type: 'add_item', listId: list.id, id: randomUUID(), text: '<b>kept as text</b>' })] });
  assert.deepEqual(mixed.body.results.map(r => r.ok), [false, false, true]);
});

test('one account can never read or change another account\'s lists', async () => {
  const ana = await account('ana'), ben = await account('ben');
  const anaList = await firstList(ana);
  const secretId = randomUUID();
  await ana.json('POST', '/api/ops', { ops: [op({ type: 'add_item', listId: anaList.id, id: secretId, text: 'Ana only' })] });
  // Ben tries Ana's ids through every door he has
  const tries = await ben.json('POST', '/api/ops', { ops: [
    op({ type: 'add_item', listId: anaList.id, id: randomUUID(), text: 'intruder' }),
    op({ type: 'update_item', listId: anaList.id, itemId: secretId, text: 'changed' }),
    op({ type: 'delete_item', listId: anaList.id, itemId: secretId }),
    op({ type: 'delete_list', listId: anaList.id }),
  ] });
  assert.ok(tries.body.results.every(r => !r.ok));
  assert.ok(!JSON.stringify((await ben.json('GET', '/api/state')).body).includes('Ana only'));
  const benTokens = (await connect(ben)).tokens;
  assert.ok(!JSON.stringify(await tool(benTokens.access_token, 'list_lists')).includes(anaList.id));
  assert.equal((await tool(benTokens.access_token, 'get_list', { list_id: anaList.id })).isError, true);
  assert.equal((await tool(benTokens.access_token, 'add_task', { list_id: anaList.id, text: 'intruder' })).isError, true);
  assert.equal((await tool(benTokens.access_token, 'complete_task', { list_id: anaList.id, task_id: secretId })).isError, true);
  assert.deepEqual((await ana.json('GET', '/api/state')).body.doc.lists[0].tasks.map(t => [t.text, t.done]), [['Ana only', false]]);
});

test('browser API refuses cross-site and unmarked requests', async () => {
  const d = await account('csrf');
  const list = await firstList(d);
  const body = { ops: [op({ type: 'add_item', listId: list.id, id: randomUUID(), text: 'x' })] };
  assert.equal((await d.call('POST', '/api/ops', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await d.call('POST', '/api/ops', body, { 'x-quiet': '' })).status, 403);
  const formPost = await fetch(base + '/api/ops', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-quiet': '1', cookie: d.cookie }, body: JSON.stringify(body) });
  assert.equal(formPost.status, 415);
  assert.equal((await firstList(d)).tasks.length, 0);
  const res = await d.call('GET', '/api/session');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('MCP endpoint demands a token and advertises how to get one', async () => {
  const none = await mcp(null, 'tools/list');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Bearer resource_metadata=".+\/\.well-known\/oauth-protected-resource"/);
  assert.equal((await mcp('made-up-token', 'tools/list')).status, 401);
  const resource = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, base + '/mcp');
  const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.equal(meta.issuer, resource.authorization_servers[0]);
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.ok(meta.registration_endpoint && meta.token_endpoint && meta.authorization_endpoint);
});

test('assistant flow: connect, list, add, edit, complete; the phone sees it', async () => {
  const phone = await account('assist');
  const list = await firstList(phone);
  await phone.json('POST', '/api/ops', { ops: [op({ type: 'add_item', listId: list.id, id: randomUUID(), text: 'Label the spice jars' })] });
  const flow = await connect(phone);
  assert.equal(flow.tokenStatus, 200);
  assert.match(flow.html, /Connect Test Assistant\?/);
  assert.equal(flow.back.searchParams.get('state'), 'xyz');
  const t = flow.tokens.access_token;

  const init = await mcp(t, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  const tools = (await mcp(t, 'tools/list')).body.result.tools;
  assert.deepEqual(tools.map(x => x.name), ['list_lists', 'get_list', 'add_task', 'edit_task', 'complete_task']);
  assert.ok(tools.every(x => x.inputSchema.additionalProperties === false && !('scope' in x)));

  const lists = (await tool(t, 'list_lists')).structuredContent.lists;
  assert.deepEqual(lists.map(l => [l.name, l.open]), [['Brain dump', 1]]);
  const added = (await tool(t, 'add_task', { list_id: list.id, text: 'Book the bike tune-up' })).structuredContent.added;
  const edited = (await tool(t, 'edit_task', { list_id: list.id, task_id: added.id, text: 'Book the bike tune-up for spring' })).structuredContent.updated;
  assert.equal(edited.text, 'Book the bike tune-up for spring');
  assert.equal((await tool(t, 'complete_task', { list_id: list.id, task_id: added.id })).structuredContent.updated.done, true);
  assert.deepEqual((await tool(t, 'get_list', { list_id: list.id })).structuredContent.tasks.map(x => x.text), ['Label the spice jars']);
  assert.equal((await tool(t, 'get_list', { list_id: list.id, include_done: true })).structuredContent.tasks.length, 2);

  const onPhone = (await phone.json('GET', '/api/state')).body.doc.lists[0].tasks;
  assert.deepEqual(onPhone.map(x => [x.text, x.done]), [['Book the bike tune-up for spring', true], ['Label the spice jars', false]]);

  // narrow by design: no delete or list-management tools, strict arguments
  assert.equal((await mcp(t, 'tools/call', { name: 'delete_task', arguments: {} })).body.error.code, -32602);
  assert.equal((await tool(t, 'add_task', { list_id: list.id, text: 'x', extra: 1 })).isError, true);
  assert.equal((await tool(t, 'add_task', { list_id: list.id, text: '' })).isError, true);
  assert.equal((await tool(t, 'add_task', { list_id: list.id, text: 'a'.repeat(2001) })).isError, true);
  assert.equal((await mcp(t, 'resources/list')).body.error.code, -32601);

  // the owner can see and revoke the connection; the token dies at once
  const connections = (await phone.json('GET', '/api/connections')).body.connections;
  assert.deepEqual(connections.map(c => [c.name, c.canWrite, c.site]), [['Test Assistant', true, 'assistant.example']]);
  await phone.call('DELETE', '/api/connections/' + connections[0].id);
  assert.equal((await mcp(t, 'tools/list')).status, 401);
  const refresh = await fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token, client_id: flow.reg.client_id }) });
  assert.equal(refresh.status, 400);
});

test('read-only approval cannot write', async () => {
  const phone = await account('readonly');
  const list = await firstList(phone);
  const { tokens } = await connect(phone, { allowWrite: false });
  assert.equal(tokens.scope, 'lists:read');
  assert.equal((await tool(tokens.access_token, 'list_lists')).isError, false);
  assert.equal((await tool(tokens.access_token, 'add_task', { list_id: list.id, text: 'nope' })).isError, true);
  assert.equal((await firstList(phone)).tasks.length, 0);
});

test('OAuth refuses the usual attacks', async () => {
  const phone = await account('oauth');
  const flow = await connect(phone);
  const tokenCall = fields => fetch(base + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  // a code works once
  assert.equal((await tokenCall({ grant_type: 'authorization_code', code: flow.code, client_id: flow.reg.client_id, redirect_uri: flow.params.redirect_uri, code_verifier: flow.verifier })).status, 400);
  // wrong PKCE verifier
  const second = await connectUntilCode(phone);
  assert.equal((await tokenCall({ ...second.exchange, code_verifier: b64url(randomBytes(32)) })).status, 400);
  assert.equal((await tokenCall(second.exchange)).status, 400, 'and the code is burnt after a failed try');
  // refresh tokens rotate
  const fresh = await tokenCall({ grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token, client_id: flow.reg.client_id });
  assert.equal(fresh.status, 200);
  assert.equal((await tokenCall({ grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token, client_id: flow.reg.client_id })).status, 400);
  assert.equal((await mcp((await fresh.json()).access_token, 'ping')).status, 200);
  // unregistered return address is shown as an error, never redirected to
  const bad = await phone.call('GET', '/oauth/authorize?' + new URLSearchParams({ ...flow.params, redirect_uri: 'https://evil.example/steal' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('location'), null);
  // PKCE is mandatory; plain is refused
  const noPkce = await phone.call('GET', '/oauth/authorize?' + new URLSearchParams({ ...flow.params, code_challenge_method: 'plain' }));
  assert.match(noPkce.headers.get('location'), /error=invalid_request/);
  // consent cannot be forged without the per-session token, or from another site
  assert.equal((await phone.form('/oauth/authorize', { ...flow.params, csrf: 'forged', decision: 'allow' })).status, 403);
  const crossSite = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example', cookie: phone.cookie }, body: new URLSearchParams({ ...flow.params, csrf: flow.csrf, decision: 'allow' }) });
  assert.equal(crossSite.status, 403);
  // signed-out visitors get a sign-in page, not a consent page
  const anon = await new Browser().call('GET', '/oauth/authorize?' + new URLSearchParams(flow.params));
  const anonHtml = await anon.text();
  assert.match(anonHtml, /Sign in to Quiet List/);
  assert.doesNotMatch(anonHtml, /name="csrf"/);
  // registration only accepts https (or localhost) return addresses
  for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://ok.example/cb#frag']) {
    const res = await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) });
    assert.equal(res.status, 400, uri);
  }
  // app names are shown on the consent page as text
  const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: '<script>alert(1)</script>', redirect_uris: ['https://a.example/cb'] }) })).json();
  assert.ok(!reg.client_name.includes('<'));
  // an access token is not a session, and a session is not an access token
  assert.equal((await fetch(base + '/api/state', { headers: { authorization: `Bearer ${flow.tokens.access_token}` } })).status, 401);
  assert.equal((await mcp(phone.cookie.split('=')[1], 'tools/list')).status, 401);
});
async function connectUntilCode(device) {
  const redirectUri = 'https://assistant.example/callback';
  const reg = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [redirectUri] }) })).json();
  const verifier = b64url(randomBytes(32));
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' };
  const html = await (await device.call('GET', '/oauth/authorize?' + new URLSearchParams(params))).text();
  const decided = await device.form('/oauth/authorize', { ...params, csrf: html.match(/name="csrf" value="([0-9a-f]+)"/)[1], decision: 'allow', allow_write: '1' });
  const code = new URL(decided.headers.get('location')).searchParams.get('code');
  return { exchange: { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier } };
}

test('static app is served with a strict policy; paths cannot escape', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/..%2fserver/app.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
});

test('the Cloudflare migration matches the schema the tests run on', async () => {
  const { readFile } = await import('node:fs/promises');
  const { SCHEMA } = await import('../server/app.js');
  const file = await readFile(new URL('../server/migrations/0001_init.sql', import.meta.url), 'utf8');
  assert.equal(file.split('\n').slice(1).join('\n').trim(), SCHEMA.trim());
});
