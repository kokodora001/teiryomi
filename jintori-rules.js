// =============================================================
//  同時陣取り — 盤面ルール（画面や通信に依存しない純粋なロジック）
//  盤は1マス1文字の文字列：'.' 空き / '#' 岩 / 'a'〜 プレイヤー（0番 = 'a'）
// =============================================================
export const EMPTY = '.', ROCK = '#';
export const ownerChar = (i) => String.fromCharCode(97 + i);
export const ownerOf = (ch) => (ch >= 'a' && ch <= 'z' ? ch.charCodeAt(0) - 97 : -1);

export function boardSize(players) { return players <= 2 ? 7 : players <= 4 ? 9 : 11; }

// スタート地点：四隅 → 辺の真ん中
export function startCells(n, players) {
  const m = n - 1, h = Math.floor(n / 2);
  const spots = {
    2: [[0, 0], [m, m]],
    3: [[0, 0], [0, m], [m, h]],
    4: [[0, 0], [0, m], [m, 0], [m, m]],
    5: [[0, 0], [0, m], [m, 0], [m, m], [h, h]],
    6: [[0, 0], [0, m], [m, 0], [m, m], [h, 0], [h, m]],
  }[players];
  return spots.map(([r, c]) => r * n + c);
}

export function neighbors(i, n) {
  const r = Math.floor(i / n), c = i % n, out = [];
  if (r > 0) out.push(i - n);
  if (r < n - 1) out.push(i + n);
  if (c > 0) out.push(i - 1);
  if (c < n - 1) out.push(i + 1);
  return out;
}

// 新しい盤面（★マスも配置）
export function newBoard(players, { stars = true, rand = Math.random } = {}) {
  const n = boardSize(players), b = Array(n * n).fill(EMPTY);
  const starts = startCells(n, players);
  starts.forEach((cell, i) => { b[cell] = ownerChar(i); });
  const starCells = [];
  if (stars) {
    const want = Math.round((n * n) / 14);
    const dist = (a, z) => Math.abs(Math.floor(a / n) - Math.floor(z / n)) + Math.abs((a % n) - (z % n));
    const pool = [];
    for (let i = 0; i < n * n; i++) if (b[i] === EMPTY && starts.every((s) => dist(i, s) >= 3)) pool.push(i);
    while (starCells.length < want && pool.length) {
      const k = Math.floor(rand() * pool.length), cell = pool.splice(k, 1)[0];
      if (starCells.every((s) => dist(s, cell) >= 2)) starCells.push(cell);
    }
  }
  return { n, board: b.join(''), stars: starCells.sort((a, z) => a - z) };
}

// プレイヤーiが選べるマス（自分の陣地に上下左右で接する空きマス）
export function validMoves(board, n, i) {
  const me = ownerChar(i), out = new Set();
  for (let k = 0; k < board.length; k++) {
    if (board[k] !== me) continue;
    for (const nb of neighbors(k, n)) if (board[nb] === EMPTY) out.add(nb);
  }
  return [...out].sort((a, z) => a - z);
}

// 1ターン分の解決
//   picks: { プレイヤー番号: マス }
//   返り値: 新しい盤面と、何が起きたか
export function resolveTurn(board, n, picks, { capture = true } = {}) {
  const b = board.split('');
  const byCell = {};
  for (const [i, cell] of Object.entries(picks)) {
    if (cell == null || b[cell] !== EMPTY) continue;
    (byCell[cell] ||= []).push(+i);
  }
  const claimed = [], rocks = [], collided = [];
  for (const [cell, who] of Object.entries(byCell)) {
    if (who.length === 1) { b[cell] = ownerChar(who[0]); claimed.push([+cell, who[0]]); }
    else { b[cell] = ROCK; rocks.push(+cell); collided.push(...who); }
  }
  // 囲い込み：空きマスのかたまりのうち、接しているプレイヤーが1人だけなら、まるごとその人のもの
  const captured = [];
  if (capture) {
    const seen = new Uint8Array(b.length);
    for (let s = 0; s < b.length; s++) {
      if (b[s] !== EMPTY || seen[s]) continue;
      const region = [], owners = new Set(), q = [s];
      seen[s] = 1;
      while (q.length) {
        const x = q.pop(); region.push(x);
        for (const nb of neighbors(x, n)) {
          if (b[nb] === EMPTY) { if (!seen[nb]) { seen[nb] = 1; q.push(nb); } }
          else if (b[nb] !== ROCK) owners.add(ownerOf(b[nb]));
        }
      }
      if (owners.size === 1) {
        const o = [...owners][0];
        for (const x of region) b[x] = ownerChar(o);
        captured.push({ owner: o, cells: region.sort((a, z) => a - z) });
      }
    }
  }
  return { board: b.join(''), claimed, rocks, collided, captured };
}

// 得点（陣地1マス=1点、★マスは3点）
export function scoreBoard(board, stars, players) {
  const s = Array(players).fill(0), starSet = new Set(stars || []);
  for (let k = 0; k < board.length; k++) {
    const o = ownerOf(board[k]);
    if (o >= 0 && o < players) s[o] += starSet.has(k) ? 3 : 1;
  }
  return s;
}
export function cellCounts(board, players) {
  const s = Array(players).fill(0);
  for (const ch of board) { const o = ownerOf(ch); if (o >= 0 && o < players) s[o]++; }
  return s;
}
export const anyoneCanMove = (board, n, players) => Array.from({ length: players }, (_, i) => i).some((i) => validMoves(board, n, i).length > 0);
