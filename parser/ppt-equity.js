// [wrapped in IIFE for safe classic-script loading in the browser:
//  prevents top-level decls from leaking to the global scope and colliding
//  with the app or the other parser modules. module.exports and window.X
//  assignments still work inside the IIFE.]
;(function () {
'use strict';

// ppt-equity.js
// Standalone MULTI-WAY (N-player) poker equity engine. Pooled Monte-Carlo:
// every player (specific hand OR range) is dealt one concrete holding each
// trial (range players sample from their parsed combo set, honoring @weights),
// collisions across players + board + dead are rejected, the remaining board
// is run out, ALL players are evaluated with ppt-eval, and the pot is awarded
// (split on ties). EVERY player gets an equity; equities sum to ~100%.
//
// This replaces a broken engine that silently dropped the 2nd/3rd range and
// capped ranges at 80 combos. There are NO artificial combo caps here.
//
// Card model (matches every sibling module): index 0..51,
//   rank = idx >> 2  (0='2' .. 12='A'),  suit = idx & 3,  'cdhs'.
//
// Public API:
//   computeMultiwayEquity({ game, players, board, dead, trials, rng, onProgress })
//     -> { players:[{label, equity, win, tie, ...}], trials, perBoard? }
//
//   game     : 'holdem' | 'omaha' | 'doubleboard'  (doubleboard => Omaha eval)
//   players  : ARRAY of N>=2 entries, each { label?, spec }. `spec` is EITHER a
//              specific hand string ("KdKs7d7c","AhKh") OR a range string
//              ("AA*","QQ*","20%","$ds,KK","AKs@50").
//   board    : card string ("Js Td 4c" or "JsTd4c"), optional. For doubleboard
//              you may pass board1/board2 separately, or board split on '/'.
//   dead     : card string of removed cards, optional.
//   trials   : Monte-Carlo trial count (default 120000).
//   rng      : optional () -> [0,1) generator (default Math.random).

// --------------------------------------------------------------------------
// Dependency resolution (Node require OR browser globals)
// --------------------------------------------------------------------------
var PPTEval, PPTHoldem, PPTOmaha, PPTPercent;
if (typeof module !== 'undefined' && module.exports) {
  PPTEval = require('./ppt-eval.js');
  PPTHoldem = require('./ppt-holdem.js');
  PPTOmaha = require('./ppt-omaha.js');
  PPTPercent = require('./ppt-percent.js');
} else {
  var _g = (typeof window !== 'undefined') ? window : (typeof self !== 'undefined' ? self : this);
  PPTEval = _g.PPTEval;
  PPTHoldem = _g.PPTHoldem;
  PPTOmaha = _g.PPTOmaha;
  PPTPercent = _g.PPTPercent;
}

var evalOmaha = PPTEval.evalOmaha;
var eval7holdem = PPTEval.eval7holdem;

// --------------------------------------------------------------------------
// Card string <-> index helpers (card model shared by all modules)
// --------------------------------------------------------------------------
var RANK_CHARS = '23456789TJQKA';
var SUIT_CHARS = 'cdhs';
var RANK_OF = {};
for (var _ri = 0; _ri < RANK_CHARS.length; _ri++) RANK_OF[RANK_CHARS[_ri]] = _ri;
var SUIT_OF = {};
for (var _si = 0; _si < SUIT_CHARS.length; _si++) SUIT_OF[SUIT_CHARS[_si]] = _si;

function cardToStr(idx) { return RANK_CHARS[idx >> 2] + SUIT_CHARS[idx & 3]; }

// Parse one card token ("Ah", "Tc", "10c") -> index 0..51, or -1 if invalid.
function strToCard(tok) {
  var s = String(tok).trim();
  var rp, sp;
  if (s.length === 3 && s.slice(0, 2) === '10') { rp = 'T'; sp = s[2]; }
  else if (s.length === 2) { rp = s[0].toUpperCase(); sp = s[1].toLowerCase(); }
  else return -1;
  var r = RANK_OF[rp];
  var su = SUIT_OF[sp];
  if (r === undefined || su === undefined) return -1;
  return r * 4 + su;
}

// Parse a free-form card list ("Js Td 4c" or "JsTd4c") -> array of indices.
// Throws on any malformed token. Empty / null -> [].
function parseCards(str) {
  if (str == null) return [];
  if (Array.isArray(str)) {
    // already indices or card strings
    return str.map(function (c) {
      if (typeof c === 'number') return c;
      var id = strToCard(c);
      if (id < 0) throw new Error('Invalid card: "' + c + '"');
      return id;
    });
  }
  var s = String(str).trim();
  if (s === '') return [];
  // Split on whitespace/commas if present, else chunk into card tokens.
  var toks;
  if (/[\s,]/.test(s)) {
    toks = s.split(/[\s,]+/).filter(function (t) { return t !== ''; });
  } else {
    toks = [];
    var i = 0;
    while (i < s.length) {
      if (s.slice(i, i + 2) === '10') { toks.push('10' + s[i + 2]); i += 3; }
      else { toks.push(s.slice(i, i + 2)); i += 2; }
    }
  }
  var out = [];
  for (var t = 0; t < toks.length; t++) {
    var id = strToCard(toks[t]);
    if (id < 0) throw new Error('Invalid card token: "' + toks[t] + '" in "' + str + '"');
    out.push(id);
  }
  return out;
}

// --------------------------------------------------------------------------
// Spec resolution: detect specific-hand vs range, materialize a SAMPLER.
// --------------------------------------------------------------------------
// A resolved player is one of:
//   { kind:'fixed', cards:[idx...] }                        // specific holding
//   { kind:'range', combos:[[idx...]...], cum:Float64Array? } // sample one
// `cum` (cumulative weight array) is present only for weighted range players.

// Try to read a spec as exactly `need` concrete cards. Returns the index array
// or null if it is NOT a clean specific hand of the right size.
function tryFixedHand(spec, need) {
  var s = String(spec).trim();
  // Reject anything that smells like a range operator.
  if (/[%@*\[\]():!,\-]/.test(s)) return null;
  if (/\s/.test(s)) {
    // whitespace-separated cards (e.g. "Ah Kh")
    var ws = parseCardsSafe(s);
    if (ws && ws.length === need && allDistinct(ws)) return ws;
    return null;
  }
  // contiguous run of cards: length must be exactly need*2 (or include "10")
  var ids = parseCardsSafe(s);
  if (ids && ids.length === need && allDistinct(ids)) return ids;
  return null;
}

function parseCardsSafe(s) {
  try { return parseCards(s); } catch (e) { return null; }
}
function allDistinct(arr) {
  var seen = {};
  for (var i = 0; i < arr.length; i++) {
    if (seen[arr[i]]) return false;
    seen[arr[i]] = true;
  }
  return true;
}

// Resolve a range spec into a flat list of concrete combos (index arrays) plus
// an optional cumulative-weight array for weighted sampling.
function resolveRange(spec, game, dead) {
  var holeSize = (game === 'holdem') ? 2 : 4;
  var s = String(spec).trim();
  // PPT "any two more cards" wildcard: "AA*"/"QQ*" mean "a hand CONTAINING this
  // rank-group, the rest anything". The Omaha parser spells that as just "AA",
  // and in holdem there are no extra cards, so a trailing '*' on a rank-group
  // token is a no-op. Strip a single trailing '*' so screenshot specs parse.
  if (/[A-Za-z0-9]\*$/.test(s)) s = s.slice(0, -1).trim();
  var isPercent = /(^|[^A-Za-z0-9])\d+(?:\.\d+)?%/.test(s);

  // ----- Percentage specs: resolve via ppt-percent (real top-X% set) -----
  if (isPercent) {
    var pg = (game === 'holdem') ? 'holdem' : 'omaha';
    var band = parsePercentBand(s);
    if (PPTPercent && PPTPercent.loadRankings) {
      try { PPTPercent.loadRankings(); } catch (e) { /* browser must preset */ }
    }
    var pr = PPTPercent.percentRange(pg, band.lo, band.hi);
    var flat = pr._ensureFlat ? pr._ensureFlat() : null;
    if (!flat) throw new Error('ppt-percent did not expose a flat combo set');
    var combosP = filterDead(flat.map(function (h) { return h.slice(); }), dead, holeSize);
    if (combosP.length === 0) throw new Error('Percent range "' + spec + '" empty after dead cards');
    return { kind: 'range', combos: combosP, cum: null, count: combosP.length };
  }

  // ----- Holdem range -----
  if (game === 'holdem') {
    var deadStrs = dead.map(cardToStr);
    var res = PPTHoldem.parseRange(s, { dead: deadStrs });
    if (!res.combos.length) throw new Error('Holdem range "' + spec + '" is empty');
    var combos = res.combos.map(function (pair) {
      return [strToCard(pair[0]), strToCard(pair[1])];
    });
    var cum = null;
    if (res.weights) {
      cum = buildCumWeights(res.combos, res.weights, function (pair) {
        return pair[0] + pair[1];
      }, combos.length);
    }
    return { kind: 'range', combos: combos, cum: cum, count: combos.length };
  }

  // ----- Omaha range (also used for each board of doubleboard) -----
  var parsed = PPTOmaha.parseRange(s);
  // Enumerate the FULL matching set (no artificial cap on our side; we pass a
  // large `max` so the sampled path still returns plenty if it triggers).
  var en = parsed.enumerate({ max: 60000, dead: dead });
  if (!en.combos.length) throw new Error('Omaha range "' + spec + '" is empty');
  var ocombos = en.combos.map(function (q) {
    return [strToCard(q[0]), strToCard(q[1]), strToCard(q[2]), strToCard(q[3])];
  });
  // Omaha parser does not surface per-combo weights, so no cum array.
  return { kind: 'range', combos: ocombos, cum: null, count: ocombos.length, sampled: en.sampled };
}

// Parse "20%" or "15%-30%" -> {lo,hi}.
function parsePercentBand(s) {
  var m = s.match(/(\d+(?:\.\d+)?)%\s*-\s*(\d+(?:\.\d+)?)%/);
  if (m) {
    var lo = parseFloat(m[1]), hi = parseFloat(m[2]);
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    return { lo: lo, hi: hi };
  }
  m = s.match(/(\d+(?:\.\d+)?)%/);
  if (m) return { lo: 0, hi: parseFloat(m[1]) };
  throw new Error('Malformed percent spec: "' + s + '"');
}

function filterDead(combos, dead, holeSize) {
  if (!dead || dead.length === 0) return combos;
  var deadSet = {};
  for (var i = 0; i < dead.length; i++) deadSet[dead[i]] = true;
  var out = [];
  for (var c = 0; c < combos.length; c++) {
    var h = combos[c], bad = false;
    for (var k = 0; k < h.length; k++) { if (deadSet[h[k]]) { bad = true; break; } }
    if (!bad) out.push(h);
  }
  return out;
}

// Build a cumulative-weight array aligned to `combos` order. weights is the
// object keyed by combo string (only entries != 100 are present). Combos
// absent from the map are weight 100.
function buildCumWeights(combosStr, weights, keyFn, n) {
  var cum = new Float64Array(n);
  var run = 0;
  for (var i = 0; i < n; i++) {
    var k = keyFn(combosStr[i]);
    var w = (weights[k] !== undefined) ? weights[k] : 100;
    if (w < 0) w = 0;
    run += w;
    cum[i] = run;
  }
  return run > 0 ? cum : null; // if total weight 0 fall back to uniform
}

// Resolve every player spec up front (one parse, reused across all trials).
function resolvePlayers(players, game, dead) {
  var need = (game === 'holdem') ? 2 : 4;
  return players.map(function (p, idx) {
    var label = (p && p.label != null) ? p.label : ('P' + (idx + 1));
    var spec = p && p.spec != null ? p.spec : p; // allow bare-string entries
    var fixed = tryFixedHand(spec, need);
    if (fixed) return { label: label, kind: 'fixed', cards: fixed };
    var r = resolveRange(spec, game, dead);
    r.label = label;
    return r;
  });
}

// --------------------------------------------------------------------------
// Sampling one holding for a player, avoiding `used` cards.
// --------------------------------------------------------------------------
function sampleFixed(player, used) {
  var cards = player.cards;
  for (var i = 0; i < cards.length; i++) if (used[cards[i]]) return null;
  return cards;
}

function sampleRange(player, used, rng) {
  var combos = player.combos;
  var n = combos.length;
  var cum = player.cum;
  // Up to a bounded number of draws, pick a combo and accept if collision-free.
  for (var attempt = 0; attempt < 64; attempt++) {
    var pick;
    if (cum) {
      var target = rng() * cum[n - 1];
      pick = lowerBound(cum, target);
    } else {
      pick = (rng() * n) | 0;
      if (pick >= n) pick = n - 1;
    }
    var h = combos[pick];
    var clash = false;
    for (var k = 0; k < h.length; k++) { if (used[h[k]]) { clash = true; break; } }
    if (!clash) return h;
  }
  return null; // heavily blocked; trial will be skipped
}

// Smallest index i with cum[i] > target (weighted sampling).
function lowerBound(cum, target) {
  var lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// --------------------------------------------------------------------------
// Board runout: fill the remaining board cards from a fresh deck.
// --------------------------------------------------------------------------
function runoutBoard(fixedBoard, used, rng) {
  var need = 5 - fixedBoard.length;
  if (need <= 0) return fixedBoard;
  var deck = [];
  for (var i = 0; i < 52; i++) if (!used[i]) deck.push(i);
  // partial Fisher-Yates for `need` cards
  for (var k = 0; k < need; k++) {
    var j = k + ((rng() * (deck.length - k)) | 0);
    var tmp = deck[k]; deck[k] = deck[j]; deck[j] = tmp;
  }
  var out = fixedBoard.slice();
  for (var d = 0; d < need; d++) out.push(deck[d]);
  return out;
}

// --------------------------------------------------------------------------
// Single-board Monte Carlo (holdem or omaha)
// --------------------------------------------------------------------------
function runSingleBoard(resolved, evalFn, fixedBoard, dead, trials, rng, onProgress) {
  var N = resolved.length;
  var win = new Float64Array(N);   // outright (single winner) tallies
  var tie = new Float64Array(N);   // trials where the player was in a tie
  var eq = new Float64Array(N);    // pot share sum
  var scores = new Array(N);
  var holdings = new Array(N);
  var completed = 0;

  for (var t = 0; t < trials; t++) {
    // `used` marks every card already committed this trial.
    var used = new Uint8Array(52);
    for (var d = 0; d < dead.length; d++) used[dead[d]] = 1;
    for (var b = 0; b < fixedBoard.length; b++) used[fixedBoard[b]] = 1;

    var ok = true;
    for (var p = 0; p < N; p++) {
      var pl = resolved[p];
      var h = (pl.kind === 'fixed') ? sampleFixed(pl, used) : sampleRange(pl, used, rng);
      if (!h) { ok = false; break; }
      holdings[p] = h;
      for (var c = 0; c < h.length; c++) used[h[c]] = 1;
    }
    if (!ok) continue; // degenerate draw (heavily blocked) — skip

    var board = runoutBoard(fixedBoard, used, rng);

    var best = -1;
    for (var e = 0; e < N; e++) {
      var s = evalFn(holdings[e], board);
      scores[e] = s;
      if (s > best) best = s;
    }
    var winners = 0;
    for (var w = 0; w < N; w++) if (scores[w] === best) winners++;
    var share = 1 / winners;
    for (var g = 0; g < N; g++) {
      if (scores[g] === best) {
        eq[g] += share;
        if (winners === 1) win[g] += 1; else tie[g] += 1;
      }
    }
    completed++;
    if (onProgress && (t & 8191) === 8191) onProgress((t + 1) / trials);
  }

  return buildResult(resolved, eq, win, tie, completed);
}

// --------------------------------------------------------------------------
// Double-board Monte Carlo (two Omaha boards, half pot each, scoop tracked)
// --------------------------------------------------------------------------
function runDoubleBoard(resolved, fixed1, fixed2, dead, trials, rng, onProgress) {
  var N = resolved.length;
  var win = new Float64Array(N);
  var tie = new Float64Array(N);
  var eq = new Float64Array(N);
  var scoop = new Float64Array(N); // trials where a player won BOTH boards outright
  var s1 = new Array(N), s2 = new Array(N), holdings = new Array(N);
  var completed = 0;

  for (var t = 0; t < trials; t++) {
    var used = new Uint8Array(52);
    var d;
    for (d = 0; d < dead.length; d++) used[dead[d]] = 1;
    for (d = 0; d < fixed1.length; d++) used[fixed1[d]] = 1;
    for (d = 0; d < fixed2.length; d++) used[fixed2[d]] = 1;

    var ok = true;
    for (var p = 0; p < N; p++) {
      var pl = resolved[p];
      var h = (pl.kind === 'fixed') ? sampleFixed(pl, used) : sampleRange(pl, used, rng);
      if (!h) { ok = false; break; }
      holdings[p] = h;
      for (var c = 0; c < h.length; c++) used[h[c]] = 1;
    }
    if (!ok) continue;

    var board1 = runoutBoard(fixed1, used, rng);
    // Mark board1's drawn cards as used so board2 doesn't collide.
    for (var b1 = 0; b1 < board1.length; b1++) used[board1[b1]] = 1;
    var board2 = runoutBoard(fixed2, used, rng);

    var e, best1 = -1, best2 = -1;
    for (e = 0; e < N; e++) {
      s1[e] = evalOmaha(holdings[e], board1); if (s1[e] > best1) best1 = s1[e];
      s2[e] = evalOmaha(holdings[e], board2); if (s2[e] > best2) best2 = s2[e];
    }
    var win1 = 0, win2 = 0;
    for (e = 0; e < N; e++) { if (s1[e] === best1) win1++; if (s2[e] === best2) win2++; }
    var share1 = 0.5 / win1, share2 = 0.5 / win2;
    for (e = 0; e < N; e++) {
      var got1 = (s1[e] === best1), got2 = (s2[e] === best2);
      if (got1) eq[e] += share1;
      if (got2) eq[e] += share2;
      if (got1 || got2) {
        // "win" counts a clean both-boards-sole-winner; "tie" otherwise shared
        if (got1 && got2 && win1 === 1 && win2 === 1) { win[e] += 1; scoop[e] += 1; }
        else tie[e] += 1;
      }
    }
    completed++;
    if (onProgress && (t & 8191) === 8191) onProgress((t + 1) / trials);
  }

  var res = buildResult(resolved, eq, win, tie, completed);
  // scoop reported as a PERCENTAGE, consistent with equity/win/tie.
  for (var i = 0; i < N; i++) res.players[i].scoop = completed ? (scoop[i] / completed) * 100 : 0;
  res.perBoard = true;
  return res;
}

function buildResult(resolved, eq, win, tie, completed) {
  var players = resolved.map(function (pl, i) {
    return {
      label: pl.label,
      equity: completed ? (eq[i] / completed) * 100 : 0,
      win: completed ? (win[i] / completed) * 100 : 0,
      tie: completed ? (tie[i] / completed) * 100 : 0,
      kind: pl.kind,
      combos: pl.kind === 'range' ? pl.count : 1
    };
  });
  return { players: players, trials: completed };
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------
function computeMultiwayEquity(opts) {
  opts = opts || {};
  var game = opts.game || 'holdem';
  if (game !== 'holdem' && game !== 'omaha' && game !== 'doubleboard') {
    throw new Error('Unknown game: "' + game + '" (holdem | omaha | doubleboard)');
  }
  var players = opts.players;
  if (!Array.isArray(players) || players.length < 2) {
    throw new Error('computeMultiwayEquity needs an array of >= 2 players');
  }
  var trials = opts.trials || 120000;
  var rng = opts.rng || Math.random;
  var dead = parseCards(opts.dead);

  if (game === 'doubleboard') {
    var b1, b2;
    if (opts.board1 != null || opts.board2 != null) {
      b1 = parseCards(opts.board1);
      b2 = parseCards(opts.board2);
    } else {
      // single `board` string split on '/' into the two boards
      var raw = String(opts.board || '');
      var halves = raw.split('/');
      b1 = parseCards(halves[0] || '');
      b2 = parseCards(halves[1] || '');
    }
    if (b1.length > 5 || b2.length > 5) throw new Error('Each board holds at most 5 cards');
    // doubleboard always uses Omaha holdings
    var resolvedD = resolvePlayers(players, 'omaha', dead);
    validateNoDuplicateGivens(resolvedD, b1.concat(b2), dead);
    return runDoubleBoard(resolvedD, b1, b2, dead, trials, rng, opts.onProgress);
  }

  var fixedBoard = parseCards(opts.board);
  if (fixedBoard.length > 5) throw new Error('Board holds at most 5 cards');
  var resolved = resolvePlayers(players, game, dead);
  validateNoDuplicateGivens(resolved, fixedBoard, dead);
  var evalFn = (game === 'omaha') ? evalOmaha : eval7holdem;
  return runSingleBoard(resolved, evalFn, fixedBoard, dead, trials, rng, opts.onProgress);
}

// Sanity check: no card appears twice among the FIXED givens (specific hands +
// board + dead). Range players are checked per-trial, not here.
function validateNoDuplicateGivens(resolved, board, dead) {
  var seen = {};
  function mark(id, where) {
    if (seen[id]) throw new Error('Card ' + cardToStr(id) + ' appears twice (' + seen[id] + ' & ' + where + ')');
    seen[id] = where;
  }
  for (var d = 0; d < dead.length; d++) mark(dead[d], 'dead');
  for (var b = 0; b < board.length; b++) mark(board[b], 'board');
  for (var p = 0; p < resolved.length; p++) {
    if (resolved[p].kind === 'fixed') {
      var cs = resolved[p].cards;
      for (var c = 0; c < cs.length; c++) mark(cs[c], resolved[p].label);
    }
  }
}

// --------------------------------------------------------------------------
// Exports (Node + browser), no global leakage (IIFE).
// --------------------------------------------------------------------------
var API = {
  computeMultiwayEquity: computeMultiwayEquity,
  // exposed for tests / wiring
  _internals: {
    strToCard: strToCard,
    cardToStr: cardToStr,
    parseCards: parseCards,
    tryFixedHand: tryFixedHand,
    resolvePlayers: resolvePlayers
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
if (typeof window !== 'undefined') {
  window.PPTEquity = API;
}

})();
