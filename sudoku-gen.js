// =============================================================
//  ナンプレの問題づくり（画面や通信に依存しない純粋なロジック）
//  盤面は81文字の文字列。'0' は空きマス
// =============================================================
export const DIFFS = {
  easy: { label: 'かんたん', givens: 40 },
  normal: { label: 'ふつう', givens: 32 },
  hard: { label: 'むずかしい', givens: 26 },
  extreme: { label: 'ごくむず', givens: 0, note: '22〜24個（限界まで削る）' }, // 0 = 答えが1つのまま、消せるだけ消す
};

const ROW = [], COL = [], BOX = [];
for (let i = 0; i < 81; i++) { ROW[i] = Math.floor(i / 9); COL[i] = i % 9; BOX[i] = Math.floor(ROW[i] / 3) * 3 + Math.floor(COL[i] / 3); }
export const PEERS = Array.from({ length: 81 }, (_, i) => {
  const s = new Set();
  for (let j = 0; j < 81; j++) if (j !== i && (ROW[j] === ROW[i] || COL[j] === COL[i] || BOX[j] === BOX[i])) s.add(j);
  return [...s];
});
export { ROW, COL, BOX };

function shuffle(a, rand) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const bits = (m) => { const out = []; for (let d = 1; d <= 9; d++) if (m & (1 << d)) out.push(d); return out; };

// 解の数を数える（limit 個見つけたら打ち切り）。候補が一番少ないマスから試す
export function countSolutions(grid, limit = 2, rand = null, out = null) {
  const g = grid.slice();
  const rows = Array(9).fill(0), cols = Array(9).fill(0), boxes = Array(9).fill(0);
  for (let i = 0; i < 81; i++) if (g[i]) { const b = 1 << g[i]; if ((rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & b) return 0; rows[ROW[i]] |= b; cols[COL[i]] |= b; boxes[BOX[i]] |= b; }
  let count = 0;
  const rec = () => {
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const m = ~(rows[ROW[i]] | cols[COL[i]] | boxes[BOX[i]]) & 0x3fe;
      let n = 0; for (let x = m; x; x &= x - 1) n++;
      if (n < bestN) { best = i; bestMask = m; bestN = n; if (n <= 1) break; }
    }
    if (best < 0) { count++; if (out && !out.length) out.push(...g); return count >= limit; }
    if (!bestN) return false;
    const ds = bits(bestMask); if (rand) shuffle(ds, rand);
    for (const d of ds) {
      const b = 1 << d;
      g[best] = d; rows[ROW[best]] |= b; cols[COL[best]] |= b; boxes[BOX[best]] |= b;
      if (rec()) return true;
      g[best] = 0; rows[ROW[best]] &= ~b; cols[COL[best]] &= ~b; boxes[BOX[best]] &= ~b;
    }
    return false;
  };
  rec();
  return count;
}

// 「このマスはこれしか入らない」系の簡単な考え方（シングル）だけで解けるか
// 解ければ true。解けない＝候補を絞り込む・仮定する等のもっと難しい考え方が必要
export function singlesSolvable(puzzle) {
  const g = [...puzzle].map(Number);
  const cand = (i) => { let m = 0x3fe; for (const j of PEERS[i]) if (g[j]) m &= ~(1 << g[j]); return m; };
  const units = [];
  for (let k = 0; k < 9; k++) {
    units.push([...Array(81).keys()].filter((i) => ROW[i] === k));
    units.push([...Array(81).keys()].filter((i) => COL[i] === k));
    units.push([...Array(81).keys()].filter((i) => BOX[i] === k));
  }
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < 81; i++) { // 候補が1つだけのマス
      if (g[i]) continue;
      const m = cand(i);
      if (!m) return false;
      if ((m & (m - 1)) === 0) { g[i] = Math.log2(m); progress = true; }
    }
    for (const u of units) { // その数字が入れるマスが1つだけ
      for (let d = 1; d <= 9; d++) {
        if (u.some((i) => g[i] === d)) continue;
        const spots = u.filter((i) => !g[i] && cand(i) & (1 << d));
        if (spots.length === 1) { g[spots[0]] = d; progress = true; }
      }
    }
  }
  return g.every((v) => v);
}

// 問題を作る：ランダムな完成盤 → 答えが1つのまま、できるだけ穴をあける
export function makePuzzle(diff = 'normal', rand = Math.random) {
  if (diff === 'extreme') return makeExtreme(rand);
  return makeOne(diff, rand);
}
// ごくむず：限界まで削った問題をいくつか作り、シングルだけでは解けないもの・ヒントが少ないものを選ぶ
function makeExtreme(rand, tries = 24, budgetMs = 700) {
  const t0 = Date.now();
  let best = null, bestScore = -1;
  for (let k = 0; k < tries && (k < 3 || Date.now() - t0 < budgetMs); k++) {
    const p = makeOne('extreme', rand);
    const hardLogic = !singlesSolvable(p.puzzle);
    const score = (hardLogic ? 1000 : 0) + (81 - p.givens);
    if (score > bestScore) { best = { ...p, hardLogic }; bestScore = score; }
  }
  return best;
}
function makeOne(diff, rand) {
  const full = [];
  countSolutions(Array(81).fill(0), 1, rand, full);
  const target = DIFFS[diff]?.givens ?? 32;
  const g = full.slice();
  let givens = 81;
  for (const i of shuffle([...Array(81).keys()], rand)) {
    if (givens <= target) break;
    const keep = g[i]; g[i] = 0;
    if (countSolutions(g, 2) !== 1) g[i] = keep; else givens--;
  }
  return { puzzle: g.join(''), solution: full.join(''), givens };
}
