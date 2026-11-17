// Talks to the MCP endpoint with the official MCP client library, including its own OAuth
// discovery, registration, PKCE and token exchange. This is the closest check available
// here to "a real assistant connects"; it is not a test of ChatGPT itself.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { startServer } from '../server/node.js';

let running, base, cookie;
before(async () => {
  running = await startServer({ port: 0, setupCode: 'sdk-test-code', passwordIterations: 1000 });
  base = running.url;
  const res = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-quiet': '1' }, body: JSON.stringify({ username: 'sdk-owner', password: 'correct horse battery', setupCode: 'sdk-test-code' }) });
  cookie = res.headers.getSetCookie()[0].split(';')[0];
});
after(() => { running.server.close(); running.db.close(); });

test('official MCP client: discovers OAuth, registers, gets consent, then uses every tool', async () => {
  // The library drives the flow; this object is the "assistant" side's storage and browser hand-off.
  let client_info, tokens, verifier, authorizeUrl;
  const provider = {
    redirectUrl: 'http://127.0.0.1:9/callback',
    clientMetadata: { client_name: 'SDK Assistant', redirect_uris: ['http://127.0.0.1:9/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    clientInformation: () => client_info, saveClientInformation: info => { client_info = info; },
    tokens: () => tokens, saveTokens: t => { tokens = t; },
    codeVerifier: () => verifier, saveCodeVerifier: v => { verifier = v; },
    redirectToAuthorization: url => { authorizeUrl = url; },
  };
  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { authProvider: provider });
    const client = new Client({ name: 'sdk-test', version: '1.0.0' });
    return { transport, client, done: client.connect(transport) };
  };

  const first = await connect();
  await assert.rejects(first.done, UnauthorizedError);            // no token yet: the library was sent to the consent page
  assert.ok(authorizeUrl, 'library built an authorization URL from the server metadata');
  assert.equal(authorizeUrl.origin, base);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');

  // The owner, signed in on their own browser, approves on the consent page.
  const consent = await (await fetch(authorizeUrl, { headers: { cookie } })).text();
  const csrf = consent.match(/name="csrf" value="([0-9a-f]+)"/)[1];
  const fields = new URLSearchParams(authorizeUrl.searchParams);
  fields.set('csrf', csrf); fields.set('decision', 'allow'); fields.set('allow_write', '1');
  const approved = await fetch(base + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie }, body: fields });
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  await first.transport.finishAuth(code);                          // library exchanges the code with its PKCE verifier
  assert.ok(tokens.access_token && tokens.refresh_token);

  const { client, done } = await connect();
  await done;
  assert.equal(client.getServerVersion().name, 'quiet-list');
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['list_lists', 'get_list', 'add_task', 'edit_task', 'complete_task']);

  const lists = (await client.callTool({ name: 'list_lists', arguments: {} })).structuredContent.lists;
  const listId = lists[0].id;
  const added = (await client.callTool({ name: 'add_task', arguments: { list_id: listId, text: 'Try the noodle place' } })).structuredContent.added;
  await client.callTool({ name: 'edit_task', arguments: { list_id: listId, task_id: added.id, text: 'Try the noodle place by the station' } });
  const open = (await client.callTool({ name: 'get_list', arguments: { list_id: listId } })).structuredContent.tasks;
  assert.deepEqual(open.map(t => t.text), ['Try the noodle place by the station']);
  await client.callTool({ name: 'complete_task', arguments: { list_id: listId, task_id: added.id } });
  assert.deepEqual((await client.callTool({ name: 'get_list', arguments: { list_id: listId } })).structuredContent.tasks, []);
  const refused = await client.callTool({ name: 'add_task', arguments: { list_id: 'not-a-list', text: 'x' } });
  assert.equal(refused.isError, true);
  await client.close();
});
