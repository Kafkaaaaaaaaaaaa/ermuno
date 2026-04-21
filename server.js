const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// Game state
let rooms = {};

function createDeck() {
  const colors = ['red', 'green', 'blue', 'yellow'];
  const values = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
  let deck = [];
  for (const color of colors) {
    for (const val of values) {
      deck.push({ color, value: val });
      if (val !== '0') deck.push({ color, value: val });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild' });
    deck.push({ color: 'wild', value: 'wild4' });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dealHands(deck) {
  const hand1 = deck.splice(0, 7);
  const hand2 = deck.splice(0, 7);
  let topCard = deck.splice(0, 1)[0];
  // Make sure first card isn't a wild
  while (topCard.color === 'wild') {
    deck.push(topCard);
    shuffle(deck);
    topCard = deck.splice(0, 1)[0];
  }
  return { hand1, hand2, topCard, remaining: deck };
}

function canPlay(card, topCard, currentColor) {
  const activeColor = currentColor || topCard.color;
  if (card.color === 'wild') return true;
  if (card.color === activeColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function sendGameState(room) {
  room.players.forEach((p, idx) => {
    const opponent = room.players[1 - idx];
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({
        type: 'gameState',
        myHand: room.hands[idx],
        opponentCount: opponent ? room.hands[1 - idx].length : 0,
        topCard: room.topCard,
        currentColor: room.currentColor,
        currentTurn: room.currentTurn,
        myIndex: idx,
        drawPileCount: room.deck.length,
        unoCallable: room.unoCallable,
        unoCalled: room.unoCalled,
        winner: room.winner,
        players: room.players.map(pl => ({ name: pl.name }))
      }));
    }
  });
}

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerIndex = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const roomId = msg.roomId.toUpperCase();
      if (!rooms[roomId]) {
        rooms[roomId] = { players: [], hands: [], deck: [], topCard: null, currentColor: null, currentTurn: 0, winner: null, unoCallable: false, unoCalled: false };
      }
      const room = rooms[roomId];
      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full!' }));
        return;
      }
      playerRoom = roomId;
      playerIndex = room.players.length;
      room.players.push({ ws, name: msg.name });

      ws.send(JSON.stringify({ type: 'joined', index: playerIndex, roomId }));

      if (room.players.length === 2) {
        // Start game
        const { hand1, hand2, topCard, remaining } = dealHands(createDeck());
        room.hands = [hand1, hand2];
        room.deck = remaining;
        room.topCard = topCard;
        room.currentColor = topCard.color;
        room.currentTurn = 0;
        room.winner = null;
        broadcast(room, { type: 'gameStart' });
        sendGameState(room);
      } else {
        ws.send(JSON.stringify({ type: 'waiting', message: 'Waiting for opponent...' }));
      }
    }

    if (msg.type === 'playCard') {
      const room = rooms[playerRoom];
      if (!room || room.winner) return;
      if (room.currentTurn !== playerIndex) return;

      const hand = room.hands[playerIndex];
      const cardIdx = msg.cardIndex;
      const card = hand[cardIdx];
      if (!card) return;

      if (!canPlay(card, room.topCard, room.currentColor)) {
        ws.send(JSON.stringify({ type: 'error', message: "Can't play that card!" }));
        return;
      }

      hand.splice(cardIdx, 1);
      room.topCard = card;

      if (card.color === 'wild') {
        room.currentColor = msg.chosenColor || 'red';
      } else {
        room.currentColor = card.color;
      }

      // Check win
      if (hand.length === 0) {
        room.winner = playerIndex;
        broadcast(room, { type: 'gameOver', winner: playerIndex, winnerName: room.players[playerIndex].name });
        sendGameState(room);
        return;
      }

      // UNO check
      room.unoCallable = hand.length === 1;
      room.unoCalled = false;

      const opponent = 1 - playerIndex;

      // Handle special cards
      if (card.value === 'skip') {
        room.currentTurn = playerIndex; // same player goes again
      } else if (card.value === 'reverse') {
        room.currentTurn = playerIndex; // with 2 players, reverse = skip
      } else if (card.value === 'draw2') {
        for (let i = 0; i < 2; i++) {
          if (room.deck.length === 0) room.deck = shuffle([room.topCard]);
          room.hands[opponent].push(room.deck.pop());
        }
        room.currentTurn = playerIndex;
      } else if (card.value === 'wild4') {
        for (let i = 0; i < 4; i++) {
          if (room.deck.length === 0) room.deck = shuffle([room.topCard]);
          room.hands[opponent].push(room.deck.pop());
        }
        room.currentTurn = playerIndex;
      } else {
        room.currentTurn = opponent;
      }

      sendGameState(room);
    }

    if (msg.type === 'drawCard') {
      const room = rooms[playerRoom];
      if (!room || room.winner) return;
      if (room.currentTurn !== playerIndex) return;

      if (room.deck.length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'No cards left to draw!' }));
        return;
      }

      const card = room.deck.pop();
      room.hands[playerIndex].push(card);
      room.currentTurn = 1 - playerIndex;
      sendGameState(room);
    }

    if (msg.type === 'callUno') {
      const room = rooms[playerRoom];
      if (!room) return;
      room.unoCalled = true;
      broadcast(room, { type: 'unoCalled', playerName: room.players[playerIndex].name });
      sendGameState(room);
    }

    if (msg.type === 'catchUno') {
      const room = rooms[playerRoom];
      if (!room) return;
      // If opponent has 1 card and didn't call UNO, penalize them
      const opponent = 1 - playerIndex;
      if (room.hands[opponent].length === 1 && !room.unoCalled) {
        for (let i = 0; i < 2; i++) {
          if (room.deck.length > 0) room.hands[opponent].push(room.deck.pop());
        }
        broadcast(room, { type: 'unoCaught', caughtName: room.players[opponent].name });
        sendGameState(room);
      }
    }

    if (msg.type === 'rematch') {
      const room = rooms[playerRoom];
      if (!room) return;
      if (!room.rematchVotes) room.rematchVotes = new Set();
      room.rematchVotes.add(playerIndex);
      if (room.rematchVotes.size === 2) {
        const { hand1, hand2, topCard, remaining } = dealHands(createDeck());
        room.hands = [hand1, hand2];
        room.deck = remaining;
        room.topCard = topCard;
        room.currentColor = topCard.color;
        room.currentTurn = 0;
        room.winner = null;
        room.unoCallable = false;
        room.unoCalled = false;
        room.rematchVotes = new Set();
        broadcast(room, { type: 'gameStart' });
        sendGameState(room);
      } else {
        broadcast(room, { type: 'rematchWaiting', playerName: room.players[playerIndex].name });
      }
    }
  });

  ws.on('close', () => {
    if (playerRoom && rooms[playerRoom]) {
      broadcast(rooms[playerRoom], { type: 'playerLeft' });
      delete rooms[playerRoom];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO server running on port ${PORT}`));
