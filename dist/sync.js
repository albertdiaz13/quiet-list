// Account mode: the server holds the lists; this keeps a copy on the device so the app
// opens instantly and keeps working offline.
//
//   shown lists = last server copy + changes not yet confirmed by the server
//
// Changes wait in a queue that survives reloads. Each carries its own id, so a retry after
// a dropped connection cannot apply twice. Nothing here touches the browser-local lists.
import { applyOp } from './model.js';

const CACHE_KEY = 'quiet-list-account';
const POLL_MS = 8000;

export async function api(method, path, body, headers = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-quiet': '1' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (response.status !== 304 && (response.headers.get('content-type') || '').includes('json')) {
    try { data = await response.json(); } catch { /* treated as no data */ }
  }
  return { status: response.status, ok: response.ok, data };
}

export function createAccountSync({ storage, onChange, onStatus }) {
  let username = null, base = null, version = 0, queue = [];
  let held = false, sending = false, online = true, signedOut = false, poll = 0, retry = 0;

  const persist = () => { try { storage.setItem(CACHE_KEY, JSON.stringify({ username, version, base, queue })); } catch { /* cache only */ } };
  const report = () => onStatus({ username, pending: queue.length, online, signedOut, sending });
  const active = () => !!username && !!base;

  function current() {
    const doc = structuredClone(base);
    for (const { op } of queue) { try { applyOp(doc, op); } catch { /* the server copy moved on; this change no longer applies */ } }
    return doc;
  }

  async function pull() {
    if (!username || sending || signedOut) return;
    try {
      const result = await api('GET', '/api/state', undefined, base ? { 'if-none-match': `"${version}"` } : {});
      online = true;
      if (result.status === 401) signedOut = true;
      else if (result.status === 200 && result.data?.doc && !sending && result.data.version >= version) {   // never step back to an older copy
        base = result.data.doc; version = result.data.version;
        persist(); onChange();
      }
    } catch { online = false; }
    report();
  }

  async function flush() {
    clearTimeout(retry);
    if (sending || held || !queue.length || !active() || signedOut) return;
    sending = true; report();
    const batch = queue.slice(0, 100);
    const sent = new Set(batch.map(entry => entry.opId));
    try {
      const result = await api('POST', '/api/ops', { ops: batch });
      online = true;
      if (result.status === 401) signedOut = true;
      else if (result.ok && result.data?.doc) {
        queue = queue.filter(entry => !sent.has(entry.opId));
        base = result.data.doc; version = result.data.version;
        persist(); onChange();
      } else if (result.status >= 400 && result.status < 500 && ![408, 409, 429].includes(result.status)) {
        queue = queue.filter(entry => !sent.has(entry.opId));   // the server will never accept these; do not wedge the queue
        persist(); onChange();
      }
    } catch { online = false; }
    sending = false; report();
    if (queue.length && !held && !signedOut) retry = setTimeout(flush, online ? 50 : 5000);
  }

  const wake = () => { if (document.visibilityState === 'visible') { flush(); pull(); } };
  function listen(on) {
    clearInterval(poll);
    const change = on ? addEventListener : removeEventListener;
    change('online', wake); change('focus', wake); document[on ? 'addEventListener' : 'removeEventListener']('visibilitychange', wake);
    if (on) poll = setInterval(() => { if (document.visibilityState === 'visible' && !queue.length) pull(); }, POLL_MS);
  }

  return {
    current, pull, flush,
    pending: () => queue.length,
    username: () => username,
    isSignedOut: () => signedOut,
    // Returns the cached username if this device already holds an account copy.
    resume() {
      try {
        const cached = JSON.parse(storage.getItem(CACHE_KEY));
        if (!cached?.username || !cached.base) return null;
        ({ username, version, base } = cached);
        queue = Array.isArray(cached.queue) ? cached.queue : [];
        return username;
      } catch { return null; }
    },
    // Starts syncing as `name`. A cached copy that belongs to someone else is discarded.
    async begin(name) {
      if (username !== name) { username = name; base = null; version = 0; queue = []; }
      signedOut = false;
      listen(true);
      await pull();
      if (base) flush();
      return active();
    },
    markSignedOut() { signedOut = true; report(); },
    record(ops) {
      for (const op of ops) queue.push({ opId: crypto.randomUUID(), op });
      persist(); report();
      clearTimeout(retry);
      retry = setTimeout(flush, 250);
    },
    mark: () => queue.length,
    rewind(length) { queue.length = Math.min(queue.length, length); persist(); report(); },
    // While an Undo offer is on screen nothing is sent, so undoing is just forgetting the change.
    hold(value) { held = value; if (!held) flush(); },
    stop({ forget = false } = {}) {
      listen(false); clearTimeout(retry);
      if (forget) { try { storage.removeItem(CACHE_KEY); } catch { /* nothing to clear */ } }
      username = null; base = null; queue = []; version = 0; signedOut = false; held = false;
    },
  };
}
