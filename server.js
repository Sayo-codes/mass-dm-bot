const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { startMassDM, stopMassDM } = require('./automation');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

['session', 'public/debug'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}
global.broadcast = broadcast;

// ─────────────────────────────────────────────
// SAVE FULL COOKIES (important upgrade)
// ─────────────────────────────────────────────
app.post('/api/session/:id', (req, res) => {
  const { authToken, ct0, passcode, cookies } = req.body;

  const file = path.join(__dirname, 'session', `account${req.params.id}.json`);

  // Prefer full cookies array if provided
  if (Array.isArray(cookies) && cookies.length > 0) {
    fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
  } else {
    // Fallback to basic auth_token + ct0
    if (!authToken || !String(authToken).trim()) {
      return res.status(400).json({ error: 'auth_token or full cookies required' });
    }

    const basic = [
      {
        name: 'auth_token',
        value: String(authToken).trim(),
        domain: '.x.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
      }
    ];

    if (ct0 && String(ct0).trim()) {
      basic.push({
        name: 'ct0',
        value: String(ct0).trim(),
        domain: '.x.com',
        path: '/',
        secure: true,
        sameSite: 'Lax'
      });
    }

    fs.writeFileSync(file, JSON.stringify(basic, null, 2));
  }

  // Passcode
  const pinFile = path.join(__dirname, 'session', `account${req.params.id}_pin.txt`);
  if (passcode && String(passcode).trim()) {
    fs.writeFileSync(pinFile, String(passcode).trim());
  } else if (fs.existsSync(pinFile)) {
    fs.unlinkSync(pinFile);
  }

  res.json({ ok: true });
});

app.get('/api/session/:id/status', (req, res) => {
  const file = path.join(__dirname, 'session', `account${req.params.id}.json`);
  const pinFile = path.join(__dirname, 'session', `account${req.params.id}_pin.txt`);
  res.json({
    active: fs.existsSync(file),
    hasPin: fs.existsSync(pinFile)
  });
});

// ─────────────────────────────────────────────
// START MASS DM
// ─────────────────────────────────────────────
app.post('/api/mass-dm/start', (req, res) => {
  const {
    message,
    dailyLimit = 40,
    delaySeconds = 55,
    passcode = '',
    proxy = null
  } = req.body;

  if (!message) return res.status(400).json({ error: 'message required' });

  const accounts = [1, 2, 3]
    .map(id => {
      const cookiesPath = path.join(__dirname, 'session', `account${id}.json`);
      const pinFile = path.join(__dirname, 'session', `account${id}_pin.txt`);
      let accountPasscode = '';
      if (fs.existsSync(pinFile)) {
        accountPasscode = fs.readFileSync(pinFile, 'utf-8').trim();
      }
      return {
        cookiesPath,
        label: `Account ${id}`,
        passcode: accountPasscode
      };
    })
    .filter(a => fs.existsSync(a.cookiesPath));

  if (accounts.length === 0) {
    return res.status(400).json({ error: 'No accounts found. Add session first.' });
  }

  startMassDM(accounts, message, dailyLimit, delaySeconds, passcode, proxy)
    .catch(err => console.error(err));

  res.json({ ok: true, accounts: accounts.length });
});

app.post('/api/mass-dm/stop', (req, res) => {
  stopMassDM();
  res.json({ ok: true });
});

// Targets
app.get('/api/targets', (req, res) => {
  const file = path.join(__dirname, 'users_to_dm.txt');
  res.json({ content: fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '' });
});

app.post('/api/targets', (req, res) => {
  fs.writeFileSync(path.join(__dirname, 'users_to_dm.txt'), req.body.content || '');
  res.json({ ok: true });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', data: 'Connected' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nMass DM Bot running → http://localhost:${PORT}\n`);
});
