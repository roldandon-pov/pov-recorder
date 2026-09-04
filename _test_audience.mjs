import WebSocket from 'ws';
const ws = new WebSocket('wss://pov-relay-do.povlive.workers.dev/relay?show=DEMO&role=audience');
let bin = 0, ctrl = [];
ws.on('open', () => console.log('audiencia de prueba conectada'));
ws.on('message', (data, isBinary) => {
  if (isBinary) { bin++; }
  else { try { ctrl.push(JSON.parse(data.toString()).type); } catch {} }
});
setTimeout(() => {
  console.log('frames binarios recibidos en 6s:', bin);
  console.log('mensajes de control:', ctrl.slice(0,8).join(', ') || '(ninguno)');
  ws.close(); process.exit(0);
}, 6000);
