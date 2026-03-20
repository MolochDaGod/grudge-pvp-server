import { createServer } from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 5000;
const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size, uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h1>Grudge PvP Server</h1><p>Rooms: ${rooms.size}</p><p><a href="/health">Health Check</a></p>`);
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/pvp",
});

const rooms = new Map();

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

// Clean stale rooms every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > 10 * 60 * 1000 && !room.started) rooms.delete(id);
  }
}, 60000);

io.on("connection", (socket) => {
  console.log(`[pvp] connected: ${socket.id}`);

  socket.on("room:create", (cb) => {
    const roomId = generateCode();
    rooms.set(roomId, {
      id: roomId,
      players: [{ socketId: socket.id, characterId: null, ready: false, slot: "p1" }],
      started: false,
      createdAt: Date.now(),
    });
    socket.join(roomId);
    console.log(`[pvp] room ${roomId} created`);
    cb({ roomId, slot: "p1" });
  });

  socket.on("room:join", (roomId, cb) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) return cb({ success: false, error: "Room not found" });
    if (room.players.length >= 2) return cb({ success: false, error: "Room is full" });
    if (room.started) return cb({ success: false, error: "Already started" });

    room.players.push({ socketId: socket.id, characterId: null, ready: false, slot: "p2" });
    socket.join(roomId);
    console.log(`[pvp] ${socket.id} joined ${roomId}`);

    const p1 = room.players.find((p) => p.slot === "p1");
    if (p1) io.to(p1.socketId).emit("room:opponent-joined");
    cb({ success: true, slot: "p2", opponentCharacter: p1?.characterId ?? null });
  });

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
      room.started = true;
      const p1 = room.players.find((p) => p.slot === "p1");
      const p2 = room.players.find((p) => p.slot === "p2");
      console.log(`[pvp] room ${data.roomId} starting: ${p1.characterId} vs ${p2.characterId}`);
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
          rooms.delete(roomId);
          console.log(`[pvp] room ${roomId} deleted`);
        }
      }
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[pvp] Grudge PvP Server running on port ${PORT}`);
});
