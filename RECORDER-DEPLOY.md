# Recorder de nube (Ruta A) — deploy en Render (gratis, sin tarjeta)

Graba automáticamente cada **show rápido** (`/go/<code>`) a **Mux**, con MP4 listo
para Instagram/redes. El teléfono no hace nada extra.

## Cómo funciona el disparo automático

```
iPhone abre "New Show"
   → POST /api/go (Vercel) ── mintea code+link
                          └── webhook POST https://pov-recorder.onrender.com/record { code }
                                → server.js lanza quick-record.mjs <code>
                                    → provisiona Mux (grabación) → encoder relay→RTMPS→Mux
                                    → al terminar: activa MP4 y da el link
```
Si nadie sale al aire, se **auto-apaga** (sin dejar grabación). Render **duerme**
cuando no hay show y **despierta con el webhook**; durante la grabación se
auto-pinguea para no cortarse. Todo entra en las **750 hrs/mes gratis**.

## Paso 1 — Subir el recorder a un repo de GitHub

Desde esta carpeta (`rtmp-encoder/`), en tu Terminal:

```bash
cd ~/Desktop/POV\ TODO/POV\ NEW\ CODE/rtmp-encoder
git init && git add -A && git commit -m "POV recorder"
gh repo create pov-recorder --private --source=. --push
```

(Si no usas `gh`: crea el repo en github.com, luego
`git remote add origin <url> && git branch -M main && git push -u origin main`.)

## Paso 2 — Crear el servicio en Render

1. Entra a **render.com** y regístrate **con GitHub** (el plan free **no pide tarjeta**).
2. **New → Blueprint** → elige el repo `pov-recorder`. Render lee `render.yaml` y
   crea el servicio web Docker `pov-recorder` en plan **free**.
3. En **Environment**, pon los 3 secrets (genera el RECORDER_SECRET con
   `openssl rand -hex 24` y **guárdalo**):
   - `MUX_TOKEN_ID`  = tu token de Mux
   - `MUX_TOKEN_SECRET` = tu secret de Mux
   - `RECORDER_SECRET` = el hex que generaste
4. **Create / Deploy**. Cuando termine, tu URL será algo como
   `https://pov-recorder.onrender.com`. Pruébala:
   ```bash
   curl https://pov-recorder.onrender.com/health   # → {"ok":true,"active":[],"count":0}
   ```

## Paso 3 — Conectar el disparo en Vercel

Con la MISMA `RECORDER_SECRET`:

```bash
cd ~/Desktop/POV\ NEW\ CODE/povlive-sandbox
printf 'https://pov-recorder.onrender.com' | npx vercel env add RECORDER_URL production
printf '<el mismo hex>' | npx vercel env add RECORDER_SECRET production
npx vercel --prod --yes
```

Listo: cada show rápido queda grabado en Mux. El MP4 sale en
`https://stream.mux.com/<playbackId>/high.mp4` (lo imprime el log de la grabación
en Render, o lo ves en el dashboard de Mux).

## Notas Render free
- **Duerme** tras ~15 min sin tráfico; el primer webhook la **despierta** (~30-60 s).
  Como el disparo ocurre al abrir "New Show" (antes del GO LIVE), para cuando sales
  al aire ya está lista. `after()` en el backend garantiza que el webhook se envíe.
- **No commitees** `node_modules` (ya está en `.gitignore`).
- Secrets opcionales: `MAX_CONCURRENT` (def 4), `NO_SIGNAL_SECS` (def 480),
  `MAX_MINUTES` (def 180).
