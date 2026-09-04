#!/usr/bin/env node
/**
 * quick-record.mjs — RUTA A: graba un SHOW RÁPIDO a Mux (MP4 listo para redes).
 *
 * El show rápido es relay-only (glasses→iPhone→relay). Este orquestador le pone
 * grabación SIN tocar el teléfono: se suscribe al relay como audiencia (vídeo
 * H.264 + audio PCM del programa), reusa el encoder del Director's Cut para
 * puentear a Mux por RTMPS, y Mux graba el VOD. Al terminar, activa el MP4
 * descargable y te da el link.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────────
 *   source "../../mux-access-token-POV Backend.env"   # MUX_TOKEN_ID / _SECRET
 *   node quick-record.mjs <SHOW_CODE>
 *
 *   Empieza a grabar en cuanto el creador de ese <SHOW_CODE> sale al aire.
 *   Ctrl+C para terminar → Mux cierra el VOD, se activa el MP4 y se imprime la URL.
 *
 * ── Requisitos ───────────────────────────────────────────────────────────────
 *   Node 18+, ffmpeg en el PATH (lo usa encoder.js). Credenciales de Mux en el
 *   entorno. Corre local para validar; para producción va en un host de nube
 *   (Render/Fly/Railway) — mismo comando, disparado cuando arranca el show.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TOKEN_ID = process.env.MUX_TOKEN_ID;
const TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;
const RELAY_WS_URL = process.env.RELAY_WS_URL || 'wss://pov-relay-do.povlive.workers.dev';
// Mux ingesta por RTMPS 443 (el 5222 plano suele estar bloqueado en redes/venues;
// encoder.js levanta un proxy TLS local para RTMPS).
const MUX_RTMP_URL = process.env.MUX_RTMP_URL || 'rtmps://global-live.mux.com:443/app';
const API = 'https://api.mux.com/video/v1';

const showCode = process.argv[2];
if (!showCode) {
  console.error('Uso: node quick-record.mjs <SHOW_CODE>');
  process.exit(1);
}
if (!TOKEN_ID || !TOKEN_SECRET) {
  console.error('❌ Faltan MUX_TOKEN_ID / MUX_TOKEN_SECRET. Haz `source "../../mux-access-token-POV Backend.env"`.');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');

async function mux(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Mux ${res.status}: ${body?.error?.messages?.join('; ') || JSON.stringify(body)}`);
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) Crear un live stream EFÍMERO con grabación (VOD público) + reconexión.
  console.log(`🎬 Provisionando live stream de Mux para el show "${showCode}"…`);
  const ls = await mux('/live-streams', {
    method: 'POST',
    body: JSON.stringify({
      playback_policy: ['public'],
      latency_mode: 'low',
      reconnect_window: 60,
      // Cada emisión crea un VOD (público). El MP4 se activa al final (más fiable
      // por-asset que en new_asset_settings, y así sale "standard" garantizado).
      new_asset_settings: { playback_policy: ['public'] },
      passthrough: `quick:${showCode}`,
    }),
  });
  const streamKey = ls.stream_key;
  console.log(`   live stream ${ls.id} · ingesta ${MUX_RTMP_URL}/••••`);

  // 2) Lanzar el encoder (relay → ffmpeg → Mux) apuntado a este show + esta ingesta.
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawn('node', [join(here, 'encoder.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      RELAY_WS_URL,
      RELAY_SHOW_CODE: showCode,
      DEST: 'mux',
      RTMP_URL: MUX_RTMP_URL,
      STREAM_KEY: streamKey,
      SOURCE_CODEC: 'h264',   // el relay ya entrega H.264 (Ruta B)
      AUDIO_SOURCE: 'relay',  // audio PCM 48k mono del programa
    },
  });
  console.log(`▶️  Encoder corriendo. Grabando en cuanto "${showCode}" salga al aire. Ctrl+C para terminar.\n`);

  // 3) Al terminar (Ctrl+C o fin del encoder): cerrar, activar MP4 y dar la URL.
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    try { child.kill('SIGINT'); } catch {}
    await sleep(1500);
    console.log('\n🧾 Cerrando grabación y activando MP4…');
    try {
      // Mux tarda unos segundos en pasar el VOD a "ready". Reintentar.
      let assetId = null;
      for (let i = 0; i < 30 && !assetId; i++) {
        const s = await mux(`/live-streams/${ls.id}`);
        assetId = (s.recent_asset_ids || [])[0] || null;
        if (!assetId) await sleep(2000);
      }
      if (!assetId) {
        console.log('⚠️  No se generó grabación (¿nadie salió al aire en ese code?). Nada que guardar.');
      } else {
        // Activar MP4 descargable (para Instagram/redes).
        await mux(`/assets/${assetId}/mp4-support`, {
          method: 'PUT',
          body: JSON.stringify({ mp4_support: 'standard' }),
        });
        // Esperar a que el asset y el MP4 estén listos.
        let asset = null;
        for (let i = 0; i < 60; i++) {
          asset = await mux(`/assets/${assetId}`);
          const mp4 = (asset.static_renditions?.files || []).some((f) => f.status === 'ready') ||
                      asset.mp4_support === 'standard';
          if (asset.status === 'ready' && mp4) break;
          await sleep(3000);
        }
        const pb = (asset.playback_ids || [])[0]?.id;
        console.log('\n✅ Grabación lista.');
        console.log(`   asset:     ${assetId}  (dur ${Math.round(asset.duration || 0)}s)`);
        if (pb) {
          console.log(`   Ver HLS:   https://stream.mux.com/${pb}.m3u8`);
          console.log(`   MP4 redes: https://stream.mux.com/${pb}/high.mp4`);
          console.log('   (si el MP4 aún da 404, espera ~30 s: Mux lo está generando)');
        }
      }
    } catch (e) {
      console.error('❌ Al finalizar:', e.message);
    }
    // El live stream efímero ya cumplió; se puede borrar (el VOD queda aparte).
    try { await mux(`/live-streams/${ls.id}`, { method: 'DELETE' }); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', finish);
  child.on('exit', finish);

  // Auto-apagado si NADIE sale al aire (trigger ocioso desde /api/go): si el
  // stream sigue 'idle' tras NO_SIGNAL_SECS, no hubo broadcast → cerrar sin dejar
  // grabación. Ventana amplia para dar tiempo a conectar las Metas y GO LIVE.
  const NO_SIGNAL_SECS = Number(process.env.NO_SIGNAL_SECS || 480);
  const MAX_MINUTES = Number(process.env.MAX_MINUTES || 180);
  setTimeout(async () => {
    if (finishing) return;
    try {
      const s = await mux(`/live-streams/${ls.id}`);
      if (s.status !== 'active' && !(s.recent_asset_ids || []).length) {
        console.log(`⏱️  Sin señal en ${NO_SIGNAL_SECS}s — nadie salió al aire. Cerrando.`);
        finish();
      }
    } catch { /* ignora; el MAX_MINUTES cubre el peor caso */ }
  }, NO_SIGNAL_SECS * 1000);
  // Tope de seguridad de duración (evita un encoder colgado para siempre).
  setTimeout(() => {
    if (!finishing) { console.log(`⏱️  Tope de ${MAX_MINUTES} min. Cerrando.`); finish(); }
  }, MAX_MINUTES * 60000);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
