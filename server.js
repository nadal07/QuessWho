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
//   phase: 'lobby' | 'reveal' | 'clues' | 'round-vote' | 'voting' | 'results',
//   wordPair: { civilian, impostor, category },
//   impostorId: socketId,
//   clues: [{ playerId, playerName, clue }],
//   votes: { [voterId]: votedForId },
//   roundVotes: { [playerId]: 'vote' | 'skip' },
//   clueOrder: [socketId, ...],
//   currentClueIndex: number,
//   roundNumber: number,          // current round (1-based)
//   impostorRoundsSurvived: number, // rounds impostor survived without being caught
// }
const rooms = {};

const MAX_ROUNDS = 4;
const REJOIN_GRACE_MS = 15000; // 15 s to reconnect after a page refresh
const disconnectTimers = {};   // key: `${roomCode}:${playerName}`

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

// Continue same game to next round — SAME word, SAME impostor, just reset clues
function continueToNextRound(code) {
  const room = getRoomSafe(code);
  if (!room) return;

  room.clues = [];
  room.votes = {};
  room.roundVotes = {};
  room.clueOrder = [...room.players].sort(() => Math.random() - 0.5).map(p => p.id);
  room.currentClueIndex = 0;
  room.phase = 'clues';

  const currentPlayerId = room.clueOrder[0];
  io.to(code).emit('next-round-clues', {
    players: room.players,
    clueOrder: room.clueOrder,
    currentPlayerId,
    roundNumber: room.roundNumber,
    impostorRoundsSurvived: room.impostorRoundsSurvived,
  });

  console.log(`[Game] Room ${code} | Next round ${room.roundNumber} (same word)`);
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
      roundVotes: {},
      clueOrder: [],
      currentClueIndex: 0,
      roundNumber: 1,
      impostorRoundsSurvived: 0,
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name.trim();
    socket.emit('room-created', { code });
    broadcastLobby(code);
  });

  // REJOIN ROOM (after page refresh)
  socket.on('rejoin-room', ({ name, roomCode }) => {
    // Cancel any pending disconnect timer for this player
    const timerKey = `${roomCode}:${(name || '').trim().toLowerCase()}`;
    if (disconnectTimers[timerKey]) {
      clearTimeout(disconnectTimers[timerKey]);
      delete disconnectTimers[timerKey];
    }
    const room = getRoomSafe(roomCode);
    if (!room) return socket.emit('rejoin-failed', { message: 'Room no longer exists.' });

    const player = room.players.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
    if (!player) return socket.emit('rejoin-failed', { message: 'You are not in this room.' });

    const oldId = player.id;
    const newId = socket.id;

    // Swap the socket ID everywhere in room state
    player.id = newId;
    if (room.hostId === oldId)      room.hostId = newId;
    if (room.impostorId === oldId)  room.impostorId = newId;

    // Update clue order
    room.clueOrder = room.clueOrder.map(id => id === oldId ? newId : id);

    // Update playerId in submitted clues (so avatar lookup works after rejoin)
    room.clues.forEach(c => { if (c.playerId === oldId) c.playerId = newId; });

    // Migrate votes & roundVotes keyed by old socket ID
    if (room.votes[oldId] !== undefined)      { room.votes[newId] = room.votes[oldId];      delete room.votes[oldId]; }
    if (room.roundVotes[oldId] !== undefined) { room.roundVotes[newId] = room.roundVotes[oldId]; delete room.roundVotes[oldId]; }

    // Migrate readyPlayers Set (if active during reveal phase)
    if (room.readyPlayers && room.readyPlayers.has(oldId)) {
      room.readyPlayers.delete(oldId);
      room.readyPlayers.add(newId);
    }

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = name.trim();

    // Build private word/role for this player
    let myWord = null, myRole = null;
    if (room.wordPair) {
      myRole = newId === room.impostorId ? 'impostor' : 'civilian';
      myWord = myRole === 'impostor' ? room.wordPair.impostor : room.wordPair.civilian;
    }

    // Current turn player for clue phase
    const currentPlayerId = room.clueOrder[room.currentClueIndex] || null;

    socket.emit('rejoin-success', {
      code: roomCode,
      phase: room.phase,
      players: room.players,
      hostId: room.hostId,
      myWord,
      myRole,
      clues: room.clues,
      clueOrder: room.clueOrder,
      currentPlayerId,
      currentClueIndex: room.currentClueIndex,
      hasVoted: room.votes[newId] !== undefined,
      hasRoundVoted: room.roundVotes[newId] !== undefined,
      roundNumber: room.roundNumber,
      impostorRoundsSurvived: room.impostorRoundsSurvived,
      wordPair: room.wordPair,
    });

    // Notify others in room
    io.to(roomCode).emit('player-reconnected', { players: room.players, hostId: room.hostId });
    console.log(`[Rejoin] ${name} rejoined room ${roomCode} (phase: ${room.phase})`);
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
    room.roundVotes = {};
    room.roundNumber = 1;
    room.impostorRoundsSurvived = 0;
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
        roundNumber: room.roundNumber,
        impostorRoundsSurvived: room.impostorRoundsSurvived,
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

    // All clues submitted → ask everyone if they want to vote
    if (room.currentClueIndex >= room.clueOrder.length) {
      room.phase = 'round-vote';
      room.roundVotes = {};
      io.to(code).emit('round-vote-phase-start', {
        players: room.players,
        clues: room.clues,
        roundNumber: room.roundNumber,
        impostorRoundsSurvived: room.impostorRoundsSurvived,
      });
    }
  });

  // SUBMIT ROUND VOTE (vote now vs skip)
  socket.on('submit-round-vote', ({ decision }) => {
    const code = socket.data.roomCode;
    const room = getRoomSafe(code);
    if (!room || room.phase !== 'round-vote') return;
    if (!['vote', 'skip'].includes(decision)) return;
    if (room.roundVotes[socket.id]) return; // already voted

    room.roundVotes[socket.id] = decision;
    const decided = Object.keys(room.roundVotes).length;
    io.to(code).emit('round-vote-update', { decided, total: room.players.length });

    // Wait until all players have decided
    if (decided < room.players.length) return;

    // Check if any CIVILIAN voted skip
    const anycivilianSkipped = room.players.some(p =>
      p.id !== room.impostorId && room.roundVotes[p.id] === 'skip'
    );

    if (anycivilianSkipped) {
      // Round skipped — impostor survives this round
      room.impostorRoundsSurvived++;
      room.roundNumber++;

      if (room.impostorRoundsSurvived >= MAX_ROUNDS) {
        // Impostor wins by surviving MAX_ROUNDS rounds
        const impostorPlayer = room.players.find(p => p.id === room.impostorId);
        room.phase = 'results';
        io.to(code).emit('game-results', {
          tally: {},
          eliminatedId: null,
          eliminatedName: null,
          impostorId: room.impostorId,
          impostorName: impostorPlayer?.name,
          impostorFound: false,
          civilianWord: room.wordPair.civilian,
          impostorWord: room.wordPair.impostor,
          category: room.wordPair.category,
          clues: room.clues,
          players: room.players,
          votes: {},
          roundsSurvived: room.impostorRoundsSurvived,
          skipped: true,
        });
        console.log(`[Game] Room ${code} | Impostor won after ${MAX_ROUNDS} rounds!`);
      } else {
        // Continue to next round with SAME word
        io.to(code).emit('round-skipped', {
          roundNumber: room.roundNumber,
          impostorRoundsSurvived: room.impostorRoundsSurvived,
          roundsRemaining: MAX_ROUNDS - room.impostorRoundsSurvived,
        });
        setTimeout(() => continueToNextRound(code), 3000);
      }
    } else {
      // All civilians want to vote — proceed to elimination
      room.phase = 'voting';
      room.votes = {};
      io.to(code).emit('voting-phase-start', {
        players: room.players,
        clues: room.clues,
        roundNumber: room.roundNumber,
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

      if (!impostorFound) {
        // Wrong person eliminated — impostor survives this vote
        room.impostorRoundsSurvived++;
        room.roundNumber++;
      }

      const impostorWins = !impostorFound && room.impostorRoundsSurvived >= MAX_ROUNDS;

      room.phase = 'results';
      io.to(code).emit('game-results', {
        tally,
        eliminatedId,
        eliminatedName: eliminatedPlayer?.name,
        impostorId: room.impostorId,
        impostorName: impostorPlayer?.name,
        impostorFound,
        impostorWins,
        civilianWord: room.wordPair.civilian,
        impostorWord: room.wordPair.impostor,
        category: room.wordPair.category,
        clues: room.clues,
        players: room.players,
        votes: room.votes,
        roundsSurvived: room.impostorRoundsSurvived,
        skipped: false,
      });

      // If wrong person eliminated: impostor still in play but NOT max rounds yet
      // Game stays on results — host must start a new game via play-again → lobby
      if (!impostorFound && !impostorWins) {
        // Automatically continue to next clue round after delay
        setTimeout(() => continueToNextRound(code), 6000);
      }

      console.log(`[Game] Room ${code} results | Impostor: ${impostorPlayer?.name} | Found: ${impostorFound} | Survived: ${room.impostorRoundsSurvived}`);
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
    room.roundVotes = {};
    room.clueOrder = [];
    room.currentClueIndex = 0;
    room.readyPlayers = null;
    room.roundNumber = 1;
    room.impostorRoundsSurvived = 0;

    broadcastLobby(code);
  });

  // DISCONNECT — give players a grace period to reconnect (page refresh)
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const name = (socket.data.name || '').trim().toLowerCase();
    console.log(`[-] Disconnected: ${socket.id} (${socket.data.name || 'unknown'})`);

    if (code && name) {
      const timerKey = `${code}:${name}`;
      // Cancel any existing timer for this player (safety)
      if (disconnectTimers[timerKey]) clearTimeout(disconnectTimers[timerKey]);

      disconnectTimers[timerKey] = setTimeout(() => {
        delete disconnectTimers[timerKey];
        removePlayer(socket.id);
      }, REJOIN_GRACE_MS);
    } else {
      removePlayer(socket.id);
    }
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7429;
server.listen(PORT, () => {
  console.log(`\n🎮 QuessWho server running at http://localhost:${PORT}\n`);
});
