// =============================================================
//  ティアよみ — 出題者のティア表をみんなで予想するゲーム
// =============================================================
import { createStore, isLocalMode } from './store.js';
import { PRESETS } from './presets.js';

// ---------- 定数 ----------
const TIERS = [
  { label: 'S', color: '#ff5a6e' },
  { label: 'A', color: '#ff9f45' },
  { label: 'B', color: '#ffd84d' },
  { label: 'C', color: '#6fdc8c' },
  { label: 'D', color: '#5aa9ff' },
];
const ITEM_COUNT = TIERS.length;
const PTS_EXACT = 3, PTS_NEAR = 1, PTS_PERFECT = 5;
const MAX_PTS = ITEM_COUNT * PTS_EXACT + PTS_PERFECT;
const PLAYER_COLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLACEHOLDERS = ['ポテチ', 'ポッキー', 'じゃがりこ', 'きのこの山', 'たけのこの里'];

const $app = document.getElementById('app');

// ---------- クライアント状態 ----------
const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null,
  viewKey: '', placement: null, placementKey: '', selected: null,
  dragging: false, pendingRender: false,
  phaseSeen: '', animateRound: null, revealDone: {}, confettiDone: {},
  revealTimer: null, revealing: false,
};

// ---------- ユーティリティ ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstChar = (s) => [...(s || '?')][0];
const rk = (n) => 'r' + n;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
function genCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
function getPid() {
  let p = sessionStorage.getItem('tieryomi.pid');
  if (!p) { p = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); sessionStorage.setItem('tieryomi.pid', p); }
  return p;
}
function roomUrl(code) {
  const u = new URL(location.href); u.search = ''; u.hash = '';
  if (isLocalMode && new URLSearchParams(location.search).has('local')) u.searchParams.set('local', '1');
  u.searchParams.set('room', code); return u.toString();
}
function setUrlRoom(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('room', code); else u.searchParams.delete('room');
  history.replaceState(null, '', u);
}

// ---------- ルーム状態の参照 ----------
const roomPath = () => `rooms/${S.code}`;
const roundPath = (n) => `rooms/${S.code}/rounds/${rk(n)}`;
function playerList() {
  return Object.entries(S.room?.players || {})
    .filter(([, p]) => p && p.name)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
const onlinePlayers = () => playerList().filter((p) => p.online);
const hostId = () => (onlinePlayers()[0] || playerList()[0] || {}).id;
const isHost = () => hostId() === S.pid;
function player(id) { const p = S.room?.players?.[id]; return p ? { id, ...p } : { id, name: '???', color: '#777', online: false }; }
const stateOf = () => S.room?.state || { phase: 'lobby', round: 0 };
const curRound = () => S.room?.rounds?.[rk(stateOf().round)] || null;
function myRole() {
  const r = curRound(); if (!r) return 'none';
  if (r.setterId === S.pid) return 'setter';
  if (stateOf().phase === 'setting') return 'guesser';
  return r.participants?.[S.pid] ? 'guesser' : 'spectator';
}
function allSubmitted(r) {
  const parts = Object.keys(r?.participants || {});
  return parts.length > 0 && parts.every((id) => r.subs?.[id]);
}

// ---------- 得点計算 ----------
function scoreGuess(ans, g) {
  let pts = 0, exact = 0, near = 0;
  const marks = ans.map((t, i) => {
    const d = Math.abs(t - g[i]);
    if (d === 0) { exact++; pts += PTS_EXACT; return 'exact'; }
    if (d === 1) { near++; pts += PTS_NEAR; return 'near'; }
    return 'miss';
  });
  const perfect = exact === ITEM_COUNT;
  if (perfect) pts += PTS_PERFECT;
  return { pts, exact, near, marks, perfect };
}
function roundResults(r) {
  const ans = r?.subs?.[r.setterId]; if (!ans) return [];
  return Object.entries(r.subs)
    .filter(([id]) => id !== r.setterId)
    .map(([id, g]) => ({ id, ...scoreGuess(ans, g) }))
    .sort((a, b) => b.pts - a.pts);
}
function revealedRounds() {
  return Object.entries(S.room?.rounds || {})
    .filter(([, r]) => r && r.revealed && r.subs?.[r.setterId])
    .map(([k, r]) => ({ n: +k.slice(1), ...r }))
    .sort((a, b) => a.n - b.n);
}
function totals() {
  const t = {};
  const blank = () => ({ pts: 0, exact: 0, near: 0, perfect: 0, guesses: 0 });
  for (const p of playerList()) t[p.id] = blank();
  for (const r of revealedRounds()) {
    for (const res of roundResults(r)) {
      const x = t[res.id] || (t[res.id] = blank());
      x.pts += res.pts; x.exact += res.exact; x.near += res.near; x.perfect += res.perfect ? 1 : 0; x.guesses++;
    }
  }
  return t;
}
function setCounts() {
  const c = {};
  for (const r of revealedRounds()) c[r.setterId] = (c[r.setterId] || 0) + 1;
  return c;
}
// 次の出題者：参加順でローテーション。周回数の上限に達した人は飛ばす
function pickNextSetter(afterId) {
  const laps = S.room?.meta?.laps ?? 1;
  const all = playerList();
  const start = all.findIndex((p) => p.id === afterId);
  const rotated = start < 0 ? all : [...all.slice(start + 1), ...all.slice(0, start + 1)];
  const counts = setCounts();
  const c = rotated.find((p) => p.online && (!laps || (counts[p.id] || 0) < laps));
  return c ? c.id : null;
}

// =============================================================
//  起動
// =============================================================
async function boot() {
  S.pid = getPid();
  S.name = localStorage.getItem('tieryomi.name') || '';
  try {
    S.store = await createStore();
  } catch (e) {
    console.error(e);
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
  if (code && sessionStorage.getItem('tieryomi.room') === code && S.name) {
    const meta = await S.store.get(`rooms/${code}/meta`);
    if (meta) return enterRoom(code);
  }
  renderHome(code);
}

// =============================================================
//  ホーム
// =============================================================
function localBanner() {
  return isLocalMode ? `<div class="local-banner">🧪 ローカルテストモード — 同じブラウザで別タブを開いて参加すると、1人で動作確認できます</div>` : '';
}
function rulesHTML(open = false) {
  return `<details class="card rules" ${open ? 'open' : ''}>
    <summary>あそびかた</summary>
    <ol>
      <li><b>出題者</b>がお題と5つの要素を決める<br><span class="muted">例：お菓子 → ポテチ / ポッキー / じゃがりこ…</span></li>
      <li>出題者は<b>本当のティア表</b>を、他の人は<b>出題者のティア表の予想</b>を同時に作る（S〜Dに1つずつ）</li>
      <li>全員そろったら正解発表！</li>
      <li>出題者を交代して次のお題へ</li>
    </ol>
    <div class="score-legend">
      <span><em class="m exact">◎</em>段がぴったり <b>+${PTS_EXACT}</b></span>
      <span><em class="m near">○</em>1段ズレ <b>+${PTS_NEAR}</b></span>
      <span><em class="m perfect">★</em>5つ全部ぴったり <b>+${PTS_PERFECT}</b></span>
    </div>
    <p class="muted small">1問あたり最大${MAX_PTS}pt。出題者はその回の得点なし（全員が同じ回数出題するので公平です）。</p>
  </details>`;
}
function logoHTML() {
  return `<div class="logo">
    <div class="logo-tiers">${TIERS.map((t, i) => `<span style="--c:${t.color};--i:${i}">${t.label}</span>`).join('')}</div>
    <h1>ティアよみ</h1>
    <p>あの人のティア表、読み切れる？</p>
  </div>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
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
  S.name = v.slice(0, 10); localStorage.setItem('tieryomi.name', S.name);
  return S.name;
}

async function createRoom() {
  if (!readName()) return;
  let code = genCode();
  for (let i = 0; i < 8; i++) { if (!(await S.store.get(`rooms/${code}/meta`))) break; code = genCode(); }
  await S.store.set(`rooms/${code}`, { meta: { createdAt: Date.now(), laps: 1 }, state: { phase: 'lobby', round: 0 } });
  await enterRoom(code);
}
async function joinRoom(raw) {
  if (!readName()) return;
  const code = (raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { toast('4文字の部屋コードを入力してね'); document.getElementById('code')?.focus(); return; }
  const meta = await S.store.get(`rooms/${code}/meta`);
  if (!meta) { toast('部屋が見つかりません'); return; }
  await enterRoom(code);
}
async function enterRoom(code) {
  S.code = code; S.viewKey = ''; S.phaseSeen = '';
  sessionStorage.setItem('tieryomi.room', code);
  setUrlRoom(code);
  const players = (await S.store.get(`rooms/${code}/players`)) || {};
  const me = players[S.pid];
  if (!me || !me.name) {
    const used = Object.values(players).map((p) => p.color);
    const color = PLAYER_COLORS.find((c) => !used.includes(c)) || PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length];
    await S.store.set(`rooms/${code}/players/${S.pid}`, { name: S.name, joinedAt: Date.now(), online: true, color });
  } else {
    await S.store.update(`rooms/${code}/players/${S.pid}`, { name: S.name, online: true });
  }
  S.stopPresence = S.store.presence(`rooms/${code}/players/${S.pid}/online`);
  S.unsub = S.store.on(`rooms/${code}`, onRoom);
}
async function leaveRoom() {
  if (!confirm('部屋から退出しますか？')) return;
  const phase = stateOf().phase;
  const code = S.code;
  S.unsub?.(); S.unsub = null;
  S.stopPresence?.(); S.stopPresence = null;
  if (phase === 'lobby') await S.store.remove(`rooms/${code}/players/${S.pid}`);
  else await S.store.set(`rooms/${code}/players/${S.pid}/online`, false);
  sessionStorage.removeItem('tieryomi.room');
  S.code = null; S.room = null; setUrlRoom(null);
  renderHome();
}

// =============================================================
//  ルーム更新
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    S.unsub?.(); S.stopPresence?.();
    sessionStorage.removeItem('tieryomi.room'); setUrlRoom(null);
    S.code = null; S.room = null;
    toast('部屋が見つかりません'); renderHome(); return;
  }
  S.room = room;
  const st = stateOf();
  if (S.phaseSeen === `ranking:${st.round}` && st.phase === 'reveal') S.animateRound = st.round;
  S.phaseSeen = `${st.phase}:${st.round}`;
  hostDuties();
  render();
}

// ホスト（参加順で最初のオンラインの人）が進行を管理する
function hostDuties() {
  if (!isHost()) return;
  const st = stateOf(), r = curRound();
  if (st.phase === 'ranking' && r && allSubmitted(r)) doReveal();
}
async function doReveal() {
  if (S.revealing) return; S.revealing = true;
  try {
    const n = stateOf().round;
    await S.store.update(roomPath(), { 'state/phase': 'reveal', [`rounds/${rk(n)}/revealed`]: true });
  } finally { S.revealing = false; }
}

// =============================================================
//  描画
// =============================================================
function render() {
  if (!S.room) return;
  if (S.dragging) { S.pendingRender = true; return; }
  const st = stateOf(), r = curRound();
  const key = [st.phase, st.round, myRole(), r?.setterId || '', r?.topic ? 1 : 0, r?.subs?.[S.pid] ? 1 : 0].join('|');
  if (key === S.viewKey) { updateDynamic(); return; }
  S.viewKey = key;
  clearInterval(S.revealTimer);

  const views = { lobby: lobbyView, setting: settingView, ranking: rankingView, reveal: revealView, final: finalView };
  $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
  window.scrollTo({ top: 0 });
  if (st.phase === 'ranking') renderBoard();
  if (st.phase === 'reveal') mountReveal();
  if (st.phase === 'final' && !S.confettiDone.final) { S.confettiDone.final = true; setTimeout(() => confetti(140), 300); }
}
function updateDynamic() {
  const pb = document.getElementById('pbar'); if (pb) pb.innerHTML = pbarHTML();
  const pc = document.getElementById('phase-chip'); if (pc) pc.innerHTML = phaseChipHTML();
  const d = document.getElementById('dyn'); if (d) d.innerHTML = dynHTML();
}
function dynHTML() {
  switch (stateOf().phase) {
    case 'lobby': return lobbyDyn();
    case 'setting': return settingDyn();
    case 'ranking': return rankingDyn();
    case 'reveal': return revealDyn();
    case 'final': return finalDyn();
  }
  return '';
}

function avatar(p, size = '') {
  return `<span class="avatar ${size} ${p.online === false ? 'off' : ''}" style="--pc:${p.color || '#888'}">${esc(firstChar(p.name))}</span>`;
}
function phaseChipHTML() {
  const st = stateOf();
  const label = { lobby: 'メンバー待ち', setting: 'お題決め', ranking: 'ティア作成中', reveal: '正解発表', final: '最終結果' }[st.phase] || '';
  return `${st.round && st.phase !== 'final' && st.phase !== 'lobby' ? `<b>第${st.round}問</b>` : ''}<span>${label}</span>`;
}
function headerHTML() {
  return `<header class="topbar">
    <button class="room-chip" data-action="copy-link" title="招待リンクをコピー"><small>ROOM</small><b class="mono">${esc(S.code)}</b><i>🔗</i></button>
    <div class="phase-chip" id="phase-chip">${phaseChipHTML()}</div>
    <button class="btn small ghost" data-action="leave">退出</button>
  </header>
  <div id="pbar" class="pbar">${pbarHTML()}</div>`;
}
function pbarHTML() {
  const st = stateOf(), r = curRound(), tot = totals(), h = hostId();
  const showScore = st.phase !== 'lobby';
  return playerList().map((p) => {
    const tags = [];
    if (p.id === h) tags.push('<span class="tag host">ホスト</span>');
    if (r && r.setterId === p.id && ['setting', 'ranking', 'reveal'].includes(st.phase)) tags.push('<span class="tag setter">出題者</span>');
    return `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar(p)}
      <div class="pmeta"><div class="pname">${esc(p.name)}</div>
      <div class="ptags">${tags.join('')}${showScore ? `<span class="pscore">${tot[p.id]?.pts || 0}pt</span>` : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</div></div>
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
    <div id="dyn">${dynHTML()}</div>
    ${rulesHTML(true)}`;
}
function lobbyDyn() {
  const ps = playerList(), host = isHost(), laps = S.room.meta?.laps ?? 1, n = onlinePlayers().length, h = hostId();
  return `<section class="card">
      <h3>参加メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card">
      <h3>何周あそぶ？</h3>
      <div class="seg">${[1, 2, 3, 0].map((l) => `<button class="seg-btn ${laps === l ? 'on' : ''}" data-action="set-laps" data-laps="${l}" ${host ? '' : 'disabled'}>${l ? l + '周' : 'エンドレス'}</button>`).join('')}</div>
      <p class="muted small">${laps ? `全員が${laps}回ずつ出題したら終了` : 'ホストが好きなタイミングで終了できます'}${host ? '' : '（ホストが設定します）'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'あと1人集まったら開始できます' : 'ゲームスタート！'}</button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}`;
}
async function startGame() {
  if (onlinePlayers().length < 2) return toast('2人以上集まったら始められます');
  const setter = pickNextSetter(null);
  await S.store.update(roomPath(), { state: { phase: 'setting', round: 1, setterId: setter }, rounds: { r1: { setterId: setter } } });
}

// ---------- お題決め ----------
function settingView() {
  const r = curRound(), setter = player(r.setterId);
  if (r.setterId === S.pid) {
    return `<section class="card topic-form">
      <div class="badge">あなたが出題者です</div>
      <h2>お題と5つの要素を決めよう</h2>
      <button class="btn gacha wide" data-action="gacha">🎲 お題ガチャ <small>（ランダムに埋める）</small></button>
      <label class="field"><span>お題</span><input id="topic" maxlength="30" placeholder="例：コンビニのお菓子" enterkeyhint="next"></label>
      <div class="items">${PLACEHOLDERS.map((ph, i) => `
        <label class="field item"><span class="num">${i + 1}</span><input class="item-input" data-i="${i}" maxlength="16" placeholder="${ph}" enterkeyhint="${i < ITEM_COUNT - 1 ? 'next' : 'done'}"></label>`).join('')}
      </div>
      <p class="muted small">出題すると、あなたは<b>本当のティア表</b>を、みんなは<b>その予想</b>を同時に作ります。</p>
      <button class="btn primary big" data-action="submit-topic">この内容で出題する</button>
    </section><div id="dyn"></div>`;
  }
  return `<section class="card center thinking">
      ${avatar(setter, 'xl')}
      <h2><b style="color:${setter.color}">${esc(setter.name)}</b> さんが<br>お題を考えています</h2>
      <div class="loader">${TIERS.map((t, i) => `<span style="--c:${t.color};--i:${i}">${t.label}</span>`).join('')}</div>
      <p class="muted small">${esc(setter.name)} さんならどう並べるか、今のうちに想像しておこう</p>
    </section>
    <div id="dyn">${dynHTML()}</div>`;
}
function settingDyn() {
  const r = curRound();
  if (r && isHost() && r.setterId !== S.pid && !player(r.setterId).online) {
    return `<section class="card warn"><p>${esc(player(r.setterId).name)} さんの接続が切れています</p>
      <button class="btn" data-action="skip-setter">次の人に出題を回す</button></section>`;
  }
  return '';
}
function gacha() {
  const cur = document.getElementById('topic')?.value;
  const pool = PRESETS.filter((p) => p.topic !== cur);
  const p = pool[Math.floor(Math.random() * pool.length)];
  const topic = document.getElementById('topic');
  topic.value = p.topic;
  const items = [...p.items].sort(() => Math.random() - 0.5);
  document.querySelectorAll('.item-input').forEach((el, i) => { el.value = items[i]; });
  const form = document.querySelector('.topic-form');
  form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
}
async function submitTopic() {
  const st = stateOf(), r = curRound();
  if (st.phase !== 'setting' || r?.setterId !== S.pid) return;
  const topic = document.getElementById('topic').value.trim();
  const items = [...document.querySelectorAll('.item-input')].map((i) => i.value.trim());
  if (!topic) { toast('お題を入力してね'); document.getElementById('topic').focus(); return; }
  const empty = items.findIndex((x) => !x);
  if (empty >= 0) { toast('要素を5つ全部入力してね'); document.querySelectorAll('.item-input')[empty].focus(); return; }
  if (new Set(items).size !== items.length) { toast('同じ要素が重複しています'); return; }
  const participants = {};
  for (const p of onlinePlayers()) participants[p.id] = true;
  participants[S.pid] = true;
  await S.store.update(roomPath(), {
    [`rounds/${rk(st.round)}/topic`]: topic,
    [`rounds/${rk(st.round)}/items`]: items,
    [`rounds/${rk(st.round)}/participants`]: participants,
    'state/phase': 'ranking',
  });
}
async function skipSetter() {
  const st = stateOf(), r = curRound();
  const next = pickNextSetter(r.setterId);
  if (!next || next === r.setterId) return toast('出題できる人がいません');
  await S.store.update(roomPath(), { state: { phase: 'setting', round: st.round, setterId: next }, [`rounds/${rk(st.round)}`]: { setterId: next } });
}

// ---------- ティア作成（出題者＆予想者） ----------
function rankingView() {
  const r = curRound(), setter = player(r.setterId), role = myRole();
  initPlacement();
  const hint = role === 'setter'
    ? 'あなたの<b>本当の</b>ティア表を作ってください。<br>みんながこれを予想します。'
    : role === 'guesser'
      ? `<b style="color:${setter.color}">${esc(setter.name)}</b> さんならどう並べる？<br>予想してティア表を作ろう。`
      : '途中参加のため今回は観戦です。次のお題から参加できます。';
  return `<section class="topic-card ${role}">
      <div class="topic-by">${avatar(setter, 'sm')}<span>${esc(setter.name)} さんのお題</span></div>
      <h2 class="topic">${esc(r.topic)}</h2>
      <p class="role-hint">${hint}</p>
    </section>
    ${role !== 'spectator' ? '<div id="board" class="board"></div>' : ''}
    <div id="dyn">${dynHTML()}</div>`;
}
function draftKey() { return `${S.code}:${stateOf().round}:${curRound()?.topic}`; }
function initPlacement() {
  const key = draftKey();
  if (S.placementKey === key && S.placement) return;
  S.placementKey = key; S.selected = null;
  const sub = curRound()?.subs?.[S.pid];
  let draft = null;
  try { const d = JSON.parse(sessionStorage.getItem('tieryomi.draft')); if (d?.key === key) draft = d.p; } catch {}
  S.placement = sub ? [...sub] : draft || Array(ITEM_COUNT).fill(-1);
}
function saveDraft() { try { sessionStorage.setItem('tieryomi.draft', JSON.stringify({ key: S.placementKey, p: S.placement })); } catch {} }

function renderBoard() {
  const el = document.getElementById('board'); if (!el) return;
  const r = curRound(), items = r.items || [], p = S.placement, locked = !!r.subs?.[S.pid];
  const chip = (i) => `<button type="button" class="chip ${S.selected === i ? 'sel' : ''}" data-item="${i}" ${locked ? 'tabindex="-1"' : ''}>${esc(items[i])}</button>`;
  const pool = items.map((_, i) => i).filter((i) => p[i] < 0);
  el.classList.toggle('locked', locked);
  el.classList.toggle('has-sel', S.selected != null);
  el.innerHTML = `${locked ? '' : `
    <div class="pool ${pool.length ? '' : 'empty'}" data-drop="pool">
      ${pool.length ? pool.map(chip).join('') : '<span class="pool-done">✨ 全部置けた！ 下のボタンで提出しよう</span>'}
    </div>
    <p class="board-hint">${S.selected != null ? `「${esc(items[S.selected])}」を置きたい段を<b>タップ</b>` : 'ドラッグで移動 / タップで選んで段をタップ'}</p>`}
    <div class="tiers">${TIERS.map((t, ti) => {
      const i = p.indexOf(ti);
      return `<div class="tier" data-drop="${ti}" style="--c:${t.color}">
        <div class="tier-label">${t.label}</div>
        <div class="tier-slot">${i >= 0 ? chip(i) : '<span class="slot-hint">ここに置く</span>'}</div>
      </div>`;
    }).join('')}</div>`;
}
function place(i, dest) {
  const p = S.placement, from = p[i];
  if (dest === 'pool') p[i] = -1;
  else {
    const t = +dest;
    const occ = p.findIndex((x, j) => x === t && j !== i);
    if (occ >= 0) p[occ] = from;  // 入れ替え（元がプールならプールへ）
    p[i] = t;
  }
  S.selected = null;
  saveDraft(); renderBoard(); updateDynamic();
  if (navigator.vibrate) try { navigator.vibrate(8); } catch {}
}
function tapChip(item) {
  const p = S.placement, sel = S.selected;
  if (sel === null || sel === item) { S.selected = sel === item ? null : item; renderBoard(); return; }
  if (p[item] >= 0) { place(sel, p[item]); return; }
  S.selected = item; renderBoard();
}
function onBoardPointerDown(e) {
  const board = document.getElementById('board');
  if (!board || board.classList.contains('locked')) return;
  const chip = e.target.closest('#board .chip[data-item]');
  if (!chip || (e.button != null && e.button > 0)) return;
  const item = +chip.dataset.item, sx = e.clientX, sy = e.clientY;
  const rect = chip.getBoundingClientRect(), ox = sx - rect.left, oy = sy - rect.top;
  let ghost = null, over = null;
  try { chip.setPointerCapture(e.pointerId); } catch {}

  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      ghost = chip.cloneNode(true); ghost.classList.add('ghost'); ghost.classList.remove('sel');
      ghost.style.width = rect.width + 'px';
      document.body.appendChild(ghost);
      chip.classList.add('src'); board.classList.add('dragging');
      S.dragging = true; S.selected = null;
    }
    lx = ev.clientX; ly = ev.clientY;
    ghost.style.transform = `translate(${lx - ox}px, ${ly - oy}px) rotate(-3deg) scale(1.06)`;
    hit();
    if (!raf) raf = requestAnimationFrame(autoScroll);
  };
  // 指が画面の上下端に来たら自動スクロール
  let lx = sx, ly = sy, raf = 0;
  const hit = () => {
    const t = document.elementFromPoint(lx, ly)?.closest('#board [data-drop]') || null;
    if (t !== over) { over?.classList.remove('over'); over = t; over?.classList.add('over'); }
  };
  const autoScroll = () => {
    raf = 0; if (!ghost) return;
    const edge = 80, h = innerHeight;
    const v = ly < edge ? -(edge - ly) / 4 : ly > h - edge ? (ly - (h - edge)) / 4 : 0;
    if (v) { window.scrollBy(0, v); hit(); raf = requestAnimationFrame(autoScroll); }
  };
  const end = (ev) => {
    chip.removeEventListener('pointermove', move);
    chip.removeEventListener('pointerup', end);
    chip.removeEventListener('pointercancel', end);
    cancelAnimationFrame(raf); raf = 0;
    if (ghost) {
      ghost.remove(); over?.classList.remove('over'); board.classList.remove('dragging');
      S.dragging = false;
      if (ev.type === 'pointerup' && over) place(item, over.dataset.drop); else renderBoard();
      if (S.pendingRender) { S.pendingRender = false; render(); }
    } else if (ev.type === 'pointerup') {
      tapChip(item);
    }
  };
  chip.addEventListener('pointermove', move);
  chip.addEventListener('pointerup', end);
  chip.addEventListener('pointercancel', end);
}
function boardClick(e) {
  const board = document.getElementById('board');
  if (!board || board.classList.contains('locked') || !board.contains(e.target)) return;
  const chip = e.target.closest('.chip[data-item]');
  if (chip) { if (e.detail === 0) tapChip(+chip.dataset.item); return; } // キーボード操作
  const drop = e.target.closest('[data-drop]');
  if (drop && S.selected != null) place(S.selected, drop.dataset.drop);
}

function rankingDyn() {
  const r = curRound(), role = myRole(), submitted = !!r.subs?.[S.pid];
  const parts = Object.keys(r.participants || {});
  const left = S.placement ? S.placement.filter((t) => t < 0).length : ITEM_COUNT;
  let html = '';
  if (role !== 'spectator') {
    html += submitted
      ? `<div class="submitted card"><div class="big-check">✓</div><div class="grow">提出しました！<br><span class="muted small">みんなの提出を待っています<span class="dots"></span></span></div><button class="btn small" data-action="unsubmit">修正する</button></div>`
      : `<div class="row actions"><button class="btn" data-action="reset-board">リセット</button>
         <button class="btn primary grow" data-action="submit-tier" ${left ? 'disabled' : ''}>${left ? `あと${left}つ置いてね` : (role === 'setter' ? 'これが正解！提出する' : 'この予想で提出する')}</button></div>`;
  }
  if (isHost()) {
    const setterDone = !!r.subs?.[r.setterId];
    const missing = parts.filter((id) => !r.subs?.[id]);
    const missingOff = missing.filter((id) => !player(id).online);
    if (!setterDone && !player(r.setterId).online) {
      html += `<section class="card warn"><p>出題者の ${esc(player(r.setterId).name)} さんの接続が切れています</p>
        <button class="btn" data-action="skip-round">このお題を飛ばして次の人へ</button></section>`;
    } else if (setterDone && missing.length) {
      html += missingOff.length
        ? `<section class="card warn"><p>${missingOff.map((id) => esc(player(id).name)).join('、')} さんの接続が切れています</p><button class="btn" data-action="force-reveal">待たずに正解発表</button></section>`
        : (parts.length - missing.length >= 2 ? `<div class="center"><button class="btn small ghost" data-action="force-reveal">未提出の人を待たずに発表する</button></div>` : '');
    }
  }
  const done = parts.filter((id) => r.subs?.[id]).length;
  html += `<section class="card status">
      <h3>提出状況 <small>${done} / ${parts.length}</small></h3>
      <div class="progress"><i style="width:${parts.length ? (done / parts.length) * 100 : 0}%"></i></div>
      <ul class="slist">${parts.map((id) => {
        const p = player(id), s = r.subs?.[id];
        return `<li class="${s ? 'done' : ''} ${p.online ? '' : 'off'}">${avatar(p, 'sm')}<span class="nm">${esc(p.name)}</span>${id === r.setterId ? '<span class="tag setter">出題者</span>' : ''}<em>${s ? '✓ 提出済み' : p.online ? '考え中…' : '切断中'}</em></li>`;
      }).join('')}</ul>
    </section>`;
  return html;
}
async function submitTier() {
  if (stateOf().phase !== 'ranking') return;
  if (!S.placement || S.placement.some((t) => t < 0)) return toast('5つ全部置いてね');
  await S.store.set(`${roundPath(stateOf().round)}/subs/${S.pid}`, S.placement.slice());
}
async function unsubmit() {
  if (stateOf().phase !== 'ranking') return;
  await S.store.remove(`${roundPath(stateOf().round)}/subs/${S.pid}`);
}
async function forceReveal() {
  const r = curRound();
  if (!r?.subs?.[r.setterId]) return toast('出題者がまだ提出していません');
  if (!confirm('未提出の人を待たずに正解発表しますか？')) return;
  await doReveal();
}
async function skipRound() {
  if (!confirm('このお題を飛ばして、次の人に出題を回しますか？')) return;
  await skipSetter();
}

// ---------- 正解発表 ----------
function revealView() {
  const n = stateOf().round, r = curRound(), setter = player(r.setterId), ans = r.subs[r.setterId];
  const animate = S.animateRound === n && !S.revealDone[n];
  const mine = r.setterId !== S.pid ? r.subs?.[S.pid] : null;
  const myRes = mine ? scoreGuess(ans, mine) : null;
  return `<section class="topic-card">
      <div class="topic-by">${avatar(setter, 'sm')}<span>${esc(setter.name)} さんの正解は…</span></div>
      <h2 class="topic">${esc(r.topic)}</h2>
    </section>
    <div class="board answer ${animate ? 'animating' : ''}" id="answer">
      <div class="tiers">${TIERS.map((t, ti) => {
        const i = ans.indexOf(ti);
        let guess = '';
        if (mine) {
          const gi = mine.indexOf(ti), m = myRes.marks[gi];
          guess = `<span class="my-guess ${m}" title="あなたの予想">あなた：${esc(r.items[gi])} <em>${m === 'exact' ? '◎' : m === 'near' ? '○' : '×'}</em></span>`;
        }
        return `<div class="tier" data-tier="${ti}" style="--c:${t.color}">
          <div class="tier-label">${t.label}</div>
          <div class="tier-slot"><div class="flip ${animate ? '' : 'shown'}">
            <div class="flip-back">?</div>
            <div class="flip-front"><span class="chip static">${esc(r.items[i])}</span>${guess}</div>
          </div></div>
        </div>`;
      }).join('')}</div>
      ${animate ? '<button class="skip-anim" data-action="skip-anim">スキップ ›</button>' : ''}
    </div>
    <div id="results" class="results ${animate ? 'pending' : ''}">${resultsHTML(r)}</div>
    <div id="dyn" class="${animate ? 'pending' : ''}">${dynHTML()}</div>`;
}
function resultsHTML(r) {
  const results = roundResults(r);
  let html = '<h3 class="sec-title">みんなの予想</h3>';
  if (!results.length) html += '<section class="card center"><p class="muted">今回は予想した人がいませんでした</p></section>';
  else {
    const best = results[0].pts;
    html += `<div class="rgrid">${results.map((res, idx) => {
      const p = player(res.id), g = r.subs[res.id], sync = Math.round((res.pts / MAX_PTS) * 100);
      return `<div class="rcard ${res.perfect ? 'perfect' : ''} ${res.id === S.pid ? 'me' : ''}" style="--pc:${p.color};--d:${idx}">
        <div class="rhead">${avatar(p)}<div class="rname">${esc(p.name)}${res.pts === best && best > 0 ? ' <span class="crown">👑</span>' : ''}</div><div class="rpts">+${res.pts}<small>pt</small></div></div>
        <div class="sync"><div class="sync-bar"><i style="width:${sync}%"></i></div><span>シンクロ率 <b>${sync}%</b></span></div>
        <div class="mini">${TIERS.map((t, ti) => {
          const i = g.indexOf(ti), m = res.marks[i];
          return `<div class="mini-row ${m}"><b style="--c:${t.color}">${t.label}</b><span>${esc(r.items[i])}</span><em>${m === 'exact' ? '◎' : m === 'near' ? '○' : '×'}</em></div>`;
        }).join('')}</div>
        ${res.perfect ? `<div class="perfect-badge">★ PERFECT! +${PTS_PERFECT}</div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }
  html += `<p class="legend muted small center">◎ ぴったり +${PTS_EXACT}　○ 1段ズレ +${PTS_NEAR}　★ 全部ぴったり +${PTS_PERFECT}</p>`;
  html += `<h3 class="sec-title">現在の順位</h3>${standingsHTML()}`;
  return html;
}
function standingsHTML() {
  const tot = totals();
  const ps = playerList().sort((a, b) => (tot[b.id]?.pts || 0) - (tot[a.id]?.pts || 0));
  return `<section class="card"><ol class="standings">${ps.map((p) => {
    const pts = tot[p.id]?.pts || 0;
    const rank = 1 + ps.filter((q) => (tot[q.id]?.pts || 0) > pts).length;
    return `<li class="${p.id === S.pid ? 'me' : ''}"><span class="rank r${rank}">${rank}</span>${avatar(p, 'sm')}<span class="nm">${esc(p.name)}</span><b>${pts}<small>pt</small></b></li>`;
  }).join('')}</ol></section>`;
}
function revealDyn() {
  const r = curRound(), next = pickNextSetter(r.setterId), laps = S.room.meta?.laps ?? 1;
  if (isHost()) {
    return `<div class="host-bar">
      ${next
        ? `<button class="btn primary big" data-action="next-round">次のお題へ<small>次の出題者：${esc(player(next).name)} さん</small></button>
           <button class="btn ghost wide" data-action="end-game" data-confirm="1">ここでゲームを終了する</button>`
        : `<button class="btn primary big" data-action="end-game">🏆 最終結果を見る</button>`}
    </div>`;
  }
  return `<div class="waiting">${next ? `次は <b>${esc(player(next).name)}</b> さんの出題！` : (laps ? '全員の出題が終わりました！' : '')}<br>ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}
function mountReveal() {
  const n = stateOf().round;
  const el = document.getElementById('answer');
  if (!el?.classList.contains('animating')) { celebrate(n); return; }
  const rows = [...el.querySelectorAll('.tier')].reverse(); // D → S の順にめくる
  let k = 0;
  S.revealTimer = setInterval(() => {
    if (k < rows.length) {
      rows[k].querySelector('.flip').classList.add('shown');
      rows[k].classList.add('pop');
      k++;
    } else finishReveal();
  }, 800);
}
function finishReveal() {
  clearInterval(S.revealTimer);
  const n = stateOf().round;
  S.revealDone[n] = true;
  document.querySelectorAll('#answer .flip').forEach((f) => f.classList.add('shown'));
  document.getElementById('answer')?.classList.remove('animating');
  document.querySelector('.skip-anim')?.remove();
  document.getElementById('results')?.classList.remove('pending');
  document.getElementById('dyn')?.classList.remove('pending');
  celebrate(n);
}
function celebrate(n) {
  if (S.confettiDone[n]) return;
  S.confettiDone[n] = true;
  const results = roundResults(curRound());
  if (results.some((x) => x.perfect)) confetti(results.find((x) => x.id === S.pid)?.perfect ? 160 : 80);
}
async function nextRound() {
  const st = stateOf(), r = curRound();
  const next = pickNextSetter(r?.setterId);
  if (!next) return endGame();
  const n = st.round + 1;
  await S.store.update(roomPath(), { state: { phase: 'setting', round: n, setterId: next }, [`rounds/${rk(n)}`]: { setterId: next } });
}
async function endGame(el) {
  if (el?.dataset?.confirm && !confirm('ゲームを終了して最終結果を表示しますか？')) return;
  await S.store.update(roomPath(), { 'state/phase': 'final' });
}

// ---------- 最終結果 ----------
function finalView() {
  const tot = totals();
  const ps = playerList().map((p) => ({ ...p, ...(tot[p.id] || { pts: 0, exact: 0, near: 0, perfect: 0, guesses: 0 }) }))
    .sort((a, b) => b.pts - a.pts);
  const rankOf = (p) => 1 + ps.filter((q) => q.pts > p.pts).length;
  const podium = [ps[1], ps[0], ps[2]].filter(Boolean);
  const rounds = revealedRounds();

  // 称号
  const awards = [];
  const best = (key, label, desc, icon) => {
    const max = Math.max(0, ...ps.map((p) => p[key] || 0));
    if (max <= 0) return;
    const who = ps.filter((p) => (p[key] || 0) === max);
    awards.push({ icon, label, desc: desc(max), who });
  };
  best('exact', '一番の理解者', (v) => `ぴったり的中 ${v}回`, '🎯');
  best('near', 'ニアピン王', (v) => `1段ズレ ${v}回`, '📐');
  best('perfect', 'エスパー', (v) => `パーフェクト ${v}回`, '🔮');
  const setterSync = {};
  for (const r of rounds) {
    const res = roundResults(r); if (!res.length) continue;
    const avg = res.reduce((a, b) => a + b.pts, 0) / res.length / MAX_PTS;
    (setterSync[r.setterId] ||= []).push(avg);
  }
  const ss = Object.entries(setterSync).map(([id, a]) => ({ id, v: a.reduce((x, y) => x + y, 0) / a.length }));
  if (ss.length >= 2) {
    const hi = Math.max(...ss.map((x) => x.v)), lo = Math.min(...ss.map((x) => x.v));
    awards.push({ icon: '📖', label: '読まれやすい人', desc: `平均シンクロ率 ${Math.round(hi * 100)}%`, who: ss.filter((x) => x.v === hi).map((x) => player(x.id)) });
    if (lo < hi) awards.push({ icon: '🎭', label: 'ミステリアス', desc: `平均シンクロ率 ${Math.round(lo * 100)}%`, who: ss.filter((x) => x.v === lo).map((x) => player(x.id)) });
  }

  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>最終結果</h2>
      <p class="muted small">${rounds.length}問あそびました</p>
    </section>
    <div class="podium">${podium.map((p) => {
      const rank = rankOf(p);
      return `<div class="pod r${rank}" style="--pc:${p.color}">
        ${avatar(p, rank === 1 ? 'xl' : 'lg')}
        <div class="pod-name">${esc(p.name)}</div>
        <div class="pod-pts">${p.pts}<small>pt</small></div>
        <div class="pod-step"><span>${rank}</span></div>
      </div>`;
    }).join('')}</div>
    ${standingsHTML()}
    ${awards.length ? `<h3 class="sec-title">称号</h3><div class="awards">${awards.map((a) => `
      <div class="award"><div class="aw-icon">${a.icon}</div><div class="aw-body"><b>${a.label}</b><span>${a.who.map((w) => esc(w.name)).join('、')}</span><small class="muted">${a.desc}</small></div></div>`).join('')}</div>` : ''}
    ${rounds.length ? `<h3 class="sec-title">ふりかえり</h3><div class="history">${rounds.map((r) => {
      const s = player(r.setterId), ans = r.subs[r.setterId], res = roundResults(r);
      return `<details class="card hist"><summary><span class="hn">第${r.n}問</span><span class="ht">${esc(r.topic)}</span><span class="hs" style="color:${s.color}">${esc(s.name)}</span></summary>
        <div class="hist-tiers">${TIERS.map((t, ti) => `<div><b style="--c:${t.color}">${t.label}</b><span>${esc(r.items[ans.indexOf(ti)])}</span></div>`).join('')}</div>
        ${res.length ? `<p class="muted small">トップ：${esc(player(res[0].id).name)}（${res[0].pts}pt）</p>` : ''}
      </details>`;
    }).join('')}</div>` : ''}
    <div id="dyn">${dynHTML()}</div>`;
}
function finalDyn() {
  return isHost()
    ? `<div class="host-bar"><button class="btn primary big" data-action="play-again">🔁 同じメンバーでもう一度</button><button class="btn ghost wide" data-action="leave">部屋を出る</button></div>`
    : `<div class="waiting">ホストがもう一度遊ぶか決めています<span class="dots"></span></div><div class="host-bar"><button class="btn ghost wide" data-action="leave">部屋を出る</button></div>`;
}
async function playAgain() {
  S.revealDone = {}; S.confettiDone = {};
  await S.store.update(roomPath(), { state: { phase: 'lobby', round: 0 }, rounds: null });
}

// =============================================================
//  紙吹雪
// =============================================================
function confetti(count = 100) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = [...TIERS.map((t) => t.color), '#ffffff', '#b98bff'];
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
      { transform: `translate(0, -20px) rotate(0deg)`, opacity: 1 },
      { transform: `translate(${dx}px, ${H + 40}px) rotate(${rot}deg)`, opacity: 0.9 },
    ], { duration: 1800 + Math.random() * 1800, delay: Math.random() * 500, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 4500);
}

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = roomUrl(S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'ティアよみ', text: `ティアよみで遊ぼう！部屋コード：${S.code}`, url: roomUrl(S.code) }); } catch {}
}

const actions = {
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink,
  share: shareLink,
  leave: leaveRoom,
  'set-laps': (el) => S.store.set(`${roomPath()}/meta/laps`, +el.dataset.laps),
  start: startGame,
  gacha,
  'submit-topic': submitTopic,
  'skip-setter': skipSetter,
  'reset-board': () => { S.placement = Array(ITEM_COUNT).fill(-1); S.selected = null; saveDraft(); renderBoard(); updateDynamic(); },
  'submit-tier': submitTier,
  unsubmit,
  'force-reveal': forceReveal,
  'skip-round': skipRound,
  'next-round': nextRound,
  'end-game': endGame,
  'play-again': playAgain,
  'skip-anim': finishReveal,
};

$app.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a && !a.disabled) {
    const fn = actions[a.dataset.action]; if (!fn) return;
    const ret = fn(a);
    if (ret instanceof Promise) {
      a.disabled = true; a.classList.add('busy');
      ret.catch((err) => { console.error(err); toast('エラー：' + (err?.message || err)); })
        .finally(() => { if (a.isConnected) { a.disabled = false; a.classList.remove('busy'); } });
    }
    return;
  }
  boardClick(e);
});
$app.addEventListener('pointerdown', onBoardPointerDown);
$app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const t = e.target;
  if (t.id === 'name' || t.id === 'code') {
    e.preventDefault();
    (document.querySelector('[data-action="join"][data-code]') || (t.id === 'code' || document.getElementById('code')?.value ? document.querySelector('[data-action="join"]') : document.querySelector('[data-action="create"]')))?.click();
  } else if (t.id === 'topic' || t.classList.contains('item-input')) {
    e.preventDefault();
    const inputs = [document.getElementById('topic'), ...document.querySelectorAll('.item-input')];
    const i = inputs.indexOf(t);
    if (i < inputs.length - 1) inputs[i + 1].focus(); else document.querySelector('[data-action="submit-topic"]')?.click();
  }
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

boot();
