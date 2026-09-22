const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const ROOMS = ['genel', 'oyun', 'spor', 'sohbet'];

const roomHistory = {};
ROOMS.forEach(r => { roomHistory[r] = []; });

const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('[BAGLANDI]', socket.id);

  socket.on('set username', (username) => {
    console.log('[SET USERNAME]', username);
    socket.username = username;
    socket.room = 'genel';
    onlineUsers[socket.id] = { username: username, room: 'genel' };

    socket.join('genel');

    socket.emit('rooms list', ROOMS);

    // ÖNCE current room, SONRA history
    socket.emit('current room', 'genel');
    socket.emit('history', { room: 'genel', messages: roomHistory['genel'] });

    socket.to('genel').emit('system message', username + ' #genel odasına katıldı 👋');
    io.emit('users list', Object.values(onlineUsers));
  });

  socket.on('join room', (newRoom) => {
    console.log('[JOIN ROOM ISTEGI]', socket.username, '->', newRoom);

    if (!ROOMS.includes(newRoom)) {
      console.log('[JOIN ROOM] Gecersiz oda:', newRoom);
      return;
    }

    const oldRoom = socket.room;
    if (oldRoom === newRoom) {
      console.log('[JOIN ROOM] Zaten bu odada');
      return;
    }

    console.log('[ODA DEGISTIR]', socket.username, oldRoom, '->', newRoom);

    socket.leave(oldRoom);
    socket.to(oldRoom).emit('system message', socket.username + ' #' + oldRoom + ' odasından ayrıldı');

    socket.join(newRoom);
    socket.room = newRoom;
    onlineUsers[socket.id] = { username: socket.username, room: newRoom };

    const history = roomHistory[newRoom] || [];
    console.log('[HISTORY GONDERILIYOR]', newRoom, history.length, 'mesaj');

    // ÖNCE current room, SONRA history
    socket.emit('current room', newRoom);
    socket.emit('history', { room: newRoom, messages: history });

    socket.to(newRoom).emit('system message', socket.username + ' #' + newRoom + ' odasına katıldı 👋');
    io.emit('users list', Object.values(onlineUsers));
  });

  socket.on('chat message', (msg) => {
    const room = socket.room || 'genel';
    const fullMsg = { user: msg.user, text: msg.text, room: room, time: Date.now() };

    roomHistory[room].push(fullMsg);
    if (roomHistory[room].length > 50) roomHistory[room].shift();

    console.log('[MESAJ]', room, msg.user + ':', msg.text);
    io.to(room).emit('chat message', fullMsg);
  });

  socket.on('typing', (username) => {
    socket.to(socket.room).emit('typing', username);
  });

  socket.on('stop typing', () => {
    socket.to(socket.room).emit('stop typing');
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    delete onlineUsers[socket.id];

    if (user) {
      socket.to(user.room).emit('system message', user.username + ' sohbetten ayrıldı');
      io.emit('users list', Object.values(onlineUsers));
    }
    console.log('[AYRILDI]', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Sunucu ' + PORT + ' portunda çalışıyor');
});