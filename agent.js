const SERVER = process.env.SERVER_URL || 'ws://streamamethyst.org/ws';
const ROOM = process.env.ROOM_CODE || '';
const AGENT_SECRET = process.env.AGENT_SECRET || null;
const AGENT_DEBUG = true;
const AGENT_SENSITIVITY = Number(process.env.AGENT_SENSITIVITY || 1.0);
const AGENT_MOUSE_EMIT_MIN_MS = Number(process.env.AGENT_MOUSE_EMIT_MIN_MS || 16);
const AGENT_REGISTER_BASE_MS = Number(process.env.AGENT_REGISTER_BASE_MS || 1000);
const AGENT_REGISTER_MAX_MS = Number(process.env.AGENT_REGISTER_MAX_MS || 60000);
const AGENT_REGISTER_JITTER = Number(process.env.AGENT_REGISTER_JITTER || 0.2);
const AGENT_REGISTER_MAX_RETRIES = Number(process.env.AGENT_REGISTER_MAX_RETRIES || 0);
if (!ROOM) {
  console.error('Please set ROOM_CODE env var to the room code to register as agent');
  process.exit(1);
}
const WebSocket = require('ws');
const ws = new WebSocket(SERVER);
ws.binaryType = 'arraybuffer';
let _registered = false;
let _registerTimer = null;
let _registerAttempts = 0;
function sendReq(event, data) {
  const obj = { id: String(Math.floor(Math.random()*1e9)), event, data };
  ws.send(JSON.stringify(obj));
}
function sendBinary(event, meta, ab) {
  try {
    const header = JSON.stringify({ event, meta: meta || {} });
    const headerBuf = Buffer.from(header, 'utf8');
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32BE(headerBuf.length, 0);
    const out = Buffer.concat([prefix, headerBuf, Buffer.from(ab)]);
    ws.send(out);
  } catch (e) {}
}
ws.on('open', () => {
  if (AGENT_DEBUG) console.log('[agent] connected to server', SERVER);
  _doRegister();
});
ws.on('close', () => {
  _registered = false;
});
ws.on('message', (data) => {
  try {
    if (typeof data === 'string') {
      const obj = JSON.parse(data);
    } else {
      const buf = Buffer.from(data);
      if (buf.length < 4) return;
      const headerLen = buf.readUInt32BE(0);
      if (buf.length < 4 + headerLen) return;
      const headerBuf = buf.slice(4, 4 + headerLen);
      const meta = JSON.parse(headerBuf.toString('utf8'));
      const payload = buf.slice(4 + headerLen);
      if (meta.event === 'control-from-viewer') {
        const fromViewer = meta.meta && meta.meta.fromViewer;
      }
    }
  } catch(e){}
});
function _doRegister() {
  const payload = { code: ROOM, secret: AGENT_SECRET };
  try {
    sendReq('agent-register', payload);
    _registered = true;
    _registerAttempts = 0;
  } catch(e){
    _registered = false;
    _scheduleRegisterRetry('send-failed');
  }
}
function _scheduleRegisterRetry(reason) {
  try {
    _registerAttempts++;
    if (AGENT_REGISTER_MAX_RETRIES && _registerAttempts > AGENT_REGISTER_MAX_RETRIES) return;
    const base = Math.min(AGENT_REGISTER_BASE_MS * Math.pow(1.6, _registerAttempts-1), AGENT_REGISTER_MAX_MS);
    const jitter = base * AGENT_REGISTER_JITTER * (Math.random()*2 - 1);
    const delay = Math.max(200, Math.round(base + jitter));
    if (_registerTimer) clearTimeout(_registerTimer);
    _registerTimer = setTimeout(()=>{ _doRegister(); }, delay);
  } catch(e){}
}
