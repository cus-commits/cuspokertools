// [wrapped in IIFE for safe classic-script loading in the browser:
//  prevents top-level decls (RANKS/SUITS/parseRange/API/etc.) from
//  leaking to the global scope and colliding with the app or each other.
//  module.exports and window.X assignments still work inside the IIFE.]
;(function(){
'use strict';
/*
 * nl-query.js
 * ------------------------------------------------------------------
 * The natural-language -> structured-query LLM layer for cusPokerTools.
 *
 * This module does NOT call Claude. The app does. This module:
 *   1. Defines and documents the STRUCTURED QUERY SCHEMA the model emits.
 *   2. buildSystemPrompt()  -> the Claude system prompt that teaches the
 *      model the contract + the EXACT supported PPT grammar + few-shots.
 *   3. parseLLMResponse(text) -> pull the model's reply apart. The model emits
 *      ONE of three outputs per turn:
 *        (a) |||CALC|||{query}|||END|||     -> { ok:true, query }
 *        (b) |||CLARIFY|||{questions,note}|||END||| -> { ok:false, clarify:true, questions, note }
 *        (c) UNSUPPORTED: <reason>          -> { ok:false, unsupported:true, error }
 *      Anything else -> { ok:false, error }. The LAST marker block wins (CALC or
 *      CLARIFY), so a model that reconsiders gets its final answer used.
 *   4. validateQuery(query)  -> the GUARDRAIL. Runs every player range through
 *      the REAL parsers (ppt-holdem / ppt-omaha). If a range throws or yields
 *      0 combos, returns a structured error naming the offending range. Also
 *      checks game shape, card collisions across board/dead/explicit hands,
 *      and well-formed percentages. Powers a self-repair re-prompt loop.
 *
 * Percentages ("20%", "10%-30%") are NEVER expanded by the model. They stay
 * as tokens; the engine resolves them (Omaha top-20% ~ 54k combos sampled by
 * the parser, NOT an 80-combo enumeration). validateQuery confirms the token
 * parses, it does not force enumeration.
 *
 * Public API:
 *   STRUCTURED_QUERY_SCHEMA   (doc object)
 *   buildSystemPrompt(opts?)  -> string
 *   parseLLMResponse(text)    -> { ok:true, query }
 *                              | { ok:false, clarify:true, questions:[...], note }
 *                              | { ok:false, unsupported:true, error }
 *                              | { ok:false, error }
 *   validateQuery(query)      -> { ok, errors:[{field,range?,message}], normalized? }
 *
 * Works in Node (module.exports) and the browser (window.NLQuery).
 */

/* ------------------------------------------------------------------ */
/* Parser modules (the source of truth for what is REALLY supported). */
/* ------------------------------------------------------------------ */
var Holdem, Omaha;
if (typeof module !== 'undefined' && module.exports) {
  Holdem = require('./ppt-holdem.js');
  Omaha = require('./ppt-omaha.js');
} else if (typeof window !== 'undefined') {
  Holdem = window.PPTHoldem;
  Omaha = window.PPTOmaha;
}

/* ================================================================== */
/* 1. STRUCTURED QUERY SCHEMA                                          */
/* ================================================================== */
/*
 * {
 *   game:    'holdem' | 'omaha' | 'doubleboard',   // required
 *   players: [ { label?: string, range: string }, ... ],  // >= 2
 *   board?:   string,   // e.g. "Kh3c4c"  (single-board games)
 *   board1?:  string,   // doubleboard only
 *   board2?:  string,   // doubleboard only
 *   dead?:    string,   // dead/blocker cards, e.g. "AsKd"  (NOT a range)
 *   intent:  'equity',  // only 'equity' is supported by the engine today
 *   assumptions?: string // plain-English statement of EVERY non-obvious
 *                        // interpretation the model made: game choice (and why),
 *                        // any invented/assumed board suits, how each vague range
 *                        // was read, and any ambiguity/contradiction it resolved.
 *                        // Surfaced verbatim to the user so they can verify the
 *                        // reading. Mandatory whenever the input is ambiguous.
 * }
 *
 * - `range` is a PPT Simple Range Syntax string. Percentages stay as
 *   "X%" / "X%-Y%" tokens; the engine resolves them (do NOT enumerate).
 * - `board`, `board1`, `board2`, `dead` are concatenated 2-char cards
 *   ("Ah", "Tc", ...), no separators. 3-5 cards on a board, any number dead.
 * - Blockers / "dead cards" go in `dead`, never inside a player range.
 */
var STRUCTURED_QUERY_SCHEMA = {
  game: ['holdem', 'omaha', 'doubleboard'],
  intent: ['equity'],
  fields: {
    game: 'holdem | omaha | doubleboard (required)',
    players: 'array of { label?, range } — at least 2 (required)',
    board: 'string of concatenated cards e.g. "Kh3c4c" (single-board games)',
    board1: 'doubleboard only — first board',
    board2: 'doubleboard only — second board',
    dead: 'string of dead/blocker cards e.g. "AsKd" (NOT a range)',
    intent: "'equity' (only supported intent today)",
    assumptions: 'plain-English statement of every non-obvious interpretation made (game choice + why, assumed board suits, how vague ranges were read, ambiguities resolved). Surfaced verbatim to the user.'
  }
};

/* Per-game hand length: how many cards a fully-specified hand has.
 * doubleboard is PLO — the equity engine deals 4-card Omaha holdings to each
 * player across both boards — so its hands are 4 cards, NOT 2. (Earlier this
 * was 2, which made the guardrail validate doubleboard ranges with the Hold'em
 * grammar and wrongly reject valid PLO tokens like AA$ds / AKQJ-T987 / RROO.) */
var HAND_LEN = { holdem: 2, omaha: 4, doubleboard: 4 };

/* ================================================================== */
/* 2. buildSystemPrompt()                                             */
/* ================================================================== */

var FEW_SHOTS = [
  {
    q: 'How does AA do vs the top 20% of hands in Omaha?',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'AA' }, { label: 'Villain', range: '20%' }], intent: 'equity' }
  },
  {
    q: 'AA vs KK heads up',
    a: { game: 'holdem', players: [{ label: 'AA', range: 'AA' }, { label: 'KK', range: 'KK' }], intent: 'equity' }
  },
  {
    q: 'double-suited aces against a random hand in PLO',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'AA$ds' }, { label: 'Villain', range: '*' }], intent: 'equity' }
  },
  {
    q: 'AKs vs a pair of queens, the flop came Kh3c4c',
    a: { game: 'holdem', players: [{ label: 'Hero', range: 'AKs' }, { label: 'Villain', range: 'QQ' }], board: 'Kh3c4c', intent: 'equity' }
  },
  {
    // The villain range hinges on "a flush draw", which needs a two-tone board —
    // but the board "6-4-7" was given without suits. Inventing a two-club board to
    // make the draw possible would MATERIALLY change the equity (whether a flush
    // draw even exists, and which suits), and the user plausibly just didn't type
    // the suits. So ASK rather than silently assume. (Read the hand as PLO: "top
    // set with 8-9" is a 4-card holding = top set of 7s plus the 8 and 9 -> 7789.)
    q: 'in PLO I have top set with 8-9 on a 6-4-7 board, villain has any 88 with at least a pair or a flush draw, or any 8-5',
    clarify: {
      questions: [
        'What were the exact board suits on the 6-4-7 — was it two of a suit so a flush draw is actually out there, and which suit?',
        'For villain\'s "88 with a flush draw" piece, do you want me to count any hand with an 8 plus two of the flush suit (I\'ll approximate the draw with the closest supported range and tell you what I included)?'
      ],
      note: 'Whether a flush draw even exists (and which suit) changes the equity, and the 6-4-7 board was given without suits — plausibly just left out. PLO read: top set with 8-9 = 7789.'
    }
  },
  {
    q: 'JT98 double suited vs 20% in Omaha',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'JT98$ds' }, { label: 'Villain', range: '20%' }], intent: 'equity' }
  },
  {
    q: 'AA vs KK vs QQ vs JT suited, four-way',
    a: { game: 'holdem', players: [{ range: 'AA' }, { range: 'KK' }, { range: 'QQ' }, { range: 'JTs' }], intent: 'equity' }
  },
  {
    q: 'AKo vs any two, but the ace of spades and king of spades are dead',
    a: { game: 'holdem', players: [{ label: 'Hero', range: 'AKo' }, { label: 'Villain', range: '*' }], dead: 'AsKs', intent: 'equity' }
  },
  {
    q: 'double board bomb pot: aces vs kings, both PLO double board',
    a: { game: 'doubleboard', players: [{ range: 'AA' }, { range: 'KK' }], intent: 'equity' }
  },
  {
    q: 'on a 2-2-5 rainbow flop I have an overpair of jacks, villain has any trips or better, equity?',
    a: { game: 'holdem', players: [{ label: 'Hero', range: 'JJ' }, { label: 'Villain', range: '2' }], board: '2c2d5h', intent: 'equity',
         assumptions: 'Hold\'em (two-card holdings, "overpair" + a single villain board-relative class). "Overpair of jacks" on a 2-2-5 board = JJ. Board stated rainbow with no exact suits; assumed 2c2d5h (three different suits) to honour "rainbow". "Any trips or better" on this paired board: trips needs a 2, so approximated as any hand containing a 2 (range "2"). This is an approximation — it includes 2x trips and full houses/quads but does not separately add the rare straight (3-4 making 2-3-4-5-6) since "or better" was read as trips-and-up of the board pair.' }
  },
  {
    q: 'top 5% vs 5%-15% preflop holdem',
    a: { game: 'holdem', players: [{ range: '5%' }, { range: '5%-15%' }], intent: 'equity' }
  },
  {
    q: 'big suited rundowns vs aces in Omaha (KQJT-type double suited)',
    a: { game: 'omaha', players: [{ label: 'Rundown', range: 'AKQJ-T987:$ds' }, { label: 'Aces', range: 'AA' }], intent: 'equity' }
  },
  {
    q: 'in PLO villain has four cards all nine or higher with at least one pair, hero has the double-suited KQJT rundown',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'KQJT$ds' }, { label: 'Villain', range: '$9+:RR' }], intent: 'equity' }
  },
  {
    q: 'how often does AA flop a set in holdem?',
    a: null,
    note: 'UNSUPPORTED. The engine computes hand-vs-hand/range equity on a given board, not "frequency of flopping X" probabilities. Set intent to "equity" only when the question maps to an equity matchup; otherwise return an "unsupported" note instead of a query.'
  },
  // ---- MATERIALITY few-shots: when missing info CHANGES the equity AND was --
  // ---- plausibly forgotten, ASK (bundle everything into ONE CLARIFY turn). --
  {
    q: 'i got the nut flush draw and two overcards on a queen-high board, he jams any top pair or better, am i ahead',
    clarify: {
      questions: [
        'What were your exact two cards (the nut flush draw means you hold two of a suit, and the two overcards — which ones)?',
        'What were the three (or more) exact board cards, and was it two-tone — i.e. two of one suit so the flush draw is live, and which suit?'
      ],
      note: 'The flush draw and overcards move the equity a lot, and "queen-high" gives the texture but not the exact cards/suits — those were plausibly just left out.'
    }
  },
  {
    q: 'on a 2-2-5 flop I have an overpair, villain has any set or a wheel draw',
    clarify: {
      questions: [
        'Is this Hold\'em or PLO?',
        'Which overpair do you have exactly (e.g. AA, KK, ...)? It changes which sets you dominate.',
        'What were the exact board suits on the 2-2-5 (rainbow, or two of a suit)?'
      ],
      note: 'Both the exact overpair and the board suits change the number here, and they were plausibly just not stated.'
    }
  },
  // ---- IMMATERIAL: suits/board don't move the equity (symmetry / no flush) ---
  // ---- so DON'T pester — compute and briefly note the arbitrary assumption. --
  {
    q: 'AA double suited vs the top 20% in PLO',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'AA$ds' }, { label: 'Villain', range: '20%' }], intent: 'equity',
         assumptions: 'PLO ("PLO" + "double suited"). No board, so the exact two suits of the double-suited aces are immaterial (suit-symmetric) — used AA$ds directly without asking.' }
  },
  {
    q: 'JT98 double suited vs aces preflop',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'JT98$ds' }, { label: 'Aces', range: 'AA' }], intent: 'equity',
         assumptions: 'PLO (4-card double-suited rundown). Preflop, no board, so the specific two suits are immaterial by symmetry — JT98$ds vs AA, no question needed.' }
  },
  {
    q: 'JT98 double suited vs 25% in Omaha on a King-high rainbow flop Kh7c2d',
    a: { game: 'omaha', players: [{ label: 'Hero', range: 'JT98$ds' }, { label: 'Villain', range: '25%' }], board: 'Kh7c2d', intent: 'equity',
         assumptions: 'Board fully given (Kh7c2d) and rainbow — no flush in play, so the hero\'s two suits relative to the board are immaterial; computed JT98$ds vs 25% on the given board without asking.' }
  }
];

function fewShotBlock() {
  var lines = [];
  for (var i = 0; i < FEW_SHOTS.length; i++) {
    var ex = FEW_SHOTS[i];
    lines.push('English: ' + ex.q);
    if (ex.clarify) {
      lines.push('Ask: |||CLARIFY|||' + JSON.stringify(ex.clarify) + '|||END|||');
    } else if (ex.a === null) {
      lines.push('UNSUPPORTED: ' + (ex.note || 'cannot be expressed as an equity matchup.'));
    } else {
      lines.push('Query: |||CALC|||' + JSON.stringify(ex.a) + '|||END|||');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildSystemPrompt(opts) {
  opts = opts || {};
  return [
'You translate plain-English poker equity questions into a STRUCTURED QUERY for the cusPokerTools engine.',
'',
'OUTPUT CONTRACT — emit EXACTLY ONE of these three, and NOTHING ELSE (no preamble,',
'no "Great question", no reasoning, no text before or after the block):',
'  (a) |||CALC|||{ ...query json... }|||END|||      -> you have everything; ready to compute.',
'  (b) |||CLARIFY|||{"questions":["..."],"note":"..."}|||END|||  -> you are missing MATERIAL info',
'      the user likely just forgot (see MATERIALITY below). Bundle EVERY question you need',
'      into this ONE block; never drip questions one at a time.',
'  (c) UNSUPPORTED: <reason>                          -> cannot be an equity matchup at all.',
'(Explaining in prose instead of emitting one of these is the #1 failure.)',
'For (a) the JSON is the structured query wrapped in markers, on its own line:',
'  |||CALC|||{ ...json... }|||END|||',
'The JSON MUST match this schema:',
'  { "game": "holdem"|"omaha"|"doubleboard",',
'    "players": [ { "label"?: string, "range": <PPT range string> }, ... ],  // >= 2 players',
'    "board"?:  <cards>,    // single-board games, e.g. "Kh3c4c"',
'    "board1"?: <cards>,    // doubleboard only',
'    "board2"?: <cards>,    // doubleboard only',
'    "dead"?:   <cards>,    // dead/blocker cards, e.g. "AsKd" (NEVER put blockers in a range)',
'    "intent":  "equity",   // only "equity" is supported',
'    "assumptions"?: <string> }  // SEE BELOW — mandatory when the input is ambiguous',
'Cards are concatenated 2-char tokens (rank + suit), no separators: "Ah", "Tc", "3c". A board has 3-5 cards.',
'',
'MATERIALITY — WHEN TO ASK (|||CLARIFY|||) vs WHEN TO JUST COMPUTE (|||CALC|||)',
'This is the most important judgment you make. Before asking ANY question, ask yourself:',
'  "Would the equity actually be DIFFERENT if I assumed this vs the truth?"',
'  - If NO (the answer is unchanged — suit symmetry, no flush in play, an irrelevant',
'    detail): DO NOT ASK. Pick a legal representative silently and note it briefly in',
'    "assumptions", then emit |||CALC|||. Pestering about immaterial detail is a failure.',
'  - If YES (it moves the number) AND the user plausibly just forgot to say it: ASK.',
'    Emit |||CLARIFY||| with EVERY missing material item bundled into ONE friendly turn.',
'ASK (material + plausibly forgotten) — examples:',
'  - "there was a flush draw on the board" -> which suit? was the board two-of-a-suit?',
'    do YOU hold that suit (do you actually have the draw)? (flush draws swing equity).',
'  - "I had two overcards" -> which exact cards? (the specific overcards change outs).',
'  - a board given by TEXTURE only ("queen-high", "2-2-5") when made hands or DRAWS are',
'    referenced -> what were the EXACT board cards and suits?',
'  - "double suited" WHEN a flush / board-suit interaction is in play -> which two suits,',
'    and do they match the board?',
'  - a referenced made-hand class that hinges on an unstated card ("an overpair" -> which',
'    one?) when that choice changes which hands dominate.',
'DO NOT ASK (immaterial — equity unchanged) — just compute, note the arbitrary pick:',
'  - "AA double suited vs the top 20% in PLO" -> no board; the exact two suits are',
'    suit-symmetric, equity is identical -> compute AA$ds vs 20%. No question.',
'  - "AA vs KK heads up" -> suits immaterial -> compute.',
'  - "JT98 double suited vs aces preflop" -> no board, symmetric -> compute.',
'  - any spot with NO flush / flush-draw in play and a rainbow or unspecified-but-',
'    immaterial board -> assign arbitrary legal suits silently (note it), do not pester.',
'TONE of CLARIFY questions: friendly and brief, like a poker buddy. e.g.',
'  "Quick Qs so I nail this: (1) was the flop two of a suit — a flush draw out there —',
'   and which suit? (2) what were your two overcards exactly?"',
'BUNDLE everything into the single CLARIFY; never ask one thing, then another next turn.',
'Note: Hold\'em straight draws (gutshot/OESD) and PLO board-suit flush draws are not exactly expressible',
'by the grammar. For those, either ASK for the specifics that let you approximate,',
'or compute the closest supported range and DISCLOSE the approximation in "assumptions" — never',
'emit nonsense, and never silently guess a detail that moves the number.',
'',
'ASSUMPTIONS FIELD — MANDATORY WHENEVER THE INPUT IS AMBIGUOUS, GAME-AMBIGUOUS, OR BOARD-RELATIVE',
'The user only sees the syntax you emit; they CANNOT see your reasoning. So you MUST record every',
'non-obvious interpretation in a short plain-English "assumptions" string. State EACH of:',
'  - GAME CHOICE and WHY ("4 named hole cards + a set plus extra cards = PLO, not Hold\'em").',
'  - Any board suits you INVENTED because the user gave ranks but no suits and a suit-dependent',
'    concept (flush draw / two-tone) needed them ("user gave board 6-4-7 with no suits; assumed two',
'    clubs so a flush draw is possible: 6c4c7h").',
'  - How you read each VAGUE or board-relative range ("top set" -> set of the highest board rank;',
'    "any top pair or better" -> pair of the top board card or a stronger made hand, approximated as ...).',
'  - Any AMBIGUITY or CONTRADICTION you resolved, and any concept you could only APPROXIMATE',
'    ("the engine has no exact \'wrap\' token, approximated the straight draws as open-enders + gutters").',
'It is FAR better to over-explain here than to silently guess. If the input is fully unambiguous',
'(e.g. "AA vs KK"), you may omit assumptions or keep it to one short line. When in doubt, include it.',
'',
'PERCENTAGES — CRITICAL',
'Keep "top X%" / range bands as literal tokens: "20%", "10%-30%". The engine resolves them itself',
'(Omaha top-20% is ~54,000 sampled combos, NOT a short enumerated list). NEVER expand a percentage',
'into specific hands, and NEVER replace it with "AA,KK,..." — just emit the "20%" token as the range.',
'',
'EXACTLY-SUPPORTED RANGE SYNTAX (do not invent anything outside this):',
'  Common (Hold\'em + Omaha):',
'    - pairs: AA, KK ; pair-plus: TT+ ; pair range: TT-77',
'    - operators: , (union/or)   : (intersection/and)   ! (difference/not)   ( ) grouping',
'    - percentages: 20%   10%-30%',
'    - wildcard: * (any card / any hand)',
'  Hold\'em-specific:',
'    - two ranks: AK, AKs, AKo  ; kicker-plus: AJs+, AJo+, AK+ ; suit alias: AK$s, AK$o',
'    - class dashes: A2s-A5s, K8s-K5s, 98s-76s (connectors) ; suit-specific: AhKh-AhTh',
'    - specific combo: AsKh ; single card present: As ; weight: AKs@50',
'    - ANY hand containing a rank: A (any ace), K (any king), Ax/A* (any ace) ; high-card presence Q-or-better: Q+',
'    - suitedness words: xx (suited), xy (offsuit) ; brackets: [A-J][T] , A[2-5]',
'  Omaha-specific (4-card):',
'    - suit groups: $ds (double-suited), $ss (single-suited), $ns (rainbow), wxyz (rainbow)',
'    - named ranks: AA, AAKK, AKQ ; pair-of + structure: AALL, AARR',
'    - rank variables: RR, RROO (two pair), RRON ; mixed: JRON',
'    - rundowns: AKQJ ; rundown range: AKQJ-T987, 9876- ; gaps: $0g, $1g, $2g',
'    - rank-class macros (ALL FOUR cards fall in the class). The classes are FIXED rank sets:',
'        $B = big (A,K,Q,J)   $F = face (K,Q,J)   $R = broadway (A,K,Q,J,T)',
'        $M = mid (T,9,8,7)   $Z = small (6,5,4,3,2)   $W = wheel (A,5,4,3,2)   $L = low (A,8,7,6,5,4,3,2)',
'      (Do NOT guess a macro means something else — e.g. $W is the WHEEL, NOT "broadway".)',
'    - rank-FLOOR / window macros (ALL FOUR cards satisfy a rank bound). USE THESE for',
'      "all cards N or higher / N or lower / between X and Y" when no fixed class fits:',
'        $9+  = every card rank >= 9     $T+ = every card >= T (same as $R)     $8+ = every card >= 8',
'        $9-  = every card rank <= 9     $9-Q = every card within 9..Q inclusive',
'      ("all four cards nine or higher" -> $9+ ; do NOT misuse $W/$R/$B which are fixed sets.)',
'    - "has at least one pair" filter: RR (some rank appears >= 2). Combine with : e.g. $9+:RR',
'      = all four cards nine-plus AND at least one pair.  $np (no pair), $nt (no trips)',
'    - suit variables (4 rank+suit-letter pairs): AxAyKxKy (AA-KK double-suited), AxAyKxKz (AA single-suited w/ KK)',
'    - explicit 4 cards: AsAhKsKd',
'',
'GAME DETECTION — decide Hold\'em vs Omaha/PLO from cues, then STATE the choice in assumptions:',
'  OMAHA / PLO cues (4-card hands):',
'    - the word "PLO", "Omaha", "double board", "bomb pot", "rundown", "double suited" / "single suited"',
'    - any player described by FOUR named cards/ranks ("KQJT", "aces and kings", "9876")',
'    - "top set WITH X-Y" / "a set PLUS two more cards" / "trips and a wrap" — a made hand PLUS extra',
'      cards is a 4-card holding => Omaha. e.g. "top set with 8-9" on a 6-4-7 board = a 4-card hand',
'      that holds two 7s (top set) AND an 8 and a 9 => "7789" (PLO).',
'    - "all combos" / "any two pair or better" / "wrap" / "rundown" alongside 4 ranks',
'  HOLD\'EM cues (2-card hands):',
'    - exactly TWO cards named ("AK", "8-9", "pocket jacks"), "suited connector", "AKs", "AKo"',
'    - "preflop", "3-bet", "hand vs hand" with 2-card holdings and no 4-card language',
'  If BOTH games are plausible, pick the one that lets you keep ALL of the user\'s words (dropping',
'  "the 8-9" to force Hold\'em is WRONG — that loss of information signals you picked the wrong game).',
'  Whatever you pick, say so in assumptions and explain the cue that decided it.',
'',
'BOARD-RELATIVE CONCEPTS — expand against the CONCRETE board; if the board is missing the suits a',
'concept needs, INVENT a representative board and SAY SO LOUDLY in assumptions (never silently):',
'  - "top set" = a set (three) of the HIGHEST board rank. Hold\'em: that pocket pair (e.g. board 6-4-7',
'    -> "77"). Omaha: a 4-card hand containing two of that rank plus the stated extras (e.g. "7789").',
'  - "top pair" = a hole card matching the highest board rank. "overpair" = a pocket pair higher than',
'    every board card (Hold\'em e.g. board 2-2-5 -> "JJ" is an overpair of jacks).',
'  - "flush draw" / "nut flush draw" = needs a TWO-TONE board (two of one suit) AND the drawing hand',
'    to hold two of that suit. This is MATERIAL: whether the draw exists at all, and which suit,',
'    changes the equity. So if the user referenced a flush draw but gave the board WITHOUT suits',
'    (e.g. "6-4-7", "queen-high"), DO NOT silently invent a two-tone board — emit |||CLARIFY||| and',
'    ASK which suit / whether it was two-tone / whether the hero holds that suit. Only invent + STATE',
'    a representative two-tone board when the flush detail is genuinely immaterial to the number asked.',
'  - "trips" = a hole card pairing a PAIRED board (board 2-2-5 -> any hand with a 2 -> Hold\'em "2",',
'    Omaha a 4-card hand containing a 2). "pairs the board" similar.',
'  - "two pair or better" / "top pair or better" / "any trips or better" / "any straight draw" are',
'    THRESHOLD ranges. The engine has no literal "or better" or "any draw" token. APPROXIMATE with the',
'    closest supported syntax (unions of the relevant made hands / draw shapes, or a wide "%" band if',
'    that is honestly the best you can do) and SAY in assumptions that it is an approximation and what',
'    you included/omitted. If you truly cannot approximate a clause, drop the IMPOSSIBLE part, keep the',
'    rest, and flag the omission in assumptions. Never emit a token you are unsure the grammar supports.',
'  - "wheel draw" = drawing to A-2-3-4-5; on a low board approximate with the wheel cards present',
'    ("A","2","3","4","5" holdings as supported) and note the approximation.',
'  Where a board-relative range cannot be made exact, it is BETTER to ship a clearly-labelled',
'  approximation than a silent guess. The assumptions string is where you are honest about the gap.',
'',
'CONTRADICTIONS / IMPOSSIBLE INPUT: if a clause is self-contradictory or cannot exist (e.g. a "flush',
'draw" demanded on a rainbow board you were forced to assume), make the most reasonable assumption,',
'flag it in assumptions, and still emit a valid query. Never crash, never emit unsupported tokens.',
'',
'DO NOT EMIT / UNSUPPORTED (the engine cannot compute these):',
'    - "frequency of flopping a set / making a straight / hitting a draw" style PROBABILITY questions',
'      (the engine does equity matchups on a given board, not made-hand frequencies).',
'    - intents other than "equity".',
'    - expanded percentage lists (keep the % token).',
'    - any token not listed above (e.g. "broadway+" Hold\'em-style, ICM, ranges-by-position names).',
'If a question cannot be expressed as an equity matchup, DO NOT emit a |||CALC||| block; instead reply',
'with a short note beginning "UNSUPPORTED:" explaining why.',
'',
'Route blockers / "X is dead" / "the Ace of spades is gone" into the "dead" field, never into a range.',
'For "vs a random hand" / "vs any two" use range "*". Multiway = add more players.',
'',
'FEW-SHOT EXAMPLES',
fewShotBlock(),
'Now translate the user\'s question. Emit EXACTLY ONE of: a |||CALC|||...|||END||| block, a',
'|||CLARIFY|||...|||END||| block (only when MATERIAL info was plausibly forgotten — see MATERIALITY),',
'or an "UNSUPPORTED:" note. When you DO compute and the input was ambiguous, game-ambiguous, or uses',
'board-relative concepts, you MUST include the "assumptions" string explaining every non-obvious',
'reading (including any immaterial detail you assigned arbitrarily). No prose outside the block.'
  ].join('\n');
}

/* ================================================================== */
/* 3. parseLLMResponse(text)                                          */
/* ================================================================== */

function parseLLMResponse(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'LLM response was not a string' };
  }

  // Detect an explicit unsupported note.
  var unsup = text.match(/UNSUPPORTED:\s*(.+)/i);

  // The model emits ONE of three outputs per turn:
  //   (a) |||CALC|||{...}|||END|||      — ready to compute
  //   (b) |||CLARIFY|||{...}|||END|||   — needs info the user likely forgot
  //   (c) UNSUPPORTED: <reason>         — not an equity matchup
  // CALC and CLARIFY share the |||...|||END||| envelope. A model may reconsider
  // and emit several blocks; the LAST marker block (of EITHER kind) is the answer.
  // We scan for both kinds in one pass so the true last block wins regardless of
  // type — a CLARIFY that follows a scratch CALC must not be overridden, and vice
  // versa.
  var markerRe = /\|\|\|(CALC|CLARIFY)\|\|\|([\s\S]*?)\|\|\|END\|\|\|/g;
  var lastKind = null, lastBody = null, mm;
  while ((mm = markerRe.exec(text)) !== null) {
    lastKind = mm[1].toUpperCase();
    lastBody = mm[2];
  }

  var jsonStr = null;
  if (lastBody !== null) {
    jsonStr = lastBody.trim();
  } else {
    // No marker block. Fall back to fenced / bare JSON (legacy CALC shapes only;
    // CLARIFY is always wrapped in markers per the contract).
    var fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
    var fenceAll = [], fm;
    while ((fm = fenceRe.exec(text)) !== null) fenceAll.push(fm[1]);
    if (fenceAll.length) {
      jsonStr = fenceAll[fenceAll.length - 1].trim();
    } else {
      // a bare {...} object somewhere in the text (first balanced-ish object)
      var brace = text.match(/\{[\s\S]*\}/);
      if (brace) jsonStr = brace[0].trim();
    }
  }

  if (jsonStr === null) {
    if (unsup) return { ok: false, error: 'UNSUPPORTED: ' + unsup[1].trim(), unsupported: true };
    return { ok: false, error: 'No structured query found in LLM response' };
  }

  var obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch (e) {
    var label = lastKind === 'CLARIFY' ? 'Clarify block' : 'Structured query';
    return { ok: false, error: label + ' is not valid JSON: ' + e.message };
  }

  // (b) CLARIFY: the model needs material info it judges the user likely forgot.
  if (lastKind === 'CLARIFY') {
    var questions = (obj && Array.isArray(obj.questions)) ? obj.questions.filter(function (q) {
      return typeof q === 'string' && q.trim() !== '';
    }) : [];
    if (questions.length === 0) {
      return { ok: false, error: 'Clarify block had no questions' };
    }
    return {
      ok: false,
      clarify: true,
      questions: questions,
      note: (obj && typeof obj.note === 'string') ? obj.note : ''
    };
  }

  // (a) CALC.
  return { ok: true, query: obj };
}

/* ================================================================== */
/* 4. validateQuery(query) — the GUARDRAIL                            */
/* ================================================================== */

/* Split a concatenated card string ("Kh3c4c") into ["Kh","3c","4c"]. */
function splitCards(str, fieldName, errors) {
  if (str === undefined || str === null || str === '') return [];
  if (typeof str !== 'string') {
    errors.push({ field: fieldName, message: fieldName + ' must be a string of cards' });
    return [];
  }
  var s = str.replace(/\s+/g, '');
  var out = [];
  var i = 0;
  while (i < s.length) {
    // allow "10x" -> "Tx"
    var rank, suit;
    if (s.slice(i, i + 2) === '10') { rank = 'T'; suit = s[i + 2]; i += 3; }
    else { rank = s[i]; suit = s[i + 1]; i += 2; }
    if (suit === undefined) {
      errors.push({ field: fieldName, message: 'Dangling card character in ' + fieldName + ': "' + str + '"' });
      break;
    }
    var card = rank + suit;
    if (!/^[2-9TJQKA][cdhs]$/i.test(card)) {
      errors.push({ field: fieldName, message: 'Invalid card "' + card + '" in ' + fieldName });
      break;
    }
    // normalize rank uppercase / suit lowercase
    out.push(card[0].toUpperCase() + card[1].toLowerCase());
  }
  return out;
}

/* Validate a single range against the REAL parser for the game. */
function validateRange(range, game, deadCards, errors, label) {
  if (typeof range !== 'string' || range.trim() === '') {
    errors.push({ field: 'players', range: range, message: 'Player ' + label + ' has an empty range' });
    return;
  }
  var isOmaha = (game === 'omaha');
  try {
    if (isOmaha) {
      var rr = Omaha.parseRange(range);
      // enumerate just enough to learn total; dead cards reduce the space.
      var en = rr.enumerate({ max: 1, dead: deadCards });
      if (en.total === 0) {
        errors.push({ field: 'players', range: range, message: 'Omaha range "' + range + '" (player ' + label + ') matches 0 hands' + (deadCards.length ? ' after dead cards' : '') });
      }
    } else {
      var res = Holdem.parseRange(range, { dead: deadCards });
      if (res.count === 0) {
        errors.push({ field: 'players', range: range, message: 'Hold\'em range "' + range + '" (player ' + label + ') yields 0 combos' + (deadCards.length ? ' after dead cards' : '') });
      }
    }
  } catch (e) {
    errors.push({ field: 'players', range: range, message: 'Range "' + range + '" (player ' + label + ') is not valid PPT syntax: ' + e.message });
  }
}

function validateQuery(query) {
  var errors = [];

  if (!query || typeof query !== 'object') {
    return { ok: false, errors: [{ field: 'query', message: 'Query is missing or not an object' }] };
  }

  // --- game ---
  var game = query.game;
  if (STRUCTURED_QUERY_SCHEMA.game.indexOf(game) < 0) {
    errors.push({ field: 'game', message: 'game must be one of ' + STRUCTURED_QUERY_SCHEMA.game.join(', ') + ' (got ' + JSON.stringify(game) + ')' });
  }

  // --- intent ---
  if (query.intent !== undefined && STRUCTURED_QUERY_SCHEMA.intent.indexOf(query.intent) < 0) {
    errors.push({ field: 'intent', message: 'Unsupported intent ' + JSON.stringify(query.intent) + ' (only "equity" is supported)' });
  }

  // --- assumptions (optional, but must be a string if present) ---
  if (query.assumptions !== undefined && typeof query.assumptions !== 'string') {
    errors.push({ field: 'assumptions', message: 'assumptions must be a plain-English string if present' });
  }

  // --- players ---
  if (!Array.isArray(query.players) || query.players.length < 2) {
    errors.push({ field: 'players', message: 'players must be an array of at least 2 entries' });
  }

  // --- boards / dead: collect card strings (game-aware) ---
  var deadCards = splitCards(query.dead, 'dead', errors);

  var boardCards = [];
  if (game === 'doubleboard') {
    if (query.board) errors.push({ field: 'board', message: 'doubleboard uses board1/board2, not board' });
    var b1 = splitCards(query.board1, 'board1', errors);
    var b2 = splitCards(query.board2, 'board2', errors);
    [['board1', b1], ['board2', b2]].forEach(function (p) {
      var name = p[0], cards = p[1];
      if (cards.length > 0 && (cards.length < 3 || cards.length > 5)) {
        errors.push({ field: name, message: name + ' must have 3-5 cards (got ' + cards.length + ')' });
      }
    });
    boardCards = b1.concat(b2);
  } else {
    if (query.board1 || query.board2) errors.push({ field: 'board', message: game + ' uses a single "board", not board1/board2' });
    boardCards = splitCards(query.board, 'board', errors);
    if (boardCards.length > 0 && (boardCards.length < 3 || boardCards.length > 5)) {
      errors.push({ field: 'board', message: 'board must have 3-5 cards (got ' + boardCards.length + ')' });
    }
  }

  // --- card collisions across board(s) + dead + explicit player hands ---
  // (a board card cannot be a dead card, two boards in doubleboard may legally
  // share? No — they are dealt from one deck, so all board+dead cards distinct.)
  var seen = {};
  var collisionSrc = [];
  function noteCards(cards, src) {
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (seen[c]) collisionSrc.push({ card: c, a: seen[c], b: src });
      else seen[c] = src;
    }
  }
  noteCards(boardCards, 'board');
  noteCards(deadCards, 'dead');

  // explicit fully-specified player hands (holdem AsKh / omaha AsAhKsKd) also
  // collide with board+dead. We only treat a range as "explicit cards" when it
  // is a single token of N specific cards (no operators).
  if (Array.isArray(query.players)) {
    var handLen = HAND_LEN[game] || 2;
    for (var pi = 0; pi < query.players.length; pi++) {
      var pr = query.players[pi] && query.players[pi].range;
      if (typeof pr === 'string' && new RegExp('^([2-9TJQKA][cdhs]){' + (handLen === 4 ? 4 : 2) + '}$', 'i').test(pr.replace(/\s+/g, ''))) {
        var pc = splitCards(pr, 'players', errors);
        noteCards(pc, 'player#' + (pi + 1));
      }
    }
  }
  for (var ci = 0; ci < collisionSrc.length; ci++) {
    var col = collisionSrc[ci];
    errors.push({ field: 'cards', message: 'Card ' + col.card + ' appears in both ' + col.a + ' and ' + col.b });
  }

  // --- each player range through the real parser ---
  // Board cards are dealt from the same deck, so they are blockers for every
  // player range exactly like dead cards. A range that is fully blocked by the
  // board (e.g. "AA" on a board holding three aces) yields 0 real combos and
  // must be rejected. Pass board+dead together as the blocker set.
  var rangeBlockers = deadCards.concat(boardCards);
  if (Array.isArray(query.players) && STRUCTURED_QUERY_SCHEMA.game.indexOf(game) >= 0) {
    for (var p = 0; p < query.players.length; p++) {
      var player = query.players[p];
      if (!player || typeof player !== 'object') {
        errors.push({ field: 'players', message: 'players[' + p + '] is not an object' });
        continue;
      }
      var lbl = player.label || ('#' + (p + 1));
      // doubleboard is PLO: the engine deals 4-card Omaha holdings across both
      // boards, so its ranges MUST validate with the Omaha (4-card) grammar,
      // exactly like 'omaha'. Only plain 'holdem' uses the 2-card grammar.
      var parseGame = (game === 'holdem') ? 'holdem' : 'omaha';
      validateRange(player.range, parseGame, rangeBlockers, errors, lbl);
    }
  }

  return { ok: errors.length === 0, errors: errors };
}

/* ================================================================== */
/* Result narration — MATH-FIRST, terse. See LLM_OUTPUT_CONTRACT.md.   */
/* ================================================================== */

// Deterministically render the SYNTAX + RESULT block. The app prints THIS,
// not the LLM, so the syntax + combo counts + equity are always present,
// exact, and never hallucinated or text-mangled. `result` shape:
//   { players:[{label, range, equity, combos, exact, trials}], board, dead }
function formatResultBlock(query, result) {
  var pad = function (s, n) { s = String(s); while (s.length < n) s += ' '; return s; };
  var players = (result && result.players) || (query && query.players) || [];
  var board = (query && (query.board || query.board1)) || (result && result.board) || '';
  var board2 = (query && query.board2) || (result && result.board2) || '';
  var dead = (query && query.dead) || (result && result.dead) || '';
  var game = (query && query.game) || (result && result.game) || '';

  // tag P1 as hero, others P2..Pn; pad the tag column to the widest tag.
  var tag = function (i) { return 'P' + (i + 1) + (i === 0 ? ' hero' : ''); };
  var tagW = 0;
  for (var ti = 0; ti < players.length; ti++) tagW = Math.max(tagW, tag(ti).length);
  tagW = Math.max(tagW, 7);

  // --- EXACT SYNTAX (copy-pasteable; APP_RULES.md rule 1) -------------------
  var lines = ['EXACT SYNTAX  (copy to verify in ProPokerTools)'];
  if (game) lines.push('  ' + pad('game', tagW) + '  ' + game);
  for (var i = 0; i < players.length; i++) {
    var gloss = players[i].gloss ? '   (' + players[i].gloss + ')' : '';
    lines.push('  ' + pad(tag(i), tagW) + '  ' + (players[i].range || '') + gloss);
  }
  lines.push('  ' + pad('board', tagW) + '  ' + (board || '—'));
  if (board2) lines.push('  ' + pad('board2', tagW) + '  ' + board2);
  lines.push('  ' + pad('dead', tagW) + '  ' + (dead || '—'));
  lines.push('');

  // --- RESULT: one row per player, exact range + its equity + combos --------
  lines.push('RESULT');
  for (var k = 0; k < players.length; k++) {
    var p = players[k];
    var eq = (p.equity !== undefined && p.equity !== null) ? (Number(p.equity).toFixed(1) + '%') : '—';
    var extra = '';
    if (p.combos !== undefined) {
      var how = p.exact ? 'exact' : ('sampled ' + (p.trials ? (p.trials >= 1000 ? Math.round(p.trials / 1000) + 'k' : p.trials) : '') + ' trials');
      extra = '   (' + Number(p.combos).toLocaleString() + ' combos, ' + how + ')';
    }
    lines.push('  ' + pad(tag(k), tagW) + '  ' + pad((p.range || ''), 12) + '  ' + pad(eq, 7) + extra);
  }
  // Deterministic board texture — COMPUTED from the cards, never guessed. This
  // replaces the old LLM "note" that hallucinated draws (e.g. flushes on a
  // rainbow board). Facts only: suit texture + paired/unpaired.
  if (board && board.length >= 6) {
    var bc = board.match(/../g) || [];
    var sct = {}, rct = {};
    for (var bi = 0; bi < bc.length; bi++) { sct[bc[bi][1]] = (sct[bc[bi][1]] || 0) + 1; rct[bc[bi][0]] = (rct[bc[bi][0]] || 0) + 1; }
    var maxSuit = 0; for (var sk in sct) if (sct[sk] > maxSuit) maxSuit = sct[sk];
    var suitTex = maxSuit >= 3 ? 'flush possible' : (maxSuit === 2 ? 'two-tone (flush draws live)' : 'rainbow — no flush draws');
    var paired = false; for (var rk in rct) if (rct[rk] >= 2) paired = true;
    lines.push('');
    lines.push('BOARD');
    lines.push('  ' + pad('texture', 16) + ' ' + suitTex + (paired ? ', paired' : ', unpaired'));
  }

  // --- INTERPRETATION / ASSUMPTIONS (always after the math) -----------------
  // The user must ALWAYS be able to see how their words were read: which game
  // was chosen and why, any board suits that were invented, how each vague /
  // board-relative range was approximated, and any ambiguity that was resolved.
  // This is the model's plain-English `assumptions` string, shown verbatim and
  // word-wrapped. If the model gave none, say so explicitly (never hide it).
  var assumptions = (query && query.assumptions) || (result && result.assumptions) || '';
  lines.push('');
  lines.push('INTERPRETATION / ASSUMPTIONS');
  if (assumptions && String(assumptions).trim()) {
    var words = String(assumptions).trim().split(/\s+/);
    var line = '  ', WRAP = 78;
    for (var wi = 0; wi < words.length; wi++) {
      if (line.length > 2 && (line.length + 1 + words[wi].length) > WRAP) { lines.push(line); line = '  '; }
      line += (line.length > 2 ? ' ' : '') + words[wi];
    }
    if (line.trim()) lines.push(line);
  } else {
    lines.push('  (none stated — the input was read literally / unambiguously)');
  }
  return lines.join('\n');
}

// The prompt for the OPTIONAL second LLM call. The math is already rendered by
// formatResultBlock; the model adds at most a 2-line factual note. No filler.
var OUTPUT_CONTRACT = [
  'You are a poker EQUITY CALCULATOR, not a coach. The math is already shown to',
  'the user (syntax, combo count, equities). Your ONLY job is an OPTIONAL note of',
  'AT MOST 2 short lines stating what is factually notable (what beats the hero,',
  'key cards, why the number is what it is).',
  'HARD RULES:',
  ' - Do NOT restate the equity numbers or the syntax (already shown).',
  ' - Do NOT cheerlead or praise ("crushing it", "great spot", "you did right", no emojis).',
  ' - Do NOT give strategy / bet-sizing / "you should..." unless the user explicitly asked.',
  ' - No multi-section essays, no "Bottom Line", no headers. Plain facts only.',
  ' - If nothing useful to add, output nothing.'
].join('\n');

function buildResultPrompt(query, result) {
  return OUTPUT_CONTRACT + '\n\nComputed result:\n' + formatResultBlock(query, result) +
    '\n\nYour optional <=2 line factual note (or empty):';
}

/* ================================================================== */
/* Exports                                                            */
/* ================================================================== */
var API = {
  STRUCTURED_QUERY_SCHEMA: STRUCTURED_QUERY_SCHEMA,
  HAND_LEN: HAND_LEN,
  buildSystemPrompt: buildSystemPrompt,
  parseLLMResponse: parseLLMResponse,
  validateQuery: validateQuery,
  formatResultBlock: formatResultBlock,
  buildResultPrompt: buildResultPrompt,
  OUTPUT_CONTRACT: OUTPUT_CONTRACT,
  _splitCards: splitCards
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else if (typeof window !== 'undefined') {
  window.NLQuery = API;
}

})();
