// Captura local del PROGRAMA H.264 desde el relay (role=audience), tal cual lo
// recibe encoder.js, a un archivo .h264 crudo — para verificar que decodifica
// limpio SIN publicar a Mux/YouTube.
const fs = require('fs');
const WebSocket = require('ws');

const URL = process.env.RELAY_WS_URL || 'wss://pov-relay-do.povlive.workers.dev';
const SHOW = process.env.RELAY_SHOW_CODE || 'POVCAM';
const SECS = Number(process.env.SECS || 6);
const OUT = process.env.OUT || '/tmp/pov_program.h264';

const out = fs.createWriteStream(OUT);
let bytes = 0, aus = 0;
const ws = new WebSocket(`${URL}/relay?show=${encodeURIComponent(SHOW)}&role=audience`);

ws.on('open', () => console.log('✅ audience conectado, siguiendo programa', SHOW));
ws.on('message', (data, isBinary) => {
  if (isBinary) { out.write(data); bytes += data.length; aus++; return; }
  try { const m = JSON.parse(data.toString()); if (m.type) console.log('ctrl:', m.type, m.camId || ''); } catch {}
});
ws.on('error', (e) => console.error('error:', e.message));

setTimeout(() => {
  ws.close(); out.end();
  console.log(`⏹️ capturado ${aus} AUs / ${(bytes/1024).toFixed(0)} KB → ${OUT}`);
  process.exit(0);
}, SECS * 1000);
