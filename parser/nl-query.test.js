'use strict';
/*
 * nl-query.test.js
 *
 * Tests the NL -> structured-query layer (nl-query.js). The LLM is MOCKED:
 * for each English question we write the structured query we EXPECT a good
 * model to emit, wrap it in the |||CALC||| contract, run it back through
 * parseLLMResponse + validateQuery, and assert the guardrail accepts it.
 * Negative cases assert the guardrail REJECTS bad / unsupported ranges with
 * a clear, range-naming error.
 *
 * Run:  node nl-query.test.js
 */

var NL = require('./nl-query.js');

var pass = 0, fail = 0, failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (detail ? '  ->  ' + detail : '')); console.log('FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* Helper: wrap a structured query the way a model would, then run the full
 * pipeline (parse the "LLM text" -> validate). Returns the validation result. */
function runMocked(query, wrap) {
  var text;
  if (wrap === 'fence') text = 'Here you go:\n```json\n' + JSON.stringify(query) + '\n```';
  else if (wrap === 'bare') text = 'The query is ' + JSON.stringify(query);
  else text = 'Sure.\n|||CALC|||' + JSON.stringify(query) + '|||END|||';
  var parsed = NL.parseLLMResponse(text);
  if (!parsed.ok) return { parsedOk: false, parsed: parsed };
  var v = NL.validateQuery(parsed.query);
  return { parsedOk: true, query: parsed.query, validation: v };
}

/* ================================================================== */
/* POSITIVE CASES — ~12 English questions -> expected structured query */
/* ================================================================== */
var POSITIVE = [
  { name: 'AA vs top 20% Omaha (THE production case)',
    q: 'how does AA do vs top 20% of hands in omaha?',
    query: { game: 'omaha', players: [{ label: 'Hero', range: 'AA' }, { label: 'Villain', range: '20%' }], intent: 'equity' } },

  { name: 'AA vs KK heads up holdem',
    q: 'AA vs KK',
    query: { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' } },

  { name: 'double-suited aces vs random PLO',
    q: 'double-suited aces vs a random hand in PLO',
    query: { game: 'omaha', players: [{ range: 'AA$ds' }, { range: '*' }], intent: 'equity' } },

  { name: 'AKs vs QQ on flop Kh3c4c',
    q: 'AKs vs queens, flop came Kh3c4c',
    query: { game: 'holdem', players: [{ range: 'AKs' }, { range: 'QQ' }], board: 'Kh3c4c', intent: 'equity' } },

  { name: 'JT98 rundown vs 20% Omaha',
    q: 'JT98 double suited vs top 20% in omaha',
    query: { game: 'omaha', players: [{ range: 'JT98$ds' }, { range: '20%' }], intent: 'equity' } },

  { name: 'four-way multiway holdem',
    q: 'AA vs KK vs QQ vs JTs four way',
    query: { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }, { range: 'QQ' }, { range: 'JTs' }], intent: 'equity' } },

  { name: 'blockers routed to dead, not range',
    q: 'AKo vs any two but the As and Ks are dead',
    query: { game: 'holdem', players: [{ range: 'AKo' }, { range: '*' }], dead: 'AsKs', intent: 'equity' } },

  { name: 'double board bomb pot PLO',
    q: 'double board bomb pot, aces vs kings PLO',
    query: { game: 'doubleboard', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' } },

  { name: 'percentage band vs percentage band',
    q: 'top 5% vs 5% to 15% preflop',
    query: { game: 'holdem', players: [{ range: '5%' }, { range: '5%-15%' }], intent: 'equity' } },

  { name: 'omaha intersection rundown:double-suited',
    q: 'big rundowns AKQJ down to T987 that are double suited, vs aces',
    query: { game: 'omaha', players: [{ range: 'AKQJ-T987:$ds' }, { range: 'AA' }], intent: 'equity' } },

  { name: 'holdem union range vs pair',
    q: 'AK or QQ+ vs JJ',
    query: { game: 'holdem', players: [{ range: 'AK,QQ+' }, { range: 'JJ' }], intent: 'equity' } },

  { name: 'omaha suit-variable double-suited AA-KK vs broadway macro',
    q: 'double-suited aces and kings vs all-broadway hands in omaha',
    query: { game: 'omaha', players: [{ range: 'AxAyKxKy' }, { range: '$R' }], intent: 'equity' } }
];

POSITIVE.forEach(function (tc) {
  var r = runMocked(tc.query);
  ok('parse: ' + tc.name, r.parsedOk, r.parsed && r.parsed.error);
  if (r.parsedOk) {
    ok('valid: ' + tc.name, r.validation.ok, JSON.stringify(r.validation.errors));
  }
});

/* The exact production case deserves an explicit, pointed assertion:
 * the opponent range MUST be the literal "20%" token (resolved by the engine),
 * NOT an enumerated list of specific hands. */
(function () {
  var prod = POSITIVE[0];
  var villainRange = prod.query.players[1].range;
  ok('production case opponent is the "20%" token (not enumerated)',
     villainRange === '20%', 'got: ' + villainRange);
  ok('production case opponent is NOT a comma-enumerated hand list',
     villainRange.indexOf(',') < 0 && !/[2-9TJQKA]{4}/.test(villainRange), 'got: ' + villainRange);
})();

/* Wrapper-format coverage: |||CALC|||, fenced block, bare object all parse. */
(function () {
  var q = { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' };
  ok('parse wrapper: |||CALC|||', runMocked(q, 'calc').parsedOk);
  ok('parse wrapper: ```json fence', runMocked(q, 'fence').parsedOk);
  ok('parse wrapper: bare object', runMocked(q, 'bare').parsedOk);
})();

/* ================================================================== */
/* NEGATIVE CASES — guardrail must reject with a clear, named error.   */
/* ================================================================== */
function expectError(name, query, fieldOrRangeNeedle) {
  var r = runMocked(query);
  if (!r.parsedOk) { ok(name + ' (parse)', false, r.parsed.error); return; }
  var v = r.validation;
  ok(name, !v.ok, 'expected invalid but validateQuery passed');
  if (!v.ok && fieldOrRangeNeedle) {
    var hit = v.errors.some(function (e) {
      return (e.range && String(e.range).indexOf(fieldOrRangeNeedle) >= 0) ||
             (e.message && e.message.indexOf(fieldOrRangeNeedle) >= 0) ||
             (e.field && e.field === fieldOrRangeNeedle);
    });
    ok(name + ' (error names offender)', hit, JSON.stringify(v.errors));
  }
}

// Unsupported holdem token -> parser throws -> validator names the range.
expectError('reject: garbage holdem range "ZZZ"',
  { game: 'holdem', players: [{ range: 'AA' }, { range: 'ZZZ' }], intent: 'equity' }, 'ZZZ');

// Unsupported omaha token.
expectError('reject: unsupported omaha token "QQQQQ"',
  { game: 'omaha', players: [{ range: 'AA' }, { range: 'QQQQQ' }], intent: 'equity' }, 'QQQQQ');

// Percentage out of range.
expectError('reject: 150% out of range',
  { game: 'holdem', players: [{ range: '150%' }, { range: 'AA' }], intent: 'equity' }, '150%');

// Card collision: board card duplicated in dead.
expectError('reject: board/dead card collision',
  { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], board: 'Kh3c4c', dead: 'Kh', intent: 'equity' }, 'cards');

// Explicit hand collides with board.
expectError('reject: explicit hand collides with board',
  { game: 'holdem', players: [{ range: 'AsKs' }, { range: 'QQ' }], board: 'AsTd5c', intent: 'equity' }, 'cards');

// Bad game.
expectError('reject: unknown game',
  { game: 'razz', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' }, 'game');

// Too few players.
expectError('reject: only one player',
  { game: 'holdem', players: [{ range: 'AA' }], intent: 'equity' }, 'players');

// Unsupported intent.
expectError('reject: non-equity intent',
  { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'flop_set_frequency' }, 'intent');

// Board wrong size.
expectError('reject: 2-card board',
  { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], board: 'KhQh', intent: 'equity' }, 'board');

// Range that filters to zero combos (impossible after dead): AsKs but As is dead.
expectError('reject: range empties to 0 combos after dead',
  { game: 'holdem', players: [{ range: 'AsKs' }, { range: 'QQ' }], dead: 'As', intent: 'equity' }, 'cards');

// Board cards are blockers too: "AA" is impossible when the board holds 3 aces.
// This must be REJECTED (board cards block player ranges, not just `dead`).
expectError('reject: range blocked to 0 combos by the BOARD (not dead)',
  { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], board: 'AsAhAdKc4c', intent: 'equity' }, 'AA');

// Sanity: a board that does NOT exhaust the range still passes (only 2 aces gone).
(function () {
  var v = NL.validateQuery({ game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], board: 'AsAh2c3d4h', intent: 'equity' });
  ok('accept: AA still has combos when board holds only 2 aces', v.ok, JSON.stringify(v.errors));
})();

/* UNSUPPORTED-note path: model declined to emit a query. */
(function () {
  var parsed = NL.parseLLMResponse('UNSUPPORTED: the engine computes equity matchups, not the frequency of flopping a set.');
  ok('unsupported note: parseLLMResponse flags it', parsed.ok === false && parsed.unsupported === true, JSON.stringify(parsed));
})();

/* buildSystemPrompt sanity: contains contract + the production few-shot + the unsupported note. */
(function () {
  var sp = NL.buildSystemPrompt();
  ok('prompt mentions |||CALC|||', sp.indexOf('|||CALC|||') >= 0);
  ok('prompt keeps percentages as tokens (warns NOT to expand)', /NEVER expand a percentage/i.test(sp));
  ok('prompt has the AA-vs-20% Omaha few-shot', sp.indexOf('"20%"') >= 0 && sp.indexOf('omaha') >= 0);
  ok('prompt lists Omaha $ds', sp.indexOf('$ds') >= 0);
  ok('prompt has DO NOT EMIT / UNSUPPORTED section', /DO NOT EMIT|UNSUPPORTED/.test(sp));
})();

/* ================================================================== */
/* SUMMARY                                                             */
/* ================================================================== */
console.log('\n' + (fail === 0 ? 'ALL PASS' : 'SOME FAILED'));
console.log('pass=' + pass + ' fail=' + fail);
if (fail) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }

/* ==================================================================
 * NL TEST BATTERY (for later end-to-end equity checks)
 * ------------------------------------------------------------------
 * ~15 English questions -> expected structured query + ballpark equity
 * (Hero equity %, exhaustive/sampled). Adversarial / ambiguous ones marked.
 * These are NOT asserted here (they need the live equity engine); they are
 * the regression battery for the app's end-to-end LLM+engine pipeline.
 *
 *  1. "AA vs KK"                          -> holdem AA vs KK            ~ 82% Hero
 *  2. "AKs vs QQ"                         -> holdem AKs vs QQ           ~ 46% Hero
 *  3. "AA vs two random cards"            -> holdem AA vs *             ~ 85% Hero
 *  4. "AA vs top 20% in omaha"  (PROD)    -> omaha AA vs 20%            ~ 56-62% Hero (sampled)
 *  5. "double suited aces vs random PLO"  -> omaha AA$ds vs *           ~ 67% Hero
 *  6. "JT98ds vs aces in omaha"           -> omaha JT98$ds vs AA        ~ 42-46% Hero
 *  7. "AKs vs QQ flop Kh3c4c"             -> holdem AKs vs QQ /board    ~ 70-74% Hero (top pair + flush draw vs overpair... actually set-less)
 *  8. "AA vs KK vs QQ vs JTs four way"    -> holdem 4-way              Hero(AA) ~ 50-55%
 *  9. "top 5% vs 5%-15% preflop"          -> holdem 5% vs 5%-15%        ~ 55-60% top band
 * 10. "double board bomb pot AA vs KK"    -> doubleboard AA vs KK       ~ 80%+ (two boards, AA usually scoops/ties)
 * 11. "broadway rundowns vs aces omaha"   -> omaha AKQJ-T987:$ds vs AA  ~ 40-45% rundown
 * 12. "AK or QQ+ vs JJ"                   -> holdem AK,QQ+ vs JJ        ~ 52-56% combo range
 * 13. (AMBIGUOUS) "aces vs kings"         -> defaults to holdem AA vs KK (note: could be PLO; app should ask or default holdem) ~82%
 * 14. (ADVERSARIAL) "how often does AA flop a set?" -> UNSUPPORTED (not an equity matchup)
 * 15. (ADVERSARIAL) "AKo vs random, ace of spades is dead" -> holdem AKo vs *, dead=As  (blocker must land in `dead`, range stays AKo) ~ 65% Hero
 *
 * Battery checks for the app to add later:
 *   - #4 villain range stays the literal "20%" token (no 80-combo enumeration).
 *   - #14 yields an UNSUPPORTED note, not a fabricated query.
 *   - #15 blocker ends up in `dead`, never inside the range string.
 * ================================================================== */
