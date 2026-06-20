// ppt-percent.js
// Runtime module: loads the precomputed rankings (holdem-ranking.json /
// omaha-ranking.json) and exposes a ProPokerTools-style percentage-range
// engine. Works in Node and in the browser (via a typeof module guard; in the
// browser, set globalThis.PPT_RANKINGS = {holdem:[...], omaha:[...]} before use,
// or pass rankings into the constructor functions).
//
// Card model (matches ppt-eval.js): index 0..51, rank = idx>>2 (0=2..12=A),
// suit = idx & 3.
//
// API:
//   percentRange(game, lo, hi) -> { classes, totalCombos, sampleHand(rng) }
//       Selects the classes whose CUMULATIVE combo-weight (best->worst) falls in
//       the [lo, hi] percentile band. sampleHand draws a uniform-by-combos
//       concrete hand (expanding suit isomorphism) from the band.
//   equityVsPercent(heroHand, lo, hi, opts) -> { equity, trials, opponentRangeCombos }
//       Monte-Carlo equity of hero vs the top lo-hi% range. Each trial samples a
//       fresh legal opponent hand from the band (no collision with hero/board/dead),
//       runs out the remaining board, evaluates. Supports N opponents.

'use strict';

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./ppt-eval.js'), require);
  } else {
    root.PPTPercent = factory(root.PPTEval, null);
  }
})(typeof self !== 'undefined' ? self : this, function (PPTEval, nodeRequire) {

  const { eval7holdem, evalOmaha } = PPTEval;
  const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const RANK_OF = {}; RANK_CHARS.forEach((c, i) => { RANK_OF[c] = i; });

  // -------------------------------------------------------------------------
  // Rankings loading
  // -------------------------------------------------------------------------
  let _rankings = { holdem: null, omaha: null };

  function loadRankings() {
    if (_rankings.holdem && _rankings.omaha) return _rankings;
    // Node: read JSON from disk relative to this file.
    if (nodeRequire) {
      const fs = nodeRequire('fs');
      const path = nodeRequire('path');
      _rankings.holdem = JSON.parse(fs.readFileSync(path.join(__dirname, 'holdem-ranking.json'), 'utf8'));
      _rankings.omaha = JSON.parse(fs.readFileSync(path.join(__dirname, 'omaha-ranking.json'), 'utf8'));
    } else if (typeof globalThis !== 'undefined' && globalThis.PPT_RANKINGS) {
      _rankings.holdem = globalThis.PPT_RANKINGS.holdem;
      _rankings.omaha = globalThis.PPT_RANKINGS.omaha;
    } else {
      throw new Error('ppt-percent: rankings not available (set globalThis.PPT_RANKINGS in browser)');
    }
    return _rankings;
  }

  function setRankings(r) { _rankings = { holdem: r.holdem, omaha: r.omaha }; }

  function getRanking(game) {
    const r = loadRankings();
    if (game === 'holdem') return r.holdem;
    if (game === 'omaha') return r.omaha;
    throw new Error('ppt-percent: unknown game ' + game);
  }

  // -------------------------------------------------------------------------
  // Concrete-combo expansion of a class -> list its concrete card-index pairs/quads
  // -------------------------------------------------------------------------

  // Hold'em class key -> array of concrete [c0,c1] index pairs.
  function holdemClassCombos(classKey) {
    const out = [];
    const isPair = classKey.length === 2;
    if (isPair) {
      const r = RANK_OF[classKey[0]];
      for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) out.push([r * 4 + s1, r * 4 + s2]);
    } else {
      const hi = RANK_OF[classKey[0]], lo = RANK_OF[classKey[1]], suited = classKey[2] === 's';
      if (suited) {
        for (let s = 0; s < 4; s++) out.push([hi * 4 + s, lo * 4 + s]);
      } else {
        for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([hi * 4 + s1, lo * 4 + s2]);
      }
    }
    return out;
  }

  // Omaha class key "<r0r1r2r3>/<pattern>" -> array of concrete 4-card quads.
  // Expand the canonical pattern over all distinct suit assignments that keep
  // pattern-letters consistent (same letter -> same suit, different letter ->
  // different suit). The number of expansions = falling factorial 4_P_k where
  // k = number of distinct letters. We enumerate via the SUIT_PERMS-style map.
  function omahaClassCombos(classKey) {
    const slash = classKey.indexOf('/');
    const rankStr = classKey.slice(0, slash);
    const pattern = classKey.slice(slash + 1);
    const ranks = [];
    for (const ch of rankStr) ranks.push(RANK_OF[ch]);
    const letters = [];
    const letterIdx = {};
    for (const ch of pattern) { if (!(ch in letterIdx)) { letterIdx[ch] = letters.length; letters.push(ch); } }
    const k = letters.length; // distinct suits used
    // choose an ordered injection of k distinct suits from {0,1,2,3}
    const out = [];
    const chosen = [];
    const used = [false, false, false, false];
    function rec(li) {
      if (li === k) {
        // build the 4-card hand
        const hand = new Array(4);
        for (let i = 0; i < 4; i++) {
          const suit = chosen[letterIdx[pattern[i]]];
          hand[i] = ranks[i] * 4 + suit;
        }
        // dedupe protection: must be 4 distinct cards (canonical form guarantees it)
        out.push(hand.slice());
        return;
      }
      for (let s = 0; s < 4; s++) {
        if (used[s]) continue;
        used[s] = true; chosen[li] = s;
        rec(li + 1);
        used[s] = false;
      }
    }
    rec(0);
    return out;
  }

  // -------------------------------------------------------------------------
  // percentRange: select classes in the [lo,hi] percentile band (combo-weighted)
  // -------------------------------------------------------------------------
  function percentRange(game, lo, hi) {
    if (lo == null) lo = 0;
    if (hi == null) hi = 100;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    const ranking = getRanking(game);
    const grandTotal = ranking.reduce((s, c) => s + c.comboCount, 0);
    const loCombos = (lo / 100) * grandTotal;
    const hiCombos = (hi / 100) * grandTotal;

    // Walk best->worst accumulating combo weight. A class is INCLUDED if its
    // combo interval [cum, cum+comboCount) overlaps [loCombos, hiCombos).
    const classes = [];
    let cum = 0;
    let totalCombos = 0;
    for (const c of ranking) {
      const start = cum;
      const end = cum + c.comboCount;
      cum = end;
      if (end <= loCombos) continue;     // entirely before the band
      if (start >= hiCombos) break;      // entirely after the band (sorted) -> done
      classes.push(c);
      totalCombos += c.comboCount;
    }

    const combosFn = (game === 'holdem') ? holdemClassCombos : omahaClassCombos;

    // Build a flat, combo-weighted sampler. We lazily expand class combos on
    // first sample to avoid materializing the whole band up front for big ranges.
    let flat = null;
    function ensureFlat() {
      if (flat) return flat;
      flat = [];
      for (const c of classes) {
        const combos = combosFn(c.classKey);
        for (const h of combos) flat.push(h);
      }
      return flat;
    }

    function sampleHand(rng) {
      const f = ensureFlat();
      if (f.length === 0) return null;
      const r = rng ? rng() : Math.random();
      const idx = Math.min(f.length - 1, Math.floor(r * f.length));
      return f[idx].slice();
    }

    return { classes, totalCombos, sampleHand, _ensureFlat: ensureFlat };
  }

  // -------------------------------------------------------------------------
  // equityVsPercent: Monte-Carlo hero vs a top lo-hi% range
  // -------------------------------------------------------------------------
  //
  // opts: { game:'holdem'|'omaha', board:[indices], dead:[indices],
  //         trials:Number, opponents:Number, rng:fn }
  function equityVsPercent(heroHand, lo, hi, opts) {
    opts = opts || {};
    const game = opts.game || (heroHand.length === 4 ? 'omaha' : 'holdem');
    const board = (opts.board || []).slice();
    const dead = opts.dead || [];
    const trials = opts.trials || 200000;
    const nOpp = opts.opponents || 1;
    const rng = opts.rng || Math.random;
    const evalFn = game === 'omaha' ? evalOmaha : eval7holdem;
    const holeSize = game === 'omaha' ? 4 : 2;

    const range = percentRange(game, lo, hi);
    const flat = range._ensureFlat(); // array of legal concrete hands (by combos)
    const opponentRangeCombos = range.totalCombos;
    if (flat.length === 0) {
      return { equity: 0, trials: 0, opponentRangeCombos };
    }

    // Blocked cards = hero + board + dead. Opponent samples must avoid these and
    // each other across the N opponents.
    const blockedBase = new Set([...heroHand, ...board, ...dead]);

    // Remaining deck (for board runout) excluding hero+board+dead. Opponent
    // cards are removed per-trial.
    const boardNeed = 5 - board.length;

    let heroEqSum = 0;
    let completed = 0;

    // scratch deck reused across trials
    for (let t = 0; t < trials; t++) {
      const blocked = blockedBase; // we use a per-trial overlay set instead
      // Sample nOpp opponent hands, rejection-sampling against collisions.
      const oppHands = [];
      const trialBlocked = new Set(blockedBase);
      let ok = true;
      for (let o = 0; o < nOpp; o++) {
        let hand = null;
        // rejection sample a hand from the band that doesn't collide
        let attempts = 0;
        while (attempts < 200) {
          const cand = flat[Math.min(flat.length - 1, Math.floor(rng() * flat.length))];
          let clash = false;
          for (let i = 0; i < cand.length; i++) { if (trialBlocked.has(cand[i])) { clash = true; break; } }
          if (!clash) { hand = cand; break; }
          attempts++;
        }
        if (!hand) { ok = false; break; }
        for (let i = 0; i < hand.length; i++) trialBlocked.add(hand[i]);
        oppHands.push(hand);
      }
      if (!ok) continue; // extremely rare; skip degenerate trial

      // Build remaining deck for board runout (exclude everything in trialBlocked).
      let runBoard = board;
      if (boardNeed > 0) {
        const deck = [];
        for (let i = 0; i < 52; i++) if (!trialBlocked.has(i)) deck.push(i);
        // partial Fisher-Yates for boardNeed cards
        for (let k = 0; k < boardNeed; k++) {
          const j = k + Math.floor(rng() * (deck.length - k));
          const tmp = deck[k]; deck[k] = deck[j]; deck[j] = tmp;
        }
        runBoard = board.concat(deck.slice(0, boardNeed));
      }

      // Showdown: hero vs all opponents
      const heroScore = evalFn(heroHand, runBoard);
      let maxScore = heroScore;
      let ties = 1; // hero ties with itself
      for (let o = 0; o < oppHands.length; o++) {
        const s = evalFn(oppHands[o], runBoard);
        if (s > maxScore) { maxScore = s; ties = 1; }
        else if (s === maxScore) { ties++; }
      }
      if (heroScore === maxScore) heroEqSum += 1 / ties; // split pot if tied
      completed++;
    }

    return {
      equity: completed ? heroEqSum / completed : 0,
      trials: completed,
      opponentRangeCombos,
    };
  }

  return {
    loadRankings,
    setRankings,
    percentRange,
    equityVsPercent,
    holdemClassCombos,
    omahaClassCombos,
    RANK_OF,
    RANK_CHARS,
  };
});
