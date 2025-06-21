const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

function cleanCard(card) {
  if (!card) return card;
  const { image, ...rest } = card;
  return rest;
}

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const rooms = {}; // roomCode -> { hostId, players, lastGameState }

io.on("connection", (socket) => {
  socket.on("create-room", ({ nickname }) => {
    const generateCode = () => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ123456789";
      let code = "";
      for (let i = 0; i < 3; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      return code;
    };

    let code;
    do {
      code = generateCode();
    } while (rooms[code]);

    rooms[code] = {
      hostId: socket.id,
      players: {
        [socket.id]: {
          nickname,
          ready: false,
          deck: null,
          deckName: null,
          hasMulliganned: false,
        },
      },
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.nickname = nickname;

    emitRoomPlayers(code);
    io.to(code).emit("room-ready", { code });
  });
  socket.on("join-room", ({ nickname, code }) => {
    const room = rooms[code];
    if (!room || Object.keys(room.players).length >= 2) {
      socket.emit("join-error", "Room full or does not exist");
      return;
    }

    room.players[socket.id] = {
      nickname,
      ready: false,
      deck: null,
      deckName: null,
      hasMulliganned: false,
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.nickname = nickname;

    emitRoomPlayers(code);

    if (Object.keys(room.players).length === 2) {
      io.to(code).emit("room-ready");
    }
  });

  socket.on("player-ready", ({ code, nickname, deck, ready, deckName }) => {
    const room = rooms[code];
    if (room && room.players[socket.id]) {
      room.players[socket.id].ready = ready;
      room.players[socket.id].deck = deck;
      room.players[socket.id].deckName = deckName || deck?.name;
      emitRoomPlayers(code);
    }
  });

  socket.on("start-game", ({ code }) => {
    const room = rooms[code];
    if (!room) return;

    const playersArray = Object.entries(room.players);
    const allDecksReady = playersArray.every(
      ([, p]) => p.deck && Array.isArray(p.deck.cards)
    );
    if (!allDecksReady) {
      return;
    }

    const allPlayers = playersArray.map(([socketId, player]) => {
      const shuffled = [...player.deck.cards.map(cleanCard)]
        .sort(() => Math.random() - 0.5)
        .map((card) => ({
          ...card,
          instanceId: `${player.nickname}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
        }));

      player.deck.cards = shuffled;

      return {
        nickname: player.nickname,
        name: player.deck.name,
        cards: shuffled,
      };
    });

    room.lastGameState = {
      allPlayers,
      floatingCards: [],
      roomCode: code,
    };

    syncGameStateToAll(code); // Manda solo le 4 carte iniziali per mulligan (logica nel client)
  });
  socket.on("mulligan", ({ code, playerNickname, cardIds }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;

    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (!player) return;

    const socketId = Object.entries(room.players).find(
      ([, p]) => p.nickname === playerNickname
    )?.[0];
    if (socketId) {
      room.players[socketId].hasMulliganned = true;
    }

    // Rimuove le vecchie carte dalla floating (mano iniziale)
    state.floatingCards = state.floatingCards.filter(
      (c) =>
        !(
          c.owner === playerNickname &&
          (c.card.type === "unit" || c.card.type === "champion") &&
          c.card.metadata !== "main"
        )
    );

    // Mantieni le carte non scartate
    const cardsToKeep = player.cards.filter(
      (c) =>
        (c.type === "unit" || c.type === "champion") &&
        c.metadata !== "main" &&
        !cardIds.includes(c.instanceId)
    );

    // Pesca nuove carte per rimpiazzare quelle scartate
    const usedIds = new Set([
      ...cardsToKeep.map((c) => c.instanceId),
      ...cardIds,
      ...state.floatingCards.map((c) => c.card.instanceId),
    ]);

    const newCards = player.cards
      .filter(
        (c) =>
          (c.type === "unit" || c.type === "champion") &&
          c.metadata !== "main" &&
          !usedIds.has(c.instanceId)
      )
      .sort(() => Math.random() - 0.5)
      .slice(0, cardIds.length);

    const finalHand = [...cardsToKeep, ...newCards];
    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;
    let x = 260;

    finalHand.forEach((c) => {
      const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const updatedCard = { ...c, instanceId: generatedId };

      const index = player.cards.findIndex(
        (card) => card.instanceId === c.instanceId
      );
      if (index !== -1) {
        player.cards[index] = updatedCard;
      }

      state.floatingCards.push({
        id: generatedId,
        card: updatedCard,
        x,
        y: yBase - 50,
        owner: playerNickname,
      });

      x += 100;
    });

    const allDone = Object.values(room.players).every((p) => p.hasMulliganned);
    if (allDone) {
      startGame(code);
    }

    syncGameStateToAll(code);
  });

  function startGame(code) {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;

    const { allPlayers } = room.lastGameState;
    const floatingCards = [];
    const BOARD_HEIGHT = 855;
    const yBaseBasso = BOARD_HEIGHT - 350;
    const yBaseAlto = 350;

    allPlayers.forEach((player, idx) => {
      const nickname = player.nickname;
      const yBase = idx === 0 ? yBaseBasso : yBaseAlto;
      let x = 260;

      const battlefield = player.cards.find((c) => c.type === "battlefield");
      const legend = player.cards.find((c) => c.type === "legend");
      const champion = player.cards.find(
        (c) => c.type === "champion" && c.metadata === "main"
      );
      const initialHand = room.lastGameState.floatingCards.filter(
        (c) =>
          c.owner === nickname &&
          (c.card.type === "unit" || c.card.type === "champion") &&
          c.card.metadata !== "main"
      );

      [battlefield, champion, legend].filter(Boolean).forEach((c) => {
        floatingCards.push({
          id: `${nickname}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
          card: c,
          x,
          y: yBase - 50,
          owner: nickname,
        });
        x += 120;
      });

      initialHand.forEach((c) => {
        floatingCards.push({
          id: c.instanceId,
          card: c,
          x,
          y: yBase - 50,
          owner: nickname,
        });
        x += 100;
      });
    });

    room.lastGameState.floatingCards = floatingCards;
    syncGameStateToAll(code);
  }

  function syncGameStateToAll(code) {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;

    for (const socketId in room.players) {
      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;
      const nickname = room.players[socketId].nickname;

      const personalizedCards = room.lastGameState.floatingCards.map(
        (card) => ({
          ...card,
          owner: card.owner === nickname ? "local" : "opponent",
        })
      );

      s.emit("start-game", {
        ...room.lastGameState,
        floatingCards: personalizedCards,
        deck: {
          nickname: nickname,
          name: room.players[socketId].deck?.name,
          cards: room.players[socketId].deck?.cards || [],
        },
      });
    }
  }
  socket.on("draw-card", ({ code, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;

    const state = room.lastGameState;
    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (!player) return;

    const drawn = player.cards.find(
      (c) =>
        c.type === "unit" &&
        !state.floatingCards.some((f) => f.card.instanceId === c.instanceId)
    );
    if (!drawn) return;

    const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const updatedCard = { ...drawn, instanceId: generatedId };

    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;

    state.floatingCards.push({
      id: generatedId,
      card: updatedCard,
      x: 100,
      y: yBase - 50,
      owner: playerNickname,
    });

    syncGameStateToAll(code);
  });

  socket.on("draw-rune", ({ code, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;

    const state = room.lastGameState;
    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (!player) return;

    const drawn = player.cards.find(
      (c) =>
        c.type === "rune" &&
        !state.floatingCards.some((f) => f.card.instanceId === c.instanceId)
    );
    if (!drawn) return;

    const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const updatedCard = { ...drawn, instanceId: generatedId };

    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;

    state.floatingCards.push({
      id: generatedId,
      card: updatedCard,
      x: 100,
      y: yBase - 50,
      owner: playerNickname,
    });

    syncGameStateToAll(code);
  });

  socket.on("tap-card", ({ code, cardId }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const card = room.lastGameState.floatingCards.find((c) => c.id === cardId);
    if (!card) return;
    card.rotated = !card.rotated;
    syncGameStateToAll(code);
  });

  socket.on("flip-card", ({ code, cardId }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const card = room.lastGameState.floatingCards.find((c) => c.id === cardId);
    if (!card) return;
    card.flipped = !card.flipped;
    syncGameStateToAll(code);
  });

  socket.on("recycle-card", ({ code, cardId, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const idx = state.floatingCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;
    const [cardObj] = state.floatingCards.splice(idx, 1);

    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (player) {
      player.cards.push(cardObj.card);
    }

    syncGameStateToAll(code);
  });

  socket.on("end-game", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit("end-game");
    delete rooms[code];
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const nickname = socket.data.nickname;
    if (!code || !rooms[code]) return;

    delete rooms[code].players[socket.id];
    if (rooms[code].hostId === socket.id) {
      const remaining = Object.keys(rooms[code].players);
      rooms[code].hostId = remaining[0] || null;
    }

    if (Object.keys(rooms[code].players).length === 0) {
      delete rooms[code];
    } else {
      emitRoomPlayers(code);
    }
  });

  function emitRoomPlayers(code) {
    const room = rooms[code];
    if (!room) return;
    const players = Object.entries(room.players).map(([id, p]) => ({
      id,
      nickname: p.nickname,
      ready: p.ready,
      isHost: id === room.hostId,
      deckName: p.deck?.name || null,
    }));
    io.to(code).emit("room-players", players);
    io.to(code).emit("player-update", players);
  }
});
