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
    query: { game: 'omaha', players: [{ range: 'AxAyKxKy' }, { range: '$R' }], intent: 'equity' } },

  { name: 'omaha per-card rank-floor + pair ($9+:RR)',
    q: 'KQJT double suited vs four cards all nine or higher with at least a pair, omaha',
    query: { game: 'omaha', players: [{ range: 'KQJT$ds' }, { range: '$9+:RR' }], intent: 'equity' } },

  { name: 'omaha rank-window macro ($9-Q)',
    q: 'aces vs four cards all between nine and queen in PLO',
    query: { game: 'omaha', players: [{ range: 'AA' }, { range: '$9-Q' }], intent: 'equity' } }
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
  // Macros must be DEFINED (the LLM previously guessed $W="broadway"; it is the wheel).
  ok('prompt defines $W as the wheel (not broadway)', /\$W\s*=\s*wheel/i.test(sp));
  ok('prompt teaches per-card rank-floor macro $9+', sp.indexOf('$9+') >= 0 && /every card rank >= 9/i.test(sp));
  // NEW: the smarter-interpretation upgrades must be present in the prompt.
  ok('prompt has the ASSUMPTIONS field instructions', /ASSUMPTIONS FIELD/.test(sp) && /assumptions/.test(sp));
  ok('prompt teaches GAME DETECTION (holdem vs PLO cues)', /GAME DETECTION/.test(sp) && /top set WITH/i.test(sp));
  ok('prompt teaches BOARD-RELATIVE concepts', /BOARD-RELATIVE CONCEPTS/.test(sp) && /flush draw/i.test(sp) && /top set/i.test(sp));
  ok('prompt teaches CONTRADICTION handling (never crash)', /CONTRADICTIONS|IMPOSSIBLE INPUT/i.test(sp));
  // The PLO "top set with 8-9" case now ASKS (the flush-draw board suits are
  // material + plausibly forgotten), and the 7789 reading still appears in it.
  ok('prompt has the PLO "top set with 8-9" -> 7789 few-shot (now a CLARIFY)', sp.indexOf('7789') >= 0 && /PLO read/.test(sp));
  ok('prompt instructs to ASK for flush-draw board suits when material', /ASK which suit|ASK for the specifics|invent \+ STATE/i.test(sp));
})();

/* ================================================================== */
/* ASSUMPTIONS FIELD — schema, validation, and rendering              */
/* ================================================================== */
(function () {
  // a) schema documents the assumptions field
  ok('schema documents assumptions field',
     NL.STRUCTURED_QUERY_SCHEMA.fields.assumptions !== undefined);

  // b) a query WITH an assumptions string still validates (it's optional + free text)
  var withAssump = NL.validateQuery({
    game: 'omaha',
    players: [{ label: 'Hero', range: '7789' }, { label: 'Villain', range: '88,8$ss,85' }],
    board: '6c4c7h', intent: 'equity',
    assumptions: 'Read as PLO; assumed two clubs on the board so a flush draw is possible.'
  });
  ok('query with a valid assumptions string validates', withAssump.ok, JSON.stringify(withAssump.errors));

  // c) a NON-string assumptions value is rejected with a clear, field-named error
  var badAssump = NL.validateQuery({
    game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity',
    assumptions: { not: 'a string' }
  });
  ok('non-string assumptions is rejected', !badAssump.ok);
  ok('non-string assumptions error names the field',
     badAssump.errors.some(function (e) { return e.field === 'assumptions'; }), JSON.stringify(badAssump.errors));

  // d) a query that round-trips through the |||CALC||| wrapper keeps assumptions
  var roundTrip = runMocked({
    game: 'omaha', players: [{ range: '7789' }, { range: '88,8$ss,85' }],
    board: '6c4c7h', intent: 'equity',
    assumptions: 'PLO reading: top set of 7s plus 8-9 = 7789; assumed two-club board.'
  });
  ok('assumptions survives parseLLMResponse round-trip',
     roundTrip.parsedOk && roundTrip.query.assumptions &&
     roundTrip.query.assumptions.indexOf('7789') >= 0, JSON.stringify(roundTrip.query && roundTrip.query.assumptions));

  // e) formatResultBlock RENDERS an INTERPRETATION / ASSUMPTIONS section verbatim
  var blockWith = NL.formatResultBlock(
    { game: 'omaha', players: [{ label: 'Hero', range: '7789' }, { label: 'V', range: '88,8$ss,85' }],
      board: '6c4c7h', assumptions: 'Assumed two clubs so a flush draw is possible.' },
    { players: [{ label: 'Hero', range: '7789', equity: 80, combos: 96, exact: true },
                { label: 'V', range: '88,8$ss,85', equity: 20, combos: 4936, exact: false, trials: 60000 }] });
  ok('result block has an INTERPRETATION / ASSUMPTIONS section',
     /INTERPRETATION \/ ASSUMPTIONS/.test(blockWith));
  ok('result block prints the assumptions text verbatim',
     blockWith.indexOf('Assumed two clubs so a flush draw is possible.') >= 0);
  ok('result block still shows the EXACT SYNTAX (math kept)',
     /EXACT SYNTAX/.test(blockWith) && blockWith.indexOf('7789') >= 0);

  // f) when NO assumptions are given, the section still appears and says so
  //    (the user must NEVER be left unable to see how their words were read)
  var blockNo = NL.formatResultBlock(
    { game: 'holdem', players: [{ label: 'Hero', range: 'AA' }, { label: 'V', range: 'KK' }] },
    { players: [{ label: 'Hero', range: 'AA', equity: 82, combos: 6, exact: true },
                { label: 'V', range: 'KK', equity: 18, combos: 6, exact: true }] });
  ok('result block shows the INTERPRETATION section even with no assumptions',
     /INTERPRETATION \/ ASSUMPTIONS/.test(blockNo) && /none stated/i.test(blockNo));
})();

/* ================================================================== */
/* DOUBLEBOARD = PLO: ranges validate with the 4-card Omaha grammar    */
/* ================================================================== */
(function () {
  // Regression: doubleboard is PLO (the engine deals 4-card Omaha holdings),
  // so PLO-only tokens (AA$ds, rundown dashes, RROO) MUST validate. Before the
  // fix these were wrongly rejected because doubleboard used the Hold'em parser.
  var v = NL.validateQuery({
    game: 'doubleboard',
    players: [{ label: 'Hero', range: 'AA$ds' },
              { label: 'Rundowns', range: 'AKQJ-T987' },
              { label: 'TwoPair+', range: 'RROO' }],
    intent: 'equity'
  });
  ok('doubleboard accepts PLO-only ranges (AA$ds / rundown / RROO)', v.ok, JSON.stringify(v.errors));
  ok('HAND_LEN.doubleboard is 4 (PLO), not 2', NL.HAND_LEN.doubleboard === 4);

  // A range that is NOT valid Omaha must still be rejected on a doubleboard.
  var bad = NL.validateQuery({
    game: 'doubleboard', players: [{ range: 'AA' }, { range: 'ZZZ' }], intent: 'equity'
  });
  ok('doubleboard still rejects a garbage Omaha range', !bad.ok &&
     bad.errors.some(function (e) { return e.range === 'ZZZ' || (e.message && e.message.indexOf('ZZZ') >= 0); }),
     JSON.stringify(bad.errors));
})();

/* ================================================================== */
/* CLARIFY PARSE PATH — the third output type (ask the user)           */
/* ================================================================== */
(function () {
  // a) a well-formed CLARIFY block parses to { ok:false, clarify:true, questions, note }
  var clarifyText = 'Quick check first.\n|||CLARIFY|||' +
    JSON.stringify({ questions: ['Was the flop two of a suit, and which suit?', 'What were your two overcards?'],
                     note: 'The flush draw moves the equity and the suits were not stated.' }) +
    '|||END|||';
  var c = NL.parseLLMResponse(clarifyText);
  ok('CLARIFY parses to ok:false + clarify:true', c.ok === false && c.clarify === true, JSON.stringify(c));
  ok('CLARIFY surfaces the questions array', Array.isArray(c.questions) && c.questions.length === 2, JSON.stringify(c.questions));
  ok('CLARIFY carries the note line', typeof c.note === 'string' && /flush draw/.test(c.note), c.note);
  ok('CLARIFY is NOT mistaken for a CALC query', c.query === undefined && c.unsupported === undefined);

  // b) blank / whitespace questions are filtered; an empty list is an error
  var emptyClarify = NL.parseLLMResponse('|||CLARIFY|||' + JSON.stringify({ questions: ['', '  '], note: 'x' }) + '|||END|||');
  ok('CLARIFY with no real questions is an error', emptyClarify.ok === false && !emptyClarify.clarify && /no questions/i.test(emptyClarify.error), JSON.stringify(emptyClarify));

  // c) the LAST marker block wins, regardless of kind: a scratch CALC followed by
  //    a CLARIFY must resolve to CLARIFY (the model reconsidered and decided to ask).
  var calcThenClarify = 'Hmm.\n|||CALC|||' + JSON.stringify({ game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' }) +
    '|||END|||\nWait, I actually need to ask.\n|||CLARIFY|||' + JSON.stringify({ questions: ['Hold\'em or PLO?'], note: 'game unstated' }) + '|||END|||';
  var ctc = NL.parseLLMResponse(calcThenClarify);
  ok('last block wins: CALC then CLARIFY -> CLARIFY', ctc.ok === false && ctc.clarify === true, JSON.stringify(ctc));

  // d) and the reverse: a scratch CLARIFY followed by a final CALC resolves to CALC.
  var clarifyThenCalc = '|||CLARIFY|||' + JSON.stringify({ questions: ['?'], note: 'n' }) + '|||END|||\n' +
    'Actually I have enough.\n|||CALC|||' + JSON.stringify({ game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' }) + '|||END|||';
  var ctc2 = NL.parseLLMResponse(clarifyThenCalc);
  ok('last block wins: CLARIFY then CALC -> CALC', ctc2.ok === true && ctc2.query && ctc2.query.game === 'holdem', JSON.stringify(ctc2));

  // e) malformed JSON inside a CLARIFY is reported as a clarify-block JSON error (not a query error)
  var badJson = NL.parseLLMResponse('|||CLARIFY|||{ not valid json |||END|||');
  ok('malformed CLARIFY json is a clear error', badJson.ok === false && /Clarify block is not valid JSON/.test(badJson.error), JSON.stringify(badJson));
})();

/* ================================================================== */
/* MATERIALITY — the prompt teaches ask-vs-compute with worked few-shots */
/* ================================================================== */
(function () {
  var sp = NL.buildSystemPrompt();
  // The three-output contract is taught.
  ok('prompt teaches the |||CLARIFY||| output', sp.indexOf('|||CLARIFY|||') >= 0);
  ok('prompt has a MATERIALITY section', /MATERIALITY/.test(sp));
  // The core principle: would the equity actually differ?
  ok('prompt teaches the differ-or-not principle', /Would the equity actually be DIFFERENT/i.test(sp));
  // ASK exemplars (material + forgotten).
  ok('prompt: ASK on flush draw suits', /flush draw/i.test(sp) && /which suit/i.test(sp));
  ok('prompt: ASK on exact overcards', /two overcards/i.test(sp) && /exact/i.test(sp));
  ok('prompt: ASK on texture-only board with draws/made hands', /TEXTURE only|board given by TEXTURE/i.test(sp));
  // DO-NOT-ASK exemplars (immaterial by symmetry).
  ok('prompt: DO NOT ASK on AA$ds vs 20% PLO (symmetry)', /DO NOT ASK/i.test(sp) && /suit-symmetric/i.test(sp));
  // Bundle-into-one + friendly tone.
  ok('prompt: bundle all questions into ONE clarify', /BUNDLE|bundle/.test(sp) && /never (drip|ask one)/i.test(sp));
  ok('prompt: friendly poker-buddy tone for questions', /poker buddy/i.test(sp));
  // The worked few-shots are present (both an ASK and an immaterial COMPUTE).
  ok('prompt has a CLARIFY few-shot (Ask:)', /Ask: \|\|\|CLARIFY\|\|\|/.test(sp));
  ok('prompt has the AA$ds-vs-20% immaterial COMPUTE few-shot', /AA double suited vs the top 20% in PLO/.test(sp));
  // Approximation honesty for inexpressible draws.
  ok('prompt notes draws are not exactly expressible (approximate or ask)', /not exactly expressible|NOT exactly expressible/i.test(sp));
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
