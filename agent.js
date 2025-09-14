// host-agent.js
// Run this on the machine that should receive mouse/keyboard events.
// Example usage (Linux/macOS):
//   ROOM_CODE=ABC SERVER_URL="http://your-server:3000" node host-agent.js
// Example usage (Windows cmd):
//   set ROOM_CODE=ABC&& set SERVER_URL=http://your-server:3000&& node host-agent.js
//
// Optional env:
//   AGENT_SECRET - if your server requires a secret to register an agent.

const SERVER = process.env.SERVER_URL || 'http://localhost:3000';
const ROOM = process.env.ROOM_CODE || '';
const AGENT_SECRET = process.env.AGENT_SECRET || null; // optional auth secret

if (!ROOM) {
  console.error('Please set ROOM_CODE env var to the room code to register as agent');
  process.exit(1);
}

let io, socket;
try { io = require('socket.io-client'); } catch(e) { console.error('Failed to require socket.io-client', e); process.exit(1); }

try {
  socket = io(SERVER, { transports: ['websocket'] });
} catch(e) {
  console.error('[agent] failed to connect to server', SERVER, e);
  process.exit(1);
}

let nutMouse = null, nutKeyboard = null, nutKey = null, nutButton = null, nutScreen = null;
let nut = null;

try {
  nut = require('@nut-tree-fork/nut-js');
  nutMouse = nut?.mouse || null;
  nutKeyboard = nut?.keyboard || null;
  nutKey = nut?.Key || null;
  nutButton = nut?.Button || null;
  nutScreen = nut?.screen || null;

  try { if (nutKeyboard?.config) nutKeyboard.config.autoDelayMs = 0; } catch(e){}
  try { if (nutMouse?.config) nutMouse.config.mouseSpeed = 100; } catch(e){}

  console.log('[agent] nut.js loaded — agent will perform input locally');
} catch (e) {
  console.error('[agent] failed to load @nut-tree-fork/nut-js. Install it: npm i @nut-tree-fork/nut-js');
  console.error('[agent] full error:', e?.message || e);
  process.exit(2);
}

// Build a key map
const NUT_KEY_MAP = {};
try {
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

    const tryAssign = (name, keyProp) => { 
      try { 
        if (typeof nutKey[keyProp] !== 'undefined') NUT_KEY_MAP[name] = nutKey[keyProp]; 
      } catch(e){}
    };

    ['shift','control','ctrl','alt','meta','command','capslock',
     'enter','return','backspace','tab','escape','space','delete',
     'home','end','pageup','pagedown','insert',
     'arrowleft','arrowright','arrowup','arrowdown',
     'printscreen','pause','scrolllock','numlock',
     'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12'].forEach(k=>{
       tryAssign(k, k.charAt(0).toUpperCase() + k.slice(1));
     });
  }
} catch(e){ console.error('[agent] key map build error', e); }

function mapButton(b) {
  try {
    if (!nutButton) return null;
    if (b === 'right') return nutButton.RIGHT;
    if (b === 'middle') return nutButton.MIDDLE;
    return nutButton.LEFT;
  } catch(e) { console.error('[agent] mapButton error', e); return null; }
}

async function moveMouseForPayload(xNorm, yNorm) {
  try {
    if (!nutMouse) return;
    const w = (nutScreen?.width && typeof nutScreen.width === 'function') ? await nutScreen.width() : 1024;
    const h = (nutScreen?.height && typeof nutScreen.height === 'function') ? await nutScreen.height() : 768;
    const x = Math.round(Math.max(0, Math.min(1, xNorm)) * (w - 1));
    const y = Math.round(Math.max(0, Math.min(1, yNorm)) * (h - 1));
    if (typeof nutMouse.setPosition === 'function') {
      await nutMouse.setPosition({ x, y });
    } else if (typeof nutMouse.move === 'function') {
      await nutMouse.move({ x, y });
    }
  } catch (e) { console.error('[agent] moveMouseForPayload failed', e); }
}

async function mouseClickPayload(buttonName) {
  try {
    if (!nutMouse) return;
    const b = mapButton(buttonName);
    if (!b) return;
    if (b === nutButton.LEFT && typeof nutMouse.leftClick === 'function') return nutMouse.leftClick();
    if (b === nutButton.RIGHT && typeof nutMouse.rightClick === 'function') return nutMouse.rightClick();
    if (typeof nutMouse.click === 'function') return nutMouse.click(b);
    if (typeof nutMouse.pressButton === 'function') {
      await nutMouse.pressButton(b);
      await nutMouse.releaseButton(b);
    }
  } catch (e) { console.error('[agent] mouseClick failed', e); }
}

async function mouseDownPayload(buttonName) {
  try { 
    if (!nutMouse) return; 
    const b = mapButton(buttonName); 
    if (!b) return; 
    if (typeof nutMouse.pressButton === 'function') await nutMouse.pressButton(b); 
  } catch (e) { console.error('[agent] mouseDown failed', e); }
}

async function mouseUpPayload(buttonName) {
  try { 
    if (!nutMouse) return; 
    const b = mapButton(buttonName); 
    if (!b) return; 
    if (typeof nutMouse.releaseButton === 'function') await nutMouse.releaseButton(b); 
  } catch (e) { console.error('[agent] mouseUp failed', e); }
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
  } catch (e) { console.error('[agent] mouseScroll failed', e); }
}

// --- Socket events ---
try {
  socket.on('connect', () => {
    try {
      console.log('[agent] connected to server', SERVER, 'socket id', socket.id);
      socket.emit('agent-register', { code: ROOM, secret: AGENT_SECRET }, (res) => {
        try {
          if (!res || !res.success) {
            console.error('[agent] agent-register failed', res);
            return;
          }
          console.log('[agent] agent registered for room', ROOM);
        } catch(e) { console.error('[agent] agent-register callback error', e); }
      });
    } catch(e) { console.error('[agent] connect handler error', e); }
  });

  socket.on('control-from-viewer', async ({ fromViewer, payload } = {}) => {
    try {
      if (!payload) return;
      // Mouse actions
      if (payload.type === 'mouse') {
        try {
          if (payload.action === 'move' && typeof payload.xNorm === 'number' && typeof payload.yNorm === 'number') {
            await moveMouseForPayload(payload.xNorm, payload.yNorm);
          } else if (payload.action === 'click') {
            await mouseClickPayload(payload.button);
          } else if (payload.action === 'down') {
            await mouseDownPayload(payload.button);
          } else if (payload.action === 'up') {
            await mouseUpPayload(payload.button);
          } else if (payload.action === 'scroll') {
            await mouseScrollPayload(payload.deltaX || 0, payload.deltaY || 0);
          }
        } catch(e) { console.error('[agent] mouse action error', e); }
        return;
      }

      // Key actions
      if (payload.type === 'key') {
        try {
          const rawKey = payload?.rawKey ? String(payload.rawKey) : String(payload?.key || '');
          const lowKey = String(payload?.key || rawKey || '').toLowerCase();
          const mapped = lowKey;
          const MODIFIERS = new Set(['shift','control','ctrl','alt','meta','command','capslock']);

          if (MODIFIERS.has(mapped)) {
            const mappedKeyEnum = NUT_KEY_MAP[mapped];
            if (payload.action === 'down') {
              if (mappedKeyEnum && nutKeyboard?.pressKey) await nutKeyboard.pressKey(mappedKeyEnum);
            } else if (payload.action === 'up') {
              if (mappedKeyEnum && nutKeyboard?.releaseKey) await nutKeyboard.releaseKey(mappedKeyEnum);
            }
            return;
          }

          const mappedKeyEnum = NUT_KEY_MAP[mapped];
          if (payload.action === 'down') {
            if (mappedKeyEnum && nutKeyboard?.pressKey) await nutKeyboard.pressKey(mappedKeyEnum);
            else if (rawKey?.length === 1 && nutKeyboard?.type) await nutKeyboard.type(rawKey);
          } else if (payload.action === 'up') {
            if (mappedKeyEnum && nutKeyboard?.releaseKey) await nutKeyboard.releaseKey(mappedKeyEnum);
          }
        } catch(e) { console.error('[agent] key action error', e); }
      }
    } catch (err) {
      console.error('[agent] control-from-viewer handler error', err);
    }
  });

  socket.on('disconnect', () => {
    try { console.log('[agent] disconnected from server'); } catch(e){console.error('[agent] disconnect handler error', e);}
  });
} catch(e) { console.error('[agent] socket event binding error', e); }
