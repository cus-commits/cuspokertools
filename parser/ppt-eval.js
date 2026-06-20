// [wrapped in IIFE for safe classic-script loading in the browser:
//  prevents top-level decls (RANKS/SUITS/parseRange/API/etc.) from
//  leaking to the global scope and colliding with the app or each other.
//  module.exports and window.X assignments still work inside the IIFE.]
;(function(){
// ppt-eval.js
// Self-contained poker hand evaluator ported VERBATIM from the validated
// Web Worker engine in ../index.html (WORKER_CODE: evaluate5, bestHoldemHand,
// bestOmahaHand). Card model: index 0..51, rank = idx >> 2 (0=2 .. 12=A),
// suit = idx & 3. A 5-card hand "score" is a single integer; higher is better.
//
// Exposes: eval7holdem(hole2, board5) -> score
//          evalOmaha(hole4, board5)  -> score  (exactly 2 of 4 hole + 3 of 5 board)
//          compareHoldem / compareOmaha / showdown helpers
//
// NOTE: we deliberately do NOT use node_modules/poker-odds-calc for Omaha —
// its Omaha evaluator misses straights. This is the index.html evaluator.

'use strict';

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
}

function detectStraight(bits) {
  for (let top = 12; top >= 4; top--) {
    const mask = 0x1F << (top - 4);
    if ((bits & mask) === mask) return top;
  }
  // wheel: A-2-3-4-5  (A=12, then 0,1,2,3) -> bits 0x100F, straight high = 3 (the 5)
  if ((bits & 0x100F) === 0x100F) return 3;
  return -1;
}

function evaluate5(ci) {
  let rankBits = 0;
  const suitBits = [0, 0, 0, 0];
  const rc = new Int32Array(13);
  for (let i = 0; i < 5; i++) {
    const c = ci[i];
    const rank = (c >> 2);
    const suit = c & 3;
    rankBits |= (1 << rank);
    suitBits[suit] |= (1 << rank);
    rc[rank]++;
  }
  let flushBits = 0;
  for (let s = 0; s < 4; s++) {
    if (popcount(suitBits[s]) === 5) { flushBits = suitBits[s]; break; }
  }
  const isFlush = flushBits !== 0;
  const straightHigh = detectStraight(rankBits);
  const isStraight = straightHigh >= 0;
  if (isFlush && isStraight) {
    const sfHigh = detectStraight(flushBits);
    if (sfHigh >= 0) return 8 * 1048576 + sfHigh;
  }
  let quadRank = -1, tripRank = -1, pair1 = -1, pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    if (rc[r] === 4) quadRank = r;
    else if (rc[r] === 3) tripRank = r;
    else if (rc[r] === 2) { if (pair1 < 0) pair1 = r; else pair2 = r; }
  }
  if (quadRank >= 0) {
    let kicker = 0;
    for (let r = 12; r >= 0; r--) { if (rc[r] > 0 && r !== quadRank) { kicker = r; break; } }
    return 7 * 1048576 + quadRank * 16 + kicker;
  }
  if (tripRank >= 0 && pair1 >= 0) return 6 * 1048576 + tripRank * 16 + pair1;
  if (isFlush) {
    let score = 5 * 1048576, shift = 16, fb = flushBits;
    for (let counted = 0; counted < 5; counted++) {
      const hi = 31 - Math.clz32(fb);
      score += hi << shift; fb ^= (1 << hi); shift -= 4;
    }
    return score;
  }
  if (isStraight) return 4 * 1048576 + straightHigh;
  if (tripRank >= 0) {
    let k1 = -1, k2 = -1;
    for (let r = 12; r >= 0; r--) { if (rc[r] > 0 && r !== tripRank) { if (k1 < 0) k1 = r; else if (k2 < 0) k2 = r; } }
    return 3 * 1048576 + tripRank * 256 + k1 * 16 + k2;
  }
  if (pair1 >= 0 && pair2 >= 0) {
    let kicker = 0;
    for (let r = 12; r >= 0; r--) { if (rc[r] > 0 && r !== pair1 && r !== pair2) { kicker = r; break; } }
    return 2 * 1048576 + pair1 * 256 + pair2 * 16 + kicker;
  }
  if (pair1 >= 0) {
    let k1 = -1, k2 = -1, k3 = -1;
    for (let r = 12; r >= 0; r--) { if (rc[r] > 0 && r !== pair1) { if (k1 < 0) k1 = r; else if (k2 < 0) k2 = r; else if (k3 < 0) k3 = r; } }
    return 1 * 1048576 + pair1 * 4096 + k1 * 256 + k2 * 16 + k3;
  }
  let score = 0, shift = 16;
  for (let r = 12; r >= 0; r--) { if (rc[r] > 0) { score += r << shift; shift -= 4; } }
  return score;
}

const COMBO_7_5 = (function () {
  const r = [];
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 5; c++)
    for (let d = c + 1; d < 6; d++) for (let e = d + 1; e < 7; e++) r.push([a, b, c, d, e]);
  return r;
})();
const COMBO_4_2 = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const COMBO_5_3 = (function () {
  const r = [];
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 5; c++) r.push([a, b, c]);
  return r;
})();

// hole = 2 indices, board = 5 indices. Best 5 of 7.
function eval7holdem(hole, board) {
  const all7 = [hole[0], hole[1], board[0], board[1], board[2], board[3], board[4]];
  let best = -1;
  const h5 = [0, 0, 0, 0, 0];
  for (let ci = 0; ci < 21; ci++) {
    const idx = COMBO_7_5[ci];
    h5[0] = all7[idx[0]]; h5[1] = all7[idx[1]]; h5[2] = all7[idx[2]];
    h5[3] = all7[idx[3]]; h5[4] = all7[idx[4]];
    const s = evaluate5(h5);
    if (s > best) best = s;
  }
  return best;
}

// hole = 4 indices, board = 5 indices. EXACTLY 2 of 4 hole + 3 of 5 board.
function evalOmaha(hole, board) {
  let best = -1;
  const h5 = [0, 0, 0, 0, 0];
  for (let hi = 0; hi < 6; hi++) {
    const hc = COMBO_4_2[hi];
    h5[0] = hole[hc[0]]; h5[1] = hole[hc[1]];
    for (let bi = 0; bi < 10; bi++) {
      const bc = COMBO_5_3[bi];
      h5[2] = board[bc[0]]; h5[3] = board[bc[1]]; h5[4] = board[bc[2]];
      const s = evaluate5(h5);
      if (s > best) best = s;
    }
  }
  return best;
}

// Showdown helper: scores already computed -> returns equity share for index 0
// given an array of scores. (Generic.)
function equityFromScores(scores, heroIndex) {
  let maxScore = scores[0];
  for (let i = 1; i < scores.length; i++) if (scores[i] > maxScore) maxScore = scores[i];
  let winners = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] === maxScore) winners++;
  if (scores[heroIndex] !== maxScore) return 0;
  return 1 / winners;
}

// compare two holdem hands on a board: +1 hero wins, 0 tie, -1 villain wins
function compareHoldem(heroHole, villainHole, board) {
  const a = eval7holdem(heroHole, board);
  const b = eval7holdem(villainHole, board);
  return a > b ? 1 : (a < b ? -1 : 0);
}
function compareOmaha(heroHole, villainHole, board) {
  const a = evalOmaha(heroHole, board);
  const b = evalOmaha(villainHole, board);
  return a > b ? 1 : (a < b ? -1 : 0);
}

var PPTEvalAPI = {
  evaluate5,
  eval7holdem,
  evalOmaha,
  equityFromScores,
  compareHoldem,
  compareOmaha,
  popcount,
  detectStraight,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PPTEvalAPI;
}
if (typeof window !== 'undefined') {
  window.PPTEval = PPTEvalAPI;
}

// ---------------------------------------------------------------------------
// Self-test (run with: node ppt-eval.js)
// ---------------------------------------------------------------------------
if (typeof require !== 'undefined' && require.main === module) {
  // card(rankChar, suitIdx): rank 0=2..12=A. idx = rank*4 + suit.
  const RANKS = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
  function C(str) { return RANKS[str[0]] * 4 + 'cdhs'.indexOf(str[1]); }
  function H(...cs) { return cs.map(C); }

  let pass = 0, fail = 0;
  function check(name, cond) { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name); } }

  // 1. Straight beats trips (board makes hero a straight, villain trips)
  {
    const board = H('5c', '6d', '7h', '8s', 'Tc');
    const hero = H('9c', '2d');      // 5-6-7-8-9 straight
    const villain = H('Th', 'Td');   // trip tens
    check('straight beats trips', eval7holdem(hero, board) > eval7holdem(villain, board));
  }

  // 2. Nut flush beats lower flush
  {
    const board = H('2h', '7h', '9h', 'Js', 'Kc');
    const hero = H('Ah', 'Th');      // A-high heart flush
    const villain = H('Qh', '3h');   // Q-high heart flush
    check('nut flush beats lower flush', eval7holdem(hero, board) > eval7holdem(villain, board));
  }

  // 3. Wheel straight is recognized (A-2-3-4-5)
  {
    const board = H('Ac', '2d', '3h', '4s', 'Kc');
    const hero = H('5c', '8d');      // makes A-2-3-4-5 wheel
    const villain = H('Ah', 'Qd');   // pair of aces
    check('wheel straight recognized', eval7holdem(hero, board) > eval7holdem(villain, board));
  }

  // 4. Omaha must use exactly 2 hole cards: a single A in hand does NOT
  //    complete a flush with 4 board hearts.
  {
    const board = H('2h', '7h', '9h', 'Jh', 'Kc'); // 4 hearts on board
    const hero = H('Ah', 'Td', 'Tc', 'Ts');         // only ONE heart in hand
    // Hero CANNOT make a heart flush (needs 2 hole hearts). Best is trips/two pair.
    const score = evalOmaha(hero, board);
    check('omaha 2-card rule (no flush from 1 hole heart)', score < 5 * 1048576);
    const heroFlush = H('Ah', 'Qh', 'Tc', 'Ts');     // TWO hole hearts -> nut flush
    check('omaha flush with 2 hole hearts', evalOmaha(heroFlush, board) >= 5 * 1048576);
  }

  // 5. Quick Monte Carlo: AA vs KK preflop heads-up should be ~81-82%.
  {
    const hero = H('Ah', 'As');
    const villain = H('Kh', 'Ks');
    const dead = new Set([...hero, ...villain]);
    const deck = [];
    for (let i = 0; i < 52; i++) if (!dead.has(i)) deck.push(i);
    let heroEq = 0;
    const N = 60000;
    for (let t = 0; t < N; t++) {
      // Fisher-Yates partial shuffle for 5 board cards
      const d = deck.slice();
      for (let k = 0; k < 5; k++) {
        const j = k + Math.floor(Math.random() * (d.length - k));
        const tmp = d[k]; d[k] = d[j]; d[j] = tmp;
      }
      const board = [d[0], d[1], d[2], d[3], d[4]];
      const sh = eval7holdem(hero, board);
      const sv = eval7holdem(villain, board);
      heroEq += sh > sv ? 1 : (sh === sv ? 0.5 : 0);
    }
    const eq = heroEq / N;
    check('AA vs KK ~81-82% (got ' + (eq * 100).toFixed(1) + '%)', eq > 0.80 && eq < 0.835);
    console.log('  AA vs KK heads-up equity:', (eq * 100).toFixed(2) + '%');
  }

  console.log(`\nppt-eval self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

})();
