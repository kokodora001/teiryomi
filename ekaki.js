// =============================================================
//  絵描き人狼 — 1人だけお題を知らない「人狼」を、みんなの絵から見つけ出す
// =============================================================
import { createStore, isLocalMode } from './store.js';
import { EKAKI_PRESETS } from './ekaki-presets.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, shuffle, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';

// ---------- 定数 ----------
const GAME = 'ekaki';
const COLORS = ['#e8384f', '#1c7ed6', '#2f9e44', '#f08c00', '#9c36b5', '#0c8599', '#d6336c', '#5c940d', '#7048e8', '#a0522d'];
const PTS_WOLF_WIN = 3, PTS_CITIZEN_WIN = 1, PTS_DETECTIVE = 1, PTS_BLAME = -2;
const PAPER = '#fffdf6';
const RES = 1295; // 座標の分解能（base36 2桁）
const MAX_POINTS = 1200;

const $app = document.getElementById('app');

const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null, viewKey: '',
  drawing: null, pending: null, pendingKey: '', lastLive: 0,
  flipped: {}, peek: false, peekTimer: null, highlight: null,
  replay: null, hostBusy: '', notified: '', confettiDone: {}, phaseSeen: '',
};

// ---------- ルーム状態の参照 ----------
const rk = (n) => 'r' + n;
const roomPath = () => `rooms/${S.code}`;
const roundPath = (n = stateOf().round) => `rooms/${S.code}/rounds/${rk(n)}`;
function playerList() {
  return Object.entries(S.room?.players || {})
    .filter(([, p]) => p && p.name)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
const onlinePlayers = () => playerList().filter((p) => p.online);
const hostId = () => (onlinePlayers()[0] || playerList()[0] || {}).id;
const isHost = () => hostId() === S.pid;
function player(id) { const p = S.room?.players?.[id]; return p ? { id, ...p } : { id, name: '???', color: '#888', online: false }; }
const stateOf = () => S.room?.state || { phase: 'lobby', round: 0 };
const curRound = () => S.room?.rounds?.[rk(stateOf().round)] || null;
const settings = () => ({ mode: S.room?.meta?.mode || 'random', laps: S.room?.meta?.laps || 2 });
const minPlayers = () => (settings().mode === 'gm' ? 4 : 3);

function roleOf(r, id = S.pid) {
  if (!r) return 'none';
  if (r.gmId === id) return 'gm';
  if (!r.participants?.[id]) return 'spectator';
  return r.wolfId === id ? 'wolf' : 'citizen';
}
const myRole = () => roleOf(curRound());
const participants = (r) => Object.keys(r?.participants || {});
function strokesOf(r) {
  const s = r?.strokes; if (!s) return [];
  const arr = Array.isArray(s) ? s : Object.keys(s).sort((a, b) => a - b).map((k) => s[k]);
  return arr.filter(Boolean);
}
function turnInfo(r) {
  const order = r?.order || [], laps = r?.laps || 1;
  const total = order.length * laps, t = r?.turn || 0;
  return { order, laps, total, t, lap: Math.min(laps, Math.floor(t / (order.length || 1)) + 1), idx: t % (order.length || 1), drawer: t < total ? order[t % order.length] : null };
}

// ---------- 点列のエンコード（4文字/点） ----------
const c2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * RES).toString(36).padStart(2, '0');
const enc = (pts) => pts.map(([x, y]) => c2(x) + c2(y)).join('');
function dec(s) {
  const out = [];
  for (let i = 0; i + 4 <= (s || '').length; i += 4) out.push([parseInt(s.slice(i, i + 2), 36) / RES, parseInt(s.slice(i + 2, i + 4), 36) / RES]);
  return out;
}

// ---------- 回答の判定 ----------
function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[\s・、。,.!！?？「」『』'"〜~ー-]/g, '')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
const isCorrect = (guess, alts) => !!norm(guess) && (alts || []).some((a) => norm(a) === norm(guess));

// ---------- 得点 ----------
function roundScores(r) {
  const s = {}, o = r?.outcome; if (!o) return s;
  for (const id of participants(r)) {
    if (id === r.wolfId) { if (o.wolfWin) s[id] = (s[id] || 0) + PTS_WOLF_WIN; continue; }
    if (!o.wolfWin) s[id] = (s[id] || 0) + PTS_CITIZEN_WIN;
    if (r.votes?.[id] === r.wolfId) s[id] = (s[id] || 0) + PTS_DETECTIVE;
  }
  const culprit = r.blameResult?.target;
  if (culprit) s[culprit] = (s[culprit] || 0) + PTS_BLAME;
  return s;
}
function finishedRounds() {
  return Object.entries(S.room?.rounds || {})
    .filter(([, r]) => r && r.outcome)
    .map(([k, r]) => ({ n: +k.slice(1), ...r }))
    .sort((a, b) => a.n - b.n);
}
function totals() {
  const t = {};
  for (const p of playerList()) t[p.id] = 0;
  for (const r of finishedRounds()) for (const [id, v] of Object.entries(roundScores(r))) t[id] = (t[id] || 0) + v;
  return t;
}
function tally(r) {
  const c = {};
  for (const [voter, target] of Object.entries(r?.votes || {})) if (r.participants?.[voter]) c[target] = (c[target] || 0) + 1;
  return c;
}

// ---------- 戦犯投票（市民が負けたときだけ） ----------
const blameNeeded = (r) => !!r?.outcome?.wolfWin && citizens(r).length > 0;
const citizens = (r) => participants(r).filter((id) => id !== r.wolfId);
function blameTally(r) {
  const c = {};
  for (const [v, t] of Object.entries(r?.blame || {})) if (r.participants?.[v]) c[t] = (c[t] || 0) + 1;
  return c;
}
const fmtPts = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '±0');

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
      <li>みんなにお題が配られる。ただし<b>1人だけ「人狼」</b>で、人狼にはジャンルしか分からない</li>
      <li>順番に<b>一筆ずつ</b>描いていく（指・ペンを離すまでが一筆）。これを何周かくり返す</li>
      <li>描き終わったら話し合って、人狼だと思う人に<b>投票</b></li>
      <li>人狼が単独で最多票なら<b>捕まる</b>。でも人狼がお題を<b>当てたら逆転勝利！</b></li>
    </ol>
    <p class="muted small">市民はお題を知っている証拠を描きつつ、人狼にバレない絶妙な一筆を。人狼はみんなの絵から推理して、知っているフリをしよう。</p>
    <div class="score-legend">
      <span>🐺 人狼の勝ち <b>人狼 +${PTS_WOLF_WIN}</b></span>
      <span>🧑‍🤝‍🧑 市民の勝ち <b>市民 +${PTS_CITIZEN_WIN}</b></span>
      <span>🔍 人狼に投票した市民 <b>+${PTS_DETECTIVE}</b></span>
      <span>😇 市民が負けたら戦犯投票 <b>最多票の人 ${PTS_BLAME}</b></span>
    </div>
    <p class="muted small">同票で最多が複数いるときは人狼の逃げ切りです。</p>
  </details>`;
}
function logoHTML() {
  return `<div class="logo ekaki-logo">
    <div class="ek-mark"><span>🖌</span><span>🐺</span></div>
    <h1>絵描き人狼</h1>
    <p>一筆ずつ描いて、お題を知らない人狼を探せ</p>
  </div>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    ${logoHTML()}
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
  await S.store.set(`rooms/${code}`, { meta: { game: GAME, createdAt: Date.now(), laps: 2, mode: 'random' }, state: { phase: 'lobby', round: 0 } });
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
  await joinPlayer(S.store, code, S.pid, S.name, COLORS);
  S.stopPresence = S.store.presence(`rooms/${code}/players/${S.pid}/online`);
  S.unsub = S.store.on(`rooms/${code}`, onRoom);
}
async function leaveRoom() {
  if (!confirm('部屋から退出しますか？')) return;
  const phase = stateOf().phase, code = S.code;
  S.unsub?.(); S.unsub = null; S.stopPresence?.(); S.stopPresence = null;
  if (phase === 'lobby') await S.store.remove(`rooms/${code}/players/${S.pid}`);
  else await S.store.set(`rooms/${code}/players/${S.pid}/online`, false);
  sessionStorage.removeItem(ROOM_KEY);
  S.code = null; S.room = null; setUrlRoom(null); document.title = '絵描き人狼 — あそびば';
  renderHome();
}

// =============================================================
//  ルーム更新・ホストの進行
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    S.unsub?.(); S.stopPresence?.();
    sessionStorage.removeItem(ROOM_KEY); setUrlRoom(null);
    S.code = null; S.room = null; toast('部屋が見つかりません'); renderHome(); return;
  }
  if (followRoom(room, GAME, S.code)) { S.unsub?.(); return; }
  S.room = room;
  const st = stateOf();
  const ph = `${st.phase}:${st.round}`;
  if (ph !== S.phaseSeen) { S.phaseSeen = ph; S.highlight = null; S.peek = false; S.replay = null; }
  hostDuties();
  notifyTurn();
  render();
}

async function hostDo(key, fn) {
  if (S.hostBusy === key) return;
  S.hostBusy = key;
  try { await fn(); } catch (e) { console.error(e); S.hostBusy = ''; }
}
function hostDuties() {
  if (!isHost()) return;
  const st = stateOf(), r = curRound(); if (!r) return;
  const key = `${st.phase}:${st.round}`;
  if (st.phase === 'role') {
    const need = participants(r).filter((id) => player(id).online);
    if (need.length && need.every((id) => r.ready?.[id])) hostDo(key, () => S.store.set(`${roomPath()}/state/phase`, 'draw'));
  } else if (st.phase === 'draw') {
    if (turnInfo(r).drawer === null) hostDo(key, () => S.store.set(`${roomPath()}/state/phase`, 'vote'));
  } else if (st.phase === 'vote') {
    const need = participants(r).filter((id) => player(id).online);
    if (need.length && need.every((id) => r.votes?.[id])) hostDo(key, finalizeVote);
  } else if (st.phase === 'result' && blameNeeded(r) && !r.blameResult) {
    const need = participants(r).filter((id) => player(id).online);
    if (need.length && need.every((id) => r.blame?.[id])) hostDo(`blame:${st.round}`, finalizeBlame);
  }
}

function notifyTurn() {
  const st = stateOf(), r = curRound();
  const mine = st.phase === 'draw' && r && turnInfo(r).drawer === S.pid;
  document.title = mine ? '🖌 あなたの番！ — 絵描き人狼' : '絵描き人狼 — あそびば';
  if (!mine) return;
  const key = `${st.round}:${r.turn || 0}`;
  if (S.notified === key) return;
  S.notified = key;
  if (navigator.vibrate) try { navigator.vibrate([40, 60, 40]); } catch {}
}

// ---------- ラウンド開始 ----------
function usedWords() { return new Set(Object.values(S.room?.rounds || {}).map((r) => r?.word).filter(Boolean)); }
function pickTopic() {
  const used = usedWords();
  const pool = [];
  for (const c of EKAKI_PRESETS) for (const w of c.words) {
    const alts = w.split('|');
    if (!used.has(alts[0])) pool.push({ category: c.category, word: alts[0], alts });
  }
  const src = pool.length ? pool : EKAKI_PRESETS.flatMap((c) => c.words.map((w) => ({ category: c.category, word: w.split('|')[0], alts: w.split('|') })));
  return src[Math.floor(Math.random() * src.length)];
}
function buildRound(ids, topic, gmId = null) {
  const wolfId = ids[Math.floor(Math.random() * ids.length)];
  const order = shuffle(ids);
  if (order[0] === wolfId) { const j = 1 + Math.floor(Math.random() * (order.length - 1)); [order[0], order[j]] = [order[j], order[0]]; } // 人狼は先頭にしない
  const r = {
    category: topic.category, word: topic.word, alts: topic.alts, wolfId, order,
    participants: Object.fromEntries(ids.map((id) => [id, true])),
    laps: settings().laps, turn: 0,
  };
  if (gmId) r.gmId = gmId;
  return r;
}
function nextGm(after) {
  const all = playerList();
  const i = all.findIndex((p) => p.id === after);
  const rot = i < 0 ? all : [...all.slice(i + 1), ...all.slice(0, i + 1)];
  return rot.find((p) => p.online)?.id || null;
}
async function startRound(n) {
  if (onlinePlayers().length < minPlayers()) return toast(`${minPlayers()}人以上いないと始められません`);
  if (settings().mode === 'gm') {
    const prev = S.room.rounds?.[rk(n - 1)]?.gmId;
    const gm = nextGm(prev);
    await S.store.update(roomPath(), { state: { phase: 'topic', round: n }, [`rounds/${rk(n)}`]: { gmId: gm } });
  } else {
    const ids = onlinePlayers().map((p) => p.id);
    await S.store.update(roomPath(), { state: { phase: 'role', round: n }, [`rounds/${rk(n)}`]: buildRound(ids, pickTopic()) });
  }
}
const startGame = () => startRound(1);
const nextRound = () => startRound(stateOf().round + 1);

// =============================================================
//  描画（画面）
// =============================================================
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }

function render() {
  if (!S.room) return;
  const st = stateOf(), r = curRound();
  const key = [st.phase, st.round, myRole(), r?.guess ? 1 : 0].join('|');
  if (key !== S.viewKey) {
    S.viewKey = key;
    const views = { lobby: lobbyView, topic: topicView, role: roleView, draw: drawView, vote: voteView, guess: guessView, result: resultView, final: finalView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main ekaki phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    window.scrollTo({ top: 0 });
    if (st.phase === 'result' && !S.confettiDone[st.round]) {
      S.confettiDone[st.round] = true;
      const me = r?.outcome && (roleOf(r) === 'wolf' ? r.outcome.wolfWin : roleOf(r) === 'citizen' ? !r.outcome.wolfWin : false);
      if (me) setTimeout(() => confetti(110, [...COLORS, '#ffd84d', '#ffffff']), 250);
    }
    if (st.phase === 'final' && !S.confettiDone.final) { S.confettiDone.final = true; setTimeout(() => confetti(140), 300); }
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('turn'), turnHTML());
  setHTML(document.getElementById('legend'), legendHTML());
  setHTML(document.getElementById('peek'), peekHTML());
  setHTML(document.getElementById('dyn'), dynHTML());
  if (stateOf().phase === 'result') {
    setHTML(document.getElementById('blame'), blameHTML());
    setHTML(document.getElementById('scores'), roundScoresHTML());
  }
  paintMain();
  if (stateOf().phase === 'final') paintHistory();
}
function dynHTML() {
  const f = { lobby: lobbyDyn, topic: topicDyn, role: roleDyn, draw: drawDyn, vote: voteDyn, guess: guessDyn, result: resultDyn, final: finalDyn }[stateOf().phase];
  return f ? f() : '';
}

function phaseChipHTML() {
  const st = stateOf();
  const label = { lobby: 'メンバー待ち', topic: 'お題決め', role: '役職確認', draw: 'お絵描き中', vote: '投票タイム', guess: '人狼の逆転チャンス', result: '結果発表', final: '最終結果' }[st.phase] || '';
  return `${st.round && !['final', 'lobby'].includes(st.phase) ? `<b>第${st.round}戦</b>` : ''}<span>${label}</span>`;
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
  const showScore = st.phase !== 'lobby';
  const drawer = st.phase === 'draw' && r ? turnInfo(r).drawer : null;
  return playerList().map((p) => {
    const tags = [];
    if (p.id === h) tags.push('<span class="tag host">ホスト</span>');
    if (r && r.gmId === p.id && st.phase !== 'final' && st.phase !== 'lobby') tags.push('<span class="tag setter">出題者</span>');
    return `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''} ${drawer === p.id ? 'drawing' : ''}">
      ${avatar(p)}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${tags.join('')}${showScore ? `<span class="pscore">${tot[p.id] || 0}pt</span>` : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
    </div>`;
  }).join('');
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
  const ps = playerList(), host = isHost(), { mode, laps } = settings(), n = onlinePlayers().length, h = hostId(), need = minPlayers();
  return `<section class="card">
      <h3>参加メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>お題の決め方</h3>
      <div class="seg">
        <button class="seg-btn ${mode === 'random' ? 'on' : ''}" data-action="set-mode" data-mode="random" ${host ? '' : 'disabled'}>🎲 おまかせ</button>
        <button class="seg-btn ${mode === 'gm' ? 'on' : ''}" data-action="set-mode" data-mode="gm" ${host ? '' : 'disabled'}>✍️ 出題者が決める</button>
      </div>
      <p class="muted small">${mode === 'random' ? `全員が参加。お題は${EKAKI_PRESETS.length}ジャンルからランダムに出ます（3人〜）` : '毎回1人が交代で出題者になってお題を考えます。出題者は描かずに見守り役（4人〜）'}</p>
      <h3 class="mt">一筆を何周する？</h3>
      <div class="seg">${[1, 2, 3].map((l) => `<button class="seg-btn ${laps === l ? 'on' : ''}" data-action="set-laps" data-laps="${l}" ${host ? '' : 'disabled'}>${l}周</button>`).join('')}</div>
      <p class="muted small">1人あたり${laps}回描きます${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start" ${n < need ? 'disabled' : ''}>${n < need ? `あと${need - n}人集まったら開始できます` : 'ゲームスタート！'}</button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- お題決め（出題者モード） ----------
function topicView() {
  const r = curRound(), gm = player(r.gmId);
  if (r.gmId === S.pid) {
    return `<section class="card topic-form">
      <div class="badge">あなたが出題者です</div>
      <h2>お題を決めよう</h2>
      <p class="muted small">ジャンルは人狼にも見えます。お題は人狼以外にだけ見えます。<br>あなたは描かずに、みんなの絵と推理を見守ります。</p>
      <button class="btn gacha wide" data-action="gacha">🎲 お題ガチャ <small>（ランダムに埋める）</small></button>
      <label class="field"><span>ジャンル（人狼にも見える）</span><input id="category" maxlength="16" placeholder="例：動物" enterkeyhint="next"></label>
      <label class="field"><span>お題（人狼には見えない）</span><input id="word" maxlength="20" placeholder="例：キリン" enterkeyhint="done"></label>
      <button class="btn primary big" data-action="submit-topic">この内容で出題する</button>
    </section><div id="dyn"></div>`;
  }
  return `<section class="card center thinking">
      ${avatar(gm, 'xl')}
      <h2><b style="color:${gm.color}">${esc(gm.name)}</b> さんが<br>お題を考えています</h2>
      <div class="pencil-loader">✏️</div>
    </section>
    <div id="dyn"></div>`;
}
function topicDyn() {
  const r = curRound();
  if (r && isHost() && r.gmId !== S.pid && !player(r.gmId).online) {
    return `<section class="card warn"><p>${esc(player(r.gmId).name)} さんの接続が切れています</p>
      <button class="btn" data-action="skip-gm">次の人に出題を回す</button></section>`;
  }
  return '';
}
function gacha() {
  const t = pickTopic();
  document.getElementById('category').value = t.category;
  document.getElementById('word').value = t.word;
  S.gachaAlts = t.alts;
  const form = document.querySelector('.topic-form');
  form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
}
async function submitTopic() {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'topic' || r?.gmId !== S.pid) return;
  const category = document.getElementById('category').value.trim();
  const word = document.getElementById('word').value.trim();
  if (!category) { toast('ジャンルを入力してね'); document.getElementById('category').focus(); return; }
  if (!word) { toast('お題を入力してね'); document.getElementById('word').focus(); return; }
  const ids = onlinePlayers().map((p) => p.id).filter((id) => id !== S.pid);
  if (ids.length < 3) return toast('出題者以外に3人以上必要です');
  const alts = S.gachaAlts && S.gachaAlts[0] === word ? S.gachaAlts : [word];
  await S.store.update(roomPath(), { 'state/phase': 'role', [`rounds/${rk(st.round)}`]: buildRound(ids, { category, word, alts }, S.pid) });
}
async function skipGm() {
  const st = stateOf(), r = curRound();
  const next = nextGm(r.gmId);
  if (!next || next === r.gmId) return toast('出題できる人がいません');
  await S.store.update(roomPath(), { [`rounds/${rk(st.round)}`]: { gmId: next } });
}

// ---------- 役職確認 ----------
function roleCardInner(r, role) {
  if (role === 'wolf') return `<div class="rc-kicker">あなたは</div><div class="rc-role wolf">人狼 🐺</div>
      <div class="rc-cat">ジャンル：<b>${esc(r.category)}</b></div>
      <p class="rc-note">お題は分かりません。みんなの絵から推理して、<br>知っているフリをして描こう</p>`;
  if (role === 'gm') return `<div class="rc-kicker">あなたは出題者</div><div class="rc-cat">ジャンル：<b>${esc(r.category)}</b></div>
      <div class="rc-word">${esc(r.word)}</div>
      <p class="rc-note">人狼は <b style="color:${player(r.wolfId).color}">${esc(player(r.wolfId).name)}</b> さん。<br>口出しせずに見守ろう</p>`;
  return `<div class="rc-kicker">あなたは市民。お題は…</div>
      <div class="rc-cat">ジャンル：<b>${esc(r.category)}</b></div>
      <div class="rc-word">${esc(r.word)}</div>
      <p class="rc-note">人狼にお題がバレないように、<br>でも仲間には伝わるように描こう</p>`;
}
function roleView() {
  const r = curRound(), role = myRole();
  if (role === 'spectator') {
    return `<section class="card center"><h2>観戦中</h2><p class="muted">途中参加のため、次のゲームから参加できます</p></section><div id="dyn"></div>`;
  }
  const flipped = role === 'gm' || S.flipped[stateOf().round];
  return `<section class="role-wrap">
      <button class="role-card ${flipped ? 'flipped' : ''} ${role}" data-action="flip" aria-label="カードをめくる">
        <div class="rc-face rc-back"><div class="rc-q">?</div><div class="rc-tap">タップしてめくる</div><div class="rc-hint">まわりの人に見られないように！</div></div>
        <div class="rc-face rc-front">${roleCardInner(r, role)}</div>
      </button>
    </section>
    <div id="dyn"></div>`;
}
function roleDyn() {
  const r = curRound(), role = myRole(), n = stateOf().round;
  const parts = participants(r), done = parts.filter((id) => r.ready?.[id]).length;
  let html = '';
  if (role === 'wolf' || role === 'citizen') {
    if (r.ready?.[S.pid]) html += `<div class="waiting">準備OK！ みんなを待っています<span class="dots"></span></div>`;
    else html += `<button class="btn primary big" data-action="ready" ${S.flipped[n] ? '' : 'disabled'}>${S.flipped[n] ? 'OK、覚えた！' : 'カードをめくって確認してね'}</button>`;
  }
  html += `<section class="card status">
      <h3>準備できた人 <small>${done} / ${parts.length}</small></h3>
      <div class="progress"><i style="width:${parts.length ? (done / parts.length) * 100 : 0}%"></i></div>
      <div class="ready-row">${parts.map((id) => { const p = player(id); return `<span class="rdy ${r.ready?.[id] ? 'ok' : ''} ${p.online ? '' : 'off'}">${avatar(p, 'sm')}${esc(p.name)}</span>`; }).join('')}</div>
    </section>`;
  if (isHost()) {
    const missing = parts.filter((id) => !r.ready?.[id]);
    if (missing.length && missing.length < parts.length) html += `<div class="center"><button class="btn small ghost" data-action="force-draw">待たずにお絵描きを始める</button></div>`;
  }
  return html;
}

// ---------- お題の確認（覗き見ボタン） ----------
function peekHTML() {
  const r = curRound(), role = myRole();
  if (!r || !['draw', 'vote'].includes(stateOf().phase) || role === 'spectator') return '';
  let txt;
  if (role === 'wolf') txt = `🐺 あなたは人狼　ジャンル：<b>${esc(r.category)}</b>`;
  else if (role === 'gm') txt = `お題：<b>${esc(r.word)}</b>　人狼：<b>${esc(player(r.wolfId).name)}</b>`;
  else txt = `${esc(r.category)}：<b>${esc(r.word)}</b>`;
  return `<button class="peek-btn ${S.peek ? 'open' : ''}" data-action="peek">
      <span class="peek-label">${S.peek ? txt : '👁 タップでお題を確認'}</span>
    </button>`;
}

// ---------- キャンバス ----------
function canvasBlock({ drawable = false } = {}) {
  return `<div class="paper-wrap ${drawable ? 'drawable' : ''}">
      <canvas id="cv" class="paper" aria-label="みんなの絵"></canvas>
      <div id="turn" class="turn-flag"></div>
    </div>
    <div id="legend" class="legend"></div>`;
}
function paint(canvas, strokes, { live = null, extra = [], highlight = null, progress = null } = {}) {
  if (!canvas) return;
  const w = canvas.clientWidth; if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.round(w * dpr);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, w);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const lw = Math.max(2.5, w * 0.013);
  const line = (pts, color, alpha = 1) => {
    if (!pts.length) return;
    ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw;
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * w, pts[0][1] * w, lw / 2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; return; }
    ctx.beginPath(); ctx.moveTo(pts[0][0] * w, pts[0][1] * w);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * w, mx * w, my * w);
    }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0] * w, l[1] * w);
    ctx.stroke(); ctx.globalAlpha = 1;
  };
  strokes.forEach((st, i) => {
    if (!st || st.skip) return;
    if (progress && i > progress.i) return;
    let pts = dec(st.p);
    if (progress && i === progress.i) pts = pts.slice(0, Math.max(1, Math.ceil(pts.length * progress.f)));
    line(pts, player(st.by).color, highlight && highlight !== st.by ? 0.12 : 1);
  });
  if (live && !progress) line(dec(live.p), player(live.by).color, highlight && highlight !== live.by ? 0.12 : 0.9);
  for (const e of extra) line(e.pts, e.color, 1);
}
function paintMain() {
  const cv = document.getElementById('cv'); if (!cv) return;
  const r = curRound(); if (!r) return;
  const st = stateOf();
  const extra = [];
  const myColor = player(S.pid).color;
  if (st.phase === 'draw') {
    syncPending();
    if (S.drawing) extra.push({ pts: S.drawing, color: myColor });
    else if (S.pending) extra.push({ pts: S.pending, color: myColor });
  }
  const live = st.phase === 'draw' && r.live && r.live.by !== S.pid ? r.live : null;
  paint(cv, strokesOf(r), { live, extra, highlight: S.highlight, progress: S.replay?.progress });
}
let paintQueued = false;
function paintSoon() { if (paintQueued) return; paintQueued = true; requestAnimationFrame(() => { paintQueued = false; paintMain(); }); }
window.addEventListener('resize', () => { paintMain(); if (stateOf().phase === 'final') paintHistory(); });

function legendHTML() {
  const r = curRound(); if (!r || !document.getElementById('legend')) return '';
  const st = stateOf(), ti = turnInfo(r);
  const clickable = st.phase !== 'draw';
  const counts = {};
  for (const s of strokesOf(r)) if (!s.skip) counts[s.by] = (counts[s.by] || 0) + 1;
  return `${clickable ? '<div class="legend-hint">名前をタップするとその人の線だけ表示</div>' : ''}
    <div class="legend-row">${ti.order.map((id, i) => {
      const p = player(id), cur = st.phase === 'draw' && ti.drawer === id;
      return `<button class="lg ${cur ? 'cur' : ''} ${S.highlight === id ? 'hl' : ''} ${S.highlight && S.highlight !== id ? 'dim' : ''}" ${clickable ? `data-action="highlight" data-id="${id}"` : 'tabindex="-1"'} style="--pc:${p.color}">
        <i></i><span>${esc(p.name)}</span>${st.phase === 'draw' ? `<small>${counts[id] || 0}/${ti.laps}</small>` : ''}
      </button>`;
    }).join('')}</div>`;
}
function turnHTML() {
  const r = curRound(), st = stateOf();
  if (!r || st.phase !== 'draw') return '';
  const ti = turnInfo(r); if (!ti.drawer) return '';
  const p = player(ti.drawer), mine = ti.drawer === S.pid;
  return `<span class="tf-lap">${ti.lap}周目 · ${ti.t + 1}/${ti.total}</span>
    <span class="tf-who ${mine ? 'mine' : ''}" style="--pc:${p.color}">${mine ? '🖌 あなたの番！' : `${esc(p.name)} さんが描いています`}</span>`;
}

// ---------- お絵描き ----------
function drawView() {
  const role = myRole();
  return `<div id="peek" class="peek"></div>
    ${canvasBlock({ drawable: role === 'citizen' || role === 'wolf' })}
    <div id="dyn"></div>`;
}
function pendingKeyNow() { const r = curRound(); return `${stateOf().round}:${r?.turn || 0}`; }
function syncPending() {
  const k = pendingKeyNow();
  if (S.pendingKey !== k) { S.pendingKey = k; S.pending = null; S.drawing = null; }
}
function drawDyn() {
  const r = curRound(), ti = turnInfo(r), role = myRole();
  syncPending();
  let html = '';
  if (ti.drawer === S.pid) {
    html += S.pending
      ? `<div class="row actions"><button class="btn" data-action="redo">↩ 描き直す</button><button class="btn primary grow" data-action="commit">この一筆で決定！</button></div>`
      : `<div class="draw-tip">紙の上をなぞって<b>一筆</b>描こう<br><span class="muted small">指を離すまでが一筆。離したあとに描き直しもできます</span></div>`;
  } else if (ti.drawer) {
    const next = ti.order[(ti.t + 1) % ti.order.length];
    const myNext = role === 'citizen' || role === 'wolf' ? ((ti.order.indexOf(S.pid) - ti.idx + ti.order.length) % ti.order.length) : -1;
    html += `<div class="draw-tip muted small">${myNext > 0 && ti.t + myNext < ti.total ? `あなたの番まであと <b>${myNext}</b> 人` : ti.t + 1 < ti.total ? `次は ${esc(player(next).name)} さん` : 'これが最後の一筆！'}</div>`;
    if (isHost() && !player(ti.drawer).online) {
      html += `<section class="card warn"><p>${esc(player(ti.drawer).name)} さんの接続が切れています</p><button class="btn" data-action="skip-turn">この人の番を飛ばす</button></section>`;
    }
  }
  return html;
}
function canvasPoint(e, cv) {
  const b = cv.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), Math.max(0, Math.min(1, (e.clientY - b.top) / b.height))];
}
function canDraw() {
  const r = curRound();
  return stateOf().phase === 'draw' && r && turnInfo(r).drawer === S.pid && !S.pending;
}
function sendLive(force = false) {
  const now = performance.now();
  if (!force && now - S.lastLive < 70) return;
  S.lastLive = now;
  const pts = S.drawing || S.pending;
  S.store.set(`${roundPath()}/live`, pts ? { by: S.pid, p: enc(pts) } : null).catch(() => {});
}
function onPointerDown(e) {
  if (e.target.id !== 'cv') return;
  syncPending();
  if (!canDraw()) {
    const r = curRound();
    if (stateOf().phase === 'draw' && r && turnInfo(r).drawer === S.pid && S.pending) toast('「決定」か「描き直す」を押してね');
    return;
  }
  e.preventDefault();
  const cv = e.target;
  try { cv.setPointerCapture(e.pointerId); } catch {}
  S.drawing = [canvasPoint(e, cv)];
  sendLive(true); paintSoon();
}
function onPointerMove(e) {
  if (!S.drawing || e.target.id !== 'cv') return;
  const cv = e.target;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (evs.length ? evs : [e])) {
    const p = canvasPoint(ev, cv), l = S.drawing[S.drawing.length - 1];
    if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.003 && S.drawing.length < MAX_POINTS) S.drawing.push(p);
  }
  sendLive(); paintSoon();
}
function onPointerUp(e) {
  if (!S.drawing) return;
  S.pending = S.drawing; S.drawing = null;
  sendLive(true); updateDynamic();
}
async function commitStroke() {
  const st = stateOf(), r = curRound(), ti = turnInfo(r);
  if (st.phase !== 'draw' || ti.drawer !== S.pid || !S.pending) return;
  const upd = {
    [`rounds/${rk(st.round)}/strokes/${ti.t}`]: { by: S.pid, p: enc(S.pending) },
    [`rounds/${rk(st.round)}/turn`]: ti.t + 1,
    [`rounds/${rk(st.round)}/live`]: null,
  };
  if (ti.t + 1 >= ti.total) upd['state/phase'] = 'vote';
  await S.store.update(roomPath(), upd);
}
function redo() {
  S.pending = null; S.drawing = null;
  sendLive(true); updateDynamic();
}
async function skipTurn() {
  const st = stateOf(), r = curRound(), ti = turnInfo(r);
  if (!ti.drawer) return;
  if (!confirm(`${player(ti.drawer).name} さんの番を飛ばしますか？`)) return;
  const upd = {
    [`rounds/${rk(st.round)}/strokes/${ti.t}`]: { by: ti.drawer, skip: true },
    [`rounds/${rk(st.round)}/turn`]: ti.t + 1,
    [`rounds/${rk(st.round)}/live`]: null,
  };
  if (ti.t + 1 >= ti.total) upd['state/phase'] = 'vote';
  await S.store.update(roomPath(), upd);
}

// ---------- 投票 ----------
function voteView() {
  return `<div class="vote-head"><h2>🗳 人狼は誰だ？</h2><p class="muted small">絵を見ながら話し合って、人狼だと思う人に投票しよう</p></div>
    <div id="peek" class="peek"></div>
    ${canvasBlock()}
    <div id="dyn"></div>`;
}
function voteDyn() {
  const r = curRound(), role = myRole(), parts = participants(r);
  const done = parts.filter((id) => r.votes?.[id]).length;
  let html = '';
  if (role === 'citizen' || role === 'wolf') {
    const mine = r.votes?.[S.pid];
    html += `<section class="card vote-card">
      <h3>${mine ? `<span class="muted">あなたの投票：</span>${esc(player(mine).name)} <small>（変更できます）</small>` : 'あなたの投票'}</h3>
      <div class="vote-grid">${r.order.filter((id) => id !== S.pid).map((id) => {
        const p = player(id);
        return `<button class="vote-btn ${mine === id ? 'on' : ''}" data-action="vote" data-id="${id}" style="--pc:${p.color}">${avatar(p)}<span>${esc(p.name)}</span>${mine === id ? '<em>✓</em>' : ''}</button>`;
      }).join('')}</div>
      ${role === 'wolf' ? '<p class="muted small center">あなたは人狼。自分以外の誰かに投票して疑いをそらそう</p>' : ''}
    </section>`;
  }
  html += `<section class="card status">
      <h3>投票した人 <small>${done} / ${parts.length}</small></h3>
      <div class="progress"><i style="width:${parts.length ? (done / parts.length) * 100 : 0}%"></i></div>
      <div class="ready-row">${parts.map((id) => { const p = player(id); return `<span class="rdy ${r.votes?.[id] ? 'ok' : ''} ${p.online ? '' : 'off'}">${avatar(p, 'sm')}${esc(p.name)}</span>`; }).join('')}</div>
    </section>`;
  if (isHost() && done > 0 && done < parts.length) html += `<div class="center"><button class="btn small ghost" data-action="force-vote">未投票の人を待たずに締め切る</button></div>`;
  return html;
}
async function vote(id) {
  if (stateOf().phase !== 'vote' || id === S.pid) return;
  await S.store.set(`${roundPath()}/votes/${S.pid}`, id);
}
async function finalizeVote() {
  const r = curRound(), st = stateOf();
  if (st.phase !== 'vote') return;
  const c = tally(r);
  const max = Math.max(0, ...Object.values(c));
  const top = Object.keys(c).filter((id) => c[id] === max);
  const caught = max > 0 && top.length === 1 && top[0] === r.wolfId;
  if (caught) {
    await S.store.update(roomPath(), { 'state/phase': 'guess', [`rounds/${rk(st.round)}/caught`]: true });
  } else {
    await S.store.update(roomPath(), { 'state/phase': 'result', [`rounds/${rk(st.round)}/caught`]: false, [`rounds/${rk(st.round)}/outcome`]: { wolfWin: true, reason: top.includes(r.wolfId) ? 'tie' : 'escaped' } });
  }
}
async function forceVote() {
  if (!confirm('未投票の人を待たずに締め切りますか？')) return;
  await finalizeVote();
}

// ---------- 投票結果（共通部品） ----------
function voteResultHTML(r) {
  const c = tally(r), max = Math.max(0, ...Object.values(c));
  const rows = r.order.map((id) => ({ id, n: c[id] || 0, voters: Object.entries(r.votes || {}).filter(([v, t]) => t === id && r.participants?.[v]).map(([v]) => v) }))
    .sort((a, b) => b.n - a.n);
  return `<section class="card">
    <h3>投票結果</h3>
    <ul class="vres">${rows.map((x) => {
      const p = player(x.id);
      return `<li class="${x.n === max && max > 0 ? 'top' : ''} ${x.id === r.wolfId ? 'wolf' : ''}">
        ${avatar(p, 'sm')}<span class="nm">${esc(p.name)}${x.id === r.wolfId ? ' 🐺' : ''}</span>
        <span class="vbar"><i style="width:${max ? (x.n / max) * 100 : 0}%;background:${p.color}"></i></span>
        <b>${x.n}</b>
        <span class="voters">${x.voters.map((v) => avatar(player(v), 'xs')).join('')}</span>
      </li>`;
    }).join('')}</ul>
  </section>`;
}

// ---------- 人狼の逆転チャンス ----------
function guessView() {
  const r = curRound(), wolf = player(r.wolfId), role = myRole();
  return `<section class="caught-banner">
      <div class="cb-kicker">投票の結果…</div>
      <div class="cb-who">${avatar(wolf, 'lg')}<span><b style="color:${wolf.color}">${esc(wolf.name)}</b> さんは</span></div>
      <div class="cb-big">人狼でした！🐺</div>
      <p>${role === 'wolf' ? 'バレてしまった…でもお題を当てれば逆転勝利！' : 'でも人狼がお題を当てたら逆転されます…'}</p>
    </section>
    <div id="dyn"></div>
    ${canvasBlock()}
    ${voteResultHTML(r)}`;
}
function guessDyn() {
  const r = curRound(), role = myRole(), wolf = player(r.wolfId);
  if (!r.guess) {
    if (role === 'wolf') {
      return `<section class="card guess-form">
        <h3>お題は何だった？</h3>
        <p class="muted small">ジャンル：<b>${esc(r.category)}</b></p>
        <div class="join-row"><input id="guess" maxlength="20" placeholder="お題を入力" enterkeyhint="done" autocomplete="off"><button class="btn primary" data-action="submit-guess">回答</button></div>
        <p class="muted tiny">チャンスは1回だけ。ひらがな・カタカナの違いは自動で判定します</p>
      </section>`;
    }
    let html = `<div class="waiting">🐺 ${esc(wolf.name)} さんがお題を推理しています<span class="dots"></span></div>`;
    if (isHost() && !wolf.online) html += `<section class="card warn"><p>${esc(wolf.name)} さんの接続が切れています</p><button class="btn" data-action="forfeit">市民の勝ちで終える</button></section>`;
    return html;
  }
  // 自動判定で一致しなかった → 人狼以外が判定
  if (role === 'wolf') return `<section class="card center"><p>あなたの回答：<b class="big-guess">${esc(r.guess.text)}</b></p><div class="waiting">みんなが判定しています<span class="dots"></span></div></section>`;
  return `<section class="card judge">
      <h3>判定してください</h3>
      <div class="judge-cmp">
        <div><small>人狼の回答</small><b>${esc(r.guess.text)}</b></div>
        <div><small>正解のお題</small><b>${esc(r.word)}</b></div>
      </div>
      <p class="muted small center">言い方が違うだけで同じものなら「正解」にしてOK（誰か1人が押せば決まります）</p>
      <div class="row"><button class="btn grow judge-ok" data-action="judge" data-ok="1">⭕ 正解</button><button class="btn grow judge-ng" data-action="judge" data-ok="0">❌ 不正解</button></div>
    </section>`;
}
async function submitGuess() {
  const el = document.getElementById('guess');
  const text = (el?.value || '').trim();
  if (!text) { toast('お題を入力してね'); el?.focus(); return; }
  const st = stateOf(), r = curRound();
  if (st.phase !== 'guess' || r.wolfId !== S.pid || r.guess) return;
  const base = `rounds/${rk(st.round)}`;
  if (isCorrect(text, r.alts || [r.word])) {
    await S.store.update(roomPath(), { [`${base}/guess`]: { text, auto: true }, [`${base}/outcome`]: { wolfWin: true, reason: 'guessed' }, 'state/phase': 'result' });
  } else {
    await S.store.update(roomPath(), { [`${base}/guess`]: { text } });
  }
}
async function judge(ok) {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'guess' || !r.guess || r.wolfId === S.pid) return;
  const base = `rounds/${rk(st.round)}`;
  await S.store.update(roomPath(), { [`${base}/judgedBy`]: S.pid, [`${base}/outcome`]: { wolfWin: !!ok, reason: ok ? 'guessed' : 'caught' }, 'state/phase': 'result' });
}
async function forfeit() {
  const st = stateOf();
  await S.store.update(roomPath(), { [`rounds/${rk(st.round)}/outcome`]: { wolfWin: false, reason: 'forfeit' }, 'state/phase': 'result' });
}

// ---------- 結果 ----------
function reasonText(r) {
  const w = esc(player(r.wolfId).name);
  return {
    escaped: `人狼の ${w} さんは疑われずに逃げ切りました`,
    tie: `票が割れて、人狼の ${w} さんは逃げ切りました`,
    guessed: `捕まった ${w} さんがお題を見事に当てて逆転！`,
    caught: `人狼の ${w} さんを捕まえ、お題も守りきりました`,
    forfeit: `人狼の ${w} さんが不在のため、市民の勝ち`,
  }[r.outcome.reason] || '';
}
function resultView() {
  const r = curRound(), o = r.outcome, wolf = player(r.wolfId), role = myRole();
  const meWin = role === 'wolf' ? o.wolfWin : role === 'citizen' ? !o.wolfWin : null;
  return `<section class="result-banner ${o.wolfWin ? 'wolf-win' : 'citizen-win'}">
      <div class="rb-icon">${o.wolfWin ? '🐺' : '🎉'}</div>
      <div class="rb-title">${o.wolfWin ? '人狼の勝ち！' : '市民の勝ち！'}</div>
      <p>${reasonText(r)}</p>
      ${meWin === true ? '<div class="rb-me win">あなたの勝ち！</div>' : meWin === false ? '<div class="rb-me lose">あなたの負け…</div>' : ''}
      ${blameNeeded(r) ? '<div class="rb-blame">⚖️ このあと戦犯投票があります（下へ）</div>' : ''}
    </section>
    <section class="answer-row">
      <div class="ans-box"><small>人狼</small><div>${avatar(wolf, 'sm')} <b>${esc(wolf.name)}</b></div></div>
      <div class="ans-box"><small>お題（${esc(r.category)}）</small><div><b class="ans-word">${esc(r.word)}</b></div></div>
      ${r.guess ? `<div class="ans-box"><small>人狼の回答</small><div><b>${esc(r.guess.text)}</b> ${o.reason === 'guessed' ? '⭕' : '❌'}</div></div>` : ''}
    </section>
    ${canvasBlock()}
    <div class="center"><button class="btn small" data-action="replay">▶ 描いた順に再生</button></div>
    ${voteResultHTML(r)}
    <div id="blame"></div>
    <div id="scores"></div>
    <div id="dyn"></div>`;
}
function roundScoresHTML() {
  const r = curRound(), sc = roundScores(r), culprit = r.blameResult?.target;
  const pending = blameNeeded(r) && !r.blameResult;
  return `<h3 class="sec-title">今回の得点${pending ? ' <small>（戦犯投票のあとに確定）</small>' : ''}</h3>
    <section class="card"><ul class="standings">${participants(r).map((id) => ({ id, v: sc[id] || 0 })).sort((a, b) => b.v - a.v).map((x) => {
      const p = player(x.id);
      return `<li class="${x.id === S.pid ? 'me' : ''}">${avatar(p, 'sm')}<span class="nm">${esc(p.name)}${x.id === r.wolfId ? ' 🐺' : ''}${r.votes?.[x.id] === r.wolfId && x.id !== r.wolfId ? ' <span class="tag det">🔍名探偵</span>' : ''}${x.id === culprit ? ' <span class="tag culprit">😇戦犯</span>' : ''}</span><b class="${x.v < 0 ? 'neg' : ''}">${fmtPts(x.v)}<small>pt</small></b></li>`;
    }).join('')}</ul></section>
    <h3 class="sec-title">現在の順位</h3>
    ${standingsHTML()}`;
}
function blameHTML() {
  const r = curRound();
  if (!blameNeeded(r)) return '';
  const parts = participants(r), cits = citizens(r);
  if (r.blameResult) {
    const c = blameTally(r), max = Math.max(0, ...Object.values(c)), t = r.blameResult.target;
    const rows = [...cits, 'none'].map((id) => ({ id, n: c[id] || 0, voters: Object.entries(r.blame || {}).filter(([v, x]) => x === id && r.participants?.[v]).map(([v]) => v) }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
    return `<section class="card blame-card done">
      <h3>⚖️ 戦犯投票の結果</h3>
      <div class="blame-verdict ${t ? 'guilty' : 'free'}">${t ? `${avatar(player(t), 'sm')}<span><b>${esc(player(t).name)}</b> さんが戦犯に…！</span><em>${PTS_BLAME}点</em>` : '<span>🙆 戦犯なし！ 減点はありません</span>'}</div>
      <ul class="vres">${rows.map((x) => {
        const isNone = x.id === 'none', p = isNone ? null : player(x.id);
        return `<li class="${x.n === max ? 'top' : ''}">${isNone ? '<span class="avatar sm none-av">🙆</span>' : avatar(p, 'sm')}<span class="nm">${isNone ? '戦犯なし' : esc(p.name)}</span>
          <span class="vbar"><i style="width:${max ? (x.n / max) * 100 : 0}%;background:${isNone ? '#5fe08a' : p.color}"></i></span><b>${x.n}</b>
          <span class="voters">${x.voters.map((v) => avatar(player(v), 'xs')).join('')}</span></li>`;
      }).join('')}</ul>
      ${!t && rows.length > 1 && rows[0].n === rows[1].n ? '<p class="muted tiny center">同票のため減点なし</p>' : ''}
    </section>`;
  }
  const mine = r.blame?.[S.pid], canVote = !!r.participants?.[S.pid];
  const done = parts.filter((id) => r.blame?.[id]).length;
  return `<section class="card blame-card">
    <h3>⚖️ 戦犯投票</h3>
    <p class="muted small">市民が負けてしまった…足を引っぱったのは誰？<br>最多票の人は <b class="neg">${PTS_BLAME}点</b>。同票や「戦犯なし」が最多なら減点なし。</p>
    ${canVote ? `<div class="vote-grid">${cits.filter((id) => id !== S.pid).map((id) => {
      const p = player(id);
      return `<button class="vote-btn ${mine === id ? 'on' : ''}" data-action="blame" data-id="${id}" style="--pc:${p.color}">${avatar(p)}<span>${esc(p.name)}</span>${mine === id ? '<em>✓</em>' : ''}</button>`;
    }).join('')}
      <button class="vote-btn none ${mine === 'none' ? 'on' : ''}" data-action="blame" data-id="none" style="--pc:#5fe08a"><span class="avatar none-av">🙆</span><span>戦犯なし</span>${mine === 'none' ? '<em>✓</em>' : ''}</button>
    </div>
    ${mine ? '<p class="muted tiny center">全員がそろうまで変更できます</p>' : ''}` : '<p class="muted small center">観戦中のため投票はできません</p>'}
    <div class="progress"><i style="width:${(done / parts.length) * 100}%"></i></div>
    <div class="ready-row">${parts.map((id) => { const p = player(id); return `<span class="rdy ${r.blame?.[id] ? 'ok' : ''} ${p.online ? '' : 'off'}">${avatar(p, 'sm')}${esc(p.name)}</span>`; }).join('')}</div>
    ${isHost() && done > 0 && done < parts.length ? '<div class="center"><button class="btn small ghost" data-action="force-blame">未投票の人を待たずに締め切る</button></div>' : ''}
  </section>`;
}
async function voteBlame(id) {
  const r = curRound();
  if (stateOf().phase !== 'result' || !blameNeeded(r) || r.blameResult || id === S.pid) return;
  await S.store.set(`${roundPath()}/blame/${S.pid}`, id);
}
async function finalizeBlame() {
  const r = curRound(); if (!blameNeeded(r) || r.blameResult) return;
  const c = blameTally(r), max = Math.max(0, ...Object.values(c));
  const top = Object.keys(c).filter((k) => c[k] === max);
  const target = max > 0 && top.length === 1 && top[0] !== 'none' ? top[0] : '';
  await S.store.set(`${roundPath()}/blameResult`, { target, at: Date.now() });
}
function standingsHTML() {
  const tot = totals();
  const ps = playerList().sort((a, b) => (tot[b.id] || 0) - (tot[a.id] || 0));
  return `<section class="card"><ol class="standings">${ps.map((p) => {
    const pts = tot[p.id] || 0, rank = 1 + ps.filter((q) => (tot[q.id] || 0) > pts).length;
    return `<li class="${p.id === S.pid ? 'me' : ''}"><span class="rank r${rank}">${rank}</span>${avatar(p, 'sm')}<span class="nm">${esc(p.name)}</span><b>${pts}<small>pt</small></b></li>`;
  }).join('')}</ol></section>`;
}
function resultDyn() {
  const r = curRound();
  if (blameNeeded(r) && !r.blameResult) return `<div class="waiting">戦犯投票の結果を待っています<span class="dots"></span></div>`;
  if (isHost()) {
    const n = onlinePlayers().length, need = minPlayers();
    return `<div class="host-bar">
      <button class="btn primary big" data-action="next-round" ${n < need ? 'disabled' : ''}>${n < need ? `${need}人以上必要です` : '次のゲームへ'}${settings().mode === 'gm' && n >= need ? `<small>次の出題者：${esc(player(nextGm(curRound().gmId)).name)} さん</small>` : ''}</button>
      <button class="btn ghost wide" data-action="end-game">ここで終了して最終結果を見る</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}
function startReplay() {
  const strokes = strokesOf(curRound()); if (!strokes.length) return;
  const per = Math.max(250, Math.min(700, 9000 / strokes.length));
  const t0 = performance.now();
  S.highlight = null;
  const step = (now) => {
    if (!S.replay || S.replay.t0 !== t0) return;
    const e = (now - t0) / per, i = Math.floor(e);
    if (i >= strokes.length) { S.replay = null; paintMain(); setHTML(document.getElementById('legend'), legendHTML()); return; }
    S.replay.progress = { i, f: e - i };
    paintMain();
    requestAnimationFrame(step);
  };
  S.replay = { t0, progress: { i: 0, f: 0 } };
  setHTML(document.getElementById('legend'), legendHTML());
  requestAnimationFrame(step);
}

// ---------- 最終結果 ----------
function finalView() {
  const tot = totals();
  const ps = playerList().map((p) => ({ ...p, pts: tot[p.id] || 0 })).sort((a, b) => b.pts - a.pts);
  const rankOf = (p) => 1 + ps.filter((q) => q.pts > p.pts).length;
  const podium = [ps[1], ps[0], ps[2]].filter(Boolean);
  const rounds = finishedRounds();
  const stat = {};
  const add = (id, k) => { (stat[id] ||= { det: 0, wolfWin: 0, wolf: 0, blamed: 0 })[k]++; };
  for (const r of rounds) {
    add(r.wolfId, 'wolf'); if (r.outcome.wolfWin) add(r.wolfId, 'wolfWin');
    if (r.blameResult?.target) add(r.blameResult.target, 'blamed');
    for (const [v, t] of Object.entries(r.votes || {})) if (t === r.wolfId && v !== r.wolfId) add(v, 'det');
  }
  const awards = [];
  const best = (k, icon, label, desc) => {
    const max = Math.max(0, ...Object.values(stat).map((s) => s[k]));
    if (max <= 0) return;
    awards.push({ icon, label, desc: desc(max), who: Object.keys(stat).filter((id) => stat[id][k] === max).map(player) });
  };
  best('det', '🔍', '名探偵', (v) => `人狼を指名 ${v}回`);
  best('wolfWin', '🎭', '名優', (v) => `人狼で勝利 ${v}回`);
  best('blamed', '😇', '戦犯', (v) => `戦犯に選ばれた ${v}回`);
  const cWins = rounds.filter((r) => !r.outcome.wolfWin).length;

  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>最終結果</h2>
      <p class="muted small">${rounds.length}ゲーム　市民 ${cWins}勝 / 人狼 ${rounds.length - cWins}勝</p>
    </section>
    <div class="podium">${podium.map((p) => {
      const rank = rankOf(p);
      return `<div class="pod r${rank}" style="--pc:${p.color}">${avatar(p, rank === 1 ? 'xl' : 'lg')}<div class="pod-name">${esc(p.name)}</div><div class="pod-pts">${p.pts}<small>pt</small></div><div class="pod-step"><span>${rank}</span></div></div>`;
    }).join('')}</div>
    ${standingsHTML()}
    ${awards.length ? `<h3 class="sec-title">称号</h3><div class="awards">${awards.map((a) => `
      <div class="award"><div class="aw-icon">${a.icon}</div><div class="aw-body"><b>${a.label}</b><span>${a.who.map((w) => esc(w.name)).join('、')}</span><small class="muted">${a.desc}</small></div></div>`).join('')}</div>` : ''}
    ${rounds.length ? `<h3 class="sec-title">みんなの作品</h3><div class="gallery">${rounds.map((r) => `
      <figure class="gal">
        <canvas class="paper hist-cv" data-round="${r.n}"></canvas>
        <figcaption><b>${esc(r.word)}</b><span>${r.outcome.wolfWin ? '🐺 人狼勝ち' : '🎉 市民勝ち'}・人狼 ${esc(player(r.wolfId).name)}</span></figcaption>
      </figure>`).join('')}</div>` : ''}
    <div id="dyn"></div>`;
}
function paintHistory() {
  document.querySelectorAll('.hist-cv').forEach((cv) => {
    const r = S.room?.rounds?.[rk(cv.dataset.round)];
    if (r) paint(cv, strokesOf(r));
  });
}
function finalDyn() {
  return isHost()
    ? `<div class="host-bar"><button class="btn primary big" data-action="play-again">🔁 同じメンバーでもう一度</button><button class="btn ghost wide" data-action="leave">部屋を出る</button>${changeGameBtn()}</div>`
    : `<div class="waiting">ホストがもう一度遊ぶか決めています<span class="dots"></span></div><div class="host-bar"><button class="btn ghost wide" data-action="leave">部屋を出る</button></div>`;
}
async function endGame() {
  if (!confirm('ゲームを終了して最終結果を表示しますか？')) return;
  await S.store.update(roomPath(), { 'state/phase': 'final' });
}
async function playAgain() {
  S.confettiDone = {};
  await S.store.update(roomPath(), { state: { phase: 'lobby', round: 0 }, rounds: null });
}

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = pageUrl('ekaki.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: '絵描き人狼', text: `絵描き人狼で遊ぼう！部屋コード：${S.code}`, url: pageUrl('ekaki.html', S.code) }); } catch {}
}

const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  'set-mode': (el) => S.store.set(`${roomPath()}/meta/mode`, el.dataset.mode),
  'set-laps': (el) => S.store.set(`${roomPath()}/meta/laps`, +el.dataset.laps),
  start: startGame,
  gacha, 'submit-topic': submitTopic, 'skip-gm': skipGm,
  flip: () => {
    const n = stateOf().round;
    if (myRole() === 'gm') return;
    S.flipped[n] = !S.flipped[n];
    document.querySelector('.role-card')?.classList.toggle('flipped', S.flipped[n]);
    updateDynamic();
  },
  ready: () => S.store.set(`${roundPath()}/ready/${S.pid}`, true),
  'force-draw': () => S.store.set(`${roomPath()}/state/phase`, 'draw'),
  peek: () => {
    S.peek = !S.peek; clearTimeout(S.peekTimer);
    if (S.peek) S.peekTimer = setTimeout(() => { S.peek = false; updateDynamic(); }, 4000);
    updateDynamic();
  },
  commit: commitStroke, redo, 'skip-turn': skipTurn,
  highlight: (el) => { S.replay = null; S.highlight = S.highlight === el.dataset.id ? null : el.dataset.id; updateDynamic(); },
  vote: (el) => vote(el.dataset.id), 'force-vote': forceVote,
  blame: (el) => voteBlame(el.dataset.id),
  'force-blame': () => { if (confirm('未投票の人を待たずに締め切りますか？')) return finalizeBlame(); },
  'submit-guess': submitGuess, judge: (el) => judge(el.dataset.ok === '1'), forfeit,
  replay: startReplay,
  'next-round': nextRound, 'end-game': endGame, 'play-again': playAgain,
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
  } else if (t.id === 'category') { e.preventDefault(); document.getElementById('word')?.focus(); }
  else if (t.id === 'word') { e.preventDefault(); document.querySelector('[data-action="submit-topic"]')?.click(); }
  else if (t.id === 'guess') { e.preventDefault(); document.querySelector('[data-action="submit-guess"]')?.click(); }
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (e.target.id === 'word') S.gachaAlts = null;
});

boot();
