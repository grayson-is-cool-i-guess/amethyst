// agent.js - updated to respond to control-binary and emit agent-mouse immediately
const SERVER = process.env.SERVER_URL || 'http://localhost:3000';
const ROOM = process.env.ROOM_CODE || '';
const AGENT_SECRET = process.env.AGENT_SECRET || null;
const AGENT_DEBUG = process.env.AGENT_DEBUG === '1' || false;
const AGENT_SENSITIVITY = Number(process.env.AGENT_SENSITIVITY || 1.0);
const AGENT_MOUSE_EMIT_MIN_MS = Number(process.env.AGENT_MOUSE_EMIT_MIN_MS || 8);

if (!ROOM) {
  console.error('Please set ROOM_CODE env var to the room code to register as agent');
  process.exit(1);
}

const io = require('socket.io-client');
const socket = io(SERVER, { transports: ['websocket'] });

let nut = null, nutMouse = null, nutKeyboard = null, nutKey = null, nutButton = null, nutScreen = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nutMouse = nut.mouse;
  nutKeyboard = nut.keyboard;
  nutKey = nut.Key;
  nutButton = nut.Button;
  nutScreen = nut.screen;
  try { if (nutKeyboard && nutKeyboard.config) nutKeyboard.config.autoDelayMs = 0; } catch(e){}
  try { if (nutMouse && nutMouse.config) nutMouse.config.mouseSpeed = 100; } catch(e){}
  if (AGENT_DEBUG) console.log('[agent] nut.js loaded');
} catch (e) {
  console.error('[agent] failed to load @nut-tree-fork/nut-js. Install it: npm i @nut-tree-fork/nut-js');
  console.error('[agent] full error:', e && e.message ? e.message : e);
  process.exit(2);
}

let _cachedScreen = { w: 1024, h: 768 };
async function refreshScreenSizeOnce(){
  try{
    if(nutScreen && typeof nutScreen.width === 'function'){
      const w = await nutScreen.width();
      const h = await nutScreen.height();
      if(w && h) _cachedScreen = { w,h };
      if(AGENT_DEBUG) console.log('[agent] screen', _cachedScreen);
    }
  } catch(e){ if(AGENT_DEBUG) console.warn(e); }
}
setInterval(()=> refreshScreenSizeOnce().catch(()=>{}), 15_000);

let lastProgrammaticMove = 0;
let lastAgentEmitAt = 0;

// emit back to server quickly (non-blocking)
function emitAgentMouseNormalized(x, y){
  try {
    const now = Date.now();
    if (socket && socket.connected && (now - lastAgentEmitAt) >= AGENT_MOUSE_EMIT_MIN_MS) {
      const nx = Math.max(0, Math.min(1, x));
      const ny = Math.max(0, Math.min(1, y));
      socket.emit('agent-mouse', { code: ROOM, xNorm: Number(nx) || 0, yNorm: Number(ny) || 0 });
      lastAgentEmitAt = now;
      if (AGENT_DEBUG) console.debug('[agent] emit agent-mouse', nx, ny);
    }
  } catch (e) {
    if (AGENT_DEBUG) console.error('[agent] emitAgentMouseNormalized fail', e);
  }
}

// non-blocking move helper: compute and emit first, then apply OS move asynchronously
async function applyAbsoluteMoveNonBlocking(xNorm, yNorm){
  try {
    // compute int pixel coordinates from normalized values
    await refreshScreenSizeOnce().catch(()=>{});
    const w = (_cachedScreen && _cachedScreen.w) ? _cachedScreen.w : 1024;
    const h = (_cachedScreen && _cachedScreen.h) ? _cachedScreen.h : 768;
    const newX = Math.round(Math.max(0, Math.min(1, xNorm)) * (w - 1));
    const newY = Math.round(Math.max(0, Math.min(1, yNorm)) * (h - 1));

    // Immediately tell server/viewers about the new position so they see cursor update
    emitAgentMouseNormalized(newX / Math.max(1, w-1), newY / Math.max(1, h-1));
    lastProgrammaticMove = Date.now();

    // now apply to OS, but don't block or await in caller; do it here asynchronously
    (async ()=>{
      try {
        if (!nutMouse) return;
        if (typeof nutMouse.setPosition === 'function') {
          await nutMouse.setPosition({ x: newX, y: newY });
        } else if (typeof nutMouse.move === 'function') {
          await nutMouse.move({ x: newX, y: newY });
        }
        // after actual OS move, optionally emit again to confirm
        emitAgentMouseNormalized(newX / Math.max(1, w-1), newY / Math.max(1, h-1));
      } catch (e) {
        if (AGENT_DEBUG) console.error('[agent] applyAbsoluteMoveNonBlocking: OS move error', e);
      }
    })();
  } catch (e) {
    if (AGENT_DEBUG) console.error('[agent] applyAbsoluteMoveNonBlocking failed', e);
  }
}

// relative move queue accumulator to avoid many slow OS calls; we still emit the net effect immediately
let relAccum = { x:0, y:0 };
let relFlushScheduled = false;
function scheduleRelFlush(){
  if(relFlushScheduled) return;
  relFlushScheduled = true;
  setTimeout(()=> {
    relFlushScheduled = false;
    // compute target absolute position from current cached pos
    (async ()=>{
      try {
        await refreshScreenSizeOnce().catch(()=>{});
        const w = (_cachedScreen && _cachedScreen.w) ? _cachedScreen.w : 1024;
        const h = (_cachedScreen && _cachedScreen.h) ? _cachedScreen.h : 768;
        // obtain current pointer pos if nut.mouse.getPosition exists
        let cur = { x: Math.floor(w/2), y: Math.floor(h/2) };
        try {
          if (nutMouse && typeof nutMouse.getPosition === 'function') {
            const p = await nutMouse.getPosition();
            if (p && typeof p === 'object' && typeof p.x === 'number' && typeof p.y === 'number') cur = { x: Math.round(p.x), y: Math.round(p.y) };
            else if (Array.isArray(p) && p.length >= 2) cur = { x: Math.round(p[0]), y: Math.round(p[1]) };
          }
        } catch(e){}

        // apply accumulated delta
        const dx = Math.round(relAccum.x * AGENT_SENSITIVITY);
        const dy = Math.round(relAccum.y * AGENT_SENSITIVITY);
        relAccum.x = 0; relAccum.y = 0;

        const newX = Math.max(0, Math.min(w-1, cur.x + dx));
        const newY = Math.max(0, Math.min(h-1, cur.y + dy));
        // emit immediate net effect
        emitAgentMouseNormalized(newX / Math.max(1, w-1), newY / Math.max(1, h-1));
        lastProgrammaticMove = Date.now();

        // apply OS move asynchronously
        (async ()=>{
          try {
            if (!nutMouse) return;
            if (typeof nutMouse.setPosition === 'function') {
              await nutMouse.setPosition({ x: newX, y: newY });
            } else if (typeof nutMouse.move === 'function') {
              await nutMouse.move({ x: newX, y: newY });
            }
            // optionally emit confirmation
            emitAgentMouseNormalized(newX / Math.max(1, w-1), newY / Math.max(1, h-1));
          } catch(e){
            if (AGENT_DEBUG) console.error('[agent] relFlush OS move failed', e);
          }
        })();

      } catch(e){ if (AGENT_DEBUG) console.error('[agent] scheduleRelFlush error', e); }
    })();
  }, 6); // 6ms coalescing window — tuned for low latency but reduces OS call pressure
}

// perform a relative movement immediately (accumulate + schedule flush)
// dx/dy are signed ints (pixels)
function acceptRelativeMove(dx, dy){
  try {
    relAccum.x += Number(dx || 0);
    relAccum.y += Number(dy || 0);
    // if accumulation would produce no-op, skip
    if(!relFlushScheduled) scheduleRelFlush();
    // do not await; UI will receive agent-mouse emitted by scheduleRelFlush
  } catch (e) { if (AGENT_DEBUG) console.error('[agent] acceptRelativeMove', e); }
}

// Previous JSON control handler preserved
socket.on('control-from-viewer', async ({ fromViewer, payload } = {}) => {
  try {
    if (!payload) return;
    if (payload.type === 'mouse') {
      if (payload.action === 'relative') {
        const dx = Number(payload.dx || 0) || 0;
        const dy = Number(payload.dy || 0) || 0;
        acceptRelativeMove(dx, dy);
        return;
      }
      if (payload.action === 'move' && typeof payload.xNorm === 'number' && typeof payload.yNorm === 'number') {
        applyAbsoluteMoveNonBlocking(payload.xNorm, payload.yNorm).catch(()=>{});
      } else if (payload.action === 'click') {
        // handle clicks
        const btn = (payload.button === 'right' || payload.button === 'middle') ? payload.button : 'left';
        mouseClickPayload(btn).catch(()=>{});
      } else if (payload.action === 'down') {
        const btn = (payload.button === 'right' || payload.button === 'middle') ? payload.button : 'left';
        mouseDownPayload(btn).catch(()=>{});
      } else if (payload.action === 'up') {
        const btn = (payload.button === 'right' || payload.button === 'middle') ? payload.button : 'left';
        mouseUpPayload(btn).catch(()=>{});
      } else if (payload.action === 'scroll') {
        const dx = Math.trunc(payload.deltaX || 0);
        const dy = Math.trunc(payload.deltaY || 0);
        mouseScrollPayload(dx, dy).catch(()=>{});
      }
      return;
    }
    // keys...
  } catch (err) {
    if (AGENT_DEBUG) console.error('[agent] control-from-viewer handler error', err);
  }
});

// ---------- NEW: binary control path for low-latency relative deltas ----------
socket.on('control-binary', (buf) => {
  try {
    // expect ArrayBuffer / Buffer / Uint8Array
    const ab = (buf && buf.buffer) ? buf.buffer : buf;
    const dv = new DataView(ab);
    const typ = dv.getUint8(0);
    if (typ === 1) {
      const dx = dv.getInt16(1);
      const dy = dv.getInt16(3);
      // accept relative move (coalesced)
      acceptRelativeMove(dx, dy);
    } else {
      // unknown type — ignore or extend as needed
      if (AGENT_DEBUG) console.warn('[agent] unknown control-binary type', typ);
    }
  } catch (e) {
    if (AGENT_DEBUG) console.error('[agent] control-binary handler error', e);
  }
});

// Keep your existing mouse-click/press helpers and keyboard mapping (as you had)
// Minimal implementations below — you already had these in your agent; ensure they remain:

async function mouseClickPayload(buttonName) {
  try {
    if (!nutMouse) return;
    const b = mapButton(buttonName);
    if (b === nutButton.LEFT && typeof nutMouse.leftClick === 'function') return nutMouse.leftClick();
    if (b === nutButton.RIGHT && typeof nutMouse.rightClick === 'function') return nutMouse.rightClick();
    if (typeof nutMouse.click === 'function') return nutMouse.click(b);
    if (typeof nutMouse.pressButton === 'function') {
      await nutMouse.pressButton(b);
      await nutMouse.releaseButton(b);
    }
  } catch (e) { if (AGENT_DEBUG) console.error('[agent] mouseClick failed', e); }
}
async function mouseDownPayload(buttonName) {
  try { if (!nutMouse) return; const b = mapButton(buttonName); if (typeof nutMouse.pressButton === 'function') await nutMouse.pressButton(b); } catch (e) { if (AGENT_DEBUG) console.error('[agent] mouseDown failed', e); }
}
async function mouseUpPayload(buttonName) {
  try { if (!nutMouse) return; const b = mapButton(buttonName); if (typeof nutMouse.releaseButton === 'function') await nutMouse.releaseButton(b); } catch (e) { if (AGENT_DEBUG) console.error('[agent] mouseUp failed', e); }
}
async function mouseScrollPayload(dx, dy) {
  try {
    if (!nutMouse) return;
    dx = Math.trunc(dx || 0);
    dy = Math.trunc(dy || 0);
    if (Math.abs(dy) >= Math.abs(dx)) {
      if (dy > 0 && typeof nutMouse.scrollDown === 'function') return nutMouse.scrollDown(Math.abs(dy));
      if (dy < 0 && typeof nutMouse.scrollUp === 'function') return nutMouse.scrollUp(Math.abs(dy));
    } else {
      if (dx > 0 && typeof nutMouse.scrollRight === 'function') return nutMouse.scrollRight(Math.abs(dx));
      if (dx < 0 && typeof nutMouse.scrollLeft === 'function') return nutMouse.scrollLeft(Math.abs(dx));
    }
  } catch (e) { if (AGENT_DEBUG) console.error('[agent] mouseScroll failed', e); }
}

function mapButton(b) {
  if (!nutButton) return null;
  if (b === 'right') return nutButton.RIGHT;
  if (b === 'middle') return nutButton.MIDDLE;
  return nutButton.LEFT;
}

// Agent register logic (based on your original with retry/backoff) — keep unchanged behavior
let _registered = false;
function _doRegister(){
  if (_registered) return;
  try {
    socket.emit('agent-register', { code: ROOM, secret: AGENT_SECRET }, (res) => {
      if (res && res.success) {
        _registered = true;
        if (AGENT_DEBUG) console.log('[agent] registered for room', ROOM);
        return;
      }
      // schedule retry with exponential backoff on failure (omitted here for brevity in this paste; keep your existing logic)
      setTimeout(()=> _doRegister(), 2000);
    });
  } catch (e) {
    setTimeout(()=> _doRegister(), 2000);
  }
}

socket.on('connect', ()=> {
  refreshScreenSizeOnce().catch(()=>{});
  if (!_registered) _doRegister();
});
