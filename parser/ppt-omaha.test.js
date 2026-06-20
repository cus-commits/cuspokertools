'use strict';
/*
 * ppt-omaha.test.js
 * ------------------------------------------------------------------
 * Node test runner for ppt-omaha.js. Prints PASS/FAIL per check and
 * exits non-zero if any check fails.
 *
 *   node ppt-omaha.test.js
 *
 * Strategy: most assertions brute-force the FULL 270,725-hand space,
 * count how many hands the parser's predicate matches, and compare
 * against a closed-form / derived expectation. Iterating the whole
 * space is fast in Node (~30ms per pass).
 * ------------------------------------------------------------------ */

var PPT = require('./ppt-omaha.js');
var parseRange = PPT.parseRange;
var I = PPT._internals;

var pass = 0, fail = 0;
var failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else {
    fail++;
    var msg = 'FAIL  ' + name + (extra ? '  -> ' + extra : '');
    console.log(msg);
    failures.push(msg);
  }
}

function eq(name, got, want) {
  ok(name, got === want, 'got ' + got + ' want ' + want);
}

// Count matches of a range over the FULL space (optionally with dead).
function countMatches(range) {
  var r = (typeof range === 'string') ? parseRange(range) : range;
  var n = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    // call predicate via matches() using card strings to also exercise coercion
    if (r.matches([a, b, c, d])) n++;
  });
  return n;
}

// Faster count helper that drives the predicate directly (matches by ints).
function countMatchesFast(rangeStr) {
  var r = parseRange(rangeStr);
  var n = 0;
  I.forEachHand(function (a, b, c, d) {
    if (r.matches([a, b, c, d])) n++;
  });
  return n;
}

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  var num = 1, den = 1;
  for (var i = 0; i < k; i++) { num *= (n - i); den *= (i + 1); }
  return Math.round(num / den);
}

console.log('=== ppt-omaha.js test suite ===\n');

/* ----------------------------------------------------------------
 * 0. Sanity: total space.
 * ---------------------------------------------------------------- */
var TOTAL = comb(52, 4); // 270725
eq('space size C(52,4) = 270725', countMatchesFast('****'), TOTAL);
eq('blank "*" = any-4', countMatchesFast('*'), TOTAL);

/* ----------------------------------------------------------------
 * 1. Specific 4 cards -> exactly 1.
 * ---------------------------------------------------------------- */
eq('AsAhKsKd is exactly 1 hand', countMatchesFast('AsAhKsKd'), 1);
(function () {
  var r = parseRange('AsAhKsKd');
  var e = r.enumerate({});
  ok('AsAhKsKd enumerate -> 1 combo, not sampled',
     e.total === 1 && e.combos.length === 1 && e.sampled === false,
     JSON.stringify(e));
})();

/* ----------------------------------------------------------------
 * 2. Named pairs.
 *
 * AA = at least two aces, other two cards anything.
 * Derivation: choose 2 of the 4 aces = C(4,2)=6, choose 2 of the
 * remaining 48 cards = C(48,2)=1128. BUT this double counts hands
 * with 3 or 4 aces. Use exactly-k decomposition:
 *   exactly2 = C(4,2)*C(48,2) = 6*1128 = 6768   (minus 3+ overlap)
 * Cleaner: hands with >=2 aces = total - (0 aces) - (exactly 1 ace)
 *   0 aces      = C(48,4)
 *   exactly1ace = C(4,1)*C(48,3)
 *   >=2 aces    = C(52,4) - C(48,4) - 4*C(48,3)
 * ---------------------------------------------------------------- */
(function () {
  var expAA = comb(52, 4) - comb(48, 4) - comb(4, 1) * comb(48, 3);
  eq('AA (>=2 aces) count', countMatchesFast('AA'), expAA);
  // expAA derivation value:
  console.log('      (AA expected = ' + expAA + ')');
})();

/* AAKK = >=2 aces AND >=2 kings. With only 4 cards, that forces
 * EXACTLY two aces and exactly two kings. Count = C(4,2)*C(4,2) = 36. */
eq('AAKK (exactly two aces + two kings) = 36', countMatchesFast('AAKK'), 36);

/* AARR = two aces + another pair (rank != A). Exactly two aces, and the
 * other two cards form a pair of one of the other 12 ranks.
 *   = C(4,2) [aces] * 12 [other rank] * C(4,2) [its pair] = 6*12*6 = 432 */
eq('AARR (aces + another pair) = 432', countMatchesFast('AARR'), 432);

/* AALL = two aces + two LOW cards (low = ranks 2..8 => 7 ranks, 28 cards).
 * The two low cards are any 2 of those 28 (may pair or not), distinct from
 * aces automatically (ace not low here).
 *   = C(4,2) [aces] * C(28,2) [two low cards] = 6 * 378 = 2268 */
(function () {
  var lowCards = 7 * 4; // ranks 2..8 -> 28 cards
  var expAALL = comb(4, 2) * comb(lowCards, 2);
  eq('AALL (aces + two low 2..8) count', countMatchesFast('AALL'), expAALL);
  console.log('      (AALL expected = ' + expAALL + ')');
})();

/* ----------------------------------------------------------------
 * 3. Rank VARIABLES.
 *
 * RR = one pair (some rank appears >= 2). Count = hands with at least
 * one pair = total - (all four ranks distinct).
 *   all-distinct = C(13,4) ways to pick ranks * 4^4 suit choices
 *                = 715 * 256 = 183040
 *   RR (>=1 pair) = 270725 - 183040 = 87685
 * ---------------------------------------------------------------- */
(function () {
  var distinct = comb(13, 4) * Math.pow(4, 4);
  var expRR = TOTAL - distinct;
  eq('RR (>=1 pair) count', countMatchesFast('RR'), expRR);
  console.log('      (RR expected = ' + expRR + ', all-distinct = ' + distinct + ')');
})();

/* RROO = two pair (two distinct ranks each paired). Two flavors:
 *   (a) exactly two pairs, four cards = two pairs:
 *        choose 2 ranks of 13 = C(13,2)=78, each pair C(4,2)=6 => 78*36 = 2808
 *   (b) a hand with trips+pair? RROO needs two DISTINCT paired ranks; a
 *       hand of pattern {3,1} only has one pair-or-more rank, not two, so
 *       it doesn't qualify. Quads {4} -> one rank. So RROO = exactly the
 *       two-pair hands = 2808.
 *   Also {2,2} is the only 4-card shape giving two paired ranks. So 2808.
 * ---------------------------------------------------------------- */
(function () {
  var expRROO = comb(13, 2) * comb(4, 2) * comb(4, 2); // 78*6*6
  eq('RROO (two pair) count', countMatchesFast('RROO'), expRROO);
  eq('RR00 alias (0=O) equals RROO', countMatchesFast('RR00'), expRROO);
  console.log('      (RROO expected = ' + expRROO + ')');
})();

/* RRON = one pair + two further distinct UNPAIRED ranks.
 * Shape {2,1,1}: choose the pair rank C(13,1)=13, its 2 suits C(4,2)=6,
 * choose 2 OTHER distinct ranks C(12,2)=66, each one card 4*4=16.
 *   = 13 * 6 * 66 * 16 = 82368
 * ---------------------------------------------------------------- */
(function () {
  var expRRON = 13 * comb(4, 2) * comb(12, 2) * 4 * 4;
  eq('RRON (one pair + 2 distinct unpaired) count', countMatchesFast('RRON'), expRRON);
  console.log('      (RRON expected = ' + expRRON + ')');
})();

/* JRON = a jack + three OTHER distinct ranks (all four ranks distinct,
 * one of them is exactly J, no pairing among them).
 * Shape: rank J present once, plus 3 distinct non-J ranks, all singletons.
 *   choose 3 other ranks from 12 = C(12,3)=220, the J card 4 ways,
 *   each of the 3 others 4 ways => 220 * 4 * 4^3 = 220 * 4 * 64 = 56320
 * ---------------------------------------------------------------- */
(function () {
  var expJRON = comb(12, 3) * 4 * Math.pow(4, 3);
  eq('JRON (a jack + 3 other distinct ranks) count', countMatchesFast('JRON'), expJRON);
  console.log('      (JRON expected = ' + expJRON + ')');
})();

/* ----------------------------------------------------------------
 * 4. Pair ranges (made-pair rank).
 *
 * TT+ = hand contains a pair of rank >= T (T,J,Q,K,A = 5 ranks).
 * Count via inclusion is fiddly (a hand could have two qualifying pairs).
 * We brute-force and also cross-check TT+ == union of TT..AA pair presence.
 * ---------------------------------------------------------------- */
(function () {
  // cross-check: TT+ should equal "any hand with >=2 of some rank in {T,J,Q,K,A}"
  var got = countMatchesFast('TT+');
  // independent brute-force expectation using a hand-rolled predicate
  var exp = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    var hit = false;
    for (var r in f.rankCount) {
      if (f.rankCount[r] >= 2 && Number(r) >= 8) { hit = true; break; } // T idx=8
    }
    if (hit) exp++;
  });
  eq('TT+ (pair of T or better) matches brute-force', got, exp);
  console.log('      (TT+ = ' + got + ')');
})();

(function () {
  var got = countMatchesFast('TT-77');
  var exp = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    var hit = false;
    for (var r in f.rankCount) {
      var ri = Number(r);
      if (f.rankCount[r] >= 2 && ri >= 5 && ri <= 8) { hit = true; break; } // 7..T
    }
    if (hit) exp++;
  });
  eq('TT-77 (pair within 7..T) matches brute-force', got, exp);
  console.log('      (TT-77 = ' + got + ')');
})();

/* ----------------------------------------------------------------
 * 5. SUIT GROUPING (the headline fix).
 *
 * $ds = double-suited = suit multiset exactly {2,2}.
 * Closed form:
 *   choose the two suits: C(4,2) = 6
 *   for the FIRST suit choose 2 of its 13 cards: C(13,2)=78
 *   for the SECOND suit choose 2 of its 13 cards: C(13,2)=78
 *   = 6 * 78 * 78 = 36504
 *   (No overcount: the two suits are an unordered pair, and we picked an
 *    unordered pair of suits once.)
 * ---------------------------------------------------------------- */
(function () {
  var expDS = comb(4, 2) * comb(13, 2) * comb(13, 2); // 6*78*78
  eq('$ds (double-suited {2,2}) count', countMatchesFast('$ds'), expDS);
  eq('*$ds equals $ds', countMatchesFast('*$ds'), expDS);
  console.log('      ($ds expected = ' + expDS + ' = C(4,2)*C(13,2)^2)');
})();

/* $ns / wxyz = rainbow = four distinct suits {1,1,1,1}.
 * Closed form: one card from each suit = 13^4 = 28561.
 * Hmm but that counts ordered-by-suit which is fine since suits are fixed
 * labels: pick one of 13 clubs, one of 13 diamonds, one of 13 hearts, one
 * of 13 spades = 13^4 = 28561. Each such hand is unordered and unique.
 * ---------------------------------------------------------------- */
(function () {
  var expNS = Math.pow(13, 4); // 28561
  eq('wxyz (rainbow, 4 distinct suits) count', countMatchesFast('wxyz'), expNS);
  eq('$ns equals wxyz', countMatchesFast('$ns'), expNS);
  console.log('      (wxyz/$ns expected = ' + expNS + ' = 13^4)');
})();

/* $ss = single-suited = suit multiset {2,1,1}.
 * Closed form:
 *   choose the doubled suit: 4 ways
 *   choose its 2 cards: C(13,2)=78
 *   choose the two OTHER suits that appear once: C(3,2)=3
 *   one card from each of those two suits: 13 * 13 = 169
 *   = 4 * 78 * 3 * 169 = 158184
 * Sanity: {2,2}+{2,1,1}+{3,1}+{4}+{1,1,1,1} should sum to 270725.
 * ---------------------------------------------------------------- */
(function () {
  var expSS = 4 * comb(13, 2) * comb(3, 2) * 13 * 13;
  eq('$ss (single-suited {2,1,1}) count', countMatchesFast('$ss'), expSS);
  console.log('      ($ss expected = ' + expSS + ')');
  // partition sanity check
  var ds = countMatchesFast('$ds');
  var ss = countMatchesFast('$ss');
  var ns = countMatchesFast('$ns');
  var threeOne = 0, four = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    var s = f.suitCountSorted;
    if (s[0] === 3) threeOne++;
    else if (s[0] === 4) four++;
  });
  eq('suit partition sums to 270725', ds + ss + ns + threeOne + four, TOTAL,
     'ds=' + ds + ' ss=' + ss + ' ns=' + ns + ' 3-1=' + threeOne + ' mono=' + four);
})();

/* AA$ds = double-suited aces (exactly two aces, double-suited).
 * Derivation: hand is {2,2} suited and contains exactly two aces.
 * Approach: count {2,2} double-suited hands that contain >=2 aces.
 * With double-suited shape, the two aces could be:
 *   (i) the SAME suit pair (both aces in one of the two suits) -> but a
 *       suit only contributes 2 cards; if both are aces, that suit's pair
 *       is AcAd? no — same suit can't have two aces. A single suit has ONE
 *       ace. So two aces must be in TWO DIFFERENT suits. In a {2,2} hand the
 *       two suits each contribute 2 cards. For two aces we need one ace in
 *       each of the two chosen suits (aces occupy one slot in each suit).
 *   Count: choose 2 suits for the hand: C(4,2)=6. In each chosen suit, the
 *   ace of that suit is forced (to be one of the 2 cards), and the 2nd card
 *   of that suit is any of the remaining 12 ranks: 12 choices per suit.
 *     = 6 * 12 * 12 = 864
 *   (Exactly two aces, since each suit gives exactly one ace and only the
 *    two chosen suits are present.)
 * ---------------------------------------------------------------- */
(function () {
  var expAAds = comb(4, 2) * 12 * 12; // 6*144 = 864
  eq('AA$ds (double-suited aces) count', countMatchesFast('AA$ds'), expAAds);
  console.log('      (AA$ds expected = ' + expAAds + ' = C(4,2)*12*12)');
})();

/* Suit variables:
 *   AxAyxy  = AA double-suited  -> should equal AA$ds = 864
 *   AxAyxz  = AA single-suited  -> two aces, single-suited.
 * For AxAyxz: suits (x,y,x,z): suit x appears twice, y once, z once. The two
 * x-cards are an ace (Ax) and the 3rd card; the y card is the 2nd ace (Ay).
 * So aces are in suits x and y (distinct), x is the doubled suit.
 *   choose suit x (doubled): 4; suit y (other ace): 3 remaining; suit z: 2
 *   remaining. The x-pair: Ax (ace, forced) + one more x-card of any of 12
 *   non-ace ranks (12). The z card: any of 13 ranks in suit z, but must keep
 *   ranks consistent? AxAyxz has rank pattern A,A,*,* with the 3rd (x) and
 *   4th (z) being free ranks (suit vars only constrain suits).
 *   Wait rank chars: A x A y x z -> cards: (A,x)(A,y)(?,x)(?,z) — only TWO
 *   rank chars given as 'A'; the 3rd and 4th rank chars are 'x'/'z'? No:
 *   token "AxAyxz" parses pairwise: (A,x)(A,y)(x,z)?? That's only valid if
 *   length 6 => 3 cards. Our pattern requires 8 chars for 4 cards. So the
 *   canonical AA single-suited token is the 8-char "AxAyAzAw"? The spec gave
 *   "AxAyxy"/"AxAyxz" as 6-char => 3 placeholders... Actually PPT uses these
 *   as 2-rank specs meaning "two aces with this suit relationship" and the
 *   remaining cards free. We treat 6-char "AxAyxy" specially below.
 * We just assert the documented equivalences via dedicated tokens.
 * ---------------------------------------------------------------- */
(function () {
  // Our parser handles the 8-char rank+suitvar form. Build AA double-suited
  // as "AxAyBxBy"? Simplify: assert via the spec's stated 6-char forms by
  // mapping them: we accept "AxAy" + suit relation. Implement check using the
  // explicit suit-variable predicate over a constructed 8-char equivalent:
  //   AA double-suited: AxAy?x?y  (two aces in suits x,y; two more cards in
  //   the same two suits). We test the canonical "AxAyzxwy"-style is awkward;
  //   instead validate the documented identity AA$ds == 864 already above and
  //   here validate AxAy.. via a 4-card suit-var token that pins both aces and
  //   leaves the other two cards' suits to repeat x,y.
  // Token "AxAyOxOy"? 'O' is not a suit var. Use blanks: "*x*y" won't pin aces.
  // We assert the 8-char "AxAy*x*y"? blanks allowed as rank => any rank in
  // suits x and y respectively. That's: 2 aces (Ax,Ay) + 2 more cards, one in
  // suit x one in suit y => double-suited containing >=2 aces but the two ace
  // cards are pinned to suits x,y. Counts to AA$ds = 864.
  var got = countMatchesFast('AxAy*x*y');
  eq('AxAy*x*y (AA double-suited via suit vars) = 864', got, 864);

  // AA single-suited via suit vars: aces in suits x and y, the two remaining
  // cards both in suit x (so suit x has 3?). No — single-suited is {2,1,1}.
  // Put both aces' suits x,y, and the other two cards in suits z and w? that
  // would be rainbow. Single-suited {2,1,1}: doubled suit shared by an ace and
  // one other card; the 2nd ace and the 4th card in two further distinct suits.
  //   token "AxAy*x*z": Ax, Ay, (*,x), (*,z): suit x twice (Ax + *x), suit y
  //   once (Ay), suit z once (*z) => {2,1,1} single-suited, two aces.
  // Expected: choose x:4, y:3, z:2 => 24 suit-assignments; the *x card: 12
  // non-ace ranks (must differ from ace rank? only suit pinned, rank free but
  // distinct card; could be any of 12 non-A ranks in suit x, since Ax already
  // taken -> 12). The *z card: any of 13 ranks in suit z (Az allowed? that'd
  // be a 3rd ace -> still two-aces? no, 3 aces). Token says rank '*' so a 3rd
  // ace is permitted by the token, but then it's AAA not AA-as-two. Hmm.
  // To keep the assertion clean we instead brute-force the expected predicate
  // independently here.
  // Independent brute-force of the EXACT token semantics of "AxAy*x*z":
  // there must exist a labelling of the 4 cards to slots (A,x)(A,y)(*,x)(*,z)
  // such that ranks match (slots 0,1 are aces; slots 2,3 any) and suit vars are
  // consistent: x==x (same suit), x!=y, x!=z, y!=z (distinct letters => distinct
  // suits). Slot 2 shares suit x with slot 0; slot 3 has its own suit z.
  // We brute-force by trying all suit assignments x,y,z distinct and all aces.
  var got2 = countMatchesFast('AxAy*x*z');
  var exp2 = 0;
  function suitOf(c){return c & 3;} function rankOf(c){return c>>2;}
  I.forEachHand(function (a, b, c, d) {
    var cards = [a, b, c, d];
    // try every permutation into slots [A x][A y][* x][* z]
    var perms = [];
    (function p(arr,m){ if(!arr.length){perms.push(m);return;}
      for(var i=0;i<arr.length;i++) p(arr.slice(0,i).concat(arr.slice(i+1)), m.concat(arr[i])); })([0,1,2,3],[]);
    for (var pi = 0; pi < perms.length; pi++) {
      var pm = perms[pi];
      var s0=cards[pm[0]], s1=cards[pm[1]], s2=cards[pm[2]], s3=cards[pm[3]];
      if (rankOf(s0)!==12 || rankOf(s1)!==12) continue;       // slots 0,1 are aces
      var x = suitOf(s0), y = suitOf(s1), x2 = suitOf(s2), z = suitOf(s3);
      if (x2 !== x) continue;            // slot2 suit == x
      if (x===y || x===z || y===z) continue; // distinct letters => distinct suits
      exp2++; break; // count the hand once
    }
  });
  eq('AxAy*x*z (AA single-suited via suit vars) matches independent brute-force',
     got2, exp2);
  console.log('      (AxAy*x*z = ' + got2 + ')');
})();

/* literal suit groups "sshh" = two spades + two hearts -> {2,2} double-suited.
 * Equals $ds count = 36504 (our semantics: distinct labels => {2,2}). */
eq('sshh literal (two-of-one + two-of-another) = $ds count',
   countMatchesFast('sshh'), comb(4, 2) * comb(13, 2) * comb(13, 2));

/* ----------------------------------------------------------------
 * 6. Rundowns.
 *
 * AKQJ = hand contains ranks A,K,Q,J (each >=1). Other 0 cards (it's
 * exactly 4 ranks). Count = each rank one card, 4 choices each = 4^4 = 256.
 * (No room for extra cards; all four ranks fixed, distinct.)
 * ---------------------------------------------------------------- */
eq('AKQJ rundown (4 fixed consecutive ranks) = 4^4 = 256',
   countMatchesFast('AKQJ'), Math.pow(4, 4));

/* AKQJ-T987 = union of rundowns with top card A,K,Q,J,T (5 rundowns).
 *   tops: A(idx12),K(11),Q(10),J(9),T(8) -> 5 rundowns.
 * These 5 sets are DISJOINT? A rundown is 4 consecutive ranks; two rundowns
 * with different tops share at most 3 ranks but as 4-card hands each requires
 * its own 4 distinct ranks, so a single 4-card hand can satisfy at most one
 * rundown (it has exactly the 4 ranks of that rundown, or fewer ranks). A
 * hand satisfying AKQJ has ranks {A,K,Q,J}; it cannot also satisfy KQJT
 * (needs a T). So disjoint. Count = 5 * 256 = 1280.
 * ---------------------------------------------------------------- */
eq('AKQJ-T987 (5 rundowns A..T tops) = 5*256 = 1280',
   countMatchesFast('AKQJ-T987'), 5 * 256);

/* 9876- = this rundown and all lower. Tops from 9(idx7) down to 5(idx3)
 *   -> 9876, 8765, 7654, 6543, 5432 = 5 rundowns. 5*256 = 1280. */
eq('9876- (open-ended low) = 5*256 = 1280',
   countMatchesFast('9876-'), 5 * 256);

/* ----------------------------------------------------------------
 * 7. Gapped connectors.
 *
 * $0g = 0-gap = 4 distinct consecutive ranks (a rundown of any top).
 *   #rundowns = tops A(12)..5(3) = 10 tops? top must allow 4 below: top from
 *   idx 3 (5432) up to idx 12 (AKQJ) = 10 tops. Each = 4^4 = 256.
 *   = 10 * 256 = 2560.
 * ---------------------------------------------------------------- */
eq('$0g (0-gap connectors = all rundowns) = 10*256 = 2560',
   countMatchesFast('$0g'), 10 * 256);

/* $1g = 4 DISTINCT ranks with span (max-min) == 4 (one internal gap).
 * Derivation: pick a window [lo, lo+4] (span 4) -> lo from idx0..8 = 9 windows.
 * Within each 5-rank window we must use BOTH endpoints (lo and lo+4) to make
 * span exactly 4, plus 2 of the 3 interior ranks: C(3,2)=3 rank-sets per window.
 * Each chosen rank one card, 4 suits => 4^4=256.
 *   = 9 windows * 3 * 256 = 6912.
 * ---------------------------------------------------------------- */
eq('$1g (1-gap, span==4) = 9*3*256 = 6912',
   countMatchesFast('$1g'), 9 * 3 * 256);

/* $2g = 4 distinct ranks with span == 5 (two internal gaps within a 6 window).
 * windows [lo,lo+5]: lo idx0..7 = 8 windows. Use both endpoints + 2 of the 4
 * interior ranks: C(4,2)=6 sets. * 4^4 = 256.
 *   = 8 * 6 * 256 = 12288.
 * ---------------------------------------------------------------- */
eq('$2g (2-gap, span==5) = 8*6*256 = 12288',
   countMatchesFast('$2g'), 8 * 6 * 256);

/* ----------------------------------------------------------------
 * 8. Macro filters.
 *
 * $np = no pair = all 4 ranks distinct = C(13,4)*4^4 = 715*256 = 183040.
 * $nt = no trips/quads = exclude any rank with >=3.
 * $B = all four cards in {A,K,Q,J} (16 cards) = C(16,4) = 1820.
 * $R = all four in broadway A..T (20 cards) = C(20,4) = 4845.
 * $F = all four in {K,Q,J} (12 cards) = C(12,4) = 495.
 * $W = all four in wheel {A,2,3,4,5} (20 cards) = C(20,4) = 4845.
 * $L = all four in low {A,2..8} (8 ranks=32 cards) = C(32,4) = 35960.
 * ---------------------------------------------------------------- */
eq('$np (no pair, 4 distinct ranks) = 183040', countMatchesFast('$np'), comb(13,4)*256);
eq('$B (all in A-J, 16 cards) = C(16,4)=1820', countMatchesFast('$B'), comb(16,4));
eq('$R (all in A-T, 20 cards) = C(20,4)=4845', countMatchesFast('$R'), comb(20,4));
eq('$F (all in K-J, 12 cards) = C(12,4)=495', countMatchesFast('$F'), comb(12,4));
eq('$W (all in wheel A2345, 20 cards) = C(20,4)=4845', countMatchesFast('$W'), comb(20,4));
eq('$L (all in low A-8, 32 cards) = C(32,4)=35960', countMatchesFast('$L'), comb(32,4));
eq('$M (all in mid T9876, 16 cards) = C(16,4)=1820', countMatchesFast('$M'), comb(16,4));
eq('$Z (all in small 65432, 20 cards) = C(20,4)=4845', countMatchesFast('$Z'), comb(20,4));

(function () {
  // $nt brute-force expectation
  var exp = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    var trippy = false;
    for (var r in f.rankCount) if (f.rankCount[r] >= 3) trippy = true;
    if (!trippy) exp++;
  });
  eq('$nt (no trips/quads) matches brute-force', countMatchesFast('$nt'), exp);
})();

/* ----------------------------------------------------------------
 * 9. Operators: union(,) intersection(:) difference(!) grouping().
 * ---------------------------------------------------------------- */
(function () {
  // AA , KK  -> hands with >=2 aces OR >=2 kings (inclusion-exclusion)
  var aa = countMatchesFast('AA');
  var kk = countMatchesFast('KK');
  var both = countMatchesFast('AAKK'); // >=2 aces AND >=2 kings = 36
  var union = countMatchesFast('AA,KK');
  eq('union AA,KK = |AA|+|KK|-|AA&KK|', union, aa + kk - both);
})();

(function () {
  // AA : $ds  == AA$ds (intersection equals the combined token) = 864
  eq('intersection AA:$ds == AA$ds = 864', countMatchesFast('AA:$ds'), 864);
})();

(function () {
  // $ds ! AA  == double-suited minus double-suited-aces
  var ds = countMatchesFast('$ds');
  var aads = countMatchesFast('AA$ds');
  eq('difference $ds!AA = |$ds| - |AA$ds|', countMatchesFast('$ds!AA'), ds - aads);
})();

(function () {
  // precedence: ":" and "!" bind tighter than ",".
  // "AA:$ds, KK"  ==  (AA AND $ds) OR (KK)
  var left = countMatchesFast('AA$ds');       // AA:$ds
  var kk = countMatchesFast('KK');
  var overlap = countMatchesFast('AA$ds:KK');  // (AA & ds) & KK  -> need >=2 aces, >=2 kings, ds: with 4 cards 2A+2K and double-suited
  var combined = countMatchesFast('AA:$ds,KK');
  eq('precedence (AA:$ds),KK = |AA$ds|+|KK|-overlap', combined, left + kk - overlap);
})();

(function () {
  // grouping changes meaning: "(AA,KK):$ds" = (AA or KK) AND double-suited
  var got = countMatchesFast('(AA,KK):$ds');
  var exp = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    var ds = (f.suitCountSorted[0] === 2 && f.suitCountSorted[1] === 2);
    var aaOrKk = (f.rankCount[12] >= 2) || (f.rankCount[11] >= 2);
    if (ds && aaOrKk) exp++;
  });
  eq('grouping (AA,KK):$ds = brute-force', got, exp);
})();

/* ----------------------------------------------------------------
 * 10. Percentages (APPROXIMATE — flagged).
 * We only assert structural properties, not exact PPT parity:
 *   - "15%" selects roughly 15% of the space (within a tolerance band,
 *      ties make it inexact).
 *   - "15%-30%" selects roughly the next band and is disjoint-ish from top15.
 *   - warnings array is populated.
 * ---------------------------------------------------------------- */
(function () {
  var r15 = parseRange('15%');
  ok('percentage warning present', r15.warnings.length > 0, JSON.stringify(r15.warnings));
  var n15 = countMatchesFast('15%');
  var frac = n15 / TOTAL;
  ok('15% selects ~15% of space (0.08..0.25 tolerance, ties)',
     frac > 0.08 && frac < 0.25, 'frac=' + frac.toFixed(4) + ' n=' + n15);

  var n30 = countMatchesFast('30%');
  ok('30% selects more than 15%', n30 > n15, 'n30=' + n30 + ' n15=' + n15);

  // band 15%-30% should be (roughly) the difference, and not overlap top 15%.
  var nband = countMatchesFast('15%-30%');
  ok('15%-30% band is non-empty and < 30% cut', nband > 0 && nband < n30,
     'band=' + nband + ' n30=' + n30);

  // band should be disjoint from top-15% (no hand in both)
  var rBand = parseRange('15%-30%');
  var rTop = parseRange('15%');
  var overlap = 0;
  I.forEachHand(function (a, b, c, d) {
    if (rBand.matches([a, b, c, d]) && rTop.matches([a, b, c, d])) overlap++;
  });
  eq('15%-30% band disjoint from top-15%', overlap, 0);
})();

/* Regression: percentage boundary cases.
 * "0%" = top 0% = the EMPTY set (NOT the whole space). Earlier the single-
 * value form used 0 as its "no hi" sentinel, so a literal "0%" collapsed to
 * a band with an out-of-range threshold and matched ALL 270725 hands.
 * Likewise "0%-0%" and "50%-50%" are empty bands, and "100%"/"200%" select
 * the whole space (clamped). */
(function () {
  eq('0% (top 0%) selects nothing', countMatchesFast('0%'), 0);
  eq('0%-0% (empty band) selects nothing', countMatchesFast('0%-0%'), 0);
  eq('50%-50% (empty band) selects nothing', countMatchesFast('50%-50%'), 0);
  eq('100% selects the whole space', countMatchesFast('100%'), TOTAL);
  eq('200% (over 100%) clamps to whole space', countMatchesFast('200%'), TOTAL);
  // top-50% and the explicit two-value form "0%-50%" must agree.
  eq('0%-50% equals 50%', countMatchesFast('0%-50%'), countMatchesFast('50%'));
})();

/* ----------------------------------------------------------------
 * 11. Dead cards.
 * ---------------------------------------------------------------- */
(function () {
  // AsAhKsKd with As dead -> 0 combos
  var r = parseRange('AsAhKsKd');
  var e = r.enumerate({ dead: ['As'] });
  eq('AsAhKsKd with As dead -> 0', e.total, 0);

  // AA with both black aces dead: aces available = Ad, Ah only -> >=2 aces
  // means exactly the pair AdAh + any 2 of remaining 48 (minus the 2 dead).
  // remaining non-ace, non-dead cards = 48 (no aces among them; dead were aces)
  // wait dead are As,Ac (aces) -> remaining aces = Ad,Ah (2). >=2 aces forces
  // AdAh + C(48,2) others = 1 * 1128 = 1128.
  var r2 = parseRange('AA');
  var e2 = r2.enumerate({ dead: ['As', 'Ac'] });
  eq('AA with As,Ac dead -> AdAh + C(48,2) = 1128', e2.total, comb(48, 2));
})();

/* ----------------------------------------------------------------
 * 12. enumerate() sampling path for a large set.
 * ---------------------------------------------------------------- */
(function () {
  var r = parseRange('****'); // 270725 hands, way over cap
  var e = r.enumerate({ max: 100 });
  ok('enumerate(****) is sampled with total=270725 and 100 combos',
     e.sampled === true && e.total === TOTAL && e.combos.length === 100,
     'sampled=' + e.sampled + ' total=' + e.total + ' combos=' + e.combos.length);
  // sampled combos are valid 4-distinct-card hands
  var allValid = e.combos.every(function (c) {
    if (c.length !== 4) return false;
    var set = {};
    for (var i = 0; i < 4; i++) { if (set[c[i]]) return false; set[c[i]] = 1; }
    return true;
  });
  ok('sampled combos are valid 4-distinct-card hands', allValid);
})();

/* small set returns exhaustive, not sampled */
(function () {
  var r = parseRange('AAKK'); // 36 hands
  var e = r.enumerate({ max: 5 });
  ok('AAKK enumerate exhaustive (36, not sampled)',
     e.sampled === false && e.total === 36 && e.combos.length === 36,
     'sampled=' + e.sampled + ' total=' + e.total + ' n=' + e.combos.length);
})();

/* ----------------------------------------------------------------
 * 13. Error handling: invalid tokens MUST throw (never silent random).
 * ---------------------------------------------------------------- */
function throws(name, fn) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok('throws: ' + name, threw);
}
throws('empty string', function () { parseRange(''); });
throws('garbage token "XYZ@"', function () { parseRange('XYZ@'); });
throws('unbalanced paren "(AA"', function () { parseRange('(AA'); });
throws('bad rundown "AKJT" (not consecutive) in range', function () { parseRange('AKJT-QJT9'); });
throws('duplicate explicit card "AsAsKsKd"', function () { parseRange('AsAsKsKd').matches(['As','Ah','Ks','Kd']); });
throws('bad suit char "AxAhKsKd"? actually valid pattern; use "Az9z" bad rank',
       function () { parseRange('1c2c3c4c'); });

/* ----------------------------------------------------------------
 * 14. KJ*ss (rank + single-suited tail) sanity.
 *   KJ*ss = contains a K and a J, and is single-suited {2,1,1}.
 *   We brute-force the expected count.
 * ---------------------------------------------------------------- */
(function () {
  var got = countMatchesFast('KJ*ss');
  var exp = 0;
  I.forEachHand(function (a, b, c, d) {
    var f = I.features(a, b, c, d);
    var hasK = (f.rankCount[11] || 0) >= 1;
    var hasJ = (f.rankCount[9] || 0) >= 1;
    var ss = (f.suitCountSorted[0] === 2 && f.suitCountSorted[1] === 1 && f.suitCountSorted[2] === 1);
    if (hasK && hasJ && ss) exp++;
  });
  eq('KJ*ss (has K,J and single-suited) matches brute-force', got, exp);
  console.log('      (KJ*ss = ' + got + ')');
})();

/* ----------------------------------------------------------------
 * Summary
 * ---------------------------------------------------------------- */
console.log('\n=== SUMMARY ===');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach(function (m) { console.log('  ' + m); });
  process.exit(1);
} else {
  console.log('All checks passed.');
  process.exit(0);
}
