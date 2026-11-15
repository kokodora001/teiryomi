// =============================================================
//  ゲーム選択画面 ＋ 共通ロビー
//  ・ロビーを作ってメンバーを集める → ホストがゲームを選ぶ → 全員そのゲームへ
//  ・ゲーム中に「ゲームを変える」でみんなここに戻ってくる（部屋はそのまま）
// =============================================================
import { createStore } from './store.js';
import {
  esc, toast, pageUrl, localBanner, gotoRoom, genCode, getPid, getName, saveName, setUrlRoom, avatar,
  ROOM_KEY, MIN_PLAYERS, joinPlayer, followRoom, switchGame,
} from './common.js';
import { VERSION, UPDATED } from './version.js';

const $app = document.getElementById('app');
const H = { store: null, pid: '', name: '', code: null, room: null, unsub: null, stopPresence: null, viewKey: '' };

const TIER_COLORS = ['#ff5a6e', '#ff9f45', '#ffd84d', '#6fdc8c', '#5aa9ff'];
const LOBBY_COLORS = ['#ff6b9a', '#4dc3ff', '#ffb347', '#7ee081', '#b98bff', '#ff7f50', '#40e0d0', '#f4d35e', '#e88bff', '#9fd3ff'];

// ---------- ゲームカード ----------
const CARDS = [
  {
    id: 'tier', name: 'ティアよみ', players: '2〜10人', time: '1問 約3分',
    desc: '出題者のティア表を予想しよう。あの人の「好き」をどこまで読める？',
    art: () => `<div class="gc-tiers">${['S', 'A', 'B', 'C', 'D'].map((t, i) => `<span style="--c:${TIER_COLORS[i]};--i:${i}">${t}</span>`).join('')}</div>`,
  },
  {
    id: 'ekaki', name: '絵描き人狼', players: '3〜10人', time: '1ゲーム 約5分',
    desc: '1人だけお題を知らない人狼がいる。みんなで一筆ずつ描いて見つけ出せ！',
    art: () => `<div class="gc-paper"><svg viewBox="0 0 120 80" aria-hidden="true">
        <path d="M18 58 C 30 20, 52 18, 60 40" stroke="#e8384f" /><path d="M60 40 C 66 56, 84 62, 98 30" stroke="#1c7ed6" />
        <path d="M30 66 L 92 66" stroke="#2f9e44" /><path d="M44 30 q 8 -14 18 -4" stroke="#9c36b5" />
      </svg><span class="gc-wolf">🐺</span></div>`,
  },
  {
    id: 'eshiri', name: 'えしりとり', players: '3〜10人', time: '1ラウンド 約8分',
    desc: '絵だけでつなぐ伝言しりとり。「りんご」のつもりが「トマト」に見えて…ズレていく答え合わせが最高！',
    art: () => `<div class="gc-shiri"><span class="k">り</span><i>→</i><span class="p">🍎</span><i>→</i><span class="q">？</span><i>→</i><span class="k">と</span></div>`,
  },
  {
    id: 'dengon', name: 'お絵かき伝言', players: '3〜10人', time: '1ラウンド 約8分',
    desc: 'お題を絵に、絵を答えに。伝言していくうちに「寝坊したサンタ」が何に化ける？',
    art: () => `<div class="gc-shiri gc-dengon"><span>📝</span><i>→</i><span>🖼</span><i>→</i><span>💬</span><i>→</i><span>🖼</span></div>`,
  },
  {
    id: 'dots', name: 'ドット＆ボックス', players: '2〜6人', time: '1戦 約5分',
    desc: '順番に線を1本ずつ。四角を閉じたら自分の陣地で、もう1手！ 3辺目を引かされるのは誰だ？',
    art: () => `<svg class="gc-dots" viewBox="0 0 160 100" aria-hidden="true">
        <rect x="30" y="20" width="30" height="30" fill="#ff5a8a66"/><rect x="90" y="50" width="30" height="30" fill="#4dc3ff66"/>
        <path d="M30 20H60V50H30Z M90 50H120V80H90Z" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/>
        <path class="gc-dl" d="M60 20H90" stroke="#ffc145" stroke-width="5" stroke-linecap="round"/>
        ${[20, 50, 80].map((y) => [30, 60, 90, 120].map((x) => `<circle cx="${x}" cy="${y}" r="5" fill="#fff"/>`).join('')).join('')}
      </svg>`,
  },
  {
    id: 'jintori', name: '同時陣取り', players: '2〜6人', time: '1戦 約5分',
    desc: '全員が同時にマスを選ぶ陣取り。同じマスを選んだら岩に！ 読み合いと囲い込みで陣地を広げろ',
    art: () => `<div class="gc-jt">${'aab.b a#.bb aa★.b'.replace(/ /g, '').split('').map((c) => `<i class="${c === 'a' ? 'pa' : c === 'b' ? 'pb' : c === '#' ? 'rk' : c === '★' ? 'st' : ''}">${c === '★' ? '★' : ''}</i>`).join('')}</div>`,
  },
  {
    id: 'fruit', name: 'フルーツまぜまぜ', players: '1〜10人', time: '1戦 約5〜15分',
    desc: '同じ果物をくっつけて進化させる落ち物パズル。みんな同時にスタートして、スイカを作った人が勝ち！',
    art: () => `<div class="gc-fruit">${[['#e8384f', 10], ['#ff9f1c', 16], ['#e63946', 22], ['#a5d86a', 28], ['#2f9e44', 34]].map(([c, r], i) => `<i style="--c:${c};--r:${r}px;--i:${i}"></i>`).join('')}</div>`,
  },
  {
    id: 'sudoku', name: 'ナンプレバトル', players: '1〜10人', time: '1戦 約5〜15分',
    desc: '全員に同じナンプレが同時に配られる早解き対戦。ミスするたびにペナルティがどんどん重くなる！',
    art: () => `<div class="gc-su">${'5.3..7.6.19.5..98..'.slice(0, 16).split('').map((c, i) => `<i class="${c === '.' ? '' : 'n'}" style="--i:${i}">${c === '.' ? '' : c}</i>`).join('')}</div>`,
  },
  {
    id: 'uno', name: 'ラストワン', players: '2〜10人', time: '1戦 約5〜10分',
    desc: '色か数字をそろえて出していくUNO風カードゲーム。残り1枚で「ラスト1！」、言い忘れたら指摘されて2枚追加！',
    art: () => `<div class="gc-uno">${[['#ef4b5f', '7'], ['#2a2340', '+4'], ['#3b82f6', '⇄'], ['#f7b928', '2']].map(([c, t], i) => `<i style="--c:${c};--i:${i}">${t}</i>`).join('')}</div>`,
  },
];
function cardLink(c) {
  return `<a class="game-card g-${c.id}" href="${esc(pageUrl(c.id + '.html'))}">
      <div class="gc-art">${c.art()}</div>
      <div class="gc-body"><h3>${c.name}</h3><p>${c.desc}</p><div class="gc-meta"><span>👥 ${c.players}</span><span>⏱ ${c.time}</span></div></div>
      <span class="gc-go">あそぶ ›</span>
    </a>`;
}
function cardPick(c, picked, host, n) {
  const short = n < MIN_PLAYERS[c.id];
  return `<button class="pick-card g-${c.id} ${picked ? 'on' : ''}" ${host ? `data-action="pick" data-game="${c.id}"` : 'tabindex="-1"'}>
      <div class="gc-art">${c.art()}</div>
      <div class="pc-body"><b>${c.name}</b><small>👥 ${c.players}${short ? '<em>人数不足</em>' : ''}</small></div>
      ${picked ? '<span class="pc-check">✓</span>' : ''}
    </button>`;
}

// ---------- ロビーの状態 ----------
function playerList() {
  return Object.entries(H.room?.players || {})
    .filter(([, p]) => p && p.name).map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
}
const onlinePlayers = () => playerList().filter((p) => p.online);
const hostId = () => (onlinePlayers()[0] || playerList()[0] || {}).id;
const isHost = () => hostId() === H.pid;

// =============================================================
//  ホーム（部屋に入る前）
// =============================================================
function renderHome(prefill = '') {
  H.viewKey = 'home';
  $app.innerHTML = `${localBanner()}
  <div class="hub">
    <header class="hub-head">
      <div class="hub-mark">🎲</div>
      <h1>あそびば</h1>
      <p>友達とオンラインで遊べるパーティーゲーム集</p>
    </header>

    <section class="card lobby-start">
      <h2>みんなで遊ぶ</h2>
      <p class="muted small">ロビーを作って友達を集めよう。ゲームはあとから選べて、遊び終わったら同じメンバーのまま別のゲームに移れます。</p>
      <label class="field"><span>ニックネーム</span>
        <input id="name" maxlength="10" placeholder="例：たろう" value="${esc(H.name)}" autocomplete="nickname" enterkeyhint="go"></label>
      ${prefill ? `
        <button class="btn primary big" data-action="join" data-code="${esc(prefill)}">ロビー <b class="mono">${esc(prefill)}</b> に参加する</button>
        <div class="or"><span>または</span></div>
        <button class="btn wide" data-action="create">新しいロビーを作る</button>` : `
        <button class="btn primary big" data-action="create">ロビーを作る</button>
        <div class="or"><span>または</span></div>
        <div class="join-row">
          <input id="code" maxlength="4" placeholder="部屋コード（4文字）" autocapitalize="characters" autocomplete="off" enterkeyhint="go" class="mono">
          <button class="btn" data-action="join">参加</button>
        </div>`}
    </section>

    <h2 class="hub-sec">ゲーム一覧 <small>（ここから直接遊ぶこともできます）</small></h2>
    <div class="games">${CARDS.map(cardLink).join('')}</div>

    <footer class="hub-foot"><span class="ver">ver ${VERSION}</span><span>${UPDATED} 更新</span></footer>
  </div>`;
}
function readName() {
  const el = document.getElementById('name');
  const v = (el?.value || '').trim();
  if (!v) { toast('ニックネームを入力してね'); el?.focus(); return null; }
  H.name = v.slice(0, 10); saveName(H.name);
  return H.name;
}
async function createLobby() {
  if (!readName()) return;
  let code = genCode();
  for (let i = 0; i < 8; i++) { if (!(await H.store.get(`rooms/${code}/meta`))) break; code = genCode(); }
  await H.store.set(`rooms/${code}`, { meta: { game: 'lobby', createdAt: Date.now() }, state: { phase: 'lobby', round: 0 } });
  await enterLobby(code);
}
async function join(raw) {
  const el = document.getElementById('code');
  const code = (raw || el?.value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { toast('4文字の部屋コードを入力してね'); el?.focus(); return; }
  const meta = await H.store.get(`rooms/${code}/meta`);
  if (!meta) { toast('部屋が見つかりません'); return; }
  if (!readName()) return;
  sessionStorage.setItem(ROOM_KEY, code);
  if (meta.game && meta.game !== 'lobby') { await gotoRoom(H.store, code); return; } // ゲーム中ならそのゲームへ
  await enterLobby(code);
}
async function enterLobby(code) {
  H.code = code; H.viewKey = '';
  sessionStorage.setItem(ROOM_KEY, code);
  setUrlRoom(code);
  await joinPlayer(H.store, code, H.pid, H.name, LOBBY_COLORS);
  H.stopPresence = H.store.presence(`rooms/${code}/players/${H.pid}/online`);
  H.unsub = H.store.on(`rooms/${code}`, onRoom);
}
async function leaveLobby() {
  if (!confirm('ロビーから退出しますか？')) return;
  const code = H.code;
  H.unsub?.(); H.unsub = null; H.stopPresence?.(); H.stopPresence = null;
  await H.store.remove(`rooms/${code}/players/${H.pid}`);
  sessionStorage.removeItem(ROOM_KEY);
  H.code = null; H.room = null; setUrlRoom(null);
  renderHome();
}

// =============================================================
//  ロビー
// =============================================================
function onRoom(room) {
  if (!room || !room.meta) {
    H.unsub?.(); H.stopPresence?.();
    sessionStorage.removeItem(ROOM_KEY); setUrlRoom(null);
    H.code = null; H.room = null; toast('部屋が見つかりません'); renderHome(); return;
  }
  if (followRoom(room, 'lobby', H.code)) { H.unsub?.(); return; } // ゲームが選ばれたら全員移動
  H.room = room;
  if (H.viewKey !== 'lobby') { H.viewKey = 'lobby'; $app.innerHTML = lobbyShell(); }
  setHTML(document.getElementById('lobby-dyn'), lobbyDyn());
}
function setHTML(el, html) { if (el && el._h !== html) { el._h = html; el.innerHTML = html; } }
function lobbyShell() {
  return `${localBanner()}
  <header class="topbar">
    <button class="room-chip" data-action="copy-link" title="招待リンクをコピー"><small>ROOM</small><b class="mono">${esc(H.code)}</b><i>🔗</i></button>
    <div class="phase-chip"><span>ロビー</span></div>
    <button class="btn small ghost" data-action="leave">退出</button>
  </header>
  <section class="card invite">
    <div class="invite-label">ロビーの部屋コード</div>
    <div class="invite-code mono">${[...H.code].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}</div>
    <p class="muted small">このコードかリンクを友達に送ろう。ゲームを変えても、この部屋のまま遊べます</p>
    <div class="row center">
      <button class="btn" data-action="copy-link">🔗 リンクをコピー</button>
      ${navigator.share ? '<button class="btn" data-action="share">📤 共有</button>' : ''}
    </div>
  </section>
  <div id="lobby-dyn"></div>
  <footer class="hub-foot"><span class="ver">ver ${VERSION}</span><span>${UPDATED} 更新</span></footer>`;
}
function lobbyDyn() {
  const ps = playerList(), n = onlinePlayers().length, h = hostId(), host = isHost();
  const pick = H.room.meta?.pick || '';
  const card = CARDS.find((c) => c.id === pick);
  const need = card ? MIN_PLAYERS[pick] : 0;
  return `<section class="card">
      <h3>メンバー <small>${n}人</small></h3>
      <ul class="plist">${ps.map((p) => `<li class="${p.online ? '' : 'off'}">${avatar(p)}<span class="nm">${esc(p.name)}${p.id === H.pid ? ' <small class="muted">(あなた)</small>' : ''}</span>${p.id === h ? '<span class="tag host">ホスト</span>' : ''}${p.online ? '' : '<span class="muted tiny">移動中・切断中</span>'}</li>`).join('')}</ul>
    </section>
    <h2 class="hub-sec">${host ? '遊ぶゲームを選んでね' : `ホストの ${esc(player(h).name)} さんがゲームを選んでいます`}</h2>
    <div class="pick-grid">${CARDS.map((c) => cardPick(c, c.id === pick, host, n)).join('')}</div>
    ${host
      ? `<button class="btn primary big" data-action="go" ${!card || n < need ? 'disabled' : ''}>${!card ? 'ゲームを選んでください' : n < need ? `${card.name}は${need}人から遊べます` : `${card.name}で遊ぶ！`}<small>${card ? '全員がこのゲームに移動します' : ''}</small></button>`
      : `<div class="waiting">${card ? `「${card.name}」が選ばれています。` : ''}ホストの開始を待っています<span class="dots"></span></div>`}`;
}
function player(id) { const p = H.room?.players?.[id]; return p ? { id, ...p } : { id, name: '???' }; }
async function go() {
  const pick = H.room.meta?.pick;
  if (!pick || onlinePlayers().length < MIN_PLAYERS[pick]) return;
  await switchGame(H.store, H.code, pick, playerList().map((p) => p.id));
}
async function copyLink() {
  const url = pageUrl('index.html', H.code);
  try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました'); }
  catch { prompt('このリンクを友達に送ってね', url); }
}
async function shareLink() {
  try { await navigator.share({ title: 'あそびば', text: `あそびばで遊ぼう！部屋コード：${H.code}`, url: pageUrl('index.html', H.code) }); } catch {}
}

// =============================================================
//  イベント
// =============================================================
const actions = {
  create: createLobby,
  join: (el) => join(el.dataset.code),
  leave: leaveLobby,
  'copy-link': copyLink, share: shareLink,
  pick: (el) => H.store.set(`rooms/${H.code}/meta/pick`, el.dataset.game),
  go,
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

(async () => {
  H.pid = getPid(); H.name = getName();
  try { H.store = await createStore(); } catch (e) {
    $app.innerHTML = `<div class="card center"><h2>接続できませんでした</h2><p class="muted">firebase-config.js の設定を確認してください。</p><pre class="err">${esc(e.message)}</pre></div>`;
    return;
  }
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code) {
    $app.innerHTML = `<div class="boot">部屋 ${esc(code)} を探しています…</div>`;
    const meta = await H.store.get(`rooms/${code}/meta`);
    if (!meta) { toast('部屋が見つかりません'); setUrlRoom(null); renderHome(); return; }
    if (meta.game && meta.game !== 'lobby') { await gotoRoom(H.store, code); return; } // 古い招待リンク・ゲーム中の部屋
    if (H.name && sessionStorage.getItem(ROOM_KEY) === code) { await enterLobby(code); return; } // ゲームから戻ってきた
    renderHome(code); return;
  }
  renderHome();
})();
