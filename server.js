const fs = require('fs');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const { Schema } = mongoose;

// MongoDB connection with enhanced error handling
const dbConnect = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/realtime-docs', {
      serverSelectionTimeoutMS: 5000,
      retryWrites: true,
      retryReads: true
    });
    console.log('Connected to MongoDB at:', conn.connection.host);
    
    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected - attempting to reconnect...');
      setTimeout(dbConnect, 5000);
    });
    
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    console.log('Retrying connection in 5 seconds...');
    setTimeout(dbConnect, 5000);
  }
};

dbConnect();

// Document schema
const documentSchema = new Schema({
  roomId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const Document = mongoose.model('Document', documentSchema);

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = socketIO(server);

// Request logger middleware
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.url}`);
  next();
});

// Test endpoint
app.get('/test', (req, res) => {
  console.log('Test endpoint hit');
  res.send('Server is working');
});

// Editor route
app.get('/editor.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'editor.html');
  console.log(`Serving editor.html from: ${filePath}`);
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.set('Content-Type', 'text/html');
    res.send(content);
    console.log('Editor served successfully');
  } catch (err) {
    console.error('Error serving editor:', err);
    res.status(500).send('Error loading editor');
  }
});

// Then static files
app.use(express.static(path.join(__dirname, 'public')));

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000'];

io.engine.on("initial_headers", (headers, req) => {
  if (allowedOrigins.includes(req.headers.origin)) {
    headers["Access-Control-Allow-Origin"] = req.headers.origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
});

// Room management
let rooms = {};

io.on('connection', (socket) => {
  console.log('New user connected');

  socket.on('join_room', (room) => {
    socket.join(room);
    rooms[room] = rooms[room] || { users: new Set() };
    rooms[room].users.add(socket.id);
    
    socket.emit('room_joined', { room });
    io.to(room).emit('user_joined', { 
      userId: socket.id,
      userCount: rooms[room].users.size
    });
  });

  socket.on('document_update', (data) => {
    io.to(data.room).emit('sync_update', {
      content: data.content,
      userId: socket.id
    });
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(room => {
      if (rooms[room].users.has(socket.id)) {
        rooms[room].users.delete(socket.id);
        io.to(room).emit('user_left', {
          userId: socket.id,
          userCount: rooms[room].users.size
        });
      }
    });
  });
});

// Save document endpoint
app.post('/api/save-doc', async (req, res) => {
  try {
    const { room, content } = req.body;
    
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Database not connected');
    }

    const result = await Document.findOneAndUpdate(
      { roomId: room },
      { content, updatedAt: Date.now() },
      { upsert: true, new: true, runValidators: true }
    );
    
    res.status(200).json({
      message: 'Document saved',
      documentId: result._id,
      timestamp: result.updatedAt
    });
  } catch (err) {
    console.error('Save error:', err);
    res.status(503).json({
      error: 'Service unavailable',
      message: 'Document could not be saved to database',
      details: err.message
    });
  }
});

// In-memory document storage fallback
const memoryDocs = new Map();

// Explicit route for editor
app.get('/editor.html', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'editor.html');
  console.log(`Attempting to serve editor.html from: ${filePath}`);
  
  if (fs.existsSync(filePath)) {
    console.log('File exists, sending...');
    res.sendFile(filePath);
  } else {
    console.log('File not found');
    res.status(404).send('Editor file not found');
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'memory';
  res.json({
    status: 'ok',
    dbState: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Save document endpoint with memory fallback
app.post('/api/save-doc', async (req, res) => {
  try {
    const { room, content } = req.body;
    
    if (mongoose.connection.readyState === 1) {
      const result = await Document.findOneAndUpdate(
        { roomId: room },
        { content, updatedAt: Date.now() },
        { upsert: true, new: true, runValidators: true }
      );
      
      return res.status(200).json({
        message: 'Document saved to database',
        documentId: result._id,
        timestamp: result.updatedAt
      });
    }

    // Fallback to memory storage
    memoryDocs.set(room, {
      content,
      updatedAt: new Date()
    });

    res.status(200).json({
      message: 'Document saved to memory (MongoDB not available)',
      documentId: `mem-${room}`,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Save error:', err);
    res.status(503).json({
      error: 'Service unavailable',
      message: 'Document could not be saved',
      details: err.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`MongoDB connection state: ${mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'}`);
});
