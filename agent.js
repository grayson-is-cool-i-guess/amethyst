// agent.js
// made by chatgpt
// idc

const SERVER = process.env.SERVER || 'http://localhost:3000';
const AGENT_NAME = process.env.AGENT_NAME || 'unnamed-agent';
const AGENT_SECRET = process.env.AGENT_SECRET || null;
const AGENT_DEBUG = !!process.env.AGENT_DEBUG;

const path = require('path');
const fs = require('fs');
const ioClient = require('socket.io-client');

let nut = null;
let NUT_KEY_MAP = {};
let nutKeyboard = null;
let nutMouse = null;

try {
  nut = require('@nut-tree/nut-js');
  // build NUT_KEY_MAP from nut.Key if available
  if (nut && nut.Key) {
    Object.keys(nut.Key).forEach(k => {
      NUT_KEY_MAP[k.toLowerCase()] = nut.Key[k];
    });
  }
  if (nut && nut.keyboard) {
    nutKeyboard = nut.keyboard;
  }
  if (nut && nut.mouse) {
    nutMouse = nut.mouse;
  }
} catch (e) {
  if (AGENT_DEBUG) console.error('[agent] nut.js not available:', e);
}

// convenience wrappers used later
async function mouseDownPayload(button) {
  try {
    if (!nutMouse) return;
    if (button === 'left') {
      await nutMouse.pressButton(nut.Button.LEFT);
    } else if (button === 'right') {
      await nutMouse.pressButton(nut.Button.RIGHT);
    } else {
      await nutMouse.pressButton(nut.Button.LEFT);
    }
  } catch (err) {
    if (AGENT_DEBUG) console.error('[agent] mouseDownPayload error', err);
  }
}

async function mouseUpPayload(button) {
  try {
    if (!nutMouse) return;
    if (button === 'left') {
      await nutMouse.releaseButton(nut.Button.LEFT);
    } else if (button === 'right') {
      await nutMouse.releaseButton(nut.Button.RIGHT);
    } else {
      await nutMouse.releaseButton(nut.Button.LEFT);
    }
  } catch (err) {
    if (AGENT_DEBUG) console.error('[agent] mouseUpPayload error', err);
  }
}

async function mouseScrollPayload(dx, dy) {
  try {
    if (!nutMouse) return;
    // nut.mouse doesn't have a unified scroll; emulate with scroll
    if (nut.scroll) {
      await nut.scroll(dx, dy);
    }
  } catch (err) {
    if (AGENT_DEBUG) console.error('[agent] mouseScrollPayload error', err);
  }
}

// connect to server
const socket = ioClient(SERVER, {
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
});

socket.on('connect', () => {
  if (AGENT_DEBUG) console.log('[agent] connected to server');
  socket.emit('register-agent', { name: AGENT_NAME, secret: AGENT_SECRET });
});

socket.on('connect_error', (err) => {
  if (AGENT_DEBUG) console.error('[agent] connect_error', err);
});

socket.on('disconnect', (reason) => {
  if (AGENT_DEBUG) console.warn('[agent] disconnected', reason);
});

socket.on('control-from-viewer', (data) => {
  // data should be { viewerId, payload }
  try {
    const payload = data && data.payload ? data.payload : null;
    if (!payload) return;
    // handle mouse events first
    if (payload.type === 'mouse') {
      if (payload.action === 'down') {
        const btn = payload.button || 'left';
        mouseDownPayload(btn).catch(e=>{ if (AGENT_DEBUG) console.error('[agent] mdown error', e); });
      } else if (payload.action === 'up') {
        const btn = payload.button || 'left';
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
      let mapped = lowKey;
      const MODIFIERS = new Set(['shift','control','ctrl','alt','meta','command','capslock']);

      try {
        if (['left','right','up','down'].includes(mapped)) {
          mapped = 'arrow' + mapped;
        }
      } catch(e){}

      // Log every key event so you can bind/diagnose keys
      try {
        console.log(`[agent] key event -> action=${payload.action} raw="${rawKey}" normalized="${lowKey}" mapped="${mapped}"`);
      } catch(e){ /* ignore logging errors */ }

      if (MODIFIERS.has(mapped)) {
        const mappedKeyEnum = NUT_KEY_MAP[mapped];
        // Log resolved enum for modifier keys
        try {
          console.log(`[agent] modifier key handling -> mappedEnum=${mappedKeyEnum ? mappedKeyEnum : 'null'}`);
        } catch(e){}

        if (payload.action === 'down') {
          if (mappedKeyEnum && nutKeyboard && nutKeyboard.pressKey) {
            // log before calling nut.js
            console.log(`[agent] calling nutKeyboard.pressKey(${mapped})`);
            nutKeyboard.pressKey(mappedKeyEnum).catch(e=>{ console.error('[agent] pressKey failed', e); });
          } else {
            console.log('[agent] modifier press: no mapped enum or nutKeyboard.pressKey unavailable');
          }
        } else if (payload.action === 'up') {
          if (mappedKeyEnum && nutKeyboard && nutKeyboard.releaseKey) {
            console.log(`[agent] calling nutKeyboard.releaseKey(${mapped})`);
            nutKeyboard.releaseKey(mappedKeyEnum).catch(e=>{ console.error('[agent] releaseKey failed', e); });
          } else {
            console.log('[agent] modifier release: no mapped enum or nutKeyboard.releaseKey unavailable');
          }
        }
        return;
      }

      const mappedKeyEnum = NUT_KEY_MAP[mapped];

      // Log whether we'll press/release or type
      try {
        console.log(`[agent] non-modifier key -> mappedEnum=${mappedKeyEnum ? mappedKeyEnum : 'null'}, action=${payload.action}`);
      } catch(e){}

      if (payload.action === 'down') {
        if (mappedKeyEnum && nutKeyboard && nutKeyboard.pressKey) {
          console.log(`[agent] calling nutKeyboard.pressKey(${mapped})`);
          nutKeyboard.pressKey(mappedKeyEnum).catch(e=>{ console.error('[agent] pressKey failed', e); });
        } else {
          const toType = (rawKey && rawKey.length === 1) ? rawKey : null;
          if (toType && nutKeyboard && nutKeyboard.type) {
            console.log(`[agent] calling nutKeyboard.type("${toType}")`);
            nutKeyboard.type(toType).catch(e=>{ console.error('[agent] type failed', e); });
          } else {
            console.log('[agent] down: no mapped enum and not a single-char to type');
          }
        }
        return;
      } else if (payload.action === 'up') {
        if (mappedKeyEnum && nutKeyboard && nutKeyboard.releaseKey) {
          console.log(`[agent] calling nutKeyboard.releaseKey(${mapped})`);
          nutKeyboard.releaseKey(mappedKeyEnum).catch(e=>{ console.error('[agent] release failed', e); });
        } else {
          console.log('[agent] up: no mapped enum to release (nothing to do)');
        }
        return;
      }
    }
  } catch (err) {
    if (AGENT_DEBUG) console.error('[agent] control-from-viewer handler error', err);
  }
});

socket.on('shutdown-agent', () => {
  if (AGENT_DEBUG) console.log('[agent] shutdown requested');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[agent] uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent] unhandledRejection', reason);
});
