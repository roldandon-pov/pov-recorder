# Recorder de nube (Ruta A) — Node + ffmpeg para puentear relay → Mux.
FROM node:20-slim

# ffmpeg (con libx264/aac) para el encoder relay→RTMP.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Sólo la dependencia de runtime (ws). El resto es Node nativo (fetch, http).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Código del recorder: servidor + orquestador + encoder.
COPY server.js quick-record.mjs encoder.js ./

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
