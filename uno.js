// =============================================================
//  ラストワン — UNO風のカードゲーム
//  ・場のカードと「同じ色」か「同じ数字・記号」のカードを1枚出す
//  ・出せなければ山札から引く。手札をいちばん早くなくした人の勝ち
//  ・残り1枚になったら「ラスト1！」を宣言。言い忘れを指摘されたら2枚引く
//  ・配る枚数・ドロー重ね・引き方・ドロー4の制限・終わり方はロビーで設定
//
//  山札や手札を書きかえるのは「手番の人」だけ（切断中・止まっているときはホストが代行）。
//  言い忘れの指摘は state/caught に印をつけるだけで、カードを配るのは手番の人の画面。
//  → 同時に2人が山札を触って、カードが増えたり消えたりしないようにしている。
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, genCode, getPid, getName, saveName, pageUrl, hubUrl, setUrlRoom,
  localBanner, avatar, shuffle, confetti, gotoRoom,
  ROOM_KEY, joinPlayer, followRoom, switchGame, changeGameBtn,
} from './common.js';

// ---------- 定数 ----------
const GAME = 'uno';
const PCOLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];
const MAX_PLAYERS = 10;
const CC = { r: '#ef4b5f', y: '#f7b928', g: '#34b878', b: '#3b82f6' };
const CN = { r: '赤', y: '黄', g: '緑', b: '青' };
const COLOR_ORDER = 'rygbW';
const VAL_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'S', 'R', 'D', 'W', 'W4'];
const DEFAULTS = { hand: 7, timer: 30, stack: true, draw: 'one', w4: 'free', finish: 'first' };

const $app = document.getElementById('app');
const S = {
  store: null, pid: '', name: '', code: null, room: null,
  unsub: null, stopPresence: null, viewKey: '', tick: null,
  sel: -1, pick: -1, unoPress: false, acting: false, doneKeys: new Set(),
  notified: '', seenCatch: '', seenHit: '', confettiDone: {},
  touch: matchMedia('(hover: none)').matches,
};

// ---------- カード ----------
// 'r5' = 赤の5、'gS' = 緑スキップ、'bR' = 青リバース、'yD' = 黄ドロー2、'W' = ワイルド、'W4' = ワイルドドロー4
const isWild = (c) => c[0] === 'W';
const colOf = (c) => (isWild(c) ? null : c[0]);
const valOf = (c) => (isWild(c) ? c : c.slice(1));
const SYM = { S: '⊘', R: '⇄', D: '+2', W: '', W4: '+4' };
const sym = (c) => SYM[valOf(c)] ?? valOf(c);
function cardName(c) {
  if (c === 'W') return 'ワイルド';
  if (c === 'W4') return 'ワイルドドロー4';
  return CN[c[0]] + ({ S: 'スキップ', R: 'リバース', D: 'ドロー2' }[valOf(c)] || `の${valOf(c)}`);
}
const points = (c) => (isWild(c) ? 50 : /\d/.test(valOf(c)) ? +valOf(c) : 20);
function buildDeck() {
  const d = [];
  for (const c of 'rygb') {
    d.push(c + '0');
    for (const v of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'S', 'R', 'D']) d.push(c + v, c + v);
  }
  for (let i = 0; i < 4; i++) d.push('W', 'W4');
  return d; // 108枚
}
const cmpCard = (a, b) => (COLOR_ORDER.indexOf(a[0]) - COLOR_ORDER.indexOf(b[0])) || (VAL_ORDER.indexOf(valOf(a)) - VAL_ORDER.indexOf(valOf(b)));
// 出せるか（st は top / color / stack を持つ）
function canPlay(card, st, hand, set) {
  const tv = valOf(st.top);
  if (st.stack > 0) return tv === 'D' ? (valOf(card) === 'D' || card === 'W4') : card === 'W4';
  if (card === 'W') return true;
  if (card === 'W4') return set.w4 === 'free' || !hand.some((h) => h !== card && !isWild(h) && colOf(h) === st.color);
  return colOf(card) === st.color || valOf(card) === tv;
}
function cardHTML(c, { tag = 'div', cls = '', attrs = '' } = {}) {
  const w = isWild(c), s = sym(c), corner = c === 'W' ? '★' : s;
  return `<${tag} class="uc ${w ? 'c-w' : 'c-' + c[0]} ${cls}" ${attrs} aria-label="${cardName(c)}">
    <span class="uc-face">${w ? '<i class="uc-wheel"></i>' : ''}<b class="${s.length > 1 ? 'long' : ''}">${s}</b></span>
    <small class="tl">${corner}</small><small class="br">${corner}</small></${tag}>`;
}
const backHTML = (cls = '', attrs = '', tag = 'div') => `<${tag} class="uc back ${cls}" ${attrs}><span class="uc-logo">LAST<b>1</b></span></${tag}>`;

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
const settings = () => { const m = S.room?.meta || {}; const o = {}; for (const k in DEFAULTS) o[k] = m[k] ?? DEFAULTS[k]; return o; };
const handOf = (g, id) => g?.hands?.[id] || [];
const ranksOf = (g) => g?.ranks || [];
const pcolor = (g, id) => { const i = g?.order?.indexOf(id) ?? -1; return i >= 0 ? PCOLORS[i % PCOLORS.length] : '#8a87a8'; };
const nameOf = (id) => (id === S.pid ? 'あなた' : `${player(id).name}さん`);
function winsTotal() {
  const w = {};
  for (const g of Object.values(S.room?.games || {})) {
    const r = g?.done && ranksOf(g)[0];
    if (r) w[r] = (w[r] || 0) + 1;
  }
  return w;
}
// 宣言忘れを指摘できるか（残り1枚になった次の人が動くまで）
function catchable(g, st, id) {
  if (st.phase !== 'play' || !g || ranksOf(g).includes(id)) return false;
  const at = st.unoAt?.[id];
  return handOf(g, id).length === 1 && at != null && (st.moveNo || 0) <= at + 1 && !st.uno?.[id] && !st.caught?.[id];
}

// =============================================================
//  ゲームの手（ctx の上で山札・手札・状態を書きかえ、最後にまとめて保存）
// =============================================================
function makeCtx(g, st) {
  return {
    g, base: `games/${gk(st.game)}`, set: settings(),
    deck: [...(g.deck || [])], pile: [...(g.pile || [])], ranks: [...ranksOf(g)],
    hands: Object.fromEntries(g.order.map((id) => [id, [...handOf(g, id)]])),
    st: { turn: st.turn, dir: st.dir || 1, color: st.color, top: st.top, stack: st.stack || 0, moveNo: st.moveNo || 0, drew: st.drew || null },
    upd: {}, dirty: new Set(), bump: false, last: null, finished: false,
  };
}
function take(ctx, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    if (!ctx.deck.length) { // 山札が尽きたら、捨て札（いちばん上以外）を切り直す
      const top = ctx.pile.pop();
      ctx.deck = shuffle(ctx.pile); ctx.pile = top ? [top] : [];
      if (!ctx.deck.length) break;
      ctx.upd['state/reshuffled'] = Date.now();
    }
    out.push(ctx.deck.pop());
  }
  return out;
}
function give(ctx, id, cards) {
  if (!cards.length) return;
  ctx.hands[id].push(...cards); ctx.dirty.add(id);
  ctx.upd[`state/uno/${id}`] = null; ctx.upd[`state/unoAt/${id}`] = null;
}
const activeIds = (ctx) => ctx.g.order.filter((id) => !ctx.ranks.includes(id));
function nextFrom(ctx, i, steps = 1) {
  const n = ctx.g.order.length;
  if (!activeIds(ctx).length) return i;
  let j = i, k = 0;
  while (k < steps) { j = (j + ctx.st.dir + n) % n; if (!ctx.ranks.includes(ctx.g.order[j])) k++; }
  return j;
}
function endTurn(ctx, i, steps) { ctx.st.turn = nextFrom(ctx, i, steps); ctx.st.drew = null; ctx.bump = true; }

function applyCatches(ctx, caught) {
  for (const [id, c] of Object.entries(caught || {})) {
    ctx.upd[`state/caught/${id}`] = null;
    if (ctx.hands[id]?.length !== 1 || ctx.ranks.includes(id)) continue;
    const got = take(ctx, 2); give(ctx, id, got);
    ctx.upd['state/lastCatch'] = { by: c.by, target: id, n: got.length, at: Date.now() };
  }
}
function drawAction(ctx, id, auto = false) {
  const i = ctx.g.order.indexOf(id);
  if (ctx.st.stack > 0) { // たまったドローを引き受ける
    const got = take(ctx, ctx.st.stack); give(ctx, id, got);
    ctx.st.stack = 0; ctx.last = { t: 'take', by: id, n: got.length, auto };
    endTurn(ctx, i, 1); return;
  }
  const got = [], limit = ctx.set.draw === 'until' && !auto ? 40 : 1; // 自動のときは1枚だけ
  let playable = null;
  for (let k = 0; k < limit; k++) {
    const c = take(ctx, 1)[0]; if (!c) break;
    got.push(c);
    if (canPlay(c, ctx.st, [...ctx.hands[id], ...got], ctx.set)) { playable = c; break; }
  }
  give(ctx, id, got);
  ctx.last = { t: 'draw', by: id, n: got.length, auto };
  if (playable && !auto) { ctx.st.drew = playable; ctx.bump = true; } // 引いたカードは出してもいい
  else endTurn(ctx, i, 1);
}
function passAction(ctx, id, auto = false) {
  if (!ctx.st.drew) return false;
  ctx.last = { t: 'pass', by: id, auto };
  endTurn(ctx, ctx.g.order.indexOf(id), 1);
}
function playAction(ctx, id, idx, color, declared) {
  const hand = ctx.hands[id], card = hand[idx];
  if (!card) return false;
  if (ctx.st.drew && card !== ctx.st.drew) return false;
  if (!canPlay(card, ctx.st, hand, ctx.set)) return false;
  if (isWild(card) && !CC[color]) return false;
  const i = ctx.g.order.indexOf(id), v = valOf(card), before = activeIds(ctx).length;
  hand.splice(idx, 1); ctx.dirty.add(id); ctx.pile.push(card);
  ctx.st.top = card; ctx.st.color = isWild(card) ? color : card[0];
  ctx.last = { t: 'play', by: id, card, color: ctx.st.color };
  if (!hand.length) ctx.ranks.push(id);
  let steps = 1;
  if (v === 'S') steps = 2;
  else if (v === 'R') { ctx.st.dir = -ctx.st.dir; if (before === 2) steps = 2; } // 2人のときはスキップと同じ
  else if (v === 'D' || v === 'W4') {
    const n = v === 'D' ? 2 : 4;
    if (ctx.set.stack) ctx.st.stack += n; // 次の人は重ねるか、まとめて引く
    else {
      const vid = ctx.g.order[nextFrom(ctx, i, 1)];
      const got = take(ctx, n); give(ctx, vid, got);
      ctx.last.victim = vid; ctx.last.vn = got.length; steps = 2;
    }
  }
  if (hand.length === 1) { ctx.upd[`state/uno/${id}`] = declared ? true : null; ctx.upd[`state/unoAt/${id}`] = ctx.st.moveNo + 1; }
  else { ctx.upd[`state/uno/${id}`] = null; ctx.upd[`state/unoAt/${id}`] = null; }
  endTurn(ctx, i, steps);
  const act = activeIds(ctx);
  if (ctx.set.finish === 'first' ? ctx.ranks.length >= 1 : act.length <= 1) {
    if (ctx.set.finish !== 'first') ctx.ranks.push(...act);
    ctx.finished = true;
  }
}
// 時間切れ：1枚引いて次へ。切断中の人の代行（smart）：出せるカードがあれば出す（ゲームが終わらなくならないように）
function autoTurn(ctx, id, smart = false) {
  if (smart && !ctx.st.stack) {
    const hand = ctx.hands[id];
    const i = hand.findIndex((c) => (!ctx.st.drew || c === ctx.st.drew) && canPlay(c, ctx.st, hand, ctx.set));
    if (i >= 0) {
      const cnt = {}; for (const c of hand) if (!isWild(c)) cnt[c[0]] = (cnt[c[0]] || 0) + 1;
      const color = Object.keys(CC).sort((a, b) => (cnt[b] || 0) - (cnt[a] || 0))[0];
      return playAction(ctx, id, i, color, true);
    }
  }
  if (ctx.st.drew) return passAction(ctx, id, true);
  drawAction(ctx, id, true);
}
function finalize(ctx) {
  const u = ctx.upd, b = ctx.base;
  u[`${b}/deck`] = ctx.deck; u[`${b}/pile`] = ctx.pile; u[`${b}/ranks`] = ctx.ranks;
  for (const id of ctx.dirty) u[`${b}/hands/${id}`] = ctx.hands[id].sort(cmpCard);
  for (const k of ['turn', 'dir', 'color', 'top', 'stack', 'drew']) u[`state/${k}`] = ctx.st[k];
  if (ctx.last) u['state/last'] = { ...ctx.last, at: Date.now() };
  if (ctx.bump) {
    const now = S.store.now(), t = ctx.set.timer;
    u['state/moveNo'] = ctx.st.moveNo + 1; u['state/turnAt'] = now; u['state/deadline'] = t ? now + t * 1000 : 0;
  }
  if (ctx.finished) { u['state/phase'] = 'result'; u['state/deadline'] = 0; u[`${b}/done`] = true; u[`${b}/endedAt`] = Date.now(); }
  return u;
}
// 手を1つ実行して保存。key があれば同じ手を二重に送らない
async function act(fn, key) {
  if (S.acting) return false;
  if (key) { if (S.doneKeys.has(key)) return false; S.doneKeys.add(key); }
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return false;
  S.acting = true;
  try {
    const ctx = makeCtx(g, st);
    if (st.caught) applyCatches(ctx, st.caught); // 指摘が残っていれば先に処理
    if (fn(ctx) === false) return false;
    await S.store.update(roomPath(), finalize(ctx));
    return true;
  } finally { S.acting = false; }
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
      <li>場のカードと<b>同じ色</b>か<b>同じ数字・記号</b>のカードを1枚出す。ワイルドはいつでも出せて、次の色を決められる</li>
      <li>出せない（出したくない）ときは山札から引く。引いたカードが出せればそのまま出してもいい</li>
      <li>残り1枚になったら<b>「ラスト1！」</b>ボタン。押し忘れたまま次の人が動く前に指摘されると<b>2枚</b>引く</li>
      <li>手札を最初になくした人の勝ち！</li>
    </ol>
    <div class="u-legend">
      ${['bS', 'gR', 'yD', 'W', 'W4'].map((c) => `<div>${cardHTML(c, { cls: 'mini' })}<span>${{ bS: '次の人を飛ばす', gR: '順番が逆回り', yD: '次の人が2枚引いて休み', W: '好きな色に変える', W4: '色を変えて、次の人が4枚引いて休み' }[c]}</span></div>`).join('')}
    </div>
  </details>`;
}
function renderHome(prefill = '') {
  S.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <a class="back-link" href="${esc(hubUrl())}">‹ ゲーム選択</a>
  <div class="home">
    <div class="logo u-logo">
      <div class="u-fan">${cardHTML('r7')}${cardHTML('W4')}${cardHTML('bR')}</div>
      <h1>ラストワン</h1>
      <p>色か数字をそろえて、最後の1枚を出しきれ</p>
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
  await S.store.set(`rooms/${code}`, { meta: { game: GAME, createdAt: Date.now(), ...DEFAULTS }, state: { phase: 'lobby', game: 0 } });
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
  S.code = null; S.room = null; setUrlRoom(null); document.title = 'ラストワン — あそびば';
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
  const g = curGame(), st = stateOf();
  if (S.sel >= handOf(g, S.pid).length) S.sel = -1;
  if (S.pick >= 0 && (st.phase !== 'play' || g?.order?.[st.turn] !== S.pid)) S.pick = -1;
  if (handOf(g, S.pid).length !== 2) S.unoPress = false;
  notify();
  render();
  onTick();
}
function onTick() {
  if (!S.room) return;
  updateTimer();
  const st = stateOf(), g = curGame();
  if (st.phase !== 'play' || !g) return;
  const cur = g.order[st.turn], now = S.store.now(), mine = cur === S.pid;
  const curOff = !player(cur).online;
  // 指摘された人に2枚配る（手番の人の画面が担当。動いていなければホストが代わりに）
  const caught = Object.values(st.caught || {});
  if (caught.length) {
    const oldest = Math.min(...caught.map((c) => c.at || 0));
    if (mine || (isHost() && (curOff || now > oldest + 3000))) act(() => {}, `c:${st.game}:${st.moveNo}:${Object.keys(st.caught).join(',')}`);
  }
  // 自分の番で時間切れ → 自動で引く（引いたあとならパス）
  if (mine && st.deadline && now > st.deadline) {
    act((ctx) => autoTurn(ctx, cur), `t:${st.game}:${st.moveNo}`).then((ok) => ok && toast('時間切れ！ 自動で山札から引きました'));
  }
  // 手番の人が切断中・止まっている → ホストが代わりに進める
  if (isHost() && !mine) {
    const stalled = curOff ? now > (st.turnAt || 0) + 4000 : st.deadline && now > st.deadline + 5000;
    if (stalled) act((ctx) => autoTurn(ctx, cur, curOff), `h:${st.game}:${st.moveNo}`);
  }
}
function notify() {
  const st = stateOf(), g = curGame();
  const mine = st.phase === 'play' && g && g.order[st.turn] === S.pid;
  document.title = mine ? '🟢 あなたの番！ — ラストワン' : 'ラストワン — あそびば';
  // 指摘・ドローのお知らせ
  const lc = st.lastCatch;
  if (lc && S.seenCatch !== String(lc.at)) {
    const first = !S.seenCatch; S.seenCatch = String(lc.at);
    if (!first) toast(lc.target === S.pid ? `😱 ${player(lc.by).name}さんに言い忘れを指摘された！ 2枚引きます` : `🚨 ${nameOf(lc.by)}が${nameOf(lc.target)}の言い忘れを指摘！ 2枚追加`);
  }
  const l = st.last;
  if (l?.victim && S.seenHit !== String(l.at)) {
    const first = !S.seenHit; S.seenHit = String(l.at);
    if (!first && l.victim === S.pid) toast(`💥 ${l.vn}枚引かされて、お休み…`);
  }
  if (!mine) return;
  const key = `${st.game}:${st.moveNo}`;
  if (S.notified === key) return;
  S.notified = key;
  if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
}

async function startGame() {
  const ids = shuffle(onlinePlayers().map((p) => p.id)).slice(0, MAX_PLAYERS);
  if (ids.length < 2) return toast('2人以上いないと始められません');
  const set = settings();
  const per = Math.min(set.hand, Math.floor(84 / ids.length)); // 山札が残るように
  const deck = shuffle(buildDeck());
  const hands = Object.fromEntries(ids.map((id) => [id, []]));
  for (let k = 0; k < per; k++) for (const id of ids) hands[id].push(deck.pop());
  for (const id of ids) hands[id].sort(cmpCard);
  // 最初の1枚は数字カードにする
  const ti = deck.findLastIndex((c) => /^[rygb]\d$/.test(c));
  const top = deck.splice(ti, 1)[0];
  const n = stateOf().game + 1, now = S.store.now();
  S.sel = -1; S.pick = -1; S.unoPress = false;
  await S.store.update(roomPath(), {
    state: {
      phase: 'play', game: n, turn: 0, dir: 1, color: top[0], top, stack: 0, moveNo: 0, drew: null,
      turnAt: now, deadline: set.timer ? now + set.timer * 1000 : 0, last: { t: 'start', at: Date.now(), per },
    },
    [`games/${gk(n)}`]: { order: ids, hands, deck, pile: [top], ranks: [], startedAt: Date.now(), set },
  });
}

// ---------- 操作 ----------
function myTurn() { const st = stateOf(), g = curGame(); return st.phase === 'play' && g && g.order[st.turn] === S.pid; }
function onCard(el) {
  const i = +el.dataset.i, st = stateOf(), g = curGame(), hand = handOf(g, S.pid), c = hand[i];
  if (!c) return;
  if (!myTurn()) { S.sel = S.sel === i ? -1 : i; updateDynamic(); return; }
  if (st.drew && c !== st.drew) return toast('山札から引いたカードだけ出せます（出さないならパス）');
  if (!canPlay(c, st, hand, settings())) {
    return toast(st.stack > 0 ? `+${st.stack} がたまっています。ドローを重ねるか、まとめて引こう` : `出せません。${CN[st.color]}のカードか、「${sym(st.top) || 'ワイルド'}」を出そう`);
  }
  const isTouch = S.touch;
  if (isTouch && S.sel !== i) { S.sel = i; updateDynamic(); return; }
  if (isWild(c)) { S.pick = i; S.sel = i; updateDynamic(); return; }
  return doPlay(i, null);
}
async function doPlay(i, color) {
  const hand = handOf(curGame(), S.pid), declared = S.unoPress && hand.length === 2;
  S.sel = -1; S.pick = -1;
  const ok = await act((ctx) => playAction(ctx, S.pid, i, color, declared));
  S.unoPress = false;
  if (!ok) updateDynamic();
  else if (hand.length === 2 && !declared) {
    // 宣言せずに残り1枚 → まだ間に合う
    setTimeout(() => { const g = curGame(); if (catchable(g, stateOf(), S.pid)) toast('残り1枚！ 「ラスト1！」を押さないと指摘されるかも'); }, 200);
  }
}
async function doDraw() {
  if (!myTurn()) return;
  const st = stateOf();
  if (st.drew) return toast('もう引きました。出すかパスしてね');
  S.sel = -1; S.pick = -1;
  await act((ctx) => drawAction(ctx, S.pid));
}
async function doPass() { if (myTurn()) { S.sel = -1; S.pick = -1; await act((ctx) => passAction(ctx, S.pid)); } }
async function doUno() {
  const g = curGame(), st = stateOf(), n = handOf(g, S.pid).length;
  if (n === 1 && !st.uno?.[S.pid]) {
    if (st.caught?.[S.pid]) return toast('おそかった…指摘されてしまいました');
    await S.store.set(`${roomPath()}/state/uno/${S.pid}`, true);
    toast('📣 ラスト1！');
    return;
  }
  if (n === 2 && myTurn()) { S.unoPress = !S.unoPress; if (S.unoPress) toast('📣 ラスト1！ このまま1枚出そう'); updateDynamic(); }
}
async function doCatch(el) {
  const id = el.dataset.p, g = curGame(), st = stateOf();
  if (!catchable(g, st, id)) return toast('もう指摘できません');
  await S.store.set(`${roomPath()}/state/caught/${id}`, { by: S.pid, at: S.store.now() });
  toast(`🚨 ${player(id).name}さんの言い忘れを指摘！`);
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
    S.viewKey = key; S.sel = -1; S.pick = -1;
    const views = { lobby: lobbyView, play: playView, result: resultView };
    $app.innerHTML = `${localBanner()}${headerHTML()}<main class="main u-game phase-${st.phase}">${(views[st.phase] || lobbyView)()}</main>`;
    window.scrollTo({ top: 0 });
    if (st.phase === 'result' && !S.confettiDone[st.game]) {
      S.confettiDone[st.game] = true;
      if (ranksOf(curGame())[0] === S.pid) setTimeout(() => confetti(140, Object.values(CC)), 300);
    }
  }
  updateDynamic();
}
function updateDynamic() {
  setHTML(document.getElementById('pbar'), pbarHTML());
  setHTML(document.getElementById('phase-chip'), phaseChipHTML());
  setHTML(document.getElementById('dyn'), dynHTML());
  if (stateOf().phase === 'play') {
    setHTML(document.getElementById('opps'), oppsHTML());
    setHTML(document.getElementById('table'), tableHTML());
    setHTML(document.getElementById('turn-banner'), turnBannerHTML());
    setHTML(document.getElementById('log'), logHTML());
    setHTML(document.getElementById('acts'), actsHTML());
    setHTML(document.getElementById('hand'), handHTML());
    setHTML(document.getElementById('picker'), pickerHTML());
  }
  updateTimer();
}
function dynHTML() {
  const f = { lobby: lobbyDyn, play: playDyn, result: resultDyn }[stateOf().phase];
  return f ? f() : '';
}
function phaseChipHTML() {
  const st = stateOf(), g = curGame();
  if (st.phase === 'play' && g) return `<b>第${st.game}戦</b><span>山札${(g.deck || []).length}枚</span>`;
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
  const h = hostId(), w = winsTotal(), st = stateOf(), g = curGame();
  return playerList().map((p) => `<div class="pchip ${p.online ? '' : 'off'} ${p.id === S.pid ? 'me' : ''}">
      ${avatar({ ...p, color: pcolor(g, p.id) })}
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
function segHTML(k, opts, cur, host) {
  return `<div class="seg u-seg">${opts.map(([v, label]) => `<button class="seg-btn ${cur === v ? 'on' : ''}" data-action="set" data-k="${k}" data-v='${JSON.stringify(v)}' ${host ? '' : 'disabled'}>${label}</button>`).join('')}</div>`;
}
function lobbyDyn() {
  const ps = playerList(), host = isHost(), s = settings(), n = onlinePlayers().length, h = hostId();
  const per = n ? Math.min(s.hand, Math.floor(84 / Math.min(n, MAX_PLAYERS))) : s.hand;
  return `<section class="card">
      <h3>参加メンバー <small>${n}人${n > MAX_PLAYERS ? `（対戦は${MAX_PLAYERS}人まで）` : ''}</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar({ ...p, color: '#8a87a8' })}<span class="nm">${esc(p.name)}${p.id === S.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">切断中</span>'}</li>`).join('')}</ul>
    </section>
    <section class="card u-settings">
      <h3>ルール設定${host ? '' : ' <small class="muted">（ホストが設定します）</small>'}</h3>
      <h4>最初に配る枚数</h4>
      ${segHTML('hand', [3, 5, 7, 10, 15].map((v) => [v, v + '枚']), s.hand, host)}
      <p class="muted small">${s.hand <= 5 ? 'サクッと短期決戦' : s.hand >= 10 ? 'じっくり長期戦' : '標準の枚数'}${per < s.hand ? `（${n}人だと山札が足りないので${per}枚ずつ配ります）` : ''}</p>
      <h4>1手の制限時間</h4>
      ${segHTML('timer', [[15, '15秒'], [30, '30秒'], [60, '60秒'], [0, 'なし']], s.timer, host)}
      <p class="muted small">時間切れになると自動で山札から1枚引いて、次の人の番になります</p>
      <h4>ドロー2・ドロー4を重ねる</h4>
      ${segHTML('stack', [[true, '重ねられる'], [false, '重ねられない']], s.stack, host)}
      <p class="muted small">${s.stack ? '+2 に +2（か +4）、+4 に +4 を重ねて次の人へ回せる。重ねられない人がまとめて引く' : '出された次の人は、すぐに枚数ぶん引いてお休み'}</p>
      <h4>山札から引くとき</h4>
      ${segHTML('draw', [['one', '1枚だけ'], ['until', '出せるまで引く']], s.draw, host)}
      <p class="muted small">${s.draw === 'one' ? '1枚引いて、それが出せれば出してもいい' : '出せるカードが出るまで引き続ける（手札が一気に増えることも）'}</p>
      <h4>ワイルドドロー4</h4>
      ${segHTML('w4', [['free', 'いつでも出せる'], ['strict', '場の色がないときだけ']], s.w4, host)}
      <p class="muted small">${s.w4 === 'free' ? 'ワイルドと同じく、いつでも出せる' : '場と同じ色のカードを持っているときは出せない（公式ルールに近い）'}</p>
      <h4>終わり方</h4>
      ${segHTML('finish', [['first', '1人あがったら終了'], ['all', '最後の1人まで']], s.finish, host)}
      <p class="muted small">${s.finish === 'first' ? '残りの人は手札の点数が少ない順に順位がつきます' : 'あがった人から順位が決まり、最後の1人まで続けます'}</p>
    </section>
    ${host
      ? `<button class="btn primary big" data-action="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'あと1人集まったら開始できます' : 'ゲームスタート！'}</button>`
      : `<div class="waiting">ホストの ${esc(player(h).name)} さんの開始を待っています<span class="dots"></span></div>`}${isHost() ? changeGameBtn() : ''}`;
}

// ---------- 対戦 ----------
function playView() {
  const g = curGame(), me = g?.order?.includes(S.pid);
  return `<div id="opps" class="u-opps"></div>
    <div id="table" class="u-table"></div>
    <div id="turn-banner" class="turn-banner"></div>
    <div class="db-timer" id="timer"><i></i></div>
    <div id="log" class="u-log"></div>
    ${me ? `<div id="acts" class="u-acts"></div><div id="hand" class="u-hand"></div>` : '<div id="acts"></div><div id="hand"></div><p class="muted small center">観戦中（次のゲームから参加できます）</p>'}
    <div id="picker"></div>
    <div id="dyn"></div>`;
}
// 自分から見た席順（自分の次の人から並べる）
function seatOrder(g) {
  const o = g.order, i = o.indexOf(S.pid);
  if (i < 0) return o;
  return [...o.slice(i + 1), ...o.slice(0, i)];
}
function oppsHTML() {
  const g = curGame(), st = stateOf(); if (!g) return '';
  const ranks = ranksOf(g), cur = g.order[st.turn];
  return seatOrder(g).map((id) => {
    const p = player(id), n = handOf(g, id).length, r = ranks.indexOf(id), col = pcolor(g, id);
    const isCur = id === cur, can = id !== S.pid && catchable(g, st, id);
    const backs = Array.from({ length: Math.min(n, 10) }, (_, k) => `<i style="--k:${k}"></i>`).join('');
    return `<div class="u-opp ${isCur ? 'cur' : ''} ${p.online ? '' : 'off'} ${r >= 0 ? 'out' : ''}" style="--pc:${col}">
      <div class="u-opp-top">${avatar({ ...p, color: col }, 'sm')}<span class="nm">${esc(p.name)}</span></div>
      ${r >= 0 ? `<div class="u-rank">🏅 ${r + 1}位であがり</div>` : `<div class="u-backs">${backs}<b>${n}</b></div>`}
      ${st.uno?.[id] && n === 1 ? '<span class="u-badge">ラスト1！</span>' : ''}
      ${can ? `<button class="u-catch" data-action="catch" data-p="${id}">🚨 言ってない！</button>` : ''}
    </div>`;
  }).join('');
}
function tableHTML() {
  const g = curGame(), st = stateOf(); if (!g) return '';
  const pileN = (g.pile || []).length, deckN = (g.deck || []).length, mt = myTurn() && !st.drew;
  return `<div class="u-deck ${mt ? 'can' : ''}">
      ${deckN ? `<button class="u-deck-btn" data-action="draw" ${mt ? '' : 'tabindex="-1"'} aria-label="山札から引く">${backHTML('d3')}${backHTML('d2')}${backHTML('d1')}</button>` : '<div class="uc empty">空</div>'}
      <small>山札 ${deckN}</small>
    </div>
    <div class="u-center" style="--cc:${CC[st.color] || '#fff'}">
      <div class="u-ring ${st.dir < 0 ? 'ccw' : ''}"><span>${st.dir < 0 ? '↺' : '↻'}</span></div>
      <div class="u-top" data-k="${pileN}">${cardHTML(st.top, { cls: 'big' })}</div>
      ${isWild(st.top) ? `<div class="u-chosen">${CN[st.color]}</div>` : ''}
    </div>
    <div class="u-info">
      <div class="u-color" style="--cc:${CC[st.color]}"><i></i>${CN[st.color]}</div>
      <div class="muted tiny">${st.dir < 0 ? '↺ 逆回り' : '↻ 時計回り'}</div>
      ${st.stack > 0 ? `<div class="u-stack">+${st.stack}<small>たまってる</small></div>` : ''}
    </div>`;
}
function turnBannerHTML() {
  const st = stateOf(), g = curGame(); if (!g) return '';
  const id = g.order[st.turn], p = player(id), col = pcolor(g, id);
  if (id === S.pid) {
    const sub = st.stack > 0 ? `<span class="bonus">+${st.stack} を重ねるか、まとめて引く</span>` : st.drew ? '<span class="bonus">引いたカードを出す？</span>' : '';
    return `<div class="tb mine" style="--pc:${col}">🟢 あなたの番！${sub}</div>`;
  }
  return `<div class="tb" style="--pc:${col}">${avatar({ ...p, color: col }, 'xs')} ${esc(p.name)} さんの番${p.online ? '' : '（切断中）'}${st.stack > 0 ? `<span class="bonus">+${st.stack}</span>` : ''}</div>`;
}
function logHTML() {
  const l = stateOf().last; if (!l) return '';
  const who = (id) => `<b>${esc(id === S.pid ? 'あなた' : player(id).name)}</b>`;
  if (l.t === 'start') return `🃏 ${l.per}枚ずつ配りました。スタート！`;
  if (l.t === 'play') {
    const extra = l.victim ? `　→ ${who(l.victim)} が${l.vn}枚引いてお休み` : '';
    return `${who(l.by)} が ${cardHTML(l.card, { cls: 'tiny' })} ${cardName(l.card)}${isWild(l.card) ? `（${CN[l.color]}に指定）` : ''}を出した${extra}`;
  }
  if (l.t === 'draw') return `${who(l.by)} が山札から${l.n}枚引いた${l.auto ? '（時間切れ）' : ''}`;
  if (l.t === 'take') return `${who(l.by)} がドロー${l.n}枚をまとめて引いた${l.auto ? '（時間切れ）' : ''}`;
  if (l.t === 'pass') return `${who(l.by)} はパス${l.auto ? '（時間切れ）' : ''}`;
  return '';
}
function actsHTML() {
  const g = curGame(), st = stateOf(); if (!g || !g.order.includes(S.pid) || ranksOf(g).includes(S.pid)) return '';
  const hand = handOf(g, S.pid), mt = myTurn(), btns = [];
  if (mt) {
    if (st.drew) btns.push('<button class="btn" data-action="pass">パス（出さない）</button>');
    else btns.push(`<button class="btn ${st.stack > 0 ? 'danger' : ''}" data-action="draw">${st.stack > 0 ? `${st.stack}枚まとめて引く` : '山札から引く'}</button>`);
  }
  const late = hand.length === 1 && !st.uno?.[S.pid] && catchable(g, st, S.pid);
  if (late) btns.push('<button class="btn u-uno hot" data-action="uno">📣 ラスト1！</button>');
  else if (mt && hand.length === 2) btns.push(`<button class="btn u-uno ${S.unoPress ? 'on' : ''}" data-action="uno">${S.unoPress ? '📣 宣言ずみ！' : '📣 ラスト1！'}</button>`);
  else if (hand.length === 1 && st.uno?.[S.pid]) btns.push('<span class="u-said">📣 ラスト1！ 宣言ずみ</span>');
  return btns.join('');
}
function handHTML() {
  const g = curGame(), st = stateOf(); if (!g || !g.order.includes(S.pid)) return '';
  if (ranksOf(g).includes(S.pid)) return `<div class="u-done">🎉 ${ranksOf(g).indexOf(S.pid) + 1}位であがり！ みんなの勝負を見守ろう</div>`;
  const hand = handOf(g, S.pid), mt = myTurn(), set = settings();
  const tip = mt ? (S.touch ? 'カードをタップで選んで、もう一度タップで出す' : 'カードをクリックして出す') : '';
  return `<div class="u-hand-head"><span>あなたの手札 <b>${hand.length}</b>枚</span><span class="muted tiny">${tip}</span></div>
    <div class="u-cards" style="--ov:${hand.length <= 7 ? 2 : hand.length <= 12 ? -12 : -22}px;--ov-pad:${hand.length <= 7 ? 0 : hand.length <= 12 ? 12 : 22}px">${hand.map((c, i) => {
      const ok = mt && (!st.drew || c === st.drew) && canPlay(c, st, hand, set);
      const cls = [mt ? (ok ? 'ok' : 'no') : '', S.sel === i ? 'sel' : '', st.drew && c === st.drew && mt ? 'drawn' : ''].join(' ');
      return cardHTML(c, { tag: 'button', cls, attrs: `data-action="card" data-i="${i}"` });
    }).join('')}</div>`;
}
function pickerHTML() {
  if (S.pick < 0 || !myTurn()) return '';
  const c = handOf(curGame(), S.pid)[S.pick]; if (!c) return '';
  return `<div class="u-picker" data-action="pick-cancel">
    <div class="u-pick-box" data-stop="1">
      <p>${cardName(c)}：次の色を選んでね</p>
      <div class="u-pick-grid">${Object.keys(CC).map((k) => `<button style="--cc:${CC[k]}" data-action="color" data-c="${k}">${CN[k]}</button>`).join('')}</div>
      <button class="btn ghost wide" data-action="pick-cancel">やめる</button>
    </div></div>`;
}
function updateTimer() {
  const el = document.getElementById('timer'); if (!el) return;
  const st = stateOf(), t = settings().timer, g = curGame();
  if (st.phase !== 'play' || !st.deadline || !t) { el.classList.add('none'); return; }
  el.classList.remove('none');
  const left = Math.max(0, st.deadline - S.store.now());
  el.classList.toggle('warn', left < 6000);
  el.style.setProperty('--pc', g ? pcolor(g, g.order[st.turn]) : '#fff');
  el.querySelector('i').style.width = `${Math.min(100, (left / (t * 1000)) * 100)}%`;
}
function playDyn() {
  const st = stateOf(), g = curGame(); if (!g) return '';
  const cur = g.order[st.turn];
  if (isHost() && !player(cur).online && cur !== S.pid) return '<p class="muted small center">切断中の人の番は、自動で進めます…</p>';
  return '';
}

// ---------- 結果 ----------
function standings(g) {
  const ranks = ranksOf(g);
  const pts = (id) => handOf(g, id).reduce((a, c) => a + points(c), 0);
  const rest = g.order.filter((id) => !ranks.includes(id)).map((id) => ({ id, pts: pts(id) })).sort((a, b) => a.pts - b.pts);
  const rows = [...ranks.map((id) => ({ id, pts: pts(id), out: handOf(g, id).length === 0 })), ...rest];
  let rank = 0;
  return rows.map((x, i) => {
    if (i <= ranks.length || x.pts !== rows[i - 1].pts) rank = i + 1; // 手札が残った人は同点なら同順位
    return { ...x, rank };
  });
}
function resultView() {
  const g = curGame(), rows = standings(g), wins = winsTotal(), w = ranksOf(g)[0];
  const title = w === S.pid ? 'あなたの勝ち！' : `${esc(player(w).name)} さんの勝ち！`;
  return `<section class="final-head">
      <div class="trophy">🏆</div>
      <h2>${title}</h2>
      <p class="muted small">第${stateOf().game}戦　最後のカード ${cardHTML(stateOf().top, { cls: 'tiny' })}</p>
    </section>
    <section class="card"><ol class="standings u-standings">${rows.map((x) => {
      const p = player(x.id), hand = handOf(g, x.id);
      return `<li class="${x.id === S.pid ? 'me' : ''}">
        <div class="u-row"><span class="rank r${x.rank}">${x.rank}</span>${avatar({ ...p, color: pcolor(g, x.id) }, 'sm')}<span class="nm">${esc(p.name)}</span><span class="muted tiny">通算🏆${wins[x.id] || 0}</span>
        <b>${x.out ? 'あがり' : `${x.pts}<small>点</small>`}</b></div>
        ${hand.length ? `<div class="u-left">${hand.map((c) => cardHTML(c, { cls: 'tiny' })).join('')}</div>` : ''}
      </li>`;
    }).join('')}</ol>
    <p class="muted tiny">点数＝残った手札（数字はその数、記号20点、ワイルド50点）。少ないほど上位</p></section>
    <div id="dyn"></div>`;
}
function resultDyn() {
  if (isHost()) {
    const n = onlinePlayers().length;
    return `<div class="host-bar">
      <button class="btn primary big" data-action="start" ${n < 2 ? 'disabled' : ''}>${n < 2 ? '2人以上必要です' : '🔁 もう一戦（席順をシャッフル）'}</button>
      <button class="btn ghost wide" data-action="to-lobby">ロビーに戻る（ルールを変える）</button>
    ${changeGameBtn()}</div>`;
  }
  return `<div class="waiting">ホストの ${esc(player(hostId()).name)} さんを待っています<span class="dots"></span></div>`;
}
async function toLobby() { await S.store.update(roomPath(), { 'state/phase': 'lobby' }); }

// =============================================================
//  イベント
// =============================================================
async function copyLink() {
  const url = pageUrl('uno.html', S.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'ラストワン', text: `ラストワンで遊ぼう！部屋コード：${S.code}`, url: pageUrl('uno.html', S.code) }); } catch {}
}
const actions = {
  'change-game': () => { if (confirm('今のゲームを終えて、みんなでロビーに戻りますか？')) return switchGame(S.store, S.code, 'lobby', playerList().map((p) => p.id)); },
  create: createRoom,
  join: (el) => joinRoom(el.dataset.code || document.getElementById('code')?.value),
  'copy-link': copyLink, share: shareLink, leave: leaveRoom,
  set: (el) => S.store.set(`${roomPath()}/meta/${el.dataset.k}`, JSON.parse(el.dataset.v)),
  start: startGame, 'to-lobby': toLobby,
  card: onCard, draw: doDraw, pass: doPass, uno: doUno, catch: doCatch,
  color: (el) => { const i = S.pick; if (i >= 0) return doPlay(i, el.dataset.c); },
  'pick-cancel': () => { S.pick = -1; S.sel = -1; updateDynamic(); },
};
$app.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a || a.disabled) return;
  if (a.dataset.action === 'pick-cancel' && a.classList.contains('u-picker') && e.target.closest('[data-stop]')) return;
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
