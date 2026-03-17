const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const PORT = process.env.PORT || 3000;

const PLAYER_COLORS = ['#FF4757','#1E90FF','#2ED573','#FFA502','#A29BFE','#FF6B81','#00D2D3','#ECCC68'];
const VALID_GAMES   = ['kites', 'trivia', 'drawing'];
const DRAWING_WORDS = [
  'apple','cat','house','tree','car','sun','fish','boat','pizza','snake',
  'crown','clock','cloud','bridge','guitar','elephant','robot','umbrella',
  'rocket','coffee','castle','butterfly','dragon','rainbow','volcano',
];
const ROUND_TIME    = 60; // seconds per drawing round
const rooms = {};

app.get('/', (req, res) => res.send('AirConsole backend is running ✅'));

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastPlayerList(room) {
  io.to(room.screenSocketId).emit('player-list', {
    players:      room.players.map(({ playerId, label, color }) => ({ playerId, label, color })),
    hostPlayerId: room.hostPlayerId,
    gameState:    room.gameState,
    activeGame:   room.activeGame,
  });
}
function buildJoinedPayload(room, playerId, label, color) {
  return {
    playerLabel: label, playerId, color,
    roomCode:     Object.keys(rooms).find(k => rooms[k] === room),
    hostPlayerId: room.hostPlayerId,
    gameState:    room.gameState,
    activeGame:   room.activeGame,
  };
}
function findPlayerSocket(room, playerId) {
  const e = room.players.find(p => p.playerId === playerId);
  return e ? io.sockets.sockets.get(e.socketId) : null;
}
function emitToControllers(room, event, payload) {
  room.players.forEach(({ socketId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit(event, payload);
  });
}

// ── Drawing game logic ────────────────────────────────────────────────────────
function startDrawingRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
  const dg = room.drawing;

  if (dg.artistIndex >= dg.artistQueue.length) {
    endDrawingGame(roomCode); return;
  }

  dg.currentArtistId = dg.artistQueue[dg.artistIndex++];
  dg.currentWord     = DRAWING_WORDS[Math.floor(Math.random() * DRAWING_WORDS.length)].toLowerCase();
  dg.roundStartTime  = Date.now();

  const artist = room.players.find(p => p.playerId === dg.currentArtistId);
  const artistName  = artist?.label || 'Someone';
  const artistColor = artist?.color || '#fff';

  console.log(`[drawing] Round ${dg.artistIndex}/${dg.artistQueue.length} — Artist: ${artistName} Word: ${dg.currentWord}`);

  // Tell the TV screen
  io.to(room.screenSocketId).emit('drawing-round-start', {
    artistId: dg.currentArtistId, artistName, artistColor,
    roundIndex: dg.artistIndex, totalRounds: dg.artistQueue.length,
    timeLimit: ROUND_TIME, wordLength: dg.currentWord.length,
  });

  // Tell each controller their role
  room.players.forEach(({ socketId, playerId }) => {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    if (playerId === dg.currentArtistId) {
      s.emit('drawing-role', { role: 'artist', word: dg.currentWord, artistName, artistColor });
    } else {
      s.emit('drawing-role', { role: 'guesser', artistName, artistColor });
    }
  });

  // Authoritative round timer
  if (dg.roundTimer) clearTimeout(dg.roundTimer);
  dg.roundTimer = setTimeout(() => {
    const r2 = rooms[roomCode];
    if (!r2 || r2.drawing?.currentWord !== dg.currentWord) return; // already resolved
    const word = dg.currentWord;
    dg.currentWord = null;
    io.to(r2.screenSocketId).emit('drawing-round-timeout', { word, artistName });
    emitToControllers(r2, 'drawing-round-timeout', { word });
    setTimeout(() => startDrawingRound(roomCode), 4000);
  }, ROUND_TIME * 1000);
}

function endDrawingGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const scores = room.drawing?.scores || {};
  console.log(`[drawing] Game over for room ${roomCode}`);
  io.to(room.screenSocketId).emit('drawing-game-end', { scores });
  emitToControllers(room, 'drawing-game-end', { scores });
}

// ── Socket logic ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect]    ${socket.id}`);

  socket.on('create-room', ({ roomCode }) => {
    if (!roomCode || roomCode.length !== 4) { socket.emit('error', { message: 'Room code must be 4 digits.' }); return; }
    rooms[roomCode] = { screenSocketId: socket.id, hostPlayerId: null, gameState: 'lobby', activeGame: 'kites', players: [], drawing: null };
    socket.join(roomCode);
    socket.emit('room-created', { roomCode });
    console.log(`[create-room] ${roomCode}`);
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room)                             { socket.emit('error', { message: `Room ${roomCode} does not exist.` }); return; }
    if (room.gameState === 'playing')      { socket.emit('error', { message: 'Match in progress. Wait for next round.' }); return; }
    if (room.players.length >= PLAYER_COLORS.length) { socket.emit('error', { message: 'Room is full.' }); return; }

    const rawName     = (typeof playerName === 'string') ? playerName.trim().replace(/[<>&"']/g, '').slice(0, 18) : '';
    const playerLabel = rawName || `Player ${room.players.length + 1}`;
    const playerColor = PLAYER_COLORS[room.players.length];
    const playerId    = socket.id;

    room.players.push({ socketId: socket.id, playerId, label: playerLabel, color: playerColor });
    socket.join(roomCode);
    if (room.players.length === 1) { room.hostPlayerId = playerId; }

    socket.data.roomCode = roomCode; socket.data.playerId = playerId;
    socket.data.playerLabel = playerLabel; socket.data.playerColor = playerColor;

    console.log(`[join-room]  ${playerLabel} → room ${roomCode}`);
    socket.emit('joined', buildJoinedPayload(room, playerId, playerLabel, playerColor));
    broadcastPlayerList(room);
  });

  socket.on('select-game', ({ roomCode, game }) => {
    const room = rooms[roomCode];
    if (!room || socket.data.playerId !== room.hostPlayerId) return;
    if (room.gameState === 'playing' || !VALID_GAMES.includes(game)) return;
    room.activeGame = game;
    console.log(`[select-game] Room ${roomCode} → ${game}`);
    io.to(room.screenSocketId).emit('game-selected', { activeGame: game });
    emitToControllers(room, 'game-selected', { activeGame: game });
  });

  socket.on('start-match', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.data.playerId !== room.hostPlayerId) return;
    if (room.gameState === 'playing') return;
    room.gameState = 'playing';
    console.log(`[start-match] Room ${roomCode} playing ${room.activeGame}`);
    io.to(room.screenSocketId).emit('match-started');
    emitToControllers(room, 'match-started', {});
    // Kick off drawing game loop
    if (room.activeGame === 'drawing') {
      const shuffled = [...room.players.map(p => p.playerId)].sort(() => Math.random() - 0.5);
      room.drawing = {
        artistQueue: shuffled, artistIndex: 0,
        currentArtistId: null, currentWord: null,
        scores: {}, roundTimer: null, roundStartTime: null,
      };
      // Seed scores to 0 for all players
      room.players.forEach(p => { room.drawing.scores[p.playerId] = 0; });
      setTimeout(() => startDrawingRound(roomCode), 1200); // let screen init first
    }
  });

  // Kites: controller → screen
  socket.on('jump', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;
    io.to(room.screenSocketId).emit('player-jumped', {
      playerId: socket.data.playerId, playerLabel: socket.data.playerLabel, color: socket.data.playerColor,
    });
  });

  // Drawing: only the current artist may emit drawing events
  socket.on('draw-start', ({ roomCode, x, y }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    if (socket.data.playerId !== room.drawing?.currentArtistId) return; // ← security
    const nx = Math.max(0, Math.min(1, Number(x) || 0));
    const ny = Math.max(0, Math.min(1, Number(y) || 0));
    io.to(room.screenSocketId).emit('draw-start', {
      playerId: socket.data.playerId, label: socket.data.playerLabel,
      color: socket.data.playerColor, x: nx, y: ny,
    });
  });

  socket.on('draw-move', ({ roomCode, x, y }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    if (socket.data.playerId !== room.drawing?.currentArtistId) return;
    const nx = Math.max(0, Math.min(1, Number(x) || 0));
    const ny = Math.max(0, Math.min(1, Number(y) || 0));
    io.to(room.screenSocketId).emit('draw-move', { playerId: socket.data.playerId, x: nx, y: ny });
  });

  socket.on('draw-end', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    if (socket.data.playerId !== room.drawing?.currentArtistId) return;
    io.to(room.screenSocketId).emit('draw-end', { playerId: socket.data.playerId });
  });

  // Drawing: guesses from non-artist controllers
  socket.on('drawing-guess', ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing' || room.activeGame !== 'drawing') return;
    const dg = room.drawing;
    if (!dg?.currentWord || !dg.currentArtistId) return;
    if (socket.data.playerId === dg.currentArtistId) return; // artist can't guess

    const safe = (typeof guess === 'string') ? guess.trim().replace(/[<>&"']/g, '').slice(0, 40) : '';
    if (!safe) return;

    if (safe.toLowerCase() === dg.currentWord) {
      // ── Correct! ──
      clearTimeout(dg.roundTimer);
      const word = dg.currentWord; dg.currentWord = null; // lock against double-win
      dg.scores[socket.data.playerId]  = (dg.scores[socket.data.playerId]  || 0) + 100;
      dg.scores[dg.currentArtistId]    = (dg.scores[dg.currentArtistId]    || 0) + 50;
      const timeMs = dg.roundStartTime ? Date.now() - dg.roundStartTime : 0;
      io.to(room.screenSocketId).emit('drawing-round-win', {
        word,
        winner: { playerId: socket.data.playerId, label: socket.data.playerLabel, color: socket.data.playerColor },
        artistId: dg.currentArtistId, scores: { ...dg.scores }, timeMs,
      });
      emitToControllers(room, 'drawing-round-win', {
        word, winnerLabel: socket.data.playerLabel, winnerPlayerId: socket.data.playerId,
        scores: { ...dg.scores },
      });
      setTimeout(() => startDrawingRound(roomCode), 5000);
    } else {
      // ── Wrong — broadcast as guess feed ──
      io.to(room.screenSocketId).emit('drawing-guess-feed', {
        playerId: socket.data.playerId, label: socket.data.playerLabel,
        color: socket.data.playerColor, guess: safe,
      });
    }
  });

  // Trivia events
  socket.on('trivia-question', ({ roomCode, questionIndex, question, options, timeLimit }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-question', { questionIndex, question, options, timeLimit });
  });
  socket.on('trivia-answer', ({ roomCode, answerIndex, timeMs }) => {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(room.screenSocketId).emit('trivia-answer', {
      playerId: socket.data.playerId, playerLabel: socket.data.playerLabel,
      color: socket.data.playerColor, answerIndex, timeMs,
    });
  });
  socket.on('trivia-result', ({ roomCode, correctIndex, scores, answers }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-result', { correctIndex, scores, answers });
  });
  socket.on('trivia-final', ({ roomCode, finalScores }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.screenSocketId) return;
    emitToControllers(room, 'trivia-final', { finalScores });
  });

  // Kites: screen relays elimination
  socket.on('player-eliminated', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const t = findPlayerSocket(room, playerId);
    if (t) t.emit('player-eliminated');
  });

  // Any game: lobby reset
  socket.on('game-reset', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.drawing?.roundTimer) clearTimeout(room.drawing.roundTimer);
    room.drawing    = null;
    room.gameState  = 'lobby';
    console.log(`[game-reset] Room ${roomCode} back to LOBBY`);
    emitToControllers(room, 'game-reset', { hostPlayerId: room.hostPlayerId });
    broadcastPlayerList(room);
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    for (const [code, room] of Object.entries(rooms)) {
      if (room.screenSocketId === socket.id) {
        if (room.drawing?.roundTimer) clearTimeout(room.drawing.roundTimer);
        delete rooms[code]; return;
      }
    }
    const rc = socket.data.roomCode;
    if (rc && rooms[rc]) {
      const room = rooms[rc];
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.hostPlayerId === socket.data.playerId && room.players.length > 0) {
        room.hostPlayerId = room.players[0].playerId;
        const nh = io.sockets.sockets.get(room.players[0].socketId);
        if (nh) nh.emit('host-assigned');
      }
      broadcastPlayerList(room);
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
