// =============================================================
//  フルーツまぜまぜ — 同じ果物をくっつけて大きくし、スイカを目指す落ち物パズル（対戦）
//  ・全員同時スタート。落ちてくる果物の順番は全員同じ（公平）
//  ・スイカを作った人がその場で勝ち → 全員終了
//  ・スイカが出ないまま全員ラインを越えたら終了 → スコア勝負
//  物理演算は Matter.js（matter.min.js を同梱, MIT License）
// =============================================================
import { createStore, isLocalMode } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';

const GAME = 'fruit';
const { Engine, Bodies, Body, Composite, Events } = window.Matter;

// ---------- 果物 ----------
export const FRUITS = [
  { name: 'さくらんぼ', r: 13, c: '#a3122e', c2: '#ff5c7a' },
  { name: 'いちご', r: 18, c: '#ff4d6d', c2: '#ff9aa9' },
  { name: 'ぶどう', r: 24, c: '#8e5bd6', c2: '#bf9bf0' },
  { name: 'みかん', r: 30, c: '#ff9f1c', c2: '#ffd08a' },
  { name: 'かき', r: 37, c: '#d9480f', c2: '#ff8c42' },
  { name: 'りんご', r: 45, c: '#e63946', c2: '#ff8a93' },
  { name: 'なし', r: 54, c: '#e3d26f', c2: '#fff3b0' },
  { name: 'もも', r: 63, c: '#ffa6c1', c2: '#ffe0ea' },
  { name: 'パイナップル', r: 73, c: '#f4c430', c2: '#ffe78a' },
  { name: 'メロン', r: 84, c: '#a5d86a', c2: '#e2f5c4' },
  { name: 'スイカ', r: 96, c: '#2f9e44', c2: '#7fd38f' },
];
const LAST = FRUITS.length - 1;
const DROP_KINDS = 5;                 // 落ちてくるのは小さい5種類
const W = 400, H = 560, LINE = 112, DROP_Y = 56;
const OVER_MS = 2500;                 // ラインを越えた状態がこれだけ続いたらゲームオーバー
const pointsFor = (lvl) => (lvl * (lvl + 1)) / 2; // 合体してできた果物のレベルで得点（1,3,6,10…）

// ---------- 乱数（全員同じ順番にするため、部屋ごとのシードから作る） ----------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const $app = document.getElementById('app');
const S = {
  store: null, pid: '', name: '', code: null, room: null, unsub: null, stopPresence: null, viewKey: '',
  tick: null, hostBusy: '', confettiDone: {}, G: null, raf: 0,
};

// ---------- 状態 ----------
const gk = (n) => 'g' + n;
const roomPath = () => `rooms/${S.code}`;
const gamePath = () => `rooms/${S.code}/games/${gk(stateOf().game)}`;
function playerList() {
  return Object.entries(S.room?.players || {})
    .filter(([, p]) => p && p.name).map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
const onlinePlayers = () => playerList().filter((p) => p.online);
const hostId = () => (onlinePlayers()[0] || playerList()[0] || {}).id;
const isHost = () => hostId() === S.pid;
function player(id) { const p = S.room?.players?.[id]; return p ? { id, ...p } : { id, name: '???', color: '#888', online: false }; }
const stateOf = () => S.room?.state || { phase: 'lobby', game: 0 };
const curGame = () => S.room?.games?.[gk(stateOf().game)] || null;
const settings = () => ({ limit: S.room?.meta?.limit ?? 0 });
const inGame = (g) => !!g?.order?.includes(S.pid);
const pdata = (g, id) => g?.ps?.[id] || {};
// 終わった人：ゲームオーバー／切断中／20秒以上更新がない（スマホが止まっている）
function finished(g, id, now) {
  const d = pdata(g, id);
  if (d.over) return true;
  if (!player(id).online) return true;
  if (!d.at) return now - (stateOf().startAt || now) > 30000; // 一度も送ってこない人
  return now - d.at > 20000;
}
function winsTotal() {
  const w = {};
  for (const g of Object.values(S.room?.games || {})) if (g?.winner) w[g.winner] = (w[g.winner] || 0) + 1;
  return w;
}

// ---------- 果物の絵 ----------
function drawFruit(ctx, x, y, r, lvl, ang = 0) {
  const f = FRUITS[lvl];
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  g.addColorStop(0, f.c2); g.addColorStop(1, f.c);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  // 模様
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.clip();
  if (lvl === 10) { // スイカのしま
    ctx.strokeStyle = '#1b5e2b'; ctx.lineWidth = r * 0.12;
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.42, -r); ctx.quadraticCurveTo(i * r * 0.42 + r * 0.18, 0, i * r * 0.42, r); ctx.stroke(); }
  } else if (lvl === 9) { // メロンの網目
    ctx.strokeStyle = '#ffffff99'; ctx.lineWidth = Math.max(1, r * 0.04);
    for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.3 - r, -r); ctx.lineTo(i * r * 0.3 + r, r); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i * r * 0.3 + r, -r); ctx.lineTo(i * r * 0.3 - r, r); ctx.stroke(); }
  } else if (lvl === 8) { // パイナップルのうろこ
    ctx.strokeStyle = '#c98a00'; ctx.lineWidth = Math.max(1, r * 0.05);
    for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * r * 0.35 - r, -r); ctx.lineTo(i * r * 0.35 + r, r); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i * r * 0.35 + r, -r); ctx.lineTo(i * r * 0.35 - r, r); ctx.stroke(); }
  } else if (lvl === 1) { // いちごのつぶ
    ctx.fillStyle = '#ffe08a';
    for (const [a, b] of [[-0.4, -0.1], [0.3, -0.2], [0, 0.3], [-0.3, 0.45], [0.45, 0.3], [0.05, -0.45]]) { ctx.beginPath(); ctx.ellipse(a * r, b * r, r * 0.06, r * 0.1, 0, 0, Math.PI * 2); ctx.fill(); }
  } else if (lvl === 3) { // みかんのつぶつぶ
    ctx.fillStyle = '#ffffff40';
    for (let i = 0; i < 14; i++) { const a = i * 2.4, d = r * (0.25 + (i % 4) * 0.17); ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.045, 0, Math.PI * 2); ctx.fill(); }
  } else if (lvl === 2) { // ぶどうのつぶ
    ctx.fillStyle = '#ffffff33';
    for (const [a, b] of [[-0.35, -0.3], [0.3, -0.3], [0, 0.1], [-0.35, 0.35], [0.35, 0.35]]) { ctx.beginPath(); ctx.arc(a * r, b * r, r * 0.3, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  // へた・葉っぱ
  if (lvl === 0) { // さくらんぼ：長い軸
    ctx.strokeStyle = '#5b3a1a'; ctx.lineWidth = Math.max(1.5, r * 0.14); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -r * 0.85); ctx.quadraticCurveTo(r * 0.15, -r * 1.6, r * 0.75, -r * 1.85); ctx.stroke();
    ctx.fillStyle = '#4caf50'; ctx.beginPath(); ctx.ellipse(r * 0.85, -r * 1.75, r * 0.38, r * 0.16, -0.4, 0, Math.PI * 2); ctx.fill();
  } else if (lvl === 1) { // いちご：ぎざぎざのへた
    ctx.fillStyle = '#2f9e44';
    for (const a of [-1.1, -0.55, 0, 0.55, 1.1]) { ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.ellipse(0, -r * 0.92, r * 0.13, r * 0.3, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  } else if (lvl === 4) { // かき：四角い大きなへた
    ctx.fillStyle = '#2b5d1e';
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) { ctx.save(); ctx.translate(0, -r * 0.82); ctx.rotate(a + Math.PI / 4); ctx.beginPath(); ctx.ellipse(r * 0.2, 0, r * 0.24, r * 0.12, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    ctx.fillStyle = '#3d2412'; ctx.fillRect(-r * 0.06, -r * 1.02, r * 0.12, r * 0.18);
  } else if (lvl !== 8) {
    ctx.fillStyle = lvl === 5 ? '#6b3b1c' : '#3a7d2c';
    ctx.fillRect(-r * 0.05, -r * 1.12, r * 0.1, r * 0.25);
    ctx.fillStyle = '#4caf50'; ctx.beginPath(); ctx.ellipse(r * 0.18, -r * 0.98, r * 0.2, r * 0.09, -0.5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = '#4caf50';
    for (const a of [-0.5, 0, 0.5]) { ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.ellipse(0, -r * 1.08, r * 0.1, r * 0.3, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  }
  // かお
  if (r >= 16) {
    ctx.fillStyle = '#2a1a1a';
    const e = r * 0.09;
    ctx.beginPath(); ctx.arc(-r * 0.28, -r * 0.05, e, 0, Math.PI * 2); ctx.arc(r * 0.28, -r * 0.05, e, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2a1a1a'; ctx.lineWidth = Math.max(1.2, r * 0.06); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, r * 0.12, r * 0.16, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.fillStyle = '#ff6b8a66'; ctx.beginPath(); ctx.arc(-r * 0.45, r * 0.12, r * 0.1, 0, Math.PI * 2); ctx.arc(r * 0.45, r * 0.12, r * 0.1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function fruitIcon(lvl, size = 28) {
  const c = document.createElement('canvas'), dpr = Math.min(devicePixelRatio || 1, 2);
  c.width = c.height = size * dpr;
  const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
  if (lvl === 0) drawFruit(ctx, size * 0.42, size * 0.66, size * 0.28, lvl); // 長い軸が入るように小さめ
  else drawFruit(ctx, size / 2, size / 2 + size * 0.06, size * 0.4, lvl);
  return c.toDataURL();
}
const ICONS = [];
const icon = (lvl, size = 28) => `<img class="fi" src="${(ICONS[lvl] ||= fruitIcon(lvl, 40))}" width="${size}" height="${size}" alt="${FRUITS[lvl].name}">`;

// ---------- 盤面の保存形式（相手に見せる・リロード復帰） ----------
const c2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1295).toString(36).padStart(2, '0');
const encSnap = (bodies) => bodies.map((b) => b.lvl.toString(16) + c2(b.position.x / W) + c2(b.position.y / H)).join('');
function decSnap(s) {
  const out = [];
  for (let i = 0; i + 5 <= (s || '').length; i += 5) out.push({ lvl: parseInt(s[i], 16), x: (parseInt(s.slice(i + 1, i + 3), 36) / 1295) * W, y: (parseInt(s.slice(i + 3, i + 5), 36) / 1295) * H });
  return out;
}

// =============================================================
//  ゲーム本体（自分の箱）
// =============================================================
function newLocalGame(seed, restore) {
  const engine = Engine.create({ positionIterations: 10, velocityIterations: 8 });
  engine.gravity.y = 1.15;
  const wall = { isStatic: true, friction: 0.3, restitution: 0.1 };
  Composite.add(engine.world, [
    Bodies.rectangle(W / 2, H + 30, W + 200, 60, wall),
    Bodies.rectangle(-30, H / 2, 60, H * 2, wall),
    Bodies.rectangle(W + 30, H / 2, 60, H * 2, wall),
  ]);
  const rng = mulberry32(seed);
  const draw = () => Math.floor(rng() * DROP_KINDS);
  const G = {
    engine, rng, draw, fruits: [], score: 0, best: 0, drops: 0, cur: draw(), next: draw(),
    dropX: W / 2, canDrop: true, over: false, danger: 0, fx: [], won: false, acc: 0, last: 0, sentAt: 0, dirty: true,
  };
  if (restore) { // リロード復帰：保存してある盤面と落とした回数から再現
    for (let i = 0; i < restore.drops; i++) { G.cur = G.next; G.next = draw(); }
    G.drops = restore.drops; G.score = restore.score || 0; G.best = restore.best || 0;
    for (const f of decSnap(restore.snap)) addFruit(G, f.x, f.y, f.lvl, true);
  }
  Events.on(engine, 'collisionStart', (e) => onCollide(G, e));
  Events.on(engine, 'collisionActive', (e) => onCollide(G, e));
  return G;
}
function addFruit(G, x, y, lvl, old = false) {
  const b = Bodies.circle(x, y, FRUITS[lvl].r, { restitution: 0.15, friction: 0.08, frictionStatic: 0.4, density: 0.0012, slop: 0.02 });
  b.lvl = lvl; b.born = old ? -1e9 : performance.now();
  Composite.add(G.engine.world, b); G.fruits.push(b);
  return b;
}
function removeFruit(G, b) {
  b.gone = true;
  Composite.remove(G.engine.world, b);
  G.fruits = G.fruits.filter((x) => x !== b);
}
function onCollide(G, e) {
  for (const { bodyA: a, bodyB: b } of e.pairs) {
    if (a.lvl === undefined || a.lvl !== b.lvl || a.gone || b.gone || G.over) continue;
    const lvl = a.lvl;
    const x = (a.position.x + b.position.x) / 2, y = (a.position.y + b.position.y) / 2;
    removeFruit(G, a); removeFruit(G, b);
    if (lvl === LAST) { G.score += 100; G.fx.push({ x, y, r: 120, t: 0, c: '#ffd84d', txt: '+100' }); continue; } // スイカ同士は消える
    const n = addFruit(G, x, y, lvl + 1, true);
    n.born = performance.now() - 2000;
    const pts = pointsFor(lvl + 1);
    G.score += pts; G.best = Math.max(G.best, lvl + 1); G.dirty = true;
    G.fx.push({ x, y, r: FRUITS[lvl + 1].r, t: 0, c: FRUITS[lvl + 1].c2, txt: `+${pts}` });
    if (lvl + 1 === LAST && !G.won) { G.won = true; onWatermelon(); }
  }
}
function dropNow() {
  const G = S.G; if (!G || G.over || !G.canDrop || stateOf().phase !== 'play' || !started()) return;
  const r = FRUITS[G.cur].r;
  const x = Math.max(r + 2, Math.min(W - r - 2, G.dropX));
  addFruit(G, x, DROP_Y, G.cur);
  G.cur = G.next; G.next = G.draw(); G.drops++; G.canDrop = false; G.dirty = true;
  setTimeout(() => { if (S.G === G) G.canDrop = true; }, 550);
  sendState(true);
}
const started = () => S.store.now() >= (stateOf().startAt || 0);

function stepGame(now) {
  const G = S.G; if (!G) return;
  const dt = Math.min(50, now - (G.last || now)); G.last = now;
  const playing = stateOf().phase === 'play' && started() && !G.over;
  if (playing) {
    G.acc += dt;
    let n = 0;
    while (G.acc >= 1000 / 60 && n < 3) { Engine.update(G.engine, 1000 / 60); G.acc -= 1000 / 60; n++; }
    // ゲームオーバー判定：落としてから少したった果物が、ラインより上で止まっている
    const above = G.fruits.some((b) => now - b.born > 1500 && b.position.y - FRUITS[b.lvl].r < LINE && Math.hypot(b.velocity.x, b.velocity.y) < 1.2);
    G.danger = above ? G.danger + dt : 0;
    if (G.danger > OVER_MS) { G.over = true; G.dirty = true; sendState(true); toast('ゲームオーバー！ ほかの人の結果を待とう'); }
  }
  for (const f of G.fx) f.t += dt;
  G.fx = G.fx.filter((f) => f.t < 700);
  if (performance.now() - G.sentAt > 1000) sendState();
}
async function sendState(force = false) {
  const G = S.G, st = stateOf(); if (!G || !S.code || st.phase !== 'play' || !inGame(curGame())) return;
  if (!force && !G.dirty && performance.now() - G.sentAt < 3000) return;
  G.sentAt = performance.now(); G.dirty = false;
  await S.store.set(`${gamePath()}/ps/${S.pid}`, { score: G.score, best: G.best, drops: G.drops, over: G.over, snap: encSnap(G.fruits), at: S.store.now() }).catch(() => {});
}
async function onWatermelon() {
  const st = stateOf(); if (st.phase !== 'play') return;
  confetti(160, FRUITS.map((f) => f.c));
  await sendState(true);
  await S.store.update(roomPath(), { 'state/phase': 'result', [`games/${gk(st.game)}/winner`]: S.pid, [`games/${gk(st.game)}/reason`]: 'suika', [`games/${gk(st.game)}/endedAt`]: S.store.now() });
}

// ---------- 描画（自分の箱） ----------
function paintBoard() {
  const cv = document.getElementById('board'), G = S.G; if (!cv || !G) return;
  const cw = cv.clientWidth; if (!cw) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), sc = cw / W;
  if (cv.width !== Math.round(cw * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(cw * (H / W) * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // 箱
  const bg = ctx.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#fff3d6'); bg.addColorStop(1, '#ffe2a8');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // ライン
  const warn = G.danger > 0;
  ctx.strokeStyle = warn ? `rgba(232,56,79,${0.5 + 0.5 * Math.sin(performance.now() / 90)})` : '#e8384f88';
  ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.moveTo(0, LINE); ctx.lineTo(W, LINE); ctx.stroke(); ctx.setLineDash([]);
  // 落とす位置のガイド
  const playing = stateOf().phase === 'play' && !G.over && inGame(curGame());
  if (playing) {
    const r = FRUITS[G.cur].r, x = Math.max(r + 2, Math.min(W - r - 2, G.dropX));
    ctx.strokeStyle = '#00000022'; ctx.lineWidth = 2; ctx.setLineDash([4, 8]);
    ctx.beginPath(); ctx.moveTo(x, DROP_Y); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([]);
    if (G.canDrop && started()) drawFruit(ctx, x, DROP_Y, r, G.cur);
  }
  for (const b of G.fruits) drawFruit(ctx, b.position.x, b.position.y, FRUITS[b.lvl].r, b.lvl, b.angle);
  // 合体のエフェクト
  for (const f of G.fx) {
    const p = f.t / 700;
    ctx.strokeStyle = f.c; ctx.globalAlpha = 1 - p; ctx.lineWidth = 6 * (1 - p);
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1 + p * 0.6), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#5a2a00'; ctx.font = `800 ${18 + f.r * 0.15}px 'M PLUS Rounded 1c', sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(f.txt, f.x, f.y - f.r - 10 - p * 24);
    ctx.globalAlpha = 1;
  }
  if (G.over) {
    ctx.fillStyle = '#1b163099'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = "800 40px 'M PLUS Rounded 1c', sans-serif"; ctx.textAlign = 'center';
    ctx.fillText('ゲームオーバー', W / 2, H / 2 - 10);
    ctx.font = "700 20px 'M PLUS Rounded 1c', sans-serif"; ctx.fillText(`スコア ${G.score}`, W / 2, H / 2 + 26);
  }
  // カウントダウン
  const st = stateOf();
  if (st.phase === 'play' && !started()) {
    const n = Math.ceil(((st.startAt || 0) - S.store.now()) / 1000);
    ctx.fillStyle = '#1b163088'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = "800 120px 'M PLUS Rounded 1c', sans-serif"; ctx.textAlign = 'center';
    ctx.fillText(n > 0 ? n : 'GO!', W / 2, H / 2 + 40);
  }
}
function paintMini(cv, snap, over) {
  if (!cv) return;
  const cw = cv.clientWidth; if (!cw) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), sc = cw / W;
  if (cv.width !== Math.round(cw * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(cw * (H / W) * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0);
  ctx.fillStyle = '#ffe9be'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e8384f88'; ctx.lineWidth = 6; ctx.setLineDash([16, 12]); ctx.beginPath(); ctx.moveTo(0, LINE); ctx.lineTo(W, LINE); ctx.stroke(); ctx.setLineDash([]);
  for (const f of decSnap(snap)) { ctx.fillStyle = FRUITS[f.lvl].c; ctx.beginPath(); ctx.arc(f.x, f.y, FRUITS[f.lvl].r, 0, Math.PI * 2); ctx.fill(); }
  if (over) { ctx.fillStyle = '#1b1630aa'; ctx.fillRect(0, 0, W, H); }
}
function loop(now) {
  S.raf = requestAnimationFrame(loop);
  if (!S.G) return;
  stepGame(now);
  paintBoard();
  updateHud();
}

// =============================================================
//  起動・ホーム
// =============================================================
async function boot() {
  S.pid = getPid(); S.name = getName();
  try { S.store = await createStore(); } catch (e) {
    $app.innerHTML = `<div class="card center"><h2>接続できませんでした</h2><p class="muted">firebase-config.js の設定を確認してください。</p><pre class="err">${esc(e.message)}</pre></div>`;
    return;
  }
  let shown = null;
  S.store.onConnection((ok) => {
    clearTimeout(shown);
    const el = document.getElementById('conn');
    if (ok) el.classList.remove('show'); else shown = setTimeout(() => el.classList.add('show'), 1500);
  });
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code && sessionStorage.getItem(ROOM_KEY) === code && S.name) {
    const meta = await S.store.get(`rooms/${code}/meta`);
    if (meta?.game === GAME) return enterRoom(code);
    if (meta) { await gotoRoom(S.store, code); return; }
  }
  renderHome(code);
}
function ladderHTML() {
  return `<div class="fr-ladder">${FRUITS.map((f, i) => `${i ? '<i>›</i>' : ''}<span title="${f.name}">${icon(i, 22 + i * 1.2)}</span>`).join('')}</div>`;
}
function rulesHTML(open = false) {
  return `<details class="card rules" ${open ? 'open' : ''}>
    <summary>あそびかた</summary>
    <ol>
      <li>左右に動かして、離した（クリックした）ところに果物を落とす</li>
      <li><b>同じ果物</b>どうしがくっつくと、ひとつ大きい果物に進化！</li>
      <li>果物がラインを越えたまま止まると<b>ゲームオーバー</b></li>
      <li>全員同時スタート。落ちてくる順番はみんな同じ</li>
    </ol>
    ${ladderHTML()}
    <div class="score-legend">
      <span>🍉 <b>スイカを作ったらその場で勝ち！</b></span>
      <span>全員ゲームオーバーなら<b>スコア勝負</b></span>
    </div>
    <p class="muted small">PCは ← → キーで移動、スペースで落とすこともできます。</p>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo fr-logo">
      <div class="fr-mark">${[0, 3, 5, 9, 10].map((l, i) => `<span style="--i:${i}">${icon(l, 30 + i * 8)}</span>`).join('')}</div>
      <h1>フルーツまぜまぜ</h1>
      <p>同じ果物をくっつけて、スイカを目指せ！</p>
    </div>
    <section class="card">
      <label class="field"><span>ニックネーム</span>
        <input id="name" maxlength="10" placeholder="例：たろう" value="${esc(S.name)}" autocomplete="nickname" enterkeyhint="go"></label>
      ${prefill ? `
        <button class="btn primary big" data-action="join" data-code="${esc(prefill)}">部屋 <b class="mono">${esc(prefill)}</b> に参加する</button>
        <div class="or"><span>または</span></div>
        <button class="btn wide" data-action="create">新しい部屋を作る</button>` : `
        <button class="btn primary big" data-action="create">部屋を作る</button>
        <div class="or"><span>または</span></div>
        <div class="join-row">
          <input id="code" maxlength="4" placeholder="部屋コード" autocapitalize="characters" autocomplete="off" enterkeyhint="go" class="mono">
          <button class="btn" data-action="join">参加</button>
        </div>`}
    </section>
    ${rulesHTML(false)}
  </div>`;
}
function readName() {
  const el = document.getElementById('name');
  const v = (el?.value || '').trim();
  if (!v) { toast('ニックネームを入力してね'); el?.focus(); return null; }
  S.name = v.slice(0, 10); saveName(S.name);
  return S.name;
}
async function createRoom() {
  if (!readName()) return;
  let code = genCode();
  for (let i = 0; i < 8; i++) { if (!(await S.store.get(`rooms/${code}/meta`))) break; code = genCode(); }
  await S.store.set(`rooms/${code}`, { meta: { game: GAME, createdAt: Date.now() }, state: { phase: 'lobby', game: 0 } });
  await enterRoom(code);
}
async function joinRoom(raw) {
  if (!readName()) return;
  const code = (raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { toast('4文字の部屋コードを入力してね'); document.getElementById('code')?.focus(); return; }
  const meta = await S.store.get(`rooms/${code}/meta`);
  if (!meta) { toast('部屋が見つかりません'); return; }
  if (meta.game !== GAME) { await gotoRoom(S.store, code); return; }
  await enterRoom(code);
}
const AVATAR_COLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];
async function enterRoom(code) {
  S.code = code; S.viewKey = '';
  sessionStorage.setItem(ROOM_KEY, code);
  setUrlRoom(code);
  await joinPlayer(S.store, code, S.pid, S.name, AVATAR_COLORS);
  S.stopPresence = S.store.presence(`rooms/${code}/players/${S.pid}/online`);
  S.unsub = S.store.on(`rooms/${code}`, onRoom);
  clearInterval(S.tick); S.tick = setInterval(onTick, 500);
  cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(loop);
}
async function leaveRoom() {
  if (!confirm('部屋から退出しますか？')) return;
  const phase = stateOf().phase, code = S.code;
  S.unsub?.(); S.unsub = null; S.stopPresence?.(); S.stopPresence = null; clearInterval(S.tick); cancelAnimationFrame(S.raf); S.G = null;
  if (phase === 'lobby') await S.store.remove(`rooms/${code}/players/${S.pid}`);
  else await S.store.set(`rooms/${code}/players/${S.pid}/online`, false);
  sessionStorage.removeItem(ROOM_KEY);
  S.code = null; S.room = null; setUrlRoom(null);
  renderHome();
}

// =============================================================
//  進行
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    S.unsub?.(); S.stopPresence?.(); clearInterval(S.tick);
    sessionStorage.removeItem(ROOM_KEY); setUrlRoom(null);
    S.code = null; S.room = null; S.G = null; toast('部屋が見つかりません'); renderHome(); return;
  }
  if (followRoom(room, GAME, S.code)) { S.unsub?.(); clearInterval(S.tick); return; }
  S.room = room;
  syncLocalGame();
  render();
}
// 部屋の状態に合わせて自分の箱を用意する
function syncLocalGame() {
  const st = stateOf(), g = curGame();
  const key = `${S.code}:${st.game}`;
  if (st.phase === 'play' && g && inGame(g)) {
    if (S.G?.key !== key) {
      const mine = pdata(g, S.pid);
      S.G = newLocalGame(g.seed, mine.drops ? mine : null);
      S.G.key = key;
      if (mine.over) S.G.over = true;
    }
  } else if (st.phase !== 'play' && st.phase !== 'result') S.G = null;
  else if (st.phase === 'result' && S.G && !S.G.over && S.G.key === key) { S.G.over = true; sendFinal(); }
}
async function sendFinal() {
  const G = S.G; if (!G) return;
  const st = stateOf(); if (!inGame(curGame())) return;
  await S.store.set(`${gamePath()}/ps/${S.pid}`, { score: G.score, best: G.best, drops: G.drops, over: true, snap: encSnap(G.fruits), at: S.store.now() }).catch(() => {});
}
function onTick() {
  if (!S.room) return;
  updateDynamic();
  if (!isHost()) return;
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g || !started()) return;
  const now = S.store.now();
  const allDone = g.order.every((id) => finished(g, id, now));
  const timeUp = st.endAt && now > st.endAt;
  if ((allDone || timeUp) && S.hostBusy !== `end:${st.game}`) {
    S.hostBusy = `end:${st.game}`;
    let best = null, max = -1;
    for (const id of g.order) { const sc = pdata(g, id).score || 0; if (sc > max) { max = sc; best = id; } }
    const tie = g.order.filter((id) => (pdata(g, id).score || 0) === max).length > 1;
    S.store.update(roomPath(), { 'state/phase': 'result', [`games/${gk(st.game)}/winner`]: tie ? '' : best, [`games/${gk(st.game)}/reason`]: timeUp ? 'time' : 'allover', [`games/${gk(st.game)}/endedAt`]: now }).catch(() => { S.hostBusy = ''; });
  }
}
async function startGame() {
  const ids = onlinePlayers().map((p) => p.id);
  if (!ids.length) return;
  const n = stateOf().game + 1, now = S.store.now(), startAt = now + 3500, { limit } = settings();
  await S.store.update(roomPath(), {
    state: { phase: 'play', game: n, startAt, endAt: limit ? startAt + limit * 60000 : 0 },
    [`games/${gk(n)}`]: { order: ids, seed: Math.floor(Math.random() * 2 ** 31), startedAt: Date.now() },
  });
}

// =============================================================
//  画面
// =============================================================
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }
function render() {
  if (!S.room) return;
  const st = stateOf();
  const key = `${st.phase}|${st.game}|${inGame(curGame())}`;
  if (key !== S.viewKey) {
    S.viewKey = key;
    const views = { lobby: lobbyView, play: playView, result: resultView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main frgame phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    window.scrollTo({ top: 0 });
    if (st.phase === 'result' && !S.confettiDone[st.game]) {
      S.confettiDone[st.game] = true;
      if (curGame()?.winner === S.pid) setTimeout(() => confetti(150, FRUITS.map((f) => f.c)), 300);
    }
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('rivals'), rivalsHTML());
  setHTML(document.getElementById('dyn'), dynHTML());
  document.querySelectorAll('canvas[data-mini]').forEach((cv) => { const g = curGame(), d = pdata(g, cv.dataset.mini); paintMini(cv, d.snap, d.over); });
}
function updateHud() {
  const G = S.G; if (!G) return;
  setHTML(document.getElementById('hud'), `
    <div class="hud-box"><small>スコア</small><b>${G.score}</b></div>
    <div class="hud-box"><small>つぎ</small>${icon(G.next, 34)}<em class="fname">${FRUITS[G.next].name}</em></div>
    <div class="hud-box"><small>さいこう</small>${icon(G.best, 34)}</div>`);
  const st = stateOf();
  if (st.endAt) {
    const left = Math.max(0, st.endAt - S.store.now());
    setHTML(document.getElementById('clock'), started() ? `⏱ 残り ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` : '');
  }
}
function dynHTML() {
  const f = { lobby: lobbyDyn, play: playDyn, result: resultDyn }[stateOf().phase];
  return f ? f() : '';
}
function phaseChipHTML() {
  const st = stateOf();
  return `<span>${{ lobby: 'メンバー待ち', play: `第${st.game}戦`, result: '結果発表' }[st.phase] || ''}</span>`;
}
function headerHTML() {
  return `<header class="topbar">
    <button class="room-chip" data-action="copy-link" title="招待リンクをコピー"><small>ROOM</small><b class="mono">${esc(S.code)}</b><i>🔗</i></button>
    <div class="phase-chip" id="phase-chip"></div>
    <button class="btn small ghost" data-action="leave">退出</button>
  </header>
  <div id="pbar" class="pbar"></div>`;
}
function pbarHTML() {
  const h = hostId(), w = winsTotal(), st = stateOf(), g = curGame();
  return playerList().map((p) => {
    const d = pdata(g, p.id);
    return `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar(p)}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${st.phase !== 'lobby' ? `<span class="pscore">🏆${w[p.id] || 0}</span>` : ''}${st.phase === 'play' && inGame(g) && g.order.includes(p.id) && d.over ? '<span class="tag wip">終了</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
    </div>`;
  }).join('');
}

// ---------- ロビー ----------
function lobbyView() {
  return `<section class="card invite">
      <div class="invite-label">部屋コード</div>
      <div class="invite-code mono">${[...S.code].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
      <p class="muted small">このコードかリンクを友達に送ろう（1人でも遊べます）</p>
      <div class="row center">
        <button class="btn" data-action="copy-link">🔗 リンクをコピー</button>
        ${navigator.share ? '<button class="btn" data-action="share">📤 共有</button>' : ''}
      </div>
    </section>
    <div id="dyn"></div>
    ${rulesHTML(true)}`;
}
function lobbyDyn() {
  const ps = playerList(), host = isHost(), { limit } = settings(), n = onlinePlayers().length, h = hostId();
  return `<section class="card">
      <h3>参加メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>制限時間</h3>
      <div class="seg">${[0, 3, 5, 10].map((v) => `<button class="seg-btn ${limit === v ? 'on' : ''}" data-action="set-limit" data-v="${v}" ${host ? '' : 'disabled'}>${v ? v + '分' : 'なし'}</button>`).join('')}</div>
      <p class="muted small">${limit ? `${limit}分たったら、その時点のスコアで勝負` : 'スイカができるか、全員がゲームオーバーになるまで続きます'}${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start">${n === 1 ? 'ひとりで練習スタート' : 'みんなでスタート！'}<small>3秒のカウントダウンのあと、全員同時に始まります</small></button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- プレイ ----------
function playView() {
  const g = curGame(), me = inGame(g);
  return `<div id="rivals" class="rivals"></div>
    ${me ? `<div class="fr-top"><div id="hud" class="hud"></div><div id="clock" class="clock"></div></div>
    <div class="fr-wrap"><canvas id="board" class="fr-board" aria-label="あなたの箱"></canvas></div>
    <p class="muted tiny center">${matchMedia('(hover: none)').matches ? '指でなぞって位置を決め、離すと落ちます' : 'マウスで位置を決めてクリック（← → とスペースでもOK）'}</p>
    ${ladderHTML()}` : '<p class="muted center">観戦中（次のゲームから参加できます）</p>'}
    <div id="dyn"></div>`;
}
function rivalsHTML() {
  const g = curGame(), st = stateOf(); if (!g) return '';
  const me = inGame(g);
  const ids = g.order.filter((id) => id !== S.pid || !me);
  if (!ids.length) return '';
  const now = S.store.now();
  return ids.map((id) => {
    const p = player(id), d = pdata(g, id), done = st.phase === 'play' && finished(g, id, now);
    return `<div class="rival ${me ? '' : 'big'}">
      <canvas class="mini" data-mini="${id}"></canvas>
      <div class="rv-name">${avatar(p, 'xs')}<span>${esc(p.name)}</span></div>
      <div class="rv-score"><b>${d.score || 0}</b>${d.best ? icon(d.best, 18) : ''}${done ? '<em>終了</em>' : ''}</div>
    </div>`;
  }).join('');
}
function playDyn() {
  const g = curGame(), st = stateOf(); if (!g) return '';
  const now = S.store.now(), left = g.order.filter((id) => !finished(g, id, now)).length;
  return `<p class="muted small center">${S.G?.over ? `あと${left}人がプレイ中…` : `プレイ中 ${left}人`}</p>`;
}

// ---------- 結果 ----------
function resultView() {
  const g = curGame(), wins = winsTotal();
  const rows = g.order.map((id) => ({ id, ...pdata(g, id) })).sort((a, b) => (b.id === g.winner) - (a.id === g.winner) || (b.score || 0) - (a.score || 0));
  const w = g.winner ? player(g.winner) : null;
  const title = g.reason === 'suika'
    ? `🍉 ${g.winner === S.pid ? 'あなた' : `${esc(w.name)} さん`}がスイカを作った！`
    : w ? `${g.winner === S.pid ? 'あなた' : `${esc(w.name)} さん`}の勝ち！` : '引き分け！';
  return `<section class="final-head">
      <div class="trophy">${g.reason === 'suika' ? icon(LAST, 72) : '🏆'}</div>
      <h2>${title}</h2>
      <p class="muted small">${g.reason === 'suika' ? 'スイカを作った人の勝ち' : g.reason === 'time' ? '時間切れ → スコア勝負' : '全員ゲームオーバー → スコア勝負'}</p>
    </section>
    <section class="card"><ol class="standings">${rows.map((x, i) => {
      const p = player(x.id);
      return `<li class="${x.id === S.pid ? 'me' : ''}"><span class="rank r${i + 1}">${i + 1}</span>${avatar(p, 'sm')}<span class="nm">${esc(p.name)}${x.id === g.winner ? ' 👑' : ''}</span><span class="fr-best">${icon(x.best || 0, 22)}</span><span class="muted tiny">通算🏆${wins[x.id] || 0}</span><b>${x.score || 0}<small>点</small></b></li>`;
    }).join('')}</ol></section>
    <h3 class="sec-title">みんなの箱</h3>
    <div class="fr-gallery">${rows.map((x) => `<figure><canvas class="mini" data-mini="${x.id}"></canvas><figcaption>${esc(player(x.id).name)}</figcaption></figure>`).join('')}</div>
    <div id="dyn"></div>`;
}
function resultDyn() {
  if (isHost()) {
    return `<div class="host-bar">
      <button class="btn primary big" data-action="start">🔁 もう一戦</button>
      <button class="btn ghost wide" data-action="to-lobby">ロビーに戻る（設定を変える）</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}

// =============================================================
//  操作
// =============================================================
function boardX(e) {
  const cv = document.getElementById('board'); if (!cv) return null;
  const b = cv.getBoundingClientRect();
  return ((e.clientX - b.left) / b.width) * W;
}
let aiming = false;
$app.addEventListener('pointerdown', (e) => {
  if (e.target.id !== 'board' || !S.G) return;
  e.preventDefault(); aiming = true;
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  const x = boardX(e); if (x != null) S.G.dropX = x;
});
$app.addEventListener('pointermove', (e) => {
  if (!S.G) return;
  if (e.target.id !== 'board' && !aiming) return;
  const x = boardX(e); if (x != null) S.G.dropX = x;
});
$app.addEventListener('pointerup', (e) => {
  if (!aiming) return;
  aiming = false;
  const x = boardX(e); if (x != null && S.G) S.G.dropX = x;
  dropNow();
});
$app.addEventListener('pointercancel', () => { aiming = false; });
document.addEventListener('keydown', (e) => {
  if (!S.G || e.target.closest?.('input')) return;
  if (e.key === 'ArrowLeft') { S.G.dropX -= 14; e.preventDefault(); }
  else if (e.key === 'ArrowRight') { S.G.dropX += 14; e.preventDefault(); }
  else if (e.key === ' ' || e.key === 'ArrowDown') { dropNow(); e.preventDefault(); }
  S.G.dropX = Math.max(0, Math.min(W, S.G.dropX));
});
document.addEventListener('visibilitychange', () => { if (document.hidden) sendState(true); });

async function copyLink() {
  const url = pageUrl('fruit.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'フルーツまぜまぜ', text: `フルーツまぜまぜで対戦しよう！部屋コード：${S.code}`, url: pageUrl('fruit.html', S.code) }); } catch {}
}
const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  'set-limit': (el) => S.store.set(`${roomPath()}/meta/limit`, +el.dataset.v),
  start: startGame,
  'to-lobby': () => S.store.update(roomPath(), { 'state/phase': 'lobby' }),
};
$app.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a || a.disabled) return;
  const fn = actions[a.dataset.action]; if (!fn) return;
  const ret = fn(a);
  if (ret instanceof Promise) {
    a.disabled = true; a.classList.add('busy');
    ret.catch((err) => { console.error(err); toast('エラー：' + (err?.message || err)); })
      .finally(() => { if (a.isConnected) { a.disabled = false; a.classList.remove('busy'); } });
  }
});
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const t = e.target;
  if (t.id === 'name' || t.id === 'code') {
    e.preventDefault();
    (document.querySelector('[data-action="join"][data-code]') || (document.getElementById('code')?.value ? document.querySelector('[data-action="join"]') : document.querySelector('[data-action="create"]')))?.click();
  }
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ローカルテストモードのときだけ、動作確認用に中身をのぞけるようにする
if (isLocalMode) window.__fruit = { S, addFruit, FRUITS };

boot();
