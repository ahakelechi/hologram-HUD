#!/usr/bin/env node
// HOLO // NEXUS — local voice bridge.
//
// Why this exists: inside Wallpaper Engine the wallpaper can open the
// microphone but cannot transcribe, because Chromium uploads audio to a
// speech backend and WE's embedded build ships without the keys to reach it.
// So the recognising happens out here instead, and the wallpaper is told what
// was said over a localhost socket.
//
// Deliberately dependency-free: `node holo-bridge.js` and nothing else. A
// wallpaper add-on that needs an npm install is an add-on nobody runs.
//
// Binds to 127.0.0.1 only. Anything that can talk to this can drive the
// wallpaper, so it must not be reachable from the network.
'use strict';
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.argv[2]) || 8787;
const HOST = '127.0.0.1';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const clients = new Set();

// --- minimal RFC6455 server, text frames only ---------------------------
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81;               // FIN + text opcode
  return Buffer.concat([header, payload]);
}

// Frames from a browser are always masked. This handles fragmentation across
// TCP reads by keeping a per-socket buffer, which a naive implementation gets
// wrong the moment a message spans two packets.
function makeFrameReader(onText, onClose) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (buf.length < off + 8) return; len = Number(buf.readBigUInt64BE(off)); off += 8; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 0x8) { onClose(); return; }
      if (opcode === 0x1) onText(payload.toString('utf8'));
      // pings/pongs/binary ignored: nothing here sends them
    }
  };
}

function broadcast(obj) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const sock of clients) {
    try { sock.write(frame); } catch (e) { clients.delete(sock); }
  }
  return clients.size;
}

function say(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const n = broadcast({ type: 'utterance', text: t });
  log('-> ' + JSON.stringify(t) + '  (' + n + ' client' + (n === 1 ? '' : 's') + ')');
  return n;
}

// The bridge is normally launched windowless, so console output alone means
// no record at all when something goes wrong. Everything also lands in a file
// next to the script.
const LOG_FILE = path.join(__dirname, 'holo-bridge.log');
try { require('fs').writeFileSync(LOG_FILE, '--- holo-bridge started ' + new Date().toISOString() + ' ---\n'); } catch (e) {}
function log(msg) {
  const t = new Date().toLocaleTimeString();
  const line = '[' + t + '] ' + msg + '\n';
  process.stdout.write(line);
  try { require('fs').appendFileSync(LOG_FILE, line); } catch (e) {}
}

// --- local LLM, via Ollama -----------------------------------------------
// Kept short and blunt on purpose: this is spoken aloud through
// text-to-speech, so a model that answers in paragraphs or markdown lists
// produces several sentences of silence while it is read out, or a bullet
// list read as a wall of dashes.
const LLM_SYSTEM_PROMPT = 'You are the voice of HOLO // NEXUS, an assistant '
  + 'embedded in a desktop hologram wallpaper. Your replies are read aloud by '
  + 'text-to-speech, so answer in one or two short spoken sentences - never a '
  + 'list, never markdown, never code unless directly asked to read code out. '
  + 'Be direct and a little dry. If asked to change something about the '
  + 'wallpaper itself, say the user can do that by naming it directly '
  + '(e.g. "switch to skull") rather than attempting it yourself.';
const LLM_TIMEOUT_MS = 25000;
function askOllama(messages, model, cb) {
  const body = JSON.stringify({ model: model || 'llama3.2:3b', messages, stream: false });
  const req = http.request({
    hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        // Ollama's own error body is plain text/JSON and usually says exactly
        // what is wrong (model not pulled, etc) - worth surfacing as-is.
        return cb(new Error('ollama ' + res.statusCode + ': ' + data.slice(0, 150)));
      }
      try {
        const j = JSON.parse(data);
        cb(null, (j.message && j.message.content || '').trim());
      } catch (e) { cb(new Error('bad response from ollama')); }
    });
  });
  req.on('error', (e) => {
    // ECONNREFUSED is the expected case when Ollama simply is not running,
    // and deserves a clearer message than the raw socket error.
    cb(e.code === 'ECONNREFUSED' ? new Error('Ollama is not running on 127.0.0.1:11434') : e);
  });
  req.setTimeout(LLM_TIMEOUT_MS, () => req.destroy(new Error('local model timed out')));
  req.write(body);
  req.end();
}

// --- the listener, owned by the bridge ----------------------------------
// A web page cannot start a process, so the wallpaper asks the bridge to do
// it. That means the bridge is the one thing that has to be running, and the
// microphone can then be turned on and off from the wallpaper's own UI
// instead of by hunting for a batch file.
let listener = null;
let listenModel = 'small';

function pythonExe() {
  // The bundled launcher path first, then whatever is on PATH.
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python310', 'python.exe')
    : null;
  return local && require('fs').existsSync(local) ? local : 'python';
}

function listenerStatus() {
  return { type: 'listen-status', running: !!listener, model: listenModel };
}

function startListener(model) {
  if (listener) return true;
  listenModel = model || listenModel;
  const script = path.join(__dirname, 'holo-listen.py');
  if (!require('fs').existsSync(script)) { log('holo-listen.py not found next to the bridge'); return false; }
  try {
    listener = spawn(pythonExe(), [script, '--model', listenModel, '--port', String(PORT)],
                     { cwd: __dirname, windowsHide: true });
  } catch (e) {
    log('could not start listener: ' + e.message);
    listener = null;
    return false;
  }
  log('listener started (' + listenModel + ')');
  // Its output is echoed here so there is still one place to watch, rather
  // than a hidden process failing silently.
  const echo = (buf) => String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) log('  listen| ' + l.trim()); });
  listener.stdout.on('data', echo);
  listener.stderr.on('data', echo);
  listener.on('exit', (code) => {
    log('listener stopped' + (code ? ' (exit ' + code + ')' : ''));
    listener = null;
    broadcast(listenerStatus());
  });
  broadcast(listenerStatus());
  return true;
}

function stopListener() {
  if (!listener) return;
  try { listener.kill(); } catch (e) {}
  listener = null;
  broadcast(listenerStatus());
}

// --- HTTP: health, and a POST hook so anything can push text -------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, port: PORT, listening: !!listener, model: listenModel }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/listen/start' || req.url === '/listen/stop')) {
    const on = req.url.endsWith('start');
    const ok = on ? startListener() : (stopListener(), true);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: ok, listening: !!listener }));
    return;
  }
  if (req.method === 'POST' && req.url === '/mic') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        broadcast({ type: 'mic', level: +j.level || 0, state: String(j.state || ''), gate: +j.gate || 0 });
      } catch (e) {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/say') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let text = body;
      try { const j = JSON.parse(body); if (j && j.text) text = j.text; } catch (e) {}
      const n = say(text);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered: n }));
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  clients.add(socket);
  log('client connected  (' + clients.size + ' total)');
  try { socket.write(encodeFrame(JSON.stringify({ type: 'hello', from: 'holo-bridge' }))); } catch (e) {}

  const drop = () => {
    if (clients.delete(socket)) log('client disconnected  (' + clients.size + ' left)');
    try { socket.destroy(); } catch (e) {}
  };
  try { socket.write(encodeFrame(JSON.stringify(listenerStatus()))); } catch (e) {}
  socket.on('data', makeFrameReader((text) => {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === 'reply') log('<- reply: ' + JSON.stringify(msg.text));
    // The wallpaper's microphone button arrives here.
    else if (msg.type === 'listen') {
      if (msg.on) startListener(msg.model); else stopListener();
    }
    else if (msg.type === 'status') {
      try { socket.write(encodeFrame(JSON.stringify(listenerStatus()))); } catch (e) {}
    }
    // Open-ended question the rule table had no answer for. Handled here
    // rather than fetched directly from the page: Ollama sends no CORS
    // headers, so a browser fetch to it — including from inside Wallpaper
    // Engine — would just be blocked. Node has no such restriction.
    else if (msg.type === 'ask') {
      const q = String(msg.text || '').trim();
      if (!q) return;
      const history = Array.isArray(msg.history) ? msg.history.slice(-10) : [];
      const messages = [{ role: 'system', content: LLM_SYSTEM_PROMPT }]
        .concat(history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '') })))
        .concat([{ role: 'user', content: q }]);
      log('ask: ' + JSON.stringify(q));
      askOllama(messages, msg.model, (err, text) => {
        if (err) {
          log('llm error: ' + err.message);
          try { socket.write(encodeFrame(JSON.stringify({ type: 'answer', text: '', error: err.message }))); } catch (e) {}
          return;
        }
        log('llm reply: ' + JSON.stringify(text));
        try { socket.write(encodeFrame(JSON.stringify({ type: 'answer', text }))); } catch (e) {}
      });
    }
  }, drop));
  socket.on('error', drop);
  socket.on('close', drop);
});

process.on('SIGINT', () => { stopListener(); process.exit(0); });
process.on('exit', () => { try { stopListener(); } catch (e) {} });

server.listen(PORT, HOST, () => {
  log('holo-bridge listening on ws://' + HOST + ':' + PORT);
  log('type a line to send it to the wallpaper, or:');
  log('  curl -X POST http://' + HOST + ':' + PORT + '/say -d "nexus what time is it"');
  log('the wallpaper can start the microphone itself - no need to run anything else');
  log('ctrl-c to stop');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log('port ' + PORT + ' is already in use — is a bridge already running?');
  else log('server error: ' + e.message);
  process.exit(1);
});

// stdin is the stand-in for a recogniser: it proves the whole pipe before any
// speech-to-text is wired in, and stays useful afterwards for testing.
if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => { if (line.trim()) say(line); });
}
