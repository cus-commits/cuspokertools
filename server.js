const http = require('http');
const { TexasHoldem, Omaha } = require('poker-odds-calc');

const PORT = 3847;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function runEquity(params) {
  const { gameType, hands, board, board1, board2 } = params;

  if (gameType === 'holdem') {
    const calc = new TexasHoldem();
    if (board && board.length) calc.setBoard(board);
    for (const h of hands) calc.addPlayer(h);
    const result = calc.calculate();
    const players = result.getPlayers().map(p => ({
      win: parseFloat(p.getWinsPercentageString().replace('~','').replace('%','')) / 100,
      tie: parseFloat(p.getTiesPercentageString().replace('~','').replace('%','')) / 100,
    }));
    return { gameType, players, time: result.getTime(), board: board || [] };
  }

  if (gameType === 'omaha') {
    const calc = new Omaha();
    if (board && board.length) calc.setBoard(board);
    for (const h of hands) calc.addPlayer(h);
    const result = calc.calculate();
    const players = result.getPlayers().map(p => ({
      win: parseFloat(p.getWinsPercentageString().replace('~','').replace('%','')) / 100,
      tie: parseFloat(p.getTiesPercentageString().replace('~','').replace('%','')) / 100,
    }));
    return { gameType, players, time: result.getTime(), board: board || [] };
  }

  if (gameType === 'doubleBoard') {
    // Run each board separately, combine results
    const r1 = runEquity({ gameType: 'omaha', hands, board: board1 });
    const r2 = runEquity({ gameType: 'omaha', hands, board: board2 });
    const players = hands.map((_, i) => ({
      board1Equity: r1.players[i].win + r1.players[i].tie,
      board2Equity: r2.players[i].win + r2.players[i].tie,
      overallEquity: (r1.players[i].win + r1.players[i].tie + r2.players[i].win + r2.players[i].tie) / 2,
      scoop: 0 // Can't easily compute scoop from separate runs
    }));
    return { gameType, players, time: r1.time + r2.time, board1: board1 || [], board2: board2 || [] };
  }

  throw new Error('Unknown game type: ' + gameType);
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/equity') {
    try {
      const params = await parseBody(req);
      const result = runEquity(params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/range') {
    try {
      const params = await parseBody(req);
      const { gameType, heroHand, oppHands, board, board1, board2 } = params;
      let totalHeroEq = 0;
      let totalB1 = 0, totalB2 = 0;
      const startTime = Date.now();

      for (const oppHand of oppHands) {
        const hands = [heroHand, oppHand];
        if (gameType === 'doubleBoard') {
          const r = runEquity({ gameType, hands, board1, board2 });
          totalHeroEq += r.players[0].overallEquity;
          totalB1 += r.players[0].board1Equity;
          totalB2 += r.players[0].board2Equity;
        } else {
          const r = runEquity({ gameType, hands, board });
          totalHeroEq += r.players[0].win + r.players[0].tie;
        }
      }

      const n = oppHands.length;
      const result = {
        heroEquity: totalHeroEq / n,
        oppEquity: 1 - totalHeroEq / n,
        combos: n,
        time: Date.now() - startTime,
        gameType
      };
      if (gameType === 'doubleBoard') {
        result.heroB1 = totalB1 / n;
        result.heroB2 = totalB2 / n;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', engine: 'poker-odds-calc' }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('cusPokerTools engine server running on http://localhost:' + PORT);
  console.log('Endpoints:');
  console.log('  POST /equity  — run equity calculation');
  console.log('  GET  /health  — check server status');
  console.log('');
  console.log('Example:');
  console.log('  curl -X POST http://localhost:' + PORT + '/equity \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"gameType":"holdem","hands":[["Ah","As"],["Kd","Kc"]]}\'');
});
