// [wrapped in IIFE for safe classic-script loading in the browser]
;(function(){
'use strict';
// ===========================================================================
// wrap-predicate.js  —  STANDALONE PROTOTYPE (board-relative Omaha ranges)
// ---------------------------------------------------------------------------
// A NEW capability the preflop PPT syntax cannot express: ranges defined
// RELATIVE TO THE BOARD — "top wrap + pair", "any set", "top two pair",
// "13-out wrap", etc. A "wrap" is a straight draw whose out-count depends on
// the specific board, so it can only be resolved once the board is known.
//
// Card model (shared with ppt-eval.js): idx 0..51, rank = idx>>2 (0=2..12=A),
// suit = idx&3, suit chars 'cdhs'. evalOmaha(hole4, board5) -> integer score;
// made-hand CATEGORY = score >>> 20:
//   8 straight-flush  7 quads  6 full house  5 flush  4 straight
//   3 trips  2 two-pair  1 one-pair  0 high-card
//
// This file does NOT modify any existing module. It only REQUIRES ppt-eval.js.
// ===========================================================================

var PPTEval = (typeof require !== 'undefined')
  ? require('./ppt-eval.js')
  : (typeof window !== 'undefined' ? window.PPTEval : null);
var evalOmaha = PPTEval.evalOmaha;

var CAT = function (score) { return score >>> 20; };           // made-hand category
var rankOf = function (c) { return c >> 2; };
var suitOf = function (c) { return c & 3; };

// ---------------------------------------------------------------------------
// 1. STRAIGHT-DRAW OUTS  (the heart of "wrap")
// ---------------------------------------------------------------------------
// DEFINITION. For a 4-card Omaha hand on a 3- or 4-card board, a "straight out"
// is a next-street card that completes a 5-card straight using EXACTLY 2 hole
// cards + 3 board cards (the Omaha rule, enforced by evalOmaha). We compute it
// brute-force: for every card not already on the board or in the hand, deal it
// as the next board card and ask whether evalOmaha now yields a STRAIGHT (cat 4)
// or STRAIGHT-FLUSH (cat 8) that the hand did NOT already have.
//
// We report BOTH:
//   • outCards  — number of distinct physical cards that complete a straight
//                 (this is the "real" out count for equity / dead-card removal)
//   • outRanks  — number of distinct RANKS that complete a straight
//                 (this is what poker players mean colloquially by "outs";
//                  a wrap is usually counted in ranks, since all 4 suits of a
//                  needed rank are live pre-removal)
// For wrap TIER classification we use outRanks*4-style intuition but key the
// tiers off outRanks (the standard "9-out / 13-out / 17-out / 20-out" language).
//
// We only count a card as an out if the hand does NOT already make a straight
// on the current board (a made straight is not a draw).
function straightOuts(hole, board) {
  if (board.length < 3 || board.length > 4) {
    throw new Error('straightOuts: board must be 3 or 4 cards (flop or turn)');
  }
  var dead = {};
  var i;
  for (i = 0; i < hole.length; i++) dead[hole[i]] = 1;
  for (i = 0; i < board.length; i++) dead[board[i]] = 1;

  // Does the hand already make a straight on the current board?
  // Pad the partial board to 5 cards by repeating board[0] is WRONG (would
  // create accidental pairs/straights). Instead test all real 5th/4th cards:
  // simplest correct check — append two impossible-to-help fillers is unsafe,
  // so we check "already straight" by testing the partial board directly with
  // a dedicated straight-on-partial routine below.
  var alreadyStraight = madeStraightOnPartial(hole, board);

  var outCards = 0;
  var outRanksSet = {};
  for (var c = 0; c < 52; c++) {
    if (dead[c]) continue;
    var nb = board.concat([c]);
    var nowStraight = madeStraightOnPartial(hole, nb);
    if (nowStraight && !alreadyStraight) {
      outCards++;
      outRanksSet[rankOf(c)] = 1;
    }
  }
  return {
    outCards: outCards,
    outRanks: Object.keys(outRanksSet).length,
    alreadyStraight: alreadyStraight
  };
}

// Helper: does (hole4 + partial board of 3 or 4) make a straight using exactly
// 2 hole + 3 board, ignoring flush? We evaluate every (2-of-4 hole)x(3-of-N
// board) 5-card combo and detect a straight directly via detectStraight on the
// rank bits, so a 4-card board never needs padding.
var detectStraight = PPTEval.detectStraight;
function madeStraightOnPartial(hole, board) {
  var H2 = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  var n = board.length;
  // all 3-of-n board combos
  var B3 = [];
  for (var a = 0; a < n - 2; a++)
    for (var b = a + 1; b < n - 1; b++)
      for (var d = b + 1; d < n; d++) B3.push([a, b, d]);
  for (var hi = 0; hi < H2.length; hi++) {
    for (var bi = 0; bi < B3.length; bi++) {
      var bits = 0;
      bits |= 1 << rankOf(hole[H2[hi][0]]);
      bits |= 1 << rankOf(hole[H2[hi][1]]);
      bits |= 1 << rankOf(board[B3[bi][0]]);
      bits |= 1 << rankOf(board[B3[bi][1]]);
      bits |= 1 << rankOf(board[B3[bi][2]]);
      if (detectStraight(bits) >= 0) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. WRAP TIERS  (classify a straight draw by its out count, in RANKS)
// ---------------------------------------------------------------------------
// Standard Omaha wrap language is counted in CARDS, not ranks (a "13-out wrap",
// "17-out wrap", "20-out wrap"). On a flop the board's 3 cards are too spread to
// form a straight by themselves, so the straight forms on the RIVER using 3 of
// the now-4 board cards; the TURN card is the "out". A 4-card hole on the right
// board can see up to 20 straight outs. We therefore key tiers off OUT-CARDS:
//   < 9 cards  : weak / gutshot / partial draw     (not a wrap)
//   >= 9 cards : WRAP                               (isWrap = true)
//   >= 13 cards: BIG wrap
//   >= 17 cards: MONSTER wrap   (the classic 17/20-out top wrap)
// (We still report outRanks separately — it's the distinct-rank count, useful
// for dead-card reasoning, but the colloquial wrap size is the card count.)
// "TOP wrap" — CHOICE (documented): the maximum-out straight draw AVAILABLE on
// that board (the nut wrap). We compute, across ALL legal hole hands on this
// board, the highest straightOuts.outRanks that any drawing hand can have, and
// call that the board's TOP-WRAP out count. A hand isTopWrap if its outRanks
// equals that board maximum AND it is also the NUT straight draw (its completed
// straight, on its best out, is the best possible straight that out can make —
// i.e. nobody can hold a higher straight on that runout). This is stricter than
// "most outs" because a hand can have many outs yet draw to a non-nut straight.
// We ALSO expose a simpler threshold flag isMonsterWrap (>=17) for callers who
// want a fixed bar rather than the board-relative nut definition.
var WRAP_TIERS = {           // thresholds in OUT-CARDS
  WEAK: 0,        // < 9 cards
  WRAP: 9,        // >= 9 cards
  BIG: 13,        // >= 13 cards
  MONSTER: 17     // >= 17 cards
};
function wrapTier(outCards) {
  if (outCards >= WRAP_TIERS.MONSTER) return 'MONSTER';
  if (outCards >= WRAP_TIERS.BIG)     return 'BIG';
  if (outCards >= WRAP_TIERS.WRAP)    return 'WRAP';
  return 'WEAK';
}

// ---------------------------------------------------------------------------
// 3/4. MADE-HAND HELPERS  (pair / top pair / set / two-pair / top two-pair)
// ---------------------------------------------------------------------------
// We use evalOmaha for the *made* category, plus structural checks for which
// board cards are involved (top pair, top two pair).
function boardRanksSortedDesc(board) {
  var rs = board.map(rankOf).slice();
  rs.sort(function (x, y) { return y - x; });
  return rs;
}
function rankCount(cards) {
  var rc = {};
  for (var i = 0; i < cards.length; i++) {
    var r = rankOf(cards[i]);
    rc[r] = (rc[r] || 0) + 1;
  }
  return rc;
}

// hasPair: hand makes at least one pair on this board, using 2 hole + 3 board.
// Read directly from the made category (cat >= 1) — note cat>=2 (two pair),
// cat 3 (trips/set), cat 6 (full house) etc. all imply a pair. We treat any
// made category that contains a pair as hasPair=true. (Flush/straight made
// hands that contain NO pair are hasPair=false unless they also pair.)
// To capture "holds a pocket pair OR pairs a board card" robustly even when a
// bigger made hand (straight/flush) masks it, we ALSO do a structural check.
function hasAnyPairStructural(hole, board) {
  // pocket pair in hand
  var hrc = rankCount(hole);
  for (var k in hrc) if (hrc[k] >= 2) return true;
  // a hole card pairs a board card
  var brs = {};
  for (var i = 0; i < board.length; i++) brs[rankOf(board[i])] = 1;
  for (var j = 0; j < hole.length; j++) if (brs[rankOf(hole[j])]) return true;
  return false;
}

// SET: hole pocket pair that matches a board card -> trips that are a "set"
// (as opposed to trips made from a paired board, which Omaha calls trips).
// We define set = hold a pocket pair AND that rank appears on the board.
function isSet(hole, board) {
  var hrc = rankCount(hole);
  var brs = {};
  var i;
  for (i = 0; i < board.length; i++) brs[rankOf(board[i])] = 1;
  for (var r in hrc) {
    if (hrc[r] >= 2 && brs[r]) return true;
  }
  return false;
}

// TWO PAIR (made, on the board): the made category is exactly two-pair (cat 2),
// OR the hand uses two of its hole cards to pair two distinct board cards.
// We use a structural definition so it isn't masked by a bigger hand:
// hand pairs two DISTINCT board ranks using hole cards (each via a separate
// hole card), giving "two pair" on the board.
function pairedBoardRanks(hole, board) {
  // which board ranks does the hand pair (using a hole card)? returns set of ranks
  var brs = {};
  var i;
  for (i = 0; i < board.length; i++) brs[rankOf(board[i])] = 1;
  var paired = {};
  for (var j = 0; j < hole.length; j++) {
    var r = rankOf(hole[j]);
    if (brs[r]) paired[r] = 1;
  }
  return Object.keys(paired).map(Number);
}
function isTwoPair(hole, board) {
  // two distinct board ranks paired by hole cards == two pair on board.
  var paired = pairedBoardRanks(hole, board);
  if (paired.length >= 2) return true;
  // OR: a pocket pair (below/between board) + pairing one board card also = 2 pair,
  // but to keep "two pair on the board" clean we require >=2 paired board ranks
  // OR a pocket pair that is itself a pair plus one paired board card.
  if (paired.length === 1) {
    var hrc = rankCount(hole);
    for (var k in hrc) {
      if (hrc[k] >= 2 && Number(k) !== paired[0]) return true; // pocket pair + 1 board pair
    }
  }
  return false;
}

// TOP PAIR: hand pairs the HIGHEST board card, OR holds an overpair (pocket
// pair higher than the highest board card).
function isTopPair(hole, board) {
  var brs = boardRanksSortedDesc(board);
  var topBoard = brs[0];
  // pairs the top board card?
  for (var j = 0; j < hole.length; j++) if (rankOf(hole[j]) === topBoard) return true;
  // overpair?
  var hrc = rankCount(hole);
  for (var r in hrc) if (hrc[r] >= 2 && Number(r) > topBoard) return true;
  return false;
}

// TOP TWO PAIR: pairs the two highest DISTINCT board ranks.
function isTopTwoPair(hole, board) {
  var brs = boardRanksSortedDesc(board);
  // distinct top two board ranks
  var distinct = [];
  for (var i = 0; i < brs.length; i++) {
    if (distinct.indexOf(brs[i]) === -1) distinct.push(brs[i]);
    if (distinct.length === 2) break;
  }
  if (distinct.length < 2) return false;
  var paired = {};
  var k;
  for (k = 0; k < hole.length; k++) {
    var r = rankOf(hole[k]);
    if (distinct.indexOf(r) !== -1) paired[r] = 1;
  }
  return paired[distinct[0]] && paired[distinct[1]];
}

// ---------------------------------------------------------------------------
// BOARD TOP-WRAP precomputation: the maximum outRanks any hand can have on a
// given board, plus the nut-straight detection used for isTopWrap.
// We memoize per board string to avoid re-enumerating 270k hands repeatedly.
// ---------------------------------------------------------------------------
var _topWrapCache = {};
function boardKey(board) { return board.slice().sort(function(a,b){return a-b;}).join(','); }

function boardMaxStraightOuts(board) {
  var key = boardKey(board);
  if (_topWrapCache[key] != null) return _topWrapCache[key];
  var dead = {};
  for (var i = 0; i < board.length; i++) dead[board[i]] = 1;
  var deck = [];
  for (var c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
  var max = 0;
  // enumerate all 4-card hands from remaining deck
  var L = deck.length;
  for (var a = 0; a < L - 3; a++)
   for (var b = a + 1; b < L - 2; b++)
    for (var d = b + 1; d < L - 1; d++)
     for (var e = d + 1; e < L; e++) {
       var hole = [deck[a], deck[b], deck[d], deck[e]];
       var o = straightOuts(hole, board).outCards;
       if (o > max) max = o;
     }
  _topWrapCache[key] = max;
  return max;
}

// Is THIS hand drawing to the NUT straight on at least one of its outs?
// For each out card, complete the board, find the best straight score the hand
// makes; then check no OTHER possible 4-card holding makes a HIGHER straight on
// that same completed board. Implemented lightly: a hand draws to the nut
// straight if, on its best out, the straight it completes uses the TOP of the
// available straight window (no over-card straight is possible for a villain).
// We approximate "nut" precisely: deal each out, and for the completed 5-card
// board, the maximum straight any 2-hole+3-board holding can make equals the
// straight THIS hand makes. If equal on any out, it's a nut-straight draw.
function drawsToNutStraight(hole, board) {
  var dead = {};
  var i;
  for (i = 0; i < hole.length; i++) dead[hole[i]] = 1;
  for (i = 0; i < board.length; i++) dead[board[i]] = 1;
  for (var c = 0; c < 52; c++) {
    if (dead[c]) continue;
    var nb = board.concat([c]);
    if (!madeStraightOnPartial(hole, nb)) continue;
    // hand's straight-high on this runout
    var myHigh = bestStraightHigh(hole, nb);
    if (myHigh < 0) continue;
    // best straight-high ANY holding can make on this completed board
    var nutHigh = boardBestStraightHigh(nb, dead);
    if (myHigh === nutHigh) return true;
  }
  return false;
}
// best straight-high for a specific holding on a (3..5 card) board
function bestStraightHigh(hole, board) {
  var H2 = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  var n = board.length, best = -1;
  var B3 = [];
  for (var a = 0; a < n - 2; a++)
    for (var b = a + 1; b < n - 1; b++)
      for (var d = b + 1; d < n; d++) B3.push([a, b, d]);
  for (var hi = 0; hi < H2.length; hi++)
    for (var bi = 0; bi < B3.length; bi++) {
      var bits = 0;
      bits |= 1 << rankOf(hole[H2[hi][0]]);
      bits |= 1 << rankOf(hole[H2[hi][1]]);
      bits |= 1 << rankOf(board[B3[bi][0]]);
      bits |= 1 << rankOf(board[B3[bi][1]]);
      bits |= 1 << rankOf(board[B3[bi][2]]);
      var sh = detectStraight(bits);
      if (sh > best) best = sh;
    }
  return best;
}
// best straight-high ANY 2-hole holding can make on this completed board
// (uses 3 board cards + any 2 ranks). Since villain can hold any 2 cards, the
// nut straight on a 5-card board is just the highest straight completable by
// SOME 2 ranks together with 3 board cards.
function boardBestStraightHigh(board5) {
  var n = board5.length;
  var B3 = [];
  for (var a = 0; a < n - 2; a++)
    for (var b = a + 1; b < n - 1; b++)
      for (var d = b + 1; d < n; d++) B3.push([a, b, d]);
  var best = -1;
  for (var bi = 0; bi < B3.length; bi++) {
    var bbits = (1 << rankOf(board5[B3[bi][0]])) | (1 << rankOf(board5[B3[bi][1]])) | (1 << rankOf(board5[B3[bi][2]]));
    // try adding any two ranks
    for (var r1 = 0; r1 < 13; r1++)
      for (var r2 = r1; r2 < 13; r2++) {
        var sh = detectStraight(bbits | (1 << r1) | (1 << r2));
        if (sh > best) best = sh;
      }
  }
  return best;
}

// ---------------------------------------------------------------------------
// analyzeHand  — the unified report
// ---------------------------------------------------------------------------
function analyzeHand(hole, board) {
  var so = straightOuts(hole, board);
  var maxOuts = boardMaxStraightOuts(board);     // in CARDS
  var tier = wrapTier(so.outCards);
  var isWrap = so.outCards >= WRAP_TIERS.WRAP;
  // TOP wrap (documented CHOICE): a WRAP (>=9 outs) that draws to the NUT
  // straight on at least one of its outs — i.e. the high end of the wrap makes
  // the best possible straight on that runout, so no villain straight beats it.
  // This matches table language ("top wrap" = the nut-end wrap) and is what the
  // user means by labeling 97TJ / 9JQ8 top wraps. It is NOT merely the max
  // out-count hand (a 20-out wrap to a non-nut straight is big but not "top").
  // boardMaxOuts is still reported for reference.
  var isTopWrap = isWrap && drawsToNutStraight(hole, board);
  return {
    madeCategory: CAT(_evalPartial(hole, board)),   // category on the partial board
    straightOuts: so.outCards,                       // CARDS (the wrap size)
    straightOutRanks: so.outRanks,                   // distinct ranks
    straightOutCards: so.outCards,
    wrapTier: tier,
    isWrap: isWrap,
    isBigWrap: so.outCards >= WRAP_TIERS.BIG,
    isMonsterWrap: so.outCards >= WRAP_TIERS.MONSTER,
    isTopWrap: isTopWrap,
    boardMaxOuts: maxOuts,
    hasPair: !!hasAnyPairStructural(hole, board),
    isTopPair: !!isTopPair(hole, board),
    isSet: !!isSet(hole, board),
    isTwoPair: !!isTwoPair(hole, board),
    isTopTwoPair: !!isTopTwoPair(hole, board)
  };
}

// evaluate the made category on a partial (3/4) board: pad to 5 by evaluating
// every 2-hole + 3-board combo via evalOmaha is overkill; instead we just run
// evalOmaha on the FLOP by duplicating... no — evalOmaha needs 5 board cards.
// For a fair "made category on partial board" we run a 5-of-(hole+board) style
// best-category scan limited to 2 hole + 3 board (straights/pairs/sets only;
// flushes need 5 cards so on a 3-card board only a made set/2pair/pair/trip is
// possible). We reuse evaluate5 over 2-hole + 3-board combos.
var evaluate5 = PPTEval.evaluate5;
function _evalPartial(hole, board) {
  var H2 = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
  var n = board.length;
  var B3 = [];
  for (var a = 0; a < n - 2; a++)
    for (var b = a + 1; b < n - 1; b++)
      for (var d = b + 1; d < n; d++) B3.push([a, b, d]);
  var best = -1;
  for (var hi = 0; hi < H2.length; hi++)
    for (var bi = 0; bi < B3.length; bi++) {
      var s = evaluate5([
        hole[H2[hi][0]], hole[H2[hi][1]],
        board[B3[bi][0]], board[B3[bi][1]], board[B3[bi][2]]
      ]);
      if (s > best) best = s;
    }
  return best;
}

// ---------------------------------------------------------------------------
// wrapPlusPair  — the headline predicate: TOP wrap AND a pair
// ---------------------------------------------------------------------------
function wrapPlusPair(hole, board, opts) {
  opts = opts || {};
  var a = analyzeHand(hole, board);
  var wrapOK = opts.requireTopWrap === false ? a.isWrap : a.isTopWrap;
  var pairOK = opts.requireTopPair ? a.isTopPair : a.hasPair;
  return wrapOK && pairOK;
}

// ---------------------------------------------------------------------------
// RANGE BUILDER  — enumerate all C(52,4) hands minus dead, return matches.
// spec is a board-relative spec object. Supported keys (OR-combined unless
// `all:true`): wrapPlusPair, topWrapPlusTopPair, set, twoPair, topTwoPair,
// wrap, bigWrap, monsterWrap, topWrap, pair, topPair, minStraightOuts.
// ---------------------------------------------------------------------------
function buildRange(board, spec, extraDead) {
  spec = spec || {};
  var dead = {};
  var i;
  for (i = 0; i < board.length; i++) dead[board[i]] = 1;
  if (extraDead) for (i = 0; i < extraDead.length; i++) dead[extraDead[i]] = 1;
  var deck = [];
  for (var c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
  var L = deck.length;
  var out = [];
  for (var a = 0; a < L - 3; a++)
   for (var b = a + 1; b < L - 2; b++)
    for (var d = b + 1; d < L - 1; d++)
     for (var e = d + 1; e < L; e++) {
       var hole = [deck[a], deck[b], deck[d], deck[e]];
       if (matchesSpec(hole, board, spec)) out.push(hole.slice());
     }
  return out;
}

function matchesSpec(hole, board, spec) {
  var a = analyzeHand(hole, board);
  var hits = [];
  if (spec.wrapPlusPair)       hits.push(a.isTopWrap && a.hasPair);
  if (spec.topWrapPlusTopPair) hits.push(a.isTopWrap && a.isTopPair);
  if (spec.set)                hits.push(a.isSet);
  if (spec.twoPair)            hits.push(a.isTwoPair);
  if (spec.topTwoPair)         hits.push(a.isTopTwoPair);
  if (spec.wrap)               hits.push(a.isWrap);
  if (spec.bigWrap)            hits.push(a.isBigWrap);
  if (spec.monsterWrap)        hits.push(a.isMonsterWrap);
  if (spec.topWrap)            hits.push(a.isTopWrap);
  if (spec.pair)               hits.push(a.hasPair);
  if (spec.topPair)            hits.push(a.isTopPair);
  if (spec.minStraightOuts != null) hits.push(a.straightOuts >= spec.minStraightOuts);
  if (hits.length === 0) return false;
  if (spec.all) { for (var i = 0; i < hits.length; i++) if (!hits[i]) return false; return true; }
  for (var j = 0; j < hits.length; j++) if (hits[j]) return true;  // OR
  return false;
}

// ---------------------------------------------------------------------------
// Monte-Carlo equity: hero vs a list of villain holdings on a 3/4-card board.
// ---------------------------------------------------------------------------
function mcEquityVsRange(hero, board, villainRange, N) {
  N = N || 50000;
  var i;
  for (i = 0; i < villainRange.length; i++) {} // touch
  var heroEq = 0, trials = 0;
  var boardNeed = 5 - board.length;
  // Precompute deck excluding hero+board (villain dealt from range each trial)
  for (var t = 0; t < N; t++) {
    var v = villainRange[(Math.random() * villainRange.length) | 0];
    // skip if villain overlaps hero or board
    var dead = {};
    var bad = false;
    for (i = 0; i < hero.length; i++) dead[hero[i]] = 1;
    for (i = 0; i < board.length; i++) dead[board[i]] = 1;
    for (i = 0; i < v.length; i++) { if (dead[v[i]]) { bad = true; break; } dead[v[i]] = 1; }
    if (bad) continue;
    var deck = [];
    for (var c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
    // draw remaining board cards
    var fb = board.slice();
    for (var k = 0; k < boardNeed; k++) {
      var j = (Math.random() * deck.length) | 0;
      fb.push(deck[j]);
      deck[j] = deck[deck.length - 1]; deck.pop();
    }
    var hs = evalOmaha(hero, fb);
    var vs = evalOmaha(v, fb);
    heroEq += hs > vs ? 1 : (hs === vs ? 0.5 : 0);
    trials++;
  }
  return { equity: heroEq / trials, trials: trials };
}

// ---------------------------------------------------------------------------
// Exports + small parsing helper
// ---------------------------------------------------------------------------
var RANKMAP = { '2':0,'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'T':8,'J':9,'Q':10,'K':11,'A':12 };
function card(str) { return RANKMAP[str[0]] * 4 + 'cdhs'.indexOf(str[1]); }
function cards(str) {
  // "4c8hTs" -> [idx,idx,idx]
  var out = [], i = 0;
  while (i < str.length) { out.push(card(str.substr(i, 2))); i += 2; }
  return out;
}

var API = {
  straightOuts: straightOuts,
  madeStraightOnPartial: madeStraightOnPartial,
  wrapTier: wrapTier,
  WRAP_TIERS: WRAP_TIERS,
  hasAnyPairStructural: hasAnyPairStructural,
  isSet: isSet,
  isTwoPair: isTwoPair,
  isTopPair: isTopPair,
  isTopTwoPair: isTopTwoPair,
  drawsToNutStraight: drawsToNutStraight,
  boardMaxStraightOuts: boardMaxStraightOuts,
  analyzeHand: analyzeHand,
  wrapPlusPair: wrapPlusPair,
  buildRange: buildRange,
  matchesSpec: matchesSpec,
  mcEquityVsRange: mcEquityVsRange,
  card: card,
  cards: cards
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.WrapPredicate = API;

})();
