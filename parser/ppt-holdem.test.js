/*
 * ppt-holdem.test.js
 *
 * Node test runner for ppt-holdem.js.
 *  - Asserts exact combo COUNTS for every grammar construct.
 *  - Asserts that genuinely-invalid input THROWS.
 *  - Validates a handful of parsed ranges' equities against poker-odds-calc
 *    (TexasHoldem exhaustive mode) as ground truth.
 *
 * Prints a PASS/FAIL summary and exits non-zero on any failure.
 *
 * Run:  node ppt-holdem.test.js
 */

'use strict';

var P = require('./ppt-holdem.js');

// poker-odds-calc is installed at the repo root node_modules.
var TexasHoldem = require('poker-odds-calc').TexasHoldem;

var pass = 0;
var fail = 0;
var failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? '  ->  ' + detail : ''));
    console.log('FAIL  ' + name + (detail ? '   ' + detail : ''));
  }
}

// Assert that parseRange(str) yields exactly `expected` combos.
function count(name, str, expected, opts) {
  var got;
  try {
    got = P.parseRange(str, opts).count;
  } catch (e) {
    ok(name + '  "' + str + '"', false, 'threw: ' + e.message);
    return;
  }
  ok(name + '  "' + str + '" == ' + expected, got === expected,
    'got ' + got + ', expected ' + expected);
}

// Assert that parseRange(str) THROWS.
function throws(name, str, opts) {
  var threw = false;
  var got;
  try {
    got = P.parseRange(str, opts);
  } catch (e) {
    threw = true;
  }
  ok(name + '  "' + str + '" throws', threw,
    threw ? '' : 'did NOT throw (count=' + (got ? got.count : '?') + ')');
}

// --------------------------------------------------------------------------
// 1. Card helpers
// --------------------------------------------------------------------------
ok('normalizeCard 10c -> Tc', P.normalizeCard('10c') === 'Tc');
ok('normalizeCard ah -> Ah', P.normalizeCard('ah') === 'Ah');
ok('normalizeCard Tc -> Tc', P.normalizeCard('Tc') === 'Tc');
throws('normalizeCard invalid', 'Zx'); // not a card -> throws via parseRange path below
(function () {
  var threw = false;
  try { P.normalizeCard('Zx'); } catch (e) { threw = true; }
  ok('normalizeCard("Zx") throws', threw);
})();

// --------------------------------------------------------------------------
// 2. Exact combo-count assertions per construct
// --------------------------------------------------------------------------

// Specific cards
count('Specific cards', 'AsKh', 1);
count('Specific cards 10-normalize', '10cKh', 1);          // Tc Kh
count('Specific cards 10 both', 'As10h', 1);

// Bare ranks
count('Bare ranks AK', 'AK', 16);
count('Bare pair AA', 'AA', 6);

// Suited / offsuit + $ aliases
count('Suited AKs', 'AKs', 4);
count('Offsuit AKo', 'AKo', 12);
count('Suited alias AK$s', 'AK$s', 4);
count('Offsuit alias AK$o', 'AK$o', 12);

// Pair-plus
count('Pair-plus TT+', 'TT+', 30);  // TT,JJ,QQ,KK,AA = 5*6
count('Pair-plus QQ+', 'QQ+', 18);  // QQ,KK,AA = 3*6

// Kicker-plus
count('Kicker-plus AJs+', 'AJs+', 12); // AJs,AQs,AKs = 3*4
count('Kicker-plus AJo+', 'AJo+', 36); // AJo,AQo,AKo = 3*12
count('Kicker-plus A2s+', 'A2s+', 48); // A2s..AKs = 12 classes * 4
count('Kicker-plus AK+',  'AK+', 16);  // only AK (suited+offsuit)
count('Kicker-plus KQ+',  'KQ+', 16);  // only KQ (suited+offsuit)

// Single-rank plus: at least one card of rank Q or higher (Q,K,A = 12 cards).
// total 1326 minus combos with NO Q/K/A = C(40,2)=780 -> 546.
count('Single-rank plus Q+', 'Q+', 546);

// Pair dash
count('Pair dash 77-TT', '77-TT', 24);  // 77,88,99,TT = 4*6
count('Pair dash TT-77 (reversed)', 'TT-77', 24);

// Suited dash (shared-high) and cross-high shared-high
count('Suited dash A2s-A5s', 'A2s-A5s', 16);   // A2s,A3s,A4s,A5s = 4*4
count('Suited dash K8s-K5s', 'K8s-K5s', 16);   // K8s,K7s,K6s,K5s = 4*4
// Suit-specific dash: AhKh-AhTh = AhKh,AhQh,AhJh,AhTh = 4 specific combos
count('Suit-specific dash AhKh-AhTh', 'AhKh-AhTh', 4);

// Percentages (top-N by 169-hand ordering)
count('Percentage 15%', '15%', 200);       // round(0.15*1326)=199 -> class boundary
count('Percentage band 15%-30%', '15%-30%', 214);

// Operators
count('Union AA,KK', 'AA,KK', 12);
count('Intersection 25%:xx', '25%:xx', 100);   // top25% AND suited
count('Difference 40%!AA-22', '40%!AA-22', 468); // top40% minus all pairs
// Grouping + precedence: ':' and '!' bind tighter than ','
count('Precedence AA,KK:KK', 'AA,KK:KK', 12);  // AA + (KK:KK) = 6 + 6
count('Grouping (AA,KK):QQ', '(AA,KK):QQ', 0);
count('Grouping (AA,KK):KK', '(AA,KK):KK', 6);

// Brackets
count('Brackets [A-J][2-5]', '[A-J][2-5]', 256); // J..A (16 cards) x 2..5 (16 cards)
count('Brackets [T+][T+]', '[T+][T+]', 190);     // C(20,2)
count('Brackets K[2s,Jc,T]', 'K[2s,Jc,T]', 24);  // K(4) x {2s,Jc,T(4)} = 4*6=24

// Wildcards
count('Wildcard *', '*', 1326);
count('Wildcard **', '**', 1326);

// Suitedness keywords
count('xx (all suited)', 'xx', 312);   // 4 suits * C(13,2)=78
count('xy (all offsuit incl pairs)', 'xy', 1014);

// Weighting
(function () {
  var r = P.parseRange('AA@50');
  ok('Weight AA@50 count==6', r.count === 6, 'count=' + r.count);
  ok('Weight AA@50 has weights map', !!r.weights);
  var keys = r.weights ? Object.keys(r.weights) : [];
  ok('Weight AA@50 all combos weight 50',
    keys.length === 6 && keys.every(function (k) { return r.weights[k] === 50; }),
    JSON.stringify(r.weights));
})();
(function () {
  var r = P.parseRange('AA@50,KK');
  ok('Weight mixed AA@50,KK count==12', r.count === 12, 'count=' + r.count);
  // KK combos default weight 100 (not listed in weights map)
  var kkListed = Object.keys(r.weights || {}).some(function (k) { return k.indexOf('K') === 0 && k[2] === 'K'; });
  ok('Weight mixed KK not in weights map (default 100)', !kkListed);
})();

// --------------------------------------------------------------------------
// 3. Dead/blocked cards
// --------------------------------------------------------------------------
count('Dead: AA with Ah dead', 'AA', 3, { dead: ['Ah'] });           // remove 3 combos with Ah
count('Dead: AA with Ah,Ad dead', 'AA', 1, { dead: ['Ah', 'Ad'] });  // only AsAc left
count('Dead: AKs with Ah,Kh dead', 'AKs', 3, { dead: ['Ah', 'Kh'] }); // only AhKh removed (Ah and Kh both in same combo) -> 3 left
count('Dead: ** minus one card', '**', 1326 - 51, { dead: ['As'] }); // every combo with As removed = 51

// --------------------------------------------------------------------------
// 4. Invalid / unsupported input MUST throw
// --------------------------------------------------------------------------
throws('Empty string', '');
throws('Whitespace only', '   ');
throws('Garbage token', 'ZZ');
throws('Bad suit', 'Axxx');
throws('Unbalanced paren', '(AA,KK');
throws('Unbalanced paren 2', 'AA,KK)');
throws('Unbalanced bracket', '[A-J][2-5');
throws('Trailing junk', 'AA$$$');
throws('Same card twice', 'AsAs');
throws('Bad weight', 'AA@xyz');
throws('Bad percent', '150%');
throws('Lone operator', ',');
throws('Dangling comma', 'AA,');
throws('Bad dead card', 'AA', { dead: ['Zz'] });

// --------------------------------------------------------------------------
// 5. Equity validation vs poker-odds-calc (exhaustive)
// --------------------------------------------------------------------------
// We validate that parseRange produces the correct concrete combos by feeding
// a representative combo from a parsed single-class range into TexasHoldem and
// comparing equities to a known/independently-computed value.

function equityHeadsUp(handA, handB) {
  var t = new TexasHoldem();
  t.addPlayer(handA).addPlayer(handB).exhaustive();
  var r = t.calculate();
  var players = r.getPlayers();
  return {
    a: players[0].getWinsPercentage() + players[0].getTiesPercentage() / 2,
    b: players[1].getWinsPercentage() + players[1].getTiesPercentage() / 2,
    iters: r.getIterations()
  };
}

function approx(name, got, expected, tol) {
  ok(name + ' (' + got.toFixed(2) + '% ~ ' + expected.toFixed(2) + '%)',
    Math.abs(got - expected) <= tol, 'diff=' + Math.abs(got - expected).toFixed(3));
}

// 5a. AKs combo vs QQ ~ 46.0% (classic). Pull a concrete AKs combo from parser.
(function () {
  var aks = P.parseRange('AKs').combos;
  ok('AKs yields 4 combos for equity test', aks.length === 4);
  // Use the first combo (e.g. AsKs) vs QcQd
  var eq = equityHeadsUp(aks[0], ['Qc', 'Qd']);
  // Known exhaustive AKs vs QQ ~ 46.0%
  approx('Equity AKs vs QQ', eq.a, 46.0, 0.6);
  ok('AKs vs QQ exhaustive iters == 1712304', eq.iters === 1712304, 'iters=' + eq.iters);
})();

// 5b. AA vs KK ~ 81.9% (with no card overlap). Pull concrete combos.
(function () {
  // Hand-pick non-conflicting concrete combos: AhAs vs KcKd
  var eq = equityHeadsUp(['Ah', 'As'], ['Kc', 'Kd']);
  // Exhaustive AA vs KK (no suit interaction) = 81.25% (the "82%" is rounded).
  approx('Equity AA vs KK', eq.a, 81.25, 0.4);
})();

// 5c. AKo combo vs 22 (coinflip-ish) ~ 47-48%
(function () {
  var ako = P.parseRange('AKo').combos;
  ok('AKo yields 12 combos', ako.length === 12);
  // pick a combo that doesn't clash with 2c2d
  var combo = ako.find(function (c) { return c.indexOf('2c') === -1 && c.indexOf('2d') === -1; });
  var eq = equityHeadsUp(combo, ['2c', '2d']);
  // AKo vs 22 exhaustive ~ 46.9%
  approx('Equity AKo vs 22', eq.a, 46.9, 0.8);
})();

// 5d. Verify a percentage range's TOP combo is a premium (AA) by checking
// that parseRange('5%') contains all AA combos.
(function () {
  var top5 = P.parseRange('5%').combos.map(function (c) { return c[0] + c[1]; });
  var aaCombos = P.parseRange('AA').combos.map(function (c) { return c[0] + c[1]; });
  var allAA = aaCombos.every(function (k) { return top5.indexOf(k) !== -1; });
  ok('Top 5% contains all AA combos', allAA);
})();

// 5e. Sanity: a parsed combo is always two DISTINCT valid cards.
(function () {
  var r = P.parseRange('40%!AA-22');
  var allValid = r.combos.every(function (c) {
    return c.length === 2 && c[0] !== c[1] &&
      /^[2-9TJQKA][cdhs]$/.test(c[0]) && /^[2-9TJQKA][cdhs]$/.test(c[1]);
  });
  ok('All combos are two distinct valid cards', allValid);
})();

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log('');
console.log('==================================================');
console.log('  PASS: ' + pass + '    FAIL: ' + fail + '    TOTAL: ' + (pass + fail));
console.log('==================================================');
if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach(function (f) { console.log('  - ' + f); });
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
