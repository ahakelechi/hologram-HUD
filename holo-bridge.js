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

function log(msg) {
  const t = new Date().toLocaleTimeString();
  process.stdout.write('[' + t + '] ' + msg + '\n');
}

// --- HTTP: health, and a POST hook so anything can push text -------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, port: PORT }));
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
  socket.on('data', makeFrameReader((text) => {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg && msg.type === 'reply') log('<- reply: ' + JSON.stringify(msg.text));
  }, drop));
  socket.on('error', drop);
  socket.on('close', drop);
});

server.listen(PORT, HOST, () => {
  log('holo-bridge listening on ws://' + HOST + ':' + PORT);
  log('type a line to send it to the wallpaper, or:');
  log('  curl -X POST http://' + HOST + ':' + PORT + '/say -d "nexus what time is it"');
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
