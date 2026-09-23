require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 20000, connectTimeout: 60000, maxHttpBufferSize: 25e6 });

app.use(express.static('public'));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'degistir-bunu-gizli-anahtar-12345';
const TOKEN_EXPIRY = '30d';

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
    seen INTEGER DEFAULT 0,
    reply_to_name TEXT DEFAULT NULL,
    reply_to_text TEXT DEFAULT NULL,
    reactions TEXT DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    owner TEXT DEFAULT NULL,
    is_private INTEGER DEFAULT 0,
    password_hash TEXT DEFAULT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password_hash TEXT DEFAULT NULL,
    is_guest INTEGER DEFAULT 0,
    avatar TEXT DEFAULT NULL,
    status TEXT DEFAULT 'online',
    last_seen INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(is_dm, username, to_user, id DESC);
`);

try { db.exec('ALTER TABLE messages ADD COLUMN seen INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_name TEXT DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_text TEXT DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT \'{}\''); } catch (e) {}
try { db.exec('ALTER TABLE rooms ADD COLUMN owner TEXT DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE rooms ADD COLUMN is_private INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE rooms ADD COLUMN password_hash TEXT DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_guest INTEGER DEFAULT 0'); } catch (e) {}

const DEFAULT_ROOMS = ['genel', 'oyun', 'spor', 'sohbet'];
const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (name, created_at, owner) VALUES (?, ?, NULL)');
DEFAULT_ROOMS.forEach(r => insertRoom.run(r, Date.now()));

const insertMsg = db.prepare(
  'INSERT INTO messages (room, username, text, time, is_dm, to_user, seen, reply_to_name, reply_to_text, reactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const getRoomMessages = db.prepare('SELECT * FROM messages WHERE room = ? AND is_dm = 0 ORDER BY id DESC LIMIT 100');
const getAllRooms = db.prepare('SELECT name, owner, is_private FROM rooms ORDER BY created_at');
const markDMSeen = db.prepare('UPDATE messages SET seen = 1 WHERE id = ?');
const getMsgById = db.prepare('SELECT * FROM messages WHERE id = ?');
const updateReactions = db.prepare('UPDATE messages SET reactions = ? WHERE id = ?');

const getUser = db.prepare('SELECT * FROM users WHERE username = ?');
const setAvatar = db.prepare('UPDATE users SET avatar = ? WHERE username = ?');
const setStatus = db.prepare('UPDATE users SET status = ? WHERE username = ?');
const createUser = db.prepare('INSERT INTO users (username, password_hash, is_guest, last_seen) VALUES (?, ?, 0, ?)');
const createGuest = db.prepare('INSERT OR REPLACE INTO users (username, password_hash, is_guest, last_seen) VALUES (?, NULL, 1, ?)');

const onlineUsers = {};
const socketsByName = {};
// Hangi kullanıcı hangi özel odaya girmiş: { username: Set<roomName> }
const roomAccess = {};

function dmRoomName(a, b) { return [a, b].sort().join('__DM__'); }
function avatarFor(username) { const u = getUser.get(username); return u && u.avatar ? u.avatar : null; }

function usersWithAvatar() {
  return Object.values(onlineUsers).map(u => ({
    username: u.username, room: u.room,
    avatar: avatarFor(u.username),
    status: (getUser.get(u.username) || {}).status || 'online',
    isGuest: (getUser.get(u.username) || {}).is_guest === 1
  }));
}

function roomsData() { return getAllRooms.all(); }
function validateUsername(name) { return /^[a-zA-Z0-9_-]{3,20}$/.test(name); }
function makeToken(username) { return jwt.sign({ username }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET).username; } catch (e) { return null; } }
function guestName(base) { base = String(base || '').trim().slice(0, 15) || 'Misafir'; return '(misafir) ' + base; }

function parseMsg(m) {
  let reactions = {};
  try { reactions = JSON.parse(m.reactions || '{}'); } catch (e) {}
  return {
    id: m.id, user: m.username, text: m.text, time: m.time, seen: m.seen,
    avatar: avatarFor(m.username),
    replyTo: m.reply_to_name ? { name: m.reply_to_name, text: m.reply_to_text } : null,
    reactions
  };
}

// ==================== AUTH ====================
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!validateUsername(username)) return res.json({ error: 'Kullanıcı adı 3-20 karakter, harf/rakam/-/_ olabilir' });
  if (!password || password.length < 4) return res.json({ error: 'Şifre en az 4 karakter olmalı' });
  const existing = getUser.get(username);
  if (existing && existing.password_hash) return res.json({ error: 'Bu kullanıcı adı zaten alınmış' });
  try {
    const hash = await bcrypt.hash(password, 10);
    if (existing) db.prepare('UPDATE users SET password_hash = ?, is_guest = 0 WHERE username = ?').run(hash, username);
    else createUser.run(username, hash, Date.now());
    res.json({ ok: true, username, token: makeToken(username) });
  } catch (err) { res.json({ error: 'Kayıt başarısız' }); }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ error: 'Kullanıcı adı ve şifre gerekli' });
  const user = getUser.get(username);
  if (!user || !user.password_hash) return res.json({ error: 'Kullanıcı bulunamadı veya şifre yanlış' });
  try {
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.json({ error: 'Şifre yanlış' });
    res.json({ ok: true, username, token: makeToken(username) });
  } catch (err) { res.json({ error: 'Giriş başarısız' }); }
});

app.post('/api/auto-login', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ error: 'Token yok' });
  const username = verifyToken(token);
  if (!username) return res.json({ error: 'Token geçersiz' });
  const user = getUser.get(username);
  if (!user || !user.password_hash) return res.json({ error: 'Kullanıcı bulunamadı' });
  res.json({ ok: true, username, token });
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  socket.on('set username', (data) => {
    let { username, isGuest, token } = data;
    if (token) {
      const verified = verifyToken(token);
      if (verified && verified === username) {
        const u = getUser.get(username);
        if (u && u.password_hash) isGuest = false;
      }
    }
    username = String(username).trim().slice(0, 25);
    if (!username) return;
    const finalName = isGuest ? guestName(username.replace(/^\(misafir\)\s*/, '')) : username;

    if (socketsByName[finalName] && socketsByName[finalName] !== socket.id) {
      const oldSocket = io.sockets.sockets.get(socketsByName[finalName]);
      if (oldSocket) oldSocket.disconnect(true);
    }

    const existing = getUser.get(finalName);
    if (!existing) {
      if (isGuest) createGuest.run(finalName, Date.now());
      else createUser.run(finalName, null, Date.now());
    } else {
      db.prepare('UPDATE users SET last_seen = ? WHERE username = ?').run(Date.now(), finalName);
    }

    socket.username = finalName;
    socket.room = 'genel';
    socket.isGuest = isGuest;
    onlineUsers[socket.id] = { username: finalName, room: 'genel', isGuest };
    socketsByName[finalName] = socket.id;
    roomAccess[finalName] = new Set(); // Erişim verilen özel odalar
    socket.join('genel');

    socket.emit('rooms list', roomsData());
    socket.emit('current room', 'genel');
    socket.emit('history', { room: 'genel', messages: getRoomMessages.all('genel').reverse().map(parseMsg) });

    const me = getUser.get(finalName);
    socket.emit('me', { username: finalName, avatar: me ? me.avatar : null, status: me ? me.status : 'online', isGuest });

    socket.to('genel').emit('system message', finalName + ' #genel odasına katıldı 👋');
    io.emit('users list', usersWithAvatar());
  });

  // ÖZEL ODA ŞİFRE KONTROLÜ
  socket.on('check room access', (roomName) => {
    if (!socket.username) return;
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(roomName);
    if (!room) return socket.emit('room access result', { room: roomName, allowed: false, error: 'Oda yok' });
    if (!room.is_private) return socket.emit('room access result', { room: roomName, allowed: true });
    const access = roomAccess[socket.username] || new Set();
    if (access.has(roomName)) return socket.emit('room access result', { room: roomName, allowed: true });
    socket.emit('room access result', { room: roomName, allowed: false, requiresPassword: true });
  });

  socket.on('verify room password', ({ roomName, password }) => {
    if (!socket.username) return;
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(roomName);
    if (!room || !room.is_private) return;
    bcrypt.compare(password || '', room.password_hash || '', (err, ok) => {
      if (ok) {
        if (!roomAccess[socket.username]) roomAccess[socket.username] = new Set();
        roomAccess[socket.username].add(roomName);
        socket.emit('room access granted', roomName);
      } else {
        socket.emit('room access denied', roomName);
      }
    });
  });

  socket.on('join room', (newRoom) => {
    if (!socket.username) return;
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(newRoom);
    if (!room) return;

    // Özel oda kontrolü
    if (room.is_private) {
      const access = roomAccess[socket.username] || new Set();
      if (!access.has(newRoom) && room.owner !== socket.username) {
        socket.emit('error message', 'Bu oda özel, önce şifre girmelisin');
        return;
      }
    }

    const oldRoom = socket.room;
    if (oldRoom === newRoom) return;

    socket.leave(oldRoom);
    socket.to(oldRoom).emit('system message', socket.username + ' #' + oldRoom + ' odasından ayrıldı');
    socket.join(newRoom);
    socket.room = newRoom;
    onlineUsers[socket.id] = { username: socket.username, room: newRoom, isGuest: socket.isGuest };

    socket.emit('current room', newRoom);
    socket.emit('history', { room: newRoom, messages: getRoomMessages.all(newRoom).reverse().map(parseMsg) });
    socket.to(newRoom).emit('system message', socket.username + ' #' + newRoom + ' odasına katıldı 👋');
    io.emit('users list', usersWithAvatar());
  });

  // YENİ ODA (özel/şifreli olabilir)
  socket.on('create room', async ({ name, isPrivate, password }) => {
    if (!socket.username || socket.isGuest) { socket.emit('error message', 'Misafirler oda oluşturamaz'); return; }
    name = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!name || name.length < 2 || name.length > 20) { socket.emit('error message', 'Oda adı 2-20 karakter'); return; }
    if (db.prepare('SELECT name FROM rooms WHERE name = ?').get(name)) { socket.emit('error message', 'Bu oda zaten var'); return; }

    let hash = null;
    if (isPrivate) {
      if (!password || password.length < 3) { socket.emit('error message', 'Özel oda şifresi en az 3 karakter olmalı'); return; }
      hash = await bcrypt.hash(password, 10);
    }

    db.prepare('INSERT INTO rooms (name, created_at, owner, is_private, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(name, Date.now(), socket.username, isPrivate ? 1 : 0, hash);

    io.emit('rooms list', roomsData());
    io.emit('system message', socket.username + (isPrivate ? ' özel' : ' yeni') + ' oda açtı: ' + (isPrivate ? '🔒 ' : '') + '#' + name);
  });

  // ODA SİL
  socket.on('delete room', (name) => {
    if (!socket.username || socket.isGuest) { socket.emit('error message', 'Yetki yok'); return; }
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(name);
    if (!room || DEFAULT_ROOMS.includes(name)) { socket.emit('error message', 'Silinemez'); return; }
    if (room.owner !== socket.username) { socket.emit('error message', 'Sadece sahibi silebilir'); return; }

    Object.entries(onlineUsers).forEach(([id, u]) => {
      if (u.room === name) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.leave(name); s.join('genel'); s.room = 'genel';
          onlineUsers[id].room = 'genel';
          s.emit('current room', 'genel');
          s.emit('history', { room: 'genel', messages: getRoomMessages.all('genel').reverse().map(parseMsg) });
        }
      }
    });

    db.prepare('DELETE FROM messages WHERE room = ? AND is_dm = 0').run(name);
    db.prepare('DELETE FROM rooms WHERE name = ?').run(name);
    io.emit('rooms list', roomsData());
    io.emit('users list', usersWithAvatar());
    io.emit('system message', '#' + name + ' odası silindi 🗑️');
  });

  // ODA YENİDEN ADLANDIR
  socket.on('rename room', (data) => {
    if (!socket.username || socket.isGuest) { socket.emit('error message', 'Yetki yok'); return; }
    const oldName = data.oldName;
    let newName = String(data.newName || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!newName || newName.length < 2 || newName.length > 20) { socket.emit('error message', 'Yeni ad 2-20 karakter'); return; }
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(oldName);
    if (!room || DEFAULT_ROOMS.includes(oldName)) { socket.emit('error message', 'Değiştirilemez'); return; }
    if (room.owner !== socket.username) { socket.emit('error message', 'Sadece sahibi'); return; }
    if (db.prepare('SELECT name FROM rooms WHERE name = ?').get(newName)) { socket.emit('error message', 'İsim kullanılıyor'); return; }

    db.prepare('UPDATE rooms SET name = ? WHERE name = ?').run(newName, oldName);
    db.prepare('UPDATE messages SET room = ? WHERE room = ? AND is_dm = 0').run(newName, oldName);

    Object.entries(onlineUsers).forEach(([id, u]) => {
      if (u.room === oldName) {
        const s = io.sockets.sockets.get(id);
        if (s) {
          s.leave(oldName); s.join(newName); s.room = newName;
          onlineUsers[id].room = newName;
          s.emit('current room', newName);
          s.emit('history', { room: newName, messages: getRoomMessages.all(newName).reverse().map(parseMsg) });
        }
      }
    });

    io.emit('rooms list', roomsData());
    io.emit('users list', usersWithAvatar());
    io.emit('system message', '#' + oldName + ' → #' + newName);
  });

  // ODA ŞİFRESİ DEĞİŞTİR
  socket.on('change room password', async ({ name, newPassword }) => {
    if (!socket.username || socket.isGuest) return;
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(name);
    if (!room || room.owner !== socket.username) { socket.emit('error message', 'Yetki yok'); return; }
    if (!newPassword || newPassword.length < 3) { socket.emit('error message', 'Şifre en az 3 karakter'); return; }
    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE rooms SET password_hash = ?, is_private = 1 WHERE name = ?').run(hash, name);
    // Tüm erişimleri temizle
    Object.values(roomAccess).forEach(set => set.delete(name));
    io.emit('rooms list', roomsData());
    io.emit('system message', '#' + name + ' odasının şifresi değiştirildi 🔐');
  });

  socket.on('chat message', (msg) => {
    if (!socket.username) return;
    const room = socket.room || 'genel';
    const text = String(msg.text || '').slice(0, 2000);
    if (!text) return;
    const time = Date.now();
    const replyName = msg.replyTo ? String(msg.replyTo.name || '').slice(0, 25) : null;
    const replyText = msg.replyTo ? String(msg.replyTo.text || '').slice(0, 100) : null;

    let msgId = null;
    try { msgId = insertMsg.run(room, socket.username, text, time, 0, null, 1, replyName, replyText, '{}').lastInsertRowid; } catch (e) { console.error(e.message); }
    const row = getMsgById.get(msgId);
    io.to(room).emit('chat message', parseMsg(row));
  });

  socket.on('dm message', ({ to, text, replyTo }) => {
    if (!socket.username) return;
    text = String(text || '').slice(0, 2000);
    if (!text || !to) return;
    const time = Date.now();
    const dmRoom = dmRoomName(socket.username, to);
    const targetOnline = !!socketsByName[to];
    const replyName = replyTo ? String(replyTo.name || '').slice(0, 25) : null;
    const replyText = replyTo ? String(replyTo.text || '').slice(0, 100) : null;

    let msgId = null;
    try { msgId = insertMsg.run(dmRoom, socket.username, text, time, 1, to, targetOnline ? 1 : 0, replyName, replyText, '{}').lastInsertRowid; } catch (e) {}

    const row = getMsgById.get(msgId);
    const payload = { ...parseMsg(row), from: socket.username, to };
    const t = socketsByName[to];
    if (t) io.to(t).emit('dm message', payload);
    socket.emit('dm message', payload);
  });

  socket.on('react', ({ msgId, emoji }) => {
    if (!socket.username || !msgId || !emoji) return;
    try {
      const row = getMsgById.get(msgId);
      if (!row) return;
      let reactions = {};
      try { reactions = JSON.parse(row.reactions || '{}'); } catch (e) {}
      if (!reactions[emoji]) reactions[emoji] = [];
      const idx = reactions[emoji].indexOf(socket.username);
      if (idx >= 0) reactions[emoji].splice(idx, 1);
      else reactions[emoji].push(socket.username);
      if (reactions[emoji].length === 0) delete reactions[emoji];
      updateReactions.run(JSON.stringify(reactions), msgId);

      if (row.is_dm) {
        const [u1, u2] = row.room.split('__DM__');
        [u1, u2].forEach(u => {
          const sid = socketsByName[u];
          if (sid) io.to(sid).emit('reaction update', { msgId, reactions });
        });
      } else {
        io.to(row.room).emit('reaction update', { msgId, reactions });
      }
    } catch (e) {}
  });

  socket.on('dm seen', (msgId) => {
    try {
      markDMSeen.run(msgId);
      const row = getMsgById.get(msgId);
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
    socket.emit('dm history', { with: to, messages: msgs.map(parseMsg) });
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
      delete roomAccess[user.username];
      socket.to(user.room).emit('system message', user.username + ' sohbetten ayrıldı');
      io.emit('users list', usersWithAvatar());
    }
  });
});

// ==================== DOSYA YÜKLEME ====================
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ error: 'Dosya yok' });
  const url = '/uploads/' + req.file.filename;
  const isImage = /image\/(png|jpe?g|gif|webp)/.test(req.file.mimetype);
  res.json({ ok: true, url, name: req.file.originalname, isImage, size: req.file.size });
});

app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  const username = String(req.query.username || '').replace(/[^a-zA-Z0-9_()\s-]/g, '').slice(0, 25);
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
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || '';

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