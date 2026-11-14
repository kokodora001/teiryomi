// =============================================================
//  お絵描きゲーム共通の部品
//  ・絵のエンコード／描画
//  ・ペン・色・太さのツールバー
//  ・列の振り分け（毎回ランダム、ただし同じ列に同じ人は二度入らない）
// =============================================================
import { shuffle } from './common.js';

export const PAPER = '#fffdf6';
export const PEN_COLORS = ['#1b1630', '#e8384f', '#f08c00', '#f2c200', '#2f9e44', '#1c7ed6', '#9c36b5', '#8d5524', '#9aa0a6', PAPER];
export const ERASER = PEN_COLORS.length - 1;
export const PEN_WIDTHS = [0.007, 0.015, 0.03, 0.06];
export const MAX_STROKES = 400;
const RES = 1295;

// ---------- 絵のエンコード（1点4文字、線は「|」区切り） ----------
const c2 = (v) => Math.round(Math.max(0, Math.min(1, v)) * RES).toString(36).padStart(2, '0');
const encPts = (pts) => pts.map(([x, y]) => c2(x) + c2(y)).join('');
function decPts(s) {
  const out = [];
  for (let i = 0; i + 4 <= s.length; i += 4) out.push([parseInt(s.slice(i, i + 2), 36) / RES, parseInt(s.slice(i + 2, i + 4), 36) / RES]);
  return out;
}
export const encDrawing = (strokes) => strokes.map((st) => `${st.c}${st.w}${encPts(st.pts)}`).join('|');
export const decDrawing = (s) => (s ? s.split('|').filter((x) => x.length >= 6).map((x) => ({ c: +x[0], w: +x[1], pts: decPts(x.slice(2)) })) : []);

export function paint(canvas, strokes) {
  if (!canvas) return;
  const w = canvas.clientWidth; if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3), px = Math.round(w * dpr);
  if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, w);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const st of strokes) {
    const pts = st.pts; if (!pts.length) continue;
    const lw = Math.max(1.5, w * PEN_WIDTHS[st.w]);
    ctx.strokeStyle = PEN_COLORS[st.c] || '#000'; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = lw;
    if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0] * w, pts[0][1] * w, lw / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.beginPath(); ctx.moveTo(pts[0][0] * w, pts[0][1] * w);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * w, mx * w, my * w);
    }
    const l = pts[pts.length - 1]; ctx.lineTo(l[0] * w, l[1] * w); ctx.stroke();
  }
}

// ---------- ツールバー ----------
export function toolsHTML(p) {
  return `<div class="palette">${PEN_COLORS.map((col, i) => `<button class="sw ${p.color === i ? 'on' : ''} ${i === ERASER ? 'eraser' : ''}" data-action="color" data-i="${i}" style="--sw:${col}" aria-label="${i === ERASER ? '消しゴム' : '色' + (i + 1)}">${i === ERASER ? '🧽' : ''}</button>`).join('')}</div>
    <div class="tool-row">
      <div class="widths">${PEN_WIDTHS.map((w, i) => `<button class="wd ${p.width === i ? 'on' : ''}" data-action="width" data-i="${i}" aria-label="太さ${i + 1}"><i style="--d:${4 + i * 5}px;--sw:${p.color === ERASER ? '#bbb' : PEN_COLORS[p.color]}"></i></button>`).join('')}</div>
      <button class="btn small" data-action="undo" ${p.strokes.length ? '' : 'disabled'}>↩ 戻す</button>
      <button class="btn small" data-action="clear" ${p.strokes.length ? '' : 'disabled'}>🗑 全消し</button>
    </div>`;
}

// ---------- 列の振り分け ----------
// n人・steps段ぶんの担当表を作る。rows[k][c] = 段kで列cを担当する人の番号。
// ・段0は列の持ち主（rows[0][c] = c）
// ・各段で全員がちょうど1列ずつ担当する
// ・同じ列に同じ人は二度入らない（自分のお題・一度描いた列は回ってこない）
// ・それ以外は毎回ランダム
// steps ≤ n なら必ず作れる（ラテン方陣の性質）。二部マッチングをランダム順で解く。
export function buildAssign(n, steps) {
  const rows = [[...Array(n).keys()]];
  for (let k = 1; k < steps; k++) {
    const used = Array.from({ length: n }, (_, c) => new Set(rows.map((r) => r[c])));
    const owner = Array(n).fill(-1); // 人 → 列
    const tryChain = (c, seen) => {
      for (const p of shuffle([...Array(n).keys()])) {
        if (used[c].has(p) || seen.has(p)) continue;
        seen.add(p);
        if (owner[p] < 0 || tryChain(owner[p], seen)) { owner[p] = c; return true; }
      }
      return false;
    };
    for (const c of shuffle([...Array(n).keys()])) if (!tryChain(c, new Set())) throw new Error('振り分けに失敗しました');
    const row = Array(n);
    owner.forEach((c, p) => { row[c] = p; });
    rows.push(row);
  }
  return rows;
}
