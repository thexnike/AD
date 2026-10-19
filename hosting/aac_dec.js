const fs=require('fs');const {readWav}=require('./aac_enc');
const { chromium } = require('/inner_container/opt/toolchains/.nvm/versions/node/v22.23.3/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-crash-reporter','--no-zygote']});
const p=await b.newPage();await p.goto('file://'+__dirname+'/blank.html');
const file=process.argv[2]||'test.aac';
const b64=fs.readFileSync(file).toString('base64');
const r=await p.evaluate(async f=>{const bin=atob(f);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);const ab=u.buffer;const ac=new OfflineAudioContext(2,48000,48000);const buf=await ac.decodeAudioData(ab);return {sr:buf.sampleRate,len:buf.length,L:Array.from(buf.getChannelData(0))};},b64).catch(e=>({err:e.message}));
await b.close(); if(r.err){console.log('DECODE FAIL',r.err);return;}
const {L}=readWav('ad_full_soundtrack.wav');
// find alignment offset
let best=[0,-1e9];for(let off=0;off<=3000;off++){let s=0;for(let i=48000;i<96000;i+=7)s+=L[i]*(r.L[i+off]||0);if(s>best[1])best=[off,s];}
const off=best[0];let xy=0,yy=0;for(let i=0;i<L.length&&i+off<r.L.length;i++){xy+=L[i]*r.L[i+off];yy+=r.L[i+off]**2;}const g=xy/yy;console.log('gain',g);let sig=0,err=0;for(let i=0;i<L.length&&i+off<r.L.length;i++){const d=g*r.L[i+off]-L[i];sig+=L[i]*L[i];err+=d*d;}
console.log('decoded sr',r.sr,'len',r.len,'offset',off,'SNR dB',(10*Math.log10(sig/err)).toFixed(1));})();
