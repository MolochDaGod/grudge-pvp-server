import { createServer } from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 5000;

const rooms = new Map();

// --- Helpers ---

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

/** Returns the public-facing shape of a room for lobby listings. */
function roomSummary(room) {
  return {
    roomId: room.id,
    gameMode: room.gameMode,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.length,
    status: room.status,
    createdBy: room.createdBy,
    gameSettings: room.gameSettings,
    createdAt: room.createdAt,
  };
}

/** Removes a room and notifies all lobby clients. */
function removeRoom(roomId) {
  if (!rooms.has(roomId)) return;
  rooms.delete(roomId);
  io.emit("lobby:game-removed", { roomId });
  console.log(`[pvp] room ${roomId} removed`);
}

// --- HTTP server ---

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    const allRooms = [...rooms.values()];
    const waitingGames = allRooms.filter((r) => r.status === "waiting").length;
    const inProgressGames = allRooms.filter((r) => r.status === "in-progress").length;
    const totalPlayers = allRooms.reduce((sum, r) => sum + r.players.length, 0);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        lobby: {
          waitingGames,
          inProgressGames,
          totalPlayers,
        },
      })
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h1>Grudge PvP Server</h1><p>Rooms: ${rooms.size}</p><p><a href="/health">Health Check</a></p>`);
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/pvp",
});

// Clean stale rooms every minute (5-minute TTL for non-started rooms)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 5 * 60 * 1000 && room.status === "waiting") {
      removeRoom(id);
    }
  }
}, 60000);

// --- Socket.io events ---

io.on("connection", (socket) => {
  console.log(`[pvp] connected: ${socket.id}`);

  // ── Lobby ──────────────────────────────────────────────────────────────────

  /** Return all games currently accepting players. */
  socket.on("lobby:list", (cb) => {
    const waiting = [...rooms.values()]
      .filter((r) => r.status === "waiting")
      .map(roomSummary);
    if (typeof cb === "function") cb(waiting);
  });

  /** Create a new game and broadcast it to the lobby. */
  socket.on("lobby:create-game", (options = {}, cb) => {
    const roomId = generateCode();
    const room = {
      id: roomId,
      players: [{ socketId: socket.id, characterId: null, ready: false, slot: "p1" }],
      gameMode: options.gameMode ?? "1v1",
      maxPlayers: options.maxPlayers ?? 2,
      gameSettings: options.gameSettings ?? {},
      status: "waiting",
      createdBy: socket.id,
      createdAt: Date.now(),
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    console.log(`[pvp] room ${roomId} created by ${socket.id} (mode: ${room.gameMode})`);

    // Notify all lobby clients about the new game
    io.emit("lobby:game-updated", roomSummary(room));

    if (typeof cb === "function") {
      cb({ success: true, roomId, slot: "p1", room: roomSummary(room) });
    }
  });

  /** Join an existing game by roomId. */
  socket.on("lobby:join-game", (roomId, cb) => {
    const room = rooms.get(typeof roomId === "string" ? roomId.toUpperCase() : roomId);
    if (!room) return typeof cb === "function" && cb({ success: false, error: "Room not found" });
    if (room.status !== "waiting") return typeof cb === "function" && cb({ success: false, error: "Game is not open for joining" });
    if (room.players.length >= room.maxPlayers) return typeof cb === "function" && cb({ success: false, error: "Room is full" });

    room.players.push({ socketId: socket.id, characterId: null, ready: false, slot: "p2" });
    socket.join(room.id);
    console.log(`[pvp] ${socket.id} joined ${room.id} via lobby`);

    // Notify the creator that an opponent joined
    const p1 = room.players.find((p) => p.slot === "p1");
    if (p1) io.to(p1.socketId).emit("room:opponent-joined");

    // Broadcast updated game state to all lobby clients
    io.emit("lobby:game-updated", roomSummary(room));

    if (typeof cb === "function") {
      cb({ success: true, slot: "p2", roomId: room.id, room: roomSummary(room), opponentCharacter: p1?.characterId ?? null });
    }
  });

  // ── Legacy room events (kept for backwards compatibility) ──────────────────

  /** @deprecated Use lobby:create-game instead. */
  socket.on("room:create", (cb) => {
    const roomId = generateCode();
    const room = {
      id: roomId,
      players: [{ socketId: socket.id, characterId: null, ready: false, slot: "p1" }],
      gameMode: "1v1",
      maxPlayers: 2,
      gameSettings: {},
      status: "waiting",
      createdBy: socket.id,
      createdAt: Date.now(),
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    console.log(`[pvp] room ${roomId} created (legacy)`);

    io.emit("lobby:game-updated", roomSummary(room));

    if (typeof cb === "function") cb({ roomId, slot: "p1" });
  });

  /** @deprecated Use lobby:join-game instead. */
  socket.on("room:join", (roomId, cb) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return typeof cb === "function" && cb({ success: false, error: "Room not found" });
    if (room.players.length >= room.maxPlayers) return typeof cb === "function" && cb({ success: false, error: "Room is full" });
    if (room.status !== "waiting") return typeof cb === "function" && cb({ success: false, error: "Already started" });

    room.players.push({ socketId: socket.id, characterId: null, ready: false, slot: "p2" });
    socket.join(roomId);
    console.log(`[pvp] ${socket.id} joined ${roomId} (legacy)`);

    const p1 = room.players.find((p) => p.slot === "p1");
    if (p1) io.to(p1.socketId).emit("room:opponent-joined");

    // Reflect the join in the lobby
    io.emit("lobby:game-updated", roomSummary(room));

    if (typeof cb === "function") {
      cb({ success: true, slot: "p2", opponentCharacter: p1?.characterId ?? null });
    }
  });

  // ── In-room events ─────────────────────────────────────────────────────────

  socket.on("room:pick", (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return;
    player.characterId = data.characterId;
    const opponent = room.players.find((p) => p.socketId !== socket.id);
    if (opponent) io.to(opponent.socketId).emit("room:opponent-picked", { characterId: data.characterId });
  });

  socket.on("room:ready", (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player || !player.characterId) return;
    player.ready = true;

    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      room.status = "in-progress";
      const p1 = room.players.find((p) => p.slot === "p1");
      const p2 = room.players.find((p) => p.slot === "p2");
      console.log(`[pvp] room ${data.roomId} starting: ${p1.characterId} vs ${p2.characterId}`);

      // Remove from lobby view
      io.emit("lobby:game-updated", roomSummary(room));

      io.to(data.roomId).emit("fight:start", {
        p1Character: p1.characterId,
        p2Character: p2.characterId,
      });
    }
  });

  socket.on("input", (data) => socket.to(data.roomId).emit("input:remote", { frame: data.frame, keys: data.keys }));
  socket.on("action", (data) => socket.to(data.roomId).emit("action:remote", { action: data.action, params: data.params }));

  socket.on("disconnect", () => {
    console.log(`[pvp] disconnected: ${socket.id}`);
    for (const [roomId, room] of rooms) {
      const idx = room.players.findIndex((p) => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit("room:opponent-left");

        if (room.players.length === 0) {
          removeRoom(roomId);
        } else {
          // Room still has players — mark finished and update lobby
          room.status = "finished";
          io.emit("lobby:game-updated", roomSummary(room));
        }
      }
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[pvp] Grudge PvP Server running on port ${PORT}`);
});
