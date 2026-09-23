const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 25000, connectTimeout: 45000, maxHttpBufferSize: 10e6 });

app.use(express.static('public'));

// ==================== DOSYA YÜKLEME ====================
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const AVATAR_DIR = path.join(__dirname, 'public', 'avatars');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (req.path.includes('avatar')) cb(null, AVATAR_DIR);
    else cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const base = String(req.query.username || 'anon').replace(/[^a-zA-Z0-9_-]/g, '');
    cb(null, base + '_' + Date.now() + ext);
  }
});

const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ==================== VERİTABANI ====================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'chat.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    time INTEGER NOT NULL,
    is_dm INTEGER DEFAULT 0,
    to_user TEXT DEFAULT NULL,
    seen INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    owner TEXT DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    avatar TEXT DEFAULT NULL,
    status TEXT DEFAULT 'online',
    last_seen INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(is_dm, username, to_user, id DESC);
`);

try { db.exec('ALTER TABLE messages ADD COLUMN seen INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE rooms ADD COLUMN owner TEXT DEFAULT NULL'); } catch (e) {}

const DEFAULT_ROOMS = ['genel', 'oyun', 'spor', 'sohbet'];
const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (name, created_at, owner) VALUES (?, ?, NULL)');
DEFAULT_ROOMS.forEach(r => insertRoom.run(r, Date.now()));

const insertMsg = db.prepare('INSERT INTO messages (room, username, text, time, is_dm, to_user, seen) VALUES (?, ?, ?, ?, ?, ?, ?)');
const getRoomMessages = db.prepare('SELECT * FROM messages WHERE room = ? AND is_dm = 0 ORDER BY id DESC LIMIT 100');
const getAllRooms = db.prepare('SELECT name, owner FROM rooms ORDER BY created_at');
const markDMSeen = db.prepare('UPDATE messages SET seen = 1 WHERE id = ?');

const getUser = db.prepare('SELECT * FROM users WHERE username = ?');
const upsertUser = db.prepare('INSERT INTO users (username, last_seen) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET last_seen = excluded.last_seen');
const setAvatar = db.prepare('UPDATE users SET avatar = ? WHERE username = ?');
const setStatus = db.prepare('UPDATE users SET status = ? WHERE username = ?');

// ==================== DURUM ====================
const onlineUsers = {};
const socketsByName = {};

function dmRoomName(a, b) { return [a, b].sort().join('__DM__'); }
function avatarFor(username) { const u = getUser.get(username); return u && u.avatar ? u.avatar : null; }

function usersWithAvatar() {
  return Object.values(onlineUsers).map(u => ({
    username: u.username, room: u.room,
    avatar: avatarFor(u.username),
    status: (getUser.get(u.username) || {}).status || 'online'
  }));
}

function roomsData() { return getAllRooms.all(); }

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('[BAGLANDI]', socket.id);

  socket.on('set username', (username) => {
    username = String(username).trim().slice(0, 20);
    if (!username) username = 'Anonim';

    if (socketsByName[username] && socketsByName[username] !== socket.id) {
      const oldSocket = io.sockets.sockets.get(socketsByName[username]);
      if (oldSocket) oldSocket.disconnect(true);
    }

    upsertUser.run(username, Date.now());
    socket.username = username;
    socket.room = 'genel';
    onlineUsers[socket.id] = { username, room: 'genel' };
    socketsByName[username] = socket.id;
    socket.join('genel');

    socket.emit('rooms list', roomsData());
    socket.emit('current room', 'genel');
    socket.emit('history', { room: 'genel', messages: getRoomMessages.all('genel').reverse() });

    const me = getUser.get(username);
    socket.emit('me', { username, avatar: me ? me.avatar : null, status: me ? me.status : 'online' });
    socket.to('genel').emit('system message', username + ' #genel odasına katıldı 👋');
    io.emit('users list', usersWithAvatar());
  });

  socket.on('join room', (newRoom) => {
    if (!socket.username) return;
    const roomExists = db.prepare('SELECT name FROM rooms WHERE name = ?').get(newRoom);
    if (!roomExists) return;
    const oldRoom = socket.room;
    if (oldRoom === newRoom) return;

    socket.leave(oldRoom);
    socket.to(oldRoom).emit('system message', socket.username + ' #' + oldRoom + ' odasından ayrıldı');
    socket.join(newRoom);
    socket.room = newRoom;
    onlineUsers[socket.id] = { username: socket.username, room: newRoom };

    socket.emit('current room', newRoom);
    socket.emit('history', { room: newRoom, messages: getRoomMessages.all(newRoom).reverse() });
    socket.to(newRoom).emit('system message', socket.username + ' #' + newRoom + ' odasına katıldı 👋');
    io.emit('users list', usersWithAvatar());
  });

  // --- YENİ ODA ---
  socket.on('create room', (name) => {
    if (!socket.username) return;
    name = String(name).trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!name || name.length < 2 || name.length > 20) {
      socket.emit('error message', 'Oda adı 2-20 karakter, sadece harf/rakam/-/_ olabilir');
      return;
    }
    if (db.prepare('SELECT name FROM rooms WHERE name = ?').get(name)) {
      socket.emit('error message', 'Bu oda zaten var');
      return;
    }
    db.prepare('INSERT INTO rooms (name, created_at, owner) VALUES (?, ?, ?)').run(name, Date.now(), socket.username);
    io.emit('rooms list', roomsData());
    io.emit('system message', socket.username + ' yeni oda açtı: #' + name);
    console.log('[YENI ODA]', name, '| sahibi:', socket.username);
  });

  // --- ODA SİL ---
  socket.on('delete room', (name) => {
    if (!socket.username) return;
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(name);
    if (!room) { socket.emit('error message', 'Oda bulunamadı'); return; }
    if (DEFAULT_ROOMS.includes(name)) { socket.emit('error message', 'Varsayılan oda silinemez'); return; }
    if (room.owner !== socket.username) { socket.emit('error message', 'Bu odayı sadece sahibi silebilir'); return; }

    Object.entries(onlineUsers).forEach(([id, u]) => {
      if (u.room === name) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.leave(name);
          s.join('genel');
          s.room = 'genel';
          onlineUsers[id].room = 'genel';
          s.emit('current room', 'genel');
          s.emit('history', { room: 'genel', messages: getRoomMessages.all('genel').reverse() });
        }
      }
    });

    db.prepare('DELETE FROM messages WHERE room = ? AND is_dm = 0').run(name);
    db.prepare('DELETE FROM rooms WHERE name = ?').run(name);

    io.emit('rooms list', roomsData());
    io.emit('users list', usersWithAvatar());
    io.emit('system message', '#' + name + ' odası silindi 🗑️');
    console.log('[ODA SILINDI]', name);
  });

  // --- ODA YENİDEN ADLANDIR ---
  socket.on('rename room', (data) => {
    if (!socket.username) return;
    const oldName = data.oldName;
    let newName = String(data.newName || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!newName || newName.length < 2 || newName.length > 20) {
      socket.emit('error message', 'Yeni oda adı 2-20 karakter olabilir');
      return;
    }
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(oldName);
    if (!room) { socket.emit('error message', 'Oda bulunamadı'); return; }
    if (DEFAULT_ROOMS.includes(oldName)) { socket.emit('error message', 'Varsayılan oda yeniden adlandırılamaz'); return; }
    if (room.owner !== socket.username) { socket.emit('error message', 'Bu odayı sadece sahibi değiştirebilir'); return; }
    if (db.prepare('SELECT name FROM rooms WHERE name = ?').get(newName)) {
      socket.emit('error message', 'Bu isim zaten kullanılıyor');
      return;
    }

    db.prepare('UPDATE rooms SET name = ? WHERE name = ?').run(newName, oldName);
    db.prepare('UPDATE messages SET room = ? WHERE room = ? AND is_dm = 0').run(newName, oldName);

    Object.entries(onlineUsers).forEach(([id, u]) => {
      if (u.room === oldName) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.leave(oldName);
          s.join(newName);
          s.room = newName;
          onlineUsers[id].room = newName;
          s.emit('current room', newName);
          s.emit('history', { room: newName, messages: getRoomMessages.all(newName).reverse() });
        }
      }
    });

    io.emit('rooms list', roomsData());
    io.emit('users list', usersWithAvatar());
    io.emit('system message', '#' + oldName + ' → #' + newName + ' olarak değiştirildi ✏️');
    console.log('[ODA RENAME]', oldName, '->', newName);
  });

  socket.on('chat message', (msg) => {
    if (!socket.username) return;
    const room = socket.room || 'genel';
    const text = String(msg.text || '').slice(0, 2000);
    if (!text) return;
    const time = Date.now();
    let msgId = null;
    try { msgId = insertMsg.run(room, socket.username, text, time, 0, null, 1).lastInsertRowid; } catch (e) {}
    io.to(room).emit('chat message', { id: msgId, user: socket.username, text, room, time, seen: 1, avatar: avatarFor(socket.username) });
  });

  socket.on('dm message', ({ to, text }) => {
    if (!socket.username) return;
    text = String(text || '').slice(0, 2000);
    if (!text || !to) return;
    const time = Date.now();
    const dmRoom = dmRoomName(socket.username, to);
    const targetOnline = !!socketsByName[to];
    let msgId = null;
    try { msgId = insertMsg.run(dmRoom, socket.username, text, time, 1, to, targetOnline ? 1 : 0).lastInsertRowid; } catch (e) {}
    const payload = { id: msgId, from: socket.username, to, text, time, seen: targetOnline ? 1 : 0, avatar: avatarFor(socket.username) };
    const t = socketsByName[to];
    if (t) io.to(t).emit('dm message', payload);
    socket.emit('dm message', payload);
  });

  socket.on('dm seen', (msgId) => {
    try {
      markDMSeen.run(msgId);
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
      if (row) { const t = socketsByName[row.username]; if (t) io.to(t).emit('dm seen', msgId); }
    } catch (e) {}
  });

  socket.on('open dm', (to) => {
    if (!socket.username || !to) return;
    const dmRoom = dmRoomName(socket.username, to);
    const msgs = db.prepare('SELECT * FROM messages WHERE is_dm = 1 AND room = ? ORDER BY id DESC LIMIT 100').all(dmRoom).reverse();
    msgs.forEach(m => {
      if (m.username === to && !m.seen) {
        markDMSeen.run(m.id);
        const t = socketsByName[to];
        if (t) io.to(t).emit('dm seen', m.id);
      }
    });
    socket.emit('dm history', { with: to, messages: msgs.map(m => ({ ...m, avatar: avatarFor(m.username) })) });
  });

  socket.on('set status', (status) => {
    if (!socket.username) return;
    if (!['online', 'away', 'busy'].includes(status)) return;
    setStatus.run(status, socket.username);
    io.emit('users list', usersWithAvatar());
  });

  socket.on('typing', () => { if (socket.username) socket.to(socket.room).emit('typing', socket.username); });
  socket.on('stop typing', () => { socket.to(socket.room).emit('stop typing'); });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    delete onlineUsers[socket.id];
    if (user && socketsByName[user.username] === socket.id) {
      delete socketsByName[user.username];
      socket.to(user.room).emit('system message', user.username + ' sohbetten ayrıldı');
      io.emit('users list', usersWithAvatar());
    }
  });
});

// ==================== DOSYA YÜKLEME ROUTE ====================
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ error: 'Dosya yok' });
  const url = '/uploads/' + req.file.filename;
  const isImage = /image\/(png|jpe?g|gif|webp)/.test(req.file.mimetype);
  console.log('[DOSYA]', req.file.originalname, '->', url);
  res.json({ ok: true, url, name: req.file.originalname, isImage, size: req.file.size });
});

// ==================== AVATAR UPLOAD ====================
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  const username = String(req.query.username || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
  if (!username) return res.json({ error: 'Kullanıcı yok' });
  if (!req.file) return res.json({ error: 'Dosya yok' });
  if (!/image\//.test(req.file.mimetype)) return res.json({ error: 'Sadece resim' });

  const url = '/avatars/' + req.file.filename;
  try { setAvatar.run(url, username); } catch (e) { return res.json({ error: 'DB hatası' }); }

  const sid = socketsByName[username];
  if (sid) { const s = io.sockets.sockets.get(sid); if (s) s.emit('me', { username, avatar: url, status: (getUser.get(username) || {}).status || 'online' }); }
  io.emit('users list', usersWithAvatar());
  res.json({ ok: true, url });
});

// ==================== GIPHY ====================
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || 'NPtVMP5W2go2tGESyQ8qRq8iYE3TBqZx';

app.get('/api/gifs', async (req, res) => {
  const q = req.query.q || 'trending';
  const limit = req.query.limit || 20;
  try {
    let url = q === 'trending'
      ? 'https://api.giphy.com/v1/gifs/trending?api_key=' + GIPHY_API_KEY + '&limit=' + limit + '&rating=g'
      : 'https://api.giphy.com/v1/gifs/search?api_key=' + GIPHY_API_KEY + '&q=' + encodeURIComponent(q) + '&limit=' + limit + '&rating=g';
    const r = await fetch(url);
    const data = await r.json();
    if (data.meta && data.meta.status !== 200) return res.json({ error: data.meta.msg, results: [] });
    res.json({ results: (data.data || []).map(g => ({ media_formats: { tinygif: { url: g.images.fixed_height_small.url }, gif: { url: g.images.original.url } } })) });
  } catch (err) { res.json({ error: err.message, results: [] }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Sunucu ' + PORT + ' portunda çalışıyor');
  console.log('   Veritabanı: ' + DB_PATH);
});