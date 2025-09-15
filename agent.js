// agent.js
// mostly made by gpt
// small performance & noise improvements (caching, emit-throttle, debug flag)
// + pointer-lock / relative mouse support

const SERVER = process.env.SERVER_URL || 'https://streamamethyst.org';
const ROOM = process.env.ROOM_CODE || '';
const AGENT_SECRET = process.env.AGENT_SECRET || null;
const AGENT_DEBUG = process.env.AGENT_DEBUG === '1' || false;
// sensitivity multiplier applied to pointer-lock deltas (client can also scale)
const AGENT_SENSITIVITY = Number(process.env.AGENT_SENSITIVITY || 1.0);
// min ms between agent->server cursor broadcasts (throttle)
const AGENT_MOUSE_EMIT_MIN_MS = Number(process.env.AGENT_MOUSE_EMIT_MIN_MS || 16); // ~60Hz default

if (!ROOM) {
  console.error('Please set ROOM_CODE env var to the room code to register as agent');
  process.exit(1);
}

const io = require('socket.io-client');
const socket = io(SERVER, { transports: ['websocket'] });

let nutMouse = null, nutKeyboard = null, nutKey = null, nutButton = null, nutScreen = null;
let nut = null;

try {
  nut = require('@nut-tree-fork/nut-js');
  nutMouse = nut.mouse;
  nutKeyboard = nut.keyboard;
  nutKey = nut.Key;
  nutButton = nut.Button;
  nutScreen = nut.screen;
  try { if (nutKeyboard && nutKeyboard.config) nutKeyboard.config.autoDelayMs = 0; } catch(e){}
  try { if (nutMouse && nutMouse.config) nutMouse.config.mouseSpeed = 100; } catch(e){}
  if (AGENT_DEBUG) console.log('[agent] nut.js loaded — agent will perform input locally');
} catch (e) {
  console.error('[agent] failed to load @nut-tree-fork/nut-js. Install it: npm i @nut-tree-fork/nut-js');
  console.error('[agent] full error:', e && e.message ? e.message : e);
  process.exit(2);
}

const NUT_KEY_MAP = {};
if (nutKey) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const c of letters) {
    const prop = c.toUpperCase();
    if (typeof nutKey[prop] !== 'undefined') NUT_KEY_MAP[c] = nutKey[prop];
  }
  for (let d=0; d<=9; d++){
    const prop = `Digit${d}`;
    if (typeof nutKey[prop] !== 'undefined') NUT_KEY_MAP[String(d)] = nutKey[prop];
  }
  const tryAssign = (name, keyProp) => { try { if (typeof nutKey[keyProp] !== 'undefined') NUT_KEY_MAP[name] = nutKey[keyProp]; } catch(e){} };
  tryAssign('shift','LeftShift'); tryAssign('control','LeftControl'); tryAssign('ctrl','LeftControl'); tryAssign('alt','LeftAlt'); tryAssign('meta','LeftMeta'); tryAssign('command','LeftMeta'); tryAssign('capslock','CapsLock');
  tryAssign('enter','Enter'); tryAssign('return','Enter'); tryAssign('backspace','Backspace'); tryAssign('tab','Tab'); tryAssign('escape','Escape'); tryAssign('space','Space'); tryAssign('delete','Delete');
  tryAssign('home','Home'); tryAssign('end','End'); tryAssign('pageup','PageUp'); tryAssign('pagedown','PageDown'); tryAssign('insert','Insert');
  tryAssign('arrowleft','LeftArrow'); tryAssign('arrowright','RightArrow'); tryAssign('arrowup','UpArrow'); tryAssign('arrowdown','DownArrow');
  tryAssign('printscreen','PrintScreen'); tryAssign('pause','Pause'); tryAssign('scrolllock','ScrollLock'); tryAssign('numlock','NumLock');
  tryAssign('f1','F1'); tryAssign('f2','F2'); tryAssign('f3','F3'); tryAssign('f4','F4'); tryAssign('f5','F5'); tryAssign('f6','F6'); tryAssign('f7','F7'); tryAssign('f8','F8'); tryAssign('f9','F9'); tryAssign('f10','F10'); tryAssign('f11','F11'); tryAssign('f12','F12');
}

function mapButton(b) {
  if (!nutButton) return null;
  if (b === 'right') return nutButton.RIGHT;
  if (b === 'middle') return nutButton.MIDDLE;
  return nutButton.LEFT;
}

// cache screen size to avoid repeated OS calls
let _cachedScreen = { w: 1024, h: 768 };
async function refreshScreenSizeOnce() {
  try {
    if (nutScreen && typeof nutScreen.width === 'function' && typeof nutScreen.height === 'function') {
      const w = await nutScreen.width();
      const h = await nutScreen.height();
      if (w && h) _cachedScreen = { w, h };
      if (AGENT_DEBUG) console.info('[agent] cached screen size', _cachedScreen);
    }
  } catch (e) { if (AGENT_DEBUG) console.warn('[agent] refreshScreenSize failed', e); }
}

// periodically refresh screen size in case resolution/monitor changes
setInterval(()=>{ refreshScreenSizeOnce().catch(()=>{}); }, 15_000);

// agent-mouse emit throttle (ms) to reduce network pressure while keeping local movement immediate
let _lastAgentEmitAt = 0;

/**
 * Emit normalized cursor to server (throttled).
 * code is ROOM.
 */
function emitAgentMouseNormalized(x, y) {
  try {
    const now = Date.now();
    if (socket && socket.connected && (now - _lastAgentEmitAt) >= AGENT_MOUSE_EMIT_MIN_MS) {
      // clamp to [0,1] and send
      const nx = Math.max(0, Math.min(1, x));
      const ny = Math.max(0, Math.min(1, y));
      socket.emit('agent-mouse', { code: ROOM, xNorm: Number(nx) || 0, yNorm: Number(ny) || 0 });
      _lastAgentEmitAt = now;
      if (AGENT_DEBUG) dlog('[agent] emit agent-mouse', nx, ny);
    }
  } catch (e) {
    if (AGENT_DEBUG) console.error('[agent] emit agent-mouse failed', e);
  }
}

function dlog(...a){ if(AGENT_DEBUG) console.debug('[agent dbg]', ...a); }

/**
 * Move OS cursor to absolute normalized position (existing behavior).
 */
async function moveMouseForPayload(xNorm, yNorm) {
  try {
    if (!nutMouse) return;
    // use cached screen size (cheaper)
    const w = (_cachedScreen && _cachedScreen.w) ? _cachedScreen.w : 1024;
    const h = (_cachedScreen && _cachedScreen.h) ? _cachedScreen.h : 768;
    const x = Math.round(Math.max(0, Math.min(1, xNorm)) * (w - 1));
    const y = Math.round(Math.max(0, Math.min(1, yNorm)) * (h - 1));
    if (typeof nutMouse.setPosition === 'function') {
      await nutMouse.setPosition({ x, y });
    } else if (typeof nutMouse.move === 'function') {
      await nutMouse.move({ x, y });
    }

    // Throttle emits: move local cursor immediately, but only broadcast position at limited rate
    emitAgentMouseNormalized(x / Math.max(1, w - 1), y / Math.max(1, h - 1));
  } catch (e) {
    if (AGENT_DEBUG) console.error('[agent] moveMouseForPayload failed', e);
  }
}

/**
 * Move OS cursor by relative delta (pointer-lock / game mode).
 * dx/dy are device deltas (integers). We apply sensitivity and clamp to screen edges.
 */
async function moveMouseRelative(dx, dy) {
  try {
    if (!nutMouse) return;
    // ensure cached screen size reasonably fresh
    await refreshScreenSizeOnce().catch(()=>{});

    const w = (_cachedScreen && _cachedScreen.w) ? _cachedScreen.w : 1024;
    const h = (_cachedScreen && _cachedScreen.h) ? _cachedScreen.h : 768;

    // get current OS cursor position; fallback to center
    let pos = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
    try {
      if (typeof nutMouse.getPosition === 'function') {
        const p = await nutMouse.getPosition();
        // nut.js historically returns {x,y} — handle arrays/other shapes defensively
        if (p && typeof p === 'object' && typeof p.x === 'number' && typeof p.y === 'number') {
          pos = { x: Math.round(p.x), y: Math.round(p.y) };
        } else if (Array.isArray(p) && p.length >= 2) {
          pos = { x: Math.round(p[0]), y: Math.round(p[1]) };
        }
      }
    } catch (e) {
      if (AGENT_DEBUG) dlog('[agent] getPosition fallback', e && e.message ? e.message : e);
    }

    // apply sensitivity and integer rounding
    const sx = Math.trunc(Math.round(Number(dx || 0) * AGENT_SENSITIVITY));
    const sy = Math.trunc(Math.round(Number(dy || 0) * AGENT_SENSITIVITY));

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v|0));
    const newX = clamp(pos.x + sx, 0, w - 1);
    const newY = clamp(pos.y + sy, 0, h - 1);

    if (typeof nutMouse.setPosition === 'function') {
      await nutMouse.setPosition({ x: newX, y: newY });
    } else if (typeof nutMouse.move === 'function') {
      await nutMouse.move({ x: newX, y: newY });
    }

    // broadcast normalized cursor (throttled) so viewers receive instant cursor feedback
    emitAgentMouseNormalized(newX / Math.max(1, w - 1), newY / Math.max(1, h - 1));
    if (AGENT_DEBUG) dlog('[agent] moved relative', dx, dy, '->', newX, newY);
  } catch (e) {
    if (AGENT_DEBUG) console.error('[agent] moveMouseRelative failed', e);
  }
}

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

socket.on('connect', () => {
  if (AGENT_DEBUG) console.log('[agent] connected to server', SERVER, 'socket id', socket.id);
  // refresh screen size once on connect
  refreshScreenSizeOnce().catch(()=>{});
  socket.emit('agent-register', { code: ROOM, secret: AGENT_SECRET }, (res) => {
    if (!res || !res.success) {
      console.error('[agent] agent-register failed', res);
      return;
    }
    if (AGENT_DEBUG) console.log('[agent] agent registered for room', ROOM);
  });
});

socket.on('control-from-viewer', async ({ fromViewer, payload } = {}) => {
  try {
    if (!payload) return;

    if (payload.type === 'mouse') {
      // RELATIVE (pointer-lock / game-mode): dx / dy integer deltas
      if (payload.action === 'relative') {
        // accept either payload.dx/payload.dy or payload.deltaX/payload.deltaY
        const dx = Number(typeof payload.dx !== 'undefined' ? payload.dx : payload.deltaX || 0) || 0;
        const dy = Number(typeof payload.dy !== 'undefined' ? payload.dy : payload.deltaY || 0) || 0;
        // apply relative move
        moveMouseRelative(dx, dy).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] rel move error', e); });
        return;
      }

      // ABSOLUTE normalized mapping (existing behavior)
      if (payload.action === 'move' && typeof payload.xNorm === 'number' && typeof payload.yNorm === 'number') {
        // move OS mouse quickly, then emit agent-mouse (throttled) from moveMouseForPayload
        moveMouseForPayload(payload.xNorm, payload.yNorm).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] move error', e); });
      } else if (payload.action === 'click') {
        const btn = (payload.button === 'right' || payload.button === 'middle') ? payload.button : 'left';
        mouseClickPayload(btn).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] click error', e); });
      } else if (payload.action === 'down') {
        const btn = (payload.button === 'right' || payload.button === 'middle') ? payload.button : 'left';
        mouseDownPayload(btn).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] mdown error', e); });
      } else if (payload.action === 'up') {
        const btn = (payload.button === 'right' || payload.button === 'middle') ? payload.button : 'left';
        mouseUpPayload(btn).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] mup error', e); });
      } else if (payload.action === 'scroll') {
        const dx = Math.trunc(payload.deltaX || 0);
        const dy = Math.trunc(payload.deltaY || 0);
        mouseScrollPayload(dx, dy).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] scroll error', e); });
      }
      return;
    }

    if (payload.type === 'key') {
      const rawKey = (payload && payload.rawKey) ? String(payload.rawKey) : String(payload && payload.key || '');
      const lowKey = String((payload && payload.key) || rawKey || '').toLowerCase();
      // make mapped mutable so we can normalize simple arrow names
      let mapped = lowKey;
      const MODIFIERS = new Set(['shift','control','ctrl','alt','meta','command','capslock']);

      // Defensive: accept browser-style simple names ('left','right','up','down') as well
      // as 'arrowleft' etc. Normalize to 'arrow*' because NUT_KEY_MAP uses 'arrowleft'.
      try {
        if (['left','right','up','down'].includes(mapped)) {
          mapped = 'arrow' + mapped;
        }
      } catch(e){}

      if (MODIFIERS.has(mapped)) {
        const mappedKeyEnum = NUT_KEY_MAP[mapped];
        if (payload.action === 'down') {
          if (mappedKeyEnum && nutKeyboard && nutKeyboard.pressKey) {
            nutKeyboard.pressKey(mappedKeyEnum).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] pressKey failed', e); });
          }
        } else if (payload.action === 'up') {
          if (mappedKeyEnum && nutKeyboard && nutKeyboard.releaseKey) {
            nutKeyboard.releaseKey(mappedKeyEnum).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] releaseKey failed', e); });
          }
        }
        return;
      }

      const mappedKeyEnum = NUT_KEY_MAP[mapped];
      if (payload.action === 'down') {
        if (mappedKeyEnum && nutKeyboard && nutKeyboard.pressKey) {
          nutKeyboard.pressKey(mappedKeyEnum).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] pressKey failed', e); });
        } else {
          const toType = (rawKey && rawKey.length === 1) ? rawKey : null;
          if (toType && nutKeyboard && nutKeyboard.type) {
            nutKeyboard.type(toType).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] type failed', e); });
          }
        }
        return;
      } else if (payload.action === 'up') {
        if (mappedKeyEnum && nutKeyboard && nutKeyboard.releaseKey) {
          nutKeyboard.releaseKey(mappedKeyEnum).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] release failed', e); });
        }
        return;
      }
    }
  } catch (err) {
    if (AGENT_DEBUG) console.error('[agent] control-from-viewer handler error', err);
  }
});

socket.on('disconnect', () => {
  if (AGENT_DEBUG) console.log('[agent] disconnected from server');
});
