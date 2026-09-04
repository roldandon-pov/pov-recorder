#!/usr/bin/env node
/**
 * server.js — RECORDER DE NUBE (Ruta A) para shows rápidos.
 *
 * Un servicio HTTP pequeño que vive en Fly.io. Cuando el backend crea un show
 * rápido (`/api/go`), le pega a `POST /record { code }` y este servicio lanza
 * `quick-record.mjs <code>` (provisiona Mux con grabación + corre el encoder
 * relay→Mux). Si nadie sale al aire, el propio quick-record se auto-apaga.
 *
 * Endpoints:
 *   POST /record   { code }   (header `x-recorder-secret`)  → arranca grabación
 *   GET  /health              → estado + grabaciones activas
 *
 * Entorno (secrets de Fly):
 *   RECORDER_SECRET   compartido con el backend (autoriza el webhook)
 *   MUX_TOKEN_ID / MUX_TOKEN_SECRET   credenciales de Mux
 *   RELAY_WS_URL      (opcional) por defecto el relay de Cloudflare
 *   MAX_CONCURRENT    (opcional) tope de grabaciones simultáneas (def. 4)
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.RECORDER_SECRET || '';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 4);

/** code → child process de una grabación en curso (dedupe + tope). */
const active = new Map();

// Keep-alive (Render free): el servicio se DUERME tras ~15 min sin tráfico HTTP
// entrante. Durante una grabación todo el tráfico es SALIENTE (WS al relay + RTMP
// a Mux), así que Render lo dormiría a mitad del show. Mientras haya grabaciones
// activas, se auto-pinguea para seguir despierto; sin grabaciones se deja dormir
// (ahorra horas del tramo gratis). Render expone su URL pública en RENDER_EXTERNAL_URL.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || '';
setInterval(() => {
  if (active.size > 0 && SELF_URL) {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }
}, 10 * 60 * 1000);

function startRecording(code) {
  if (active.has(code)) return { ok: true, already: true };
  if (active.size >= MAX_CONCURRENT) return { ok: false, error: 'max_concurrent' };

  const child = spawn('node', [path.join(__dirname, 'quick-record.mjs'), code], {
    stdio: 'inherit',
    env: process.env, // hereda MUX_*, RELAY_WS_URL, etc.
  });
  active.set(code, child);
  console.log(`▶️  Grabación iniciada para "${code}" (activas: ${active.size})`);
  child.on('exit', (c) => {
    active.delete(code);
    console.log(`⏹  Grabación de "${code}" terminó (código ${c}). Activas: ${active.size}`);
  });
  return { ok: true };
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, active: [...active.keys()], count: active.size });
  }

  if (req.method === 'POST' && req.url === '/record') {
    if (!SECRET || req.headers['x-recorder-secret'] !== SECRET) {
      return send(401, { ok: false, error: 'unauthorized' });
    }
    const { code } = await readJson(req);
    if (!code || !/^[A-Za-z0-9]{4,16}$/.test(code)) {
      return send(400, { ok: false, error: 'bad_code' });
    }
    const r = startRecording(code);
    return send(r.ok ? 200 : 429, r);
  }

  send(404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`🎥 POV recorder escuchando en :${PORT} (max ${MAX_CONCURRENT} simultáneas)`);
  if (!SECRET) console.warn('⚠️  RECORDER_SECRET vacío: /record quedará bloqueado hasta configurarlo.');
});
