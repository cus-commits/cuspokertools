// [wrapped in IIFE for safe classic-script loading in the browser]
;(function(){
'use strict';
// ===========================================================================
// board-range.js — BOARD-RELATIVE RANGE ENGINE for cusPokerTools
// ---------------------------------------------------------------------------
// Resolves a villain range described by MADE-HAND CLASSES + DRAWS relative to
// a SPECIFIC board ("any two pair, any straight, any wrap, any top pair, any
// open-ender") into the concrete set of combos that match. This is the missing
// capability behind a real bug where such a range was being computed as "*"
// (= any random hand) and run through the equity engine.
//
// PUBLIC API
//   resolveBoardRange(game, board, spec, dead) -> { combos, count, label }
//   describeSpec(spec) -> human label string
//
//   game  : 'plo' (4-card, exactly 2 hole + 3 board) or 'holdem' (best 5 of 7)
//   board : array of card indices, length 3 (flop) or 4 (turn)
//   spec  : object of boolean/param predicate flags (see SPEC KEYS below)
//   dead  : optional array of dead card indices (also excludes board)
//
// Card model (shared with ppt-eval.js): idx 0..51, rank = idx>>2 (0=2..12=A),
// suit = idx&3, suit chars 'cdhs'. Made-hand category = score>>>20:
//   8 SF  7 quads  6 full house  5 flush  4 straight  3 trips  2 two-pair
//   1 one-pair  0 high-card.
//
// SPEC KEYS (all optional booleans unless noted). Default = OR (a hand
// qualifies if it matches ANY requested class). Pass { all:true } to AND them.
//   madeStraight   straight made on the board (cat 4 via the game's rule)
//   wrap           PLO straight draw >= 9 out-cards            (PLO only)
//   bigWrap        PLO straight draw >= 13 out-cards           (PLO only)
//   monsterWrap    PLO straight draw >= 17 out-cards           (PLO only)
//   openEnder      open-ended straight draw (two ranks complete, ~8 outs)
//   gutshot        gutshot straight draw (one rank completes, ~4 outs)
//   minStraightOuts:N   any straight draw with >= N out-cards (PLO useful)
//   twoPair        two distinct board ranks paired by the hand
//   topTwoPair     pairs the two highest distinct board ranks
//   set            pocket pair matching a board rank (a true set)
//   topSet         set of the highest board rank
//   bottomSet      set of the lowest board rank
//   pair           any made pair on the board
//   topPair        pairs the highest board rank, OR an overpair
//   overpair       pocket pair strictly above the highest board card
//   trips          made trips (cat 3, incl. set)
//   topPairOrBetter  topPair | twoPair | set | trips | straight (and up)
//
// SUPPORT MATRIX (documented honestly):
//   PLO    : ALL keys supported.
//   holdem : made-hand classes + madeStraight + openEnder + gutshot supported.
//            wrap / bigWrap / monsterWrap are NOT supported in holdem (a 2-card
//            holding cannot make a multi-out wrap) — they are IGNORED for
//            holdem and reported in the label as not-applicable.
// ===========================================================================

var PPTEval = (typeof require !== 'undefined')
  ? require('./ppt-eval.js')
  : (typeof window !== 'undefined' ? window.PPTEval : null);
var WP = (typeof require !== 'undefined')
  ? require('./wrap-predicate.js')
  : (typeof window !== 'undefined' ? window.WrapPredicate : null);

var evalOmaha     = PPTEval.evalOmaha;
var eval7holdem   = PPTEval.eval7holdem;
var detectStraight= PPTEval.detectStraight;
var CAT = function (score) { return score >>> 20; };
var rankOf = function (c) { return c >> 2; };
var suitOf = function (c) { return c & 3; };

// ---------------------------------------------------------------------------
// STRAIGHT MADE / STRAIGHT DRAW DETECTION (game-agnostic core via rank bits)
// ---------------------------------------------------------------------------
// We reuse the rank-bit straight detector. For a draw we add one card to the
// board and ask whether a straight now exists using the game's card rule.

// PLO: straight made using EXACTLY 2 hole + 3 board (reuse WP helper).
var madeStraightPLO = WP.madeStraightOnPartial;

// Holdem: straight made using best 5 of (2 hole + N board) — N is 3 or 4 here,
// so "best 5 of 5/6". detectStraight over the union rank-bits is exactly right
// because holdem can use any 5 of the available cards (no 2-card constraint).
function madeStraightHoldem(hole, board) {
  var bits = 0, i;
  for (i = 0; i < hole.length; i++)  bits |= 1 << rankOf(hole[i]);
  for (i = 0; i < board.length; i++) bits |= 1 << rankOf(board[i]);
  return detectStraight(bits) >= 0;
}

function madeStraight(game, hole, board) {
  return game === 'holdem' ? madeStraightHoldem(hole, board)
                           : !!madeStraightPLO(hole, board);
}

// Straight-draw out scan, game-aware. Returns { outCards, outRanks, made }.
//   outCards  = distinct physical next-cards that COMPLETE a straight the hand
//               does not already have.
//   outRanks  = distinct RANKS that complete a straight (colloquial out count).
// PLO uses the 2-hole+3-board rule; holdem uses best-5-of-7-style rank bits.
function straightDrawOuts(game, hole, board) {
  var made = madeStraight(game, hole, board);
  var dead = {}, i;
  for (i = 0; i < hole.length; i++)  dead[hole[i]] = 1;
  for (i = 0; i < board.length; i++) dead[board[i]] = 1;
  var outCards = 0, outRanksSet = {};
  for (var c = 0; c < 52; c++) {
    if (dead[c]) continue;
    var nb = board.concat([c]);
    if (madeStraight(game, hole, nb)) {
      // It is an "out" only if the hand was not ALREADY made before this card.
      // (We computed `made` on the current board; if already made, no draw.)
      if (!made) { outCards++; outRanksSet[rankOf(c)] = 1; }
    }
  }
  return { outCards: outCards, outRanks: Object.keys(outRanksSet).length, made: made };
}

// OESD / open-ender: a straight DRAW (not already made) where TWO distinct
// ranks complete a straight — the textbook open-ended draw (8 outs in holdem;
// in PLO the same two-rank-completion shape, which is the natural OESD floor of
// the wrap family). gutshot: exactly ONE rank completes (the inside / belly
// draw, ~4 outs). For PLO, hands with >2 completing ranks are wraps, not OESDs.
function classifyStraightDraw(game, hole, board) {
  var o = straightDrawOuts(game, hole, board);
  return {
    made: o.made,
    outCards: o.outCards,
    outRanks: o.outRanks,
    isGutshot:  !o.made && o.outRanks === 1,
    isOpenEnder:!o.made && o.outRanks === 2,
    isWrapShape:!o.made && o.outRanks >= 3   // >2 completing ranks = wrap family
  };
}

// ---------------------------------------------------------------------------
// MADE-PAIR CLASSES (board-relative). Reuse wrap-predicate where it exists;
// add overpair, topSet, bottomSet here.
// ---------------------------------------------------------------------------
function boardRanksDistinctDesc(board) {
  var seen = {}, out = [];
  var rs = board.map(rankOf).slice().sort(function (x, y) { return y - x; });
  for (var i = 0; i < rs.length; i++) if (!seen[rs[i]]) { seen[rs[i]] = 1; out.push(rs[i]); }
  return out;
}
function rankCount(cards) {
  var rc = {};
  for (var i = 0; i < cards.length; i++) { var r = rankOf(cards[i]); rc[r] = (rc[r] || 0) + 1; }
  return rc;
}
// overpair: pocket pair strictly higher than the highest board card.
function isOverpair(hole, board) {
  var top = boardRanksDistinctDesc(board)[0];
  var hrc = rankCount(hole);
  for (var r in hrc) if (hrc[r] >= 2 && Number(r) > top) return true;
  return false;
}
// set of a SPECIFIC board rank (pocket pair matching that rank)
function isSetOfRank(hole, board, targetRank) {
  var hrc = rankCount(hole);
  return !!(hrc[targetRank] && hrc[targetRank] >= 2);
}
function isTopSet(hole, board) {
  var d = boardRanksDistinctDesc(board);
  return isSetOfRank(hole, board, d[0]);
}
function isBottomSet(hole, board) {
  var d = boardRanksDistinctDesc(board);
  return isSetOfRank(hole, board, d[d.length - 1]);
}
// trips (made cat 3) on the partial board — set is a subset of trips.
function madeCategory(game, hole, board) {
  if (game === 'holdem') {
    // best 5 of (2 + N). Evaluate every 5-card combo of (hole∪board).
    var all = hole.concat(board), best = -1, n = all.length, i;
    var idx = [];
    for (i = 0; i < n; i++) idx.push(i);
    // n is 5 or 6 (2 hole + 3/4 board) -> few combos
    var combos = kOfN(n, 5);
    for (var ci = 0; ci < combos.length; ci++) {
      var h5 = [all[combos[ci][0]], all[combos[ci][1]], all[combos[ci][2]],
                all[combos[ci][3]], all[combos[ci][4]]];
      var s = PPTEval.evaluate5(h5);
      if (s > best) best = s;
    }
    return CAT(best);
  }
  // PLO partial category: best of 2-hole + 3-board (reuse WP analyze's logic)
  return WP.analyzeHand(hole, board).madeCategory;
}
function kOfN(n, k) {
  var res = [], cur = [];
  (function go(start) {
    if (cur.length === k) { res.push(cur.slice()); return; }
    for (var i = start; i < n; i++) { cur.push(i); go(i + 1); cur.pop(); }
  })(0);
  return res;
}

// holdem pair classes (structural, mirror the PLO ones in wrap-predicate)
function holdemPairedBoardRanks(hole, board) {
  var brs = {}, i;
  for (i = 0; i < board.length; i++) brs[rankOf(board[i])] = 1;
  var paired = {};
  for (var j = 0; j < hole.length; j++) { var r = rankOf(hole[j]); if (brs[r]) paired[r] = 1; }
  return Object.keys(paired).map(Number);
}
function holdemHasPair(hole, board) {
  var hrc = rankCount(hole);
  for (var k in hrc) if (hrc[k] >= 2) return true;            // pocket pair
  return holdemPairedBoardRanks(hole, board).length >= 1;     // pairs a board card
}
function holdemTwoPair(hole, board) {
  var paired = holdemPairedBoardRanks(hole, board);
  if (paired.length >= 2) return true;
  if (paired.length === 1) {
    var hrc = rankCount(hole);
    for (var k in hrc) if (hrc[k] >= 2 && Number(k) !== paired[0]) return true;
  }
  return false;
}
function holdemTopTwoPair(hole, board) {
  var d = boardRanksDistinctDesc(board);
  if (d.length < 2) return false;
  var p = {}, i;
  for (i = 0; i < hole.length; i++) { var r = rankOf(hole[i]); if (r === d[0] || r === d[1]) p[r] = 1; }
  return !!(p[d[0]] && p[d[1]]);
}
function holdemTopPair(hole, board) {
  var top = boardRanksDistinctDesc(board)[0], i;
  for (i = 0; i < hole.length; i++) if (rankOf(hole[i]) === top) return true;
  return isOverpair(hole, board);
}

// ---------------------------------------------------------------------------
// Per-hand analysis dispatch (PLO reuses wrap-predicate; holdem uses locals).
// ---------------------------------------------------------------------------
function analyze(game, hole, board) {
  var sd = classifyStraightDraw(game, hole, board);
  if (game === 'holdem') {
    var cat = madeCategory('holdem', hole, board);
    return {
      game: 'holdem',
      madeCategory: cat,
      madeStraight: cat >= 4 ? (cat === 4 || cat === 8) : madeStraightHoldem(hole, board),
      hasPair:    holdemHasPair(hole, board),
      twoPair:    holdemTwoPair(hole, board),
      topTwoPair: holdemTopTwoPair(hole, board),
      topPair:    holdemTopPair(hole, board),
      overpair:   isOverpair(hole, board),
      set:        isTopSet(hole, board) || isBottomSet(hole, board) || _holdemAnySet(hole, board),
      topSet:     isTopSet(hole, board),
      bottomSet:  isBottomSet(hole, board),
      trips:      cat === 3,
      // wraps undefined in holdem
      wrap: false, bigWrap: false, monsterWrap: false,
      straightOuts: sd.outCards, straightOutRanks: sd.outRanks,
      openEnder: sd.isOpenEnder, gutshot: sd.isGutshot
    };
  }
  // PLO
  var a = WP.analyzeHand(hole, board);
  return {
    game: 'plo',
    madeCategory: a.madeCategory,
    madeStraight: !!madeStraightPLO(hole, board),
    hasPair:   a.hasPair,
    twoPair:   a.isTwoPair,
    topTwoPair:a.isTopTwoPair,
    topPair:   a.isTopPair,
    overpair:  isOverpair(hole, board),
    set:       a.isSet,
    topSet:    isTopSet(hole, board),
    bottomSet: isBottomSet(hole, board),
    trips:     a.madeCategory === 3,
    wrap:        a.isWrap,
    bigWrap:     a.isBigWrap,
    monsterWrap: a.isMonsterWrap,
    straightOuts:    sd.outCards,
    straightOutRanks:sd.outRanks,
    openEnder: sd.isOpenEnder,
    gutshot:   sd.isGutshot
  };
}
// holdem set: pocket pair matching ANY board rank
function _holdemAnySet(hole, board) {
  var hrc = rankCount(hole), brs = {}, i;
  for (i = 0; i < board.length; i++) brs[rankOf(board[i])] = 1;
  for (var r in hrc) if (hrc[r] >= 2 && brs[r]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// SPEC MATCHING
// ---------------------------------------------------------------------------
var WRAP_KEYS = { wrap:1, bigWrap:1, monsterWrap:1 };
function matchesSpec(game, hole, board, spec) {
  var a = analyze(game, hole, board);
  var hits = [];
  function add(flag, val) { if (flag) hits.push(val); }

  add(spec.madeStraight, a.madeStraight);
  add(spec.twoPair,      a.twoPair);
  add(spec.topTwoPair,   a.topTwoPair);
  add(spec.set,          a.set);
  add(spec.topSet,       a.topSet);
  add(spec.bottomSet,    a.bottomSet);
  add(spec.pair,         a.hasPair);
  add(spec.topPair,      a.topPair);
  add(spec.overpair,     a.overpair);
  add(spec.trips,        a.trips);
  add(spec.openEnder,    a.openEnder);
  add(spec.gutshot,      a.gutshot);
  // wraps: PLO only; in holdem these keys are ignored (no contribution).
  if (game !== 'holdem') {
    add(spec.wrap,        a.wrap);
    add(spec.bigWrap,     a.bigWrap);
    add(spec.monsterWrap, a.monsterWrap);
  }
  if (spec.minStraightOuts != null) hits.push(a.straightOuts >= spec.minStraightOuts);
  if (spec.topPairOrBetter)
    hits.push(a.topPair || a.twoPair || a.set || a.trips || a.madeStraight || a.madeCategory >= 4);

  if (hits.length === 0) return false;
  if (spec.all) { for (var i = 0; i < hits.length; i++) if (!hits[i]) return false; return true; }
  for (var j = 0; j < hits.length; j++) if (hits[j]) return true;  // OR
  return false;
}

// ---------------------------------------------------------------------------
// ENUMERATION
// ---------------------------------------------------------------------------
function liveDeck(board, dead) {
  var blocked = {}, i;
  for (i = 0; i < board.length; i++) blocked[board[i]] = 1;
  if (dead) for (i = 0; i < dead.length; i++) blocked[dead[i]] = 1;
  var deck = [];
  for (var c = 0; c < 52; c++) if (!blocked[c]) deck.push(c);
  return deck;
}

// resolveBoardRange(game, board, spec, dead) -> { combos, count, label }
function resolveBoardRange(game, board, spec, dead) {
  game = (game === 'holdem') ? 'holdem' : 'plo';
  spec = spec || {};
  if (board.length < 3 || board.length > 4)
    throw new Error('resolveBoardRange: board must be a flop (3) or turn (4)');
  var deck = liveDeck(board, dead);
  var L = deck.length;
  var combos = [];
  if (game === 'holdem') {
    for (var a = 0; a < L - 1; a++)
      for (var b = a + 1; b < L; b++) {
        var h2 = [deck[a], deck[b]];
        if (matchesSpec('holdem', h2, board, spec)) combos.push(h2);
      }
  } else {
    for (var p = 0; p < L - 3; p++)
     for (var q = p + 1; q < L - 2; q++)
      for (var r = q + 1; r < L - 1; r++)
       for (var s = r + 1; s < L; s++) {
         var h4 = [deck[p], deck[q], deck[r], deck[s]];
         if (matchesSpec('plo', h4, board, spec)) combos.push(h4);
       }
  }
  return { combos: combos, count: combos.length, label: describeSpec(spec, game) };
}

// ---------------------------------------------------------------------------
// describeSpec -> human label
// ---------------------------------------------------------------------------
var LABELS = {
  madeStraight:'straight', wrap:'wrap', bigWrap:'big wrap', monsterWrap:'monster wrap',
  openEnder:'open-ender', gutshot:'gutshot', twoPair:'two pair', topTwoPair:'top two pair',
  set:'set', topSet:'top set', bottomSet:'bottom set', pair:'a pair', topPair:'top pair',
  overpair:'overpair', trips:'trips', topPairOrBetter:'top pair or better'
};
function describeSpec(spec, game) {
  spec = spec || {};
  var parts = [];
  for (var k in LABELS) {
    if (spec[k]) {
      if (game === 'holdem' && WRAP_KEYS[k]) continue; // skip wraps in holdem label
      parts.push(LABELS[k]);
    }
  }
  if (spec.minStraightOuts != null) parts.push(spec.minStraightOuts + '+ straight outs');
  if (parts.length === 0) return 'any hand';
  var joiner = spec.all ? ' and ' : ', ';
  var label;
  if (parts.length === 1) label = parts[0];
  else if (spec.all) label = parts.join(' and ');
  else label = parts.slice(0, -1).join(', ') + ' or ' + parts[parts.length - 1];
  if (game === 'holdem' && (spec.wrap || spec.bigWrap || spec.monsterWrap))
    label += ' (wrap classes N/A in holdem)';
  return label;
}

// ---------------------------------------------------------------------------
// Monte-Carlo equity: hero vs a resolved combo list on a 3/4-card board.
// Uniform over the (board-completed) combos, removal-aware.
// ---------------------------------------------------------------------------
function mcEquity(game, hero, board, combos, N) {
  N = N || 100000;
  var evalFn = game === 'holdem' ? eval7holdem : evalOmaha;
  var boardNeed = 5 - board.length;
  var heroEq = 0, trials = 0, i;
  var heroBoardDead = {};
  for (i = 0; i < hero.length; i++)  heroBoardDead[hero[i]] = 1;
  for (i = 0; i < board.length; i++) heroBoardDead[board[i]] = 1;
  for (var t = 0; t < N; t++) {
    var v = combos[(Math.random() * combos.length) | 0];
    var dead = {}, bad = false;
    for (i = 0; i < hero.length; i++)  dead[hero[i]] = 1;
    for (i = 0; i < board.length; i++) dead[board[i]] = 1;
    for (i = 0; i < v.length; i++) { if (dead[v[i]]) { bad = true; break; } dead[v[i]] = 1; }
    if (bad) continue;
    var deck = [];
    for (var c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
    var fb = board.slice();
    for (var k = 0; k < boardNeed; k++) {
      var j = (Math.random() * deck.length) | 0;
      fb.push(deck[j]); deck[j] = deck[deck.length - 1]; deck.pop();
    }
    var hs = evalFn(hero, fb);
    var vs = evalFn(v, fb);
    heroEq += hs > vs ? 1 : (hs === vs ? 0.5 : 0);
    trials++;
  }
  return { equity: heroEq / trials, trials: trials };
}

// small card parsing helpers (mirror wrap-predicate)
var RANKMAP = { '2':0,'3':1,'4':2,'5':3,'6':4,'7':5,'8':6,'9':7,'T':8,'J':9,'Q':10,'K':11,'A':12 };
function card(str) { return RANKMAP[str[0]] * 4 + 'cdhs'.indexOf(str[1]); }
function cards(str) { var out=[],i=0; while(i<str.length){ out.push(card(str.substr(i,2))); i+=2; } return out; }

var API = {
  resolveBoardRange: resolveBoardRange,
  describeSpec: describeSpec,
  analyze: analyze,
  matchesSpec: matchesSpec,
  madeStraight: madeStraight,
  straightDrawOuts: straightDrawOuts,
  classifyStraightDraw: classifyStraightDraw,
  isOverpair: isOverpair,
  isTopSet: isTopSet,
  isBottomSet: isBottomSet,
  mcEquity: mcEquity,
  card: card,
  cards: cards
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.BoardRange = API;

})();
