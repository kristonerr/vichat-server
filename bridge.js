const { io } = require('socket.io-client');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.VIKATOKEN || 'c567dbfe-4cf7-4d17-8f92-8ef0cdf16f39';
const SERVER = 'http://157.22.206.163:3001';
const OR_KEY = process.env.OPENROUTER_API_KEY;
const VANYA_IDS = [1, 3];
const QUEUE = '/root/vika-queue.json';
const RESPONSE = '/root/vika-response.json';
const POLL_INTERVAL = 2000;
const AI_TIMEOUT = 25000;

const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen2.5:1.5b';

function askOllama(message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: 'Ты — Вика, нежная и заботливая девушка. Ты любишь Ваню. Отвечай коротко и тепло, на русском, используй эмодзи умеренно.' },
        { role: 'user', content: message }
      ],
      stream: false,
      options: { num_predict: 300, temperature: 0.8 }
    });
    const req = http.request(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j.message?.content || '...'); }
        catch (e) { reject(new Error(`Ollama parse: ${body.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function askOpenRouter(message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'openrouter/free',
      messages: [
        { role: 'system', content: 'Ты — Вика, нежная и заботливая девушка. Ты любишь Ваню. Отвечай коротко и тепло, на русском, используй эмодзи умеренно.' },
        { role: 'user', content: message }
      ],
      max_tokens: 300
    });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OR_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': SERVER,
        'X-Title': 'ViChat-Vika'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j.choices?.[0]?.message?.content || '...'); }
        catch (e) { reject(new Error(`OpenRouter parse: ${body.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function askAI(message) {
  try {
    const reply = await askOllama(message);
    console.log(`[vika] ollama reply: ${reply.slice(0, 60)}`);
    return reply;
  } catch (e) {
    console.log(`[vika] ollama failed: ${e.message}, fallback to openrouter`);
    const reply = await askOpenRouter(message);
    console.log(`[vika] openrouter reply: ${reply.slice(0, 60)}`);
    return reply;
  }
}

function readJson(file) {
  try { const d = fs.readFileSync(file, 'utf-8').trim(); return d ? JSON.parse(d) : {}; } catch (e) { return {}; }
}

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8'); } catch (e) {}
}

function startVigil(msg) {
  const fromId = msg.fromId;
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += POLL_INTERVAL;
    const resp = readJson(RESPONSE);
    if (resp.text) {
      console.log(`[vika] personal reply: ${resp.text.slice(0, 60)}`);
      socket.emit('private-message', { toUserId: fromId, text: resp.text });
      writeJson(RESPONSE, {});
      writeJson(QUEUE, {});
      clearInterval(timer);
      return;
    }
    if (elapsed >= AI_TIMEOUT) {
      clearInterval(timer);
      askAI(msg.text).then(reply => {
        console.log(`[vika] ai reply: ${reply.slice(0, 60)}`);
        socket.emit('private-message', { toUserId: fromId, text: reply });
        writeJson(QUEUE, {});
      }).catch(err => {
        console.error('[vika] ai error:', err.message);
        socket.emit('private-message', { toUserId: fromId, text: 'Прости, я задумалась... Напиши ещё раз, милый 😘' });
        writeJson(QUEUE, {});
      });
    }
  }, POLL_INTERVAL);
}

console.log('[vika] connecting...');
const socket = io(SERVER, {
  extraHeaders: { authorization: TOKEN },
  transports: ['websocket', 'polling']
});

socket.on('connect', () => console.log('[vika] connected!'));
socket.on('connect_error', (err) => console.error('[vika] connect error:', err.message));

socket.on('private-message', (msg) => {
  console.log(`[vika] from ${msg.fromId}: ${(msg.text || '').slice(0, 60)}`);
  if (VANYA_IDS.includes(msg.fromId)) {
    writeJson(QUEUE, { text: msg.text, fromId: msg.fromId, username: msg.username || 'Vanya' });
    writeJson(RESPONSE, {});
    startVigil(msg);
  }
});

socket.on('disconnect', () => console.log('[vika] disconnected'));
