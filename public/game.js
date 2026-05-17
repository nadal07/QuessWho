// ─── Socket Connection ────────────────────────────────────────────────────
const socket = io();

// ─── Local State ─────────────────────────────────────────────────────────
const state = {
  myId: null,
  myName: '',
  roomCode: '',
  isHost: false,
  players: [],
  myWord: '',
  myRole: '',
  impostorId: null,
  clueOrder: [],
  currentClueIndex: 0,
  clues: [],
  selectedVoteId: null,
  hasVoted: false,
  hasRoundVoted: false,
  wordRevealed: false,
  readySubmitted: false,
  roundNumber: 1,
  impostorRoundsSurvived: 0,
};

// ─── Session Persistence (localStorage) ──────────────────────────────────
const SESSION_KEY = 'quesswho_session';

function saveSession(overrides = {}) {
  const existing = loadSession() || {};
  const session = { ...existing, ...overrides };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// ─── Screen Management ────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(`screen-${id}`);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Toast ────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = type ? `show ${type}` : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}

// ─── Peek Word Modal ──────────────────────────────────────────────────────
function openPeek() {
  const overlay = document.getElementById('peek-overlay');
  document.getElementById('peek-word').textContent = state.myWord || '—';
  const roleEl = document.getElementById('peek-role');
  if (state.myRole === 'impostor') {
    roleEl.textContent = '🕵️ You are the Impostor';
    roleEl.className = 'impostor';
  } else {
    roleEl.textContent = '✅ You are a Civilian';
    roleEl.className = 'civilian';
  }
  overlay.classList.add('open');
}

function closePeek() {
  document.getElementById('peek-overlay').classList.remove('open');
}


// ─── Tab Switch ───────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('tab-host').classList.toggle('active', tab === 'host');
  document.getElementById('tab-join').classList.toggle('active', tab === 'join');
  document.getElementById('panel-host').style.display = tab === 'host' ? '' : 'none';
  document.getElementById('panel-join').style.display = tab === 'join' ? '' : 'none';
}

// ─── Avatar Colors ────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  ['#7c3aed','#ede9fe'], ['#0e7490','#cffafe'], ['#be185d','#fce7f3'],
  ['#b45309','#fef3c7'], ['#047857','#d1fae5'], ['#1d4ed8','#dbeafe'],
  ['#7e22ce','#f3e8ff'], ['#c2410c','#ffedd5'], ['#0f766e','#ccfbf1'],
  ['#6d28d9','#ede9fe'],
];
function avatarStyle(index) {
  const [bg, fg] = AVATAR_COLORS[index % AVATAR_COLORS.length];
  return `background:${bg};color:${fg};`;
}

// ─── Create Room ──────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById('home-name').value.trim();
  if (!name) return showToast('Please enter your name!', 'error');
  state.myName = name;
  socket.emit('create-room', { name });
}

// ─── Join Room ────────────────────────────────────────────────────────────
function joinRoom() {
  const name = document.getElementById('home-name').value.trim();
  const code = document.getElementById('home-code').value.trim().toUpperCase();
  if (!name) return showToast('Please enter your name!', 'error');
  if (code.length !== 4) return showToast('Enter a 4-letter room code.', 'error');
  state.myName = name;
  socket.emit('join-room', { name, code });
}

// ─── Copy Room Code ───────────────────────────────────────────────────────
function copyRoomCode() {
  const code = state.roomCode;
  if (!code) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => showToast('Code copied! 📋', 'success'));
  } else {
    showToast(code, '');
  }
}

// ─── Render Lobby ─────────────────────────────────────────────────────────
function renderLobby(players, hostId) {
  state.players = players;
  state.isHost = hostId === state.myId;

  document.getElementById('lobby-code').textContent = state.roomCode;

  const list = document.getElementById('lobby-players');
  list.innerHTML = players.map((p, i) => {
    const isMe = p.id === state.myId;
    const isHostP = p.id === hostId;
    return `
      <div class="player-chip">
        <div class="avatar" style="${avatarStyle(i)}">${p.name[0].toUpperCase()}</div>
        <div class="info">
          <p class="p-name">${escHtml(p.name)}</p>
          <p class="p-role">${isHostP ? 'Host' : 'Player'}</p>
        </div>
        ${isHostP ? '<span class="badge badge-host">Host</span>' : ''}
        ${isMe ? '<span class="badge badge-you">You</span>' : ''}
      </div>`;
  }).join('');

  const hint = document.getElementById('lobby-hint');
  hint.textContent = players.length < 3
    ? `Need ${3 - players.length} more player${3 - players.length > 1 ? 's' : ''} to start.`
    : `${players.length} players ready!`;

  const btnStart = document.getElementById('btn-start');
  if (state.isHost) {
    btnStart.style.display = '';
    btnStart.disabled = players.length < 3;
    btnStart.textContent = players.length < 3
      ? `⏳ Need ${3 - players.length} more…`
      : '⚡ Start Game';
  } else {
    btnStart.style.display = 'none';
  }
}

// ─── Start Game ───────────────────────────────────────────────────────────
function startGame() {
  socket.emit('start-game');
}

// ─── Word Reveal ──────────────────────────────────────────────────────────
function toggleReveal() {
  state.wordRevealed = !state.wordRevealed;
  document.getElementById('reveal-hidden').style.display = state.wordRevealed ? 'none' : 'flex';
  document.getElementById('reveal-shown').style.display  = state.wordRevealed ? 'flex' : 'none';
}

function playerReady() {
  if (state.readySubmitted) return;
  state.readySubmitted = true;
  document.getElementById('btn-ready').disabled = true;
  document.getElementById('btn-ready').textContent = '⏳ Waiting for others…';
  socket.emit('player-ready');
}

// ─── Render Clue Screen ───────────────────────────────────────────────────
function renderClueScreen(currentPlayerId, clues, clueOrder, players) {
  state.clues = clues || state.clues;
  state.clueOrder = clueOrder || state.clueOrder;
  state.players = players || state.players;

  const total = state.clueOrder.length;
  const done  = state.clues.length;

  document.getElementById('clue-counter').textContent = `${done} / ${total}`;
  document.getElementById('clue-bar').style.width = `${(done / total) * 100}%`;

  const currentPlayer = state.players.find(p => p.id === currentPlayerId);
  const isMyTurn = currentPlayerId === state.myId;

  const banner = document.getElementById('current-turn-banner');
  const turnText = document.getElementById('turn-text');

  if (isMyTurn) {
    turnText.textContent = "It's your turn! Give a clue.";
    banner.style.background = 'rgba(124,58,237,0.2)';
  } else if (currentPlayer) {
    turnText.textContent = `Waiting for ${currentPlayer.name}…`;
    banner.style.background = 'rgba(255,255,255,0.05)';
  } else {
    turnText.textContent = 'All clues given!';
  }

  document.getElementById('clue-input-card').style.display = isMyTurn ? '' : 'none';
  if (isMyTurn) {
    setTimeout(() => document.getElementById('clue-input').focus(), 100);
  }

  // Render clue list
  const list = document.getElementById('clue-list');
  if (state.clues.length === 0) {
    list.innerHTML = '<p class="small text-dim text-center">No clues yet…</p>';
  } else {
    list.innerHTML = state.clues.map((c) => {
      const pIdx = state.players.findIndex(p => p.id === c.playerId);
      const initial = (c.playerName || '?')[0].toUpperCase();
      return `
        <div class="clue-item">
          <div class="avatar" style="${avatarStyle(pIdx)};width:30px;height:30px;font-size:.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0;">
            ${initial}
          </div>
          <div>
            <p class="ci-name">${escHtml(c.playerName || '?')}</p>
            <p class="ci-text">${escHtml(c.clue || '')}</p>
          </div>
        </div>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  }
}

// ─── Submit Clue ──────────────────────────────────────────────────────────
function submitClue() {
  const input = document.getElementById('clue-input');
  const clue = input.value.trim();
  if (!clue) return showToast('Write your clue first!', 'error');
  input.value = '';
  socket.emit('submit-clue', { clue });
}

// ─── Round Tracker Helper ─────────────────────────────────────────────────
const MAX_ROUNDS = 4;
function renderRoundTracker(el, survived, current) {
  let html = '<div class="round-tracker">';
  for (let i = 0; i < MAX_ROUNDS; i++) {
    if (i < survived) html += '<div class="round-dot survived" title="Impostor survived"></div>';
    else if (i === survived && current) html += '<div class="round-dot current" title="Current round"></div>';
    else html += '<div class="round-dot" title="Future round"></div>';
  }
  html += '</div>';
  html += `<p class="round-label">Round ${survived + 1} of ${MAX_ROUNDS} — ${MAX_ROUNDS - survived} round${MAX_ROUNDS - survived !== 1 ? 's' : ''} left for impostor to win</p>`;
  el.innerHTML = html;
}

// ─── Round Vote Screen ────────────────────────────────────────────────────
function renderRoundVoteScreen(players, clues, roundNumber, impostorRoundsSurvived) {
  state.hasRoundVoted = false;
  document.getElementById('rv-buttons').style.display = 'flex';
  document.getElementById('rv-waiting').style.display = 'none';
  document.getElementById('btn-vote-now').disabled = false;
  document.getElementById('btn-skip-round').disabled = false;

  renderRoundTracker(
    document.getElementById('rv-round-tracker'),
    impostorRoundsSurvived,
    true
  );

  // Clue list
  const cl = document.getElementById('rv-clue-list');
  cl.innerHTML = clues.map((c) => {
    const pIdx = players.findIndex(p => p.id === c.playerId);
    const initial = (c.playerName || '?')[0].toUpperCase();
    return `
      <div class="clue-item">
        <div class="avatar" style="${avatarStyle(pIdx)};width:30px;height:30px;font-size:.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0;">
          ${initial}
        </div>
        <div>
          <p class="ci-name">${escHtml(c.playerName || '?')}</p>
          <p class="ci-text">${escHtml(c.clue || '')}</p>
        </div>
      </div>`;
  }).join('');
}

function submitRoundVote(decision) {
  if (state.hasRoundVoted) return;
  state.hasRoundVoted = true;
  socket.emit('submit-round-vote', { decision });

  document.getElementById('rv-buttons').style.display = 'none';
  document.getElementById('rv-waiting').style.display = '';
  document.getElementById('rv-wait-count').textContent = '1 / ? decided';
}

// ─── Voting Screen ────────────────────────────────────────────────────────
function renderVotingScreen(players, clues) {
  // Clues summary
  const vcl = document.getElementById('voting-clue-list');
  vcl.innerHTML = clues.map((c, i) => {
    const pIdx = players.findIndex(p => p.id === c.playerId);
    return `
      <div class="clue-item">
        <div class="avatar" style="${avatarStyle(pIdx)};width:30px;height:30px;font-size:.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0;">
          ${(c.playerName || '?')[0].toUpperCase()}
        </div>
        <div>
          <p class="ci-name">${escHtml(c.playerName || '?')}</p>
          <p class="ci-text">${escHtml(c.clue || '')}</p>
        </div>
      </div>`;
  }).join('');

  // Vote grid
  const grid = document.getElementById('vote-grid');
  grid.innerHTML = players.map((p, i) => {
    const isSelf = p.id === state.myId;
    return `
      <div class="vote-chip ${isSelf ? 'self' : ''}" id="vc-${p.id}" onclick="selectVote('${p.id}')">
        <div class="avatar" style="${avatarStyle(i)};width:34px;height:34px;font-size:.85rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0;">
          ${p.name[0].toUpperCase()}
        </div>
        <span class="vc-name">${escHtml(p.name)}${isSelf ? ' (you)' : ''}</span>
        <span class="vc-check" id="vc-check-${p.id}"></span>
      </div>`;
  }).join('');
}

function selectVote(playerId) {
  if (state.hasVoted) return;
  if (playerId === state.myId) return;

  state.selectedVoteId = playerId;

  document.querySelectorAll('.vote-chip').forEach(el => {
    el.classList.remove('selected');
    const checkId = el.id.replace('vc-', '');
    const checkEl = document.getElementById(`vc-check-${checkId}`);
    if (checkEl) checkEl.textContent = '';
  });

  const chosen = document.getElementById(`vc-${playerId}`);
  if (chosen) {
    chosen.classList.add('selected');
    const checkEl = document.getElementById(`vc-check-${playerId}`);
    checkEl.textContent = '✓';
  }

  document.getElementById('btn-vote').disabled = false;
}

function submitVote() {
  if (!state.selectedVoteId || state.hasVoted) return;
  state.hasVoted = true;
  socket.emit('submit-vote', { votedForId: state.selectedVoteId });

  document.getElementById('btn-vote').style.display = 'none';
  document.getElementById('voting-wait').style.display = '';

  // Lock vote chips
  document.querySelectorAll('.vote-chip').forEach(el => {
    el.style.cursor = 'default';
    el.style.opacity = el.classList.contains('selected') ? '1' : '0.4';
  });
}

// ─── Results Screen ───────────────────────────────────────────────────────
function renderResults(data) {
  const { tally, eliminatedId, eliminatedName, impostorId, impostorName,
          impostorFound, impostorWins, civilianWord, impostorWord,
          clues, players, votes, roundsSurvived, skipped } = data;

  const icon  = document.getElementById('result-icon');
  const title = document.getElementById('result-title');
  const sub   = document.getElementById('result-subtitle');

  if (impostorFound) {
    icon.textContent  = '🎉';
    title.textContent = 'Civilians Win!';
    title.style.color = 'var(--green)';
    sub.textContent   = `You caught ${impostorName}!`;
  } else if (impostorWins || (roundsSurvived >= MAX_ROUNDS)) {
    icon.textContent  = '🕵️';
    title.textContent = 'Impostor Wins!';
    title.style.color = 'var(--red)';
    sub.textContent   = `${impostorName} survived all ${MAX_ROUNDS} rounds!`;
  } else {
    // Wrong player eliminated — next round coming automatically
    icon.textContent  = '😬';
    title.textContent = 'Wrong Player!';
    title.style.color = 'var(--amber, #d4a84c)';
    sub.textContent   = `${impostorName || 'The impostor'} is still out there. Next round starting…`;
  }

  // Words
  document.getElementById('res-civilian-word').textContent = civilianWord;
  document.getElementById('res-impostor-word').textContent = impostorWord;
  document.getElementById('res-impostor-name').textContent = `🕵️ ${impostorName} was the impostor`;

  // Tally (may be empty if skipped)
  const tallyEl = document.getElementById('vote-tally');
  const sortedPlayers = [...players].sort((a, b) => (tally[b.id] || 0) - (tally[a.id] || 0));
  if (Object.keys(tally).length === 0) {
    tallyEl.innerHTML = '<p class="small text-dim text-center">No vote was held this round.</p>';
  } else {
    tallyEl.innerHTML = sortedPlayers.map((p) => {
      const voteCount = tally[p.id] || 0;
      const isImpostor = p.id === impostorId;
      const wasEliminated = p.id === eliminatedId;
      return `
        <div class="tally-row ${isImpostor ? 'was-impostor' : ''}">
          <div class="avatar" style="${avatarStyle(players.findIndex(x => x.id === p.id))};width:30px;height:30px;font-size:.75rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0;">
            ${p.name[0].toUpperCase()}
          </div>
          <span class="tr-name">${escHtml(p.name)}${isImpostor ? ' 🕵️' : ''}</span>
          <span class="tr-votes">${voteCount} vote${voteCount !== 1 ? 's' : ''}</span>
          ${wasEliminated ? '<span class="tr-icon">⬅️</span>' : ''}
        </div>`;
    }).join('');
  }

  // Host actions: only show Play Again if game is truly over
  const gameOver = impostorFound || impostorWins || (roundsSurvived >= MAX_ROUNDS);
  document.getElementById('result-host-actions').style.display = (state.isHost && gameOver) ? '' : 'none';
}

// ─── Play Again ───────────────────────────────────────────────────────────
function playAgain() {
  socket.emit('play-again');
}

// ─── Leave Game ───────────────────────────────────────────────────────────
function leaveGame() {
  clearSession();
  socket.disconnect();
  location.reload();
}

// ─── Utility ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePeek(); return; }
  if (e.key === 'Enter') {
    const activeScreen = document.querySelector('.screen.active');
    if (!activeScreen) return;
    const id = activeScreen.id;
    if (id === 'screen-home') {
      const tab = document.getElementById('tab-host').classList.contains('active') ? 'host' : 'join';
      if (tab === 'host') createRoom();
      else joinRoom();
    } else if (id === 'screen-clues') {
      if (document.getElementById('clue-input-card').style.display !== 'none') submitClue();
    }
  }
});

// ─── Socket Events ────────────────────────────────────────────────────────
socket.on('connect', () => {
  state.myId = socket.id;

  const session = loadSession();
  if (session && session.name && session.roomCode) {
    socket.emit('rejoin-room', { name: session.name, roomCode: session.roomCode });
  }
});

socket.on('rejoin-success', (data) => {
  const { code, phase, players, hostId, myWord, myRole,
          clues, clueOrder, currentPlayerId, currentClueIndex,
          hasVoted, hasRoundVoted, roundNumber, impostorRoundsSurvived, wordPair } = data;

  state.myId        = socket.id;
  state.myName      = loadSession()?.name || '';
  state.roomCode    = code;
  state.isHost      = hostId === socket.id;
  state.players     = players;
  state.myWord      = myWord || '';
  state.myRole      = myRole || '';
  state.clues       = clues || [];
  state.clueOrder   = clueOrder || [];
  state.currentClueIndex = currentClueIndex || 0;
  state.hasVoted    = hasVoted;
  state.hasRoundVoted = hasRoundVoted;
  state.roundNumber = roundNumber || 1;
  state.impostorRoundsSurvived = impostorRoundsSurvived || 0;

  showToast('Reconnected ✅', 'success');

  switch (phase) {
    case 'lobby':
      renderLobby(players, hostId);
      showScreen('lobby');
      break;

    case 'reveal': {
      document.getElementById('reveal-hidden').style.display = 'flex';
      document.getElementById('reveal-shown').style.display = 'none';
      document.getElementById('reveal-word').textContent = myWord;
      const badge = document.getElementById('reveal-role-badge');
      badge.textContent = myRole === 'impostor' ? '🕵️ You are the Impostor' : '✅ You are a Civilian';
      badge.className = `role-badge ${myRole}`;
      const btnReady = document.getElementById('btn-ready');
      btnReady.disabled = false;
      btnReady.textContent = "✅ I've Seen My Word";
      document.getElementById('ready-count').textContent = `0 / ${players.length}`;
      document.getElementById('ready-bar').style.width = '0%';
      showScreen('reveal');
      break;
    }

    case 'clues':
      showScreen('clues');
      renderClueScreen(currentPlayerId, clues, clueOrder, players);
      break;

    case 'round-vote':
      showScreen('round-vote');
      renderRoundVoteScreen(players, clues, roundNumber, impostorRoundsSurvived);
      if (hasRoundVoted) {
        document.getElementById('rv-buttons').style.display = 'none';
        document.getElementById('rv-waiting').style.display = '';
      }
      break;

    case 'voting':
      showScreen('voting');
      renderVotingScreen(players, clues);
      if (hasVoted) {
        document.getElementById('btn-vote').style.display = 'none';
        document.getElementById('voting-wait').style.display = '';
      }
      break;

    case 'results':
      if (wordPair) {
        showScreen('results');
        renderResults({
          tally: {}, eliminatedId: null, eliminatedName: null,
          impostorId: null, impostorName: '?',
          impostorFound: false, impostorWins: false,
          civilianWord: wordPair.civilian, impostorWord: wordPair.impostor,
          clues, players, votes: {}, roundsSurvived: impostorRoundsSurvived, skipped: false,
        });
      } else {
        showScreen('lobby');
      }
      break;

    default:
      showScreen('home');
  }
});

socket.on('rejoin-failed', ({ message }) => {
  clearSession();
  showToast(message, 'error');
  showScreen('home');
});

socket.on('room-created', ({ code }) => {
  state.roomCode = code;
  state.isHost = true;
  saveSession({ name: state.myName, roomCode: code });
  showScreen('lobby');
});

socket.on('join-success', ({ code }) => {
  state.roomCode = code;
  saveSession({ name: state.myName, roomCode: code });
  showScreen('lobby');
});

socket.on('join-error', ({ message }) => {
  showToast(message, 'error');
});

socket.on('lobby-update', ({ players, hostId, code }) => {
  state.roomCode = code;
  state.myId = socket.id;
  renderLobby(players, hostId);
  // If we were in results or elsewhere, return to lobby
  const active = document.querySelector('.screen.active');
  if (active && active.id === 'screen-results') showScreen('lobby');
});

socket.on('game-started', ({ word, role, category, players, clueOrder, roundNumber, impostorRoundsSurvived }) => {
  state.myWord = word;
  state.myRole = role;
  state.players = players;
  state.clueOrder = clueOrder;
  state.clues = [];
  state.selectedVoteId = null;
  state.hasVoted = false;
  state.hasRoundVoted = false;
  state.wordRevealed = false;
  state.readySubmitted = false;
  state.roundNumber = roundNumber || 1;
  state.impostorRoundsSurvived = impostorRoundsSurvived || 0;

  // Reset reveal UI
  document.getElementById('reveal-hidden').style.display = 'flex';
  document.getElementById('reveal-shown').style.display = 'none';
  document.getElementById('reveal-word').textContent = word;

  const badge = document.getElementById('reveal-role-badge');
  badge.textContent = role === 'impostor' ? '🕵️ You are the Impostor' : '✅ You are a Civilian';
  badge.className = `role-badge ${role}`;

  const btnReady = document.getElementById('btn-ready');
  btnReady.disabled = false;
  btnReady.textContent = "✅ I've Seen My Word";

  document.getElementById('ready-count').textContent = `0 / ${players.length}`;
  document.getElementById('ready-bar').style.width = '0%';

  showScreen('reveal');
});

socket.on('ready-update', ({ readyCount, total }) => {
  document.getElementById('ready-count').textContent = `${readyCount} / ${total}`;
  document.getElementById('ready-bar').style.width = `${(readyCount / total) * 100}%`;
});

socket.on('clue-phase-start', ({ clueOrder, currentPlayerId, players }) => {
  state.clueOrder = clueOrder;
  state.players = players;
  state.clues = [];
  state.currentClueIndex = 0;
  showScreen('clues');
  renderClueScreen(currentPlayerId, [], clueOrder, players);
});

socket.on('clue-submitted', ({ clues, nextPlayerId, currentClueIndex }) => {
  state.clues = clues;
  state.currentClueIndex = currentClueIndex;
  renderClueScreen(nextPlayerId, clues, state.clueOrder, state.players);
});

socket.on('round-vote-phase-start', ({ players, clues, roundNumber, impostorRoundsSurvived }) => {
  state.players = players;
  state.clues = clues;
  state.roundNumber = roundNumber;
  state.impostorRoundsSurvived = impostorRoundsSurvived;
  showScreen('round-vote');
  renderRoundVoteScreen(players, clues, roundNumber, impostorRoundsSurvived);
});

socket.on('round-vote-update', ({ decided, total }) => {
  document.getElementById('rv-wait-count').textContent = `${decided} / ${total} decided`;
});

socket.on('round-skipped', ({ roundNumber, impostorRoundsSurvived, roundsRemaining }) => {
  showToast(`Round skipped! ${roundsRemaining} round${roundsRemaining !== 1 ? 's' : ''} left for impostor to win.`, '');
});

socket.on('next-round-clues', ({ players, clueOrder, currentPlayerId, roundNumber, impostorRoundsSurvived }) => {
  state.players = players;
  state.clueOrder = clueOrder;
  state.clues = [];
  state.currentClueIndex = 0;
  state.hasVoted = false;
  state.hasRoundVoted = false;
  state.selectedVoteId = null;
  state.roundNumber = roundNumber;
  state.impostorRoundsSurvived = impostorRoundsSurvived;

  showToast(`Round ${roundNumber} — same word, fresh clues!`, '');
  showScreen('clues');
  renderClueScreen(currentPlayerId, [], clueOrder, players);
});

socket.on('voting-phase-start', ({ players, clues }) => {
  state.players = players;
  state.clues = clues;
  state.hasVoted = false;
  state.selectedVoteId = null;

  document.getElementById('btn-vote').disabled = true;
  document.getElementById('btn-vote').style.display = '';
  document.getElementById('voting-wait').style.display = 'none';

  showScreen('voting');
  renderVotingScreen(players, clues);
});

socket.on('vote-update', ({ voteCount, total }) => {
  document.getElementById('vote-wait-count').textContent = `${voteCount} / ${total} votes in`;
});

socket.on('game-results', (data) => {
  state.impostorId = data.impostorId;
  showScreen('results');
  renderResults(data);
});

socket.on('player-left', ({ players, hostId }) => {
  state.players = players;
  state.isHost = hostId === state.myId;
});

socket.on('player-reconnected', ({ players, hostId }) => {
  state.players = players;
  state.isHost = hostId === state.myId;
  // Update lobby if currently in lobby
  const active = document.querySelector('.screen.active');
  if (active && active.id === 'screen-lobby') renderLobby(players, hostId);
});

socket.on('game-aborted', ({ reason }) => {
  showToast(reason, 'error');
  showScreen('lobby');
});

socket.on('error', ({ message }) => {
  showToast(message, 'error');
});

socket.on('disconnect', () => {
  showToast('Disconnected from server.', 'error');
});

// ─── Code input: force uppercase ─────────────────────────────────────────
document.getElementById('home-code').addEventListener('input', function () {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
