const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Çevrimiçi kullanıcıları tutan obje: { socketId: username }
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('Bağlandı:', socket.id);

  socket.on('set username', (username) => {
    socket.username = username;
    onlineUsers[socket.id] = username;

    // Herkese güncel listeyi gönder
    io.emit('users list', Object.values(onlineUsers));
    io.emit('system message', `${username} sohbete katıldı 👋`);
  });

  socket.on('chat message', (msg) => {
    io.emit('chat message', msg);
  });

  socket.on('typing', (username) => {
    socket.broadcast.emit('typing', username);
  });

  socket.on('stop typing', () => {
    socket.broadcast.emit('stop typing');
  });

  socket.on('disconnect', () => {
    const username = onlineUsers[socket.id];
    delete onlineUsers[socket.id];

    io.emit('users list', Object.values(onlineUsers));
    if (username) {
      io.emit('system message', `${username} sohbetten ayrıldı`);
    }
    console.log('Ayrıldı:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Sunucu ${PORT} portunda çalışıyor`);
});