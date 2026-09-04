# POV LIVE · Director's Cut → RTMP (Cloudflare Stream / YouTube) — prototipo

Puente que toma el **Director's Cut** (el programa que el realizador corta en
vivo) del relay de POV LIVE y lo empuja por **RTMP**. Por defecto va a
**Cloudflare Stream Live**, que entrega el HLS a `povlive.app` y hace el
**fan-out a YouTube/Facebook** por "Live Outputs" — así el encoder empuja **un
solo stream** y Cloudflare reparte.

```
5 POVs → Relay ─(audience: sigue el PROGRAMA)─► encoder.js ─► ffmpeg ─RTMP─► Cloudflare Stream Live
                                                                              ├─ HLS → povlive.app
                                                                              ├─ Live Output → YouTube
                                                                              └─ Live Output → Facebook
```

El encoder se conecta al relay como **audiencia sin fijar cámara**, así recibe
`activeCamId` (el corte del director) y el flujo cambia solo cuando él corta.
Cada fotograma JPEG entra a ffmpeg, que codifica H.264 + audio y empuja al RTMP.

## Requisitos
- **Node 18+**
- **ffmpeg** instalado (`ffmpeg -version`). En Mac: `brew install ffmpeg`.

## Configuración (variables de entorno)
| Variable | Requerido | Por defecto | Qué es |
|---|---|---|---|
| `STREAM_KEY` | **sí** | — | Clave de transmisión del destino (ver abajo) |
| `DEST` | no | `cloudflare` | `cloudflare` \| `youtube` \| `custom` |
| `RTMP_URL` | no | preset del `DEST` | URL base de ingesta (para `custom`) |
| `RELAY_WS_URL` | no | `wss://pov-relay-do.povlive.workers.dev` | Relay (Cloudflare DO; Render como fallback) |
| `RELAY_SHOW_CODE` | no | `Q7NHQR` | Código de la emisión |
| `FPS` / `WIDTH` / `HEIGHT` / `VIDEO_BITRATE` | no | `30` / `1280` / `720` / `3500k` | Salida |
| `AUDIO_DEVICE` | no | *(vacío = silencio)* | Dispositivo de audio (ver «Audio») |
| `AUDIO_BACKEND` | no | `avfoundation` | `avfoundation` (Mac) · `dshow` (Win) · `alsa` (Linux) |

Presets de RTMP: `cloudflare` → `rtmps://live.cloudflare.com:443/live` · `youtube` → `rtmp://a.rtmp.youtube.com/live2`.

## Destino A — Cloudflare Stream Live (recomendado)
1. En el **dashboard de Cloudflare → Stream → Live Inputs → Create Live Input**.
2. Copia el **RTMPS Stream Key** (la URL base ya es la del preset `cloudflare`).
3. (Opcional, el fan-out) en ese Live Input → **Outputs → Add Output**: pega la
   URL + clave RTMP de **YouTube** y de **Facebook**. Cloudflare reenvía a ambas
   en cuanto entra la señal.
4. Corre:
```bash
cd rtmp-encoder
npm install
STREAM_KEY="tu-clave-de-cloudflare" RELAY_SHOW_CODE="Q7NHQR" npm start
```
El HLS queda disponible en la URL de reproducción del Live Input (embébela en
`povlive.app`), y YouTube/FB reciben la señal por los Outputs.

## Destino B — YouTube directo (alternativa)
```bash
DEST=youtube STREAM_KEY="xxxx-xxxx-xxxx-xxxx" npm start
```
La clave sale de **YouTube Studio → Transmitir en vivo → «Clave de transmisión»**
(la cuenta debe tener las transmisiones en vivo habilitadas — la 1ª vez tarda ~24 h).

## Audio (interino, hasta el DJI)
Las **Meta Ray-Ban no publican audio** (SDK MWDAT); lo capta el iPhone. Por ahora
el encoder toma el audio de un **dispositivo de entrada de la máquina** donde
corre (mic del ambiente, el iPhone ruteado por cable/Continuity, y luego el
**DJI en el mismo input**). Sin `AUDIO_DEVICE` va silencioso.
```bash
ffmpeg -f avfoundation -list_devices true -i ""   # lista dispositivos (Mac)
#   → [3] iPhone (315) Microphone  |  [0] MacBook Pro Microphone
AUDIO_DEVICE=":3" STREAM_KEY="…" npm start          # ":3" = mic del iPhone
```
Producción (audio del propio POV al aire): el iPhone que emite la cámara enviaría
su audio por el relay y el encoder lo muxearía — trabajo de iOS + relay, pendiente.

## Probar sin cámaras reales
1. Levanta el relay local (`node server.js` en `../relay-server`, escucha en `:8080`).
2. Empuja al menos una cámara simulada al relay (o usa el simulador del sandbox).
3. `RELAY_WS_URL="ws://localhost:8080" RELAY_SHOW_CODE="TEST" STREAM_KEY="…" npm start`.

Para validar SOLO la codificación, apunta ffmpeg a un archivo en vez de RTMP y
comprueba que el `.mp4`/`.flv` sea reproducible.

## Notas y límites del prototipo
- **Fan-out**: con Cloudflare lo hacen los **Live Outputs** (no hace falta
  restreamer). YouTube/FB directos: RTMP soportado; **Instagram** no tiene API
  oficial de terceros.
- **Audio**: interino por dispositivo (ver arriba); producción vía relay pendiente.
- **Huecos de programa**: sin cámara activa, ffmpeg deja de recibir fotogramas.
  Cloudflare/YouTube toleran cortes breves; la tarjeta "POV en segundos" de
  relleno queda pendiente de regenerar (JPEG compatible con el demuxer mjpeg).
- **Despliegue**: proceso de larga duración con ffmpeg → Render (Background
  Worker), Railway, Fly.io o una VM; **no** Vercel.
