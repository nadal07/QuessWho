const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const words = require('./words.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Room State ────────────────────────────────────────────────────────────
// rooms[code] = {
//   code, hostId,
//   players: [{ id, name, isHost }],
//   phase: 'lobby' | 'reveal' | 'clues' | 'voting' | 'results',
//   wordPair: { civilian, impostor, category },
//   impostorId: socketId,
//   clues: [{ playerId, playerName, clue }],
//   votes: { [voterId]: votedForId },
//   clueOrder: [socketId, ...],
//   currentClueIndex: number,
// }
const rooms = {};

// ─── Helpers ───────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateCode() : code;
}

function getRoomSafe(code) {
  return rooms[code] || null;
}

function broadcastLobby(code) {
  const room = getRoomSafe(code);
  if (!room) return;
  io.to(code).emit('lobby-update', {
    players: room.players,
    hostId: room.hostId,
    code: room.code,
  });
}

function removePlayer(socketId) {
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    const idx = room.players.findIndex(p => p.id === socketId);
    if (idx === -1) continue;

    const wasHost = room.players[idx].isHost;
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      delete rooms[code];
      return;
    }

    // Transfer host
    if (wasHost && room.players.length > 0) {
      room.players[0].isHost = true;
      room.hostId = room.players[0].id;
    }

    if (room.phase === 'lobby') {
      broadcastLobby(code);
    } else {
      io.to(code).emit('player-left', {
        players: room.players,
        hostId: room.hostId,
      });
    }

    // If only 1 player left mid-game, abort
    if (room.players.length < 2 && room.phase !== 'lobby') {
      io.to(code).emit('game-aborted', { reason: 'Not enough players to continue.' });
      room.phase = 'lobby';
      room.clues = [];
      room.votes = {};
      room.impostorId = null;
      room.wordPair = null;
    }
    return;
  }
}

// ─── Socket Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // CREATE ROOM
  socket.on('create-room', ({ name }) => {
    if (!name || name.trim().length === 0) return;
    const code = generateCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: name.trim(), isHost: true }],
      phase: 'lobby',
      wordPair: null,
      impostorId: null,
      clues: [],
      votes: {},
      clueOrder: [],
      currentClueIndex: 0,
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name.trim();
    socket.emit('room-created', { code });
    broadcastLobby(code);
  });

  // JOIN ROOM
  socket.on('join-room', ({ code, name }) => {
    const upperCode = (code || '').trim().toUpperCase();
    const room = getRoomSafe(upperCode);

    if (!room) return socket.emit('join-error', { message: 'Room not found. Check your code!' });
    if (room.phase !== 'lobby') return socket.emit('join-error', { message: 'Game already in progress.' });
    if (room.players.length >= 10) return socket.emit('join-error', { message: 'Room is full (max 10 players).' });
    if (!name || name.trim().length === 0) return socket.emit('join-error', { message: 'Please enter your name.' });

    const trimmedName = name.trim();
    const duplicate = room.players.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) return socket.emit('join-error', { message: 'Name already taken in this room.' });

    room.players.push({ id: socket.id, name: trimmedName, isHost: false });
    socket.join(upperCode);
    socket.data.roomCode = upperCode;
    socket.data.name = trimmedName;
    socket.emit('join-success', { code: upperCode });
    broadcastLobby(upperCode);
  });

  // START GAME (host only)
  socket.on('start-game', () => {
    const code = socket.data.roomCode;
    const room = getRoomSafe(code);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error', { message: 'Only the host can start the game.' });
    if (room.players.length < 3) return socket.emit('error', { message: 'Need at least 3 players to start.' });
    if (room.phase !== 'lobby') return;

    // Pick a random word pair
    const pair = words[Math.floor(Math.random() * words.length)];
    room.wordPair = pair;

    // Pick a random impostor (not host to keep it fair — actually random is better)
    const impostorIndex = Math.floor(Math.random() * room.players.length);
    room.impostorId = room.players[impostorIndex].id;

    // Set clue order (shuffle players)
    room.clueOrder = [...room.players].sort(() => Math.random() - 0.5).map(p => p.id);
    room.currentClueIndex = 0;
    room.clues = [];
    room.votes = {};
    room.phase = 'reveal';

    // Emit private word to each player
    room.players.forEach(player => {
      const assignedWord = player.id === room.impostorId ? pair.impostor : pair.civilian;
      const role = player.id === room.impostorId ? 'impostor' : 'civilian';
      io.to(player.id).emit('game-started', {
        word: assignedWord,
        role,
        category: pair.category,
        players: room.players,
        clueOrder: room.clueOrder,
        phase: 'reveal',
      });
    });

    console.log(`[Game] Room ${code} started | Pair: ${pair.civilian}/${pair.impostor} | Impostor: ${room.players[impostorIndex].name}`);
  });

  // PLAYER READY (done revealing word)
  socket.on('player-ready', () => {
    const code = socket.data.roomCode;
    const room = getRoomSafe(code);
    if (!room || room.phase !== 'reveal') return;

    if (!room.readyPlayers) room.readyPlayers = new Set();
    room.readyPlayers.add(socket.id);

    io.to(code).emit('ready-update', { readyCount: room.readyPlayers.size, total: room.players.length });

    if (room.readyPlayers.size >= room.players.length) {
      room.phase = 'clues';
      room.readyPlayers = null;
      const currentPlayerId = room.clueOrder[room.currentClueIndex];
      io.to(code).emit('clue-phase-start', {
        clueOrder: room.clueOrder,
        currentPlayerId,
        players: room.players,
      });
    }
  });

  // SUBMIT CLUE
  socket.on('submit-clue', ({ clue }) => {
    const code = socket.data.roomCode;
    const room = getRoomSafe(code);
    if (!room || room.phase !== 'clues') return;

    const currentPlayerId = room.clueOrder[room.currentClueIndex];
    if (socket.id !== currentPlayerId) return socket.emit('error', { message: "It's not your turn!" });
    if (!clue || clue.trim().length === 0) return socket.emit('error', { message: 'Clue cannot be empty.' });
    if (clue.trim().length > 100) return socket.emit('error', { message: 'Clue too long (max 100 chars).' });

    const player = room.players.find(p => p.id === socket.id);
    room.clues.push({ playerId: socket.id, playerName: player.name, clue: clue.trim() });
    room.currentClueIndex++;

    io.to(code).emit('clue-submitted', {
      clues: room.clues,
      nextPlayerId: room.clueOrder[room.currentClueIndex] || null,
      currentClueIndex: room.currentClueIndex,
    });

    // All clues submitted → voting
    if (room.currentClueIndex >= room.clueOrder.length) {
      room.phase = 'voting';
      io.to(code).emit('voting-phase-start', {
        players: room.players,
        clues: room.clues,
      });
    }
  });

  // SUBMIT VOTE
  socket.on('submit-vote', ({ votedForId }) => {
    const code = socket.data.roomCode;
    const room = getRoomSafe(code);
    if (!room || room.phase !== 'voting') return;

    const validPlayer = room.players.find(p => p.id === votedForId);
    if (!validPlayer) return socket.emit('error', { message: 'Invalid vote.' });
    if (room.votes[socket.id]) return socket.emit('error', { message: 'You already voted.' });
    if (votedForId === socket.id) return socket.emit('error', { message: "You can't vote for yourself." });

    room.votes[socket.id] = votedForId;
    const voteCount = Object.keys(room.votes).length;
    io.to(code).emit('vote-update', { voteCount, total: room.players.length });

    if (voteCount >= room.players.length) {
      // Tally votes
      const tally = {};
      room.players.forEach(p => tally[p.id] = 0);
      Object.values(room.votes).forEach(id => { if (tally[id] !== undefined) tally[id]++; });

      // Find most voted
      let maxVotes = 0;
      let eliminatedId = null;
      for (const [id, count] of Object.entries(tally)) {
        if (count > maxVotes) { maxVotes = count; eliminatedId = id; }
      }

      const eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
      const impostorFound = eliminatedId === room.impostorId;
      const impostorPlayer = room.players.find(p => p.id === room.impostorId);

      room.phase = 'results';
      io.to(code).emit('game-results', {
        tally,
        eliminatedId,
        eliminatedName: eliminatedPlayer?.name,
        impostorId: room.impostorId,
        impostorName: impostorPlayer?.name,
        impostorFound,
        civilianWord: room.wordPair.civilian,
        impostorWord: room.wordPair.impostor,
        category: room.wordPair.category,
        clues: room.clues,
        players: room.players,
        votes: room.votes,
      });

      console.log(`[Game] Room ${code} results | Impostor: ${impostorPlayer?.name} | Found: ${impostorFound}`);
    }
  });

  // PLAY AGAIN (host only)
  socket.on('play-again', () => {
    const code = socket.data.roomCode;
    const room = getRoomSafe(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.wordPair = null;
    room.impostorId = null;
    room.clues = [];
    room.votes = {};
    room.clueOrder = [];
    room.currentClueIndex = 0;
    room.readyPlayers = null;

    broadcastLobby(code);
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    removePlayer(socket.id);
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7429;
server.listen(PORT, () => {
  console.log(`\n🎮 QuessWho server running at http://localhost:${PORT}\n`);
});
