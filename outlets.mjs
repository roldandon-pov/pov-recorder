#!/usr/bin/env node
/**
 * outlets.mjs — Gestiona los OUTLETS alternos del Director's Cut vía Mux
 * Simulcast Targets.
 *
 * El Director's Cut se emite UNA vez a Mux (el encoder empuja el programa). Mux
 * puede RE-EMITIR esa misma señal a otros destinos RTMP a la vez (YouTube,
 * Facebook, Twitch…) sin volver a codificar: eso es un "simulcast target".
 *
 * Instagram NO tiene ingesta RTMP pública, así que NO se puede como simulcast
 * (ver notas al final). Este script cubre YouTube/Facebook/Twitch/custom.
 *
 * ── Requisitos ──────────────────────────────────────────────────────────────
 *   Node 18+ (usa fetch nativo). Credenciales de la API de Mux en el entorno:
 *     MUX_TOKEN_ID, MUX_TOKEN_SECRET
 *   (están en "POV TODO/mux-access-token-POV Backend.env").
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   node outlets.mjs list
 *   node outlets.mjs add youtube  <STREAM_KEY>
 *   node outlets.mjs add facebook <STREAM_KEY>
 *   node outlets.mjs add twitch   <STREAM_KEY>
 *   node outlets.mjs add custom   <RTMP_URL> <STREAM_KEY>
 *   node outlets.mjs remove <TARGET_ID>
 *
 * IMPORTANTE: los targets sólo se pueden AGREGAR/QUITAR cuando el Live Stream
 * está `idle` (no al aire). Una vez agregados, cada vez que el Director's Cut
 * salga a Mux, Mux empuja también a esos destinos automáticamente.
 */

const TOKEN_ID = process.env.MUX_TOKEN_ID;
const TOKEN_SECRET = process.env.MUX_TOKEN_SECRET;

// El Live Stream del Director's Cut se descubre por su playback id conocido
// (el del `directorsCutHlsUrl`), con override por si algún día cambia.
const KNOWN_PLAYBACK = 'r004ExXOK00oUrBkmsGNiB5Kh4t9BHn00QEOMwXBN57rN00';
const LIVE_STREAM_ID_ENV = process.env.MUX_LIVE_STREAM_ID;

const RTMP_PRESETS = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
  twitch: 'rtmp://live.twitch.tv/app',
};

const API = 'https://api.mux.com/video/v1';

function auth() {
  if (!TOKEN_ID || !TOKEN_SECRET) {
    console.error(
      '❌ Faltan credenciales. Exporta MUX_TOKEN_ID y MUX_TOKEN_SECRET.\n' +
        '   source "../../mux-access-token-POV Backend.env"  (o el .env que las tenga)',
    );
    process.exit(1);
  }
  return 'Basic ' + Buffer.from(`${TOKEN_ID}:${TOKEN_SECRET}`).toString('base64');
}

async function mux(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: auth(), 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.messages?.join('; ') || JSON.stringify(body);
    throw new Error(`Mux ${res.status}: ${msg}`);
  }
  return body.data;
}

async function resolveLiveStream() {
  if (LIVE_STREAM_ID_ENV) return await mux(`/live-streams/${LIVE_STREAM_ID_ENV}`);
  const list = await mux('/live-streams?limit=50');
  const found = list.find((s) => (s.playback_ids || []).some((p) => p.id === KNOWN_PLAYBACK));
  if (!found) {
    throw new Error(
      'No encontré el Live Stream del Director’s Cut por su playback id. ' +
        'Pásalo con MUX_LIVE_STREAM_ID=<id>.',
    );
  }
  return found;
}

function printTargets(ls) {
  const targets = ls.simulcast_targets || [];
  console.log(`\n📡 Director’s Cut · live stream ${ls.id} · estado: ${ls.status}`);
  if (!targets.length) {
    console.log('   (sin outlets alternos — solo Mux/HLS)');
    return;
  }
  console.log(`   ${targets.length} outlet(s):`);
  for (const t of targets) {
    console.log(
      `   • ${t.passthrough || '(sin etiqueta)'}  ${t.url}  ` +
        `[${t.status}]  id=${t.id}`,
    );
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd || cmd === 'list') {
    printTargets(await resolveLiveStream());
    return;
  }

  if (cmd === 'add') {
    const [kind, a, b] = args;
    let url;
    let streamKey;
    if (kind === 'custom') {
      url = a;
      streamKey = b;
    } else {
      url = RTMP_PRESETS[kind];
      streamKey = a;
    }
    if (!url || !streamKey) {
      console.error(
        'Uso: add <youtube|facebook|twitch> <STREAM_KEY>  |  add custom <RTMP_URL> <STREAM_KEY>',
      );
      process.exit(1);
    }
    // Etiqueta (passthrough) para reconocerlo en `list`. En custom se puede pasar
    // una etiqueta como 3er argumento: `add custom <url> <key> <label>`.
    const label = kind === 'custom' ? args[3] || 'custom' : kind;
    const ls = await resolveLiveStream();
    if (ls.status !== 'idle') {
      console.error(
        `⚠️  El Live Stream está "${ls.status}", no "idle". Mux sólo permite agregar ` +
          'outlets con el stream inactivo. Detén el aire, agrega, y vuelve a salir.',
      );
      process.exit(1);
    }
    const target = await mux(`/live-streams/${ls.id}/simulcast-targets`, {
      method: 'POST',
      body: JSON.stringify({ url, stream_key: streamKey, passthrough: label }),
    });
    console.log(`✅ Outlet agregado: ${label} → ${url}  (id=${target.id}, estado ${target.status})`);
    console.log('   Al próximo aire del Director’s Cut, Mux empujará también aquí.');
    return;
  }

  if (cmd === 'remove') {
    const [targetId] = args;
    if (!targetId) {
      console.error('Uso: remove <TARGET_ID>   (obtén el id con: node outlets.mjs list)');
      process.exit(1);
    }
    const ls = await resolveLiveStream();
    await mux(`/live-streams/${ls.id}/simulcast-targets/${targetId}`, { method: 'DELETE' });
    console.log(`🗑️  Outlet ${targetId} eliminado.`);
    return;
  }

  console.error(`Comando desconocido: ${cmd}\nUsa: list | add | remove`);
  process.exit(1);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
