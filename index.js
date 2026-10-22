/**
 * NiceBot — WhatsApp bot service
 * Node.js + Express + Baileys, pairing-code linking, saved session.
 * Replies come from the command list saved in the NiceBot dashboard:
 * the service re-reads it every minute, so edits and on/off switches
 * on the Commands page reach WhatsApp without a restart.
 *
 *   npm install
 *   node index.js
 *
 * Optional environment variables:
 *   PORT=3001                 port to listen on
 *   OWNER_NUMBER=2347049397307 number shown by !menu and !owner
 *   BOT_TOKEN=secret          if set, every request needs the x-bot-token header
 *   AUTH_DIR=./auth_state     where the WhatsApp session is saved
 *   BASE44_APP_ID=...         this dashboard's app ID (baked in when you copy from the page)
 *   BASE44_API_TOKEN=...      read-only personal access token for the command list
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const OWNER_NUMBER = process.env.OWNER_NUMBER || '2347049397307';
const PORT = Number(process.env.PORT || 3001);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_state');
const LOG_FILE = path.join(__dirname, 'messages.json');
const APP_ID = process.env.BASE44_APP_ID || '8ada598c7b57f36e7986e4ad';
const API_TOKEN = process.env.BASE44_API_TOKEN || 'b44u_8de97fd78cdbb18baf4e57c47039c8d997c501a19b3f3c0af4722def92f86f4b';
const API_BASE = process.env.BASE44_API_BASE || 'https://app.base44.com';

const state = {
  status: 'disconnected',
  owner_number: OWNER_NUMBER,
  pairing_code: '',
  connected_at: null,
  error: '',
  commands: 0,
};

let sock = null;
let logs = [];
let restarting = false;
let commands = [];
let commandsLoadedAt = null;

function silentLogger() {
  const logger = {
    level: 'silent',
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
  };
  return logger;
}

function loadLogs() {
  try {
    logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')).slice(0, 500);
  } catch (error) {
    logs = [];
  }
}

function saveLogs() {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs.slice(0, 500), null, 2));
  } catch (error) {}
}

// Built-in fallbacks so the bot still answers if the dashboard is unreachable.
const EIGHT_BALL = [
  'It is certain.',
  'Without a doubt.',
  'Yes, definitely.',
  'You may rely on it.',
  'Most likely.',
  'Signs point to yes.',
  'Ask again later.',
  'Cannot predict now.',
  'Concentrate and ask again.',
  'Do not count on it.',
  'My reply is no.',
  'Very doubtful.',
];

const JOKES = [
  'Why did the developer go broke? Because he used up all his cache.',
  'I told my computer I needed a break, and it said no problem — it would go to sleep.',
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'A SQL query walks into a bar, walks up to two tables and asks: can I join you?',
];

const QUOTES = [
  'Discipline is choosing between what you want now and what you want most.',
  'Small steps every day build the results you want next year.',
  'Start where you are, use what you have, do what you can.',
  'You do not have to be great to start, but you have to start to be great.',
];

const DEFAULT_COMMANDS = [
  { trigger: '!menu', kind: 'menu', sample: '', title: 'Menu', description: 'this list' },
  { trigger: '!time', kind: 'time', sample: '', title: 'Time', description: 'Nigeria time (WAT)' },
  { trigger: '!ping', kind: 'static', sample: 'pong! Bot online ✅', title: 'Ping', description: 'bot status' },
  { trigger: '!owner', kind: 'static', sample: 'Owner is ' + OWNER_NUMBER, title: 'Owner', description: 'bot owner' },
  { trigger: '!joke', kind: 'joke', sample: '', title: 'Joke', description: 'a random joke' },
  { trigger: '!quote', kind: 'quote', sample: '', title: 'Quote', description: 'a motivational quote' },
  { trigger: '!8ball', kind: '8ball', sample: '', title: 'Magic 8-Ball', description: 'yes/no answer' },
  { trigger: '!calc', kind: 'calc', sample: '', title: 'Calculator', description: 'quick maths' },
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

async function fetchCommands() {
  const unconfigured =
    !APP_ID || !API_TOKEN || APP_ID.indexOf('__') === 0 || API_TOKEN.indexOf('__') === 0;
  if (unconfigured) {
    if (!commands.length) {
      console.log('No Base44 access configured yet — using the built-in command list.');
    }
    return;
  }
  try {
    const url = API_BASE + '/api/apps/' + APP_ID + '/entities/BotCommand?limit=200';
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + API_TOKEN },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    const rows = Array.isArray(data) ? data : (data && data.items) || [];
    const list = rows
      .filter((row) => row && row.trigger && row.enabled !== false)
      .map((row) => ({
        trigger: String(row.trigger).trim().toLowerCase(),
        kind: String(row.kind || 'static').trim().toLowerCase(),
        sample: String(row.sample || ''),
        title: String(row.title || ''),
        description: String(row.description || ''),
      }));
    if (list.length) {
      commands = list;
      commandsLoadedAt = new Date().toISOString();
      state.commands = commands.length;
      console.log('Commands synced from the dashboard: ' + commands.length + ' enabled.');
    }
  } catch (error) {
    console.error('Could not sync commands from the dashboard:', String((error && error.message) || error));
  }
}

function commandList() {
  return commands.length ? commands : DEFAULT_COMMANDS;
}

function menuFrom(list) {
  const lines = list.map((row) => {
    const base = row.trigger.split(/\s+/)[0];
    return base + ' — ' + (row.description || row.title || '');
  });
  return ['📋 *NiceBot Menu*', '']
    .concat(lines, ['', 'Owner: ' + OWNER_NUMBER])
    .join('\n');
}

function nigeriaTime() {
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'long',
  }).format(now);
  return '🕐 Nigeria time: ' + time + ' WAT (' + day + ')';
}

function evaluateMath(input) {
  const clean = String(input || '').replace(/[^0-9+\-*/%.()\s]/g, '');
  let pos = 0;
  const skip = () => {
    while (pos < clean.length && /\s/.test(clean[pos])) pos += 1;
  };
  const parseFactor = () => {
    skip();
    const char = clean[pos];
    if (char === '-') {
      pos += 1;
      return -parseFactor();
    }
    if (char === '(') {
      pos += 1;
      const value = parseExpression();
      skip();
      if (clean[pos] === ')') pos += 1;
      return value;
    }
    const start = pos;
    while (pos < clean.length && /[0-9.]/.test(clean[pos])) pos += 1;
    if (start === pos) throw new Error('invalid');
    return Number.parseFloat(clean.slice(start, pos));
  };
  const parseTerm = () => {
    let value = parseFactor();
    for (;;) {
      skip();
      const char = clean[pos];
      if (char === '*' || char === '/' || char === '%') {
        pos += 1;
        const next = parseFactor();
        if (next === 0 && (char === '/' || char === '%')) throw new Error('divide by zero');
        value = char === '*' ? value * next : char === '/' ? value / next : value % next;
      } else {
        return value;
      }
    }
  };
  const parseExpression = () => {
    let value = parseTerm();
    for (;;) {
      skip();
      const char = clean[pos];
      if (char === '+' || char === '-') {
        pos += 1;
        const next = parseTerm();
        value = char === '+' ? value + next : value - next;
      } else {
        return value;
      }
    }
  };
  const result = parseExpression();
  skip();
  if (pos < clean.length || !Number.isFinite(result)) throw new Error('invalid');
  return Math.round(result * 1e6) / 1e6;
}

async function randomJoke() {
  try {
    const response = await fetch('https://official-joke-api.appspot.com/random_joke');
    if (response.ok) {
      const data = await response.json();
      if (data && data.setup && data.punchline) return '😂 ' + data.setup + '\n\n' + data.punchline;
    }
  } catch (error) {}
  return '😂 ' + pick(JOKES);
}

async function randomQuote() {
  try {
    const response = await fetch('https://api.quotable.io/quotes/random?maxLength=140');
    if (response.ok) {
      const data = await response.json();
      const quote = Array.isArray(data) ? data[0] : data;
      if (quote && quote.content) {
        return '✨ "' + quote.content + '"' + (quote.author ? '\n— ' + quote.author : '');
      }
    }
  } catch (error) {}
  return '✨ "' + pick(QUOTES) + '"';
}

function extractText(message) {
  const content = (message && message.message) || {};
  return (
    content.conversation ||
    (content.extendedTextMessage && content.extendedTextMessage.text) ||
    (content.imageMessage && content.imageMessage.caption) ||
    (content.videoMessage && content.videoMessage.caption) ||
    ''
  );
}

// The auto-reply brain: matches the message against the commands in the
// dashboard database (or the built-in fallbacks) and builds the answer.
async function replyFor(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const trigger = raw.toLowerCase().split(/\s+/)[0];
  const list = commandList();
  const entry =
    list.find((row) => row.trigger === trigger) ||
    list.find((row) => row.trigger.split(/\s+/)[0] === trigger);
  if (!entry) {
    if (raw.charAt(0) === '!') {
      return '❓ Unknown command. Send !menu to see everything I can do.';
    }
    return null;
  }
  switch (entry.kind) {
    case 'menu':
      return menuFrom(list);
    case 'time':
      return nigeriaTime();
    case 'joke':
      return randomJoke();
    case 'quote':
      return randomQuote();
    case '8ball': {
      const question = raw.slice(trigger.length).trim();
      return '🎱 ' + pick(EIGHT_BALL) + (question ? '\n\n_' + question + '_' : '');
    }
    case 'calc': {
      const expression = raw.slice(trigger.length).trim();
      if (!expression) return '🧮 Send it like this: !calc 12 * 4 + 3';
      try {
        return '🧮 ' + expression + ' = ' + evaluateMath(expression);
      } catch (error) {
        return '🧮 I could not read that sum. Try !calc 12 * 4 + 3';
      }
    }
    default:
      if (entry.sample) return entry.sample;
      if (entry.description) return entry.description;
      return null;
  }
}

function scheduleRestart() {
  if (restarting) return;
  restarting = true;
  setTimeout(async () => {
    restarting = false;
    try {
      sock = null;
      await startSocket();
    } catch (error) {
      state.error = String((error && error.message) || error);
    }
  }, 4000);
}

async function startSocket() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: silentLogger(),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'connecting') state.status = 'connecting';
    if (update.connection === 'open') {
      state.status = 'connected';
      state.connected_at = new Date().toISOString();
      state.pairing_code = '';
      state.error = '';
      console.log('NiceBot is connected as ' + state.owner_number);
    }
    if (update.connection === 'close') {
      const disconnect = update.lastDisconnect || {};
      const statusCode =
        disconnect.error && disconnect.error.output ? disconnect.error.output.statusCode : undefined;
      state.status = 'disconnected';
      state.connected_at = null;
      if (statusCode === DisconnectReason.loggedOut) {
        state.error = 'This device was logged out of WhatsApp.';
        sock = null;
      } else {
        state.error = 'Connection closed — reconnecting…';
        scheduleRestart();
      }
    }
  });

  sock.ev.on('messages.upsert', async (payload) => {
    const messages = (payload && payload.messages) || [];
    for (const message of messages) {
      try {
        const jid = message.key && message.key.remoteJid;
        if (!jid || message.key.fromMe || jid === 'status@broadcast') continue;
        const text = extractText(message);
        if (!text) continue;
        const reply = await replyFor(text);
        if (!reply) continue;
        if (sock) await sock.sendMessage(jid, { text: reply });
        const trimmed = text.trim();
        logs.unshift({
          id: message.key.id,
          created_date: new Date().toISOString(),
          from_number: String(jid).split('@')[0].split(':')[0],
          from_name: message.pushName || '',
          message: text,
          reply: reply,
          command: trimmed.charAt(0) === '!' ? trimmed.toLowerCase().split(/\s+/)[0] : '',
        });
        logs = logs.slice(0, 500);
        saveLogs();
      } catch (error) {}
    }
  });

  return sock;
}

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (BOT_TOKEN && req.get('x-bot-token') !== BOT_TOKEN) {
    return res.status(401).json({ error: 'Bad bot token.' });
  }
  next();
});

app.get('/', (req, res) => {
  res.type('text').send('NiceBot service is running. Status: ' + state.status);
});

app.get('/api/status', (req, res) => {
  res.json(state);
});

app.get('/api/logs', (req, res) => {
  res.json(logs.slice(0, 200));
});

app.post('/api/pair', async (req, res) => {
  const number = String((req.body && req.body.number) || OWNER_NUMBER).replace(/\D/g, '');
  if (number.length < 10 || number.length > 15) {
    return res.status(400).json({ error: 'Enter the number in international format, digits only.' });
  }
  if (state.status === 'connected') {
    return res.status(409).json({ error: 'This device is already linked. Log out first.' });
  }
  try {
    if (!sock) await startSocket();
    state.owner_number = number;
    state.status = 'pairing';
    await new Promise((resolve) => setTimeout(resolve, 3000));
    let code;
    try {
      code = await sock.requestPairingCode(number);
    } catch (firstError) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      code = await sock.requestPairingCode(number);
    }
    const clean = String(code || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    state.pairing_code = clean.length === 8 ? clean.slice(0, 4) + '-' + clean.slice(4) : clean;
    state.error = '';
    console.log('Pairing code for ' + number + ': ' + state.pairing_code);
    res.json({ code: state.pairing_code, number: number, status: state.status });
  } catch (error) {
    state.status = 'disconnected';
    state.error = String((error && error.message) || error);
    res.status(500).json({ error: state.error });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (error) {}
      sock = null;
    }
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch (error) {}
    state.status = 'disconnected';
    state.connected_at = null;
    state.pairing_code = '';
    state.error = '';
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String((error && error.message) || error) });
  }
});

app.listen(PORT, () => {
  loadLogs();
  console.log('NiceBot service listening on http://localhost:' + PORT);
  fetchCommands();
  setInterval(fetchCommands, 60000);
  startSocket().catch((error) => {
    state.error = String((error && error.message) || error);
    console.error('Could not start the WhatsApp socket:', state.error);
  });
});
