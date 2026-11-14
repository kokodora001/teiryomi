// =============================================================
//  ナンプレバトル — 同じ盤面を同時に解いて、いちばん早い人が勝ち
//  ・数字を入れた瞬間に正誤判定。まちがえるとタイムにペナルティ
//  ・ペナルティはミスするたびに増える（例：+10秒 → +20秒 → +30秒 …）
//  ・タイム = 解き終わるまでの時間 + ペナルティ合計。いちばん短い人の勝ち
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';
import { DIFFS, PEERS, ROW, COL, BOX, makePuzzle } from './sudoku-gen.js';

const GAME = 'sudoku';
const AVATAR_COLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];

const $app = document.getElementById('app');
const S = {
  store: null, pid: '', name: '', code: null, room: null, unsub: null, stopPresence: null, viewKey: '',
  tick: null, hostBusy: '', confettiDone: {},
  L: null, // 自分の盤面 { key, cells[81], memo[81](bitmask), miss, sel, memoMode, done }
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
const settings = () => ({ diff: S.room?.meta?.diff ?? 'normal', pen: S.room?.meta?.pen ?? 10 });
const inGame = (g) => !!g?.order?.includes(S.pid);
const pdata = (g, id) => g?.ps?.[id] || {};
const started = () => S.store.now() >= (stateOf().startAt || 0);
const penaltyTotal = (miss, base) => (base * miss * (miss + 1)) / 2; // 1回目 base, 2回目 2×base, …
const nextPenalty = (miss, base) => base * (miss + 1);
const toFill = (g) => [...g.puzzle].filter((c) => c === '0').length;
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// その人のいまのタイム（解き終わっていれば確定タイム）
function liveTime(g, id, now) {
  const d = pdata(g, id), base = g.pen;
  if (d.done) return d.ms + penaltyTotal(d.miss || 0, base) * 1000;
  return Math.max(0, now - g.startAt) + penaltyTotal(d.miss || 0, base) * 1000;
}
function winsTotal() {
  const w = {};
  for (const g of Object.values(S.room?.games || {})) if (g?.winner) w[g.winner] = (w[g.winner] || 0) + 1;
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
  const { pen } = settings();
  return `<details class="card rules" ${open ? 'open' : ''}>
    <summary>あそびかた</summary>
    <ol>
      <li>全員に<b>同じナンプレ</b>が同時に配られる</li>
      <li>マスを選んで数字を入れる。<b>入れた瞬間に正誤判定</b></li>
      <li>まちがえると数字は入らず、<b>タイムにペナルティ</b>。ミスするたびに増えていく</li>
      <li>タイム（解いた時間＋ペナルティ）がいちばん短い人の勝ち！</li>
    </ol>
    <div class="score-legend">
      <span>❌1回目 <b>+${pen}秒</b></span><span>❌2回目 <b>+${pen * 2}秒</b></span><span>❌3回目 <b>+${pen * 3}秒</b> …</span>
    </div>
    <p class="muted small">✏️メモで候補の数字を小さく書き込めます。PCは数字キー・矢印キー・Backspace・M（メモ切替）でも操作できます。</p>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo su-logo">
      <div class="su-mark">${'5.3.7..6.1...9.4'.split('').map((c, i) => `<i class="${c === '.' ? '' : 'n'}" style="--i:${i}">${c === '.' ? '' : c}</i>`).join('')}</div>
      <h1>ナンプレバトル</h1>
      <p>同じ盤面で、いちばん早く解くのは誰だ</p>
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
  S.code = null; S.room = null; S.L = null; setUrlRoom(null);
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
  syncLocal();
  render();
}
// 自分の盤面を用意（リロードしても、部屋に保存した内容から復元）
function syncLocal() {
  const st = stateOf(), g = curGame();
  if (st.phase === 'lobby' || !g || !inGame(g)) { if (st.phase === 'lobby') S.L = null; return; }
  const key = `${S.code}:${st.game}`;
  if (S.L?.key === key) return;
  const mine = pdata(g, S.pid);
  const cells = [...(mine.cells || g.puzzle)].map(Number);
  let memo = Array(81).fill(0);
  try { const m = JSON.parse(sessionStorage.getItem('sudoku.memo')); if (m?.key === key) memo = m.memo; } catch {}
  S.L = { key, cells, memo, miss: mine.miss || 0, sel: -1, memoMode: false, done: !!mine.done, flash: -1 };
}
const saveMemo = () => { try { sessionStorage.setItem('sudoku.memo', JSON.stringify({ key: S.L.key, memo: S.L.memo })); } catch {} };
function onTick() {
  if (!S.room) return;
  updateClock();
  const st = stateOf(), g = curGame();
  if (st.phase === 'play') {
    setHTML(document.getElementById('rivals'), rivalsHTML());
    if (!started()) setHTML(document.getElementById('cover'), coverHTML());
    else { document.getElementById('cover')?.remove(); paintPad(); } // カウントダウンが終わったら数字ボタンを押せるように
  }
  if (!isHost() || st.phase !== 'play' || !g || !started()) return;
  // 終了判定：全員が解き終わった／リタイア／切断、または
  // まだ解いている人が、いまの時点で1位のタイムを超えていて逆転できない
  const now = S.store.now();
  const doneTimes = g.order.filter((id) => pdata(g, id).done).map((id) => liveTime(g, id, now));
  const best = doneTimes.length ? Math.min(...doneTimes) : Infinity;
  const allOut = g.order.every((id) => {
    const d = pdata(g, id);
    if (d.done || d.gaveUp || !player(id).online) return true;
    return liveTime(g, id, now) > best;
  });
  if (allOut && S.hostBusy !== `end:${st.game}`) {
    S.hostBusy = `end:${st.game}`;
    const finishers = g.order.filter((id) => pdata(g, id).done).sort((a, b) => liveTime(g, a, now) - liveTime(g, b, now));
    S.store.update(roomPath(), { 'state/phase': 'result', [`games/${gk(st.game)}/winner`]: finishers[0] || '', [`games/${gk(st.game)}/endedAt`]: now }).catch(() => { S.hostBusy = ''; });
  }
}
async function startGame() {
  const ids = onlinePlayers().map((p) => p.id);
  if (!ids.length) return;
  const { diff, pen } = settings();
  const p = makePuzzle(diff);
  const n = stateOf().game + 1, startAt = S.store.now() + 3500;
  await S.store.update(roomPath(), {
    state: { phase: 'play', game: n, startAt },
    [`games/${gk(n)}`]: { order: ids, puzzle: p.puzzle, solution: p.solution, diff, pen, startAt },
  });
}

// ---------- 入力 ----------
function canInput() { const g = curGame(); return stateOf().phase === 'play' && started() && S.L && !S.L.done && inGame(g) && !pdata(g, S.pid).gaveUp; }
function select(i) { if (!S.L) return; S.L.sel = i; paintGrid(); }
async function inputDigit(d) {
  if (!canInput()) return;
  const L = S.L, g = curGame(), i = L.sel;
  if (i < 0) { toast('先にマスを選んでね'); return; }
  if (g.puzzle[i] !== '0' || L.cells[i]) return; // ヒントや正解済みのマスは変えられない
  if (L.memoMode) { L.memo[i] ^= 1 << d; saveMemo(); paintGrid(); return; }
  if (+g.solution[i] === d) {
    L.cells[i] = d; L.memo[i] = 0;
    for (const j of PEERS[i]) L.memo[j] &= ~(1 << d); // 同じ行・列・ブロックのメモから消す
    saveMemo();
    const filled = L.cells.every((v) => v > 0);
    if (filled) { L.done = true; }
    paintGrid(); paintPad();
    const upd = { cells: L.cells.join(''), miss: L.miss, at: S.store.now() };
    if (filled) { upd.done = true; upd.ms = S.store.now() - g.startAt; }
    await S.store.update(`${gamePath()}/ps/${S.pid}`, upd);
    if (filled) { confetti(120); toast(`クリア！ タイム ${fmt(upd.ms + penaltyTotal(L.miss, g.pen) * 1000)}`); }
  } else {
    const add = nextPenalty(L.miss, g.pen);
    L.miss++; L.flash = i;
    paintGrid(); flashPenalty(add);
    setTimeout(() => { if (S.L) { S.L.flash = -1; paintGrid(); } }, 600);
    if (navigator.vibrate) try { navigator.vibrate(80); } catch {}
    await S.store.update(`${gamePath()}/ps/${S.pid}`, { cells: L.cells.join(''), miss: L.miss, at: S.store.now() });
  }
}
function eraseCell() {
  if (!canInput()) return;
  const L = S.L, i = L.sel; if (i < 0) return;
  if (L.memo[i]) { L.memo[i] = 0; saveMemo(); paintGrid(); }
}
function flashPenalty(sec) {
  const el = document.getElementById('pen-pop'); if (!el) return;
  el.textContent = `❌ ミス！ +${sec}秒`; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
async function giveUp() {
  if (!confirm('ギブアップしますか？（この勝負は記録なしになります）')) return;
  await S.store.update(`${gamePath()}/ps/${S.pid}`, { gaveUp: true, at: S.store.now() });
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
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main sugame phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    window.scrollTo({ top: 0 });
    if (st.phase === 'result' && !S.confettiDone[st.game]) {
      S.confettiDone[st.game] = true;
      if (curGame()?.winner === S.pid) setTimeout(() => confetti(150), 300);
    }
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('rivals'), rivalsHTML());
  setHTML(document.getElementById('dyn'), dynHTML());
  paintGrid(); paintPad(); updateClock();
}
function dynHTML() {
  const f = { lobby: lobbyDyn, play: playDyn, result: resultDyn }[stateOf().phase];
  return f ? f() : '';
}
function phaseChipHTML() {
  const st = stateOf(), g = curGame();
  if (st.phase === 'play' && g) return `<b>第${st.game}戦</b><span>${DIFFS[g.diff]?.label || ''}</span>`;
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
  const h = hostId(), w = winsTotal(), st = stateOf();
  return playerList().map((p) => `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar(p)}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${st.phase !== 'lobby' ? `<span class="pscore">🏆${w[p.id] || 0}</span>` : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
    </div>`).join('');
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
  const ps = playerList(), host = isHost(), { diff, pen } = settings(), n = onlinePlayers().length, h = hostId();
  return `<section class="card">
      <h3>参加メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>むずかしさ</h3>
      <div class="seg">${Object.entries(DIFFS).map(([k, v]) => `<button class="seg-btn ${diff === k ? 'on' : ''}" data-action="set" data-k="diff" data-v='"${k}"' ${host ? '' : 'disabled'}>${v.label}</button>`).join('')}</div>
      <p class="muted small">最初から入っている数字：${DIFFS[diff].note || `${DIFFS[diff].givens}個前後`}${diff === 'extreme' ? '。簡単な考え方だけでは解けない問題だけを選んで出します' : ''}</p>
      <h3 class="mt">ミスのペナルティ</h3>
      <div class="seg">${[5, 10, 15].map((v) => `<button class="seg-btn ${pen === v ? 'on' : ''}" data-action="set" data-k="pen" data-v="${v}" ${host ? '' : 'disabled'}>${v}秒ずつ増える</button>`).join('')}</div>
      <p class="muted small">1回目 +${pen}秒 → 2回目 +${pen * 2}秒 → 3回目 +${pen * 3}秒 …（3回ミスで合計 +${penaltyTotal(3, pen)}秒）${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start">${n === 1 ? 'ひとりで練習スタート' : 'みんなでスタート！'}<small>3秒のカウントダウンのあと、同じ盤面が全員に配られます</small></button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- 対戦 ----------
function playView() {
  const g = curGame(), me = inGame(g);
  return `<div class="su-top">
      <div class="su-clock" id="clock"></div>
    </div>
    <div id="rivals" class="su-rivals"></div>
    ${me ? `<div class="su-wrap">
      <div id="grid" class="su-grid"></div>
      <div id="cover" class="su-cover"></div>
      <div id="pen-pop" class="pen-pop"></div>
    </div>
    <div id="pad" class="su-pad"></div>` : '<p class="muted center">観戦中（次の勝負から参加できます）</p>'}
    <div id="dyn"></div>`;
}
function coverHTML() {
  const n = Math.ceil(((stateOf().startAt || 0) - S.store.now()) / 1000);
  return `<div class="cd">${n > 0 ? n : 'GO!'}</div><p>同じ盤面が全員に配られます</p>`;
}
function updateClock() {
  const el = document.getElementById('clock'); const g = curGame(); if (!el || !g) return;
  if (!started()) { setHTML(el, '<b>0:00</b>'); return; }
  const d = pdata(g, S.pid), miss = S.L?.miss ?? d.miss ?? 0, pen = penaltyTotal(miss, g.pen);
  const base = d.done ? d.ms : S.store.now() - g.startAt;
  setHTML(el, `<span class="lbl">タイム</span><b>${fmt(base + pen * 1000)}</b>${miss ? `<span class="miss">❌${miss} ／ +${pen}秒</span>` : '<span class="miss ok">ミスなし</span>'}${d.done ? '<span class="clear">CLEAR!</span>' : ''}`);
}
function rivalsHTML() {
  const g = curGame(); if (!g) return '';
  const now = S.store.now(), total = toFill(g);
  const rows = g.order.map((id) => {
    const d = pdata(g, id), filled = d.cells ? [...d.cells].filter((c, i) => c !== '0' && g.puzzle[i] === '0').length : 0;
    return { id, d, pct: Math.round((filled / total) * 100), t: liveTime(g, id, now) };
  }).sort((a, b) => ((b.d.done ? 1 : 0) - (a.d.done ? 1 : 0)) || (a.d.done ? a.t - b.t : b.pct - a.pct));
  return rows.map((x) => {
    const p = player(x.id);
    return `<div class="rv ${x.id === S.pid ? 'me' : ''} ${x.d.done ? 'done' : ''} ${x.d.gaveUp ? 'gave' : ''}" style="--pc:${p.color}">
      ${avatar(p, 'xs')}<span class="nm">${x.id === S.pid ? 'あなた' : esc(p.name)}</span>
      <span class="bar"><i style="width:${x.d.done ? 100 : x.pct}%"></i></span>
      <span class="st">${x.d.done ? `✅ ${fmt(x.t)}` : x.d.gaveUp ? '🏳️' : `${x.pct}%`}${x.d.miss ? ` <em>❌${x.d.miss}</em>` : ''}</span>
    </div>`;
  }).join('');
}
function paintGrid() {
  const el = document.getElementById('grid'), g = curGame(), L = S.L; if (!el || !g || !L) return;
  const sel = L.sel, selVal = sel >= 0 ? L.cells[sel] : 0;
  let html = '';
  for (let i = 0; i < 81; i++) {
    const given = g.puzzle[i] !== '0', v = L.cells[i];
    const cls = ['c'];
    if (given) cls.push('given'); else if (v) cls.push('mine');
    if (i === sel) cls.push('sel');
    else if (sel >= 0 && (ROW[i] === ROW[sel] || COL[i] === COL[sel] || BOX[i] === BOX[sel])) cls.push('peer');
    if (selVal && v === selVal) cls.push('same');
    if (i === L.flash) cls.push('wrong');
    if (COL[i] % 3 === 2 && COL[i] < 8) cls.push('br');
    if (ROW[i] % 3 === 2 && ROW[i] < 8) cls.push('bb');
    let inner = '';
    if (v) inner = v;
    else if (L.memo[i]) inner = `<span class="memo">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<i>${L.memo[i] & (1 << d) ? d : ''}</i>`).join('')}</span>`;
    html += `<button class="${cls.join(' ')}" data-cell="${i}">${inner}</button>`;
  }
  setHTML(el, html);
}
function paintPad() {
  const el = document.getElementById('pad'), g = curGame(), L = S.L; if (!el || !g || !L) return;
  const cnt = Array(10).fill(0); for (const v of L.cells) cnt[v]++;
  const off = !canInput();
  setHTML(el, `<div class="nums">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button class="num ${cnt[d] >= 9 ? 'used' : ''}" data-num="${d}" ${off ? 'disabled' : ''}><b>${d}</b><small>${9 - cnt[d] || ''}</small></button>`).join('')}</div>
    <div class="tools">
      <button class="btn ${L.memoMode ? 'on-memo' : ''}" data-action="memo" ${off ? 'disabled' : ''}>✏️ メモ ${L.memoMode ? 'ON' : 'OFF'}</button>
      <button class="btn" data-action="erase" ${off ? 'disabled' : ''}>🧽 メモを消す</button>
    </div>`);
}
function playDyn() {
  const g = curGame(), d = pdata(g, S.pid);
  if (!inGame(g)) return '';
  if (d.done) return `<div class="waiting">クリア！ ほかの人を待っています<span class="dots"></span></div>`;
  if (d.gaveUp) return `<div class="waiting">ギブアップしました。結果を待っています<span class="dots"></span></div>`;
  return `<div class="center"><button class="btn small ghost" data-action="giveup">🏳️ ギブアップ</button></div>`;
}

// ---------- 結果 ----------
function resultView() {
  const g = curGame(), wins = winsTotal(), now = g.endedAt || S.store.now();
  const rows = g.order.map((id) => ({ id, d: pdata(g, id), t: liveTime(g, id, now) }))
    .sort((a, b) => (b.d.done ? 1 : 0) - (a.d.done ? 1 : 0) || a.t - b.t);
  const w = g.winner ? player(g.winner) : null;
  const total = toFill(g);
  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>${w ? `${g.winner === S.pid ? 'あなた' : `${esc(w.name)} さん`}の勝ち！` : '勝者なし'}</h2>
      <p class="muted small">${DIFFS[g.diff]?.label}・ペナルティ ${g.pen}秒ずつ増加</p>
    </section>
    <section class="card"><ol class="standings">${rows.map((x, i) => {
      const p = player(x.id), pen = penaltyTotal(x.d.miss || 0, g.pen);
      const filled = x.d.cells ? [...x.d.cells].filter((c, k) => c !== '0' && g.puzzle[k] === '0').length : 0;
      return `<li class="${x.id === S.pid ? 'me' : ''}"><span class="rank r${x.d.done ? i + 1 : 0}">${x.d.done ? i + 1 : '-'}</span>${avatar(p, 'sm')}<span class="nm">${esc(p.name)}${x.id === g.winner ? ' 👑' : ''}
        <small class="su-detail">${x.d.done ? `${fmt(x.d.ms)}＋❌${x.d.miss || 0}回(+${pen}秒)` : x.d.gaveUp ? 'ギブアップ' : `未完成 ${Math.round((filled / total) * 100)}%`}・通算🏆${wins[x.id] || 0}</small></span>
        <b>${x.d.done ? fmt(x.t) : '—'}</b></li>`;
    }).join('')}</ol></section>
    <div id="dyn"></div>`;
}
function resultDyn() {
  if (isHost()) {
    return `<div class="host-bar">
      <button class="btn primary big" data-action="start">🔁 新しい盤面でもう一戦</button>
      <button class="btn ghost wide" data-action="to-lobby">ロビーに戻る（設定を変える）</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = pageUrl('sudoku.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'ナンプレバトル', text: `ナンプレバトルで勝負しよう！部屋コード：${S.code}`, url: pageUrl('sudoku.html', S.code) }); } catch {}
}
const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  set: (el) => S.store.set(`${roomPath()}/meta/${el.dataset.k}`, JSON.parse(el.dataset.v)),
  start: startGame,
  'to-lobby': () => S.store.update(roomPath(), { 'state/phase': 'lobby' }),
  memo: () => { if (S.L) { S.L.memoMode = !S.L.memoMode; paintPad(); } },
  erase: eraseCell,
  giveup: giveUp,
};
$app.addEventListener('click', (e) => {
  const cell = e.target.closest('[data-cell]');
  if (cell) { select(+cell.dataset.cell); return; }
  const num = e.target.closest('[data-num]');
  if (num && !num.disabled) { inputDigit(+num.dataset.num).catch((err) => toast('エラー：' + (err?.message || err))); return; }
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
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input') || !S.L || stateOf().phase !== 'play') return;
  const L = S.L;
  if (/^[1-9]$/.test(e.key)) { inputDigit(+e.key); e.preventDefault(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { eraseCell(); e.preventDefault(); return; }
  if (e.key === 'm' || e.key === 'M') { L.memoMode = !L.memoMode; paintPad(); return; }
  const mv = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (mv !== undefined) {
    e.preventDefault();
    if (L.sel < 0) { select(40); return; }
    let i = L.sel + mv;
    if (mv === -1 && COL[L.sel] === 0) i = L.sel + 8;
    if (mv === 1 && COL[L.sel] === 8) i = L.sel - 8;
    select((i + 81) % 81);
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
