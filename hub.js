// =============================================================
//  ゲーム選択画面
// =============================================================
import { createStore } from './store.js';
import { esc, toast, pageUrl, localBanner, gotoRoom } from './common.js';
import { VERSION, UPDATED } from './version.js';

const $app = document.getElementById('app');
let store = null;

const TIER_COLORS = ['#ff5a6e', '#ff9f45', '#ffd84d', '#6fdc8c', '#5aa9ff'];

function render() {
  $app.innerHTML = `${localBanner()}
  <div class="hub">
    <header class="hub-head">
      <div class="hub-mark">🎲</div>
      <h1>あそびば</h1>
      <p>友達とオンラインで遊べるパーティーゲーム集</p>
    </header>

    <h2 class="hub-sec">ゲームをえらぶ</h2>
    <div class="games">
      <a class="game-card tier" href="${esc(pageUrl('tier.html'))}">
        <div class="gc-art"><div class="gc-tiers">${['S', 'A', 'B', 'C', 'D'].map((t, i) => `<span style="--c:${TIER_COLORS[i]};--i:${i}">${t}</span>`).join('')}</div></div>
        <div class="gc-body">
          <h3>ティアよみ</h3>
          <p>出題者のティア表を予想しよう。あの人の「好き」をどこまで読める？</p>
          <div class="gc-meta"><span>👥 2〜10人</span><span>⏱ 1問 約3分</span></div>
        </div>
        <span class="gc-go">あそぶ ›</span>
      </a>
      <a class="game-card ekaki" href="${esc(pageUrl('ekaki.html'))}">
        <div class="gc-art"><div class="gc-paper">
          <svg viewBox="0 0 120 80" aria-hidden="true">
            <path d="M18 58 C 30 20, 52 18, 60 40" stroke="#e8384f" />
            <path d="M60 40 C 66 56, 84 62, 98 30" stroke="#1c7ed6" />
            <path d="M30 66 L 92 66" stroke="#2f9e44" />
            <path d="M44 30 q 8 -14 18 -4" stroke="#9c36b5" />
          </svg>
          <span class="gc-wolf">🐺</span>
        </div></div>
        <div class="gc-body">
          <h3>絵描き人狼</h3>
          <p>1人だけお題を知らない人狼がいる。みんなで一筆ずつ描いて見つけ出せ！</p>
          <div class="gc-meta"><span>👥 3〜10人</span><span>⏱ 1ゲーム 約5分</span></div>
        </div>
        <span class="gc-go">あそぶ ›</span>
      </a>
      <a class="game-card eshiri" href="${esc(pageUrl('eshiri.html'))}">
        <span class="gc-new">NEW</span>
        <div class="gc-art"><div class="gc-shiri">
          <span class="k">り</span><i>→</i><span class="p">🍎</span><i>→</i><span class="q">？</span><i>→</i><span class="k">と</span>
        </div></div>
        <div class="gc-body">
          <h3>えしりとり</h3>
          <p>絵だけでつなぐ伝言しりとり。「りんご」のつもりが「トマト」に見えて…ズレていく答え合わせが最高！</p>
          <div class="gc-meta"><span>👥 3〜10人</span><span>⏱ 1ラウンド 約8分</span></div>
        </div>
        <span class="gc-go">あそぶ ›</span>
      </a>
    </div>

    <h2 class="hub-sec">部屋コードで参加</h2>
    <section class="card">
      <div class="join-row">
        <input id="code" maxlength="4" placeholder="部屋コード（4文字）" autocapitalize="characters" autocomplete="off" enterkeyhint="go" class="mono">
        <button class="btn primary" data-action="join">参加</button>
      </div>
      <p class="muted small">友達から届いた4文字のコードを入力すると、そのゲームの部屋に移動します</p>
    </section>
    <footer class="hub-foot"><span class="ver">ver ${VERSION}</span><span>${UPDATED} 更新</span></footer>
  </div>`;
}

async function join() {
  const el = document.getElementById('code');
  const code = (el.value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { toast('4文字の部屋コードを入力してね'); el.focus(); return; }
  if (!(await gotoRoom(store, code))) toast('部屋が見つかりません');
}

$app.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action="join"]');
  if (a) join().catch((err) => toast('エラー：' + (err?.message || err)));
});
$app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.target.id === 'code') { e.preventDefault(); join(); }
});
$app.addEventListener('input', (e) => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

(async () => {
  try { store = await createStore(); } catch (e) {
    $app.innerHTML = `<div class="card center"><h2>接続できませんでした</h2><p class="muted">firebase-config.js の設定を確認してください。</p><pre class="err">${esc(e.message)}</pre></div>`;
    return;
  }
  // 古い招待リンク（index.html?room=XXXX）にも対応
  const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (code) {
    $app.innerHTML = `<div class="boot">部屋 ${esc(code)} を探しています…</div>`;
    if (await gotoRoom(store, code)) return;
    toast('部屋が見つかりません');
  }
  render();
})();
