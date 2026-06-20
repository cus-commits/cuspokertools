// validate.js — validation harness for the PPT-style percent-range engine.
// Run: node validate.js
'use strict';

const PPT = require('./ppt-percent.js');
const RANKS = { '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, 'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12 };
function C(str) { return RANKS[str[0]] * 4 + 'cdhs'.indexOf(str[1]); }
function H(...cs) { return cs.map(C); }

// seedable rng so each "run" differs but is reproducible
function rng(seed) {
  let s = seed >>> 0; if (s === 0) s = 0x9e3779b9;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

console.log('=== Hold\'em: AA vs top 20% (x3 runs) ===');
const aa = H('Ah', 'As');
let hres = [];
for (let run = 0; run < 3; run++) {
  const r = PPT.equityVsPercent(aa, 0, 20, { game: 'holdem', trials: 150000, rng: rng(1000 + run) });
  hres.push(r.equity);
  console.log(`  run ${run + 1}: equity=${(r.equity * 100).toFixed(2)}%  trials=${r.trials}  oppRangeCombos=${r.opponentRangeCombos}`);
}
const hMean = hres.reduce((a, b) => a + b, 0) / 3;
const hSpread = (Math.max(...hres) - Math.min(...hres)) * 100;
console.log(`  mean=${(hMean * 100).toFixed(2)}%  spread=${hSpread.toFixed(2)}pp (stability)`);

console.log('\n=== Hold\'em: AA vs top 100% (≈ vs random, sanity) ===');
{
  const r = PPT.equityVsPercent(aa, 0, 100, { game: 'holdem', trials: 150000, rng: rng(42) });
  console.log(`  equity=${(r.equity * 100).toFixed(2)}%  (AA vs random ≈ 85.2%)  oppRangeCombos=${r.opponentRangeCombos} (expect 1326-6=1320 legal)`);
}

console.log('\n=== PLO: AAKQds (double-suited) vs top 20% Omaha (x3 runs) ===');
// AAKQ double-suited: A-K one suit, A-Q the other suit.
const aakqds = H('Ah', 'Kh', 'As', 'Qs');
let ores = [];
let oppCombos = 0;
for (let run = 0; run < 3; run++) {
  const r = PPT.equityVsPercent(aakqds, 0, 20, { game: 'omaha', trials: 150000, rng: rng(2000 + run) });
  ores.push(r.equity);
  oppCombos = r.opponentRangeCombos;
  console.log(`  run ${run + 1}: equity=${(r.equity * 100).toFixed(2)}%  trials=${r.trials}  oppRangeCombos=${r.opponentRangeCombos}`);
}
const oMean = ores.reduce((a, b) => a + b, 0) / 3;
const oSpread = (Math.max(...ores) - Math.min(...ores)) * 100;
console.log(`  mean=${(oMean * 100).toFixed(2)}%  spread=${oSpread.toFixed(2)}pp (stability)`);
console.log(`  opponentRangeCombos=${oppCombos} (expect ~54,145 = 20% of 270,725, NOT 384)`);

console.log('\n=== PLO: AAKQds vs top 100% (≈ vs random, sanity) ===');
{
  const r = PPT.equityVsPercent(aakqds, 0, 100, { game: 'omaha', trials: 150000, rng: rng(99) });
  console.log(`  equity=${(r.equity * 100).toFixed(2)}%  oppRangeCombos=${r.opponentRangeCombos} (expect ~270,621 legal)`);
}

console.log('\n=== Range band sizing check ===');
for (const [g, lo, hi] of [['holdem', 0, 20], ['holdem', 0, 100], ['omaha', 0, 20], ['omaha', 0, 100]]) {
  const pr = PPT.percentRange(g, lo, hi);
  console.log(`  ${g} top ${lo}-${hi}%: ${pr.classes.length} classes, ${pr.totalCombos} combos`);
}

console.log('\n=== Multi-opponent (2 opps from top 30%, holdem) ===');
{
  const r = PPT.equityVsPercent(aa, 0, 30, { game: 'holdem', trials: 100000, opponents: 2, rng: rng(7) });
  console.log(`  AA vs 2x top-30%: equity=${(r.equity * 100).toFixed(2)}%  oppRangeCombos=${r.opponentRangeCombos}`);
}
