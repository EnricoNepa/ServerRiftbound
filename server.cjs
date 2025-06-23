const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
// Utility per rimuovere la property image da ogni carta
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

const rooms = {}; // { [roomCode]: { hostId, players: { [socketId]: { nickname, ready, deck } } } }

io.on("connection", (socket) => {
  socket.on("move-card", ({ code, cardInstance }) => {
    console.log(
      "📥 move-card ricevuto da:",
      socket.data.nickname,
      cardInstance
    );
    const room = rooms[code];
    if (!room || !room.lastGameState) return;

    // Aggiorna la carta nel gameState centrale (owner deve restare il nickname!)
    const cards = room.lastGameState.floatingCards;
    const idx = cards.findIndex((c) => c.id === cardInstance.id);
    if (idx !== -1) {
      // Assicurati che owner resti il vero nickname, NON "local"
      cards[idx] = { ...cards[idx], ...cardInstance, owner: cards[idx].owner };
    }
    console.log(
      `Carta ${cardInstance.id} mossa a x:${cardInstance.x} y:${cardInstance.y} (owner: ${cardInstance.owner})`
    );
    // Aggiorna lo stato centrale
    room.lastGameState.floatingCards = cards;

    // Manda a tutti il nuovo gameState (full sync)
    for (const socketId in room.players) {
      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;
      const thisNickname = room.players[socketId].nickname;

      // Mappa "local"/"opponent" SOLO PER QUESTO CLIENT, senza toccare lo stato centrale
      const personalizedCards = cards.map((card) => ({
        ...card,
        owner: card.owner === thisNickname ? "local" : "opponent",
      }));

      s.emit("start-game", {
        ...room.lastGameState,
        floatingCards: personalizedCards,
        deck: {
          ...room.lastGameState.deck,
          nickname: thisNickname,
        },
      });
    }
  });

  socket.on("create-room", ({ nickname }) => {
    // Genera un codice univoco random (3 lettere/numeri)
    const generateCode = (length = 3) => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ123456789";
      let result = "";
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    let code;
    // Evita collisioni
    do {
      code = generateCode();
    } while (rooms[code]);

    rooms[code] = {
      hostId: socket.id,
      players: {
        [socket.id]: { nickname, ready: false, deck: null, deckName: null },
      },
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.nickname = nickname;
    console.log(`${nickname} created room ${code}`);

    emitRoomPlayers(code);

    // Manda il codice stanza nel payload!
    io.to(code).emit("room-ready", { code });
  });

  socket.on("join-room", ({ nickname, code }) => {
    const room = rooms[code];
    console.log(`${nickname} attempts to join room ${code}`);
    if (!room || Object.keys(room.players).length >= 2) {
      console.log(`Join failed for ${nickname}: room full or missing`);
      socket.emit("join-error", "Room full or does not exist");
      return;
    }

    room.players[socket.id] = {
      nickname,
      ready: false,
      deck: null,
      deckName: null,
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.nickname = nickname;

    console.log(`${nickname} joined room ${code}`);

    emitRoomPlayers(code);

    if (Object.keys(room.players).length === 2) {
      io.to(code).emit("room-ready");
    }
  });

  socket.on("get-players", ({ code }) => {
    emitRoomPlayers(code);
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

  socket.on("leave-room", ({ code, nickname }) => {
    const room = rooms[code];
    if (!room) return;

    delete room.players[socket.id];
    socket.leave(code);
    console.log(`${nickname} left room ${code}`);

    if (room.hostId === socket.id) {
      const remaining = Object.keys(room.players);
      room.hostId = remaining[0] || null;
    }

    if (Object.keys(room.players).length === 0) {
      delete rooms[code];
    } else {
      emitRoomPlayers(code);
    }
  });

  socket.on("start-game", ({ code }) => {
    console.log("🎯 Handler start-game attivato per stanza", code);
    const room = rooms[code];
    if (!room) return;

    // ❗ Verifica che entrambi abbiano un deck completo
    const playersArray = Object.entries(room.players);
    const allDecksReady = playersArray.every(
      ([_, p]) => p.deck && Array.isArray(p.deck.cards)
    );

    if (!allDecksReady) {
      console.warn("⛔️ Start-game bloccato: uno o più deck mancanti.");
      return;
    }

    // Prepara setup sincronizzato per ogni giocatore
    const floatingCards = [];
    const cardsByPlayer = {};

    const BOARD_HEIGHT = 855;
    const yBaseBasso = BOARD_HEIGHT - 350; // parte bassa (es. 2485)
    const yBaseAlto = 350; // parte alta

    playersArray.forEach(([socketId, player], idx) => {
      console.log("Numero di giocatori ready:", playersArray.length);
      console.log(`🧩 Deck ricevuto da ${player.nickname}:`, player.deck);
      const nickname = player.nickname;
      const deck = player.deck;
      console.log(`📦 Deck originale di ${nickname}:`, deck.cards);

      const shuffled = [...deck.cards.map(cleanCard)]
        .sort(() => Math.random() - 0.5)
        .map((card) => {
          const instanceId = `${nickname}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`;
          return { ...card, instanceId };
        });

      console.log(`🆔 Deck rinominato e mixato di ${nickname}:`, shuffled);

      cardsByPlayer[nickname] = shuffled;
      player.deck.cards = shuffled;
      console.log(`🔍 [${nickname}] Deck completo con instanceId:`);
      shuffled.forEach((c) => console.log(`${c.name} → ${c.instanceId}`));

      console.log(
        `🎴 ${nickname} → deck mixato:`,
        shuffled.map((c) => c.id)
      );
      const battlefield = shuffled.find((c) => c.type === "battlefield");
      const legend = shuffled.find((c) => c.type === "legend");
      const champion = shuffled.find(
        (c) => c.type === "champion" && c.metadata === "main"
      );

      const units = shuffled.filter(
        (c) =>
          (c.type === "unit" || c.type === "champion") &&
          !(champion && c.name === champion.name && c.metadata === "main")
      );

      const available = shuffled.filter(
        (c) =>
          (c.type === "unit" || c.type === "champion") && c.metadata !== "main"
      );
      const hand = available.slice(0, 4);

      // idx === 0 => primo player => basso, idx === 1 => secondo player => alto
      const yBase = idx === 0 ? yBaseBasso : yBaseAlto;
      const generatedId = `${nickname}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      let x = 260;
      [battlefield, champion, legend].filter(Boolean).forEach((c) => {
        floatingCards.push({
          id: `${nickname}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
          card: { ...c, instanceId: generatedId },
          x,
          y: yBase - 50,
          owner: nickname,
        });
        x += 120;
      });

      hand.forEach((c) => {
        const instanceId = `${nickname}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        floatingCards.push({
          id: instanceId,
          card: { ...c, instanceId },
          x,
          y: yBase - 50,
          owner: nickname,
        });
        x += 100;
      });
    });
    for (const [socketId, player] of playersArray) {
      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;
      const thisPlayerNickname = player.nickname;
      console.log("📤 Preparazione start-game per:", thisPlayerNickname);
      floatingCards.forEach((card) => {
        console.log(
          "🃏 card.owner:",
          card.owner,
          "→",
          card.owner === thisPlayerNickname ? "local" : "opponent"
        );
      });
      const personalizedFloatingCards = floatingCards.map((card) => {
        // Se la carta è del player corrente
        if (card.owner === thisPlayerNickname) {
          return { ...card, owner: "local" };
        } else {
          return { ...card, owner: "opponent" };
        }
      });

      console.log(
        "floatingCards generato:",
        floatingCards.length,
        floatingCards
      );
      room.lastGameState = {
        floatingCards,
        allPlayers: playersArray.map(([_, p]) => {
          console.log(`🧪 [${p.nickname}] Deck salvato in allPlayers:`);
          p.deck.cards.forEach((c) =>
            console.log(`${c.name} → ${c.instanceId}`)
          );
          return {
            nickname: p.nickname,
            name: p.deck.name,
            cards: p.deck.cards,
          };
        }),
        roomCode: code,
      };

      console.log(
        "🧠 Stato centrale floatingCards:",
        room.lastGameState.floatingCards.map((c) => c.owner)
      );

      // Invia a ogni player la versione personalizzata
      s.emit("start-game", {
        ...room.lastGameState,
        floatingCards: personalizedFloatingCards,
        deck: {
          nickname: player.nickname,
          name: player.deck.name,
          cards: cardsByPlayer[player.nickname],
        },
      });

      console.log("Emit start-game TO", player.nickname);
    }
  });

  socket.on("mulligan", ({ code, playerNickname, cardIds }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (!player) return;

    // 1. Trova tutte le carte in mano PRIMA del mulligan
    const handBefore = state.floatingCards.filter(
      (c) =>
        c.owner === playerNickname &&
        (c.card.type === "unit" || c.card.type === "champion") &&
        c.card.metadata !== "main"
    );

    // 2. Rimuovi TUTTE le carte della mano corrente
    state.floatingCards = state.floatingCards.filter(
      (c) => !handBefore.includes(c)
    );

    // 3. Dividi tra carte da tenere e da sostituire
    const cardsToKeep = handBefore
      .filter((c) => !cardIds.includes(c.card.instanceId))
      .map((c) => c.card);

    // 4. Calcola ID già usati (per evitare duplicati)
    const usedIds = new Set([
      ...state.floatingCards.map((c) => c.card.instanceId),
      ...cardsToKeep.map((c) => c.instanceId),
    ]);

    // 5. Pesca nuove carte dal mazzo (escludendo quelle già in uso)
    const availableNewCards = player.cards
      .filter(
        (c) =>
          (c.type === "unit" || c.type === "champion") &&
          c.metadata !== "main" &&
          !usedIds.has(c.instanceId)
      )
      .sort(() => Math.random() - 0.5)
      .slice(0, cardIds.length);

    const newHand = [...cardsToKeep, ...availableNewCards];

    // 6. Aggiungi alla board
    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;
    let x = 260;

    newHand.forEach((c) => {
      const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const updatedCard = { ...c, instanceId: generatedId };

      // Aggiorna nel deck del player
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

    syncGameStateToAll(code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const nickname = socket.data.nickname;
    if (!code || !rooms[code]) return;

    delete rooms[code].players[socket.id];
    console.log(`${nickname || "Unknown"} disconnected from ${code}`);

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
  socket.on("get-game-state", ({ code }) => {
    const room = rooms[code];
    if (room && room.lastGameState) {
      socket.emit("start-game", room.lastGameState);
      console.log("Inviato lastGameState a", socket.id);
    }
  });
  socket.on("draw-card", ({ code, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (!player) return;

    const floatingIds = state.floatingCards
      .filter((c) => c.owner === playerNickname)
      .map((c) => c.card.instanceId);

    const mainDeck = player.cards.filter(
      (c) => c.type === "unit" && !floatingIds.includes(c.instanceId)
    );

    if (mainDeck.length === 0) return;
    const card = mainDeck[0];

    const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;

    let x =
      260 +
      state.floatingCards.filter((c) => c.owner === playerNickname).length *
        100;

    state.floatingCards.push({
      id: generatedId,
      card: { ...card, instanceId: generatedId },
      x,
      y: yBase - 50,
      owner: playerNickname,
    });
    // Rimuovi la carta pescata dal mazzo del player
    const cardIndex = player.cards.findIndex(
      (c) => c.instanceId === card.instanceId
    );
    if (cardIndex !== -1) {
      player.cards.splice(cardIndex, 1);
    }

    syncGameStateToAll(code);
  });

  socket.on("draw-rune", ({ code, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (!player) return;

    const floatingIds = state.floatingCards
      .filter((c) => c.owner === playerNickname)
      .map((c) => c.card.instanceId);

    const runeDeck = player.cards.filter(
      (c) => c.type === "rune" && !floatingIds.includes(c.instanceId)
    );

    if (runeDeck.length === 0) return;

    const card = runeDeck[0];
    const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;
    const x =
      260 +
      state.floatingCards.filter((c) => c.owner === playerNickname).length *
        100;

    state.floatingCards.push({
      id: generatedId,
      card: { ...card, instanceId: generatedId },
      x,
      y: yBase - 50,
      owner: playerNickname,
    });
    // Rimuovi la carta pescata dal mazzo del player
    const cardIndex = player.cards.findIndex(
      (c) => c.instanceId === card.instanceId
    );
    if (cardIndex !== -1) {
      player.cards.splice(cardIndex, 1);
    }

    syncGameStateToAll(code);
  });

  socket.on("flip-card", ({ code, cardId, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const card = state.floatingCards.find(
      (c) => c.id === cardId && c.card.id.startsWith(playerNickname)
    );
    if (!card) return;
    card.flipped = !card.flipped;
    syncGameStateToAll(code);
  });
  socket.on("tap-card", ({ code, cardId, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const card = state.floatingCards.find(
      (c) => c.id === cardId && c.card.id.startsWith(playerNickname)
    );
    if (!card) return;
    card.rotated = !card.rotated;
    syncGameStateToAll(code);
  });
  socket.on("recycle-card", ({ code, cardId, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    // Trova e rimuovi la carta dalle floatingCards
    const idx = state.floatingCards.findIndex(
      (c) => c.id === cardId && c.card.id.startsWith(playerNickname)
    );
    if (idx === -1) return;
    const [cardObj] = state.floatingCards.splice(idx, 1);

    // Rimetti la carta nel deck giusto (mainDeck/runeDeck)
    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (player) {
      if (cardObj.card.type === "rune") {
        // NESSUN ordinamento specifico qui, aggiungi come preferisci (inizio/fine)
        player.cards.push(cardObj.card);
      } else {
        player.cards.push(cardObj.card);
      }
    }

    syncGameStateToAll(code);
  });

  //TERMINA PARTITA
  socket.on("end-game", ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit("end-game"); // Manda evento a tutti i giocatori

    // Elimina la stanza e lo stato centrale
    delete rooms[code];
    console.log("Room", code, "deleted after end-game");
  });

  function emitRoomPlayers(code) {
    const room = rooms[code];
    if (!room) return;
    const playerList = Object.entries(room.players).map(([id, p]) => ({
      id,
      nickname: p.nickname,
      ready: p.ready,
      deckName: p.deckName || null,
      isHost: id === room.hostId,
    }));
    io.to(code).emit("room-players", playerList);
    io.to(code).emit("player-update", playerList);
    console.log(
      `Updated room ${code} players:`,
      playerList.map((p) => p.nickname).join(", ")
    );
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
      });
    }
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
