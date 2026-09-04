'use strict';

/**
 * Director's Cut → YouTube Live (RTMP) — PROTOTIPO
 * ─────────────────────────────────────────────────────────────────────────────
 * Puente entre el relay de POV LIVE (fotogramas JPEG por WebSocket) y YouTube
 * Live (vídeo H.264 por RTMP).
 *
 * Cómo obtiene el Director's Cut:
 *   Se conecta al relay como AUDIENCIA **sin fijar cámara** (`role=audience`, sin
 *   `cam`). En ese modo el espectador sigue el PROGRAMA: el relay le envía los
 *   fotogramas de `activeCamId` —el corte que el realizador va montando en vivo—
 *   y, cuando el director corta a otra cámara, el flujo cambia solo. Eso es
 *   exactamente el Director's Cut.
 *
 * Qué hace con ellos:
 *   Inyecta cada JPEG en ffmpeg como un stream MJPEG. ffmpeg lo normaliza a una
 *   resolución/fps fijos, lo codifica en H.264 + AAC y lo empuja por RTMP a
 *   YouTube. YouTube EXIGE pista de audio; como el relay aún no transporta
 *   audio, se añade una pista silenciosa (anullsrc). Cuando la señal traiga
 *   audio real, se sustituye esa entrada.
 *
 * Alcance del prototipo:
 *   · Un solo destino (YouTube). El fan-out a Facebook/Instagram es el paso
 *     siguiente (un restreamer o varias salidas de ffmpeg).
 *   · Audio silencioso (placeholder).
 *   · Si el programa se queda sin cámara activa, ffmpeg deja de recibir
 *     fotogramas; YouTube tolera cortes breves. Rellenar el hueco con una
 *     tarjeta "volvemos enseguida" es una mejora pendiente.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');

// ── Configuración (por variables de entorno) ────────────────────────────────
const RELAY_WS_URL     = process.env.RELAY_WS_URL     || 'wss://pov-relay-do.povlive.workers.dev';
const RELAY_SHOW_CODE  = process.env.RELAY_SHOW_CODE  || 'Q7NHQR';

/**
 * Destino de RTMP. Por defecto **Cloudflare Stream Live**: ahí Cloudflare entrega
 * el HLS a povlive.app y hace el fan-out a YouTube/Facebook por "Live Outputs"
 * —así el encoder empuja UN solo stream y Cloudflare reparte—. YouTube directo
 * sigue disponible como preset.
 *
 *   DEST        `cloudflare` (por defecto) | `youtube` | `custom`
 *   RTMP_URL    URL base de ingesta (si se omite, se usa el preset del DEST)
 *   STREAM_KEY  clave de transmisión (requerida)
 */
const DEST = (process.env.DEST || 'cloudflare').toLowerCase();
const RTMP_PRESETS = {
  cloudflare: 'rtmps://live.cloudflare.com:443/live',   // Cloudflare Stream Live (RTMPS → usa proxy TLS)
  mux:        'rtmp://global-live.mux.com:5222/app',    // Mux (RTMP plano, sin TLS → sin proxy)
  youtube:    'rtmp://a.rtmp.youtube.com/live2',
};
const RTMP_URL   = process.env.RTMP_URL || RTMP_PRESETS[DEST] || RTMP_PRESETS.cloudflare;
// STREAM_KEY genérico; se acepta YOUTUBE_STREAM_KEY por compatibilidad.
const STREAM_KEY = process.env.STREAM_KEY || process.env.YOUTUBE_STREAM_KEY;

const FPS          = Number(process.env.FPS || 30);
// VERTICAL nativo por defecto (el producto es 9:16). Antes salía 1280×720
// landscape con barras negras, dejando el contenido real en ~405×720. En vertical
// el POV llena el cuadro y aprovecha toda la resolución. Overridable por env.
const WIDTH        = Number(process.env.WIDTH || 1080);
const HEIGHT       = Number(process.env.HEIGHT || 1920);
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '6000k';
// Buffer ~2× el bitrate; preset y perfil con más calidad por bit que veryfast.
// `fast` es tiempo-real cómodo en Apple Silicon a 1080p. `zerolatency` se retira
// (permite B-frames/lookahead → mejor calidad; el directo ya tolera ~2-4s).
const BUFSIZE      = process.env.BUFSIZE || `${(parseInt(VIDEO_BITRATE, 10) || 6000) * 2}k`;
const PRESET       = process.env.PRESET || 'fast';
const PROFILE      = process.env.PROFILE || 'high';
// Codec del PROGRAMA que llega del relay. `mjpeg` (por defecto) = JPEG por frame
// → se re-codifica a H.264. `h264` (Ruta B) = el dispositivo ya manda H.264 por el
// relay → aquí se COPIA sin re-comprimir (`-c:v copy`), sin el pump ni la CARD.
// Debe coincidir con el codec de las cámaras del show (POVCloudConfig.useH264).
const SOURCE_CODEC = process.env.SOURCE_CODEC === 'h264' ? 'h264' : 'mjpeg';

/**
 * Audio (interino, hasta el DJI).
 *
 * Las Meta Ray-Ban NO publican audio (SDK MWDAT), así que no hay "audio de los
 * Meta" que tomar directo: el sonido lo capta el iPhone. Por ahora el encoder
 * toma el audio de un DISPOSITIVO DE ENTRADA de la máquina donde corre —mic del
 * ambiente, el iPhone ruteado por cable/Continuity, y luego el DJI en el mismo
 * input—.
 *
 *   AUDIO_DEVICE  índice/nombre del dispositivo (avfoundation en Mac, p. ej. ":0"
 *                 = sólo audio, dispositivo 0). Vacío = pista silenciosa.
 *   AUDIO_BACKEND backend de captura por SO: avfoundation (Mac, por defecto),
 *                 dshow (Windows), alsa (Linux).
 *
 * Lista los dispositivos con:
 *   ffmpeg -f avfoundation -list_devices true -i ""
 */
const AUDIO_DEVICE  = process.env.AUDIO_DEVICE || '';
const AUDIO_BACKEND = process.env.AUDIO_BACKEND || 'avfoundation';
// Fuente de audio: 'silent' (placeholder, por defecto) | 'device' (mic/interfaz
// de la máquina vía AUDIO_DEVICE) | 'relay' (PCM que la app manda por el relay
// junto al video → el wearer se mueve con el iPhone; el audio viaja con el show).
const AUDIO_SOURCE  = (process.env.AUDIO_SOURCE || (AUDIO_DEVICE ? 'device' : 'silent')).toLowerCase();
const AUDIO_RATE    = Number(process.env.AUDIO_RATE || 48000); // Hz del PCM del relay
const AUDIO_CH      = Number(process.env.AUDIO_CH   || 1);     // canales del PCM del relay
const RELAY_AUDIO   = AUDIO_SOURCE === 'relay';

// Prueba local: OUTPUT_FILE escribe a un archivo en vez de RTMP (sin Mux ni key).
const OUTPUT_FILE = process.env.OUTPUT_FILE || '';

if (!STREAM_KEY && !OUTPUT_FILE) {
  console.error('❌ Falta STREAM_KEY. Cloudflare: crea un "Live Input" en Stream y copia su clave.  YouTube: DEST=youtube y la clave de YouTube Studio.');
  process.exit(1);
}

const RTMP_TARGET = `${RTMP_URL}/${STREAM_KEY}`;
console.log(`📡 Destino: ${DEST} · ${RTMP_URL}/••••`);

/**
 * Destino real para ffmpeg.
 *
 * ffmpeg compilado con OpenSSL (el de Homebrew) tiene un bug conocido al escribir
 * por RTMPS ("SSL routines::bad write retry" / broken pipe): la conexión TLS se
 * cae en el handshake y el stream nunca llega. En vez de reconstruir ffmpeg,
 * levantamos un **proxy TLS local** (como stunnel): ffmpeg empuja RTMP PLANO a
 * 127.0.0.1 —que su código sin TLS maneja bien— y el proxy envuelve esos bytes
 * en TLS hacia el host RTMPS de Cloudflare. Transparente y sin dependencias.
 */
let proxyServer = null;
const FF_TARGET = tlsProxyTarget(RTMP_TARGET);
// Si pasamos por el proxy local, ffmpeg pondría tcUrl=rtmp://127.0.0.1… en el
// connect RTMP; le forzamos el tcUrl real del host RTMPS para que Cloudflare no
// rechace la sesión.
const PROXIED = FF_TARGET !== RTMP_TARGET;

// ── Transporte: RTMP (por defecto) o SRT ─────────────────────────────────────
// SRT (UDP + recuperación de errores) es MUCHO más resistente a pérdida de
// paquetes que RTMP (TCP) — ideal para venues con wifi saturado o 5G. Requiere
// un ffmpeg con libsrt; el de Homebrew NO lo trae, pero `ffmpeg@6` SÍ, así que
// lo autodetectamos. Si SRT se cae al arrancar, hacemos FALLBACK a RTMP solo.
//   TRANSPORT       `rtmp` (default) | `srt`
//   SRT_HOST/PORT   por defecto Mux (global-live.mux.com:6001)
//   SRT_PASSPHRASE  passphrase del Live Stream (Mux la da al crearlo)
//   STREAM_KEY      se usa como `streamid` en SRT
const TRANSPORT      = (process.env.TRANSPORT || 'rtmp').toLowerCase();
const SRT_HOST       = process.env.SRT_HOST || 'global-live.mux.com';
const SRT_PORT       = process.env.SRT_PORT || '6001';
const SRT_PASSPHRASE = process.env.SRT_PASSPHRASE || '';
const SRT_LATENCY    = process.env.SRT_LATENCY || '2000000'; // µs (2 s), típico venue
const SRT_FALLBACK   = process.env.SRT_FALLBACK !== '0';     // fallback a RTMP si SRT cae rápido
const FALLBACK_MS    = Number(process.env.SRT_FALLBACK_MS || 8000);

function ffmpegHasSrt(bin) {
  try {
    return execSync(`"${bin}" -hide_banner -protocols 2>/dev/null`, { encoding: 'utf8' })
      .split(/\s+/).includes('srt');
  } catch { return false; }
}
// Primer ffmpeg disponible con SRT (para TRANSPORT=srt).
const SRT_FFMPEG = [process.env.FFMPEG_BIN, '/opt/homebrew/opt/ffmpeg@6/bin/ffmpeg', 'ffmpeg']
  .filter(Boolean).find(ffmpegHasSrt) || null;
const RTMP_FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

// Transporte efectivo: si piden SRT pero no hay ffmpeg con libsrt, caemos a RTMP.
let activeTransport = TRANSPORT;
if (TRANSPORT === 'srt' && !SRT_FFMPEG) {
  console.warn('⚠️  TRANSPORT=srt pero ningún ffmpeg tiene libsrt (instala/usa ffmpeg@6). Usando RTMP.');
  activeTransport = 'rtmp';
}

// Salida según transporte. RTMP = FLV al target (con proxy TLS si aplica).
// SRT = MPEG-TS a srt://host:port con streamid=STREAM_KEY + passphrase.
function outputArgs(transport) {
  if (OUTPUT_FILE) return ['-y', OUTPUT_FILE]; // prueba local a archivo
  if (transport === 'srt') {
    const params = [`mode=caller`, `transtype=live`, `latency=${SRT_LATENCY}`, `pkt_size=1316`];
    if (STREAM_KEY)      params.push(`streamid=${encodeURIComponent(STREAM_KEY)}`);
    if (SRT_PASSPHRASE)  params.push(`passphrase=${encodeURIComponent(SRT_PASSPHRASE)}`);
    return ['-f', 'mpegts', `srt://${SRT_HOST}:${SRT_PORT}?${params.join('&')}`];
  }
  return [...(PROXIED ? ['-rtmp_tcurl', RTMP_URL] : []), '-f', 'flv', FF_TARGET];
}

/**
 * Tarjeta de relleno "POV en segundos".
 *
 * Cuando el programa se queda sin cámara al aire (nadie transmitiendo, o el
 * director sin corte activo), no llegan fotogramas y el stream se congelaría.
 * En su lugar se emite esta tarjeta. El emisor NO manda cada JPEG del relay a
 * ffmpeg directamente: mantiene el ÚLTIMO fotograma y un "pump" lo escribe a
 * ritmo constante (FPS); si ese fotograma es viejo (> GAP_MS), escribe la
 * tarjeta. Así el ritmo hacia YouTube es estable y los huecos se rellenan.
 */
const GAP_MS   = Number(process.env.GAP_MS || 1000);
const CARD_PATH = path.join(__dirname, 'card.jpg');
const CARD     = fs.existsSync(CARD_PATH) ? fs.readFileSync(CARD_PATH) : null;
if (!CARD) console.warn('⚠️  Sin card.jpg: los huecos de programa quedarán congelados.');

let currentFrame   = CARD;   // último fotograma del programa (arranca con la tarjeta)
let lastRealFrameAt = 0;     // cuándo llegó el último fotograma REAL del relay

// ── ffmpeg ───────────────────────────────────────────────────────────────────
function audioInputArgs() {
  // relay: PCM s16le que llega por el 2º socket (audio-only) escrito a pipe:3.
  // El wearer se mueve con el iPhone; el audio del DJI viaja con el show.
  if (RELAY_AUDIO) {
    console.log(`🎙️  Audio: PCM del relay (s16le ${AUDIO_RATE}Hz ${AUDIO_CH}ch) → pipe:3.`);
    return ['-thread_queue_size', '1024', '-f', 's16le', '-ar', String(AUDIO_RATE),
            '-ac', String(AUDIO_CH), '-i', 'pipe:3'];
  }
  // device: captura en vivo de un input de la máquina (mic/interfaz).
  if (AUDIO_SOURCE === 'device' && AUDIO_DEVICE) {
    console.log(`🎙️  Audio: capturando de ${AUDIO_BACKEND} «${AUDIO_DEVICE}».`);
    return ['-thread_queue_size', '1024', '-f', AUDIO_BACKEND, '-i', AUDIO_DEVICE];
  }
  console.log('🔇 Audio: pista silenciosa (AUDIO_SOURCE=relay para el mic del iPhone).');
  return ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
}

function startFfmpeg() {
  const h264 = SOURCE_CODEC === 'h264';

  // Entrada de VÍDEO por stdin:
  //  · mjpeg → JPEGs concatenados; `image2pipe -framerate FPS` da PTS CFR limpios
  //    (el pump escribe FPS/seg). Se re-codifica a H.264.
  //  · h264 → Annex-B ya codificado por el dispositivo (el relay lo reenvía tal
  //    cual, escrito directo al llegar). `-use_wallclock_as_timestamps 1` marca
  //    cada AU con su hora de llegada = timing real de vivo; con `-framerate`
  //    (CFR asumido) el copy a FLV fallaba con "Packet is missing PTS".
  const videoInput = [
    '-thread_queue_size', '1024',
    '-f', h264 ? 'h264' : 'image2pipe',
    // H.264 por pipe en vivo: darle a ffmpeg margen para leer hasta encontrar
    // SPS/PPS+IDR antes de fijar el stream. Con analyzeduration 0 (el default del
    // demuxer h264 crudo) se rendía con "unspecified size / non-existing PPS" si
    // el primer read no traía ya los parameter sets. Como el dispositivo repite
    // SPS/PPS en cada keyframe (~1s), esto también recupera si arranca a mitad de
    // GOP. analyzeduration es un TOPE: si el SPS llega primero, resuelve al instante.
    ...(h264
      ? ['-probesize', '10000000', '-analyzeduration', '10000000', '-use_wallclock_as_timestamps', '1']
      : ['-framerate', String(FPS)]),
    '-i', 'pipe:0',
  ];

  // Códec de VÍDEO:
  //  · h264 → `-c:v copy`: sin re-encode ni `-vf` (evita la 2ª compresión; máxima
  //    calidad). El dispositivo ya entregó el tamaño/perfil correctos.
  //  · mjpeg → normaliza (scale/pad a WxH, rango tv) y re-codifica con libx264.
  const videoCodec = h264
    ? ['-c:v', 'copy']
    : [
        '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:` +
               `in_range=full:out_range=tv,` +
               `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,fps=${FPS}`,
        '-c:v', 'libx264', '-preset', PRESET,
        ...(process.env.TUNE ? ['-tune', process.env.TUNE] : []),
        '-profile:v', PROFILE, '-pix_fmt', 'yuv420p', '-color_range', 'tv',
        '-fps_mode', 'cfr', '-r', String(FPS),
        '-b:v', VIDEO_BITRATE, '-maxrate', VIDEO_BITRATE, '-bufsize', BUFSIZE,
        '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
      ];

  const args = [
    '-loglevel', 'warning',
    ...videoInput,

    // Entrada 2 — AUDIO: dispositivo real si AUDIO_DEVICE está puesto; si no,
    // pista silenciosa (YouTube exige audio).
    ...audioInputArgs(),

    ...videoCodec,

    // Audio AAC. `aresample=async=1` mantiene la sincronía cuando el audio es
    // captura en vivo (rellena/recorta silencios por deriva del reloj).
    '-af', 'aresample=async=1',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',

    // Salida según el transporte activo: RTMP/FLV (con proxy TLS si es RTMPS) o
    // SRT/MPEG-TS. Ver outputArgs().
    ...outputArgs(activeTransport),
  ];

  const bin = activeTransport === 'srt' ? SRT_FFMPEG : RTMP_FFMPEG;
  const dst = activeTransport === 'srt' ? `srt://${SRT_HOST}:${SRT_PORT}` : `${DEST}`;
  console.log(`▶️  Arrancando ffmpeg [${activeTransport.toUpperCase()}] → ${dst}…`);
  const startedAt = Date.now();
  // fd 0 = video (stdin); fd 3 = audio PCM del relay (si AUDIO_SOURCE=relay).
  const stdio = RELAY_AUDIO ? ['pipe', 'inherit', 'inherit', 'pipe'] : ['pipe', 'inherit', 'inherit'];
  const ff = spawn(bin, args, { stdio });
  if (RELAY_AUDIO && ff.stdio[3]) ff.stdio[3].on('error', () => { /* EPIPE en reinicio */ });

  ff.on('exit', (code) => {
    const ranMs = Date.now() - startedAt;
    // Fallback: si SRT se cayó rápido (venue sin UDP, puerto bloqueado…) y está
    // habilitado, cambiamos a RTMP para el siguiente arranque.
    if (activeTransport === 'srt' && SRT_FALLBACK && ranMs < FALLBACK_MS) {
      console.warn(`⚠️  SRT cayó en ${(ranMs / 1000).toFixed(1)}s → FALLBACK a RTMP.`);
      activeTransport = 'rtmp';
    }
    console.log(`⚠️  ffmpeg terminó (código ${code}). Reiniciando en 3 s…`);
    setTimeout(() => { ffmpeg = startFfmpeg(); }, 3000);
  });
  ff.stdin.on('error', () => { /* EPIPE durante un reinicio: se ignora */ });

  return ff;
}

let ffmpeg = startFfmpeg();

// ── Pump: escribe un fotograma a ritmo constante (FPS) — SÓLO MJPEG ───────────
// Estabiliza el ritmo y decide cuándo mostrar la tarjeta de relleno. En H.264 NO
// aplica: cada access unit se escribe DIRECTO al llegar (abajo), en orden y una
// sola vez; re-escribir un AU o inyectar la CARD (un JPEG) corrompería el stream.
if (SOURCE_CODEC !== 'h264') {
  setInterval(() => {
    if (!ffmpeg || !ffmpeg.stdin.writable) return;
    const stale = Date.now() - lastRealFrameAt > GAP_MS;
    const frame = stale ? CARD : currentFrame;
    if (frame) ffmpeg.stdin.write(frame);
  }, Math.max(1, Math.round(1000 / FPS)));
}

// ── Relay (Director's Cut = programa) ────────────────────────────────────────
function connectRelay() {
  const wsUrl = `${RELAY_WS_URL}/relay?show=${encodeURIComponent(RELAY_SHOW_CODE)}&role=audience`;
  console.log('🔌 Conectando al relay (programa / Director’s Cut):', wsUrl);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => console.log('✅ Conectado. Siguiendo el PROGRAMA (Director’s Cut).'));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      lastRealFrameAt = Date.now();
      if (SOURCE_CODEC === 'h264') {
        // Access unit H.264 del programa: se escribe DIRECTO, en orden, una vez.
        // El relay ya alineó el corte a keyframe (gate + force-IDR), así que el
        // stream que llega es continuo y decodable.
        if (ffmpeg && ffmpeg.stdin.writable) ffmpeg.stdin.write(data);
      } else {
        // Fotograma JPEG del programa: se guarda; el pump lo emite a ritmo fijo.
        currentFrame = data;
      }
      return;
    }
    // Mensajes de control: sólo para el log.
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'active_cam')    console.log('🎬 Corte del director →', msg.camId);
      if (msg.type === 'no_active_cam') console.log('⏸️  Sin cámara activa (hueco de programa).');
    } catch { /* no-JSON: ignorar */ }
  });

  ws.on('close', () => { console.log('🔁 Relay cerrado. Reconectando en 2 s…'); setTimeout(connectRelay, 2000); });
  ws.on('error', (e) => console.error('Relay error:', e.message));
}

// ── Relay AUDIO (2º socket, audio-only) ──────────────────────────────────────
// Recibe el PCM del programa (el mic del iPhone del wearer activo) y lo escribe
// a pipe:3 de ffmpeg. Independiente del socket de video → no toca esa ruta.
function connectRelayAudio() {
  const wsUrl = `${RELAY_WS_URL}/relay?show=${encodeURIComponent(RELAY_SHOW_CODE)}&role=audience&audio=1`;
  console.log('🔌 Conectando al relay (AUDIO del programa):', wsUrl);
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => console.log('✅ Audio conectado. Recibiendo PCM del programa.'));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // control JSON: lo maneja el socket de video
    const pipe = ffmpeg && ffmpeg.stdio && ffmpeg.stdio[3];
    if (pipe && pipe.writable) pipe.write(data);
  });
  ws.on('close', () => { console.log('🔁 Relay audio cerrado. Reconectando en 2 s…'); setTimeout(connectRelayAudio, 2000); });
  ws.on('error', (e) => console.error('Relay audio error:', e.message));
}

connectRelay();
if (RELAY_AUDIO) connectRelayAudio();

// ── Apagado limpio ───────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n⏹️  Cerrando…');
  try { ffmpeg.stdin.end(); ffmpeg.kill('SIGINT'); } catch { /* ya cerrado */ }
  try { proxyServer && proxyServer.close(); } catch { /* ya cerrado */ }
  process.exit(0);
});

/**
 * Proxy TCP→TLS local (equivalente a stunnel). Si `target` es
 * `rtmps://host:port/path`, escucha RTMP plano en 127.0.0.1 y reenvía los bytes
 * por TLS al host RTMPS. Devuelve el destino local para ffmpeg. Si no es rtmps,
 * devuelve el destino sin tocar.
 */
function tlsProxyTarget(target) {
  const m = target.match(/^rtmps:\/\/([^:/]+)(?::(\d+))?(\/.*)$/i);
  if (!m) return target; // rtmp:// o file: → directo

  const host = m[1];
  const upstreamPort = Number(m[2] || 443);
  const targetPath = m[3];
  const localPort = Number(process.env.TLS_PROXY_PORT || 1936);

  const server = net.createServer((down) => {
    const up = tls.connect(upstreamPort, host, { servername: host }, () => {
      down.pipe(up);
      up.pipe(down);
    });
    const kill = () => { try { down.destroy(); } catch {} try { up.destroy(); } catch {} };
    up.on('error', kill);
    down.on('error', kill);
    up.on('close', kill);
    down.on('close', kill);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`❌ Puerto ${localPort} ocupado: ya hay otro encoder/proxy corriendo. Ciérralo (Ctrl+C) o usa TLS_PROXY_PORT=${localPort + 1}.`);
      process.exit(1);
    }
    console.error('Proxy TLS error:', e.message);
  });
  server.listen(localPort, '127.0.0.1', () => {
    console.log(`🔒 Proxy TLS activo: rtmp://127.0.0.1:${localPort} → rtmps://${host}:${upstreamPort} (evita el bug RTMPS de ffmpeg/OpenSSL)`);
  });
  proxyServer = server;

  return `rtmp://127.0.0.1:${localPort}${targetPath}`;
}
