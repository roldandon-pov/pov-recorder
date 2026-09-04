import WebSocket from 'ws';
import { readFileSync } from 'fs';
const frame = readFileSync(process.argv[2]);
const URL = 'wss://pov-relay-do.povlive.workers.dev/relay?show=POVCAM&role=cam&cam=c1&name=CamPrueba';
let ws, timer;
function connect() {
  ws = new WebSocket(URL);
  ws.on('open', () => { console.log(new Date().toISOString(),'cam c1 EN VIVO (show=POVCAM)'); clearInterval(timer); timer=setInterval(()=>{ if(ws.readyState===1) ws.send(frame); },100); });
  ws.on('close', ()=>{ clearInterval(timer); setTimeout(connect,1000); });
  ws.on('error', e=>console.error('cam err',e.message));
}
connect();
