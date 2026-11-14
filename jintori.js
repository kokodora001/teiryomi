// =============================================================
//  同時陣取り — 全員が同時にマスを選ぶ陣取りゲーム
//  ・自分の陣地のとなりの空きマスを1つ選ぶ（全員同時・相手には見えない）
//  ・自分だけが選んだマス → 自分の陣地／同じマスを選んだ → 岩
//  ・自分だけで囲んだ空きマスはまとめて自分の陣地（囲い込み）
//  ・★マスは3点。規定ターンか、誰も動けなくなったら終了
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, shuffle, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';
import {
  EMPTY, ROCK, ownerOf, newBoard, validMoves, resolveTurn, scoreBoard, cellCounts, anyoneCanMove, boardSize,
} from './jintori-rules.js';

const GAME = 'jintori';
const COLORS = ['#ff5a8a', '#4dc3ff', '#ffc145', '#6fdc8c', '#b98bff', '#ff8a4d'];
const MAX_PLAYERS = COLORS.length;
const REVEAL_MS = 1600; // 結果を見せる時間

const $app = document.getElementById('app');
const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null, viewKey: '', tick: null, hostBusy: '', confettiDone: {}, notified: '',
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
function player(id) { const p = S.room?.players?.[id]; return p ? { id, ...p } : { id, name: '???', online: false }; }
const stateOf = () => S.room?.state || { phase: 'lobby', game: 0 };
const curGame = () => S.room?.games?.[gk(stateOf().game)] || null;
function settings() {
  const m = S.room?.meta || {};
  return { turns: m.turns ?? 20, timer: m.timer ?? 15, stars: m.stars ?? true, capture: m.capture ?? true };
}
const myIdx = (g) => (g?.order || []).indexOf(S.pid);
const colorOf = (i) => COLORS[i % COLORS.length];
const myPick = (g, st) => { const p = g?.picks?.[S.pid]; return p && p.t === st.turn ? p.c : null; };
function pickedSet(g, st) {
  const s = new Set();
  for (const [id, p] of Object.entries(g?.picks || {})) if (p && p.t === st.turn) s.add(id);
  return s;
}
function winsTotal() {
  const w = {};
  for (const g of Object.values(S.room?.games || {})) {
    if (!g?.done) continue;
    const s = scoreBoard(g.board, g.stars, g.order.length), max = Math.max(...s);
    g.order.forEach((id, i) => { if (s[i] === max) w[id] = (w[id] || 0) + 1; });
  }
  return w;
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
      <li>全員が<b>同時に</b>、自分の陣地のとなり（上下左右）の空きマスを1つ選ぶ</li>
      <li>一斉に公開！ <b>自分だけ</b>が選んだマスは自分の陣地に</li>
      <li>2人以上が<b>同じマス</b>を選んだら「ぶつかり！」→ そのマスは<b>岩</b>になる</li>
      <li>自分の陣地（と盤の端・岩）だけで<b>囲んだ空きマス</b>は、まとめて自分のもの</li>
      <li>規定ターンが終わるか、誰も動けなくなったら終了。点数が多い人の勝ち</li>
    </ol>
    <div class="score-legend">
      <span>■ 陣地1マス <b>1点</b></span><span>★ ボーナスマス <b>3点</b></span>
    </div>
    <p class="muted small">相手が狙いそうなマスをあえて避けるか、わざとぶつけて岩で道をふさぐか。読み合いが勝負！</p>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo jt-logo">
      <div class="jt-mark">${'aab.b'.split('').concat('a#.bb'.split(''), 'aa★.b'.split('')).map((c) => `<i class="${c === 'a' ? 'pa' : c === 'b' ? 'pb' : c === '#' ? 'rk' : c === '★' ? 'st' : ''}">${c === '★' ? '★' : ''}</i>`).join('')}</div>
      <h1>同時陣取り</h1>
      <p>みんな同時にマスを選ぶ。ぶつかったら岩！</p>
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
async function enterRoom(code) {
  S.code = code; S.viewKey = '';
  sessionStorage.setItem(ROOM_KEY, code);
  setUrlRoom(code);
  await joinPlayer(S.store, code, S.pid, S.name, null);
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
  S.code = null; S.room = null; setUrlRoom(null); document.title = '同時陣取り — あそびば';
  renderHome();
}

// =============================================================
//  進行
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    S.unsub?.(); S.stopPresence?.(); clearInterval(S.tick);
    sessionStorage.removeItem(ROOM_KEY); setUrlRoom(null);
    S.code = null; S.room = null; toast('部屋が見つかりません'); renderHome(); return;
  }
  if (followRoom(room, GAME, S.code)) { S.unsub?.(); clearInterval(S.tick); return; }
  S.room = room;
  render();
  onTick();
}
function onTick() {
  if (!S.room) return;
  updateTimer();
  hostDuties();
}
// 選ぶ必要がある人（盤に動けるマスがある人）
function movers(g) { return g.order.map((id, i) => ({ id, i })).filter(({ i }) => validMoves(g.board, g.n, i).length > 0); }
function hostDuties() {
  if (!isHost()) return;
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return;
  const key = `res:${st.game}:${st.turn}`;
  if (S.hostBusy === key) return;
  const need = movers(g).filter(({ id }) => player(id).online);
  const picked = pickedSet(g, st);
  const allIn = need.every(({ id }) => picked.has(id));
  const late = st.deadline && S.store.now() > st.deadline + 600;
  if (allIn || late) {
    S.hostBusy = key;
    resolveNow().catch((e) => { console.error(e); S.hostBusy = ''; });
  }
}
async function resolveNow() {
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play') return;
  const picks = {}, auto = [];
  g.order.forEach((id, i) => {
    const moves = validMoves(g.board, g.n, i);
    if (!moves.length) return;
    const p = g.picks?.[id];
    if (p && p.t === st.turn && moves.includes(p.c)) picks[i] = p.c;
    else { picks[i] = moves[Math.floor(Math.random() * moves.length)]; auto.push(i); } // 時間切れ・切断はランダム
  });
  const res = resolveTurn(g.board, g.n, picks, { capture: g.capture });
  const stats = structuredClone(g.stats || {});
  const add = (i, k, v = 1) => { const id = g.order[i]; (stats[id] ||= { hit: 0, cap: 0 }); stats[id][k] += v; };
  for (const i of res.collided) add(i, 'hit');
  for (const c of res.captured) add(c.owner, 'cap', c.cells.length);
  const turnNo = st.turn + 1;
  const over = (g.maxTurns && turnNo >= g.maxTurns) || !anyoneCanMove(res.board, g.n, g.order.length);
  const now = S.store.now(), t = settings().timer;
  const base = `games/${gk(st.game)}`;
  await S.store.update(roomPath(), {
    [`${base}/board`]: res.board,
    [`${base}/picks`]: null,
    [`${base}/stats`]: stats,
    [`${base}/last`]: {
      turn: turnNo, picks, auto,
      claimed: res.claimed.map(([c]) => c), rocks: res.rocks,
      captured: res.captured.map((c) => ({ o: c.owner, cells: c.cells })),
    },
    ...(over
      ? { [`${base}/done`]: true, 'state/phase': 'result', 'state/deadline': 0, 'state/turn': turnNo }
      : { 'state/turn': turnNo, 'state/deadline': t ? now + REVEAL_MS + t * 1000 : 0, 'state/revealUntil': now + REVEAL_MS }),
  });
}
async function startGame() {
  const ids = shuffle(onlinePlayers().map((p) => p.id)).slice(0, MAX_PLAYERS);
  if (ids.length < 2) return toast('2人以上いないと始められません');
  const s = settings(), b = newBoard(ids.length, { stars: s.stars });
  const n = stateOf().game + 1, now = S.store.now();
  await S.store.update(roomPath(), {
    state: { phase: 'play', game: n, turn: 0, deadline: s.timer ? now + s.timer * 1000 : 0, revealUntil: 0 },
    [`games/${gk(n)}`]: { order: ids, n: b.n, board: b.board, stars: b.stars, maxTurns: s.turns, capture: s.capture, startedAt: Date.now() },
  });
}
async function pick(cell) {
  const st = stateOf(), g = curGame(), i = myIdx(g);
  if (st.phase !== 'play' || i < 0) return;
  if (!validMoves(g.board, g.n, i).includes(cell)) return;
  if (myPick(g, st) === cell) return;
  await S.store.set(`${gamePath()}/picks/${S.pid}`, { c: cell, t: st.turn });
}

// =============================================================
//  画面
// =============================================================
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }
function render() {
  if (!S.room) return;
  const st = stateOf();
  const key = `${st.phase}|${st.game}`;
  if (key !== S.viewKey) {
    S.viewKey = key;
    const views = { lobby: lobbyView, play: playView, result: resultView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main jtgame phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    window.scrollTo({ top: 0 });
    if (st.phase === 'result' && !S.confettiDone[st.game]) {
      S.confettiDone[st.game] = true;
      const g = curGame(), s = scoreBoard(g.board, g.stars, g.order.length), i = myIdx(g);
      if (i >= 0 && s[i] === Math.max(...s)) setTimeout(() => confetti(140, COLORS), 300);
    }
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('scoreboard'), scoreboardHTML());
  setHTML(document.getElementById('turn-banner'), turnBannerHTML());
  setHTML(document.getElementById('summary'), summaryHTML());
  setHTML(document.getElementById('board'), boardHTML(curGame(), { interactive: stateOf().phase === 'play' }));
  setHTML(document.getElementById('dyn'), dynHTML());
  notifyTurn();
  updateTimer();
}
function notifyTurn() {
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) { document.title = '同時陣取り — あそびば'; return; }
  const i = myIdx(g), need = i >= 0 && validMoves(g.board, g.n, i).length > 0 && myPick(g, st) === null;
  document.title = need ? '🟢 マスを選んで！ — 同時陣取り' : '同時陣取り — あそびば';
  const key = `${st.game}:${st.turn}`;
  if (need && S.notified !== key) { S.notified = key; if (navigator.vibrate) try { navigator.vibrate(20); } catch {} }
}
function dynHTML() {
  const f = { lobby: lobbyDyn, play: playDyn, result: resultDyn }[stateOf().phase];
  return f ? f() : '';
}
function phaseChipHTML() {
  const st = stateOf(), g = curGame();
  if (st.phase === 'play' && g) return `<b>ターン ${st.turn + 1}${g.maxTurns ? `/${g.maxTurns}` : ''}</b><span>第${st.game}戦</span>`;
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
function pcolor(id) { const g = curGame(), i = g?.order?.indexOf(id) ?? -1; return i >= 0 ? colorOf(i) : '#8a87a8'; }
function pbarHTML() {
  const h = hostId(), w = winsTotal(), st = stateOf(), g = curGame();
  const picked = st.phase === 'play' && g ? pickedSet(g, st) : new Set();
  const mv = st.phase === 'play' && g ? new Set(movers(g).map((x) => x.id)) : new Set();
  return playerList().map((p) => `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar({ ...p, color: pcolor(p.id) })}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${st.phase !== 'lobby' ? `<span class="pscore">🏆${w[p.id] || 0}</span>` : ''}${st.phase === 'play' && g?.order.includes(p.id) ? (picked.has(p.id) ? '<span class="tag ok">✓</span>' : mv.has(p.id) ? '<span class="tag wip">…</span>' : '<span class="tag wip">休</span>') : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
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
  const ps = playerList(), host = isHost(), s = settings(), n = onlinePlayers().length, h = hostId();
  const size = boardSize(Math.max(2, Math.min(n, MAX_PLAYERS)));
  const seg = (key, vals, label) => vals.map((v) => `<button class="seg-btn ${s[key] === v ? 'on' : ''}" data-action="set" data-k="${key}" data-v="${JSON.stringify(v)}" ${host ? '' : 'disabled'}>${label(v)}</button>`).join('');
  return `<section class="card">
      <h3>参加メンバー <small>${n}人${n > MAX_PLAYERS ? `（対戦は${MAX_PLAYERS}人まで）` : ''}</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar({ ...p, color: '#8a87a8' })}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>ターン数</h3><div class="seg">${seg('turns', [15, 20, 30, 0], (v) => (v ? v + 'ターン' : '埋まるまで'))}</div>
      <h3 class="mt">1ターンの制限時間</h3><div class="seg">${seg('timer', [10, 15, 30, 0], (v) => (v ? v + '秒' : 'なし'))}</div>
      <h3 class="mt">ルール</h3>
      <div class="seg">${seg('stars', [true, false], (v) => (v ? '★マスあり' : '★マスなし'))}</div>
      <div class="seg">${seg('capture', [true, false], (v) => (v ? '囲い込みあり' : '囲い込みなし'))}</div>
      <p class="muted small">盤は人数で自動（いまの人数なら ${size}×${size}）。時間切れの人は選べるマスからランダム${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'あと1人集まったら開始できます' : 'ゲームスタート！'}</button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- 対局 ----------
function playView() {
  const g = curGame();
  return `<div id="scoreboard" class="scoreboard"></div>
    <div id="turn-banner" class="turn-banner"></div>
    <div class="db-timer" id="timer"><i></i></div>
    <div id="board" class="jt-wrap"></div>
    <div id="summary" class="jt-summary"></div>
    <div id="dyn"></div>
    ${myIdx(g) < 0 ? '<p class="muted small center">観戦中（次のゲームから参加できます）</p>' : ''}`;
}
function scoreboardHTML() {
  const g = curGame(); if (!g) return '';
  const st = stateOf(), s = scoreBoard(g.board, g.stars, g.order.length), cnt = cellCounts(g.board, g.order.length), max = Math.max(...s);
  return g.order.map((id, i) => {
    const p = player(id);
    return `<div class="sb ${id === S.pid ? 'me' : ''} ${st.phase === 'result' && s[i] === max ? 'win' : ''} ${p.online ? '' : 'off'}" style="--pc:${colorOf(i)}">
      ${avatar({ ...p, color: colorOf(i) }, 'sm')}<span class="sb-name">${id === S.pid ? 'あなた' : esc(p.name)}<small class="sb-cells">${cnt[i]}マス</small></span><b>${s[i]}</b>
    </div>`;
  }).join('');
}
function turnBannerHTML() {
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return '';
  const i = myIdx(g);
  if (i < 0) return '<div class="tb">観戦中</div>';
  const moves = validMoves(g.board, g.n, i), mine = myPick(g, st), col = colorOf(i);
  if (!moves.length) return `<div class="tb" style="--pc:${col}">😴 動けるマスがありません（このターンはお休み）</div>`;
  if (mine === null) return `<div class="tb mine" style="--pc:${col}">🟢 光っているマスから1つ選んでね</div>`;
  return `<div class="tb chosen" style="--pc:${col}">✓ 選びました！ みんなを待っています（変更もOK）</div>`;
}
function boardHTML(g, { interactive = false } = {}) {
  if (!g) return '';
  const st = stateOf(), i = myIdx(g), n = g.n;
  const moves = interactive && i >= 0 ? new Set(validMoves(g.board, n, i)) : new Set();
  const mine = interactive ? myPick(g, st) : null;
  const stars = new Set(g.stars || []);
  const last = g.last && g.last.turn === st.turn ? g.last : null; // 直前のターンの結果をアニメーション
  const fresh = new Set(last?.claimed || []), rocks = new Set(last?.rocks || []);
  const capd = new Set((last?.captured || []).flatMap((c) => c.cells));
  let cells = '';
  for (let k = 0; k < n * n; k++) {
    const ch = g.board[k], o = ownerOf(ch);
    const cls = ['jc'];
    let style = '', inner = '';
    if (o >= 0) { cls.push('own'); style = `--pc:${colorOf(o)}`; }
    else if (ch === ROCK) { cls.push('rock'); inner = '🪨'; }
    if (stars.has(k)) { cls.push('star'); if (ch !== ROCK) inner = '★'; }
    if (moves.has(k)) { cls.push('can'); style = `--pc:${colorOf(i)}`; }
    if (mine === k) cls.push('picked');
    if (fresh.has(k)) cls.push('fresh');
    if (rocks.has(k)) { cls.push('boom'); inner = '💥'; }
    if (capd.has(k)) cls.push('cap');
    cells += `<button class="${cls.join(' ')}" ${moves.has(k) ? `data-cell="${k}"` : 'tabindex="-1"'} style="${style}" aria-label="マス${k}">${inner ? `<span>${inner}</span>` : ''}</button>`;
  }
  return `<div class="jt-board ${interactive && moves.size ? 'myturn' : ''}" style="--n:${n};--me:${i >= 0 ? colorOf(i) : '#fff'}">${cells}</div>`;
}
function summaryHTML() {
  const st = stateOf(), g = curGame();
  if (!g?.last || st.phase !== 'play' || g.last.turn !== st.turn) return '';
  const L = g.last, msgs = [];
  if (L.rocks?.length) msgs.push(`💥 ${L.rocks.length}か所でぶつかり！ 岩になった`);
  for (const c of L.captured || []) msgs.push(`🏰 ${esc(player(g.order[c.o]).name)} さんが ${c.cells.length}マス囲い込み！`);
  if (L.auto?.length) msgs.push(`⏰ ${L.auto.map((i) => esc(player(g.order[i]).name)).join('、')} さんは時間切れでランダム`);
  return msgs.length ? `<div class="jt-msgs">${msgs.map((m) => `<span>${m}</span>`).join('')}</div>` : '';
}
function updateTimer() {
  const el = document.getElementById('timer'); if (!el) return;
  const st = stateOf(), t = settings().timer, g = curGame();
  if (st.phase !== 'play' || !st.deadline || !t) { el.classList.add('none'); return; }
  el.classList.remove('none');
  const left = Math.max(0, st.deadline - S.store.now());
  el.classList.toggle('warn', left < 5000);
  const i = myIdx(g);
  el.style.setProperty('--pc', i >= 0 ? colorOf(i) : '#fff');
  el.querySelector('i').style.width = `${Math.min(100, (left / (t * 1000)) * 100)}%`;
}
function playDyn() {
  const st = stateOf(), g = curGame(); if (!g) return '';
  if (!isHost()) return '';
  const need = movers(g).filter(({ id }) => player(id).online), picked = pickedSet(g, st);
  const waiting = need.filter(({ id }) => !picked.has(id));
  if (!settings().timer && waiting.length && waiting.length < need.length) {
    return `<div class="center"><button class="btn small ghost" data-action="force">未選択の人はランダムにして進める</button></div>`;
  }
  return '';
}

// ---------- 結果 ----------
function resultView() {
  const g = curGame(), n = g.order.length;
  const s = scoreBoard(g.board, g.stars, n), cnt = cellCounts(g.board, n), max = Math.max(...s);
  const starsOf = (i) => (g.stars || []).filter((k) => ownerOf(g.board[k]) === i).length;
  const rows = g.order.map((id, i) => ({ id, i, pts: s[i], cells: cnt[i], st: starsOf(i), hit: g.stats?.[id]?.hit || 0, cap: g.stats?.[id]?.cap || 0 })).sort((a, b) => b.pts - a.pts);
  const winners = rows.filter((x) => x.pts === max), wins = winsTotal();
  const title = winners.length > 1 ? '引き分け！' : winners[0].id === S.pid ? 'あなたの勝ち！' : `${esc(player(winners[0].id).name)} さんの勝ち！`;
  const awards = [];
  const best = (k, icon, label, desc) => {
    const m = Math.max(0, ...rows.map((x) => x[k]));
    if (m > 0) awards.push({ icon, label, desc: desc(m), who: rows.filter((x) => x[k] === m).map((x) => player(x.id)) });
  };
  best('cap', '🏰', '囲い込み名人', (v) => `囲い込みで ${v}マス`);
  best('hit', '💥', 'ぶつかり王', (v) => `ぶつかった回数 ${v}回`);
  best('st', '⭐', 'スターハンター', (v) => `★マス ${v}個`);
  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>${title}</h2>
      <p class="muted small">第${stateOf().game}戦　${g.n}×${g.n}・${stateOf().turn}ターン</p>
    </section>
    <div class="jt-wrap result">${boardHTML(g)}</div>
    <section class="card"><ol class="standings">${rows.map((x) => {
      const p = player(x.id), rank = 1 + rows.filter((y) => y.pts > x.pts).length;
      return `<li class="${x.id === S.pid ? 'me' : ''}"><span class="rank r${rank}">${rank}</span>${avatar({ ...p, color: colorOf(x.i) }, 'sm')}<span class="nm">${esc(p.name)}</span><span class="muted tiny">${x.cells}マス・★${x.st}・通算🏆${wins[x.id] || 0}</span><b>${x.pts}<small>点</small></b></li>`;
    }).join('')}</ol></section>
    ${awards.length ? `<h3 class="sec-title">称号</h3><div class="awards">${awards.map((a) => `
      <div class="award"><div class="aw-icon">${a.icon}</div><div class="aw-body"><b>${a.label}</b><span>${a.who.map((w) => esc(w.name)).join('、')}</span><small class="muted">${a.desc}</small></div></div>`).join('')}</div>` : ''}
    <div id="dyn"></div>`;
}
function resultDyn() {
  if (isHost()) {
    const n = onlinePlayers().length;
    return `<div class="host-bar">
      <button class="btn primary big" data-action="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? '2人以上必要です' : '🔁 もう一戦（スタート位置をシャッフル）'}</button>
      <button class="btn ghost wide" data-action="to-lobby">ロビーに戻る（設定を変える）</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = pageUrl('jintori.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: '同時陣取り', text: `同時陣取りで遊ぼう！部屋コード：${S.code}`, url: pageUrl('jintori.html', S.code) }); } catch {}
}
const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  set: (el) => S.store.set(`${roomPath()}/meta/${el.dataset.k}`, JSON.parse(el.dataset.v)),
  start: startGame,
  'to-lobby': () => S.store.update(roomPath(), { 'state/phase': 'lobby' }),
  force: () => { if (confirm('まだ選んでいない人はランダムにして進めますか？')) { S.hostBusy = `res:${stateOf().game}:${stateOf().turn}`; return resolveNow(); } },
};
$app.addEventListener('click', (e) => {
  const cell = e.target.closest('.jc[data-cell]');
  if (cell) { pick(+cell.dataset.cell).catch((err) => toast('エラー：' + (err?.message || err))); return; }
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

boot();
