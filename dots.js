// =============================================================
//  ドット＆ボックス — 点と点を線でつなぎ、四角を閉じたら自分の陣地
//  ・順番に1本ずつ線を引く
//  ・四角（ボックス）を閉じたら、その四角をもらってもう1手
//  ・全部の線が引かれたら、ボックスの数で勝負
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, shuffle, confetti, gotoRoom, firstChar,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';

// ---------- 定数 ----------
const GAME = 'dots';
const COLORS = ['#ff5a8a', '#4dc3ff', '#ffc145', '#6fdc8c', '#b98bff', '#ff8a4d'];
const CELL = 100, PAD = 26;

const $app = document.getElementById('app');

const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null, viewKey: '',
  sel: null, tick: null, hostBusy: '', autoKey: '', notified: '', lastBoxes: 0, confettiDone: {},
  touch: matchMedia('(hover: none)').matches,
};

// ---------- ルーム状態 ----------
const gk = (n) => 'g' + n;
const roomPath = () => `rooms/${S.code}`;
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
const settings = () => ({ size: S.room?.meta?.size ?? 4, timer: S.room?.meta?.timer ?? 30 });
const colorOf = (g, i) => COLORS[i % COLORS.length];
const myIdx = (g) => (g?.order || []).indexOf(S.pid);

// ---------- 盤面ロジック ----------
// 横線 h{r}_{c}：(r,c)-(r,c+1)　r=0..R, c=0..C-1
// 縦線 v{r}_{c}：(r,c)-(r+1,c)　r=0..R-1, c=0..C
function allLines(R, C) {
  const out = [];
  for (let r = 0; r <= R; r++) for (let c = 0; c < C; c++) out.push(`h${r}_${c}`);
  for (let r = 0; r < R; r++) for (let c = 0; c <= C; c++) out.push(`v${r}_${c}`);
  return out;
}
const parse = (k) => { const [r, c] = k.slice(1).split('_').map(Number); return { t: k[0], r, c }; };
function boxLines(r, c) { return [`h${r}_${c}`, `h${r + 1}_${c}`, `v${r}_${c}`, `v${r}_${c + 1}`]; }
function boxesOfLine(k, R, C) {
  const { t, r, c } = parse(k), out = [];
  if (t === 'h') { if (r > 0) out.push([r - 1, c]); if (r < R) out.push([r, c]); }
  else { if (c > 0) out.push([r, c - 1]); if (c < C) out.push([r, c]); }
  return out;
}
const sidesTaken = (lines, r, c) => boxLines(r, c).filter((l) => lines[l] !== undefined).length;
function completedBy(lines, k, R, C) {
  const tmp = { ...lines, [k]: 0 };
  return boxesOfLine(k, R, C).filter(([r, c]) => boxLines(r, c).every((l) => tmp[l] !== undefined));
}
function freeLines(g) { const L = g.lines || {}; return allLines(g.R, g.C).filter((k) => L[k] === undefined); }
// 自動手：取れる四角があれば取る → 相手に渡さない線 → どれか
function autoMove(g) {
  const L = g.lines || {}, free = freeLines(g);
  if (!free.length) return null;
  const take = free.filter((k) => completedBy(L, k, g.R, g.C).length);
  if (take.length) return take[Math.floor(Math.random() * take.length)];
  const safe = free.filter((k) => boxesOfLine(k, g.R, g.C).every(([r, c]) => sidesTaken(L, r, c) < 2));
  const pool = safe.length ? safe : free;
  return pool[Math.floor(Math.random() * pool.length)];
}
function scores(g) {
  const s = (g?.order || []).map(() => 0);
  for (const v of Object.values(g?.boxes || {})) s[v] = (s[v] || 0) + 1;
  return s;
}
function winsTotal() {
  const w = {};
  for (const g of Object.values(S.room?.games || {})) {
    if (!g?.done) continue;
    const s = scores(g), max = Math.max(...s);
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
      <li>順番に、となりの点と点を結ぶ線を<b>1本</b>引く</li>
      <li>四角の4辺目を引いたら、その四角は<b>自分のもの</b>。さらに<b>もう1手</b>引ける</li>
      <li>全部の線が引かれたら終了。四角をいちばん多く取った人の勝ち！</li>
    </ol>
    <p class="muted small">コツ：3辺目を引くと次の人に取られてしまう。終盤は「どの列を相手に渡すか」の読み合いに。</p>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo db-logo">
      <svg class="db-mark" viewBox="0 0 120 120" aria-hidden="true">
        <rect x="20" y="20" width="40" height="40" fill="#ff5a8a55"/><rect x="60" y="60" width="40" height="40" fill="#4dc3ff55"/>
        <path d="M20 20H60V60H20Z M60 60H100V100H60Z M60 20H100" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/>
        <path class="db-draw" d="M100 20V60" stroke="#ffc145" stroke-width="6" stroke-linecap="round"/>
        ${[20, 60, 100].map((y) => [20, 60, 100].map((x) => `<circle cx="${x}" cy="${y}" r="7" fill="#fff"/>`).join('')).join('')}
      </svg>
      <h1>ドット＆ボックス</h1>
      <p>線を引いて、四角を閉じろ</p>
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
  await S.store.set(`rooms/${code}`, { meta: { game: GAME, createdAt: Date.now(), size: 4, timer: 30 }, state: { phase: 'lobby', game: 0 } });
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
  S.code = null; S.room = null; setUrlRoom(null); document.title = 'ドット＆ボックス — あそびば';
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
  if (followRoom(room, GAME, S.code)) { S.unsub?.(); return; }
  S.room = room;
  notifyTurn();
  render();
  onTick();
}
function onTick() {
  if (!S.room) return;
  updateTimer();
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return;
  const cur = g.order[st.turn], now = S.store.now();
  // 自分の番で時間切れ → 自動で1本
  if (cur === S.pid && st.deadline && now > st.deadline) {
    const key = `${st.game}:${st.moveNo}`;
    if (S.autoKey !== key) { S.autoKey = key; const k = autoMove(g); if (k) { toast('時間切れ！ 自動で線を引きました'); move(k, true); } }
  }
  // 手番の人が切断中 → ホストが代わりに進める
  if (isHost() && cur !== S.pid && !player(cur).online) {
    const since = st.deadline ? st.deadline - settings().timer * 1000 : st.turnAt || 0;
    if (now > since + 4000) {
      const key = `host:${st.game}:${st.moveNo}`;
      if (S.hostBusy !== key) { S.hostBusy = key; const k = autoMove(g); if (k) move(k, true, cur); }
    }
  }
}
function notifyTurn() {
  const st = stateOf(), g = curGame();
  const mine = st.phase === 'play' && g && g.order[st.turn] === S.pid;
  document.title = mine ? '🟢 あなたの番！ — ドット＆ボックス' : 'ドット＆ボックス — あそびば';
  if (!mine) return;
  const key = `${st.game}:${st.moveNo}`;
  if (S.notified === key) return;
  S.notified = key;
  if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
}

async function startGame() {
  const ids = shuffle(onlinePlayers().map((p) => p.id)).slice(0, COLORS.length);
  if (ids.length < 2) return toast('2人以上いないと始められません');
  const { size, timer } = settings();
  const n = stateOf().game + 1;
  const now = S.store.now();
  await S.store.update(roomPath(), {
    state: { phase: 'play', game: n, turn: 0, moveNo: 0, turnAt: now, deadline: timer ? now + timer * 1000 : 0 },
    [`games/${gk(n)}`]: { order: ids, R: size, C: size, startedAt: Date.now() },
  });
}
// 線を引く（as：代理で引くときのプレイヤー）
async function move(k, auto = false, as = S.pid) {
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return;
  const idx = g.order.indexOf(as);
  if (idx !== st.turn) return;
  const L = g.lines || {};
  if (L[k] !== undefined) return;
  const done = completedBy(L, k, g.R, g.C);
  const base = `games/${gk(st.game)}`;
  const now = S.store.now(), t = settings().timer;
  const upd = {
    [`${base}/lines/${k}`]: idx,
    'state/moveNo': (st.moveNo || 0) + 1,
    'state/last': k,
    'state/bonus': done.length > 0,
    'state/turnAt': now,
    'state/deadline': t ? now + t * 1000 : 0,
  };
  for (const [r, c] of done) upd[`${base}/boxes/${r}_${c}`] = idx;
  if (!done.length) upd['state/turn'] = (idx + 1) % g.order.length;
  const total = allLines(g.R, g.C).length;
  if (Object.keys(L).length + 1 >= total) { upd['state/phase'] = 'result'; upd[`${base}/done`] = true; upd['state/deadline'] = 0; }
  S.sel = null;
  await S.store.update(roomPath(), upd);
  if (auto) return;
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
    S.viewKey = key; S.sel = null;
    const views = { lobby: lobbyView, play: playView, result: resultView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main dbgame phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    window.scrollTo({ top: 0 });
    if (st.phase === 'result' && !S.confettiDone[st.game]) {
      S.confettiDone[st.game] = true;
      const g = curGame(), s = scores(g), i = myIdx(g);
      if (i >= 0 && s[i] === Math.max(...s)) setTimeout(() => confetti(140, COLORS), 300);
    }
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('dyn'), dynHTML());
  setHTML(document.getElementById('scoreboard'), scoreboardHTML());
  setHTML(document.getElementById('turn-banner'), turnBannerHTML());
  const b = document.getElementById('board');
  if (b) { setHTML(b, boardSVG(curGame(), { interactive: stateOf().phase === 'play' })); }
  updateTimer();
}
function dynHTML() {
  const f = { lobby: lobbyDyn, play: playDyn, result: resultDyn }[stateOf().phase];
  return f ? f() : '';
}
function phaseChipHTML() {
  const st = stateOf(), g = curGame();
  if (st.phase === 'play' && g) {
    const total = allLines(g.R, g.C).length, used = Object.keys(g.lines || {}).length;
    return `<b>第${st.game}戦</b><span>残り${total - used}本</span>`;
  }
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
function pcolor(id) {
  const g = curGame(), i = g?.order?.indexOf(id) ?? -1;
  return i >= 0 ? colorOf(g, i) : '#8a87a8';
}
function pbarHTML() {
  const h = hostId(), w = winsTotal(), st = stateOf();
  return playerList().map((p) => `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar({ ...p, color: pcolor(p.id) })}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${st.phase !== 'lobby' ? `<span class="pscore">🏆${w[p.id] || 0}</span>` : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
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
  const ps = playerList(), host = isHost(), { size, timer } = settings(), n = onlinePlayers().length, h = hostId();
  return `<section class="card">
      <h3>参加メンバー <small>${n}人${n > COLORS.length ? `（対戦は${COLORS.length}人まで）` : ''}</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar({ ...p, color: '#8a87a8' })}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>盤の大きさ</h3>
      <div class="seg">${[3, 4, 5, 6].map((s) => `<button class="seg-btn ${size === s ? 'on' : ''}" data-action="set-size" data-s="${s}" ${host ? '' : 'disabled'}>${s}×${s}</button>`).join('')}</div>
      <p class="muted small">四角が${size * size}個・線が${2 * size * (size + 1)}本。${n >= 4 && size < 5 ? '4人以上なら 5×5 以上がおすすめ' : n <= 2 && size > 4 ? '2人なら 3×3〜4×4 でサクッと' : ''}</p>
      <h3 class="mt">1手の制限時間</h3>
      <div class="seg">${[15, 30, 60, 0].map((t) => `<button class="seg-btn ${timer === t ? 'on' : ''}" data-action="set-timer" data-t="${t}" ${host ? '' : 'disabled'}>${t ? t + '秒' : 'なし'}</button>`).join('')}</div>
      <p class="muted small">時間切れになると自動で1本引かれます${host ? '' : '（ホストが設定します）'}</p>
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
    <div id="board" class="board-wrap ${S.touch ? 'touch' : ''}"></div>
    <p class="muted tiny center board-tip">${S.touch ? '線をタップで選んで、もう一度タップで決定' : '点と点のあいだをクリックして線を引く'}</p>
    <div id="dyn"></div>
    ${myIdx(g) < 0 ? '<p class="muted small center">観戦中（次のゲームから参加できます）</p>' : ''}`;
}
function scoreboardHTML() {
  const g = curGame(), st = stateOf(); if (!g) return '';
  const s = scores(g), max = Math.max(...s);
  return g.order.map((id, i) => {
    const p = player(id), cur = st.phase === 'play' && st.turn === i;
    return `<div class="sb ${cur ? 'cur' : ''} ${id === S.pid ? 'me' : ''} ${st.phase === 'result' && s[i] === max ? 'win' : ''} ${p.online ? '' : 'off'}" style="--pc:${colorOf(g, i)}">
      ${avatar({ ...p, color: colorOf(g, i) }, 'sm')}<span class="sb-name">${id === S.pid ? 'あなた' : esc(p.name)}</span><b>${s[i]}</b>
    </div>`;
  }).join('');
}
function turnBannerHTML() {
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return '';
  const id = g.order[st.turn], p = player(id), mine = id === S.pid, col = colorOf(g, st.turn);
  const bonus = st.bonus ? '<span class="bonus">📦 四角ゲット！もう1手</span>' : '';
  return mine
    ? `<div class="tb mine" style="--pc:${col}">🟢 あなたの番！${bonus}</div>`
    : `<div class="tb" style="--pc:${col}">${avatar({ ...p, color: col }, 'xs')} ${esc(p.name)} さんの番${p.online ? '' : '（切断中）'}${bonus}</div>`;
}
function updateTimer() {
  const el = document.getElementById('timer'); if (!el) return;
  const st = stateOf(), t = settings().timer;
  if (st.phase !== 'play' || !st.deadline || !t) { el.classList.add('none'); return; }
  el.classList.remove('none');
  const left = Math.max(0, st.deadline - S.store.now());
  el.classList.toggle('warn', left < 6000);
  const g = curGame();
  el.style.setProperty('--pc', g ? colorOf(g, st.turn) : '#fff');
  el.querySelector('i').style.width = `${Math.min(100, (left / (t * 1000)) * 100)}%`;
}
function boardSVG(g, { interactive = false, mini = false } = {}) {
  if (!g) return '';
  const st = stateOf(), R = g.R, C = g.C, L = g.lines || {}, B = g.boxes || {};
  const W = C * CELL + PAD * 2, H = R * CELL + PAD * 2;
  const X = (c) => PAD + c * CELL, Y = (r) => PAD + r * CELL;
  const my = myIdx(g), myTurn = interactive && st.phase === 'play' && st.turn === my && my >= 0;
  let boxes = '', lines = '', hits = '', dots = '';
  for (const [key, v] of Object.entries(B)) {
    const [r, c] = key.split('_').map(Number), col = colorOf(g, v), p = player(g.order[v]);
    boxes += `<g class="bx" style="--pc:${col}"><rect x="${X(c) + 4}" y="${Y(r) + 4}" width="${CELL - 8}" height="${CELL - 8}" rx="10"/>
      ${mini ? '' : `<text x="${X(c) + CELL / 2}" y="${Y(r) + CELL / 2 + 13}">${esc(firstChar(p.name))}</text>`}</g>`;
  }
  for (const k of allLines(R, C)) {
    const { t, r, c } = parse(k);
    const x1 = X(c), y1 = Y(r), x2 = t === 'h' ? X(c + 1) : X(c), y2 = t === 'h' ? Y(r) : Y(r + 1);
    const owner = L[k];
    if (owner !== undefined) {
      lines += `<line class="ln on ${st.last === k && !mini ? 'last' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="--pc:${colorOf(g, owner)}"/>`;
    } else {
      const danger = myTurn && boxesOfLine(k, R, C).some(([br, bc]) => sidesTaken(L, br, bc) === 2);
      lines += `<line class="ln free ${S.sel === k ? 'sel' : ''} ${danger ? 'danger' : ''}" data-k="${k}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      if (myTurn) {
        const hx = t === 'h' ? x1 + CELL * 0.12 : x1 - CELL * 0.28, hy = t === 'h' ? y1 - CELL * 0.28 : y1 + CELL * 0.12;
        const hw = t === 'h' ? CELL * 0.76 : CELL * 0.56, hh = t === 'h' ? CELL * 0.56 : CELL * 0.76;
        hits += `<rect class="hit" data-line="${k}" x="${hx}" y="${hy}" width="${hw}" height="${hh}"/>`;
      }
    }
  }
  for (let r = 0; r <= R; r++) for (let c = 0; c <= C; c++) dots += `<circle class="dt" cx="${X(c)}" cy="${Y(r)}" r="9"/>`;
  return `<svg class="db-board ${myTurn ? 'myturn' : ''} ${mini ? 'mini' : ''}" viewBox="0 0 ${W} ${H}" style="--me:${my >= 0 ? colorOf(g, my) : '#fff'}">
    <g>${boxes}</g><g>${lines}</g><g>${dots}</g><g>${hits}</g></svg>`;
}
function playDyn() {
  const st = stateOf(), g = curGame(); if (!g) return '';
  const cur = g.order[st.turn];
  if (isHost() && !player(cur).online && cur !== S.pid) {
    return '<p class="muted small center">切断中の人の番は、自動で進めます…</p>';
  }
  return '';
}
function onBoardPointer(e) {
  const hit = e.target.closest?.('.hit');
  if (!hit) return;
  const k = hit.dataset.line;
  const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen' || S.touch;
  if (isTouch && S.sel !== k) { S.sel = k; updateDynamic(); return; }
  move(k).catch((err) => toast('エラー：' + (err?.message || err)));
}
function onBoardHover(e) {
  const hit = e.target.closest?.('.hit');
  document.querySelectorAll('.ln.hover').forEach((x) => x.classList.remove('hover'));
  if (hit) document.querySelector(`.ln[data-k="${hit.dataset.line}"]`)?.classList.add('hover');
}

// ---------- 結果 ----------
function resultView() {
  const g = curGame(), s = scores(g), max = Math.max(...s);
  const rows = g.order.map((id, i) => ({ id, i, n: s[i] })).sort((a, b) => b.n - a.n);
  const winners = rows.filter((x) => x.n === max);
  const wins = winsTotal();
  const title = winners.length > 1 ? '引き分け！' : winners[0].id === S.pid ? 'あなたの勝ち！' : `${esc(player(winners[0].id).name)} さんの勝ち！`;
  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>${title}</h2>
      <p class="muted small">第${stateOf().game}戦　${g.R}×${g.C}</p>
    </section>
    <div class="board-wrap result-board">${boardSVG(g)}</div>
    <section class="card"><ol class="standings">${rows.map((x) => {
      const p = player(x.id), rank = 1 + rows.filter((y) => y.n > x.n).length;
      return `<li class="${x.id === S.pid ? 'me' : ''}"><span class="rank r${rank}">${rank}</span>${avatar({ ...p, color: colorOf(g, x.i) }, 'sm')}<span class="nm">${esc(p.name)}</span><span class="muted tiny">通算🏆${wins[x.id] || 0}</span><b>${x.n}<small>個</small></b></li>`;
    }).join('')}</ol></section>
    <div id="dyn"></div>`;
}
function resultDyn() {
  if (isHost()) {
    const n = onlinePlayers().length;
    return `<div class="host-bar">
      <button class="btn primary big" data-action="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? '2人以上必要です' : '🔁 もう一戦（順番をシャッフル）'}</button>
      <button class="btn ghost wide" data-action="to-lobby">ロビーに戻る（設定を変える）</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}
async function toLobby() { await S.store.update(roomPath(), { 'state/phase': 'lobby' }); }

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = pageUrl('dots.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'ドット＆ボックス', text: `ドット＆ボックスで遊ぼう！部屋コード：${S.code}`, url: pageUrl('dots.html', S.code) }); } catch {}
}
const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  'set-size': (el) => S.store.set(`${roomPath()}/meta/size`, +el.dataset.s),
  'set-timer': (el) => S.store.set(`${roomPath()}/meta/timer`, +el.dataset.t),
  start: startGame, 'to-lobby': toLobby,
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
$app.addEventListener('pointerup', onBoardPointer);
$app.addEventListener('pointerover', onBoardHover);
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
