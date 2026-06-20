'use strict';
/*
 * ppt-omaha.js
 * ------------------------------------------------------------------
 * A self-contained ProPokerTools "Simple Range Syntax" parser for
 * OMAHA / PLO (4-card starting hands).
 *
 * No external dependencies. Works in Node and in the browser via the
 * `typeof module` export guard at the bottom.
 *
 * CARD MODEL
 *   52 cards, index 0..51.
 *     rank = idx >> 2   (0 = "2" ... 12 = "A")
 *     suit = idx & 3    (0 = c, 1 = d, 2 = h, 3 = s)
 *   An Omaha hand = 4 DISTINCT card indices.
 *   The total hand space is C(52,4) = 270725.
 *
 * RANGE MODEL
 *   Because the Omaha space is large, a "range" is fundamentally a
 *   PREDICATE  matches(hand) -> bool   over 4-card hands. We also
 *   provide enumerate() which materialises concrete combos:
 *     - exhaustive when the matching set is small (<= cap, default 50000)
 *     - otherwise a uniform random SAMPLE of `max` hands (sampled:true)
 *
 *   parseRange(str) -> { matches, enumerate, describe, warnings }
 *
 *   We NEVER silently fall back to random hands on a bad token. Invalid
 *   or unsupported tokens THROW a clear Error. (Removing that silent
 *   random behaviour is the whole point of this rewrite.)
 *
 * A `hand` passed to matches() may be either:
 *   - an array of 4 integer card indices, or
 *   - an array of 4 card strings (e.g. "As").
 * Internally everything works on integer indices; strings are coerced.
 */

/* =================================================================
 * Card helpers (duplicated here on purpose — this file is fully
 * self-contained; the Hold'em parser owns its own copies).
 * ================================================================= */

var RANK_CHARS = '23456789TJQKA'; // index 0..12
var SUIT_CHARS = 'cdhs';          // index 0..3

function rankOf(card) { return card >> 2; }
function suitOf(card) { return card & 3; }

function rankCharToIdx(ch) {
  var i = RANK_CHARS.indexOf(ch.toUpperCase());
  if (i < 0) throw new Error('Bad rank char: ' + ch);
  return i;
}
function suitCharToIdx(ch) {
  var i = SUIT_CHARS.indexOf(ch.toLowerCase());
  if (i < 0) throw new Error('Bad suit char: ' + ch);
  return i;
}

function cardToStr(card) {
  return RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];
}

function strToCard(s) {
  if (typeof s !== 'string' || s.length !== 2) {
    throw new Error('Bad card string: ' + s);
  }
  return (rankCharToIdx(s[0]) << 2) | suitCharToIdx(s[1]);
}

// Coerce a hand (array of ints or strings) into a sorted int array.
function coerceHand(hand) {
  var a = new Array(4);
  for (var i = 0; i < 4; i++) {
    var c = hand[i];
    a[i] = (typeof c === 'string') ? strToCard(c) : c;
  }
  // sort descending by index so output is stable (high cards first)
  a.sort(function (x, y) { return y - x; });
  return a;
}

// Pretty 4-card-string form, high cards first, e.g. ["As","Ah","Ks","Kd"]
function handToStrs(hand) {
  var a = coerceHand(hand);
  return a.map(cardToStr);
}

/* =================================================================
 * "Low" / rank-class definitions (documented constants)
 * ================================================================= */

// "low" for AALL etc. = ranks 2..8 inclusive.  (rank idx 0..6)
function isLowRank(r) { return r <= 6; }            // 2,3,4,5,6,7,8

// Macro rank classes ($B/$M/$Z/$W/$L/$F/$R). Each is a set of rank idxs.
// Rank idx: 0=2 ... 8=T, 9=J, 10=Q, 11=K, 12=A
var CLASS_BIG       = rankSet('AKQJ');        // $B  big   = A,K,Q,J
var CLASS_MID       = rankSet('T987');        // $M  mid   = T,9,8,7  (per "mid[T-7]")
var CLASS_SMALL     = rankSet('65432');       // $Z  small = 6..2
var CLASS_WHEEL     = rankSet('A2345');       // $W  wheel = A,2,3,4,5
var CLASS_LOW       = rankSet('A8765432');    // $L  low   = A,2..8  (ace plays low)
var CLASS_FACE      = rankSet('KQJ');         // $F  face  = K,Q,J
var CLASS_BROADWAY  = rankSet('AKQJT');       // $R  broadway = A..T

function rankSet(chars) {
  var s = 0;
  for (var i = 0; i < chars.length; i++) s |= (1 << rankCharToIdx(chars[i]));
  return s; // bitmask over 13 ranks
}
function inClass(mask, r) { return (mask & (1 << r)) !== 0; }

/* =================================================================
 * Full-space iteration (used by enumerate + tests).
 * Iterating all 270725 hands is fast (<~30ms) in Node.
 * ================================================================= */

function forEachHand(cb) {
  for (var a = 3; a < 52; a++) {
    for (var b = 2; b < a; b++) {
      for (var c = 1; c < b; c++) {
        for (var d = 0; d < c; d++) {
          // pass descending so cb sees high card first
          cb(a, b, c, d);
        }
      }
    }
  }
}

/* =================================================================
 * Hand feature extraction.
 * Given 4 card indices we precompute the features predicates need.
 * ================================================================= */

function features(c0, c1, c2, c3) {
  var cards = [c0, c1, c2, c3];
  var ranks = [rankOf(c0), rankOf(c1), rankOf(c2), rankOf(c3)];
  var suits = [suitOf(c0), suitOf(c1), suitOf(c2), suitOf(c3)];

  // rank multiset counts
  var rankCount = {};
  for (var i = 0; i < 4; i++) rankCount[ranks[i]] = (rankCount[ranks[i]] || 0) + 1;
  var distinctRanks = Object.keys(rankCount).map(Number).sort(function (a, b) { return b - a; });

  // suit counts (suit -> #cards)
  var suitCount = [0, 0, 0, 0];
  for (var j = 0; j < 4; j++) suitCount[suits[j]]++;
  var suitCountSorted = suitCount.slice().sort(function (a, b) { return b - a; }); // e.g. [2,2,0,0]

  return {
    cards: cards,
    ranks: ranks,            // unsorted, parallel to cards
    suits: suits,
    rankCount: rankCount,
    distinctRanks: distinctRanks, // descending
    suitCount: suitCount,
    suitCountSorted: suitCountSorted
  };
}

/* =================================================================
 * AST node = a predicate factory. parse() produces a function
 * f(features) -> bool. We wrap it for the public matches(hand) API.
 * ================================================================= */

/* ------------------------------------------------------------------
 * TOKENIZER
 * The grammar is a comma/operator separated list of TERMS. Each term
 * is a sequence of "atoms" that are ANDed together (a single hand
 * specification, e.g. "AA$ds" = aces AND double-suited).
 *
 * We split the top level on , : ! and parentheses, then parse each
 * primary token. Primary tokens (no operators, no parens) are handed
 * to parsePrimary().
 * ------------------------------------------------------------------ */

// Operators: , (union, lowest precedence), : (intersection), ! (difference).
// : and ! bind tighter than , (per PPT). () groups.

function parse(str) {
  var pos = 0;
  var s = str;

  function peek() { return s[pos]; }
  function eof() { return pos >= s.length; }
  function skipWs() { while (!eof() && /\s/.test(s[pos])) pos++; }

  // expr := term (',' term)*
  function parseExpr() {
    skipWs();
    var left = parseTerm();
    skipWs();
    while (!eof() && peek() === ',') {
      pos++; // consume ,
      var right = parseTerm();
      let L = left, R = right; // let (not var) so each closure captures its own L/R
      left = function (f) { return L(f) || R(f); }; // union
      skipWs();
    }
    return left;
  }

  // term := factor (( ':' | '!' ) factor)*
  function parseTerm() {
    skipWs();
    var left = parseFactor();
    skipWs();
    while (!eof() && (peek() === ':' || peek() === '!')) {
      var op = peek();
      pos++; // consume op
      var right = parseFactor();
      let L = left, R = right; // let (not var) so each closure captures its own L/R
      if (op === ':') left = function (f) { return L(f) && R(f); };       // intersection
      else            left = function (f) { return L(f) && !R(f); };      // difference
      skipWs();
    }
    return left;
  }

  // factor := '(' expr ')' | primaryToken
  function parseFactor() {
    skipWs();
    if (peek() === '(') {
      pos++; // consume (
      var inner = parseExpr();
      skipWs();
      if (peek() !== ')') throw new Error("Expected ')' in range: " + str);
      pos++; // consume )
      return inner;
    }
    // read a primary token: run of chars until an operator / paren / ws
    var start = pos;
    while (!eof() && ',:!()'.indexOf(peek()) < 0 && !/\s/.test(peek())) pos++;
    var tok = s.slice(start, pos);
    if (tok.length === 0) throw new Error('Empty token in range: ' + str);
    return parsePrimary(tok);
  }

  var pred = parseExpr();
  skipWs();
  if (!eof()) throw new Error('Unexpected trailing input in range: ' + s.slice(pos));
  return pred;
}

/* ------------------------------------------------------------------
 * parsePrimary(tok): turn a single operator-free token into a
 * predicate f(features)->bool. A token is a body + zero or more
 * suffix qualifiers ($ds, $ss, $ns, ss, hh, percentages, +/- ranges).
 *
 * Strategy: split the token into (a) a list of suit-group / macro
 * suffixes and (b) the core rank pattern, then AND them.
 * ------------------------------------------------------------------ */

function parsePrimary(tok) {
  var preds = [];

  // ---- 1. Percentage tokens: "15%" or "15%-30%" ----
  var pct = tok.match(/^(\d+(?:\.\d+)?)%(?:-(\d+(?:\.\d+)?)%?)?$/);
  if (pct) {
    var lo = parseFloat(pct[1]);
    var hi = pct[2] !== undefined ? parseFloat(pct[2]) : 0;
    return percentPredicate(lo, hi);
  }

  // ---- 2. Pure macro filter tokens: $np $nt $B $M $Z $W $L $F $R ----
  if (tok[0] === '$') {
    var macro = macroPredicate(tok);
    if (macro) return macro;
    // else it might be a suit-group like $ds applied to "any" — fall through
  }

  // We will consume suffixes from the END of the token.
  var body = tok;

  // ---- 3. Trailing macro / suit-group qualifiers ($ds,$ss,$ns,$0g..) ----
  // These appear as "...$xx". Pull them off the tail.
  var suitGroupRe = /\$(ds|ss|ns)$/;
  while (true) {
    var m = body.match(suitGroupRe);
    if (!m) break;
    preds.push(suitGroupPredicate(m[1]));
    body = body.slice(0, body.length - m[0].length);
  }

  // gap / rundown-range markers handled in body parsing below.

  // ---- 4. Trailing literal suit-group like "$ss" already done; also bare
  //         literal suit groups appended to a rank body like "KJ*ss" where the
  //         "ss" denotes single-suited. We treat a trailing run of suit chars
  //         (length 2 or 4, even) as a literal suit-group ONLY when it pairs
  //         off the body length. Handled inside parseBody via wxyz too. ----

  if (body.length === 0) {
    // token was purely suit-group qualifiers (e.g. "$ds"): means "any hand
    // that is double-suited". AND of the collected preds = the answer.
    return andAll(preds);
  }

  // ---- 5. Body: rank pattern (possibly with suit variables / literal suits) ----
  preds.push(parseBody(body));
  return andAll(preds);
}

function andAll(preds) {
  if (preds.length === 0) return function () { return true; };
  if (preds.length === 1) return preds[0];
  return function (f) {
    for (var i = 0; i < preds.length; i++) if (!preds[i](f)) return false;
    return true;
  };
}

/* ------------------------------------------------------------------
 * Macro predicates.
 * ------------------------------------------------------------------ */

function macroPredicate(tok) {
  switch (tok) {
    case '$np': // no pair: all four ranks distinct
      return function (f) { return f.distinctRanks.length === 4; };
    case '$nt': // no trips (and no quads): max rank multiplicity <= 2
      return function (f) {
        for (var r in f.rankCount) if (f.rankCount[r] >= 3) return false;
        return true;
      };
    // Rank-class filters: ALL four cards lie in the class.
    case '$B': return classAllPredicate(CLASS_BIG);
    case '$M': return classAllPredicate(CLASS_MID);
    case '$Z': return classAllPredicate(CLASS_SMALL);
    case '$W': return classAllPredicate(CLASS_WHEEL);
    case '$L': return classAllPredicate(CLASS_LOW);
    case '$F': return classAllPredicate(CLASS_FACE);
    case '$R': return classAllPredicate(CLASS_BROADWAY);
    // gap-connector macros without a body: "$0g","$1g","$2g" -> connected
    case '$0g': return gappedRundownPredicate(0);
    case '$1g': return gappedRundownPredicate(1);
    case '$2g': return gappedRundownPredicate(2);
    default:
      return null; // not a recognised pure macro
  }
}

function classAllPredicate(mask) {
  return function (f) {
    for (var i = 0; i < 4; i++) if (!inClass(mask, f.ranks[i])) return false;
    return true;
  };
}

/* ------------------------------------------------------------------
 * Suit-group predicates.
 *   $ds : double-suited  -> suit multiset is exactly {2,2}
 *   $ss : single-suited  -> exactly one suit appears with 2 cards,
 *                           the other two cards are of two DIFFERENT
 *                           further suits (PPT: 2 + 1 + 1, i.e. pattern
 *                           {2,1,1}).
 *   $ns : no-suit / rainbow -> four distinct suits {1,1,1,1}
 * ------------------------------------------------------------------ */

function suitGroupPredicate(kind) {
  switch (kind) {
    case 'ds':
      return function (f) {
        var s = f.suitCountSorted;
        return s[0] === 2 && s[1] === 2;
      };
    case 'ss':
      return function (f) {
        var s = f.suitCountSorted;
        return s[0] === 2 && s[1] === 1 && s[2] === 1;
      };
    case 'ns':
      return function (f) {
        var s = f.suitCountSorted;
        return s[0] === 1; // {1,1,1,1}
      };
    default:
      throw new Error('Unknown suit group: $' + kind);
  }
}

/* ------------------------------------------------------------------
 * Percentage predicate (APPROXIMATE — see note).
 *
 * Exact PPT top-N% ordering is proprietary. We approximate "hand
 * strength" with a documented preflop score and take the hands whose
 * score rank falls in the top [lo, hi]% band. Because score ties are
 * common we compute a global threshold by sampling the score
 * distribution once over the full space (cached).
 *
 * SCORE heuristic (higher = stronger), all components additive:
 *   + pair/structure: each pair +(rankIdx+2)*4 ; trips/quads penalised
 *   + high-card sum
 *   + double-suited bonus, single-suited smaller bonus
 *   + connectedness bonus (small rank spread)
 * This is a coarse proxy and is flagged approximate in describe().
 * ------------------------------------------------------------------ */

var _scoreSorted = null; // ascending array of all scores (cached)

function handScore(f) {
  var score = 0;
  // high-card weight
  for (var i = 0; i < 4; i++) score += f.ranks[i];
  // pair / structure
  for (var r in f.rankCount) {
    var n = f.rankCount[r];
    var ri = Number(r);
    if (n === 2) score += (ri + 2) * 3;     // a pair is good, scaled by rank
    else if (n === 3) score -= 8;           // trips: a dead card, bad in Omaha
    else if (n === 4) score -= 20;          // quads: terrible
  }
  // suit structure
  var s = f.suitCountSorted;
  if (s[0] === 2 && s[1] === 2) score += 10;          // double-suited
  else if (s[0] === 2 && s[1] === 1) score += 4;      // single-suited
  else if (s[0] >= 3) score -= 6;                     // 3+ of one suit: bad
  // connectedness: reward small spread among the four ranks
  var rs = f.ranks.slice().sort(function (a, b) { return a - b; });
  var spread = rs[3] - rs[0];
  if (spread <= 3) score += (4 - spread) * 2;
  return score;
}

function buildScoreDistribution() {
  if (_scoreSorted) return _scoreSorted;
  var arr = new Array(270725);
  var idx = 0;
  forEachHand(function (a, b, c, d) {
    arr[idx++] = handScore(features(a, b, c, d));
  });
  arr.sort(function (x, y) { return x - y; }); // ascending
  _scoreSorted = arr;
  return arr;
}

function percentPredicate(lo, hi) {
  // top lo% .. top hi% band. If hi is 0/absent, band = top lo%.
  var dist = buildScoreDistribution();
  var N = dist.length;
  if (hi === 0) { hi = lo; lo = 0; }       // "15%" -> top 0..15%
  // top X% means scores >= the (100-X) percentile threshold.
  var hiThresh = dist[Math.floor((1 - hi / 100) * N)];      // boundary for the wider (hi%) cut
  var loThresh = (lo > 0) ? dist[Math.floor((1 - lo / 100) * N)] : Infinity;
  // band: score >= hiThresh (inside top hi%) AND score < loThresh (outside top lo%)
  return function (f) {
    var sc = handScore(f);
    if (sc < hiThresh) return false;
    if (lo > 0 && sc >= loThresh) return false;
    return true;
  };
}

/* ------------------------------------------------------------------
 * BODY parser. The body is the rank pattern, possibly carrying suit
 * information (suit variables x/y/z/w, literal suits c/d/h/s) and
 * rundown-range / pair-range markers.
 *
 * We dispatch on shape:
 *   - rundown range "AKQJ-T987" / "9876-"
 *   - pair range    "TT+" / "TT-77"
 *   - named exact-rank pairs "AAKK","AARR","AALL","AA"
 *   - rank-variable patterns "RROO","RRON","JRON","RR","R","O","N"
 *   - rundown "AKQJ" (+ gap markers)
 *   - explicit cards with suits "AsAhKsKd"
 *   - rank+suitvar "AxAyxy"
 *   - rank + literal suit-group "KJ*ss", "sshh"
 *   - blanks "****" / "*"
 * ------------------------------------------------------------------ */

function parseBody(body) {
  // blanks
  if (/^\*+$/.test(body) || body === '*') {
    return function () { return true; };
  }

  // gap markers appended to a body like "AKJT$1g"? We handle "$Ng" only
  // as standalone macros (above). A body ending in a gap marker:
  var gapM = body.match(/\$(\d)g$/);
  if (gapM) {
    var g = Number(gapM[1]);
    var rest = body.slice(0, body.length - gapM[0].length);
    if (rest === '' || /^\*+$/.test(rest)) return gappedRundownPredicate(g);
    // a specific high card + gap, e.g. not commonly used; treat as run starting
    // at that top rank with the given gaps.
    return gappedRundownFromTop(rest, g);
  }

  // rundown range  "AKQJ-T987"  or open-ended  "9876-"
  if (body.indexOf('-') >= 0 && isRundownRangeShape(body)) {
    return rundownRangePredicate(body);
  }

  // named pair + "LL" low suffix, e.g. "AALL" : pair of <rank> + two low cards.
  if (/^([2-9TJQKA])\1LL$/i.test(body)) {
    return namedPlusVariablePredicate(body);
  }

  // pair range  "TT+" or "TT-77"
  var prPlus = body.match(/^([2-9TJQKA])\1\+$/i);
  if (prPlus) {
    var rp = rankCharToIdx(prPlus[1]);
    return pairAtLeastPredicate(rp);
  }
  var prRange = body.match(/^([2-9TJQKA])\1-([2-9TJQKA])\2$/i);
  if (prRange) {
    var hiR = rankCharToIdx(prRange[1]);
    var loR = rankCharToIdx(prRange[2]);
    return pairRangePredicate(Math.min(hiR, loR), Math.max(hiR, loR));
  }

  // explicit cards with suits, e.g. "AsAhKsKd" (each char-pair = rank+suit)
  if (/^([2-9TJQKA][cdhs]){4}$/i.test(body)) {
    return explicitCardsPredicate(body);
  }

  // literal suit-group only, e.g. "sshh" / "sscc" : two of one suit, two of
  // another (a $ds variant pinned to specific suit *labels* — but suit labels
  // in PPT suit-groups are positional, not literal c/d/h/s. We treat a 4-char
  // all-suit body like "sshh" as: suit multiset {2,2} with those two distinct
  // suits being arbitrary — i.e. same as $ds. "sscc" with a REPEATED label is
  // still {2,2}. PPT semantics: distinct labels = distinct suits.)
  var litSuit = body.match(/^([cdhs])\1([cdhs])\2$/i);
  if (litSuit) {
    // pattern AABB style: two of suit-label1, two of suit-label2.
    // If the two labels differ -> double suited; if same (e.g. "ssss")
    // -> all four one suit (monotone).
    var lab1 = body[0].toLowerCase(), lab2 = body[2].toLowerCase();
    if (lab1 === lab2) {
      return function (f) { return f.suitCountSorted[0] === 4; }; // monotone
    }
    return suitGroupPredicate('ds');
  }
  var litMono = body.match(/^([cdhs])\1\1\1$/i);
  if (litMono) {
    return function (f) { return f.suitCountSorted[0] === 4; };
  }

  // rank + suit-variable patterns like "AxAyxy" / "AxAyxz".
  // Shape: alternating rankChar + suitVar(letter from x/y/z/w).
  if (/^([2-9TJQKA*][xyzw]){4}$/i.test(body)) {
    return rankSuitVarPredicate(body);
  }

  // rank pattern with a trailing literal suit-group token like "KJ*ss"
  // (ranks then "ss"). Detect: body = <ranks/blanks>(2 or 4 of cdhs).
  var sgTail = body.match(/^(.*?)((?:[cdhs]{2})|(?:[cdhs]{4}))$/i);
  if (sgTail && sgTail[1].length > 0 && /^[2-9TJQKA*]+$/i.test(sgTail[1])) {
    var rankPart = sgTail[1];
    var suitPart = sgTail[2].toLowerCase();
    var rankPred = rankOnlyPredicate(rankPart);
    var suitPred = (suitPart.length === 2)
      ? suitGroupPredicate('ss')   // "ss" tail -> single-suited
      : suitGroupPredicate('ds');  // "sshh" -> double-suited
    return function (f) { return rankPred(f) && suitPred(f); };
  }

  // rank-variable patterns: tokens made only of R/O/N/0 and named ranks.
  if (/^[RON0]+$/.test(body)) {
    return rankVariablePredicate(body);
  }
  // mixed named-rank + variables, e.g. "JRON", "AARR", "AALL", "AAKK", "AA"
  if (/^[2-9TJQKARON0]+$/i.test(body) && /[RON0]/.test(body)) {
    return namedPlusVariablePredicate(body);
  }

  // pure named ranks: "AA","AAKK","AKQ","A" etc.
  if (/^[2-9TJQKA]+$/i.test(body)) {
    return namedRanksPredicate(body);
  }

  // 'wxyz' rainbow shorthand
  if (/^wxyz$/i.test(body)) {
    return suitGroupPredicate('ns');
  }

  throw new Error('Unsupported / unrecognised token: "' + body + '"');
}

/* ------------------------------------------------------------------
 * Explicit cards: AsAhKsKd -> the hand must be exactly these 4 cards.
 * ------------------------------------------------------------------ */
function explicitCardsPredicate(body) {
  var want = [];
  for (var i = 0; i < 8; i += 2) want.push(strToCard(body.substr(i, 2)));
  // detect duplicate explicit cards (invalid hand)
  var seen = {};
  for (var k = 0; k < want.length; k++) {
    if (seen[want[k]]) throw new Error('Duplicate card in token: ' + body);
    seen[want[k]] = true;
  }
  want.sort(function (a, b) { return a - b; });
  return function (f) {
    var c = f.cards.slice().sort(function (a, b) { return a - b; });
    return c[0] === want[0] && c[1] === want[1] && c[2] === want[2] && c[3] === want[3];
  };
}

/* ------------------------------------------------------------------
 * Named ranks like "AA", "AAKK", "AKQ", "A".
 * Semantics: the listed ranks must be PRESENT with the listed
 * multiplicity; remaining cards (to make 4) are unconstrained.
 *   "AA"   -> at least two aces (other two anything)
 *   "AAKK" -> at least two aces AND at least two kings
 *   "AKQ"  -> at least one A, one K, one Q (+ one anything)
 * ------------------------------------------------------------------ */
function namedRanksPredicate(body) {
  var need = {}; // rankIdx -> required count
  for (var i = 0; i < body.length; i++) {
    var r = rankCharToIdx(body[i]);
    need[r] = (need[r] || 0) + 1;
  }
  // total required must be <= 4
  var tot = 0;
  for (var rr in need) tot += need[rr];
  if (tot > 4) throw new Error('Too many cards required in token: ' + body);
  return function (f) {
    for (var r in need) {
      if ((f.rankCount[r] || 0) < need[r]) return false;
    }
    return true;
  };
}

// "ranks only" helper that ignores blanks ('*' chars) — used for KJ*ss tail.
function rankOnlyPredicate(rankPart) {
  var need = {};
  for (var i = 0; i < rankPart.length; i++) {
    if (rankPart[i] === '*') continue;
    var r = rankCharToIdx(rankPart[i]);
    need[r] = (need[r] || 0) + 1;
  }
  return function (f) {
    for (var r in need) if ((f.rankCount[r] || 0) < need[r]) return false;
    return true;
  };
}

/* ------------------------------------------------------------------
 * Rank VARIABLE patterns: R, O, N, 0(=O).
 *   A letter repeated N times demands a rank present exactly that many
 *   times. DISTINCT letters bind to DISTINCT ranks. Variables will NOT
 *   match a rank that is named explicitly elsewhere in the same token.
 *
 *   RR    -> one pair (some rank appears >=2), other two unconstrained-ish
 *   RROO  -> two pair: rank R paired AND a different rank O paired
 *   RRON  -> rank R paired + two further DISTINCT unpaired ranks O,N
 *   R / O / N standalone -> at least one card of some rank (trivially true
 *            for non-empty hand, but used in combination)
 * ------------------------------------------------------------------ */
function rankVariablePredicate(body) {
  return buildVariablePredicate(parseVarSpec(body, {}));
}

// named ranks + variables, e.g. "JRON","AARR","AALL"
function namedPlusVariablePredicate(body) {
  // AALL special-case: two aces + two LOW cards.
  if (/^AALL$/i.test(body) || /^([2-9TJQKA])\1LL$/i.test(body)) {
    // generic "<rank><rank>LL" : pair of <rank> + two low cards.
    var m = body.match(/^([2-9TJQKA])\1LL$/i);
    var pr = rankCharToIdx(m[1]);
    return function (f) {
      if ((f.rankCount[pr] || 0) < 2) return false;
      // remaining two cards (the non-pair cards) must both be "low" (2..8)
      // and distinct from the pair rank.
      var lows = 0;
      for (var i = 0; i < 4; i++) {
        if (f.ranks[i] === pr) continue;
        if (!isLowRank(f.ranks[i])) return false;
        lows++;
      }
      // need exactly the two non-pair cards low; if hand has trips of pr,
      // there'd be <2 "other" cards -> fail (good, AA wants exactly pair)
      return lows === 2;
    };
  }
  // AARR : a named pair (AA) + another pair (RR), R != A
  var arr = body.match(/^([2-9TJQKA])\1RR$/i);
  if (arr) {
    var ar = rankCharToIdx(arr[1]);
    return function (f) {
      if ((f.rankCount[ar] || 0) < 2) return false;
      // some OTHER rank also paired
      for (var r in f.rankCount) {
        if (Number(r) !== ar && f.rankCount[r] >= 2) return true;
      }
      return false;
    };
  }
  // Generic: parse named ranks as fixed, variables as placeholders.
  var spec = parseVarSpecMixed(body);
  return buildVariablePredicate(spec);
}

// Parse a variable-only spec: returns {groups:[{letter,count}], fixed:{}}.
function parseVarSpec(body, fixed) {
  var counts = {};
  for (var i = 0; i < body.length; i++) {
    var ch = body[i].toUpperCase();
    var key = (ch === '0') ? 'O' : ch; // 0 aliases O
    counts[key] = (counts[key] || 0) + 1;
  }
  var groups = [];
  for (var k in counts) groups.push({ letter: k, count: counts[k] });
  return { groups: groups, fixed: fixed || {} };
}

// Parse a mixed named+variable spec, e.g. "JRON".
function parseVarSpecMixed(body) {
  var fixed = {};     // rankIdx -> count
  var varCounts = {}; // letter -> count
  for (var i = 0; i < body.length; i++) {
    var ch = body[i];
    if (/[RONron0]/.test(ch)) {
      var key = (ch === '0') ? 'O' : ch.toUpperCase();
      varCounts[key] = (varCounts[key] || 0) + 1;
    } else {
      var r = rankCharToIdx(ch);
      fixed[r] = (fixed[r] || 0) + 1;
    }
  }
  var groups = [];
  for (var k in varCounts) groups.push({ letter: k, count: varCounts[k] });
  return { groups: groups, fixed: fixed };
}

/*
 * buildVariablePredicate(spec):
 *   spec.fixed  : map rankIdx -> required count (named explicit ranks)
 *   spec.groups : list of {letter, count} variable groups, each must bind
 *                 to a DISTINCT rank, not equal to any fixed rank, and
 *                 with exactly `count` cards of that rank in the hand.
 *
 * "exactly count" for variables (a paired variable RR means that rank
 * appears with at least 2; but for two-pair RROO we want each to be a
 * genuine distinct pair). We require AT LEAST `count` for the variable
 * rank, and DISTINCTNESS across variable bindings + fixed ranks.
 *
 * Implementation: greedy/exhaustive assignment over distinct ranks
 * present in the hand. Hands are tiny (<=4 cards, <=4 distinct ranks)
 * so we just try all assignments.
 */
function buildVariablePredicate(spec) {
  var fixedRanks = Object.keys(spec.fixed).map(Number);
  var groups = spec.groups;
  return function (f) {
    // check fixed ranks first
    for (var i = 0; i < fixedRanks.length; i++) {
      var fr = fixedRanks[i];
      if ((f.rankCount[fr] || 0) < spec.fixed[fr]) return false;
    }
    if (groups.length === 0) return true;

    // candidate ranks for variables: distinct ranks in the hand NOT used
    // as fixed ranks, that have enough cards for SOME group.
    var avail = f.distinctRanks.filter(function (r) {
      return fixedRanks.indexOf(r) < 0;
    });

    // try to assign each group a distinct available rank with count>=group.count
    return assignGroups(groups, 0, avail, {}, f);
  };
}

function assignGroups(groups, gi, avail, used, f) {
  if (gi >= groups.length) return true;
  var need = groups[gi].count;
  for (var i = 0; i < avail.length; i++) {
    var r = avail[i];
    if (used[r]) continue;
    if ((f.rankCount[r] || 0) >= need) {
      used[r] = true;
      if (assignGroups(groups, gi + 1, avail, used, f)) { used[r] = false; return true; }
      used[r] = false;
    }
  }
  return false;
}

/* ------------------------------------------------------------------
 * Rank+suit-variable patterns: "AxAyxy", "AxAyxz".
 *   Each card = <rankChar><suitVar>. Suit variables (x,y,z,w) that are
 *   the SAME letter must be the SAME suit; DIFFERENT letters must be
 *   DIFFERENT suits.
 *   AxAyxy : aces, suits (x,y,x,y) -> two suits, each twice => double-suited AA
 *   AxAyxz : suits (x,y,x,z) -> suit x twice, y once, z once => single-suited AA
 * Blanks '*' as rankChar mean any rank.
 * ------------------------------------------------------------------ */
function rankSuitVarPredicate(body) {
  // parse into 4 (rankChar, suitVar) pairs
  var spec = [];
  for (var i = 0; i < body.length; i += 2) {
    spec.push({ rank: body[i], suitVar: body[i + 1].toLowerCase() });
  }
  // rank requirements
  var rankNeed = {};
  for (var j = 0; j < spec.length; j++) {
    if (spec[j].rank !== '*') {
      var r = rankCharToIdx(spec[j].rank);
      rankNeed[r] = (rankNeed[r] || 0) + 1;
    }
  }
  // suit-var equality classes: list of varLetters with their multiplicity
  var varList = spec.map(function (s) { return s.suitVar; });

  return function (f) {
    // rank check
    for (var r in rankNeed) if ((f.rankCount[r] || 0) < rankNeed[r]) return false;

    // We must find an assignment of the 4 hand cards to the 4 spec slots so
    // that (a) ranks match each fixed-rank slot, and (b) suit variables are
    // consistent (same letter => same suit, diff letter => diff suit).
    return matchSuitVarAssignment(spec, varList, f);
  };
}

function matchSuitVarAssignment(spec, varList, f) {
  // try all permutations of the 4 cards into the 4 slots (24 perms)
  var cards = f.cards;
  var perms = PERMS4;
  for (var p = 0; p < perms.length; p++) {
    var perm = perms[p];
    var ok = true;
    var varSuit = {}; // letter -> suit
    var suitToVar = {}; // suit -> letter (enforce different letters => diff suits)
    for (var slot = 0; slot < 4; slot++) {
      var card = cards[perm[slot]];
      var sp = spec[slot];
      if (sp.rank !== '*' && rankOf(card) !== rankCharToIdx(sp.rank)) { ok = false; break; }
      var su = suitOf(card);
      var lv = sp.suitVar;
      if (varSuit[lv] === undefined) {
        if (suitToVar[su] !== undefined && suitToVar[su] !== lv) { ok = false; break; }
        varSuit[lv] = su; suitToVar[su] = lv;
      } else if (varSuit[lv] !== su) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

var PERMS4 = (function () {
  var res = [];
  var a = [0, 1, 2, 3];
  function perm(arr, m) {
    if (arr.length === 0) { res.push(m); return; }
    for (var i = 0; i < arr.length; i++) {
      var rest = arr.slice(0, i).concat(arr.slice(i + 1));
      perm(rest, m.concat(arr[i]));
    }
  }
  perm(a, []);
  return res;
})();

/* ------------------------------------------------------------------
 * Pair-or-better range on the "made pair" rank.
 *   TT+   -> hand contains a pair of rank >= T (any rank from T up)
 *   TT-77 -> hand contains a pair of rank within [7,T]
 * "contains a pair" = some rank appears >=2.
 * ------------------------------------------------------------------ */
function pairAtLeastPredicate(minRank) {
  return function (f) {
    for (var r in f.rankCount) {
      if (f.rankCount[r] >= 2 && Number(r) >= minRank) return true;
    }
    return false;
  };
}
function pairRangePredicate(loRank, hiRank) {
  return function (f) {
    for (var r in f.rankCount) {
      if (f.rankCount[r] >= 2) {
        var ri = Number(r);
        if (ri >= loRank && ri <= hiRank) return true;
      }
    }
    return false;
  };
}

/* ------------------------------------------------------------------
 * Rundowns.
 *   "AKQJ" : 4 consecutive DISTINCT ranks present (any suits).
 *            We treat the listed ranks as a required SET (each present
 *            >=1) AND they must be consecutive (they are, by construction).
 *            Actually a rundown token lists the 4 ranks explicitly, so we
 *            just require those 4 ranks present.
 *   Rundown RANGE "AKQJ-T987" : union of all consecutive-4 rundowns whose
 *            TOP card runs from A down to T (the two endpoints' top cards).
 *   "9876-" : this rundown and all LOWER ones (top card from 9 down to the
 *             lowest possible consecutive-4, i.e. top card 5 -> 5432).
 * ------------------------------------------------------------------ */

// Predicate: hand contains the 4 given consecutive ranks (top..top-3).
function rundownAtTop(topRank) {
  // need ranks topRank, topRank-1, topRank-2, topRank-3 all present
  if (topRank < 3) return function () { return false; };
  var need = [topRank, topRank - 1, topRank - 2, topRank - 3];
  return function (f) {
    for (var i = 0; i < 4; i++) if (!(f.rankCount[need[i]] >= 1)) return false;
    return true;
  };
}

function isRundownRangeShape(body) {
  // shapes: "AKQJ-T987"  or  "9876-"
  if (/^[2-9TJQKA]{4}-$/i.test(body)) return true;
  if (/^[2-9TJQKA]{4}-[2-9TJQKA]{4}$/i.test(body)) return true;
  return false;
}

function rundownRangePredicate(body) {
  var openEnded = /-$/.test(body);
  var parts = body.split('-');
  var topHi = topRankOfRundown(parts[0]);
  var topLo;
  if (openEnded) {
    topLo = 3; // lowest top rank => 5432 (top idx 3)
  } else {
    topLo = topRankOfRundown(parts[1]);
  }
  var hi = Math.max(topHi, topLo);
  var lo = Math.min(topHi, topLo);
  // union of rundownAtTop for top in [lo..hi]
  var preds = [];
  for (var t = lo; t <= hi; t++) preds.push(rundownAtTop(t));
  return function (f) {
    for (var i = 0; i < preds.length; i++) if (preds[i](f)) return true;
    return false;
  };
}

function topRankOfRundown(s) {
  // validate it's actually 4 consecutive descending ranks; return top idx
  var rs = [];
  for (var i = 0; i < s.length; i++) rs.push(rankCharToIdx(s[i]));
  for (var j = 1; j < rs.length; j++) {
    if (rs[j] !== rs[j - 1] - 1) throw new Error('Not a valid rundown: ' + s);
  }
  return rs[0];
}

/* ------------------------------------------------------------------
 * Gapped connectors.
 *   $0g : 0-gap  -> 4 cards forming 4 consecutive ranks (= a rundown,
 *                   any top). Equivalent to "some rundown".
 *   $1g : 1-gap  -> 4 distinct ranks spanning a window with exactly one
 *                   internal gap: i.e. the 4 ranks fit in a span of 4
 *                   (max-min == 4) and are distinct. (One rank in the
 *                   5-wide window is missing.)
 *   $2g : 2-gap  -> 4 distinct ranks with max-min == 5 (two internal
 *                   gaps within a 6-wide window).
 * We require all four ranks DISTINCT (a connected drawing hand).
 * ------------------------------------------------------------------ */
function gappedRundownPredicate(gaps) {
  var span = 3 + gaps; // max-min for 4 distinct ranks with `gaps` internal gaps
  return function (f) {
    if (f.distinctRanks.length !== 4) return false; // must be 4 distinct ranks
    var rs = f.distinctRanks; // descending
    return (rs[0] - rs[3]) === span;
  };
}

// "9876$1g" style: top rank fixed, with given gaps below it.
function gappedRundownFromTop(rankPart, gaps) {
  // take the first rank char as the top
  var top = rankCharToIdx(rankPart[0]);
  var span = 3 + gaps;
  return function (f) {
    if (f.distinctRanks.length !== 4) return false;
    var rs = f.distinctRanks;
    return rs[0] === top && (rs[0] - rs[3]) === span;
  };
}

/* =================================================================
 * Public API
 * ================================================================= */

function makeMatches(predFn) {
  return function (hand) {
    var a = coerceHand(hand); // descending int array
    var f = features(a[0], a[1], a[2], a[3]);
    return predFn(f);
  };
}

var ENUM_CAP = 50000;

function makeEnumerate(predFn) {
  return function (opts) {
    opts = opts || {};
    var max = opts.max || 1000;
    var dead = buildDeadSet(opts.dead); // boolean array length 52

    // First pass: count (and collect up to cap) matching hands honoring dead.
    var collected = [];
    var count = 0;
    var overCap = false;
    forEachHand(function (a, b, c, d) {
      if (dead && (dead[a] || dead[b] || dead[c] || dead[d])) return;
      var f = features(a, b, c, d);
      if (predFn(f)) {
        count++;
        if (!overCap) {
          collected.push([a, b, c, d]);
          if (collected.length > ENUM_CAP) overCap = true;
        }
      }
    });

    if (!overCap) {
      // exhaustive set is small; return all (or up to max if caller wants fewer)
      var combos = collected.map(function (h) {
        return [cardToStr(h[0]), cardToStr(h[1]), cardToStr(h[2]), cardToStr(h[3])];
      });
      return { combos: combos, total: count, sampled: false };
    }

    // Large matching set -> uniform random sample of `max` hands via
    // rejection sampling against the predicate (and dead cards).
    var sample = [];
    var seen = {};
    var attempts = 0;
    var maxAttempts = max * 200 + 10000;
    while (sample.length < max && attempts < maxAttempts) {
      attempts++;
      var h = randomHand(dead);
      if (!h) continue;
      var key = h[0] + ',' + h[1] + ',' + h[2] + ',' + h[3];
      if (seen[key]) continue;
      var ff = features(h[0], h[1], h[2], h[3]);
      if (predFn(ff)) {
        seen[key] = true;
        sample.push([cardToStr(h[0]), cardToStr(h[1]), cardToStr(h[2]), cardToStr(h[3])]);
      }
    }
    return { combos: sample, total: count, sampled: true };
  };
}

// Returns a boolean array of length 52 (or null if no dead cards).
// NOTE: we use a boolean array, NOT a bitmask — JS bitwise ops are 32-bit
// and card indices run 0..51, so `1 << idx` would overflow for idx >= 32.
function buildDeadSet(dead) {
  if (!dead || dead.length === 0) return null;
  var set = new Array(52).fill(false);
  for (var i = 0; i < dead.length; i++) {
    var c = dead[i];
    var idx = (typeof c === 'string') ? strToCard(c) : c;
    set[idx] = true;
  }
  return set;
}

function randomHand(dead) {
  // pick 4 distinct non-dead cards
  var picked = [];
  var used = new Array(52).fill(false);
  var guard = 0;
  while (picked.length < 4 && guard < 500) {
    guard++;
    var c = (Math.random() * 52) | 0;
    if (used[c]) continue;
    if (dead && dead[c]) continue;
    used[c] = true;
    picked.push(c);
  }
  if (picked.length < 4) return null;
  picked.sort(function (a, b) { return b - a; });
  return picked;
}

function parseRange(str) {
  if (typeof str !== 'string' || str.trim() === '') {
    throw new Error('Empty range string');
  }
  var warnings = [];
  // flag percentage approximation
  if (/\d+(?:\.\d+)?%/.test(str)) {
    warnings.push('Percentage ranges use an APPROXIMATE preflop-strength heuristic; ' +
      'exact ProPokerTools top-N% ordering is proprietary and not reproduced.');
  }
  var predFn = parse(str);
  return {
    matches: makeMatches(predFn),
    enumerate: makeEnumerate(predFn),
    describe: function () {
      return 'Omaha range: "' + str + '"' +
        (warnings.length ? ' [' + warnings.join(' ') + ']' : '');
    },
    warnings: warnings
  };
}

/* =================================================================
 * Exports (Node + browser)
 * ================================================================= */

var API = {
  parseRange: parseRange,
  // expose helpers for tests
  _internals: {
    forEachHand: forEachHand,
    features: features,
    cardToStr: cardToStr,
    strToCard: strToCard,
    handToStrs: handToStrs,
    coerceHand: coerceHand,
    rankOf: rankOf,
    suitOf: suitOf,
    parse: parse
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else if (typeof window !== 'undefined') {
  window.PPTOmaha = API;
}
