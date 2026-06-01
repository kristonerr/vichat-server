const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'vica-pg',
  port: 5432,
  user: 'vica',
  password: 'vica_pass',
  database: 'vica',
});

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255),
    password_hash VARCHAR(255) NOT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '#667eea',
    created_at TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, contact_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    read_at TIMESTAMP
  )`);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_user_id, to_user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(to_user_id, from_user_id, read_at)');
}

module.exports = { pool, initDB };
