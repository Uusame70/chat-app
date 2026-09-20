const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let onlineUsers = 0;

io.on('connection', (socket) => {
  onlineUsers++;
  console.log('Bağlandı:', socket.id, '| Toplam:', onlineUsers);
  io.emit('online users', onlineUsers);

  socket.on('set username', (username) => {
    socket.username = username;
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
    onlineUsers--;
    io.emit('online users', onlineUsers);
    if (socket.username) {
      io.emit('system message', `${socket.username} sohbetten ayrıldı`);
    }
    console.log('Ayrıldı:', socket.id, '| Toplam:', onlineUsers);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Sunucu ${PORT} portunda çalışıyor`);
});