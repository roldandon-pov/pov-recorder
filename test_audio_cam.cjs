// Cam sintética para probar el transporte de AUDIO por el relay:
// envía video H.264 (NALs de /tmp/test.h264, flag keyframe=1) + audio PCM
// (seno 440Hz, s16le 48k mono, tag 0x02). Corre unos segundos y termina.
const fs = require('fs');
const WebSocket = require('ws');

const URL = process.env.RELAY_WS_URL || 'ws://localhost:8090';
const SHOW = process.env.SHOW || 'T';
const SECS = Number(process.env.SECS || 7);

// Partir Annex-B en NALs por start code 00000001.
const buf = fs.readFileSync('/tmp/test.h264');
const nals = [];
let last = -1;
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === 0 && buf[i+1] === 0 && buf[i+2] === 0 && buf[i+3] === 1) {
    if (last >= 0) nals.push(buf.subarray(last, i));
    last = i;
  }
}
if (last >= 0) nals.push(buf.subarray(last));
console.log('NALs:', nals.length);

const ws = new WebSocket(`${URL}/relay?show=${SHOW}&role=cam&cam=testcam&name=TEST&codec=h264`);
let vi = 0, sample = 0, videoSent = 0, audioSent = 0;

ws.on('open', () => {
  console.log('cam conectada');
  // Video: un NAL por tick a ~30/s (flag=1 keyframe → sin gate).
  const vt = setInterval(() => {
    if (ws.readyState !== 1) return;
    const nal = nals[vi % nals.length]; vi++;
    const out = Buffer.concat([Buffer.from([0x01]), nal]);
    ws.send(out); videoSent++;
  }, 33);

  // Audio: seno 440Hz, 20ms (960 muestras) por tick, tag 0x02.
  const at = setInterval(() => {
    if (ws.readyState !== 1) return;
    const N = 960, pcm = Buffer.alloc(N * 2);
    for (let n = 0; n < N; n++) {
      const v = Math.round(Math.sin(2 * Math.PI * 440 * (sample++ / 48000)) * 12000);
      pcm.writeInt16LE(v, n * 2);
    }
    ws.send(Buffer.concat([Buffer.from([0x02]), pcm])); audioSent++;
  }, 20);

  setTimeout(() => {
    clearInterval(vt); clearInterval(at); ws.close();
    console.log(`fin: video=${videoSent} audio=${audioSent}`);
    process.exit(0);
  }, SECS * 1000);
});
ws.on('error', (e) => { console.error('error:', e.message); process.exit(1); });
