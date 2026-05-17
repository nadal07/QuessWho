# 🕵️ QuessWho

**A real-time multiplayer social deduction game — find the word impostor!**

Most players share a secret word. One player (the impostor) gets a different but related word. Give clues, discuss, vote — and find the bluffer before they fool everyone.

---

## 🎮 How to Play

1. **Host** creates a room and shares the 4-letter code
2. **Friends** join from their own phones using the code
3. Each player secretly taps to reveal their word
4. Players take turns giving **one short clue** about their word — without saying it!
5. Everyone **votes** on who they think is the impostor
6. **Civilians win** if they catch the impostor — **Impostor wins** if they survive!

> Supports **3–10 players** | Best with 5–8

---

## ✨ Features

- 🔴 **Real-time multiplayer** via Socket.io — no account needed
- 📱 **Mobile-first design** — play on any phone browser
- 🔒 **Tap-to-reveal** word card — prevents shoulder surfing
- 🏆 **Turn-based clue round** — every player gets a turn
- 🗳️ **Live voting** with instant result reveal
- 🔄 **Play again** without leaving the room
- 🌐 **100+ word pairs** across 10 categories (Food, Animals, Sports, Places…)
- 🐳 **Docker-ready** for self-hosting

---

## 🚀 Quick Start

### Local (Node.js)

```bash
# Clone the repo
git clone https://github.com/nadal07/QuessWho.git
cd QuessWho

# Install dependencies
npm install

# Start the server
npm start
```

Open **http://localhost:7429** in your browser.

### Docker

```bash
# Using Docker Compose (recommended)
docker compose up -d
```

Or manually:

```bash
docker build -t quesswho .
docker run -p 7429:7429 quesswho
```

Open **http://localhost:7429**

---

## 📁 Project Structure

```
QuessWho/
├── server.js           # Node.js + Express + Socket.io backend
├── words.json          # 100+ civilian/impostor word pairs
├── package.json
├── Dockerfile
├── docker-compose.yml
└── public/
    ├── index.html      # Single-page app (6 screens)
    ├── style.css       # Obsidian Noir theme (dark gold)
    └── game.js         # Client-side game logic & socket events
```

---

## 🌐 Self-Hosting

The server runs on port **7429** by default. You can override it with the `PORT` environment variable:

```bash
PORT=8080 node server.js
```

To make it accessible to others on your network, share your local IP address (e.g. `http://192.168.1.x:7429`).

For public hosting, deploy to any Node.js-compatible platform:

| Platform | Command |
|---|---|
| [Railway](https://railway.app) | Connect GitHub repo → auto-deploys |
| [Render](https://render.com) | New Web Service → Dockerfile |
| [Fly.io](https://fly.io) | `fly launch` |

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Real-time | Socket.io |
| Frontend | Vanilla HTML / CSS / JS |
| Fonts | Playfair Display + Inter (Google Fonts) |
| Container | Docker + Docker Compose |

---

## 📜 License

MIT — free to use, modify, and self-host.
