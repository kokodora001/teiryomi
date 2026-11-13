// =============================================================
//  えしりとり — 絵だけでつなぐ、伝言しりとり
//  ・全員が同時にそれぞれの「列」を進め、ステップごとに列が隣へ回る
//  ・回ってきた絵を見て「何に見えるか」を答え、
//    その最後の文字から始まる言葉を描いて次へ渡す
//  ・最後に1列ずつ答え合わせ。伝わったら描いた人と答えた人に +1
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, shuffle, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';

// ---------- 定数 ----------
const GAME = 'eshiri';
const AVATAR_COLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];
const PAPER = '#fffdf6';
const PEN_COLORS = ['#1b1630', '#e8384f', '#f08c00', '#f2c200', '#2f9e44', '#1c7ed6', '#9c36b5', '#8d5524', '#9aa0a6', PAPER];
const ERASER = PEN_COLORS.length - 1;
const PEN_WIDTHS = [0.007, 0.015, 0.03, 0.06];
const RES = 1295;
const MAX_STROKES = 400;
const START_KANA = ['あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'こ', 'さ', 'し', 'す', 'そ', 'た', 'つ', 'て', 'と', 'な', 'ね', 'は', 'ひ', 'ふ', 'ほ', 'ま', 'み', 'め', 'も', 'や', 'ゆ', 'ら', 'り', 'る', 'ろ', 'わ'];
const SMALL = { 'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'っ': 'つ', 'ゎ': 'わ', 'ゕ': 'か', 'ゖ': 'け', 'ゔ': 'ぶ' };

const $app = document.getElementById('app');

const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null, viewKey: '', phaseSeen: '',
  play: null,            // 自分の作業中データ
  drawing: null,         // 描いている最中の線
  tick: null, hostTick: null, hostBusy: '', autoSent: '',
  lastRv: '', confettiDone: {},
};

// ---------- かなユーティリティ ----------
function toHira(s) {
  return String(s || '').normalize('NFKC').replace(/[\s　]/g, '')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
const isKana = (s) => /^[ぁ-ゖー]+$/.test(toHira(s));
const base = (c) => (SMALL[c] || c || '').normalize('NFD')[0] || ''; // 濁点・半濁点・小文字を無視
function lastKana(s) {
  const h = toHira(s).replace(/ー+$/, '');
  let c = h[h.length - 1] || '';
  if (c === 'ん' && h.length > 1) c = h[h.length - 2]; // 「ん」で終わったらひとつ前から
  return SMALL[c] || c;
}
const sameWord = (a, b) => !!a && !!b && toHira(a).replace(/ー/g, '') === toHira(b).replace(/ー/g, '');

// ---------- 絵のエンコード ----------
const c2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * RES).toString(36).padStart(2, '0');
const encPts = (pts) => pts.map(([x, y]) => c2(x) + c2(y)).join('');
function decPts(s) {
  const out = [];
  for (let i = 0; i + 4 <= s.length; i += 4) out.push([parseInt(s.slice(i, i + 2), 36) / RES, parseInt(s.slice(i + 2, i + 4), 36) / RES]);
  return out;
}
const encDrawing = (strokes) => strokes.map((st) => `${st.c}${st.w}${encPts(st.pts)}`).join('|');
const decDrawing = (s) => (s ? s.split('|').filter((x) => x.length >= 6).map((x) => ({ c: +x[0], w: +x[1], pts: decPts(x.slice(2)) })) : []);

function paint(canvas, strokes) {
  if (!canvas) return;
  const w = canvas.clientWidth; if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3), px = Math.round(w * dpr);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, w);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const st of strokes) {
    const pts = st.pts; if (!pts.length) continue;
    const lw = Math.max(1.5, w * PEN_WIDTHS[st.w]);
    ctx.strokeStyle = PEN_COLORS[st.c] || '#000'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = lw;
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * w, pts[0][1] * w, lw / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.beginPath(); ctx.moveTo(pts[0][0] * w, pts[0][1] * w);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * w, mx * w, my * w);
    }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0] * w, l[1] * w); ctx.stroke();
  }
}

// ---------- ルーム状態の参照 ----------
const rk = (n) => 'r' + n;
const roomPath = () => `rooms/${S.code}`;
const roundPath = (n = stateOf().round) => `rooms/${S.code}/rounds/${rk(n)}`;
function playerList() {
  return Object.entries(S.room?.players || {})
    .filter(([, p]) => p && p.name).map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
const onlinePlayers = () => playerList().filter((p) => p.online);
const hostId = () => (onlinePlayers()[0] || playerList()[0] || {}).id;
const isHost = () => hostId() === S.pid;
function player(id) { const p = S.room?.players?.[id]; return p ? { id, ...p } : { id, name: '???', color: '#888', online: false }; }
const stateOf = () => S.room?.state || { phase: 'lobby', round: 0 };
const curRound = () => S.room?.rounds?.[rk(stateOf().round)] || null;
const settings = () => ({ timer: S.room?.meta?.timer ?? 90, len: S.room?.meta?.len ?? 0 });
const mod = (a, n) => ((a % n) + n) % n;
const entry = (r, c, k) => r?.chains?.[c]?.[k] || null;
const N = (r) => r?.order?.length || 0;
const workerOf = (r, c, k) => r.order[mod(c + k, N(r))];       // 列cのステップkを担当する人
const myChain = (r, k) => mod(r.order.indexOf(S.pid) - k, N(r)); // ステップkで自分が担当する列
const inRound = (r) => !!r && r.order?.includes(S.pid);

// 列cのステップkで「何から始まる言葉を描くか」
function requiredKana(r, c, k, guess) {
  if (k === 0) return r.starts[c];
  if (guess && isKana(guess)) return lastKana(guess);
  for (let j = k - 1; j >= 0; j--) { const e = entry(r, c, j); if (e?.word && isKana(e.word)) return lastKana(e.word); }
  return r.starts[c];
}
// ステップkの役割：'draw'（最初）/ 'guess-draw' / 'guess'（最後）
function stepKind(r, c, k) {
  if (k === 0) return 'draw';
  const prev = entry(r, c, k - 1);
  if (k === r.L) return prev?.d ? 'guess' : 'none';
  return prev?.d ? 'guess-draw' : 'draw';
}

// ---------- 得点 ----------
function linkOk(r, c, k) { // ステップkの人が、ステップk-1の絵を当てたか
  const a = entry(r, c, k - 1), b = entry(r, c, k);
  if (!a || !b || a.skip || b.skip || !a.d || !a.word || !b.guess) return false;
  return !!r.ok?.[`${c}_${k}`] || sameWord(a.word, b.guess);
}
function likeCount(r, c, k) { return Object.keys(r?.likes?.[`${c}_${k}`] || {}).length; }
function roundStats(r) {
  const s = {};
  const get = (id) => (s[id] ||= { pts: 0, read: 0, sent: 0, likes: 0 });
  for (let c = 0; c < N(r); c++) {
    for (let k = 1; k <= r.L; k++) if (linkOk(r, c, k)) { get(entry(r, c, k - 1).by).sent++; get(entry(r, c, k).by).read++; }
    for (let k = 0; k < r.L; k++) { const e = entry(r, c, k); if (e?.d) get(e.by).likes += likeCount(r, c, k); }
  }
  for (const v of Object.values(s)) v.pts = v.read + v.sent;
  return s;
}
function totals() {
  const t = {};
  for (const p of playerList()) t[p.id] = 0;
  for (const r of Object.values(S.room?.rounds || {})) {
    if (!r?.done) continue;
    for (const [id, v] of Object.entries(roundStats(r))) t[id] = (t[id] || 0) + v.pts;
  }
  return t;
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

function rulesHTML(open = false) {
  return `<details class="card rules" ${open ? 'open' : ''}>
    <summary>あそびかた</summary>
    <ol>
      <li>全員に「<b>〇</b>から始まる言葉」のお題が出る。言葉を決めて、<b>絵だけ</b>で描こう</li>
      <li>絵は隣の人へ回る。届いた絵が<b>何に見えるか</b>答えて、<br>その<b>最後の文字から始まる言葉</b>を描いて次へ渡す</li>
      <li>全員分回ったら、1列ずつ答え合わせ！</li>
    </ol>
    <div class="es-example">
      <span class="w">りんご</span><i>→ 見えたのは</i><span class="g ng">とまと</span><i>→「と」から</i><span class="w">とけい</span><i>→ …</i>
    </div>
    <div class="score-legend">
      <span>⭕ 絵が伝わった <b>描いた人 +1・答えた人 +1</b></span>
      <span>❤️ 気に入った絵にはいいね</span>
    </div>
    <p class="muted small">言葉は<b>ひらがな・カタカナ</b>で入力します。「ん」で終わったらひとつ前の文字から。濁点のあり・なしはどちらでもOK。</p>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo es-logo">
      <div class="es-chain"><span>り</span><b>→</b><span class="pic">🍎</span><b>→</b><span>ご</span></div>
      <h1>えしりとり</h1>
      <p>絵だけでつなぐ、伝言しりとり</p>
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
  await S.store.set(`rooms/${code}`, { meta: { game: GAME, createdAt: Date.now(), timer: 90, len: 0 }, state: { phase: 'lobby', round: 0 } });
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
async function enterRoom(code) {
  S.code = code; S.viewKey = ''; S.phaseSeen = '';
  sessionStorage.setItem(ROOM_KEY, code);
  setUrlRoom(code);
  await joinPlayer(S.store, code, S.pid, S.name, AVATAR_COLORS);
  S.stopPresence = S.store.presence(`rooms/${code}/players/${S.pid}/online`);
  S.unsub = S.store.on(`rooms/${code}`, onRoom);
  clearInterval(S.tick); S.tick = setInterval(onTick, 250);
}
async function leaveRoom() {
  if (!confirm('部屋から退出しますか？')) return;
  const phase = stateOf().phase, code = S.code;
  S.unsub?.(); S.unsub = null; S.stopPresence?.(); S.stopPresence = null; clearInterval(S.tick);
  if (phase === 'lobby') await S.store.remove(`rooms/${code}/players/${S.pid}`);
  else await S.store.set(`rooms/${code}/players/${S.pid}/online`, false);
  sessionStorage.removeItem(ROOM_KEY);
  S.code = null; S.room = null; setUrlRoom(null);
  renderHome();
}

// =============================================================
//  ルーム更新・ホストの進行
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    S.unsub?.(); S.stopPresence?.(); clearInterval(S.tick);
    sessionStorage.removeItem(ROOM_KEY); setUrlRoom(null);
    S.code = null; S.room = null; toast('部屋が見つかりません'); renderHome(); return;
  }
  if (followRoom(room, GAME, S.code)) { S.unsub?.(); return; }
  S.room = room;
  hostDuties();
  render();
}
function onTick() {
  if (!S.room) return;
  updateTimer();
  autoSubmitIfLate();
  hostDuties();
}

async function hostDo(key, fn) {
  if (S.hostBusy === key) return;
  S.hostBusy = key;
  try { await fn(); } catch (e) { console.error(e); S.hostBusy = ''; }
}
function stepDone(r, k) { for (let c = 0; c < N(r); c++) if (!entry(r, c, k)) return false; return true; }
function hostDuties() {
  if (!isHost()) return;
  const st = stateOf(), r = curRound();
  if (st.phase !== 'play' || !r) return;
  const k = st.step;
  if (stepDone(r, k)) { hostDo(`adv:${st.round}:${k}`, () => advance(k)); return; }
  // 時間切れから8秒たっても出していない人（切断など）は飛ばす
  if (st.deadline && S.store.now() > st.deadline + 8000) hostDo(`fill:${st.round}:${k}`, () => fillMissing(k));
}
async function advance(k) {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'play' || st.step !== k) return;
  const t = settings().timer;
  if (k + 1 <= r.L) {
    await S.store.update(roomPath(), { 'state/step': k + 1, 'state/deadline': t ? S.store.now() + t * 1000 : 0 });
  } else {
    await S.store.update(roomPath(), { 'state/phase': 'reveal', 'state/rv': { c: 0, i: 0 }, 'state/deadline': 0 });
  }
}
async function fillMissing(k) {
  const st = stateOf(), r = curRound(); if (st.step !== k) return;
  const upd = {};
  for (let c = 0; c < N(r); c++) if (!entry(r, c, k)) upd[`rounds/${rk(st.round)}/chains/${c}/${k}`] = { by: workerOf(r, c, k), skip: true };
  if (Object.keys(upd).length) await S.store.update(roomPath(), upd);
}

// ---------- ラウンド開始 ----------
async function startRound() {
  const ids = shuffle(onlinePlayers().map((p) => p.id));
  if (ids.length < 3) return toast('3人以上いないと始められません');
  const { timer, len } = settings();
  const L = len ? Math.min(len, ids.length) : ids.length;
  const starts = shuffle(START_KANA).slice(0, ids.length);
  const n = stateOf().round + 1;
  await S.store.update(roomPath(), {
    state: { phase: 'play', round: n, step: 0, deadline: timer ? S.store.now() + timer * 1000 : 0 },
    [`rounds/${rk(n)}`]: { order: ids, L, starts, startedAt: Date.now() },
  });
}

// =============================================================
//  画面
// =============================================================
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }

function render() {
  if (!S.room) return;
  const st = stateOf(), r = curRound();
  let key = `${st.phase}|${st.round}`;
  if (st.phase === 'play') {
    const k = st.step, sub = inRound(r) ? subState(r, k) : 'spectate';
    key += `|${k}|${sub}`;
  }
  if (st.phase === 'reveal') key += `|${st.rv?.c}|${st.rv?.i}`;
  if (key !== S.viewKey) {
    const prevKey = S.viewKey;
    S.viewKey = key;
    const views = { lobby: lobbyView, play: playView, reveal: revealView, result: resultView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main eshiri phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    afterRender(prevKey);
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('dyn'), dynHTML());
  document.querySelectorAll('[data-like]').forEach((el) => setHTML(el, likeHTML(el.dataset.like)));
  document.querySelectorAll('[data-mark]').forEach((el) => setHTML(el, markHTML(el.dataset.mark)));
  updateTimer();
}
function dynHTML() {
  const f = { lobby: lobbyDyn, play: playDyn, reveal: revealDyn, result: resultDyn }[stateOf().phase];
  return f ? f() : '';
}
function afterRender(prevKey) {
  const st = stateOf();
  if (st.phase === 'play') { paintPrev(); paintPad(); wordHint(); }
  if (st.phase === 'reveal') {
    paintAll();
    const sameChain = prevKey.startsWith(`reveal|${st.round}|${st.rv?.c}|`);
    if (sameChain) document.querySelector('.rv-card:last-of-type')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: 0 });
    const r = curRound();
    if (st.rv.i === r.L && !S.confettiDone[`${st.round}:${st.rv.c}`]) {
      S.confettiDone[`${st.round}:${st.rv.c}`] = true;
      let ok = 0; for (let k = 1; k <= r.L; k++) if (linkOk(r, st.rv.c, k)) ok++;
      if (ok === r.L) setTimeout(() => confetti(120), 300);
    }
  } else window.scrollTo({ top: 0 });
  if (st.phase === 'result') { paintAll(); if (!S.confettiDone[`res${st.round}`]) { S.confettiDone[`res${st.round}`] = true; setTimeout(() => confetti(100), 300); } }
}
window.addEventListener('resize', () => { paintPrev(); paintPad(); paintAll(); });

function phaseChipHTML() {
  const st = stateOf(), r = curRound();
  if (st.phase === 'play' && r) return `<b>ステップ ${st.step + 1}/${r.L + 1}</b><span>${st.step === r.L ? '最後の解読' : 'お絵描き中'}</span>`;
  if (st.phase === 'reveal' && r) return `<b>答え合わせ</b><span>${st.rv.c + 1}/${N(r)}列目</span>`;
  return `<span>${{ lobby: 'メンバー待ち', result: '結果発表' }[st.phase] || ''}</span>`;
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
  const st = stateOf(), r = curRound(), tot = totals(), h = hostId();
  const doneSet = new Set();
  if (st.phase === 'play' && r) for (let c = 0; c < N(r); c++) { const e = entry(r, c, st.step); if (e) doneSet.add(e.by); }
  return playerList().map((p) => `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar(p)}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${st.phase !== 'lobby' ? `<span class="pscore">${tot[p.id] || 0}pt</span>` : ''}${st.phase === 'play' && inRound(r) && r.order.includes(p.id) ? (doneSet.has(p.id) ? '<span class="tag ok">✓</span>' : '<span class="tag wip">✏️</span>') : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
    </div>`).join('');
}

// ---------- ロビー ----------
function lobbyView() {
  return `<section class="card invite">
      <div class="invite-label">部屋コード</div>
      <div class="invite-code mono">${[...S.code].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
      <p class="muted small">このコードかリンクを友達に送ろう</p>
      <div class="row center">
        <button class="btn" data-action="copy-link">🔗 リンクをコピー</button>
        ${navigator.share ? '<button class="btn" data-action="share">📤 共有</button>' : ''}
      </div>
    </section>
    <div id="dyn"></div>
    ${rulesHTML(true)}`;
}
function lobbyDyn() {
  const ps = playerList(), host = isHost(), { timer, len } = settings(), n = onlinePlayers().length, h = hostId();
  const L = len ? Math.min(len, n) : n;
  return `<section class="card">
      <h3>参加メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>1枚あたりの制限時間</h3>
      <div class="seg">${[60, 90, 120, 0].map((t) => `<button class="seg-btn ${timer === t ? 'on' : ''}" data-action="set-timer" data-t="${t}" ${host ? '' : 'disabled'}>${t ? t + '秒' : 'なし'}</button>`).join('')}</div>
      <h3 class="mt">しりとりの長さ</h3>
      <div class="seg">${[0, 4, 6].map((l) => `<button class="seg-btn ${len === l ? 'on' : ''}" data-action="set-len" data-l="${l}" ${host ? '' : 'disabled'}>${l ? l + '枚まで' : '全員分'}</button>`).join('')}</div>
      <p class="muted small">1列に絵が${L}枚つながります（1人あたり${L}枚描く）。${timer ? `目安 約${Math.ceil(((L + 1) * timer) / 60)}分` : ''}${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start" ${n < 3 ? 'disabled' : ''}>${n < 3 ? `あと${3 - n}人集まったら開始できます` : 'ゲームスタート！'}</button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- プレイ（自分の作業） ----------
function myEntry(r, k) { return entry(r, myChain(r, k), k); }
function subState(r, k) {
  if (myEntry(r, k)) return 'done';
  const c = myChain(r, k), kind = stepKind(r, c, k);
  ensurePlay(r, k);
  if (kind === 'none') return 'none';
  if (kind === 'guess') return 'guess';
  if (kind === 'guess-draw') return S.play.guessed ? 'draw' : 'guess';
  return 'draw';
}
function ensurePlay(r, k) {
  const key = `${S.code}:${stateOf().round}:${k}`;
  if (S.play?.key === key) return;
  let saved = null;
  try { const d = JSON.parse(sessionStorage.getItem('eshiri.draft')); if (d?.key === key) saved = d; } catch {}
  S.play = saved || { key, guess: '', guessed: false, word: '', strokes: [], color: 0, width: 1 };
  S.drawing = null;
}
function saveDraft() { try { sessionStorage.setItem('eshiri.draft', JSON.stringify(S.play)); } catch {} }

function timerHTML() { return `<div class="es-timer" id="timer"><i></i><span></span></div>`; }
function updateTimer() {
  const el = document.getElementById('timer'); if (!el) return;
  const st = stateOf();
  if (st.phase !== 'play' || !st.deadline) { el.classList.add('none'); return; }
  const left = Math.max(0, st.deadline - S.store.now()), total = settings().timer * 1000 || 1;
  const sec = Math.ceil(left / 1000);
  el.classList.toggle('warn', sec <= 10);
  el.querySelector('i').style.width = `${Math.min(100, (left / total) * 100)}%`;
  el.querySelector('span').textContent = left > 0 ? `残り ${sec}秒` : '時間切れ！';
}

function playView() {
  const st = stateOf(), r = curRound(), k = st.step;
  if (!inRound(r)) return `<section class="card center"><h2>観戦中</h2><p class="muted">途中参加のため、次のラウンドから参加できます</p></section><div id="dyn"></div>`;
  const sub = subState(r, k), c = myChain(r, k);
  const from = k > 0 ? player(entry(r, c, k - 1)?.by) : null;
  if (sub === 'done') {
    const e = myEntry(r, k);
    return `${timerHTML()}<section class="card center done-card">
        <div class="big-check">✓</div>
        <h2>提出しました！</h2>
        ${e.d ? `<canvas class="paper mini-paper dcv" data-draw="${c}:${k}"></canvas><p class="muted small">「${esc(e.word)}」を描きました</p>` : e.guess ? `<p class="muted">「${esc(e.guess)}」と答えました</p>` : ''}
      </section><div id="dyn"></div>`;
  }
  if (sub === 'none') {
    return `${timerHTML()}<section class="card center"><p>このステップは前の人が時間切れだったので、お休みです☕</p></section><div id="dyn"></div>`;
  }
  if (sub === 'guess') {
    const last = k === r.L;
    return `${timerHTML()}
      <section class="step-head">
        <div class="sh-from">${avatar(from, 'sm')}<span>${esc(from.name)} さんの絵</span></div>
        <h2>${last ? 'これは何？（最後の解読）' : 'これは何に見える？'}</h2>
      </section>
      <canvas class="paper big-paper" id="prev"></canvas>
      <section class="card guess-box">
        <div class="join-row"><input id="guess" maxlength="15" placeholder="ひらがな・カタカナで" value="${esc(S.play.guess)}" autocomplete="off" enterkeyhint="${last ? 'done' : 'next'}" lang="ja"><button class="btn primary" data-action="${last ? 'submit-guess' : 'guess-next'}">${last ? '提出' : '次へ'}</button></div>
        <p class="muted tiny" id="guess-hint">${last ? 'あなたの答えで、この列はおしまい。最初の人は伝わっていたかな？' : '答えの最後の文字から、次に描く言葉が決まります'}</p>
      </section>
      <div id="dyn"></div>`;
  }
  // draw
  const req = requiredKana(r, c, k, S.play.guessed ? S.play.guess : '');
  const viaGuess = k > 0 && S.play.guessed;
  return `${timerHTML()}
    <section class="step-head">
      ${viaGuess ? `<div class="sh-chain"><span class="g">${esc(S.play.guess)}</span><i>の</i><b>「${esc(req)}」</b><i>から</i></div>` : k === 0 ? '<div class="sh-chain"><i>スタートは</i><b>「' + esc(req) + '」</b></div>' : '<div class="sh-chain"><i>前の絵がなかったので</i><b>「' + esc(req) + '」</b><i>から</i></div>'}
      <h2>「${esc(req)}」から始まる言葉を描こう</h2>
    </section>
    <section class="word-box">
      <input id="word" maxlength="12" placeholder="${esc(req)}〜（ひらがな・カタカナ）" value="${esc(S.play.word)}" autocomplete="off" enterkeyhint="done" lang="ja">
      <p class="tiny" id="word-hint"></p>
    </section>
    <div class="pad-wrap"><canvas class="paper big-paper" id="pad"></canvas></div>
    <div class="tools" id="tools"></div>
    ${viaGuess ? '<div class="center"><button class="btn small ghost" data-action="back-guess">‹ 答えを直す</button></div>' : ''}
    <button class="btn primary big" data-action="submit-draw">この絵で提出する</button>
    <div id="dyn"></div>`;
}
function toolsHTML() {
  const p = S.play;
  return `<div class="palette">${PEN_COLORS.map((col, i) => `<button class="sw ${p.color === i ? 'on' : ''} ${i === ERASER ? 'eraser' : ''}" data-action="color" data-i="${i}" style="--sw:${col}" aria-label="${i === ERASER ? '消しゴム' : '色' + (i + 1)}">${i === ERASER ? '🧽' : ''}</button>`).join('')}</div>
    <div class="tool-row">
      <div class="widths">${PEN_WIDTHS.map((w, i) => `<button class="wd ${p.width === i ? 'on' : ''}" data-action="width" data-i="${i}" aria-label="太さ${i + 1}"><i style="--d:${4 + i * 5}px;--sw:${p.color === ERASER ? '#bbb' : PEN_COLORS[p.color]}"></i></button>`).join('')}</div>
      <button class="btn small" data-action="undo" ${p.strokes.length ? '' : 'disabled'}>↩ 戻す</button>
      <button class="btn small" data-action="clear" ${p.strokes.length ? '' : 'disabled'}>🗑 全消し</button>
    </div>`;
}
function wordHint() {
  const el = document.getElementById('word-hint'); if (!el) return;
  const r = curRound(), k = stateOf().step, c = myChain(r, k);
  const req = requiredKana(r, c, k, S.play.guessed ? S.play.guess : '');
  const v = check(S.play.word, req);
  el.textContent = v === true ? '✓ OK！ この言葉を絵で伝えよう（言葉は次の人には見えません）' : (S.play.word ? v : '描く言葉を決めて入力（次の人には見えません）');
  el.className = `tiny ${v === true ? 'ok' : S.play.word ? 'ng' : 'muted'}`;
}
function check(word, req) {
  const h = toHira(word);
  if (!h) return '言葉を入力してね';
  if (!isKana(h)) return 'ひらがな・カタカナで入力してね';
  if (h.replace(/ー/g, '').length < 2) return '2文字以上の言葉にしてね';
  if (base(h[0]) !== base(req)) return `「${req}」から始まる言葉にしてね`;
  if (h.replace(/ー+$/, '').endsWith('ん')) return '「ん」で終わる言葉はNG！';
  return true;
}
function paintPrev() {
  const cv = document.getElementById('prev'); if (!cv) return;
  const r = curRound(), k = stateOf().step, c = myChain(r, k);
  paint(cv, decDrawing(entry(r, c, k - 1)?.d));
}
function paintPad() {
  const cv = document.getElementById('pad'); if (!cv || !S.play) return;
  const strokes = S.drawing ? [...S.play.strokes, S.drawing] : S.play.strokes;
  paint(cv, strokes);
  setHTML(document.getElementById('tools'), toolsHTML());
}
function paintAll() {
  document.querySelectorAll('canvas[data-draw]').forEach((cv) => {
    const [c, k] = cv.dataset.draw.split(':').map(Number);
    const rn = cv.dataset.round ? +cv.dataset.round : stateOf().round;
    paint(cv, decDrawing(entry(S.room?.rounds?.[rk(rn)], c, k)?.d));
  });
}
function playDyn() {
  const st = stateOf(), r = curRound(); if (!r) return '';
  const k = st.step;
  let done = 0; for (let c = 0; c < N(r); c++) if (entry(r, c, k)) done++;
  let html = `<section class="card status">
      <h3>提出した人 <small>${done} / ${N(r)}</small></h3>
      <div class="progress"><i style="width:${(done / N(r)) * 100}%"></i></div>
    </section>`;
  if (isHost() && done < N(r) && (!inRound(r) || myEntry(r, k))) {
    const missing = []; for (let c = 0; c < N(r); c++) if (!entry(r, c, k)) missing.push(player(workerOf(r, c, k)));
    const off = missing.filter((p) => !p.online);
    html += `<div class="center"><button class="btn small ghost" data-action="force-next">${off.length ? `${off.map((p) => esc(p.name)).join('、')} さん（切断中）を飛ばして進む` : '未提出の人を飛ばして進む'}</button></div>`;
  }
  return html;
}

// 描画入力
function padPoint(e, cv) {
  const b = cv.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), Math.max(0, Math.min(1, (e.clientY - b.top) / b.height))];
}
let padQueued = false;
function paintPadSoon() { if (padQueued) return; padQueued = true; requestAnimationFrame(() => { padQueued = false; paintPad(); }); }
function onPointerDown(e) {
  if (e.target.id !== 'pad' || !S.play) return;
  if (S.play.strokes.length >= MAX_STROKES) return toast('これ以上は描けません');
  e.preventDefault();
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  S.drawing = { c: S.play.color, w: S.play.width, pts: [padPoint(e, e.target)] };
  paintPadSoon();
}
function onPointerMove(e) {
  if (!S.drawing || e.target.id !== 'pad') return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (evs.length ? evs : [e])) {
    const p = padPoint(ev, e.target), l = S.drawing.pts[S.drawing.pts.length - 1];
    if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.0035 && S.drawing.pts.length < 1500) S.drawing.pts.push(p);
  }
  paintPadSoon();
}
function onPointerUp() {
  if (!S.drawing) return;
  S.play.strokes.push(S.drawing); S.drawing = null;
  saveDraft(); paintPad();
}

// 提出
function guessNext() {
  const v = document.getElementById('guess')?.value.trim() || '';
  S.play.guess = v;
  if (!v) { toast('何に見えたか入力してね'); return; }
  if (!isKana(v)) { toast('ひらがな・カタカナで入力してね'); return; }
  S.play.guessed = true; saveDraft(); render();
}
async function submitGuess(auto = false) {
  const st = stateOf(), r = curRound(), k = st.step, c = myChain(r, k);
  if (st.phase !== 'play' || myEntry(r, k)) return;
  const v = (document.getElementById('guess')?.value ?? S.play.guess).trim();
  if (!auto) {
    if (!v) { toast('何に見えたか入力してね'); return; }
    if (!isKana(v)) { toast('ひらがな・カタカナで入力してね'); return; }
  }
  await S.store.set(`${roundPath()}/chains/${c}/${k}`, { by: S.pid, guess: v || '？', ...(auto ? { late: true } : {}) });
}
async function submitDraw(auto = false) {
  const st = stateOf(), r = curRound(), k = st.step, c = myChain(r, k);
  if (st.phase !== 'play' || myEntry(r, k)) return;
  const req = requiredKana(r, c, k, S.play.guessed ? S.play.guess : '');
  const word = (document.getElementById('word')?.value ?? S.play.word).trim();
  S.play.word = word;
  if (!auto) {
    const v = check(word, req);
    if (v !== true) { toast(v); document.getElementById('word')?.focus(); return; }
    if (!S.play.strokes.length) { toast('絵を描いてね'); return; }
  }
  const e = { by: S.pid, word: word || '？', d: encDrawing(S.play.strokes) };
  if (S.play.guessed) e.guess = S.play.guess || '？';
  if (auto) e.late = true;
  await S.store.set(`${roundPath()}/chains/${c}/${k}`, e);
}
function autoSubmitIfLate() {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'play' || !st.deadline || !inRound(r) || S.store.now() < st.deadline) return;
  const k = st.step; if (myEntry(r, k)) return;
  const key = `${st.round}:${k}`; if (S.autoSent === key) return;
  S.autoSent = key;
  const sub = subState(r, k);
  if (sub === 'none') S.store.set(`${roundPath()}/chains/${myChain(r, k)}/${k}`, { by: S.pid, skip: true });
  else if (sub === 'guess' && stepKind(r, myChain(r, k), k) === 'guess') submitGuess(true);
  else {
    if (sub === 'guess') { S.play.guess = document.getElementById('guess')?.value.trim() || ''; S.play.guessed = !!S.play.guess; }
    submitDraw(true);
  }
  toast('時間切れ！ 今の状態で提出しました');
}
async function forceNext() {
  if (!confirm('まだ提出していない人を飛ばして次へ進みますか？')) return;
  await fillMissing(stateOf().step);
}

// ---------- 答え合わせ ----------
function revealView() {
  const st = stateOf(), r = curRound(), c = st.rv.c, i = st.rv.i;
  const starter = player(entry(r, c, 0)?.by || workerOf(r, c, 0));
  let cards = '';
  for (let k = 0; k <= i; k++) cards += cardHTML(r, c, k, i);
  return `<section class="rv-head">
      <div class="rv-dots">${r.order.map((_, j) => `<i class="${j < c ? 'past' : j === c ? 'cur' : ''}"></i>`).join('')}</div>
      <h2>${avatar(starter, 'sm')} ${esc(starter.name)} さんの列</h2>
      <p class="muted small">スタート：「${esc(r.starts[c])}」</p>
    </section>
    <div class="rv-list">${cards}</div>
    ${i === r.L ? chainSummaryHTML(r, c) : ''}
    <div id="dyn"></div>`;
}
function cardHTML(r, c, k, i) {
  const e = entry(r, c, k), by = player(e?.by || workerOf(r, c, k));
  const prev = k > 0 ? entry(r, c, k - 1) : null;
  let top = '';
  if (k > 0 && prev?.d) {
    // 前の絵の答え合わせ
    if (!e || e.skip || !e.guess) top = `<div class="rv-guess skip">${avatar(by, 'sm')}<span>${esc(by.name)} さんは時間切れ…</span><span class="truth">正解は「<b>${esc(prev.word)}</b>」</span></div>`;
    else top = `<div class="rv-guess">${avatar(by, 'sm')}<span>${esc(by.name)} さんには</span><b class="gw">「${esc(e.guess)}」</b><span>に見えた</span>
        <div class="truth-row"><span class="truth">${esc(player(prev.by).name)} さんが描いたのは「<b>${esc(prev.word)}</b>」</span><span data-mark="${c}_${k}"></span></div></div>`;
  }
  let pic = '';
  if (k < r.L) {
    if (!e || e.skip || !e.d) pic = k === 0 || prev?.d ? `<div class="rv-skip">${esc(by.name)} さんの絵はありません（時間切れ）</div>` : '';
    else {
      const req = requiredKana(r, c, k, e.guess);
      const shown = i > k; // 次のカードが出たら言葉を公開
      pic = `<div class="rv-pic">
        <div class="rv-pic-head">${avatar(by, 'sm')}<span>${esc(by.name)} さんが「<b>${esc(req)}</b>」から描いた絵</span></div>
        <canvas class="paper dcv" data-draw="${c}:${k}"></canvas>
        <div class="rv-pic-foot"><span class="word ${shown ? '' : 'hide'}">${shown ? `「${esc(e.word)}」` : '？？？'}</span><span data-like="${c}_${k}"></span></div>
      </div>`;
    }
  }
  return `<article class="rv-card" style="--d:${k}">${top}${pic}</article>`;
}
function markHTML(key) {
  const r = curRound(); if (!r) return '';
  const [c, k] = key.split('_').map(Number);
  const ok = linkOk(r, c, k), auto = sameWord(entry(r, c, k - 1)?.word, entry(r, c, k)?.guess);
  if (ok) return `<button class="mark ok ${auto ? '' : 'manual'}" ${auto ? 'disabled' : `data-action="toggle-ok" data-key="${key}"`} title="${auto ? '' : 'タップで取り消し'}">⭕${auto ? '' : '<small>おまけ</small>'}</button>`;
  return `<button class="mark ng" data-action="toggle-ok" data-key="${key}" title="ほぼ同じならタップで⭕に">❌<small>ほぼ正解なら⭕に</small></button>`;
}
function likeHTML(key) {
  const r = curRound(); if (!r) return '';
  const [c, k] = key.split('_').map(Number);
  const mine = !!r.likes?.[key]?.[S.pid], n = likeCount(r, c, k), own = entry(r, c, k)?.by === S.pid;
  return `<button class="like ${mine ? 'on' : ''}" ${own ? 'disabled title="自分の絵"' : `data-action="like" data-key="${key}"`}>${mine ? '❤️' : '🤍'}<b>${n || ''}</b></button>`;
}
function chainSummaryHTML(r, c) {
  const parts = [];
  for (let k = 0; k <= r.L; k++) {
    const e = entry(r, c, k);
    if (k > 0) {
      const ok = linkOk(r, c, k);
      parts.push(`<span class="g ${ok ? 'ok' : 'ng'}">${esc(e?.guess || '…')}</span>`);
    }
    if (k < r.L && e?.d) parts.push(`<span class="w">${esc(e.word)}</span>`);
  }
  let ok = 0; for (let k = 1; k <= r.L; k++) if (linkOk(r, c, k)) ok++;
  return `<section class="card chain-sum">
    <h3>この列のしりとり <small>${ok} / ${r.L} 伝わった${ok === r.L ? ' 🎉 完璧！' : ''}</small></h3>
    <div class="es-example">${parts.join('<i>→</i>')}</div>
    <p class="muted tiny">白＝描いた言葉　緑＝伝わった答え　赤＝別のものに見えた答え</p>
  </section>`;
}
function revealDyn() {
  const st = stateOf(), r = curRound(), last = st.rv.c === N(r) - 1 && st.rv.i === r.L;
  if (isHost()) {
    const label = st.rv.i < r.L ? '次へ ▶' : last ? '🏆 結果発表へ' : '次の列へ ▶';
    return `<div class="host-bar rv-bar"><button class="btn primary big" data-action="rv-next">${label}</button>
      ${!last ? '<button class="btn ghost wide" data-action="rv-skip">答え合わせを飛ばして結果へ</button>' : ''}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんがめくっています<span class="dots"></span><br><span class="small">気に入った絵には🤍をタップ！</span></div>`;
}
async function rvNext() {
  const st = stateOf(), r = curRound(); let { c, i } = st.rv;
  if (i < r.L) i++;
  else if (c < N(r) - 1) { c++; i = 0; }
  else return toResult();
  await S.store.set(`${roomPath()}/state/rv`, { c, i });
}
async function toResult() {
  await S.store.update(roomPath(), { 'state/phase': 'result', [`rounds/${rk(stateOf().round)}/done`]: true });
}

// ---------- 結果 ----------
function resultView() {
  const r = curRound(), stats = roundStats(r), tot = totals();
  const ps = r.order.map((id) => ({ ...player(id), ...(stats[id] || { pts: 0, read: 0, sent: 0, likes: 0 }) })).sort((a, b) => b.pts - a.pts);
  let links = 0, okLinks = 0;
  for (let c = 0; c < N(r); c++) for (let k = 1; k <= r.L; k++) { links++; if (linkOk(r, c, k)) okLinks++; }
  const awards = [];
  const best = (k, icon, label, desc) => {
    const max = Math.max(0, ...ps.map((p) => p[k]));
    if (max > 0) awards.push({ icon, label, desc: desc(max), who: ps.filter((p) => p[k] === max) });
  };
  best('likes', '🎨', '画伯賞', (v) => `いいね ${v}個`);
  best('sent', '📮', '伝える力', (v) => `絵が伝わった ${v}回`);
  best('read', '🔍', '解読王', (v) => `絵を当てた ${v}回`);
  // いいねの多い絵ベスト3
  const pics = [];
  for (let c = 0; c < N(r); c++) for (let k = 0; k < r.L; k++) { const e = entry(r, c, k); if (e?.d) pics.push({ c, k, e, n: likeCount(r, c, k) }); }
  const top = pics.filter((p) => p.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  const all = [...ps.map((p) => p.id), ...playerList().map((p) => p.id)].filter((v, i, a) => a.indexOf(v) === i);
  const standings = all.map((id) => ({ ...player(id), t: tot[id] || 0 })).sort((a, b) => b.t - a.t);
  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>ラウンド${stateOf().round} 結果</h2>
      <p class="muted small">伝わった率 <b>${links ? Math.round((okLinks / links) * 100) : 0}%</b>（${okLinks} / ${links}）</p>
    </section>
    <section class="card"><h3>今回の得点</h3><ul class="standings">${ps.map((p) => `
      <li class="${p.id === S.pid ? 'me' : ''}">${avatar(p, 'sm')}<span class="nm">${esc(p.name)}</span><span class="muted tiny">伝わった${p.sent}・当てた${p.read}・❤️${p.likes}</span><b>+${p.pts}<small>pt</small></b></li>`).join('')}</ul></section>
    ${awards.length ? `<h3 class="sec-title">称号</h3><div class="awards">${awards.map((a) => `
      <div class="award"><div class="aw-icon">${a.icon}</div><div class="aw-body"><b>${a.label}</b><span>${a.who.map((w) => esc(w.name)).join('、')}</span><small class="muted">${a.desc}</small></div></div>`).join('')}</div>` : ''}
    ${top.length ? `<h3 class="sec-title">いいねが多かった絵</h3><div class="gallery">${top.map((p) => `
      <figure class="gal"><canvas class="paper dcv" data-draw="${p.c}:${p.k}"></canvas><figcaption><b>「${esc(p.e.word)}」</b><span>${esc(player(p.e.by).name)}・❤️${p.n}</span></figcaption></figure>`).join('')}</div>` : ''}
    <h3 class="sec-title">トータル順位</h3>
    <section class="card"><ol class="standings">${standings.map((p) => {
      const rank = 1 + standings.filter((q) => q.t > p.t).length;
      return `<li class="${p.id === S.pid ? 'me' : ''}"><span class="rank r${rank}">${rank}</span>${avatar(p, 'sm')}<span class="nm">${esc(p.name)}</span><b>${p.t}<small>pt</small></b></li>`;
    }).join('')}</ol></section>
    <div id="dyn"></div>`;
}
function resultDyn() {
  if (isHost()) {
    const n = onlinePlayers().length;
    return `<div class="host-bar">
      <button class="btn primary big" data-action="start" ${n < 3 ? 'disabled' : ''}>${n < 3 ? '3人以上必要です' : '🔁 もう1ラウンド'}</button>
      <button class="btn ghost wide" data-action="to-lobby">ロビーに戻る（得点リセット）</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}
async function toLobby() {
  if (!confirm('ロビーに戻りますか？（得点はリセットされます）')) return;
  S.confettiDone = {};
  await S.store.update(roomPath(), { state: { phase: 'lobby', round: 0 }, rounds: null });
}

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = pageUrl('eshiri.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'えしりとり', text: `えしりとりで遊ぼう！部屋コード：${S.code}`, url: pageUrl('eshiri.html', S.code) }); } catch {}
}

const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  'set-timer': (el) => S.store.set(`${roomPath()}/meta/timer`, +el.dataset.t),
  'set-len': (el) => S.store.set(`${roomPath()}/meta/len`, +el.dataset.l),
  start: startRound,
  'guess-next': guessNext,
  'submit-guess': () => submitGuess(false),
  'back-guess': () => { S.play.guessed = false; saveDraft(); render(); },
  'submit-draw': () => submitDraw(false),
  color: (el) => { S.play.color = +el.dataset.i; if (S.play.color === ERASER && S.play.width < 2) S.play.width = 2; saveDraft(); paintPad(); },
  width: (el) => { S.play.width = +el.dataset.i; saveDraft(); paintPad(); },
  undo: () => { S.play.strokes.pop(); saveDraft(); paintPad(); },
  clear: () => { if (confirm('絵を全部消しますか？')) { S.play.strokes = []; saveDraft(); paintPad(); } },
  'force-next': forceNext,
  'rv-next': rvNext,
  'rv-skip': () => { if (confirm('残りの答え合わせを飛ばして結果へ進みますか？')) return toResult(); },
  like: (el) => {
    const p = `${roundPath()}/likes/${el.dataset.key}/${S.pid}`;
    return curRound()?.likes?.[el.dataset.key]?.[S.pid] ? S.store.remove(p) : S.store.set(p, true);
  },
  'toggle-ok': (el) => {
    const p = `${roundPath()}/ok/${el.dataset.key}`;
    return curRound()?.ok?.[el.dataset.key] ? S.store.remove(p) : S.store.set(p, true);
  },
  'to-lobby': toLobby,
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
$app.addEventListener('pointerdown', onPointerDown);
$app.addEventListener('pointermove', onPointerMove);
$app.addEventListener('pointerup', onPointerUp);
$app.addEventListener('pointercancel', onPointerUp);
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const t = e.target;
  if (t.id === 'name' || t.id === 'code') {
    e.preventDefault();
    (document.querySelector('[data-action="join"][data-code]') || (document.getElementById('code')?.value ? document.querySelector('[data-action="join"]') : document.querySelector('[data-action="create"]')))?.click();
  } else if (t.id === 'guess') { e.preventDefault(); document.querySelector('[data-action="guess-next"],[data-action="submit-guess"]')?.click(); }
  else if (t.id === 'word') { e.preventDefault(); t.blur(); }
});
$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'code') t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.id === 'guess' && S.play) { S.play.guess = t.value; saveDraft(); }
  if (t.id === 'word' && S.play) { S.play.word = t.value; saveDraft(); wordHint(); }
});

boot();
