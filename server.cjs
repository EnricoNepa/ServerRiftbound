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
const BOARD_WIDTH = 1410;
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
    const bothMulliganDone = Object.values(room.players).every(
      (p) => p.mulliganDone
    );
    if (!bothMulliganDone) return; // 👈 evita movimenti prematuri

    if (!room || !room.lastGameState) return;

    // Aggiorna la carta nel gameState centrale (owner deve restare il nickname!).
    const cards = room.lastGameState.floatingCards;
    const idx = cards.findIndex((c) => c.id === cardInstance.id);
    if (idx !== -1) {
      cards[idx] = { ...cards[idx], ...cardInstance, owner: cards[idx].owner };
    }

    console.log(
      `Carta ${cardInstance.id} mossa a x:${cardInstance.x} y:${cardInstance.y} (owner: ${cardInstance.owner})`
    );

    // Aggiorna lo stato centrale
    room.lastGameState.floatingCards = cards;

    // Sync per ogni giocatore
    for (const socketId in room.players) {
      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;

      const thisNickname = room.players[socketId].nickname;
      const localMulliganDone = room.players[socketId].mulliganDone;
      const opponentMulliganDone = Object.values(room.players).find(
        (p) => p.nickname !== thisNickname
      )?.mulliganDone;

      const personalizedCards = room.lastGameState.floatingCards
        .filter((card) => {
          const isLocal = card.owner === thisNickname;

          // Nascondi la mano dell'avversario se non entrambi hanno finito il mulligan
          if (!isLocal && (!localMulliganDone || !opponentMulliganDone)) {
            const isInHand =
              (card.card.type === "unit" ||
                card.card.type === "champion" ||
                card.card.type === "signature") &&
              card.card.metadata !== "main";
            if (isInHand) return false;
          }

          return true;
        })
        .map((card) => {
          const isLocal = card.owner === thisNickname;
          const isFirstPlayer =
            thisNickname === room.lastGameState.allPlayers[0].nickname;
          const opponentYOffset = isFirstPlayer ? -17 : +17;

          let opponentXOffset = 0;
          if (!isLocal) {
            if (card.card.id === "rune") {
              opponentXOffset = 782;
            } else if (card.card.id === "deck") {
              opponentXOffset = -781;
            } else if (card.card.type === "legend") {
              opponentXOffset = 614;
            } else if (
              card.card.type === "champion" &&
              card.card.metadata === "main" &&
              card.y !== 21 &&
              card.y !== 580
            ) {
              opponentXOffset = 783;
            }
          }

          return {
            ...card,
            owner: isLocal ? "local" : "opponent",
            y: isLocal
              ? card.y
              : card.card.id === "deck" || card.card.id === "rune"
              ? card.y + opponentYOffset + (isFirstPlayer ? -5 : +5)
              : card.y + opponentYOffset,
            x: isLocal ? card.x : BOARD_WIDTH - card.x,
            rotation: isLocal ? 0 : 180,
          };
        });

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
    const yBaseBasso = BOARD_HEIGHT - 1250; // parte bassa (es. 2485)
    const yBaseAlto = 250; // parte alta

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
          (c.type === "unit" ||
            c.type === "champion" ||
            c.type === "signature") &&
          c.metadata !== "main" &&
          c.id !== "deck"
      );

      const hand = available.slice(0, 4);

      // idx === 0 => primo player => basso, idx === 1 => secondo player => alto
      const yBase = idx === 0 ? yBaseBasso : yBaseAlto;
      const generatedId = `${nickname}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      let x = 260;
      [battlefield, champion, legend].filter(Boolean).forEach((c) => {
        let cardX = x;
        let cardY = yBase - 50;
        if (c.type === "battlefield" && idx === 0) {
          // sposta legend player1
          cardX = 639;
          cardY = 290;
        }
        if (c.type === "battlefield" && idx === 1) {
          // sposta legend player1
          cardX = 639;
          cardY = 308;
        }
        if (c.type === "legend" && idx === 0) {
          // sposta legend player1
          cardX = 397;
          cardY = 383;
        }
        if (c.type === "legend" && idx === 1) {
          // sposta legend player1
          cardX = 397;
          cardY = 216;
        }
        if (c.type === "champion" && idx === 0) {
          // sposta champion player2
          cardX = 313;
          cardY = 383;
        }
        if (c.type === "champion" && idx === 1) {
          // sposta champion player2
          cardX = 313;
          cardY = 215;
        }
        floatingCards.push({
          id: `${nickname}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`,
          card: { ...c, instanceId: generatedId },
          x: cardX,
          y: cardY,
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
      // Rimuovi SOLO le 4 carte della mano iniziale dal mazzo
      player.deck.cards = player.deck.cards.filter(
        (c) => !hand.some((h) => h.instanceId === c.instanceId)
      );
      room.players[socketId].mulliganDone = false;
    });
    // prima aggiungi i deck UNA VOLTA SOLA
    playersArray.forEach(([socketId, player], idx) => {
      const yBase = idx === 0 ? yBaseBasso : yBaseAlto;
      let deckX = 1200;
      let deckY = yBase;
      if (idx === 0) {
        // sposta il deck del player1
        deckX = 1093;
        deckY = 426;
      }
      if (idx === 1) {
        // sposta il deck del player2
        deckX = 1093;
        deckY = 219;
      }
      if (idx === 0) {
        // sposta le rune del player1
        runeX = 314;
        runeY = 482;
      }
      if (idx === 1) {
        // sposta le rune del player2
        runeX = 314;
        runeY = 119;
      }
      floatingCards.push({
        id: `${player.nickname}-deck`,
        card: {
          id: "deck",
          name: "Deck",
          type: "unit",
          instanceId: `${player.nickname}-deck`,
        },
        x: deckX,
        y: deckY,
        owner: player.nickname,
      });

      floatingCards.push({
        id: `${player.nickname}-runeDeck`,
        card: {
          id: "rune",
          name: "Runes",
          type: "rune",
          instanceId: `${player.nickname}-runeDeck`,
        },
        x: runeX,
        y: runeY,
        owner: player.nickname,
      });
    });

    // poi personalizzi e invii a ciascun player
    playersArray.forEach(([socketId, player]) => {
      const s = io.sockets.sockets.get(socketId);
      if (!s) return;

      const thisPlayerNickname = player.nickname;

      const personalizedFloatingCards = floatingCards
        .filter((card) => {
          const isLocal = card.owner === thisPlayerNickname;
          const isHandCard =
            (card.card.type === "unit" ||
              card.card.type === "champion" ||
              card.card.type === "signature") &&
            card.card.metadata !== "main";
          // se la carta è di mano e non del player, non mostrarla
          if (isHandCard && !isLocal) return false;
          return true;
        })
        .map((card) => ({
          ...card,
          owner: card.owner === thisPlayerNickname ? "local" : "opponent",
        }));

      // crea floatingCards filtrate già per stato globale (NO mani avversarie finché non finisce il mulligan)
      const safeFloatingCards = floatingCards.filter((c) => {
        const allNicknames = playersArray.map(([_, p]) => p.nickname);
        const isInHand =
          (c.card.type === "unit" ||
            c.card.type === "champion" ||
            c.card.type === "signature") &&
          c.card.metadata !== "main";
        // se in mano => visibile solo al proprio proprietario
        if (isInHand) return false;
        return true;
      });
      function hideOpponentHands(cards, players) {
        const hidden = [];
        for (const c of cards) {
          const isInHand =
            (c.card.type === "unit" ||
              c.card.type === "champion" ||
              c.card.type === "signature") &&
            c.card.metadata !== "main";

          if (isInHand) {
            // aggiungi solo la mano del proprietario, non globalmente
            continue;
          }
          hidden.push(c);
        }
        return hidden;
      }

      room.lastGameState = {
        floatingCards: floatingCards, // SALVA TUTTO
        allPlayers: playersArray.map(([_, p]) => ({
          nickname: p.nickname,
          name: p.deck.name,
          cards: p.deck.cards,
        })),
        roomCode: code,
      };
      const opponent = playersArray.find(([sid]) => sid !== socketId)[1];

      s.emit("start-game", {
        roomCode: code,
        allPlayers: [
          {
            nickname: player.nickname,
            name: player.deck.name,
            cards: cardsByPlayer[player.nickname],
          },
          {
            nickname: opponent.nickname,
            name: opponent.deck.name,
            cards: [], // deck vuoto avversario
          },
        ],
        floatingCards: personalizedFloatingCards,
        deck: {
          nickname: player.nickname,
          name: player.deck.name,
          cards: cardsByPlayer[player.nickname],
        },
      });

      console.log(`✅ Emit start-game to ${player.nickname}`);
    });
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
        (c.card.type === "unit" ||
          c.card.type === "champion" ||
          c.card.type === "signature") &&
        c.card.metadata !== "main"
    );

    // 2. Rimuovi TUTTE le carte della mano corrente
    state.floatingCards = state.floatingCards.filter(
      (c) =>
        !handBefore
          .filter((hc) => hc.card.id !== "deck")
          .some((hc) => hc.id === c.id)
    );
    // Rimetti le carte scartate nel mazzo (quelle selezionate per il mulligan)
    const discardedCards = handBefore.filter(
      (c) => cardIds.includes(c.card.instanceId) && c.card.id !== "deck"
    );
    // Mischia solo le carte scartate
    const shuffledDiscarded = discardedCards
      .map((c) => c.card)
      .sort(() => Math.random() - 0.5);

    // Inseriscile in fondo al mazzo, mantenendo ordine casuale tra loro
    player.cards.push(...shuffledDiscarded);

    // 3. Dividi tra carte da tenere e da sostituire
    const cardsToKeep = handBefore
      .filter(
        (c) => !cardIds.includes(c.card.instanceId) && c.card.id !== "deck" // 👈 esclude la carta deck
      )
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
          (c.type === "unit" ||
            c.type === "champion" ||
            c.type === "signature") &&
          c.metadata !== "main" &&
          c.id !== "deck" && // aggiungi questa condizione
          !usedIds.has(c.instanceId)
      )
      .sort(() => Math.random() - 0.5)
      .slice(0, cardIds.length);

    const newHand = [...cardsToKeep, ...availableNewCards];

    // 6. Aggiungi alla board
    const yBase =
      state.floatingCards.find((c) => c.owner === playerNickname)?.y || 500;
    const firstPlayer = Object.values(room.players)[0].nickname;
    const secondPlayer = Object.values(room.players)[1].nickname;
    let x = 510;
    let yHand = 0;
    if (playerNickname === firstPlayer) {
      yHand = 580;
    }
    if (playerNickname === secondPlayer) {
      yHand = 21;
    }

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
        y: yHand,
        owner: playerNickname,
      });

      x += 100;
    });

    const sid = Object.keys(room.players).find(
      (id) => room.players[id].nickname === playerNickname
    );
    if (sid) room.players[sid].mulliganDone = true;

    // invia comunque una sync parziale AL SUO client
    syncGameStateToSingle(code, sid);

    // sync globale SOLO se entrambi hanno finito
    const allMulliganDone = Object.values(room.players).every(
      (p) => p.mulliganDone
    );
    if (allMulliganDone) {
      syncGameStateToAll(code);
    }
    function syncGameStateToSingle(code, socketId) {
      const room = rooms[code];
      if (!room || !room.lastGameState) return;
      room.lastGameState.floatingCards.forEach((c) => {
        if (c.card.id === "deck") {
          if (c.owner === room.lastGameState.allPlayers[0].nickname) {
            c.x = 1093;
            c.y = 426;
          }
          if (c.owner === room.lastGameState.allPlayers[1].nickname) {
            c.x = 1093;
            c.y = 219;
          }
        }
      });

      const s = io.sockets.sockets.get(socketId);
      if (!s) return;

      const thisNickname = room.players[socketId].nickname;

      const personalizedCards = room.lastGameState.floatingCards
        .filter((card) => {
          const isLocal = card.owner === thisNickname;
          const opponentMulliganDone = Object.values(room.players).find(
            (p) => p.nickname !== thisNickname
          )?.mulliganDone;
          if (!isLocal && !opponentMulliganDone) return false;
          return true;
        })
        .map((card) => {
          const isLocal = card.owner === thisNickname;
          const isFirstPlayer =
            thisNickname === room.lastGameState.allPlayers[0].nickname;
          const opponentYOffset = isFirstPlayer ? -17 : +17;
          let opponentXOffset = 0;

          if (!isLocal) {
            switch (card.card.id) {
              case "rune":
                opponentXOffset = 782;
                break;
              case "deck":
                opponentXOffset = -781;
                break;
              default:
                if (card.card.type === "legend") opponentXOffset = 614;
                if (
                  card.card.type === "champion" &&
                  card.card.metadata === "main"
                )
                  opponentXOffset = 783;
                break;
            }
          }

          return {
            ...card,
            owner: isLocal ? "local" : "opponent",
            y: isLocal
              ? card.y
              : card.card.id === "deck" || card.card.id === "rune"
              ? card.y + opponentYOffset + (isFirstPlayer ? -5 : +5)
              : card.y + opponentYOffset,
            x: isLocal ? card.x : BOARD_WIDTH - card.x,
            rotation: isLocal ? 0 : 180,
          };
        });

      s.emit("start-game", {
        ...room.lastGameState,
        floatingCards: personalizedCards,
        allPlayers: room.lastGameState.allPlayers.map((p) => ({
          nickname: p.nickname,
          name: p.name,
          cards: p.nickname === thisNickname ? p.cards : [], // opponent deck vuoto
        })),
      });
    }
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
      (c) =>
        (c.type === "unit" ||
          c.type === "champion" ||
          c.type === "signature") &&
        c.metadata !== "main" &&
        !floatingIds.includes(c.instanceId)
    );

    if (mainDeck.length === 0) return;
    const card = mainDeck[0];

    const generatedId = `${playerNickname}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    const firstPlayer = room.players[Object.keys(room.players)[0]].nickname;
    const secondPlayer = room.players[Object.keys(room.players)[1]].nickname;

    let yHand = 0;
    if (playerNickname === firstPlayer) yHand = 580;
    if (playerNickname === secondPlayer) yHand = 21;

    let x = Math.floor(Math.random() * (1000 - 880 + 1)) + 880;

    state.floatingCards.push({
      id: generatedId,
      card: { ...card, instanceId: generatedId },
      x,
      y: yHand,
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
    const firstPlayer = room.players[Object.keys(room.players)[0]].nickname;
    const secondPlayer = room.players[Object.keys(room.players)[1]].nickname;

    let yHand = 0;
    if (playerNickname === firstPlayer) yHand = 487;
    if (playerNickname === secondPlayer) yHand = 115;

    const runeCount = state.floatingCards.filter(
      (c) => c.owner === playerNickname && c.card.type === "rune"
    ).length;

    const x = 385 + runeCount * 15;

    state.floatingCards.push({
      id: generatedId,
      card: { ...card, instanceId: generatedId },
      x,
      y: yHand,
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
    const card = state.floatingCards.find((c) => c.id === cardId);
    if (!card) return;

    if (["battlefield", "legend", "rune"].includes(card.card.type)) return;

    card.flipped = !card.flipped;
    syncGameStateToAll(code);
  });

  socket.on("tap-card", ({ code, cardId, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const card = state.floatingCards.find((c) => c.id === cardId);
    if (!card) return;

    if (card.card.type === "battlefield") return; // blocca tap su battlefield

    card.rotated = !card.rotated;
    syncGameStateToAll(code);
  });

  socket.on("recycle-card", ({ code, cardId, playerNickname }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    const state = room.lastGameState;
    const idx = state.floatingCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;

    if (["battlefield", "legend"].includes(state.floatingCards[idx].card.type))
      return;

    const [cardObj] = state.floatingCards.splice(idx, 1);

    const player = state.allPlayers.find((p) => p.nickname === playerNickname);
    if (player) {
      player.cards.push(cardObj.card);
    }

    syncGameStateToAll(code);
  });
  socket.on("update-points", ({ code, nickname, points }) => {
    const room = rooms[code];
    if (!room) return;
    room.players[socket.id].points = points;
    io.to(code).emit("points-update", { nickname, points });
  });
  socket.on("spawn-token", ({ code, playerNickname, card, x, y }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    room.lastGameState.floatingCards.push({
      id: card.instanceId,
      card,
      x,
      y,
      owner: playerNickname,
    });
    syncGameStateToAll(code);
  });
  socket.on("remove-token", ({ code, cardId }) => {
    const room = rooms[code];
    if (!room || !room.lastGameState) return;
    room.lastGameState.floatingCards = room.lastGameState.floatingCards.filter(
      (c) => c.id !== cardId
    );
    syncGameStateToAll(code);
  });
  socket.on("chat-message", ({ code, nickname, text }) => {
    if (!rooms[code]) return;
    io.to(code).emit("chat-message", { nickname, text });
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

    // forzare la posizione del deck ogni sync
    room.lastGameState.floatingCards.forEach((c) => {
      if (c.card.id === "deck") {
        if (c.owner === room.lastGameState.allPlayers[0].nickname) {
          c.x = 1093; // coords player1
          c.y = 380;
        }
        if (c.owner === room.lastGameState.allPlayers[1].nickname) {
          c.x = 1093; // coords player2
          c.y = 219;
        }
      }
      return c;
    });

    for (const socketId in room.players) {
      const s = io.sockets.sockets.get(socketId);
      if (!s) continue;
      const nickname = room.players[socketId].nickname;
      const thisNickname = room.players[socketId].nickname;

      const personalizedCards = room.lastGameState.floatingCards
        .filter((card) => {
          const isLocal = card.owner === thisNickname;
          const localMulliganDone = room.players[socketId].mulliganDone;
          const opponentMulliganDone = Object.values(room.players).find(
            (p) => p.nickname !== thisNickname
          )?.mulliganDone;
          if (!isLocal && (!localMulliganDone || !opponentMulliganDone))
            return false;
          return true;
        })
        .map((card) => {
          const isLocal = card.owner === thisNickname;
          const isFirstPlayer =
            thisNickname === room.lastGameState.allPlayers[0].nickname;
          const opponentYOffset = isFirstPlayer ? -17 : +17;
          let opponentXOffset = 0;

          if (!isLocal) {
            switch (card.card.id) {
              case "rune":
                opponentXOffset = 782;
                break;
              case "deck":
                opponentXOffset = -781;
                break;
              default:
                if (card.card.type === "legend") opponentXOffset = 614;
                if (
                  card.card.type === "champion" &&
                  card.card.metadata === "main"
                )
                  opponentXOffset = 783;
                break;
            }
          }

          return {
            ...card,
            owner: isLocal ? "local" : "opponent",
            y: isLocal
              ? card.y
              : card.card.id === "deck" || card.card.id === "rune"
              ? card.y + opponentYOffset + (isFirstPlayer ? -5 : +5)
              : card.y + opponentYOffset,
            x: isLocal ? card.x : BOARD_WIDTH - card.x,
            rotation: isLocal ? 0 : 180,
          };
        });
      if (!room.players[socketId].mulliganDone) {
        s.emit("waiting-for-mulligan");
      }

      s.emit("start-game", {
        ...room.lastGameState,
        allPlayers: room.lastGameState.allPlayers.map((p) => ({
          nickname: p.nickname,
          name: p.name,
          cards: p.nickname === thisNickname ? p.cards : [], // mostra mazzo vuoto per opponent
        })),
        floatingCards: personalizedCards,
      });
    }
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
