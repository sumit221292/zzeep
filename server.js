const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://guileless-fairy-364399.netlify.app/"],
    methods: ["GET", "POST"]
  }
});

const redis = new Redis();

// Track active sessions
const activeSessions = new Map(); // userId -> socketId

// Store user presence and call status data
const updateUserPresence = async (userId, status) => {
  await redis.hset('user_presence', userId, status);
  // Broadcast to all EXCEPT the user who changed status
  const senderSocketId = activeSessions.get(userId);
  if (senderSocketId) {
    io.to(senderSocketId).broadcast.emit('presence_update', { userId, status });
  }
};

// Store active calls
const activeUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('update_status', async ({ userId, status }) => {
    const existingSocketId = activeSessions.get(userId);
    if (existingSocketId && existingSocketId !== socket.id) {
      socket.emit('duplicate_session', { message: 'User already logged in from another browser' });
      socket.disconnect();
      return;
    }

    activeSessions.set(userId, socket.id);
    await updateUserPresence(userId, status);
    socket.userId = userId;
  });

  socket.on('call_invite', ({ callerId, targetUserId, offer }) => {
    const targetSocketId = activeSessions.get(targetUserId);
    if (!targetSocketId) {
      socket.emit('user_offline', { targetUserId });
      return;
    }

    if (activeUsers.has(targetUserId)) {
      socket.emit('user_busy', { targetUserId });
      return;
    }

    // Send call invite only to the target user's socket
    io.to(targetSocketId).emit('incoming_call', {
      callerId,
      targetUserId,
      offer
    });
  });

  socket.on('call_accepted', ({ callerId, targetUserId, answer }) => {
    const callerSocketId = activeSessions.get(callerId);
    if (callerSocketId) {
      activeUsers.set(callerId, targetUserId);
      activeUsers.set(targetUserId, callerId);
      
      // Send call accepted only to the caller's socket
      io.to(callerSocketId).emit('call_accepted', { answer });
    }
  });

  socket.on('ice_candidate', ({ targetUserId, candidate }) => {
    const targetSocketId = activeSessions.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice_candidate', { candidate });
    }
  });

  socket.on('call_rejected', ({ callerId, targetUserId }) => {
    const callerSocketId = activeSessions.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call_ended', {
        reason: 'rejected'
      });
    }
  });

  socket.on('end_call', ({ callerId, targetUserId }) => {
    const otherUserId = activeUsers.get(callerId);
    if (otherUserId) {
      const otherSocketId = activeSessions.get(otherUserId);
      activeUsers.delete(callerId);
      activeUsers.delete(otherUserId);

      if (otherSocketId) {
        io.to(otherSocketId).emit('call_ended', { reason: 'ended' });
      }
    }
  });

  socket.on('disconnect', async () => {
    const userId = socket.userId;
    if (userId && activeSessions.get(userId) === socket.id) {
      activeSessions.delete(userId);
      
      if (activeUsers.has(userId)) {
        const otherUserId = activeUsers.get(userId);
        const otherSocketId = activeSessions.get(otherUserId);
        
        activeUsers.delete(userId);
        activeUsers.delete(otherUserId);
        
        if (otherSocketId) {
          io.to(otherSocketId).emit('call_ended', { reason: 'disconnected' });
        }
      }
      await updateUserPresence(userId, 'offline');
    }
  });
});

server.listen(4000, () => {
  console.log('Server running on port 4000');
});