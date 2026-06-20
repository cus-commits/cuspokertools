// build-rankings.js
// OFFLINE precompute: rank every starting hand by hot-and-cold equity vs ONE
// random opponent over a full 5-card board runout (Monte Carlo). This ranking
// DEFINES "top X%" the ProPokerTools way.
//
//   Hold'em: 169 canonical classes (pairs / suited / offsuit). High trial count
//            for effectively-exact ordering.
//   Omaha:   16,432 canonical 4-card classes under suit isomorphism. Each class
//            is reduced to (rank-multiset + suit-pattern). Equity vs random is
//            computed per class; classes are combo-weighted so percentiles are
//            combo-weighted over the full C(52,4)=270,725 space.
//
// Outputs (sorted best -> worst):
//   holdem-ranking.json  = [{classKey, equityVsRandom, comboCount}, ...]
//   omaha-ranking.json   = [{classKey, equityVsRandom, comboCount}, ...]
//
// Run:  node build-rankings.js
//
// classKey formats (parsed by ppt-percent.js):
//   Hold'em: "AKs" / "AKo" / "TT"  (rank chars high->low + s/o, pairs no suffix)
//   Omaha:   "<r0><r1><r2><r3>/<suitPattern>" where ranks are sorted high->low
//            chars and suitPattern is a 4-char canonical string over {a,b,c,d}
//            assigned in first-appearance order (e.g. "AKQJ/aabc" = A,K share a
//            suit; Q,J each their own). This canonical form is isomorphism-unique.

'use strict';

const fs = require('fs');
const path = require('path');
const { eval7holdem, evalOmaha } = require('./ppt-eval.js');

const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
// rank index: 0=2 .. 12=A.  card index = rank*4 + suit.

// ---------------------------------------------------------------------------
// Fast xorshift RNG (deterministic seed -> reproducible rankings)
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// ===========================================================================
// HOLD'EM
// ===========================================================================

// 169 canonical classes. For each we pick ONE concrete representative pair of
// card indices and run MC vs a random opponent.
function holdemClasses() {
  const classes = [];
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = 12; lo >= 0; lo--) {
      if (lo > hi) continue;
      if (hi === lo) {
        // pair
        classes.push({ classKey: RANK_CHARS[hi] + RANK_CHARS[hi], hi, lo, suited: false, isPair: true });
      }
    }
  }
  for (let hi = 12; hi >= 0; hi--) {
    for (let lo = hi - 1; lo >= 0; lo--) {
      classes.push({ classKey: RANK_CHARS[hi] + RANK_CHARS[lo] + 's', hi, lo, suited: true, isPair: false });
      classes.push({ classKey: RANK_CHARS[hi] + RANK_CHARS[lo] + 'o', hi, lo, suited: false, isPair: false });
    }
  }
  return classes;
}

// concrete representative cards for a holdem class
function holdemRep(cls) {
  if (cls.isPair) return [cls.hi * 4 + 0, cls.hi * 4 + 1];
  if (cls.suited) return [cls.hi * 4 + 0, cls.lo * 4 + 0];
  return [cls.hi * 4 + 0, cls.lo * 4 + 1];
}

// number of concrete combos a holdem class represents (out of 1326)
function holdemComboCount(cls) {
  if (cls.isPair) return 6;
  if (cls.suited) return 4;
  return 12;
}

function rankHoldem(trials, seed) {
  const classes = holdemClasses();
  const rng = makeRng(seed);
  const out = [];
  let done = 0;
  for (const cls of classes) {
    const hero = holdemRep(cls);
    const heroSet = new Set(hero);
    // build deck excluding hero
    const deck = [];
    for (let i = 0; i < 52; i++) if (!heroSet.has(i)) deck.push(i);
    let eq = 0;
    for (let t = 0; t < trials; t++) {
      // partial Fisher-Yates: need 2 villain cards + 5 board = 7 cards
      const d = deck;
      for (let k = 0; k < 7; k++) {
        const j = k + Math.floor(rng() * (d.length - k));
        const tmp = d[k]; d[k] = d[j]; d[j] = tmp;
      }
      const villain = [d[0], d[1]];
      const board = [d[2], d[3], d[4], d[5], d[6]];
      const sh = eval7holdem(hero, board);
      const sv = eval7holdem(villain, board);
      eq += sh > sv ? 1 : (sh === sv ? 0.5 : 0);
    }
    out.push({ classKey: cls.classKey, equityVsRandom: eq / trials, comboCount: holdemComboCount(cls) });
    done++;
    if (done % 40 === 0) process.stdout.write(`  holdem ${done}/${classes.length}\r`);
  }
  out.sort((a, b) => b.equityVsRandom - a.equityVsRandom);
  console.log(`\n  holdem: ranked ${out.length} classes`);
  return out;
}

// ===========================================================================
// OMAHA — canonical 4-card class enumeration under suit isomorphism
// ===========================================================================
//
// A class = (sorted rank multiset of 4 ranks, canonical suit pattern).
// We enumerate by walking all C(52,4) combos? No — too slow to dedup naively.
// Instead enumerate directly:
//   - rank multiset: all combinations-with-replacement of 4 ranks from 13,
//     but a rank can appear at most 4 times (4 suits).
//   - for each rank multiset, enumerate the legal suit assignments and reduce
//     to a canonical suit-pattern (first-appearance relabel) + a "valid" check
//     (two cards with the same rank cannot share a suit).
//
// The comboCount of a class = number of concrete 4-card hands mapping to it.
// Their sum must equal C(52,4) = 270,725 and the class count must equal 16,432.

// All 24 permutations of suits {0,1,2,3}
const SUIT_PERMS = (function () {
  const perms = [];
  const a = [0, 1, 2, 3];
  function rec(k) {
    if (k === 4) { perms.push(a.slice()); return; }
    for (let i = k; i < 4; i++) {
      const t = a[k]; a[k] = a[i]; a[i] = t;
      rec(k + 1);
      const t2 = a[k]; a[k] = a[i]; a[i] = t2;
    }
  }
  rec(0);
  return perms;
})();

// Canonical key for a concrete 4-card omaha hand under FULL suit isomorphism.
// We try all 24 suit relabelings. For each, we re-pair the (rank, mapped-suit),
// sort the four cards by rank DESC then mapped-suit ASC, then relabel suits in
// first-appearance order to a,b,c,d. The lexicographically minimal resulting
// "<ranks>/<pattern>" string is THE canonical class key. Sorting after the
// suit map (instead of before) is what makes rank-tie hands collapse correctly.
function omahaCanonicalKey(cards4) {
  const ranks = cards4.map((c) => c >> 2);
  const suits = cards4.map((c) => c & 3);
  let best = null;
  for (const perm of SUIT_PERMS) {
    // map suits, build [rank, mappedSuit] pairs
    const pairs = [];
    for (let i = 0; i < 4; i++) pairs.push([ranks[i], perm[suits[i]]]);
    // sort by rank desc, then mapped-suit asc
    pairs.sort((x, y) => (y[0] - x[0]) || (x[1] - y[1]));
    // first-appearance relabel of the (already-permuted) suits
    const map = new Map();
    let next = 0;
    let rankStr = '', patStr = '';
    for (const [r, s] of pairs) {
      if (!map.has(s)) map.set(s, next++);
      rankStr += RANK_CHARS[r];
      patStr += 'abcd'[map.get(s)];
    }
    const key = rankStr + '/' + patStr;
    if (best === null || key < best) best = key;
  }
  return best;
}

// Enumerate all omaha canonical classes with combo counts.
// Approach: enumerate the 4 cards as (rank,suit) with cards strictly ordered
// to avoid double counting concrete hands, group by canonical (ranks desc +
// canonical suit pattern aligned to the desc rank order).
//
// To make the canonical form stable we must canonicalize ranks AND suits
// together: sort the 4 cards by rank descending, then for ties (same rank)
// the suit order among them doesn't matter for the pattern relabeling because
// relabeling is by first appearance. But to get a UNIQUE class key for hands
// that are suit-isomorphic AND rank-pattern equal, we relabel suits by first
// appearance scanning in the fixed (rank-desc, then suit-asc) order.
function buildOmahaClasses() {
  // We iterate over concrete 4-card combos but in a reduced rank/suit space.
  // Direct C(52,4)=270,725 enumeration is cheap (<1s); we just bucket them.
  const classMap = new Map(); // key -> {ranks:[], pattern, count}
  let total = 0;
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      for (let c = b + 1; c < 52; c++) {
        for (let d = c + 1; d < 52; d++) {
          total++;
          const key = omahaCanonicalKey([a, b, c, d]);
          let e = classMap.get(key);
          if (!e) {
            // derive ranks + pattern from the canonical key for the representative
            const [rankStr, pattern] = key.split('/');
            const ranks = rankStr.split('').map((ch) => RANK_CHARS.indexOf(ch));
            e = { classKey: key, ranks, pattern, count: 0 };
            classMap.set(key, e);
          }
          e.count++;
        }
      }
    }
  }
  return { classMap, total };
}

// representative concrete hand for an omaha class: assign suits per pattern
// (a->0, b->1, c->2, d->3) to the ranks in order.
function omahaRep(cls) {
  const ranks = cls.ranks;
  const pattern = cls.pattern;
  const suitOf = { a: 0, b: 1, c: 2, d: 3 };
  const hand = [];
  for (let i = 0; i < 4; i++) hand.push(ranks[i] * 4 + suitOf[pattern[i]]);
  return hand;
}

function rankOmaha(classMap, trials, seed) {
  const rng = makeRng(seed);
  const classes = Array.from(classMap.values());
  const out = [];
  let done = 0;
  for (const cls of classes) {
    const hero = omahaRep(cls);
    const heroSet = new Set(hero);
    const deck = [];
    for (let i = 0; i < 52; i++) if (!heroSet.has(i)) deck.push(i);
    let eq = 0;
    for (let t = 0; t < trials; t++) {
      const dlen = deck.length;
      // need 4 villain + 5 board = 9 cards
      for (let k = 0; k < 9; k++) {
        const j = k + Math.floor(rng() * (dlen - k));
        const tmp = deck[k]; deck[k] = deck[j]; deck[j] = tmp;
      }
      const villain = [deck[0], deck[1], deck[2], deck[3]];
      const board = [deck[4], deck[5], deck[6], deck[7], deck[8]];
      const sh = evalOmaha(hero, board);
      const sv = evalOmaha(villain, board);
      eq += sh > sv ? 1 : (sh === sv ? 0.5 : 0);
    }
    out.push({ classKey: cls.classKey, equityVsRandom: eq / trials, comboCount: cls.count });
    done++;
    if (done % 200 === 0) process.stdout.write(`  omaha ${done}/${classes.length}\r`);
  }
  out.sort((a, b) => b.equityVsRandom - a.equityVsRandom);
  console.log(`\n  omaha: ranked ${out.length} classes`);
  return out;
}

// ===========================================================================
// MAIN
// ===========================================================================
function main() {
  const t0 = Date.now();

  // ----- Hold'em -----
  // 169 classes; 120k trials each is ~20M showdowns -> stable ordering, fast.
  console.log('Ranking Hold\'em (169 classes)...');
  const HOLDEM_TRIALS = 120000;
  const holdem = rankHoldem(HOLDEM_TRIALS, 0x1234567);
  fs.writeFileSync(path.join(__dirname, 'holdem-ranking.json'), JSON.stringify(holdem));
  const hSum = holdem.reduce((s, c) => s + c.comboCount, 0);
  console.log(`  holdem combo sum = ${hSum} (expect 1326)`);

  // ----- Omaha -----
  console.log('\nEnumerating Omaha canonical classes...');
  const { classMap, total } = buildOmahaClasses();
  console.log(`  enumerated ${classMap.size} classes from ${total} concrete hands (expect 16432 classes / 270725 hands)`);

  // 16,432 classes. Trials chosen so ORDER is stable in a few minutes.
  // ~3000 trials/class * 16432 ~= 49M showdowns of omaha (each = 60 evaluate5).
  console.log('Ranking Omaha (this is the long part)...');
  const OMAHA_TRIALS = 3000;
  const omaha = rankOmaha(classMap, OMAHA_TRIALS, 0x7654321);
  fs.writeFileSync(path.join(__dirname, 'omaha-ranking.json'), JSON.stringify(omaha));
  const oSum = omaha.reduce((s, c) => s + c.comboCount, 0);
  console.log(`  omaha combo sum = ${oSum} (expect 270725)`);

  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('Wrote holdem-ranking.json and omaha-ranking.json');
}

if (require.main === module) main();

module.exports = { holdemClasses, buildOmahaClasses, RANK_CHARS, omahaCanonicalKey, omahaRep };
