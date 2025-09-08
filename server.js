const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 存储在线用户信息 (userId -> socketId)
const onlineUsers = {};
// 存储通话状态 (callId -> { caller, callee, status })
const calls = {};

// 提供静态文件
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  console.log('新连接:', socket.id);

  // 用户登录（设置固定ID）
  socket.on('login', (userId) => {
    // 检查ID是否已被使用
    const existingUser = Object.keys(onlineUsers).find(key => onlineUsers[key] === userId);
    if (existingUser) {
      socket.emit('login-failed', '该用户ID已被使用，请选择其他ID');
      return;
    }
    
    // 存储用户ID与socket的映射
    onlineUsers[socket.id] = userId;
    socket.userId = userId;
    console.log(`用户 ${userId} 登录`);
    socket.emit('login-success', userId);
    
    // 通知所有在线用户，更新在线列表
    io.emit('user-status', {
      userId,
      status: 'online'
    });
  });

  // 发起呼叫
  socket.on('call', (data) => {
    const callerId = socket.userId;
    const calleeId = data.calleeId;
    
    if (!callerId) {
      socket.emit('call-failed', '请先登录');
      return;
    }
    
    if (callerId === calleeId) {
      socket.emit('call-failed', '不能呼叫自己');
      return;
    }
    
    // 查找被呼叫用户的socket
    const calleeSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === calleeId);
    
    if (!calleeSocketId) {
      socket.emit('call-failed', '对方不在线');
      return;
    }
    
    // 创建通话ID
    const callId = `${callerId}-${calleeId}-${Date.now()}`;
    
    // 存储通话信息
    calls[callId] = {
      caller: callerId,
      callee: calleeId,
      status: 'ringing' // 响铃中
    };
    
    console.log(`用户 ${callerId} 呼叫用户 ${calleeId}，通话ID: ${callId}`);
    
    // 通知被呼叫方有来电
    io.to(calleeSocketId).emit('incoming-call', {
      callId,
      callerId
    });
    
    // 通知呼叫方呼叫已发起
    socket.emit('call-initiated', {
      callId,
      calleeId
    });
  });

  // 接听呼叫
  socket.on('answer-call', (data) => {
    const callId = data.callId;
    const calleeId = socket.userId;
    const call = calls[callId];
    
    if (!call || call.callee !== calleeId) {
      socket.emit('call-error', '无效的通话');
      return;
    }
    
    // 更新通话状态
    call.status = 'active';
    
    // 查找呼叫方的socket
    const callerSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === call.caller);
    
    if (callerSocketId) {
      // 通知呼叫方通话已被接听
      io.to(callerSocketId).emit('call-answered', {
        callId
      });
      
      // 通知被呼叫方通话已建立
      socket.emit('call-connected', {
        callId
      });
      
      console.log(`通话 ${callId} 已被接听`);
    }
  });

  // 拒绝呼叫
  socket.on('reject-call', (data) => {
    const callId = data.callId;
    const calleeId = socket.userId;
    const call = calls[callId];
    
    if (!call || call.callee !== calleeId) {
      return;
    }
    
    // 更新通话状态
    call.status = 'rejected';
    
    // 查找呼叫方的socket
    const callerSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === call.caller);
    
    if (callerSocketId) {
      // 通知呼叫方通话被拒绝
      io.to(callerSocketId).emit('call-rejected', {
        callId
      });
      
      console.log(`通话 ${callId} 被拒绝`);
    }
  });

  // 挂断通话
  socket.on('end-call', (data) => {
    const callId = data.callId;
    const userId = socket.userId;
    const call = calls[callId];
    
    if (!call || (call.caller !== userId && call.callee !== userId)) {
      return;
    }
    
    // 更新通话状态
    call.status = 'ended';
    
    // 通知通话双方通话已结束
    const callerSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === call.caller);
    const calleeSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === call.callee);
    
    if (callerSocketId && callerSocketId !== socket.id) {
      io.to(callerSocketId).emit('call-ended', { callId });
    }
    
    if (calleeSocketId && calleeSocketId !== socket.id) {
      io.to(calleeSocketId).emit('call-ended', { callId });
    }
    
    console.log(`通话 ${callId} 已结束`);
    
    // 清理通话信息
    setTimeout(() => {
      delete calls[callId];
    }, 5000);
  });

  // 转发ICE候选者
  socket.on('ice-candidate', (data) => {
    const { callId, candidate } = data;
    const call = calls[callId];
    
    if (!call) return;
    
    // 确定消息接收方
    const targetId = call.caller === socket.userId ? call.callee : call.caller;
    const targetSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === targetId);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', {
        callId,
        candidate,
        senderId: socket.userId
      });
    }
  });

  // 转发SDP提议
  socket.on('offer', (data) => {
    const { callId, offer } = data;
    const call = calls[callId];
    
    if (!call || call.caller !== socket.userId) return;
    
    // 发送给被呼叫方
    const calleeSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === call.callee);
    
    if (calleeSocketId) {
      io.to(calleeSocketId).emit('offer', {
        callId,
        offer,
        senderId: socket.userId
      });
    }
  });

  // 转发SDP应答
  socket.on('answer', (data) => {
    const { callId, answer } = data;
    const call = calls[callId];
    
    if (!call || call.callee !== socket.userId) return;
    
    // 发送给呼叫方
    const callerSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === call.caller);
    
    if (callerSocketId) {
      io.to(callerSocketId).emit('answer', {
        callId,
        answer,
        senderId: socket.userId
      });
    }
  });

  // 断开连接处理
  socket.on('disconnect', () => {
    const userId = onlineUsers[socket.id];
    
    if (userId) {
      console.log(`用户 ${userId} 断开连接`);
      
      // 从在线用户列表移除
      delete onlineUsers[socket.id];
      
      // 通知所有用户该用户已下线
      io.emit('user-status', {
        userId,
        status: 'offline'
      });
      
      // 处理该用户相关的通话
      Object.keys(calls).forEach(callId => {
        const call = calls[callId];
        if (call.caller === userId || call.callee === userId) {
          // 如果是活跃通话，通知对方
          if (call.status === 'active' || call.status === 'ringing') {
            const otherUserId = call.caller === userId ? call.callee : call.caller;
            const otherSocketId = Object.keys(onlineUsers).find(key => onlineUsers[key] === otherUserId);
            
            if (otherSocketId) {
              io.to(otherSocketId).emit('call-ended', { 
                callId,
                reason: '对方已下线'
              });
            }
          }
          
          // 删除通话记录
          delete calls[callId];
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
