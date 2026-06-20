// board-range.test.js — run: node board-range.test.js
// Brute-force-verified tests for the board-relative range engine. Every count
// claimed by resolveBoardRange is independently re-derived from scratch here
// (separate predicate code + a separate Omaha evaluator) so the engine cannot
// "mark its own homework".
'use strict';
var B = require('./board-range.js');
var P = require('./ppt-eval.js');
var c = B.cards;
var R = '23456789TJQKA';
function fmt(h){ return h.map(function(x){return R[x>>2]+'cdhs'[x&3];}).join(''); }

var pass = 0, fail = 0;
function check(name, cond, extra){
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL:', name, extra != null ? '(' + extra + ')' : ''); }
}

// ===========================================================================
// INDEPENDENT predicate re-derivations (board = 5h4d2c assumed where used)
// ===========================================================================
var detect = P.detectStraight;
function rk(x){ return x>>2; }
function combos2(a){ return [[a[0],a[1]],[a[0],a[2]],[a[0],a[3]],[a[1],a[2]],[a[1],a[3]],[a[2],a[3]]]; }

function indMadeStraightPLO(h, board){
  var br = board.map(rk);
  var pairs = combos2(h);
  for (var i=0;i<pairs.length;i++){
    var bits=(1<<rk(pairs[i][0]))|(1<<rk(pairs[i][1]))|(1<<br[0])|(1<<br[1])|(1<<br[2]);
    if (detect(bits)>=0) return true;
  }
  return false;
}
function indDrawCardsPLO(h, board){
  if (indMadeStraightPLO(h, board)) return -1;
  var dead={}; h.forEach(function(x){dead[x]=1;}); board.forEach(function(x){dead[x]=1;});
  var n=0;
  for (var cc=0; cc<52; cc++){ if(dead[cc])continue;
    var nb=board.concat([cc]);
    var pairs=combos2(h); var b3=[[0,1,2],[0,1,3],[0,2,3],[1,2,3]]; var ok=false;
    for (var i=0;i<pairs.length&&!ok;i++) for (var j=0;j<b3.length;j++){
      var bits=(1<<rk(pairs[i][0]))|(1<<rk(pairs[i][1]))|(1<<rk(nb[b3[j][0]]))|(1<<rk(nb[b3[j][1]]))|(1<<rk(nb[b3[j][2]]));
      if (detect(bits)>=0){ok=true;break;}
    }
    if (ok) n++;
  }
  return n;
}
function indDrawRanksPLO(h, board){
  if (indMadeStraightPLO(h, board)) return -1;
  var dead={}; h.forEach(function(x){dead[x]=1;}); board.forEach(function(x){dead[x]=1;});
  var ranks={};
  for (var cc=0; cc<52; cc++){ if(dead[cc])continue;
    var nb=board.concat([cc]);
    var pairs=combos2(h); var b3=[[0,1,2],[0,1,3],[0,2,3],[1,2,3]]; var ok=false;
    for (var i=0;i<pairs.length&&!ok;i++) for (var j=0;j<b3.length;j++){
      var bits=(1<<rk(pairs[i][0]))|(1<<rk(pairs[i][1]))|(1<<rk(nb[b3[j][0]]))|(1<<rk(nb[b3[j][1]]))|(1<<rk(nb[b3[j][2]]));
      if (detect(bits)>=0){ok=true;break;}
    }
    if (ok) ranks[rk(cc)]=1;
  }
  return Object.keys(ranks).length;
}
function indTwoPairPLO(h, board){
  var bset={}; board.map(rk).forEach(function(x){bset[x]=1;});
  var paired={}; h.forEach(function(x){ if(bset[rk(x)]) paired[rk(x)]=1; });
  if (Object.keys(paired).length>=2) return true;
  var hc={}; h.forEach(function(x){hc[rk(x)]=(hc[rk(x)]||0)+1;});
  if (Object.keys(paired).length===1){
    for (var k in hc) if (hc[k]>=2 && Number(k)!==Number(Object.keys(paired)[0])) return true;
  }
  return false;
}
function indTopPairPLO(h, board){
  var top = Math.max.apply(null, board.map(rk));
  for (var i=0;i<h.length;i++) if (rk(h[i])===top) return true;
  var hc={}; h.forEach(function(x){hc[rk(x)]=(hc[rk(x)]||0)+1;});
  for (var k in hc) if (hc[k]>=2 && Number(k)>top) return true;
  return false;
}
function indSetPLO(h, board){
  var bset={}; board.map(rk).forEach(function(x){bset[x]=1;});
  var hc={}; h.forEach(function(x){hc[rk(x)]=(hc[rk(x)]||0)+1;});
  for (var k in hc) if (hc[k]>=2 && bset[k]) return true;
  return false;
}
function allPLOHands(board){
  var dead={}; board.forEach(function(x){dead[x]=1;});
  var deck=[]; for(var i=0;i<52;i++) if(!dead[i]) deck.push(i);
  var L=deck.length, out=[];
  for (var a=0;a<L-3;a++) for (var b=a+1;b<L-2;b++) for (var d=b+1;d<L-1;d++) for (var e=d+1;e<L;e++)
    out.push([deck[a],deck[b],deck[d],deck[e]]);
  return out;
}

// ===========================================================================
// 1. THE 542 BUG SPOT — exact spec the user described
// ===========================================================================
console.log('=== 542 RAINBOW (5h4d2c) — PLO ===');
var board = c('5h4d2c');
var spec = { twoPair:true, madeStraight:true, wrap:true, topPair:true, openEnder:true };
console.log('Spec:', JSON.stringify(spec));
console.log('Label:', B.describeSpec(spec, 'plo'));

var hands = allPLOHands(board);
console.log('Total PLO hand space (minus board):', hands.length);

// engine count
var resolved = B.resolveBoardRange('plo', board, spec);
console.log('Engine resolved count:', resolved.count);

// independent UNION count (twoPair OR madeStraight OR wrap(>=9) OR topPair OR OESD(2 ranks))
var indCount = 0;
for (var i=0;i<hands.length;i++){
  var h = hands[i];
  var made = indMadeStraightPLO(h, board);
  var oc = made ? -1 : indDrawCardsPLO(h, board);
  var orks = made ? -1 : indDrawRanksPLO(h, board);
  if (indTwoPairPLO(h,board) || made || oc>=9 || indTopPairPLO(h,board) || orks===2) indCount++;
}
console.log('Independent brute-force count:', indCount);
check('542 union count matches independent brute force', resolved.count === indCount,
      'engine=' + resolved.count + ' independent=' + indCount);

// examples
console.log('Examples:', resolved.combos.slice(0,5).map(fmt).join(' '));

// ===========================================================================
// 2. PER-PREDICATE counts each independently verified (542 board, PLO)
// ===========================================================================
console.log('\n=== PER-PREDICATE counts (542, PLO) vs independent ===');
function verifyPred(name, spec1, indFn){
  var eng = B.resolveBoardRange('plo', board, spec1).count;
  var ind = 0;
  for (var i=0;i<hands.length;i++) if (indFn(hands[i])) ind++;
  console.log('  ' + name + ': engine=' + eng + ' independent=' + ind);
  check(name + ' count matches', eng === ind, 'engine=' + eng + ' independent=' + ind);
  return eng;
}
verifyPred('madeStraight', {madeStraight:true}, function(h){ return indMadeStraightPLO(h,board); });
verifyPred('twoPair',      {twoPair:true},      function(h){ return indTwoPairPLO(h,board); });
verifyPred('topPair',      {topPair:true},      function(h){ return indTopPairPLO(h,board); });
verifyPred('set',          {set:true},          function(h){ return indSetPLO(h,board); });
verifyPred('wrap (>=9)',   {wrap:true},         function(h){ return indDrawCardsPLO(h,board)>=9; });
verifyPred('bigWrap (>=13)',{bigWrap:true},     function(h){ return indDrawCardsPLO(h,board)>=13; });
verifyPred('monsterWrap(>=17)',{monsterWrap:true},function(h){ return indDrawCardsPLO(h,board)>=17; });
verifyPred('openEnder (2 ranks)',{openEnder:true},function(h){ return !indMadeStraightPLO(h,board) && indDrawRanksPLO(h,board)===2; });
verifyPred('gutshot (1 rank)',{gutshot:true},   function(h){ return !indMadeStraightPLO(h,board) && indDrawRanksPLO(h,board)===1; });

// ===========================================================================
// 3. OR vs AND semantics
// ===========================================================================
console.log('\n=== OR vs AND semantics ===');
var orCount  = B.resolveBoardRange('plo', board, {twoPair:true, topPair:true}).count;
var andCount = B.resolveBoardRange('plo', board, {twoPair:true, topPair:true, all:true}).count;
// independent: OR = (2p OR tp), AND = (2p AND tp)
var io=0, ia=0;
for (var i=0;i<hands.length;i++){
  var t2=indTwoPairPLO(hands[i],board), tp=indTopPairPLO(hands[i],board);
  if (t2||tp) io++; if (t2&&tp) ia++;
}
check('OR (twoPair|topPair) matches', orCount===io, 'eng='+orCount+' ind='+io);
check('AND (twoPair&topPair) matches', andCount===ia, 'eng='+andCount+' ind='+ia);
check('AND <= OR', andCount <= orCount);

// ===========================================================================
// 4. HERO EQUITY vs resolved range AND vs "*" (engine + independent evaluator)
// ===========================================================================
console.log('\n=== HERO KK78 (KhKs7h8d) equity ===');
var hero = c('KhKs7h8d');
var resolvedRange = resolved.combos;

// independent omaha evaluator (separate from ppt-eval)
function eval5Ind(cs){
  var rc=new Array(13).fill(0), sc=[0,0,0,0], rs=new Array(13).fill(false);
  for (var i=0;i<5;i++){ rc[rk(cs[i])]++; sc[cs[i]&3]++; rs[rk(cs[i])]=true; }
  var flush=false; for (var s=0;s<4;s++) if (sc[s]===5) flush=true;
  function sh(){ for(var t=12;t>=4;t--){var ok=true;for(var k=0;k<5;k++)if(!rs[t-k]){ok=false;break;}if(ok)return t;} if(rs[12]&&rs[0]&&rs[1]&&rs[2]&&rs[3])return 3; return -1; }
  var st=sh();
  if (flush&&st>=0) return 8e6+st;
  var q=-1,tr=-1,pr=[]; for(var r=12;r>=0;r--){ if(rc[r]===4)q=r; else if(rc[r]===3)tr=r; else if(rc[r]===2)pr.push(r); }
  if (q>=0){ var k=-1; for(var r=12;r>=0;r--) if(rc[r]&&r!==q){k=r;break;} return 7e6+q*16+k; }
  if (tr>=0&&pr.length>=1) return 6e6+tr*16+pr[0];
  if (flush){ var sc2=5e6,sf=16,u=0; for(var r=12;r>=0&&u<5;r--) if(rc[r]){sc2+=r<<sf;sf-=4;u++;} return sc2; }
  if (st>=0) return 4e6+st;
  if (tr>=0){ var k1=-1,k2=-1; for(var r=12;r>=0;r--) if(rc[r]&&r!==tr){if(k1<0)k1=r;else if(k2<0)k2=r;} return 3e6+tr*256+k1*16+k2; }
  if (pr.length>=2){ var k=-1; for(var r=12;r>=0;r--) if(rc[r]&&r!==pr[0]&&r!==pr[1]){k=r;break;} return 2e6+pr[0]*256+pr[1]*16+k; }
  if (pr.length===1){ var ks=[]; for(var r=12;r>=0;r--) if(rc[r]&&r!==pr[0]) ks.push(r); return 1e6+pr[0]*4096+ks[0]*256+ks[1]*16+ks[2]; }
  var sc2=0,sf=16,u=0; for(var r=12;r>=0&&u<5;r--) if(rc[r]){sc2+=r<<sf;sf-=4;u++;} return sc2;
}
var C42=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
var C53=[]; (function(){ for(var a=0;a<3;a++)for(var b=a+1;b<4;b++)for(var d=b+1;d<5;d++) C53.push([a,b,d]); })();
function indEvalOmaha(hole,b5){
  var best=-1;
  for (var hi=0;hi<6;hi++) for (var bi=0;bi<10;bi++){
    var s=eval5Ind([hole[C42[hi][0]],hole[C42[hi][1]],b5[C53[bi][0]],b5[C53[bi][1]],b5[C53[bi][2]]]);
    if (s>best) best=s;
  }
  return best;
}
function indMC(hero, board, combos, N){
  var need=5-board.length, eq=0, trials=0;
  for (var t=0;t<N;t++){
    var v=combos[(Math.random()*combos.length)|0];
    var dead={}, bad=false; hero.forEach(function(x){dead[x]=1;}); board.forEach(function(x){dead[x]=1;});
    for (var i=0;i<v.length;i++){ if(dead[v[i]]){bad=true;break;} dead[v[i]]=1; }
    if (bad) continue;
    var deck=[]; for(var cc=0;cc<52;cc++) if(!dead[cc]) deck.push(cc);
    var fb=board.slice();
    for (var k=0;k<need;k++){ var j=(Math.random()*deck.length)|0; fb.push(deck[j]); deck[j]=deck[deck.length-1]; deck.pop(); }
    var hs=indEvalOmaha(hero,fb), vs=indEvalOmaha(v,fb);
    eq += hs>vs?1:(hs===vs?0.5:0); trials++;
  }
  return {equity:eq/trials, trials:trials};
}

var N = 120000;
var engVsRange = B.mcEquity('plo', hero, board, resolvedRange, N);
var indVsRange = indMC(hero, board, resolvedRange, N);
var engVsStar  = B.mcEquity('plo', hero, board, hands, N);
var indVsStar  = indMC(hero, board, hands, N);
console.log('vs RESOLVED range: engine ' + (engVsRange.equity*100).toFixed(2) + '%  independent ' + (indVsRange.equity*100).toFixed(2) + '%');
console.log('vs "*" any hand : engine ' + (engVsStar.equity*100).toFixed(2) + '%  independent ' + (indVsStar.equity*100).toFixed(2) + '%');
console.log('=> old "*" bug overstated hero by ~' + ((engVsStar.equity-engVsRange.equity)*100).toFixed(1) + ' equity points');

check('engine vs independent (resolved range) within 1.0%', Math.abs(engVsRange.equity-indVsRange.equity) < 0.01,
      'eng=' + (engVsRange.equity*100).toFixed(2) + ' ind=' + (indVsRange.equity*100).toFixed(2));
check('engine vs independent (star) within 1.0%', Math.abs(engVsStar.equity-indVsStar.equity) < 0.01,
      'eng=' + (engVsStar.equity*100).toFixed(2) + ' ind=' + (indVsStar.equity*100).toFixed(2));
check('resolved-range equity is LOWER than vs-star (range is stronger than random)',
      engVsRange.equity < engVsStar.equity - 0.02);

// ===========================================================================
// 5. HOLDEM support: madeStraight / openEnder / gutshot work; wrap ignored
// ===========================================================================
console.log('\n=== HOLDEM (5h4d2c) support ===');
function allHoldemHands(board){
  var dead={}; board.forEach(function(x){dead[x]=1;});
  var deck=[]; for(var i=0;i<52;i++) if(!dead[i]) deck.push(i);
  var L=deck.length, out=[];
  for (var a=0;a<L-1;a++) for (var b=a+1;b<L;b++) out.push([deck[a],deck[b]]);
  return out;
}
var hHands = allHoldemHands(board);
console.log('Total holdem hand space (minus board):', hHands.length, '(expect 1225 = C(49,2))');
check('holdem hand space = C(49,2)=1176? actually C(49,2)', hHands.length === 49*48/2);

// independent holdem made-straight (best 5 of hole2+board3 = detect over union ranks)
function indHoldemStraight(h, board){
  var bits=0; h.forEach(function(x){bits|=1<<rk(x);}); board.forEach(function(x){bits|=1<<rk(x);});
  return detect(bits)>=0;
}
var hStr = B.resolveBoardRange('holdem', board, {madeStraight:true});
var indHStr=0; for (var i=0;i<hHands.length;i++) if (indHoldemStraight(hHands[i],board)) indHStr++;
check('holdem madeStraight count matches', hStr.count===indHStr, 'eng='+hStr.count+' ind='+indHStr);

// wrap key is a no-op in holdem (count == madeStraight-only count)
var hWrapPlusStr = B.resolveBoardRange('holdem', board, {wrap:true, madeStraight:true}).count;
check('holdem ignores wrap key (count == madeStraight only)', hWrapPlusStr === hStr.count,
      'withWrap='+hWrapPlusStr+' strOnly='+hStr.count);

// holdem OESD example
var oe = B.analyze('holdem', c('6c7h'), board);
check('holdem 67 on 542 is open-ender (8 outs)', oe.openEnder && oe.straightOuts===8, 'outs='+oe.straightOuts);
var gut = B.analyze('holdem', c('7c8h'), board);
check('holdem 78 on 542 is gutshot (4 outs)', gut.gutshot && gut.straightOuts===4, 'outs='+gut.straightOuts);

// ===========================================================================
// 6. describeSpec labels
// ===========================================================================
console.log('\n=== describeSpec labels ===');
check('label OR list', B.describeSpec({twoPair:true,madeStraight:true,topPair:true},'plo')==='straight, two pair or top pair',
      B.describeSpec({twoPair:true,madeStraight:true,topPair:true},'plo'));
check('label single', B.describeSpec({wrap:true},'plo')==='wrap');
check('label AND', B.describeSpec({wrap:true,topPair:true,all:true},'plo')==='wrap and top pair');
check('label empty = any hand', B.describeSpec({},'plo')==='any hand');

console.log('\nboard-range test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
