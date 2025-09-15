// agent.js
// improved: cache screen size, throttle mouse updates, use setPosition if available, minimal hot-path logging

const SERVER = process.env.SERVER_URL || 'https://streamamethyst.org';
const ROOM = process.env.ROOM_CODE || '';
const AGENT_SECRET = process.env.AGENT_SECRET || null;

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
  console.log('[agent] nut.js loaded — agent will perform input locally');
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

// Cached host screen values to avoid repeated system calls
let cachedScreen = { w: 1024, h: 768, lastAt: 0 };
async function refreshScreenCache() {
  try {
    if (!nutScreen) return;
    const now = Date.now();
    if (now - cachedScreen.lastAt < 2000) return;
    let w = 1024, h = 768;
    try { w = await nutScreen.width(); h = await nutScreen.height(); } catch(e){}
    cachedScreen.w = w || cachedScreen.w;
    cachedScreen.h = h || cachedScreen.h;
    cachedScreen.lastAt = now;
  } catch(e){}
}

async function moveMouseForPayload(xNorm, yNorm) {
  try {
    if (!nutMouse) return;
    await refreshScreenCache();
    const w = cachedScreen.w || 1024;
    const h = cachedScreen.h || 768;
    const x = Math.round(Math.max(0, Math.min(1, xNorm)) * (w - 1));
    const y = Math.round(Math.max(0, Math.min(1, yNorm)) * (h - 1));

    // Use setPosition if available (generally faster than move)
    if (typeof nutMouse.setPosition === 'function') {
      await nutMouse.setPosition({ x, y });
    } else if (typeof nutMouse.move === 'function') {
      await nutMouse.move({ x, y });
    }

    // Immediately inform server/viewers of the new cursor position so viewers can render it locally
    try {
      if (socket && socket.connected) {
        socket.emit('agent-mouse', { code: ROOM, xNorm: Number(xNorm) || 0, yNorm: Number(yNorm) || 0 });
      }
    } catch (e) {
      // silent
    }
  } catch (e) {
    // reduce noisy logging on hot path
  }
}

let lastMouseEmitAt = 0;
const AGENT_MOUSE_MIN_MS = Number(process.env.AGENT_MOUSE_MIN_MS) || 6;

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
  } catch (e) { /* quiet */ }
}
async function mouseDownPayload(buttonName) {
  try { if (!nutMouse) return; const b = mapButton(buttonName); if (typeof nutMouse.pressButton === 'function') await nutMouse.pressButton(b); } catch (e) { /* quiet */ }
}
async function mouseUpPayload(buttonName) {
  try { if (!nutMouse) return; const b = mapButton(buttonName); if (typeof nutMouse.releaseButton === 'function') await nutMouse.releaseButton(b); } catch (e) { /* quiet */ }
}
async function mouseScrollPayload(dx, dy) {
  try {
    if (!nutMouse) return;
    dx = Math.trunc(dx || 0);
    dy = Math.trunc(dy || 0);

    // Prefer wheel APIs if available
    if (Math.abs(dy) >= Math.abs(dx)) {
      if (dy > 0 && typeof nutMouse.scrollDown === 'function') return nutMouse.scrollDown(Math.abs(dy));
      if (dy < 0 && typeof nutMouse.scrollUp === 'function') return nutMouse.scrollUp(Math.abs(dy));
    } else {
      if (dx > 0 && typeof nutMouse.scrollRight === 'function') return nutMouse.scrollRight(Math.abs(dx));
      if (dx < 0 && typeof nutMouse.scrollLeft === 'function') return nutMouse.scrollLeft(Math.abs(dx));
    }
  } catch (e) { /* quiet */ }
}

socket.on('connect', () => {
  console.log('[agent] connected to server', SERVER, 'socket id', socket.id);
  socket.emit('agent-register', { code: ROOM, secret: AGENT_SECRET }, (res) => {
    if (!res || !res.success) {
      console.error('[agent] agent-register failed', res);
      return;
    }
    console.log('[agent] agent registered for room', ROOM);
    // refresh screen cache on (re)connect
    refreshScreenCache().catch(()=>{});
  });
});

socket.on('control-from-viewer', async ({ fromViewer, payload } = {}) => {
  try {
    if (!payload) return;

    // throttle high-frequency mouse moves from viewers: ensure at least AGENT_MOUSE_MIN_MS between move applies
    if (payload.type === 'mouse') {
      if (payload.action === 'move' && typeof payload.xNorm === 'number' && typeof payload.yNorm === 'number') {
        const now = Date.now();
        if (now - lastMouseEmitAt < AGENT_MOUSE_MIN_MS) {
          // but still emit latest cursor to viewers immediately (server-side) — we still move less often
          try { socket.emit('agent-mouse', { code: ROOM, xNorm: Number(payload.xNorm) || 0, yNorm: Number(payload.yNorm) || 0 }); } catch(e){}
          return;
        }
        lastMouseEmitAt = now;
        // move OS mouse, then emit agent-mouse in moveMouseForPayload -> viewers get near-instant cursor
        moveMouseForPayload(payload.xNorm, payload.yNorm).catch(()=>{});
      } else if (payload.action === 'click') {
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

    if (payload.type === 'key') {
      const rawKey = (payload && payload.rawKey) ? String(payload.rawKey) : String(payload && payload.key || '');
      const lowKey = String((payload && payload.key) || rawKey || '').toLowerCase();
      // make mapped mutable so we can normalize simple arrow names
      let mapped = lowKey;
      const MODIFIERS = new Set(['shift','control','ctrl','alt','meta','command','capslock']);

      // Defensive: accept browser-style simple names ('left','right','up','down') as well
      try {
        if (['left','right','up','down'].includes(mapped)) {
          mapped = 'arrow' + mapped;
        }
      } catch(e){}

      if (MODIFIERS.has(mapped)) {
        const mappedKeyEnum = NUT_KEY_MAP[mapped];
        if (payload.action === 'down') {
          if (mappedKeyEnum && nutKeyboard && nutKeyboard.pressKey) {
            nutKeyboard.pressKey(mappedKeyEnum).catch(()=>{});
          }
        } else if (payload.action === 'up') {
          if (mappedKeyEnum && nutKeyboard && nutKeyboard.releaseKey) {
            nutKeyboard.releaseKey(mappedKeyEnum).catch(()=>{});
          }
        }
        return;
      }

      const mappedKeyEnum = NUT_KEY_MAP[mapped];
      if (payload.action === 'down') {
        if (mappedKeyEnum && nutKeyboard && nutKeyboard.pressKey) {
          nutKeyboard.pressKey(mappedKeyEnum).catch(()=>{});
        } else {
          const toType = (rawKey && rawKey.length === 1) ? rawKey : null;
          if (toType && nutKeyboard && nutKeyboard.type) {
            nutKeyboard.type(toType).catch(()=>{});
          }
        }
        return;
      } else if (payload.action === 'up') {
        if (mappedKeyEnum && nutKeyboard && nutKeyboard.releaseKey) {
          nutKeyboard.releaseKey(mappedKeyEnum).catch(()=>{});
        }
        return;
      }
    }
  } catch (err) {
    // quiet
  }
});

socket.on('disconnect', () => {
  // minimal logging on disconnect
});
