const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { pool, initDB } = require('./db');

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

async function getUserByToken(token) {
  const result = await pool.query(`SELECT users.id, users.username, users.color FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = $1`, [token]);
  return result.rows[0] || null;
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 2 || username.length > 20 || password.length < 4) {
    return res.status(400).json({ error: 'Имя от 2 до 20 символов, пароль от 4 символов' });
  }
  const ip = req.ip;
  const wait = checkRateLimit(ip, 10);
  if (wait) return res.status(429).json({ error: `Слишком много попыток. Подожди ${wait} сек` });

  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows[0]) return res.status(409).json({ error: 'Имя уже занято' });

  const hash = bcrypt.hashSync(password, 10);
  const countResult = await pool.query('SELECT COUNT(*) as c FROM users');
  const color = colors[parseInt(countResult.rows[0].c) % colors.length];
  const newUser = await pool.query('INSERT INTO users (username, password_hash, color) VALUES ($1, $2, $3) RETURNING id', [username, hash, color]);
  const token = uuidv4();
  await pool.query('INSERT INTO sessions (user_id, token) VALUES ($1, $2)', [newUser.rows[0].id, token]);

  const entry = authAttempts.get(ip);
  if (entry) entry.count = 0;

  res.json({ token, user: { id: newUser.rows[0].id, username, color } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введите имя и пароль' });

  const ip = req.ip;
  const wait = checkRateLimit(ip, 5);
  if (wait) return res.status(429).json({ error: `Слишком много попыток. Подожди ${wait} сек` });

  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const entry = authAttempts.get(ip) || { count: 0 };
    entry.count++;
    entry.lastAttempt = Date.now();
    authAttempts.set(ip, entry);
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  }

  const token = uuidv4();
  await pool.query('INSERT INTO sessions (user_id, token) VALUES ($1, $2)', [user.id, token]);
  authAttempts.set(ip, { count: 0, lastAttempt: Date.now() });

  res.json({ token, user: { id: user.id, username: user.username, color: user.color } });
});

app.post('/api/logout', async (req, res) => {
  const token = req.headers.authorization;
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  res.json({ ok: true });
});

app.get('/api/contacts', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const contacts = await pool.query(`SELECT u.id, u.username, u.color,
    (SELECT COUNT(*) FROM messages m WHERE m.from_user_id = u.id AND m.to_user_id = $1 AND m.read_at IS NULL) as unread
    FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.user_id = $2`, [user.id, user.id]);
  res.json(contacts.rows);
});

app.post('/api/contacts/add', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const contact = await pool.query('SELECT id FROM users WHERE username = $1', [req.body.username]);
  if (!contact.rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
  if (contact.rows[0].id === user.id) return res.status(400).json({ error: 'Нельзя добавить себя' });
  try {
    await pool.query('INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2)', [user.id, contact.rows[0].id]);
    res.json({ ok: true, contactId: contact.rows[0].id });
  } catch (e) {
    res.status(409).json({ error: 'Уже в контактах' });
  }
});

app.post('/api/contacts/remove', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  await pool.query('DELETE FROM contacts WHERE user_id = $1 AND contact_id = (SELECT id FROM users WHERE username = $2)', [user.id, req.body.username]);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  res.json(user);
});

app.get('/api/version', (req, res) => {
  res.json({ versionCode: 10, versionName: '0.5.6', apkUrl: '/apk/vichat.apk', changelog: '- Security fixes\n- MutableSharedFlow\n- EncryptedSharedPreferences\n- UTC timestamps' });
});

app.use('/apk', express.static(path.join(__dirname, 'apk')));

app.put('/api/messages/:id/edit', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const msgId = parseInt(req.params.id);
  const text = req.body.text?.trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'text required' });
  const msg = await pool.query('SELECT * FROM messages WHERE id = $1', [msgId]);
  if (!msg.rows[0]) return res.status(404).json({ error: 'not found' });
  if (msg.rows[0].from_user_id !== user.id) return res.status(403).json({ error: 'not yours' });
  await pool.query('UPDATE messages SET text = $1 WHERE id = $2', [text, msgId]);
  const target = [...onlineUsers.values()].find(u => u.id === msg.rows[0].to_user_id);
  if (target) io.to(target.socketId).emit('message-edited', { id: msgId, text });
  res.json({ ok: true });
});

app.delete('/api/messages/:id', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const msgId = parseInt(req.params.id);
  const msg = await pool.query('SELECT * FROM messages WHERE id = $1', [msgId]);
  if (!msg.rows[0]) return res.status(404).json({ error: 'not found' });
  if (msg.rows[0].from_user_id !== user.id) return res.status(403).json({ error: 'not yours' });
  await pool.query('DELETE FROM messages WHERE id = $1', [msgId]);
  const target = [...onlineUsers.values()].find(u => u.id === msg.rows[0].to_user_id);
  if (target) io.to(target.socketId).emit('message-deleted', { id: msgId });
  res.json({ ok: true });
});

app.get('/api/messages/:contactId', async (req, res) => {
  const user = await getUserByToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'not authorized' });
  const contactId = parseInt(req.params.contactId);
  await pool.query('UPDATE messages SET read_at = NOW() WHERE from_user_id = $1 AND to_user_id = $2 AND read_at IS NULL', [contactId, user.id]);
  const msgs = await pool.query(`SELECT m.id, m.text, m.from_user_id as fromId, m.created_at as time, m.read_at as readAt FROM messages m
    WHERE (m.from_user_id = $1 AND m.to_user_id = $2) OR (m.from_user_id = $3 AND m.to_user_id = $4)
    ORDER BY m.created_at ASC LIMIT 200`, [user.id, contactId, contactId, user.id]);
  res.json(msgs.rows);
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.headers?.authorization || socket.handshake.query?.token;
  if (!token) return next(new Error('no token'));
  const user = await getUserByToken(token);
  if (!user) return next(new Error('invalid token'));
  socket.user = user;
  socket.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, { id: socket.userId, username: socket.user.username, color: socket.user.color, socketId: socket.id });
  broadcastContacts();

  const since = lastOnline.get(socket.userId) || 0;
  if (since) {
    pool.query(`SELECT m.text, m.from_user_id as fromId, m.created_at as time FROM messages m
      WHERE m.to_user_id = $1 AND m.created_at > to_timestamp($2)
      ORDER BY m.created_at ASC`, [socket.userId, since / 1000]).then(result => {
      for (const msg of result.rows) {
        socket.emit('private-message', msg);
      }
    }).catch(() => {});
  }

  socket.on('private-message', ({ toUserId, text }) => {
    if (!text || !text.trim()) return;
    text = text.trim().slice(0, 500);
    pool.query('INSERT INTO messages (from_user_id, to_user_id, text) VALUES ($1, $2, $3) RETURNING id', [socket.userId, toUserId, text]).then(result => {
      const msg = { id: result.rows[0].id, fromId: socket.userId, text, time: new Date().toISOString(), readAt: null };
      const target = [...onlineUsers.values()].find(u => u.id === toUserId);
      if (target) {
        io.to(target.socketId).emit('private-message', msg);
        pool.query('SELECT COUNT(*) as c FROM messages WHERE from_user_id = $1 AND to_user_id = $2 AND read_at IS NULL', [socket.userId, toUserId]).then(r => {
          io.to(target.socketId).emit('unread-update', { fromUserId: socket.userId, count: parseInt(r.rows[0].c) });
        }).catch(() => {});
      }
      socket.emit('private-message', msg);
    }).catch(() => {});
  });

  socket.on('mark-read', ({ fromUserId }) => {
    pool.query('UPDATE messages SET read_at = NOW() WHERE from_user_id = $1 AND to_user_id = $2 AND read_at IS NULL', [fromUserId, socket.userId]).then(() => {
      pool.query('SELECT COUNT(*) as c FROM messages WHERE from_user_id = $1 AND to_user_id = $2 AND read_at IS NULL', [fromUserId, socket.userId]).then(r => {
        socket.emit('unread-update', { fromUserId, count: parseInt(r.rows[0].c) });
      }).catch(() => {});
    }).catch(() => {});
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

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ViChat on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
