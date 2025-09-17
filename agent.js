// server.js - low-latency tuned, socket.io-based (patched: safer sends / backpressure checks + adaptive throttling)
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { EventEmitter, once } = require('events');
require('events').EventEmitter.defaultMaxListeners = 50;

const app = express();
const server = http.createServer(app);

// Optional msgpack parser (must match client)
let customParser = null;
try {
  if (process.env.USE_MSGPACK === '1') {
    customParser = require('socket.io-msgpack-parser');
    console.log('[server] msgpack parser loaded');
  }
} catch (e) {
  customParser = null;
  console.warn('[server] USE_MSGPACK=1 but socket.io-msgpack-parser failed to load:', e && e.message);
}

// Tunables (env override)
const BROADCASTER_MS = Number(process.env.BROADCASTER_MS) || 2;   // base ms when sleeping
const MIN_IMMEDIATE_MS = Number(process.env.MIN_IMMEDIATE_MS) || 2; // guard between immediate flushes
const MAX_FRAME_SIZE = Number(process.env.MAX_FRAME_SIZE) || (12 * 1024 * 1024); // 12MB
const MAX_HTTP_BUFFER_SIZE = Number(process.env.MAX_HTTP_BUFFER_SIZE) || (50 * 1024 * 1024);

// New tunables to reduce bursts / backpressure issues
const MAX_SENDS_PER_SEC = Number(process.env.MAX_SENDS_PER_SEC) || 45; // max emits per room per second (lowered)
const SOCKET_WRITABLE_THRESHOLD = Number(process.env.SOCKET_WRITABLE_THRESHOLD) || (512 * 1024); // 512KB buffered amount (lowered)
const ROOM_BACKLOG_SKIP_MS = Number(process.env.ROOM_BACKLOG_SKIP_MS) || 80; // when backlog observed, increase room wait

// Keep rooms alive even if host/agent disconnects or host-stop is called.
const PERSIST_ROOMS = true;

const serverOpts = {
  maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
  perMessageDeflate: false,
};

const io = new Server(server, serverOpts);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
const rooms = new Map(); // code -> { hostSocketId, viewerSockets: Set, ... }

// Helper: convert various buffer-like types into a Node Buffer
function toBuffer(buf) {
  try {
    if (!buf) return null;
    if (Buffer.isBuffer(buf)) return buf;
    if (buf instanceof ArrayBuffer) return Buffer.from(new Uint8Array(buf));
    if (buf instanceof Uint8Array) return Buffer.from(buf);
    if (buf && buf.data && Array.isArray(buf.data)) return Buffer.from(buf.data);
    if (buf && typeof buf === 'object' && buf.buffer && buf.byteLength) return Buffer.from(new Uint8Array(buf.buffer));
    return null;
  } catch (e) { return null; }
}

// Helper: can we send now? (per-room rate limiter)
function canSendNow(r) {
  try {
    if (!r) return false;
    const now = Date.now();
    r._recentSends = r._recentSends || [];
    // trim older than 1000ms
    while (r._recentSends.length && r._recentSends[0] < now - 1000) r._recentSends.shift();
    if (r._recentSends.length >= MAX_SENDS_PER_SEC) return false;
    return true;
  } catch (e) { return true; }
}

// Helper: detect if any viewer socket is backlogged (bufferedAmount above threshold)
function anyViewerBacklogged(r) {
  try {
    if (!r || !r.viewerSockets || r.viewerSockets.size === 0) return false;
    for (const id of r.viewerSockets) {
      const sock = io.sockets.sockets.get(id);
      if (!sock) continue;
      // socket._payloadBufferedAmount is not public on all transports; check ws bufferedAmount if present
      try {
        if (sock.conn && sock.conn.transport && sock.conn.transport.ws && sock.conn.transport.ws.bufferedAmount !== undefined) {
          const ba = sock.conn.transport.ws.bufferedAmount;
          if (ba > SOCKET_WRITABLE_THRESHOLD) return true;
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) {}
  return false;
}

// Helper: safe per-socket emit (skip viewers whose socket is backlogged)
function emitToRoomSafe(code, event, ...args) {
  const r = rooms.get(code);
  if (!r || !r.viewerSockets || r.viewerSockets.size === 0) return;
  try {
    const now = Date.now();
    r._recentSends = r._recentSends || [];

    // Trim recent sends for bookkeeping
    while (r._recentSends.length && r._recentSends[0] < now - 1000) r._recentSends.shift();

    // If we're allowed and no viewers are backlogged, use fast room emit
    if (canSendNow(r) && !anyViewerBacklogged(r)) {
      try {
        // if the latest frame is the *same Buffer reference* we previously sent, skip (reduces redundant emits)
        try { if (r._lastSentRef && args && args[1] && args[1] === r._lastSentRef) { return; } } catch(e){}
        // use volatile so kernel/transport may drop under stress (best-effort)
        io.to(code).volatile.emit(event, ...args);
        r._recentSends.push(now);
        try{ if(args && args[1]) r._lastSentRef = args[1]; }catch(e){}
        return;
      } catch(e){
        // fall through to per-socket emission if the room emit fails for some reason
      }
    }

    // Otherwise, iterate per-socket and only send to sockets that are not backed up.
    for (const viewerId of Array.from(r.viewerSockets)) {
      try {
        const sock = io.sockets.sockets.get(viewerId);
        if (!sock) { r.viewerSockets.delete(viewerId); continue; }

        // try to detect buffered amount for the underlying ws
        try {
          const ws = sock.conn && sock.conn.transport && sock.conn.transport.ws;
          if (ws && ws.bufferedAmount !== undefined && ws.bufferedAmount > SOCKET_WRITABLE_THRESHOLD) {
            // skip this socket
            continue;
          }
        } catch (e) { /* ignore */ }

        // finally send
        const sendArgs = args;
        sock.emit(event, ...sendArgs);
        r._recentSends.push(now);
        try{ if(sendArgs && sendArgs[1]) r._lastSentRef = sendArgs[1]; }catch(e){}
      } catch (e) {
        // ignore per-socket errors
      }
    }
  } catch (e) {
    // ignore
  }
}

// Immediate flush — best-effort, volatile emit
function flushImmediateFrame(code) {
  try {
    const r = rooms.get(code);
    if (!r) return;
    const now = Date.now();
    if (r._lastImmediateAt && (now - r._lastImmediateAt) < MIN_IMMEDIATE_MS) return;
    r._lastImmediateAt = now;

    if (!canSendNow(r)) {
      // skip immediate flush to avoid exceeding per-room rate
      return;
    }

    // Best effort via volatile
    try {
      io.to(code).volatile.emit('flush');
      r._recentSends.push(now);
    } catch (e) {}
  } catch (e) {}
}

// Basic socket handling
io.on('connection', (socket) => {
  // socket listeners omitted for brevity — standard room/host/viewer flow.
  socket.on('join-room', (code) => {
    if (!rooms.has(code)) {
      rooms.set(code, { viewerSockets: new Set(), seq: 0, _recentSends: [] });
    }
    const r = rooms.get(code);
    r.viewerSockets.add(socket.id);
    socket.join(code);
  });

  socket.on('leave-room', (code) => {
    const r = rooms.get(code);
    if (r && r.viewerSockets) r.viewerSockets.delete(socket.id);
    try { socket.leave(code); } catch (e) {}
  });

  // frame relay from host -> viewers
  socket.on('frame', (meta, frameBuf) => {
    try {
      const code = meta && meta.code;
      if (!code) return;
      const r = rooms.get(code);
      if (!r) return;
      // guard frame size
      try {
        const b = toBuffer(frameBuf);
        if (!b) return;
        if (b.length > MAX_FRAME_SIZE) {
          return;
        }
        // attach seq & metadata on the server side if desired
        const metaOut = Object.assign({ seq: ++r.seq }, meta || {});
        emitToRoomSafe(code, 'frame', metaOut, b);
      } catch (e) {}
    } catch (e) {}
  });

  // request-keyframe relay
  socket.on('request-keyframe', (p) => {
    try {
      const r = rooms.get(p.code);
      if (r && r.hostSocketId) {
        const hostSock = io.sockets.sockets.get(r.hostSocketId);
        if (hostSock) hostSock.emit('request-keyframe', p);
      }
    } catch (e) {}
  });

  // cleanup
  socket.on('disconnect', () => {
    try {
      for (const [code, r] of rooms.entries()) {
        if (r.hostSocketId === socket.id) {
          // host disconnected
          r.hostSocketId = null;
          if (!PERSIST_ROOMS) rooms.delete(code);
        }
        if (r.viewerSockets) r.viewerSockets.delete(socket.id);
      }
    } catch (e) {}
  });

});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});
