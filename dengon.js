// =============================================================
//  お絵かき伝言 — お題 → 絵 → 答え → 絵 → … と伝言していくゲーム
//  ・「お題を書く」「描く」「当てる」はそれぞれ別のターン（制限時間も別）
//  ・列はターンごとにランダムな人へ。ただし自分のお題・一度関わった列は回ってこない
//  ・最後に1列ずつ答え合わせ。絵が伝わったら描いた人と当てた人に +1
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, shuffle, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';
import { ERASER, MAX_STROKES, encDrawing, decDrawing, paint, toolsHTML, buildAssign } from './drawkit.js';
import { EKAKI_PRESETS } from './ekaki-presets.js';

// ---------- 定数 ----------
const GAME = 'dengon';
const AVATAR_COLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];
const TIMER_OPTIONS = { write: [20, 30, 60, 0], draw: [60, 90, 120, 0], guess: [20, 30, 60, 0] };
const TIMER_DEFAULT = { write: 30, draw: 90, guess: 30 };
const KIND_LABEL = { write: 'お題を書く', draw: '描く', guess: '当てる' };
const SUGGEST = EKAKI_PRESETS.flatMap((c) => c.words.map((w) => w.split('|')[0]));

const $app = document.getElementById('app');
const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null, viewKey: '',
  play: null, drawing: null, tick: null, hostBusy: '', autoSent: '', confettiDone: {},
};

// ---------- 文字の比較 ----------
function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[\s　・、。,.!！?？「」『』'"〜~ー-]/g, '')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
const sameText = (a, b) => !!norm(a) && norm(a) === norm(b);

// ---------- ルーム状態 ----------
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
function settings() {
  const m = S.room?.meta || {};
  return { write: m.tWrite ?? TIMER_DEFAULT.write, draw: m.tDraw ?? TIMER_DEFAULT.draw, guess: m.tGuess ?? TIMER_DEFAULT.guess, len: m.len ?? 0 };
}
const N = (r) => r?.order?.length || 0;
const entry = (r, c, k) => r?.chains?.[c]?.[k] || null;
const kindOf = (k) => (k === 0 ? 'write' : k % 2 === 1 ? 'draw' : 'guess');
const workerOf = (r, c, k) => r.assign[k][c];
const myChain = (r, k) => (r.assign[k] || []).indexOf(S.pid);
const inRound = (r) => !!r && r.order?.includes(S.pid);

// 列cのステップkより前で、いちばん新しい「文字（お題・答え）」
function lastText(r, c, k) {
  for (let j = k - 1; j >= 0; j--) { const e = entry(r, c, j); if (e?.text && !e.skip) return e.text; }
  return '';
}
// 列cのステップkより前で、いちばん新しい「絵」
function lastDrawingIdx(r, c, k) {
  for (let j = k - 1; j >= 1; j--) { const e = entry(r, c, j); if (e?.d && !e.skip) return j; }
  return -1;
}

// ---------- 得点 ----------
function linkOk(r, c, k) { // ステップk（当てる）が、直前の絵を当てたか
  const a = entry(r, c, k - 1), b = entry(r, c, k);
  if (!a || !b || a.skip || b.skip || !a.d || !b.text) return false;
  return !!r.ok?.[`${c}_${k}`] || sameText(a.src, b.text);
}
const likeCount = (r, c, k) => Object.keys(r?.likes?.[`${c}_${k}`] || {}).length;
function roundStats(r) {
  const s = {};
  const get = (id) => (s[id] ||= { pts: 0, read: 0, sent: 0, likes: 0 });
  for (let c = 0; c < N(r); c++) {
    for (let k = 2; k <= r.S; k += 2) if (linkOk(r, c, k)) { get(entry(r, c, k - 1).by).sent++; get(entry(r, c, k).by).read++; }
    for (let k = 1; k <= r.S; k += 2) { const e = entry(r, c, k); if (e?.d) get(e.by).likes += likeCount(r, c, k); }
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
      <li><b>📝 お題を書く</b>：全員が好きなお題を1つ書く</li>
      <li><b>🖍 描く</b>：だれかのお題が届くので、それを絵にする</li>
      <li><b>💬 当てる</b>：だれかの絵が届くので、何の絵か答える</li>
      <li>「描く」「当てる」を交互にくり返して、最後に1列ずつ答え合わせ！</li>
    </ol>
    <p class="muted small">お題や絵が誰に届くかは毎回ランダム。でも<b>自分が書いたお題や、一度関わった列は回ってきません</b>。</p>
    <div class="score-legend">
      <span>⭕ 絵が伝わった <b>描いた人 +1・当てた人 +1</b></span>
      <span>❤️ 気に入った絵にはいいね</span>
    </div>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo dg-logo">
      <div class="dg-chain"><span>📝</span><b>→</b><span>🖼</span><b>→</b><span>💬</span></div>
      <h1>お絵かき伝言</h1>
      <p>お題が絵に、絵が答えに。最後はいったい何になる？</p>
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
  await S.store.set(`rooms/${code}`, { meta: { game: GAME, createdAt: Date.now() }, state: { phase: 'lobby', round: 0 } });
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
  S.code = code; S.viewKey = '';
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
//  進行（ホスト）
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    S.unsub?.(); S.stopPresence?.(); clearInterval(S.tick);
    sessionStorage.removeItem(ROOM_KEY); setUrlRoom(null);
    S.code = null; S.room = null; toast('部屋が見つかりません'); renderHome(); return;
  }
  if (followRoom(room, GAME, S.code)) { S.unsub?.(); clearInterval(S.tick); return; }
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
  if (st.deadline && S.store.now() > st.deadline + 8000) hostDo(`fill:${st.round}:${k}`, () => fillMissing(k));
}
const timerFor = (k) => settings()[kindOf(k)];
async function advance(k) {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'play' || st.step !== k) return;
  if (k + 1 <= r.S) {
    const t = timerFor(k + 1);
    await S.store.update(roomPath(), { 'state/step': k + 1, 'state/deadline': t ? S.store.now() + t * 1000 : 0 });
  } else {
    await S.store.update(roomPath(), { 'state/phase': 'reveal', 'state/rv': { c: 0, i: 0 }, 'state/deadline': 0 });
  }
}
async function fillMissing(k) {
  const st = stateOf(), r = curRound(); if (st.step !== k) return;
  const upd = {};
  for (let c = 0; c < N(r); c++) {
    if (entry(r, c, k)) continue;
    const by = workerOf(r, c, k);
    // お題が書かれなかった列は、ランダムなお題で続ける
    upd[`rounds/${rk(st.round)}/chains/${c}/${k}`] = k === 0
      ? { by, text: SUGGEST[Math.floor(Math.random() * SUGGEST.length)], auto: true }
      : { by, skip: true };
  }
  if (Object.keys(upd).length) await S.store.update(roomPath(), upd);
}
async function startRound() {
  const ids = shuffle(onlinePlayers().map((p) => p.id));
  if (ids.length < 3) return toast('3人以上いないと始められません');
  const { len } = settings();
  const S_ = len ? Math.min(len, ids.length - 1) : ids.length - 1; // お題のあと何ターン続くか
  const assign = buildAssign(ids.length, S_ + 1).map((row) => row.map((i) => ids[i]));
  const n = stateOf().round + 1, t = settings().write;
  await S.store.update(roomPath(), {
    state: { phase: 'play', round: n, step: 0, deadline: t ? S.store.now() + t * 1000 : 0 },
    [`rounds/${rk(n)}`]: { order: ids, S: S_, assign, startedAt: Date.now() },
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
  if (st.phase === 'play') key += `|${st.step}|${inRound(r) ? subState(r, st.step) : 'spectate'}`;
  if (st.phase === 'reveal') key += `|${st.rv?.c}|${st.rv?.i}`;
  if (key !== S.viewKey) {
    const prev = S.viewKey; S.viewKey = key;
    const views = { lobby: lobbyView, play: playView, reveal: revealView, result: resultView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main dengon phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    afterRender(prev);
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
function afterRender(prev) {
  const st = stateOf();
  if (st.phase === 'play') { paintPrev(); paintPad(); paintAll(); }
  if (st.phase === 'reveal') {
    paintAll();
    if (prev.startsWith(`reveal|${st.round}|${st.rv?.c}|`)) document.querySelector('.rv-card:last-of-type')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: 0 });
    const r = curRound();
    if (st.rv.i === r.S && !S.confettiDone[`${st.round}:${st.rv.c}`]) {
      S.confettiDone[`${st.round}:${st.rv.c}`] = true;
      if (finalMatches(r, st.rv.c)) setTimeout(() => confetti(120), 300);
    }
  } else window.scrollTo({ top: 0 });
  if (st.phase === 'result') { paintAll(); if (!S.confettiDone[`res${st.round}`]) { S.confettiDone[`res${st.round}`] = true; setTimeout(() => confetti(100), 300); } }
}
window.addEventListener('resize', () => { paintPrev(); paintPad(); paintAll(); });

function phaseChipHTML() {
  const st = stateOf(), r = curRound();
  if (st.phase === 'play' && r) return `<b>${st.step + 1}/${r.S + 1}</b><span>${KIND_LABEL[kindOf(st.step)]}</span>`;
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
      <div class="ptags">${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${st.phase !== 'lobby' ? `<span class="pscore">${tot[p.id] || 0}pt</span>` : ''}${st.phase === 'play' && r?.order?.includes(p.id) ? (doneSet.has(p.id) ? '<span class="tag ok">✓</span>' : '<span class="tag wip">✏️</span>') : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
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
  const ps = playerList(), host = isHost(), st = settings(), n = onlinePlayers().length, h = hostId();
  const steps = st.len ? Math.min(st.len, Math.max(n - 1, 0)) : Math.max(n - 1, 0);
  const draws = Math.ceil(steps / 2), guesses = Math.floor(steps / 2);
  const est = st.write + draws * st.draw + guesses * st.guess;
  const seg = (kind, key) => TIMER_OPTIONS[kind].map((t) => `<button class="seg-btn ${st[kind] === t ? 'on' : ''}" data-action="set-timer" data-k="${key}" data-t="${t}" ${host ? '' : 'disabled'}>${t ? t + '秒' : 'なし'}</button>`).join('');
  return `<section class="card">
      <h3>参加メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>📝 お題を書く時間</h3><div class="seg">${seg('write', 'tWrite')}</div>
      <h3 class="mt">🖍 描く時間</h3><div class="seg">${seg('draw', 'tDraw')}</div>
      <h3 class="mt">💬 当てる時間</h3><div class="seg">${seg('guess', 'tGuess')}</div>
      <h3 class="mt">伝言の長さ</h3>
      <div class="seg">${[0, 4, 6].map((l) => `<button class="seg-btn ${st.len === l ? 'on' : ''}" data-action="set-len" data-l="${l}" ${host ? '' : 'disabled'}>${l ? l + 'ターンまで' : '全員分'}</button>`).join('')}</div>
      <p class="muted small">${n >= 3 ? `お題のあと「描く」${draws}回・「当てる」${guesses}回。${st.write && st.draw && st.guess ? `目安 約${Math.ceil(est / 60)}分` : ''}` : '3人から遊べます'}${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start" ${n < 3 ? 'disabled' : ''}>${n < 3 ? `あと${3 - n}人集まったら開始できます` : 'ゲームスタート！'}</button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- プレイ ----------
const myEntry = (r, k) => { const c = myChain(r, k); return c < 0 ? null : entry(r, c, k); };
function subState(r, k) {
  if (myEntry(r, k)) return 'done';
  ensurePlay(r, k);
  const c = myChain(r, k), kind = kindOf(k);
  if (kind === 'guess' && lastDrawingIdx(r, c, k) < 0) return 'none';
  return kind;
}
function ensurePlay(r, k) {
  const key = `${S.code}:${stateOf().round}:${k}`;
  if (S.play?.key === key) return;
  let saved = null;
  try { const d = JSON.parse(sessionStorage.getItem('dengon.draft')); if (d?.key === key) saved = d; } catch {}
  S.play = saved || { key, text: '', strokes: [], color: 0, width: 1 };
  S.drawing = null;
}
function saveDraft() { try { sessionStorage.setItem('dengon.draft', JSON.stringify(S.play)); } catch {} }
function timerHTML(kind) { return `<div class="es-timer k-${kind}" id="timer"><i></i><span></span></div>`; }
function updateTimer() {
  const el = document.getElementById('timer'); if (!el) return;
  const st = stateOf();
  if (st.phase !== 'play' || !st.deadline) { el.classList.add('none'); return; }
  const total = (timerFor(st.step) || 1) * 1000, left = Math.max(0, st.deadline - S.store.now()), sec = Math.ceil(left / 1000);
  el.classList.toggle('warn', sec <= 10);
  el.querySelector('i').style.width = `${Math.min(100, (left / total) * 100)}%`;
  el.querySelector('span').textContent = left > 0 ? `${KIND_LABEL[kindOf(st.step)]}　残り ${sec}秒` : '時間切れ！';
}
function playView() {
  const st = stateOf(), r = curRound(), k = st.step, kind = kindOf(k);
  if (!inRound(r)) return `${timerHTML(kind)}<section class="card center"><h2>観戦中</h2><p class="muted">途中参加のため、次のラウンドから参加できます</p></section><div id="dyn"></div>`;
  const sub = subState(r, k), c = myChain(r, k);
  if (sub === 'done') {
    const e = myEntry(r, k);
    return `${timerHTML(kind)}<section class="card center done-card">
        <div class="big-check">✓</div><h2>提出しました！</h2>
        ${e.d ? `<canvas class="paper mini-paper dcv" data-draw="${c}:${k}"></canvas>` : e.text ? `<p class="muted">「${esc(e.text)}」</p>` : ''}
        <p class="muted small">次は「${KIND_LABEL[kindOf(k + 1)] || '答え合わせ'}」${k + 1 <= r.S ? '。だれかの列が届きます' : ''}</p>
      </section><div id="dyn"></div>`;
  }
  if (sub === 'none') return `${timerHTML(kind)}<section class="card center"><p>前の人が時間切れで絵がなかったので、このターンはお休みです☕</p></section><div id="dyn"></div>`;
  if (sub === 'write') {
    return `${timerHTML(kind)}
      <section class="step-head"><div class="kind-badge write">📝 お題を書く</div><h2>みんなに描いてほしいお題を書こう</h2>
        <p class="muted small">だれかがこれを絵にします。「空飛ぶペンギン」みたいな少しひねったお題も楽しい！</p></section>
      <section class="card guess-box">
        <input id="text" maxlength="30" placeholder="例：寝坊したサンタクロース" value="${esc(S.play.text)}" autocomplete="off" enterkeyhint="done">
        <div class="row" style="margin-top:10px"><button class="btn small" data-action="suggest">🎲 おまかせ</button><button class="btn primary grow" data-action="submit-text">このお題で決定</button></div>
      </section><div id="dyn"></div>`;
  }
  if (sub === 'draw') {
    const prompt = lastText(r, c, k) || '（お題なし：好きなものを描こう）';
    const from = player(entry(r, c, k - 1)?.by);
    return `${timerHTML(kind)}
      <section class="step-head"><div class="kind-badge draw">🖍 描く</div>
        <div class="sh-from">${k > 1 ? `${avatar(from, 'sm')}<span>${esc(from.name)} さんの答え</span>` : '<span>だれかのお題</span>'}</div>
        <h2 class="prompt">「${esc(prompt)}」</h2><p class="muted small">これを絵にしよう（文字を書くのはナシ！）</p></section>
      <div class="pad-wrap"><canvas class="paper big-paper" id="pad"></canvas></div>
      <div class="tools" id="tools"></div>
      <button class="btn primary big" data-action="submit-draw">この絵で提出する</button>
      <div id="dyn"></div>`;
  }
  // guess
  const di = lastDrawingIdx(r, c, k), from = player(entry(r, c, di)?.by);
  return `${timerHTML(kind)}
    <section class="step-head"><div class="kind-badge guess">💬 当てる</div>
      <div class="sh-from">${avatar(from, 'sm')}<span>${esc(from.name)} さんの絵</span></div><h2>これは何の絵？</h2></section>
    <canvas class="paper big-paper" id="prev"></canvas>
    <section class="card guess-box">
      <div class="join-row"><input id="text" maxlength="30" placeholder="答えを入力" value="${esc(S.play.text)}" autocomplete="off" enterkeyhint="done"><button class="btn primary" data-action="submit-text">回答</button></div>
      <p class="muted tiny">${k < r.S ? 'あなたの答えが、次の人のお題になります' : 'あなたの答えで、この列はおしまい！'}</p>
    </section><div id="dyn"></div>`;
}
function paintPrev() {
  const cv = document.getElementById('prev'); if (!cv) return;
  const r = curRound(), k = stateOf().step, c = myChain(r, k), di = lastDrawingIdx(r, c, k);
  paint(cv, decDrawing(di >= 0 ? entry(r, c, di).d : ''));
}
function paintPad() {
  const cv = document.getElementById('pad'); if (!cv || !S.play) return;
  paint(cv, S.drawing ? [...S.play.strokes, S.drawing] : S.play.strokes);
  setHTML(document.getElementById('tools'), toolsHTML(S.play));
}
function paintAll() {
  document.querySelectorAll('canvas[data-draw]').forEach((cv) => {
    const [c, k] = cv.dataset.draw.split(':').map(Number);
    paint(cv, decDrawing(entry(curRound(), c, k)?.d));
  });
}
function playDyn() {
  const st = stateOf(), r = curRound(); if (!r) return '';
  const k = st.step;
  let done = 0; for (let c = 0; c < N(r); c++) if (entry(r, c, k)) done++;
  let html = `<section class="card status"><h3>提出した人 <small>${done} / ${N(r)}</small></h3>
    <div class="progress"><i style="width:${(done / N(r)) * 100}%"></i></div></section>`;
  if (isHost() && done < N(r) && (!inRound(r) || myEntry(r, k))) {
    const off = []; for (let c = 0; c < N(r); c++) if (!entry(r, c, k)) { const p = player(workerOf(r, c, k)); if (!p.online) off.push(p); }
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
async function submitText(auto = false) {
  const st = stateOf(), r = curRound(), k = st.step, c = myChain(r, k);
  if (st.phase !== 'play' || c < 0 || myEntry(r, k) || kindOf(k) === 'draw') return;
  let v = (document.getElementById('text')?.value ?? S.play.text).trim();
  if (!v && !auto) { toast(k === 0 ? 'お題を書いてね' : '答えを入力してね'); document.getElementById('text')?.focus(); return; }
  if (!v) v = k === 0 ? SUGGEST[Math.floor(Math.random() * SUGGEST.length)] : '？';
  await S.store.set(`${roundPath()}/chains/${c}/${k}`, { by: S.pid, text: v.slice(0, 30), ...(auto ? { late: true } : {}) });
}
async function submitDraw(auto = false) {
  const st = stateOf(), r = curRound(), k = st.step, c = myChain(r, k);
  if (st.phase !== 'play' || c < 0 || myEntry(r, k) || kindOf(k) !== 'draw') return;
  if (!auto && !S.play.strokes.length) { toast('絵を描いてね'); return; }
  await S.store.set(`${roundPath()}/chains/${c}/${k}`, { by: S.pid, d: encDrawing(S.play.strokes), src: lastText(r, c, k), ...(auto ? { late: true } : {}) });
}
function autoSubmitIfLate() {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'play' || !st.deadline || !inRound(r) || S.store.now() < st.deadline) return;
  const k = st.step; if (myEntry(r, k)) return;
  const key = `${st.round}:${k}`; if (S.autoSent === key) return;
  S.autoSent = key;
  const sub = subState(r, k);
  if (sub === 'none') S.store.set(`${roundPath()}/chains/${myChain(r, k)}/${k}`, { by: S.pid, skip: true });
  else if (sub === 'draw') submitDraw(true);
  else submitText(true);
  toast('時間切れ！ 今の状態で提出しました');
}
async function forceNext() {
  if (!confirm('まだ提出していない人を飛ばして次へ進みますか？')) return;
  await fillMissing(stateOf().step);
}

// ---------- 答え合わせ ----------
function finalMatches(r, c) {
  const first = entry(r, c, 0)?.text, last = entry(r, c, r.S);
  return !!last?.text && sameText(first, last.text);
}
function revealView() {
  const st = stateOf(), r = curRound(), c = st.rv.c, i = st.rv.i;
  const owner = player(entry(r, c, 0)?.by || r.assign[0][c]);
  let cards = '';
  for (let k = 0; k <= i; k++) cards += cardHTML(r, c, k);
  return `<section class="rv-head">
      <div class="rv-dots">${r.order.map((_, j) => `<i class="${j < c ? 'past' : j === c ? 'cur' : ''}"></i>`).join('')}</div>
      <h2>${avatar(owner, 'sm')} ${esc(owner.name)} さんのお題から</h2>
    </section>
    <div class="rv-list">${cards}</div>
    ${i === r.S ? summaryHTML(r, c) : ''}
    <div id="dyn"></div>`;
}
function cardHTML(r, c, k) {
  const e = entry(r, c, k), by = player(e?.by || r.assign[k][c]), kind = kindOf(k);
  if (!e || e.skip) return `<article class="rv-card"><div class="rv-skip">${esc(by.name)} さんは時間切れ…</div></article>`;
  if (kind === 'write') {
    return `<article class="rv-card"><div class="rv-text write">${avatar(by, 'sm')}<span>${esc(by.name)} さんのお題</span><b>「${esc(e.text)}」</b>${e.auto ? '<small class="muted">（おまかせ）</small>' : ''}</div></article>`;
  }
  if (kind === 'draw') {
    return `<article class="rv-card"><div class="rv-pic">
      <div class="rv-pic-head">${avatar(by, 'sm')}<span>${esc(by.name)} さんが描いた絵</span></div>
      <canvas class="paper dcv" data-draw="${c}:${k}"></canvas>
      <div class="rv-pic-foot"><span class="muted small">お題：「${esc(e.src || '—')}」</span><span data-like="${c}_${k}"></span></div>
    </div></article>`;
  }
  return `<article class="rv-card"><div class="rv-text guess">${avatar(by, 'sm')}<span>${esc(by.name)} さんには</span><b>「${esc(e.text)}」</b><span>に見えた</span><span data-mark="${c}_${k}"></span></div></article>`;
}
function markHTML(key) {
  const r = curRound(); if (!r) return '';
  const [c, k] = key.split('_').map(Number);
  if (!entry(r, c, k - 1)?.d) return '';
  const ok = linkOk(r, c, k), auto = sameText(entry(r, c, k - 1)?.src, entry(r, c, k)?.text);
  if (ok) return `<button class="mark ok ${auto ? '' : 'manual'}" ${auto ? 'disabled' : `data-action="toggle-ok" data-key="${key}"`}>⭕${auto ? '' : '<small>おまけ</small>'}</button>`;
  return `<button class="mark ng" data-action="toggle-ok" data-key="${key}" title="ほぼ同じならタップで⭕に">❌<small>ほぼ正解なら⭕に</small></button>`;
}
function likeHTML(key) {
  const r = curRound(); if (!r) return '';
  const [c, k] = key.split('_').map(Number);
  const mine = !!r.likes?.[key]?.[S.pid], n = likeCount(r, c, k), own = entry(r, c, k)?.by === S.pid;
  return `<button class="like ${mine ? 'on' : ''}" ${own ? 'disabled title="自分の絵"' : `data-action="like" data-key="${key}"`}>${mine ? '❤️' : '🤍'}<b>${n || ''}</b></button>`;
}
function summaryHTML(r, c) {
  const first = entry(r, c, 0)?.text || '—';
  const lastE = entry(r, c, r.S);
  const last = lastE?.text || (lastE?.d ? '（絵で終了）' : '—');
  const match = finalMatches(r, c);
  let ok = 0, links = 0;
  for (let k = 2; k <= r.S; k += 2) { links++; if (linkOk(r, c, k)) ok++; }
  return `<section class="card chain-sum ${match ? 'perfect' : ''}">
    <h3>${match ? '🎉 最初のお題が最後まで伝わった！' : 'はじめと最後をくらべると…'}</h3>
    <div class="sum-row"><div><small>最初のお題</small><b>「${esc(first)}」</b></div><i>→</i><div><small>最後</small><b>「${esc(last)}」</b></div></div>
    <p class="muted tiny center">途中で伝わった回数 ${ok} / ${links}</p>
  </section>`;
}
function revealDyn() {
  const st = stateOf(), r = curRound(), last = st.rv.c === N(r) - 1 && st.rv.i === r.S;
  if (isHost()) {
    const label = st.rv.i < r.S ? '次へ ▶' : last ? '🏆 結果発表へ' : '次の列へ ▶';
    return `<div class="host-bar rv-bar"><button class="btn primary big" data-action="rv-next">${label}</button>
      ${!last ? '<button class="btn ghost wide" data-action="rv-skip">答え合わせを飛ばして結果へ</button>' : ''}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんがめくっています<span class="dots"></span><br><span class="small">気に入った絵には🤍をタップ！</span></div>`;
}
async function rvNext() {
  const st = stateOf(), r = curRound(); let { c, i } = st.rv;
  if (i < r.S) i++;
  else if (c < N(r) - 1) { c++; i = 0; }
  else return toResult();
  await S.store.set(`${roomPath()}/state/rv`, { c, i });
}
async function toResult() { await S.store.update(roomPath(), { 'state/phase': 'result', [`rounds/${rk(stateOf().round)}/done`]: true }); }

// ---------- 結果 ----------
function resultView() {
  const r = curRound(), stats = roundStats(r), tot = totals();
  const ps = r.order.map((id) => ({ ...player(id), ...(stats[id] || { pts: 0, read: 0, sent: 0, likes: 0 }) })).sort((a, b) => b.pts - a.pts);
  let links = 0, okLinks = 0, perfect = 0;
  for (let c = 0; c < N(r); c++) { if (finalMatches(r, c)) perfect++; for (let k = 2; k <= r.S; k += 2) { links++; if (linkOk(r, c, k)) okLinks++; } }
  const awards = [];
  const best = (k, icon, label, desc) => {
    const max = Math.max(0, ...ps.map((p) => p[k]));
    if (max > 0) awards.push({ icon, label, desc: desc(max), who: ps.filter((p) => p[k] === max) });
  };
  best('likes', '🎨', '画伯賞', (v) => `いいね ${v}個`);
  best('sent', '📮', '伝える力', (v) => `絵が伝わった ${v}回`);
  best('read', '🔍', '解読王', (v) => `絵を当てた ${v}回`);
  const pics = [];
  for (let c = 0; c < N(r); c++) for (let k = 1; k <= r.S; k += 2) { const e = entry(r, c, k); if (e?.d) pics.push({ c, k, e, n: likeCount(r, c, k) }); }
  const top = pics.filter((p) => p.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
  const all = [...ps.map((p) => p.id), ...playerList().map((p) => p.id)].filter((v, i, a) => a.indexOf(v) === i);
  const standings = all.map((id) => ({ ...player(id), t: tot[id] || 0 })).sort((a, b) => b.t - a.t);
  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>ラウンド${stateOf().round} 結果</h2>
      <p class="muted small">伝わった率 <b>${links ? Math.round((okLinks / links) * 100) : 0}%</b>（${okLinks} / ${links}）${perfect ? `　最後まで伝わった列 ${perfect}本🎉` : ''}</p>
    </section>
    <section class="card"><h3>今回の得点</h3><ul class="standings">${ps.map((p) => `
      <li class="${p.id === S.pid ? 'me' : ''}">${avatar(p, 'sm')}<span class="nm">${esc(p.name)}</span><span class="muted tiny">伝わった${p.sent}・当てた${p.read}・❤️${p.likes}</span><b>+${p.pts}<small>pt</small></b></li>`).join('')}</ul></section>
    ${awards.length ? `<h3 class="sec-title">称号</h3><div class="awards">${awards.map((a) => `
      <div class="award"><div class="aw-icon">${a.icon}</div><div class="aw-body"><b>${a.label}</b><span>${a.who.map((w) => esc(w.name)).join('、')}</span><small class="muted">${a.desc}</small></div></div>`).join('')}</div>` : ''}
    ${top.length ? `<h3 class="sec-title">いいねが多かった絵</h3><div class="gallery">${top.map((p) => `
      <figure class="gal"><canvas class="paper dcv" data-draw="${p.c}:${p.k}"></canvas><figcaption><b>「${esc(p.e.src || '')}」</b><span>${esc(player(p.e.by).name)}・❤️${p.n}</span></figcaption></figure>`).join('')}</div>` : ''}
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
  const url = pageUrl('dengon.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'お絵かき伝言', text: `お絵かき伝言で遊ぼう！部屋コード：${S.code}`, url: pageUrl('dengon.html', S.code) }); } catch {}
}
const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  'set-timer': (el) => S.store.set(`${roomPath()}/meta/${el.dataset.k}`, +el.dataset.t),
  'set-len': (el) => S.store.set(`${roomPath()}/meta/len`, +el.dataset.l),
  start: startRound,
  suggest: () => {
    const el = document.getElementById('text');
    el.value = SUGGEST[Math.floor(Math.random() * SUGGEST.length)];
    S.play.text = el.value; saveDraft();
  },
  'submit-text': () => submitText(false),
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
  } else if (t.id === 'text') { e.preventDefault(); document.querySelector('[data-action="submit-text"]')?.click(); }
});
$app.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'code') t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.id === 'text' && S.play) { S.play.text = t.value; saveDraft(); }
});

boot();
