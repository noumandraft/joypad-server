const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;

const PLAYER_COLORS = [
  '#FF4757', '#1E90FF', '#2ED573', '#FFA502',
  '#A29BFE', '#FF6B81', '#00D2D3', '#ECCC68',
];

// rooms[code] = { screenSocketId, hostPlayerId, gameState, activeGame, players[] }
const rooms = {};

app.get('/', (req, res) => res.send('AirConsole backend is running ✅'));

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastPlayerList(room) {
  io.to(room.screenSocketId).emit('player-list', {
    players:     room.players.map(({ playerId, label, color }) => ({ playerId, label, color })),
    hostPlayerId: room.hostPlayerId,
    gameState:   room.gameState,
    activeGame:  room.activeGame,
  });
}

function buildJoinedPayload(room, playerId, playerLabel, playerColor) {
  return {
    playerLabel,
    playerId,
    color:        playerColor,
    roomCode:     Object.keys(rooms).find(k => rooms[k] === room),
    hostPlayerId: room.hostPlayerId,
    gameState:    room.gameState,
    activeGame:   room.activeGame,
  };
}

function findPlayerSocket(room, playerId) {
  const entry = room.players.find(p => p.playerId === playerId);
  return entry ? io.sockets.sockets.get(entry.socketId) : null;
}

// ── Socket logic ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect]    socket ${socket.id}`);

  // Screen creates a room
  socket.on('create-room', ({ roomCode }) => {
    if (!roomCode || roomCode.length !== 4) {
      socket.emit('error', { message: 'Room code must be exactly 4 digits.' });
      return;
    }
    rooms[roomCode] = {
      screenSocketId: socket.id,
      hostPlayerId:   null,
      gameState:      'lobby',
      activeGame:     'kites',   // ← Phase 2: host can change this before match start
      players:        [],
    };
    socket.join(roomCode);
    console.log(`[create-room] Room ${roomCode} created`);
    socket.emit('room-created', { roomCode });
  });

  // Controller joins a room
  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) { socket.emit('error', { message: `Room ${roomCode} does not exist.` }); return; }
    if (room.gameState === 'playing') { socket.emit('error', { message: 'Match already in progress. Wait for the next round.' }); return; }
    if (room.players.length >= PLAYER_COLORS.length) { socket.emit('error', { message: 'Room is full (max 8 players).' }); return; }

    // Sanitize name: strip HTML chars, trim, limit length, fall back to "Player N"
    const rawName    = (typeof playerName === 'string') ? playerName.trim().replace(/[<>&"']/g, '').slice(0, 18) : '';
    const playerNumber = room.players.length + 1;
    const playerLabel  = rawName || `Player ${playerNumber}`;
    const playerColor  = PLAYER_COLORS[room.players.length];
    const playerId     = socket.id;

    room.players.push({ socketId: socket.id, playerId, label: playerLabel, color: playerColor });
    socket.join(roomCode);

    if (room.players.length === 1) {
      room.hostPlayerId = playerId;
      console.log(`[host]       ${playerLabel} is now host of room ${roomCode}`);
    }

    socket.data.roomCode    = roomCode;
    socket.data.playerId    = playerId;
    socket.data.playerLabel = playerLabel;
    socket.data.playerColor = playerColor;

    console.log(`[join-room]  ${playerLabel} joined room ${roomCode} as ${playerColor}`);
    socket.emit('joined', buildJoinedPayload(room, playerId, playerLabel, playerColor));
    broadcastPlayerList(room);
  });

  // Host starts the match
  socket.on('start-match', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.data.playerId !== room.hostPlayerId) { socket.emit('error', { message: 'Only the host can start the match.' }); return; }
    if (room.gameState === 'playing') return;

    room.gameState = 'playing';
    console.log(`[start-match] Room ${roomCode} is now PLAYING (${room.activeGame})`);

    io.to(room.screenSocketId).emit('match-started');
    room.players.forEach(({ socketId }) => {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('match-started');
    });
  });

  // Controller jumps
  socket.on('jump', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameState !== 'playing') return;
    const { playerId, playerLabel, playerColor } = socket.data;
    io.to(room.screenSocketId).emit('player-jumped', { playerId, playerLabel, color: playerColor });
  });

  // Screen relays elimination to specific controller
  socket.on('player-eliminated', ({ roomCode, playerId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const target = findPlayerSocket(room, playerId);
    if (target) target.emit('player-eliminated');
  });

  // Screen signals end-of-round → back to lobby
  socket.on('game-reset', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState = 'lobby';
    console.log(`[game-reset] Room ${roomCode} back to LOBBY`);
    room.players.forEach(({ socketId }) => {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('game-reset', { hostPlayerId: room.hostPlayerId });
    });
    broadcastPlayerList(room);
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    console.log(`[disconnect] socket ${socket.id}`);
    for (const [code, room] of Object.entries(rooms)) {
      if (room.screenSocketId === socket.id) {
        console.log(`[cleanup]    Room ${code} removed (screen left)`);
        delete rooms[code];
        return;
      }
    }
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.hostPlayerId === socket.data.playerId && room.players.length > 0) {
        room.hostPlayerId = room.players[0].playerId;
        console.log(`[host-swap]  New host in room ${roomCode}`);
        const newHost = io.sockets.sockets.get(room.players[0].socketId);
        if (newHost) newHost.emit('host-assigned');
      }
      broadcastPlayerList(room);
    }
  });
});

server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
