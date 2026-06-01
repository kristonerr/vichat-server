const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96E6A1', '#DDA0DD', '#FFD93D', '#FF8C42', '#6C5CE7'];
const authAttempts = new Map();
const onlineUsers = new Map();
const lastOnline = new Map();

function checkRateLimit(ip, maxAttempts) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry) return null;
  const { count, lastAttempt } = entry;
  if (count <= maxAttempts) return null;
  const waitMs = Math.min(Math.pow(2, count - maxAttempts) * 30000, 3600000);
  const elapsed = now - lastAttempt;
  if (elapsed < waitMs) return Math.ceil((waitMs - elapsed) / 1000);
  return null;
}

function getUserByToken(token) {
  const row = db.prepare(`SELECT users.id, users.username, users.color FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ?`).get(token);
  return row || null;
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 2 || username.length > 20 || password.length < 4) {
    return res.status(400).json({ error: 'Имя от 2 до 20 символов, пароль от 4 символов' });
  }
  const ip = req.ip;
  const wait = checkRateLimit(ip, 10);
  if (wait) return res.status(429).json({ error: `Слишком много попыток. Подожди ${wait} сек` });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Имя уже занято' });

  const hash = bcrypt.hashSync(password, 10);
  const color = colors[db.prepare('SELECT COUNT(*) as c FROM users').get().c % colors.length];
  const result = db.prepare('INSERT INTO users (username, password_hash, color) VALUES (?, ?, ?)').run(username, hash, color);
  const token = uuidv4();
  db.prepare('INSERT INTO sessions (user_id, token) VALUES (?, ?)').run(result.lastInsertRowid, token);

  const entry = authAttempts.get(ip);
  if (entry) entry.count = 0;

  res.json({ token, user: { id: result.lastInsertRowid, username, color } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введите имя и пароль' });

  const ip = req.ip;
  const wait = checkRateLimit(ip, 5);
  if (wait) return res.status(429).json({ error: `Слишком много попыток. Подожди ${wait} сек` });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const entry = authAttempts.get(ip) || { count: 0 };
    entry.count++;
    entry.lastAttempt = Date.now();
    authAttempts.set(ip, entry);
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }

  const token = uuidv4();
  db.prepare('INSERT INTO sessions (user_id, token) VALUES (?, ?)').run(user.id, token);
  authAttempts.set(ip, { count: 0, lastAttempt: Date.now() });

  res.json({ token, user: { id: user.id, username: user.username, color: user.color } });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/contacts', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const contacts = db.prepare(`
    SELECT u.id, u.username, u.color,
      (SELECT COUNT(*) FROM messages m WHERE m.from_user_id = u.id AND m.to_user_id = ? AND m.read_at IS NULL) as unread
    FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.user_id = ?
  `).all(user.id, user.id);
  res.json(contacts);
});

app.post('/api/contacts/add', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const contact = db.prepare('SELECT id FROM users WHERE username = ?').get(req.body.username);
  if (!contact) return res.status(404).json({ error: 'Пользователь не найден' });
  if (contact.id === user.id) return res.status(400).json({ error: 'Нельзя добавить себя' });
  try {
    db.prepare('INSERT INTO contacts (user_id, contact_id) VALUES (?, ?)').run(user.id, contact.id);
    res.json({ ok: true, contactId: contact.id });
  } catch (e) {
    res.status(409).json({ error: 'Уже в контактах' });
  }
});

app.post('/api/contacts/remove', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = (SELECT id FROM users WHERE username = ?)').run(user.id, req.body.username);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  res.json(user);
});

app.get('/api/version', (req, res) => {
  res.json({ versionCode: 10, versionName: '0.5.6', apkUrl: '/apk/vichat.apk', changelog: '- Security fixes\n- MutableSharedFlow\n- EncryptedSharedPreferences\n- UTC timestamps' });
});

app.use('/apk', express.static(path.join(__dirname, 'apk')));

app.put('/api/messages/:id/edit', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const msgId = parseInt(req.params.id);
  const text = req.body.text?.trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  if (!msg) return res.status(404).json({ error: 'not found' });
  if (msg.from_user_id !== user.id) return res.status(403).json({ error: 'not yours' });
  db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, msgId);
  const target = [...onlineUsers.values()].find(u => u.id === msg.to_user_id);
  if (target) io.to(target.socketId).emit('message-edited', { id: msgId, text });
  res.json({ ok: true });
});

app.delete('/api/messages/:id', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const msgId = parseInt(req.params.id);
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  if (!msg) return res.status(404).json({ error: 'not found' });
  if (msg.from_user_id !== user.id) return res.status(403).json({ error: 'not yours' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
  const target = [...onlineUsers.values()].find(u => u.id === msg.to_user_id);
  if (target) io.to(target.socketId).emit('message-deleted', { id: msgId });
  res.json({ ok: true });
});

app.get('/api/messages/:contactId', (req, res) => {
  const user = getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const contactId = parseInt(req.params.contactId);
  db.prepare('UPDATE messages SET read_at = datetime(\'now\') WHERE from_user_id = ? AND to_user_id = ? AND read_at IS NULL').run(contactId, user.id);
  const msgs = db.prepare(`
    SELECT m.id, m.text, m.from_user_id as fromId, m.created_at as time, m.read_at as readAt FROM messages m
    WHERE (m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?)
    ORDER BY m.created_at ASC LIMIT 200
  `).all(user.id, contactId, contactId, user.id);
  res.json(msgs);
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers?.authorization || socket.handshake.query?.token;
  if (!token) return next(new Error('no token'));
  const user = getUserByToken(token);
  if (!user) return next(new Error('invalid token'));
  socket.user = user;
  socket.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, { id: socket.userId, username: socket.user.username, color: socket.user.color, socketId: socket.id });
  broadcastContacts();

  // Send pending offline messages
  const since = lastOnline.get(socket.userId) || 0;
  if (since) {
    const sinceStr = new Date(since).toISOString().slice(0, 19).replace('T', ' ');
    const pending = db.prepare(`
      SELECT m.text, m.from_user_id as fromId, m.created_at as time FROM messages m
      WHERE m.to_user_id = ? AND m.created_at > ?
      ORDER BY m.created_at ASC
    `).all(socket.userId, sinceStr);
    for (const msg of pending) {
      socket.emit('private-message', msg);
    }
  }

  socket.on('private-message', ({ toUserId, text }) => {
    if (!text || !text.trim()) return;
    text = text.trim().slice(0, 500);
    const result = db.prepare('INSERT INTO messages (from_user_id, to_user_id, text) VALUES (?, ?, ?)').run(socket.userId, toUserId, text);
    const msg = { id: result.lastInsertRowid, fromId: socket.userId, text, time: new Date().toISOString(), readAt: null };
    const target = [...onlineUsers.values()].find(u => u.id === toUserId);
    if (target) {
      io.to(target.socketId).emit('private-message', msg);
      const unreadCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE from_user_id = ? AND to_user_id = ? AND read_at IS NULL').get(socket.userId, toUserId);
      io.to(target.socketId).emit('unread-update', { fromUserId: socket.userId, count: unreadCount.c });
    }
    socket.emit('private-message', msg);
  });

  socket.on('mark-read', ({ fromUserId }) => {
    db.prepare('UPDATE messages SET read_at = datetime(\'now\') WHERE from_user_id = ? AND to_user_id = ? AND read_at IS NULL').run(fromUserId, socket.userId);
    const remaining = db.prepare('SELECT COUNT(*) as c FROM messages WHERE from_user_id = ? AND to_user_id = ? AND read_at IS NULL').get(fromUserId, socket.userId);
    socket.emit('unread-update', { fromUserId, count: remaining.c });
  });

  socket.on('typing', ({ toUserId }) => {
    const target = [...onlineUsers.values()].find(u => u.id === toUserId);
    if (target) io.to(target.socketId).emit('typing', { fromUsername: socket.user.username });
  });

  socket.on('stop-typing', ({ toUserId }) => {
    const target = [...onlineUsers.values()].find(u => u.id === toUserId);
    if (target) io.to(target.socketId).emit('stop-typing');
  });

  socket.on('disconnect', () => {
    lastOnline.set(socket.userId, Date.now());
    onlineUsers.delete(socket.userId);
    broadcastContacts();
  });
});

function broadcastContacts() {
  const list = [...onlineUsers.values()].map(u => ({ id: u.id, username: u.username, color: u.color }));
  io.emit('contacts-online', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ViChat on http://localhost:${PORT}`);
});
