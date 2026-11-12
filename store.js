// =============================================================
//  通信レイヤー
//  - Firebase Realtime Database（本番）
//  - ローカルテストモード（localStorage + BroadcastChannel）
//  どちらも同じインターフェースを返すので、app.js は違いを意識しない。
// =============================================================
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.14.1';

export const isLocalMode =
  !firebaseConfig || !firebaseConfig.databaseURL ||
  new URLSearchParams(location.search).has('local');

export async function createStore() {
  return isLocalMode ? createLocalStore() : createFirebaseStore();
}

// ---------------- Firebase ----------------
async function createFirebaseStore() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const F = await import(`${base}/firebase-database.js`);
  const app = initializeApp(firebaseConfig);
  const db = F.getDatabase(app);
  const ref = (p) => F.ref(db, p);

  return {
    async get(p) { return (await F.get(ref(p))).val(); },
    set(p, v) { return F.set(ref(p), v); },
    update(p, obj) { return F.update(ref(p), obj); },
    remove(p) { return F.remove(ref(p)); },
    on(p, cb) { return F.onValue(ref(p), (s) => cb(s.val())); },

    // 接続中は online=true、切断されたら自動で false にする
    presence(p) {
      const r = ref(p);
      const off = F.onValue(ref('.info/connected'), (s) => {
        if (s.val() === true) {
          F.onDisconnect(r).set(false).then(() => F.set(r, true));
        }
      });
      return () => { off(); F.onDisconnect(r).cancel(); };
    },

    onConnection(cb) {
      return F.onValue(ref('.info/connected'), (s) => cb(s.val() === true));
    },
  };
}

// ---------------- Local (テスト用) ----------------
function createLocalStore() {
  const KEY = 'tieryomi.localdb';
  const bc = new BroadcastChannel('tieryomi-local');
  const listeners = new Set();

  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const keys = (p) => p.split('/').filter(Boolean);
  const getAt = (t, p) => keys(p).reduce((o, k) => (o == null ? undefined : o[k]), t);
  const setAt = (t, p, v) => {
    const ks = keys(p);
    if (!ks.length) return v == null ? {} : clone(v);
    let o = t;
    for (let i = 0; i < ks.length - 1; i++) {
      if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {};
      o = o[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (v === null || v === undefined) delete o[last]; else o[last] = clone(v);
    return t;
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));

  function notify() {
    const t = read();
    for (const l of listeners) {
      const v = getAt(t, l.path);
      const s = JSON.stringify(v ?? null);
      if (s !== l.last) { l.last = s; l.cb(JSON.parse(s)); }
    }
  }
  const write = (t) => { localStorage.setItem(KEY, JSON.stringify(t)); bc.postMessage(1); notify(); };
  bc.onmessage = () => notify();
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });

  return {
    async get(p) { const v = getAt(read(), p); return v == null ? null : clone(v); },
    async set(p, v) { write(setAt(read(), p, v)); },
    async update(p, obj) {
      let t = read();
      for (const [k, v] of Object.entries(obj)) t = setAt(t, `${p}/${k}`, v);
      write(t);
    },
    async remove(p) { write(setAt(read(), p, null)); },
    on(p, cb) {
      const l = { path: p, cb, last: undefined };
      listeners.add(l);
      setTimeout(notify, 0);
      return () => listeners.delete(l);
    },
    presence(p) {
      const exists = () => getAt(read(), p.split('/').slice(0, -1).join('/')) != null;
      const on = () => { if (exists()) write(setAt(read(), p, true)); };
      const off = () => { if (exists()) write(setAt(read(), p, false)); };
      on();
      window.addEventListener('pagehide', off);
      window.addEventListener('pageshow', on);
      return () => { window.removeEventListener('pagehide', off); window.removeEventListener('pageshow', on); };
    },
    onConnection(cb) { cb(true); return () => {}; },
  };
}
