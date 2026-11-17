// Persistence boundary. The UI only ever talks to a store through load / save / watch,
// so a future owner-scoped remote store can replace this one without touching the views.
//
// This implementation keeps everything in one browser's localStorage: unencrypted,
// no account, no sync. It is not a backend and must not be described as one.

import { validate, sample, STORAGE_KEY } from './model.js';

export function createLocalStore(storage, key = STORAGE_KEY) {
  return {
    // Returns { state, problem }. A read failure never overwrites what is stored.
    load() {
      let raw = null;
      try {
        raw = storage.getItem(key);
        if (raw) return { state: validate(JSON.parse(raw)), problem: null };
        return { state: sample(), problem: null };
      } catch {
        // Set the unreadable copy aside so the next save cannot destroy it.
        try { if (raw) storage.setItem(key + '-unreadable', raw); } catch { /* nothing more we can do */ }
        return { state: sample(), problem: 'unreadable' };
      }
    },
    save(state) {
      try {
        storage.setItem(key, JSON.stringify(state));
        return true;
      } catch {
        return false;
      }
    },
    // Calls back with the new state when another tab of this browser saves.
    watch(onChange) {
      addEventListener('storage', event => {
        if (event.key !== key || !event.newValue) return;
        try { onChange(validate(JSON.parse(event.newValue))); } catch { /* ignore a bad write from elsewhere */ }
      });
    },
  };
}

export function safeStorage() {
  try {
    const probe = '__quiet_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const memory = new Map();
    return {
      getItem: k => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => { memory.set(k, String(v)); },
      removeItem: k => { memory.delete(k); },
      volatile: true,
    };
  }
}
