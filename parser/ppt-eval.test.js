/*
 * ppt-eval.test.js
 *
 * Adversarial regression suite for ppt-eval.js. Cross-checks the packed-integer
 * evaluator against a fully INDEPENDENT category-tuple evaluator (lexicographic
 * comparison, no shared code) over random and exhaustive spots:
 *   - 5-card evaluate5: exhaustive category-boundary monotonicity + sampled
 *     pair-sign agreement over all C(52,5) hands.
 *   - eval7holdem: best-5-of-7 ordering vs independent over 60k random spots.
 *   - evalOmaha: 2-of-4 x 3-of-5 ordering + category vs independent over 60k spots.
 *   - Straight edge cases: wheel, broadway, no wraparound, straight-flush wheel.
 *   - Mirror ties: suit-isomorphic hands return EQUAL scores.
 *   - Omaha flush trap: 1 (or 4 with too-few board) hole cards of a suit must
 *     NOT make a flush.
 *
 * Run:  node ppt-eval.test.js
 */
'use strict';

const E = require('./ppt-eval.js');
const { evaluate5, eval7holdem, evalOmaha, detectStraight } = E;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

const RANKS = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
function C(s) { return RANKS[s[0]] * 4 + 'cdhs'.indexOf(s[1]); }
function H() { return Array.prototype.map.call(arguments, C); }
function pptCat(score) { return Math.floor(score / 1048576); }

// ---- Independent evaluator: returns a comparable array; bigger = better ----
function indEval5(cards) {
  const ranks = cards.map(c => c >> 2);
  const suits = cards.map(c => c & 3);
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.keys(cnt).map(Number).sort((a, b) => (cnt[b] - cnt[a]) || (b - a));
  const counts = groups.map(r => cnt[r]);
  const isFlush = suits.every(s => s === suits[0]);
  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  let sh = -1;
  if (uniq.length === 5) {
    if (uniq[4] - uniq[0] === 4) sh = uniq[4];
    else if (uniq[0] === 0 && uniq[1] === 1 && uniq[2] === 2 && uniq[3] === 3 && uniq[4] === 12) sh = 3; // wheel
  }
  const isS = sh >= 0;
  if (isS && isFlush) return [8, sh];
  if (counts[0] === 4) return [7, groups[0], groups[1]];
  if (counts[0] === 3 && counts[1] === 2) return [6, groups[0], groups[1]];
  if (isFlush) return [5, ...ranks.slice().sort((a, b) => b - a)];
  if (isS) return [4, sh];
  if (counts[0] === 3) return [3, groups[0], ...groups.slice(1).sort((a, b) => b - a)];
  if (counts[0] === 2 && counts[1] === 2) { const p = [groups[0], groups[1]].sort((a, b) => b - a); return [2, p[0], p[1], groups[2]]; }
  if (counts[0] === 2) return [1, groups[0], ...groups.slice(1).sort((a, b) => b - a)];
  return [0, ...ranks.slice().sort((a, b) => b - a)];
}
function cmpTuple(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
function combos(arr, k) {
  const res = [];
  (function rec(s, c) { if (c.length === k) { res.push(c.slice()); return; } for (let i = s; i < arr.length; i++) { c.push(arr[i]); rec(i + 1, c); c.pop(); } })(0, []);
  return res;
}
function indHoldem(hole, board) { const all = [...hole, ...board]; let best = null; for (const c of combos(all, 5)) { const t = indEval5(c); if (best === null || cmpTuple(t, best) > 0) best = t; } return best; }
function indOmaha(hole, board) { let best = null; for (const hc of combos(hole, 2)) for (const bc of combos(board, 3)) { const t = indEval5([...hc, ...bc]); if (best === null || cmpTuple(t, best) > 0) best = t; } return best; }
function dealDistinct(n, ex) { const s = new Set(ex || []); const o = []; while (o.length < n) { const c = Math.floor(Math.random() * 52); if (s.has(c)) continue; s.add(c); o.push(c); } return o; }

// ---- 1. evaluate5 category-boundary monotonicity (exhaustive) ----
{
  const all = []; for (let i = 0; i < 52; i++) all.push(i);
  const five = combos(all, 5);
  const catMin = new Array(9).fill(Infinity), catMax = new Array(9).fill(-Infinity);
  let pairBad = 0;
  // store scores + ind tuples to sample pairs without recompute
  const scores = new Float64Array(five.length);
  const tuples = new Array(five.length);
  for (let i = 0; i < five.length; i++) {
    const s = evaluate5(five[i]); scores[i] = s;
    const t = indEval5(five[i]); tuples[i] = t;
    const cat = t[0];
    if (s < catMin[cat]) catMin[cat] = s;
    if (s > catMax[cat]) catMax[cat] = s;
  }
  let boundaryOk = true;
  for (let c = 1; c < 9; c++) if (catMin[c] <= catMax[c - 1]) boundaryOk = false;
  ok('evaluate5 category boundaries strictly monotonic', boundaryOk);
  // sampled pair-sign agreement (1M pairs), comparing tuples directly (lossless)
  for (let k = 0; k < 1000000; k++) {
    const a = (Math.random() * five.length) | 0, b = (Math.random() * five.length) | 0;
    const ps = scores[a] < scores[b] ? -1 : (scores[a] > scores[b] ? 1 : 0);
    const is = cmpTuple(tuples[a], tuples[b]);
    if (ps !== is) pairBad++;
  }
  ok('evaluate5 pair-sign agrees with independent (1M pairs)', pairBad === 0, 'mismatches=' + pairBad);
}

// ---- 2. eval7holdem ordering vs independent (60k random spots) ----
{
  let bad = 0, catBad = 0;
  for (let i = 0; i < 60000; i++) {
    const cards = dealDistinct(9);
    const hA = cards.slice(0, 2), hB = cards.slice(2, 4), board = cards.slice(4, 9);
    const pa = eval7holdem(hA, board), pb = eval7holdem(hB, board);
    const ta = indHoldem(hA, board), tb = indHoldem(hB, board);
    const ps = pa < pb ? -1 : (pa > pb ? 1 : 0);
    if (ps !== cmpTuple(ta, tb)) bad++;
    if (pptCat(pa) !== ta[0]) catBad++;
  }
  ok('eval7holdem ordering matches independent (60k spots)', bad === 0, 'mismatches=' + bad);
  ok('eval7holdem category matches independent (60k spots)', catBad === 0, 'catMismatch=' + catBad);
}

// ---- 3. evalOmaha 2-of-4 x 3-of-5 ordering vs independent (60k spots) ----
{
  let bad = 0, catBad = 0;
  for (let i = 0; i < 60000; i++) {
    const cards = dealDistinct(13);
    const hA = cards.slice(0, 4), hB = cards.slice(4, 8), board = cards.slice(8, 13);
    const pa = evalOmaha(hA, board), pb = evalOmaha(hB, board);
    const ta = indOmaha(hA, board), tb = indOmaha(hB, board);
    const ps = pa < pb ? -1 : (pa > pb ? 1 : 0);
    if (ps !== cmpTuple(ta, tb)) bad++;
    if (pptCat(pa) !== ta[0]) catBad++;
  }
  ok('evalOmaha ordering matches independent (60k spots)', bad === 0, 'mismatches=' + bad);
  ok('evalOmaha category matches independent (60k spots)', catBad === 0, 'catMismatch=' + catBad);
}

// ---- 4. Straight edge cases ----
ok('detectStraight wheel A2345 -> 3', detectStraight(0x100F) === 3);
ok('detectStraight broadway -> 12', detectStraight((1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 12)) === 12);
ok('detectStraight QKA23 wraparound -> -1', detectStraight((1 << 10) | (1 << 11) | (1 << 12) | (1 << 0) | (1 << 1)) === -1);
ok('straight-flush wheel is category 8', pptCat(evaluate5(H('Ac', '2c', '3c', '4c', '5c'))) === 8);
ok('wheel straight (mixed suits) is category 4', pptCat(evaluate5(H('Ac', '2d', '3h', '4s', '5c'))) === 4);
ok('broadway SF beats wheel SF', evaluate5(H('Tc', 'Jc', 'Qc', 'Kc', 'Ac')) > evaluate5(H('Ac', '2c', '3c', '4c', '5c')));

// ---- 5. Mirror ties: suit-isomorphic 5-card hands have EQUAL score ----
{
  let tieFail = 0;
  for (let i = 0; i < 50000; i++) {
    const cards = dealDistinct(5);
    const mir = cards.map(c => ((c >> 2) << 2) | ((c & 3) ^ 1)); // swap suit bit -> same ranks, valid distinct cards
    if (evaluate5(cards) !== evaluate5(mir)) tieFail++;
  }
  ok('mirror (suit-isomorphic) hands return equal scores (50k)', tieFail === 0, 'tieFail=' + tieFail);
}

// ---- 6. Omaha flush trap: must use exactly 2 hole cards ----
ok('omaha: 1 hole heart + 4 board hearts is NOT a flush',
  pptCat(evalOmaha(H('Ah', 'Td', 'Tc', 'Ts'), H('2h', '7h', '9h', 'Jh', 'Kc'))) < 5);
ok('omaha: 4 hole hearts but only 2 board hearts is NOT a flush',
  pptCat(evalOmaha(H('Ah', 'Qh', 'Th', '3h'), H('2h', '7h', '9c', 'Jc', 'Kc'))) < 5);
ok('omaha: 2 hole hearts + 3 board hearts IS a flush',
  pptCat(evalOmaha(H('Ah', 'Qh', 'Tc', 'Ts'), H('2h', '7h', '9h', 'Js', 'Kc'))) >= 5);

console.log('\nppt-eval.test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
