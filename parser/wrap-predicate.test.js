// wrap-predicate.test.js — run: node wrap-predicate.test.js
'use strict';
var W = require('./wrap-predicate.js');
var c = W.cards;

var pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', name, extra != null ? '(' + extra + ')' : ''); }
}
function ranksStr(idxs){ var R='23456789TJQKA'; return idxs.map(function(i){return R[i>>2]+'cdhs'[i&3];}).join(' '); }

var board = c('4c8hTs');   // 4, 8, T
console.log('Board:', ranksStr(board), '\n');

// ---- Validation: user examples 97TJ and 9JQ8 ----
console.log('=== USER EXAMPLE HANDS ===');
[['97TJ','9c7dThJd'],['9JQ8','9cJdQh8s']].forEach(function(p){
  var hole = c(p[1]);
  var a = W.analyzeHand(hole, board);
  console.log(p[0], ranksStr(hole));
  console.log('   straightOuts(ranks)=' + a.straightOuts,
              'outCards=' + a.straightOutCards,
              'tier=' + a.wrapTier,
              'isWrap=' + a.isWrap,
              'isTopWrap=' + a.isTopWrap,
              'boardMaxOuts=' + a.boardMaxOuts);
  console.log('   hasPair=' + a.hasPair, 'isTopPair=' + a.isTopPair,
              'isSet=' + a.isSet, 'isTwoPair=' + a.isTwoPair, 'isTopTwoPair=' + a.isTopTwoPair,
              'madeCat=' + a.madeCategory);
});

// ---- Contrast: non-wrap hands ----
console.log('\n=== NON-WRAP CONTRAST HANDS ===');
[['Ac2d3h5s (junk gutshot/none)','Ac2d3h5s'],
 ['Kc7c2d3d (no draw)','Kd7c2d3d'],
 ['AcAdKhQc (overpair, gutshot)','AcAdKhQc']].forEach(function(p){
  var hole = c(p[1]);
  var a = W.analyzeHand(hole, board);
  console.log(p[0], '-> outs=' + a.straightOuts, 'tier=' + a.wrapTier,
              'isWrap=' + a.isWrap, 'hasPair=' + a.hasPair);
});

// ---- assertions ----
console.log('\n=== ASSERTIONS ===');
var a97 = W.analyzeHand(c('9c7dThJd'), board);
var a9J = W.analyzeHand(c('9cJdQh8s'), board);
check('97TJ is a wrap', a97.isWrap, 'outs=' + a97.straightOuts);
check('9JQ8 is a wrap', a9J.isWrap, 'outs=' + a9J.straightOuts);
check('97TJ has a pair (pairs the T)', a97.hasPair);

// ---- RANGE BUILD: set, top two pair, or top-wrap+pair ----
console.log('\n=== RANGE BUILD on', ranksStr(board), '===');
console.time('buildRange');
var range = W.buildRange(board, { set:true, topTwoPair:true, wrapPlusPair:true });  // OR
console.timeEnd('buildRange');
console.log('Combos in {set OR topTwoPair OR (topWrap AND pair)}:', range.length);

// breakdown
function countSpec(s){ return W.buildRange(board, s).length; }
console.log('  set only:', countSpec({set:true}));
console.log('  topTwoPair only:', countSpec({topTwoPair:true}));
console.log('  topWrap+pair only:', countSpec({wrapPlusPair:true}));

// ---- HERO EQUITY ----
console.log('\n=== HERO EQUITY ===');
var hero = c('4s4dJsJc');   // JJ44 -> set of fours on this board + pair of jacks
var ah = W.analyzeHand(hero, board);
console.log('Hero 4s4dJsJc:', 'isSet=' + ah.isSet, 'isTwoPair=' + ah.isTwoPair, 'madeCat=' + ah.madeCategory);
console.time('mc');
var eq = W.mcEquityVsRange(hero, board, range, 80000);
console.timeEnd('mc');
console.log('Hero equity vs the range: ' + (eq.equity*100).toFixed(2) + '%  (trials=' + eq.trials + ')');

console.log('\nwrap-predicate test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
