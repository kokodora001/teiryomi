// =============================================================
//  共通ユーティリティ（ゲーム選択・絵描き人狼で使用）
// =============================================================
import { isLocalMode } from './store.js';

// ---------- 誤選択の防止 ----------
// スマホで長押ししたり、お絵描き中に指がはみ出したりすると、ブラウザが「文字選択」と判断して
// 画面全体が青く選択されることがある。入力欄以外では選択・長押しメニューを止め、
// もし選択されてしまっても次に触れたときに解除する。（このファイルを読み込む全ページに効く）
const isEditable = (el) => !!el?.closest?.('input, textarea, [contenteditable="true"]');
document.addEventListener('selectstart', (e) => { if (!isEditable(e.target)) e.preventDefault(); });
document.addEventListener('contextmenu', (e) => { if (!isEditable(e.target)) e.preventDefault(); });
document.addEventListener('dragstart', (e) => { if (!isEditable(e.target)) e.preventDefault(); });
document.addEventListener('pointerdown', (e) => {
  if (isEditable(e.target)) return;
  const sel = window.getSelection?.();
  if (sel && sel.rangeCount && !isEditable(document.activeElement)) sel.removeAllRanges();
}, true);

export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const GAMES = {
  lobby: { page: 'index.html', name: 'ロビー' },
  tier: { page: 'tier.html', name: 'ティアよみ' },
  ekaki: { page: 'ekaki.html', name: '絵描き人狼' },
  eshiri: { page: 'eshiri.html', name: 'えしりとり' },
  dots: { page: 'dots.html', name: 'ドット＆ボックス' },
  dengon: { page: 'dengon.html', name: 'お絵かき伝言' },
  jintori: { page: 'jintori.html', name: '同時陣取り' },
  fruit: { page: 'fruit.html', name: 'フルーツまぜまぜ' },
  sudoku: { page: 'sudoku.html', name: 'ナンプレバトル' },
  uno: { page: 'uno.html', name: 'ラストワン' },
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const firstChar = (s) => [...(s || '?')][0];

export function toast(msg) {
  const t = document.getElementById('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
export function genCode() {
  let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export function getPid() {
  let p = sessionStorage.getItem('tieryomi.pid');
  if (!p) { p = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); sessionStorage.setItem('tieryomi.pid', p); }
  return p;
}
// 名前はタブごとに覚える（同じブラウザで複数タブを開いても混ざらない）。新しいタブでは前回の名前を初期値に
export const getName = () => sessionStorage.getItem('tieryomi.name') || localStorage.getItem('tieryomi.name') || '';
export const saveName = (n) => { sessionStorage.setItem('tieryomi.name', n); localStorage.setItem('tieryomi.name', n); };

const keepLocal = () => isLocalMode && new URLSearchParams(location.search).has('local');

// ゲームのページURL（部屋コード付き）
export function pageUrl(page, code) {
  const u = new URL(page, location.href);
  u.search = ''; u.hash = '';
  if (keepLocal()) u.searchParams.set('local', '1');
  if (code) u.searchParams.set('room', code);
  return u.toString();
}
export const hubUrl = () => pageUrl('index.html');

export function setUrlRoom(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}

export function localBanner() {
  return isLocalMode ? `<div class="local-banner">🧪 ローカルテストモード — 同じブラウザで別タブを開いて参加すると、1人で動作確認できます</div>` : '';
}

export function avatar(p, size = '') {
  return `<span class="avatar ${size} ${p.online === false ? 'off' : ''}" style="--pc:${p.color || '#888'}">${esc(firstChar(p.name))}</span>`;
}

export function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

export function confetti(count = 100, colors = ['#ff5a6e', '#ff9f45', '#ffd84d', '#6fdc8c', '#5aa9ff', '#ffffff', '#b98bff']) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div'); layer.className = 'confetti';
  document.body.appendChild(layer);
  const W = innerWidth, H = innerHeight;
  for (let i = 0; i < count; i++) {
    const c = document.createElement('i');
    const size = 6 + Math.random() * 8;
    c.style.cssText = `left:${Math.random() * W}px;width:${size}px;height:${size * (0.4 + Math.random() * 0.8)}px;background:${colors[i % colors.length]};border-radius:${Math.random() < 0.3 ? '50%' : '2px'}`;
    layer.appendChild(c);
    const dx = (Math.random() - 0.5) * 240, rot = (Math.random() - 0.5) * 1080;
    c.animate([
      { transform: 'translate(0, -20px) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px, ${H + 40}px) rotate(${rot}deg)`, opacity: 0.9 },
    ], { duration: 1800 + Math.random() * 1800, delay: Math.random() * 500, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 4500);
}

// 部屋コードからゲームを調べてページへ移動
export async function gotoRoom(store, code) {
  const meta = await store.get(`rooms/${code}/meta`);
  if (!meta) return false;
  const g = GAMES[meta.game] || GAMES.tier; // game 未設定の古い部屋はティアよみ
  location.href = pageUrl(g.page, code);
  return true;
}

// ---------- 共通ロビー ----------
// どのページでも同じ部屋に入り直せるよう、タブごとに部屋コードを覚えておく
export const ROOM_KEY = 'asobiba.room';
export const MIN_PLAYERS = { tier: 2, ekaki: 3, eshiri: 3, dots: 2, dengon: 3, jintori: 2, fruit: 1, sudoku: 1, uno: 2 };

// 部屋に参加（すでにいれば名前とオンラインを更新）。palette があれば色を割り当て直す
export async function joinPlayer(store, code, pid, name, palette) {
  const players = (await store.get(`rooms/${code}/players`)) || {};
  const me = players[pid];
  const needColor = !!palette && (!me?.color || !palette.includes(me.color));
  let color = me?.color;
  if (needColor) {
    const used = Object.entries(players).filter(([id, p]) => id !== pid && p?.name).map(([, p]) => p.color);
    color = palette.find((c) => !used.includes(c)) || palette[Object.keys(players).length % palette.length];
  }
  const path = `rooms/${code}/players/${pid}`;
  if (!me || !me.name) await store.set(path, { name, joinedAt: Date.now(), online: true, ...(color ? { color } : {}) });
  else await store.update(path, { name, online: true, ...(needColor ? { color } : {}) });
}

// ゲームを切り替える（'lobby' でロビーに戻る）。メンバーはそのまま、得点や盤面はリセット
export async function switchGame(store, code, game, playerIds) {
  const upd = {
    meta: { game, createdAt: Date.now() },
    state: { phase: 'lobby', round: 0, game: 0 },
    rounds: null, games: null,
  };
  for (const id of playerIds) upd[`players/${id}/color`] = null; // 色は各ゲームで割り当て直す
  await store.update(`rooms/${code}`, upd);
}

// 部屋のゲームが自分のページと違ったら、そのゲームのページへ移動する
export function followRoom(room, game, code) {
  const g = room?.meta?.game || 'tier';
  if (g === game) return false;
  sessionStorage.setItem(ROOM_KEY, code);
  location.replace(pageUrl((GAMES[g] || GAMES.lobby).page, code));
  return true;
}

export const changeGameBtn = () => '<button class="btn ghost wide change-game" data-action="change-game">🎮 ゲームを変える（みんなでロビーへ）</button>';
