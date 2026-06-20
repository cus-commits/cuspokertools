// [wrapped in IIFE for safe classic-script loading in the browser:
//  prevents top-level decls (RANKS/SUITS/parseRange/API/etc.) from
//  leaking to the global scope and colliding with the app or each other.
//  module.exports and window.X assignments still work inside the IIFE.]
;(function(){
/*
 * ppt-holdem.js
 *
 * A standalone parser for the ProPokerTools "Simple Range Syntax" for
 * Texas Hold'em. Self-contained, no external dependencies. Works in Node
 * (via module.exports) and in the browser (via window.PPTHoldem).
 *
 * Public API:
 *   parseRange(str, opts)  -> { combos: [[cardA,cardB],...], count, warnings, weights? }
 *   normalizeCard(str)     -> "Ah" style card string
 *   RANKS, SUITS           -> constants
 *
 * combos: array of 2-card hands. Each hand is a 2-element array of card
 *   strings (e.g. ["As","Kh"]) sorted high-rank-first, then by suit.
 * count: combos.length
 * warnings: array of non-fatal advisory strings
 * weights: present only when at least one weighted token (@N) was used.
 *   It is an object keyed by the canonical combo key ("AsKh") -> weight
 *   number (0..100, default 100). Combos without an explicit weight are
 *   not listed in `weights` (treated as weight 100).
 *
 * On genuinely invalid / unsupported input parseRange THROWS an Error.
 */

'use strict';

// --------------------------------------------------------------------------
// Card model
// --------------------------------------------------------------------------
// rank value: 0 = '2' .. 12 = 'A'
// suit value: 0='c',1='d',2='h',3='s'
var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
var SUITS = ['c', 'd', 'h', 's'];

var RANK_INDEX = {};
for (var ri = 0; ri < RANKS.length; ri++) RANK_INDEX[RANKS[ri]] = ri;
var SUIT_INDEX = {};
for (var si = 0; si < SUITS.length; si++) SUIT_INDEX[SUITS[si]] = si;

function rankVal(ch) {
  var v = RANK_INDEX[ch.toUpperCase()];
  if (v === undefined) return -1;
  return v;
}
function suitVal(ch) {
  var v = SUIT_INDEX[ch.toLowerCase()];
  if (v === undefined) return -1;
  return v;
}

// Normalize a rank token, mapping "10" -> "T".
function normRankToken(tok) {
  if (tok === '10') return 'T';
  return tok.toUpperCase();
}

// A card is represented internally as an integer 0..51: rank*4 + suit.
function cardId(rank, suit) { return rank * 4 + suit; }
function cardStr(id) {
  return RANKS[Math.floor(id / 4)] + SUITS[id % 4];
}
function cardRank(id) { return Math.floor(id / 4); }
function cardSuit(id) { return id % 4; }

// Parse a single card string like "Ah", "Tc", "10c" -> internal id, or -1.
function parseCardId(str) {
  var s = str.trim();
  var rankPart, suitPart;
  if (s.length === 3 && s.slice(0, 2) === '10') {
    rankPart = 'T';
    suitPart = s[2];
  } else if (s.length === 2) {
    rankPart = s[0];
    suitPart = s[1];
  } else {
    return -1;
  }
  var r = rankVal(rankPart);
  var su = suitVal(suitPart);
  if (r < 0 || su < 0) return -1;
  return cardId(r, su);
}

// Public helper: normalize a single card to "Ah" canonical form.
function normalizeCard(str) {
  var id = parseCardId(str);
  if (id < 0) throw new Error('Invalid card: "' + str + '"');
  return cardStr(id);
}

// --------------------------------------------------------------------------
// Combo representation
// --------------------------------------------------------------------------
// Internally a combo is a single integer key: hi*52 + lo, where hi > lo are
// the two card ids (hi is the larger id). This makes combos hashable and
// dedup trivial. We render to ["As","Kh"] on output, high card first.

function comboKey(idA, idB) {
  var hi = Math.max(idA, idB);
  var lo = Math.min(idA, idB);
  return hi * 52 + lo;
}
function comboCards(key) {
  var hi = Math.floor(key / 52);
  var lo = key % 52;
  // Output high-rank-first; if same rank, higher suit first (consistent order).
  if (cardRank(hi) === cardRank(lo)) {
    // hi already has the larger id => larger suit, keep as-is
    return [cardStr(hi), cardStr(lo)];
  }
  // hi has larger id which means larger rank*4 => larger rank (or equal rank
  // handled above), so hi is the higher card.
  return [cardStr(hi), cardStr(lo)];
}

// A "RangeSet" is a Set of combo keys plus a weights map (key->weight).
function newSet() { return { set: new Set(), weights: new Map() }; }
function addCombo(rs, idA, idB, weight) {
  if (idA === idB) return;
  var k = comboKey(idA, idB);
  rs.set.add(k);
  if (weight !== undefined && weight !== null) rs.weights.set(k, weight);
}

// --------------------------------------------------------------------------
// 169-hand equity-ordered preflop list (for percentages)
// --------------------------------------------------------------------------
// Ordering source: a deterministic heads-up "equity vs random" hand-strength
// score (the same idea behind the canonical 169-hand all-in equity ranking
// used by PokerStove / ProPokerTools default ordering). Index 0 = strongest.
// This is used ONLY to resolve percentage bands. Building it programmatically
// (rather than hand-typing 169 labels) guarantees exactly 169 unique, valid
// hand classes and is fully reproducible.

// --- Programmatic, guaranteed-complete 169 ordering -----------------------
// Strategy: rank the 169 hand classes by a deterministic strength score
// (an approximation of heads-up equity vs random) and use that order. This
// avoids any hand-typed errors and always yields exactly 169 unique classes.
function buildPreflop169() {
  var classes = [];
  for (var hi = 12; hi >= 0; hi--) {
    for (var lo = hi; lo >= 0; lo--) {
      if (hi === lo) {
        classes.push({ label: RANKS[hi] + RANKS[hi], type: 'pair', hi: hi, lo: lo });
      } else {
        classes.push({ label: RANKS[hi] + RANKS[lo] + 's', type: 's', hi: hi, lo: lo });
        classes.push({ label: RANKS[hi] + RANKS[lo] + 'o', type: 'o', hi: hi, lo: lo });
      }
    }
  }
  // Deterministic strength heuristic (approx HU all-in equity). Higher = stronger.
  function score(c) {
    var hi = c.hi, lo = c.lo;
    var s = 0;
    if (c.type === 'pair') {
      // pairs strong; scale with rank
      s = 60 + hi * 6;            // 22=60 .. AA=132
    } else {
      var highCard = hi;          // 0..12
      var lowCard = lo;
      var gap = hi - lo;          // 1..12
      s = highCard * 5 + lowCard * 2;
      // connectedness bonus (straight potential), bigger for small gaps
      if (gap === 1) s += 6;
      else if (gap === 2) s += 4;
      else if (gap === 3) s += 2;
      else if (gap === 4) s += 1;
      // suitedness
      if (c.type === 's') s += 8;
      // high-card / broadway bonus
      if (lowCard >= 8) s += 3;   // both T+
      if (highCard === 12) s += 4; // ace-high gets extra
    }
    return s;
  }
  classes.sort(function (a, b) {
    var d = score(b) - score(a);
    if (d !== 0) return d;
    // tie-break deterministically by label
    return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
  });
  return classes.map(function (c) { return c.label; });
}

var PREFLOP_ORDERED = buildPreflop169();

// Number of concrete combos for a 169-class label.
function classComboCount(label) {
  if (label.length === 2) return 6;       // pair
  if (label[2] === 's') return 4;
  return 12;                               // offsuit
}

// Expand a 169-class label into concrete combos -> array of [idA,idB].
function expandClass(label) {
  var out = [];
  if (label.length === 2) {
    var r = rankVal(label[0]);
    for (var a = 0; a < 4; a++) for (var b = a + 1; b < 4; b++) {
      out.push([cardId(r, a), cardId(r, b)]);
    }
    return out;
  }
  var hi = rankVal(label[0]);
  var lo = rankVal(label[1]);
  var suited = label[2] === 's';
  if (suited) {
    for (var su = 0; su < 4; su++) out.push([cardId(hi, su), cardId(lo, su)]);
  } else {
    for (var s1 = 0; s1 < 4; s1++) for (var s2 = 0; s2 < 4; s2++) {
      if (s1 !== s2) out.push([cardId(hi, s1), cardId(lo, s2)]);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Token expanders -> each returns a RangeSet
// --------------------------------------------------------------------------

// Total preflop combos = 1326.
var TOTAL_COMBOS = 1326;

function setFromCombos(combos) {
  var rs = newSet();
  for (var i = 0; i < combos.length; i++) addCombo(rs, combos[i][0], combos[i][1]);
  return rs;
}

// Percentage band: classes whose cumulative-combo coverage falls within
// [loFrac, hiFrac] of 1326 combos. We add whole classes greedily in
// PREFLOP_ORDERED until we cover the band. A class is INCLUDED if any part
// of its combo-span overlaps the [loCount, hiCount) target window.
function buildPercentSet(loPct, hiPct) {
  var loCount = Math.round((loPct / 100) * TOTAL_COMBOS);
  var hiCount = Math.round((hiPct / 100) * TOTAL_COMBOS);
  var rs = newSet();
  var cum = 0;
  for (var i = 0; i < PREFLOP_ORDERED.length; i++) {
    var label = PREFLOP_ORDERED[i];
    var n = classComboCount(label);
    var classLo = cum;          // combos before this class
    var classHi = cum + n;      // combos after this class
    // overlap of [classLo,classHi) with [loCount,hiCount)
    if (classLo < hiCount && classHi > loCount) {
      var combos = expandClass(label);
      for (var j = 0; j < combos.length; j++) addCombo(rs, combos[j][0], combos[j][1]);
    }
    cum = classHi;
    if (cum >= hiCount) break;
  }
  return rs;
}

// All 1326 combos (for ** and * helpers).
function buildAllCombos() {
  var rs = newSet();
  for (var a = 0; a < 52; a++) for (var b = a + 1; b < 52; b++) {
    addCombo(rs, a, b);
  }
  return rs;
}

// All suited (same suit) or offsuit (different suit, includes pairs which are
// always offsuit) combos. mode = 'suited' | 'offsuit'.
function buildSuitedness(mode) {
  var rs = newSet();
  for (var a = 0; a < 52; a++) for (var b = a + 1; b < 52; b++) {
    var sameSuit = cardSuit(a) === cardSuit(b);
    if (mode === 'suited' && sameSuit) addCombo(rs, a, b);
    else if (mode === 'offsuit' && !sameSuit) addCombo(rs, a, b);
  }
  return rs;
}

// Combos where at least one card belongs to `rankSet` (a Set of rank vals)
// and the OTHER card is any card (the "single rank plus" / "*" with a rank).
function buildRankPresence(rankSet) {
  var rs = newSet();
  for (var a = 0; a < 52; a++) for (var b = a + 1; b < 52; b++) {
    if (rankSet.has(cardRank(a)) || rankSet.has(cardRank(b))) addCombo(rs, a, b);
  }
  return rs;
}

// --------------------------------------------------------------------------
// Tokenizer + recursive-descent parser for the range expression grammar
// --------------------------------------------------------------------------
// Grammar (lowest -> highest precedence):
//   union      := diff ( ',' diff )*
//   diff       := isect ( '!' isect )*           // left assoc
//   isect      := atom  ( ':' isect )?           // (handle chains)
//   atom       := '(' union ')' | token
//
// ':' and '!' bind tighter than ','. We implement ':' and '!' at the same
// tighter level, left-associative, evaluated left to right.

function makeCursor(s) {
  return { s: s, i: 0, n: s.length };
}
function peek(c) { return c.i < c.n ? c.s[c.i] : null; }
function next(c) { return c.i < c.n ? c.s[c.i++] : null; }
function eof(c) { return c.i >= c.n; }
function skipWs(c) { while (c.i < c.n && /\s/.test(c.s[c.i])) c.i++; }

// Set algebra
function unionSets(a, b) {
  var rs = newSet();
  a.set.forEach(function (k) { rs.set.add(k); });
  b.set.forEach(function (k) { rs.set.add(k); });
  a.weights.forEach(function (v, k) { rs.weights.set(k, v); });
  b.weights.forEach(function (v, k) { rs.weights.set(k, v); });
  return rs;
}
function intersectSets(a, b) {
  var rs = newSet();
  a.set.forEach(function (k) { if (b.set.has(k)) rs.set.add(k); });
  rs.set.forEach(function (k) {
    if (a.weights.has(k)) rs.weights.set(k, a.weights.get(k));
    else if (b.weights.has(k)) rs.weights.set(k, b.weights.get(k));
  });
  return rs;
}
function differenceSets(a, b) {
  var rs = newSet();
  a.set.forEach(function (k) { if (!b.set.has(k)) rs.set.add(k); });
  rs.set.forEach(function (k) { if (a.weights.has(k)) rs.weights.set(k, a.weights.get(k)); });
  return rs;
}

function parseUnion(c, ctx) {
  var left = parseDiffIsect(c, ctx);
  for (;;) {
    skipWs(c);
    if (peek(c) === ',') {
      next(c);
      var right = parseDiffIsect(c, ctx);
      left = unionSets(left, right);
    } else break;
  }
  return left;
}

// handles ':' and '!' left-to-right at a tighter precedence than ','
function parseDiffIsect(c, ctx) {
  var left = parseAtom(c, ctx);
  for (;;) {
    skipWs(c);
    var ch = peek(c);
    if (ch === ':') {
      next(c);
      var r1 = parseAtom(c, ctx);
      left = intersectSets(left, r1);
    } else if (ch === '!') {
      next(c);
      var r2 = parseAtom(c, ctx);
      left = differenceSets(left, r2);
    } else break;
  }
  return left;
}

function parseAtom(c, ctx) {
  skipWs(c);
  var ch = peek(c);
  if (ch === '(') {
    next(c);
    var inner = parseUnion(c, ctx);
    skipWs(c);
    if (peek(c) !== ')') throw new Error('Unbalanced parentheses in range');
    next(c);
    return inner;
  }
  return parseToken(c, ctx);
}

// --------------------------------------------------------------------------
// Token-level parsing (single range primitives)
// --------------------------------------------------------------------------
// A token is the run of characters up to the next top-level operator
// (',', ':', '!', ')') that is not inside brackets. We then interpret it.

function readTokenText(c) {
  skipWs(c);
  var start = c.i;
  var depthBr = 0;
  var buf = '';
  while (c.i < c.n) {
    var ch = c.s[c.i];
    if (ch === '[') { depthBr++; buf += ch; c.i++; continue; }
    if (ch === ']') { depthBr--; buf += ch; c.i++; continue; }
    if (depthBr === 0 && (ch === ',' || ch === ':' || ch === '!' || ch === ')' || ch === '(')) break;
    buf += ch;
    c.i++;
  }
  if (depthBr !== 0) throw new Error('Unbalanced brackets in token: "' + buf + '"');
  return buf.trim();
}

function parseToken(c, ctx) {
  var text = readTokenText(c);
  if (text === '') throw new Error('Empty token in range expression');
  var rs = interpretToken(text, ctx);
  return rs;
}

// --------------------------------------------------------------------------
// interpretToken: the heart of the grammar. Dispatch on the token shape.
// --------------------------------------------------------------------------
function interpretToken(tok, ctx) {
  var original = tok;

  // strip a trailing weight @N
  var weight = null;
  var atIdx = tok.indexOf('@');
  if (atIdx >= 0) {
    var wstr = tok.slice(atIdx + 1).trim();
    tok = tok.slice(0, atIdx).trim();
    if (!/^\d+(\.\d+)?$/.test(wstr)) throw new Error('Invalid weight in "' + original + '"');
    weight = parseFloat(wstr);
    if (weight > 100) throw new Error('Weight out of range (must be 0..100) in "' + original + '"');
    ctx.weighted = true;
  }

  // percentages: "15%" or "15%-30%"
  if (/%/.test(tok)) {
    var rs = interpretPercent(tok);
    if (weight !== null) applyWeight(rs, weight);
    return rs;
  }

  // bracket constructs: contains '['
  if (tok.indexOf('[') >= 0) {
    var rsb = interpretBracket(tok);
    if (weight !== null) applyWeight(rsb, weight);
    return rsb;
  }

  // wildcards made of only '*'
  if (/^\*+$/.test(tok)) {
    var rsw;
    if (tok === '*') {
      // single any card paired with any other card = all 1326 combos
      rsw = buildAllCombos();
    } else if (tok === '**') {
      rsw = buildAllCombos();
    } else {
      throw new Error('Unsupported wildcard token "' + original + '"');
    }
    if (weight !== null) applyWeight(rsw, weight);
    return rsw;
  }

  // Suitedness keywords (PPT pattern shorthands, case-insensitive):
  //   xx -> any suited hand (the two cards share a suit)
  //   xy -> any offsuit (non-pair) hand
  // These are distinct from the rank tokens below because they are pure
  // suitedness predicates over all ranks.
  if (/^xx$/i.test(tok)) {
    var rsx = buildSuitedness('suited');
    if (weight !== null) applyWeight(rsx, weight);
    return rsx;
  }
  if (/^xy$/i.test(tok)) {
    var rsy = buildSuitedness('offsuit');
    if (weight !== null) applyWeight(rsy, weight);
    return rsy;
  }

  // Normalize "10" occurrences to "T" inside the token (rank only).
  tok = tok.replace(/10/g, 'T');

  // Now handle the rank-based grammar.
  var rs2 = interpretRankToken(tok, original);
  if (weight !== null) applyWeight(rs2, weight);
  return rs2;
}

function applyWeight(rs, weight) {
  rs.set.forEach(function (k) { rs.weights.set(k, weight); });
}

// percentages -------------------------------------------------------------
function interpretPercent(tok) {
  // forms: "N%" or "N%-M%"  (also accept "N-M%" loosely)
  var m;
  if ((m = tok.match(/^(\d+(?:\.\d+)?)%\s*-\s*(\d+(?:\.\d+)?)%$/))) {
    var lo = parseFloat(m[1]); var hi = parseFloat(m[2]);
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    if (hi > 100 || lo < 0) throw new Error('Percentage out of range: "' + tok + '"');
    return buildPercentSet(lo, hi);
  }
  if ((m = tok.match(/^(\d+(?:\.\d+)?)%$/))) {
    var p = parseFloat(m[1]);
    if (p > 100 || p < 0) throw new Error('Percentage out of range: "' + tok + '"');
    return buildPercentSet(0, p);
  }
  throw new Error('Malformed percentage token: "' + tok + '"');
}

// brackets ----------------------------------------------------------------
// Two forms:
//   [X][Y]   -> two positions; each [..] is a card-class spec for one card.
//   X[list]  -> one fixed card-ish position + a bracket list for the other.
// A bracket spec resolves to a set of "card patterns": each pattern is a
// {rank, suit|null}. The combo = pair one card matching spec1 with one card
// matching spec2 (rank-distinct or suit-distinct enforced by card identity).
function interpretBracket(tok) {
  var specs = parseBracketPositions(tok);
  if (specs.length !== 2) {
    throw new Error('Bracket range must resolve to exactly two card positions: "' + tok + '"');
  }
  var posA = expandCardSpec(specs[0]);
  var posB = expandCardSpec(specs[1]);
  var rs = newSet();
  for (var i = 0; i < posA.length; i++) {
    for (var j = 0; j < posB.length; j++) {
      if (posA[i] !== posB[j]) addCombo(rs, posA[i], posB[j]);
    }
  }
  return rs;
}

// Split a bracket token into exactly two position specs. A position is
// either a [...] group or a single bare card-rank/card. We scan left->right.
function parseBracketPositions(tok) {
  var positions = [];
  var i = 0;
  while (i < tok.length) {
    var ch = tok[i];
    if (ch === '[') {
      var depth = 1; var j = i + 1;
      while (j < tok.length && depth > 0) {
        if (tok[j] === '[') depth++;
        else if (tok[j] === ']') depth--;
        j++;
      }
      if (depth !== 0) throw new Error('Unbalanced brackets: "' + tok + '"');
      positions.push({ kind: 'bracket', body: tok.slice(i + 1, j - 1) });
      i = j;
    } else if (/\s/.test(ch)) {
      i++;
    } else {
      // bare token: a rank, "10", or a full card (rank+suit). Grab a minimal
      // unit: try card (2 chars) then rank (1 char) / "10".
      if (tok.slice(i, i + 2) === '10') {
        positions.push({ kind: 'rank', body: 'T' });
        i += 2;
      } else {
        // could be a full "As" card or a bare rank
        var two = tok.slice(i, i + 2);
        if (two.length === 2 && rankVal(two[0]) >= 0 && suitVal(two[1]) >= 0) {
          positions.push({ kind: 'card', body: normalizeCard(two) });
          i += 2;
        } else if (rankVal(ch) >= 0) {
          positions.push({ kind: 'rank', body: ch.toUpperCase() });
          i += 1;
        } else {
          throw new Error('Unexpected character "' + ch + '" in bracket token "' + tok + '"');
        }
      }
    }
  }
  return positions;
}

// Expand a position spec into a list of concrete card ids it can take.
function expandCardSpec(spec) {
  if (spec.kind === 'card') {
    return [parseCardId(spec.body)];
  }
  if (spec.kind === 'rank') {
    var r = rankVal(spec.body);
    var out = [];
    for (var s = 0; s < 4; s++) out.push(cardId(r, s));
    return out;
  }
  // bracket body: comma-separated entries. Each entry is one of:
  //   - a rank range "A-J" / "2-5"
  //   - a "rank+" e.g. "T+"
  //   - a specific card "Jc"
  //   - a bare rank "T" (all suits)
  var body = spec.body;
  var entries = body.split(',');
  var idsSet = new Set();
  for (var e = 0; e < entries.length; e++) {
    var entry = entries[e].trim();
    if (entry === '') continue;
    entry = entry.replace(/10/g, 'T');
    addBracketEntry(entry, idsSet, body);
  }
  return Array.from(idsSet);
}

function addBracketEntry(entry, idsSet, ctxBody) {
  // rank range  e.g. "A-J", "2-5"
  var m;
  if ((m = entry.match(/^([2-9TJQKA])\s*-\s*([2-9TJQKA])$/i))) {
    var r1 = rankVal(m[1]); var r2 = rankVal(m[2]);
    var lo = Math.min(r1, r2), hi = Math.max(r1, r2);
    for (var r = lo; r <= hi; r++) for (var s = 0; s < 4; s++) idsSet.add(cardId(r, s));
    return;
  }
  // rank-plus  e.g. "T+"
  if ((m = entry.match(/^([2-9TJQKA])\+$/i))) {
    var base = rankVal(m[1]);
    for (var rr = base; rr <= 12; rr++) for (var ss = 0; ss < 4; ss++) idsSet.add(cardId(rr, ss));
    return;
  }
  // specific card  e.g. "Jc"
  if (entry.length === 2 && rankVal(entry[0]) >= 0 && suitVal(entry[1]) >= 0) {
    idsSet.add(parseCardId(entry));
    return;
  }
  // bare rank  e.g. "T"
  if (entry.length === 1 && rankVal(entry) >= 0) {
    var br = rankVal(entry);
    for (var s2 = 0; s2 < 4; s2++) idsSet.add(cardId(br, s2));
    return;
  }
  throw new Error('Unrecognized bracket entry "' + entry + '" in "[' + ctxBody + ']"');
}

// --------------------------------------------------------------------------
// Rank-based tokens (the bulk of the grammar)
// --------------------------------------------------------------------------
function interpretRankToken(tok, original) {
  // 1) Suit-specific dash, e.g. "AhKh-AhTh"  (both endpoints full 4-char cards)
  if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]-[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/i.test(tok)) {
    return interpretSuitSpecificDash(tok);
  }

  // 2) Class dash, e.g. "77-TT", "A2s-A5s", "K8s-K5s", "AJo-ATo"
  if (tok.indexOf('-') >= 0) {
    return interpretClassDash(tok, original);
  }

  // 3) Specific two-card combo, e.g. "AsKh"
  if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/i.test(tok)) {
    var a = parseCardId(tok.slice(0, 2));
    var b = parseCardId(tok.slice(2, 4));
    if (a === b) throw new Error('A combo cannot use the same card twice: "' + original + '"');
    var rs = newSet();
    addCombo(rs, a, b);
    return rs;
  }

  // 4) Single specific card + plus: "Q+"  (rank presence: any hand with a
  //    card of rank >= Q)
  var mPlus;
  if ((mPlus = tok.match(/^([2-9TJQKA])\+$/i))) {
    var base = rankVal(mPlus[1]);
    var rankSet = new Set();
    for (var r = base; r <= 12; r++) rankSet.add(r);
    return buildRankPresence(rankSet);
  }

  // 5) Single specific card alone: "As" -> any hand containing that card?
  //    PPT treats a single card with suit as "any hand containing that card".
  if (/^[2-9TJQKA][cdhs]$/i.test(tok)) {
    var cid = parseCardId(tok);
    return buildCardPresence(cid);
  }

  // 6) Two-rank with optional suitedness and optional '+'
  //    forms: "AK", "AKs", "AKo", "AK$s", "AK$o", "AJs+", "AJo+", "AK+", "KQ+"
  //    pairs: "AA", "TT+", "QQ+"
  return interpretRankPairToken(tok, original);
}

// any hand containing a specific card
function buildCardPresence(cid) {
  var rs = newSet();
  for (var other = 0; other < 52; other++) {
    if (other === cid) continue;
    addCombo(rs, cid, other);
  }
  return rs;
}

// suit-specific dash: AhKh-AhTh
function interpretSuitSpecificDash(tok) {
  var parts = tok.split('-');
  var leftA = parseCardId(parts[0].slice(0, 2));
  var leftB = parseCardId(parts[0].slice(2, 4));
  var rightA = parseCardId(parts[1].slice(0, 2));
  var rightB = parseCardId(parts[1].slice(2, 4));
  // Determine which card is fixed (same in both endpoints) and which varies.
  var fixed, varLo, varHi, varSuitMustMatch;
  if (leftA === rightA) {
    fixed = leftA;
    varLo = Math.min(cardRank(leftB), cardRank(rightB));
    varHi = Math.max(cardRank(leftB), cardRank(rightB));
    varSuitMustMatch = cardSuit(leftB); // both endpoints' varying card suit
    if (cardSuit(leftB) !== cardSuit(rightB)) {
      throw new Error('Suit-specific dash endpoints must share the varying suit: "' + tok + '"');
    }
  } else if (leftB === rightB) {
    fixed = leftB;
    varLo = Math.min(cardRank(leftA), cardRank(rightA));
    varHi = Math.max(cardRank(leftA), cardRank(rightA));
    varSuitMustMatch = cardSuit(leftA);
    if (cardSuit(leftA) !== cardSuit(rightA)) {
      throw new Error('Suit-specific dash endpoints must share the varying suit: "' + tok + '"');
    }
  } else {
    throw new Error('Suit-specific dash must hold one card fixed: "' + tok + '"');
  }
  var rs = newSet();
  for (var r = varLo; r <= varHi; r++) {
    var vc = cardId(r, varSuitMustMatch);
    if (vc === fixed) continue;
    addCombo(rs, fixed, vc);
  }
  return rs;
}

// class dash: "77-TT", "A2s-A5s", "AJo-ATo", "K8s-K5s"
function interpretClassDash(tok, original) {
  var parts = tok.split('-');
  if (parts.length !== 2) throw new Error('Malformed dash range: "' + original + '"');
  var lo = parseClassLabel(parts[0], original);
  var hi = parseClassLabel(parts[1], original);

  // Pair dash: both pairs
  if (lo.type === 'pair' && hi.type === 'pair') {
    var a = Math.min(lo.hi, hi.hi);
    var b = Math.max(lo.hi, hi.hi);
    var rs = newSet();
    for (var r = a; r <= b; r++) {
      var combos = expandClass(RANKS[r] + RANKS[r]);
      for (var i = 0; i < combos.length; i++) addCombo(rs, combos[i][0], combos[i][1]);
    }
    return rs;
  }

  // Suited/offsuit dash sharing a high card OR a low card.
  if ((lo.type === 's' || lo.type === 'o') && lo.type === hi.type) {
    // Two recognized PPT modes:
    //  (a) shared high card, varying kicker:  A2s-A5s  (hi=A fixed)
    //  (b) shared low card, varying high:     K8s-K5s actually varies low...
    // PPT "K8s-K5s": high K fixed, kicker 8..5 -> shared HIGH card.
    // Cross-high like "98s-76s" share neither; PPT treats that as a
    //  "running" connectors range. We support shared-high and shared-low,
    //  and the connector form (same gap) too.
    var rs2 = newSet();
    if (lo.hi === hi.hi) {
      // shared high card, vary kicker between lo.lo..hi.lo
      var hcard = lo.hi;
      var k1 = Math.min(lo.lo, hi.lo), k2 = Math.max(lo.lo, hi.lo);
      for (var k = k1; k <= k2; k++) {
        if (k === hcard) continue;
        addClassCombos(rs2, hcard, k, lo.type);
      }
      return rs2;
    }
    if (lo.lo === hi.lo) {
      // shared low card, vary high between lo.hi..hi.hi
      var lcard = lo.lo;
      var h1 = Math.min(lo.hi, hi.hi), h2 = Math.max(lo.hi, hi.hi);
      for (var hh = h1; hh <= h2; hh++) {
        if (hh === lcard) continue;
        addClassCombos(rs2, hh, lcard, lo.type);
      }
      return rs2;
    }
    // connector run: same gap, walk both endpoints together
    var gapLo = lo.hi - lo.lo;
    var gapHi = hi.hi - hi.lo;
    if (gapLo === gapHi) {
      var startHi = Math.min(lo.hi, hi.hi);
      var endHi = Math.max(lo.hi, hi.hi);
      for (var top = startHi; top <= endHi; top++) {
        var bot = top - gapLo;
        if (bot < 0) continue;
        addClassCombos(rs2, top, bot, lo.type);
      }
      return rs2;
    }
    throw new Error('Unsupported suited/offsuit dash range: "' + original + '"');
  }

  throw new Error('Mismatched dash endpoints: "' + original + '"');
}

function addClassCombos(rs, hi, lo, type) {
  var combos = expandClass(RANKS[hi] + RANKS[lo] + type);
  for (var i = 0; i < combos.length; i++) addCombo(rs, combos[i][0], combos[i][1]);
}

// parse a bare class label like "77", "A2s", "AJo", "AK"
function parseClassLabel(text, original) {
  text = text.trim().replace(/10/g, 'T');
  // pair
  if (/^([2-9TJQKA])\1$/i.test(text)) {
    var r = rankVal(text[0]);
    return { type: 'pair', hi: r, lo: r, label: text.toUpperCase() };
  }
  var m = text.match(/^([2-9TJQKA])([2-9TJQKA])(\$?[so])?$/i);
  if (m) {
    var a = rankVal(m[1]), b = rankVal(m[2]);
    if (a === b) throw new Error('Invalid class "' + text + '" in "' + original + '"');
    var hi = Math.max(a, b), lo = Math.min(a, b);
    var suf = m[3] ? m[3].replace('$', '').toLowerCase() : '';
    var type = suf === 's' ? 's' : (suf === 'o' ? 'o' : 'both');
    return { type: type, hi: hi, lo: lo, label: text.toUpperCase() };
  }
  throw new Error('Unrecognized class label "' + text + '" in "' + original + '"');
}

// Two-rank token with suitedness/plus, or pair-with-plus.
function interpretRankPairToken(tok, original) {
  // handle '$' alias: AK$s / AK$o
  var hasPlus = false;
  var body = tok;
  if (body.slice(-1) === '+') { hasPlus = true; body = body.slice(0, -1); }

  // pair?  "AA", "TT"
  if (/^([2-9TJQKA])\1$/i.test(body)) {
    var pr = rankVal(body[0]);
    var rs = newSet();
    if (hasPlus) {
      for (var r = pr; r <= 12; r++) {
        var cc = expandClass(RANKS[r] + RANKS[r]);
        for (var i = 0; i < cc.length; i++) addCombo(rs, cc[i][0], cc[i][1]);
      }
    } else {
      var c0 = expandClass(RANKS[pr] + RANKS[pr]);
      for (var j = 0; j < c0.length; j++) addCombo(rs, c0[j][0], c0[j][1]);
    }
    return rs;
  }

  // "any hand containing rank R": a bare single rank ("A", "K"), or rank + a
  // wildcard kicker ("A*", "*A", "Ax", "xA"). The colloquial "any ace"/"any king".
  // (A+ only works at the top of the deck; "any king" has no plus form since K+
  // wrongly includes aces — so this fills a real gap.)
  var anyRank = body.match(/^([2-9TJQKA])(?:\*|x)?$/i) || body.match(/^(?:\*|x)([2-9TJQKA])$/i);
  if (anyRank && !hasPlus) {
    var rv = rankVal(anyRank[1]);
    var rsAny = newSet();
    for (var ca = 0; ca < 52; ca++) for (var cb = ca + 1; cb < 52; cb++) {
      if (cardRank(ca) === rv || cardRank(cb) === rv) addCombo(rsAny, ca, cb);
    }
    return rsAny;
  }

  // two ranks with optional suitedness: AK / AKs / AKo / AK$s / AK$o
  var m = body.match(/^([2-9TJQKA])([2-9TJQKA])(\$?[so])?$/i);
  if (!m) throw new Error('Unrecognized range token: "' + original + '"');
  var a = rankVal(m[1]), b = rankVal(m[2]);
  if (a === b) throw new Error('Two-rank token cannot have equal ranks: "' + original + '"');
  var hi = Math.max(a, b), lo = Math.min(a, b);
  var suf = m[3] ? m[3].replace('$', '').toLowerCase() : '';
  var suited = suf === 's';
  var offsuit = suf === 'o';
  var both = suf === '';

  var out = newSet();
  if (hasPlus) {
    // kicker-plus: fix the higher rank, walk the lower rank UP toward (hi-1).
    // e.g. AJs+ -> AJs,AQs,AKs ; AK+ (no suit, two distinct top ranks) means
    // walk lower kicker up.  KQ+ -> KQ (then nothing above with K high except
    // it walks the kicker up to K-1 = nothing) => just KQ.
    // General rule: for X Y (+), with X=hi rank fixed, kicker goes lo..hi-1.
    for (var k = lo; k <= hi - 1; k++) {
      if (suited) addClassCombos(out, hi, k, 's');
      else if (offsuit) addClassCombos(out, hi, k, 'o');
      else { addClassCombos(out, hi, k, 's'); addClassCombos(out, hi, k, 'o'); }
    }
    return out;
  }

  // no plus
  if (suited) addClassCombos(out, hi, lo, 's');
  else if (offsuit) addClassCombos(out, hi, lo, 'o');
  else { addClassCombos(out, hi, lo, 's'); addClassCombos(out, hi, lo, 'o'); }
  return out;
}

// --------------------------------------------------------------------------
// Public parseRange
// --------------------------------------------------------------------------
function parseRange(str, opts) {
  if (typeof str !== 'string') throw new Error('parseRange expects a string');
  var trimmed = str.trim();
  if (trimmed === '') throw new Error('Empty range string');
  opts = opts || {};

  var ctx = { weighted: false };
  var cursor = makeCursor(trimmed);
  var rs = parseUnion(cursor, ctx);
  skipWs(cursor);
  if (!eof(cursor)) {
    throw new Error('Unexpected trailing characters at position ' + cursor.i +
      ' in range: "' + str + '" (near "' + str.slice(cursor.i) + '")');
  }

  var warnings = [];

  // dead cards
  var deadIds = new Set();
  if (opts.dead && opts.dead.length) {
    for (var d = 0; d < opts.dead.length; d++) {
      var did = parseCardId(opts.dead[d]);
      if (did < 0) throw new Error('Invalid dead card: "' + opts.dead[d] + '"');
      deadIds.add(did);
    }
  }

  // Materialize combos, filtering dead.
  var combos = [];
  var weights = ctx.weighted ? {} : null;
  rs.set.forEach(function (k) {
    var hi = Math.floor(k / 52);
    var lo = k % 52;
    if (deadIds.has(hi) || deadIds.has(lo)) return;
    var cards = comboCards(k);
    combos.push(cards);
    if (weights) {
      var w = rs.weights.has(k) ? rs.weights.get(k) : 100;
      if (w !== 100) weights[cards[0] + cards[1]] = w;
    }
  });

  // Stable sort: high card first then low card (by rank desc, suit desc).
  combos.sort(function (x, y) {
    var ax = parseCardId(x[0]), ay = parseCardId(y[0]);
    if (ay !== ax) return ay - ax;
    var bx = parseCardId(x[1]), by = parseCardId(y[1]);
    return by - bx;
  });

  var result = { combos: combos, count: combos.length, warnings: warnings };
  if (weights) result.weights = weights;
  return result;
}

// --------------------------------------------------------------------------
// Exports
// --------------------------------------------------------------------------
var api = {
  parseRange: parseRange,
  normalizeCard: normalizeCard,
  RANKS: RANKS,
  SUITS: SUITS,
  PREFLOP_ORDERED: PREFLOP_ORDERED,
  // exposed for tests / debugging
  _expandClass: expandClass,
  _buildPercentSet: buildPercentSet
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.PPTHoldem = api;
}

})();
