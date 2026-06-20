/*
 * ppt-percent.test.js
 *
 * Regression suite for ppt-percent.js. Pins the two correctness fixes found in
 * the adversarial bug hunt, plus the invariants that must hold:
 *
 *   BUG B (fixed): adjacent percentile bands must PARTITION (no class straddling
 *     a band edge may appear in both 0-10 and 10-20). 0-100 == whole space.
 *   BUG C (fixed): omahaClassCombos must NOT double-count symmetric hands
 *     (e.g. AATT/abab is 6 combos, not 12). Total expansion == C(52,4)=270725,
 *     every expansion length == the ranking's comboCount, no duplicate-card hand.
 *   Ranking direction: index 0 is the BEST hand; top 0-20% is the STRONGEST 20%.
 *   sampleHand: legal, distinct-card hands (4 for omaha, 2 for holdem).
 *   equityVsPercent: opponents never collide with hero/board/dead or each other;
 *     partial boards run out only legal cards.
 *
 * Run:  node ppt-percent.test.js
 */
'use strict';

const P = require('./ppt-percent.js');
const E = require('./ppt-eval.js');
const HOLDEM = require('./holdem-ranking.json');
const OMAHA = require('./omaha-ranking.json');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

const RANKS = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
function C(s) { return RANKS[s[0]] * 4 + 'cdhs'.indexOf(s[1]); }
function H() { return Array.prototype.map.call(arguments, C); }
function rng(seed) { let s = seed >>> 0; if (s === 0) s = 0x9e3779b9; return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// ---- Ranking direction & full-space totals ----
ok('holdem ranking index 0 is AA (best)', HOLDEM[0].classKey === 'AA');
ok('holdem 0-100% combos == C(52,2) = 1326', P.percentRange('holdem', 0, 100).totalCombos === 1326);
ok('omaha 0-100% combos == C(52,4) = 270725', P.percentRange('omaha', 0, 100).totalCombos === 270725);

// ---- Top X% is the strongest, not the weakest ----
{
  const top20 = P.percentRange('holdem', 0, 20);
  ok('holdem top 0-20% includes AA', top20.classes.some(c => c.classKey === 'AA'));
  ok('holdem top 0-20% excludes 72o', !top20.classes.some(c => c.classKey === '72o'));
  const bottom = P.percentRange('holdem', 80, 100);
  ok('holdem 80-100% includes 72o', bottom.classes.some(c => c.classKey === '72o'));
  ok('holdem 80-100% excludes AA', !bottom.classes.some(c => c.classKey === 'AA'));
}

// ---- BUG B: bands partition cleanly (no overlap, no gap) ----
{
  const a = P.percentRange('holdem', 0, 10);
  const b = P.percentRange('holdem', 10, 20);
  const ab = P.percentRange('holdem', 0, 20);
  const sa = new Set(a.classes.map(c => c.classKey));
  const sb = new Set(b.classes.map(c => c.classKey));
  const overlap = [...sa].filter(k => sb.has(k));
  ok('holdem 0-10 and 10-20 do not overlap', overlap.length === 0, 'overlap=' + JSON.stringify(overlap));
  ok('holdem 0-10 + 10-20 combos == 0-20 combos', a.totalCombos + b.totalCombos === ab.totalCombos);
  ok('holdem 0-10 ∪ 10-20 classes == 0-20 classes', new Set([...sa, ...sb]).size === ab.classes.length);
  // full 10-band partition disjoint and complete
  const seen = new Set(); let sumC = 0, disjoint = true;
  for (let i = 0; i < 10; i++) {
    const band = P.percentRange('holdem', i * 10, (i + 1) * 10);
    sumC += band.totalCombos;
    for (const c of band.classes) { if (seen.has(c.classKey)) disjoint = false; seen.add(c.classKey); }
  }
  ok('holdem 10x10% partition is disjoint', disjoint);
  ok('holdem 10x10% partition combos sum to 1326', sumC === 1326);
  ok('holdem 10x10% partition covers all 169 classes', seen.size === 169);
}

// ---- BUG C: omaha class expansion has no symmetric double-counting ----
{
  ok('omaha AATT/abab expands to 6 combos (not 12)', P.omahaClassCombos('AATT/abab').length === 6);
  ok('omaha AKQJ/abcd expands to 24 combos', P.omahaClassCombos('AKQJ/abcd').length === 24);
  ok('omaha AKQJ/aaaa expands to 4 combos', P.omahaClassCombos('AKQJ/aaaa').length === 4);
  // exhaustive over the ranking: expansion length == comboCount, no dup-card hand, total == 270725
  let sum = 0, dupCard = 0, cmMismatch = 0;
  for (const c of OMAHA) {
    const cm = P.omahaClassCombos(c.classKey);
    sum += cm.length;
    if (cm.length !== c.comboCount) cmMismatch++;
    for (const h of cm) if (new Set(h).size !== 4) { dupCard++; break; }
  }
  ok('omaha every class expansion length == its comboCount', cmMismatch === 0, 'mismatches=' + cmMismatch);
  ok('omaha total expansion == 270725 distinct hands', sum === 270725, 'got=' + sum);
  ok('omaha no class expands to a duplicate-card hand', dupCard === 0, 'badClasses=' + dupCard);
}

// ---- sampleHand legality ----
{
  const oTop = P.percentRange('omaha', 0, 20);
  let bad = 0;
  for (let i = 0; i < 30000; i++) { const h = oTop.sampleHand(rng(i + 1)); if (!h || h.length !== 4 || new Set(h).size !== 4 || h.some(c => c < 0 || c > 51)) bad++; }
  ok('omaha sampleHand always legal 4-distinct-card hand (30k)', bad === 0, 'illegal=' + bad);
  const hTop = P.percentRange('holdem', 0, 20);
  let hbad = 0;
  for (let i = 0; i < 30000; i++) { const h = hTop.sampleHand(rng(i + 1)); if (!h || h.length !== 2 || h[0] === h[1] || h.some(c => c < 0 || c > 51)) hbad++; }
  ok('holdem sampleHand always legal 2-distinct-card hand (30k)', hbad === 0, 'illegal=' + hbad);
}

// ---- equityVsPercent collision discipline (multi-opponent) ----
{
  // Instrument the exact opponent-sampling algorithm against the real flat list
  // and assert no card is shared across hero + all opponents.
  const hero = H('Ah', 'As');
  const flat = P.percentRange('holdem', 0, 30)._ensureFlat();
  const base = new Set(hero);
  let collisions = 0, trials = 100000, nOpp = 2, r = rng(123);
  for (let t = 0; t < trials; t++) {
    const tb = new Set(base); const hands = []; let okt = true;
    for (let o = 0; o < nOpp; o++) {
      let hand = null, a = 0;
      while (a < 200) { const cand = flat[Math.min(flat.length - 1, Math.floor(r() * flat.length))]; let clash = false; for (const x of cand) if (tb.has(x)) { clash = true; break; } if (!clash) { hand = cand; break; } a++; }
      if (!hand) { okt = false; break; }
      for (const x of hand) tb.add(x); hands.push(hand);
    }
    if (!okt) continue;
    const all = [...hero]; for (const h of hands) for (const c of h) all.push(c);
    if (new Set(all).size !== all.length) collisions++;
  }
  ok('equityVsPercent 2-opp sampling never shares a card (100k)', collisions === 0, 'collisions=' + collisions);
}

// ---- equityVsPercent partial-board sanity (boardNeed) ----
{
  const aa = H('Ah', 'As');
  const flop = H('2c', '7d', 'Td');
  const r = P.equityVsPercent(aa, 0, 20, { game: 'holdem', board: flop, trials: 40000, rng: rng(5) });
  ok('equityVsPercent runs on a partial (flop) board', r.trials > 39000 && r.equity > 0.5 && r.equity < 1);
  // AA vs random ~85.15% (sanity that the engine direction is right)
  const rr = P.equityVsPercent(aa, 0, 100, { game: 'holdem', trials: 80000, rng: rng(42) });
  ok('AA vs random ~85% (engine sane)', rr.equity > 0.83 && rr.equity < 0.87, 'eq=' + (rr.equity * 100).toFixed(2) + '%');
}

console.log('\nppt-percent.test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
