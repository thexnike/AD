// Renders ad.html to an MP4 with H.264 video + Opus audio, plus a WAV of the soundtrack.
// Usage: node render_full.js ad.html out.mp4            -> full render
//        node render_full.js ad.html - 1.5,3.6,5.4       -> preview stills only
const path = require('path');
const fs = require('fs');
const { chromium } = require('/inner_container/opt/toolchains/.nvm/versions/node/v22.23.3/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const EXE = '/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell';
const [scene = 'hosting.html', out = 'out.mp4', previews = '', scale = '2'] = process.argv.slice(2);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-crash-reporter', '--no-zygote'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('file://' + path.resolve(scene) + '?scale=' + scale);
  await page.evaluate(() => window.ready);

  for (const t of previews.split(',').filter(Boolean)) {
    const b64 = await page.evaluate(tt => { renderFrame(+tt); return document.getElementById('c').toDataURL('image/jpeg', .8).split(',')[1]; }, t);
    fs.mkdirSync(path.join(__dirname, 'previews'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'previews', `t${t}s.jpg`), Buffer.from(b64, 'base64'));
  }
  if (out === '-') { await browser.close(); return; }

  const res = await page.evaluate(async () => {
    const { W, H, FPS, DURATION } = window.sceneInfo;
    const canvas = document.getElementById('c');
    const N = Math.round(FPS * DURATION);
    const t0 = performance.now();

    // ---------- audio ----------
    const abuf = await buildAudio();
    const SR = abuf.sampleRate, L = abuf.getChannelData(0), Rr = abuf.getChannelData(1);
    let peak = 0; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rr[i]));
    const norm = peak > .98 ? .98 / peak : 1;
    if (norm !== 1) for (let i = 0; i < L.length; i++) { L[i] *= norm; Rr[i] *= norm; }
    // WAV (16-bit) for convenience
    const wav = new DataView(new ArrayBuffer(44 + L.length * 4));
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); wav.setUint32(4, 36 + L.length * 4, true); ws(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 2, true);
    wav.setUint32(24, SR, true); wav.setUint32(28, SR * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true); ws(36, 'data'); wav.setUint32(40, L.length * 4, true);
    for (let i = 0, o = 44; i < L.length; i++, o += 4) { wav.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true); wav.setInt16(o + 2, Math.max(-1, Math.min(1, Rr[i])) * 32767, true); }

    // ---------- video ----------
    const vChunks = []; let vDesc = null;
    const venc = new VideoEncoder({
      output: (c, m) => { if (m && m.decoderConfig && m.decoderConfig.description) vDesc = new Uint8Array(m.decoderConfig.description); const d = new Uint8Array(c.byteLength); c.copyTo(d); vChunks.push({ data: d, key: c.type === 'key' }); },
      error: e => console.log('VENC ERR ' + e.message),
    });
    venc.configure({ codec: window.sceneInfo.codec, width: W, height: H, bitrate: window.sceneInfo.bitrate, framerate: FPS, avc: { format: 'avc' }, latencyMode: 'quality' });
    for (let i = 0; i < N; i++) {
      renderFrame(i / FPS);
      const f = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      venc.encode(f, { keyFrame: i % FPS === 0 }); f.close();
      while (venc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
      if (i % 60 === 0) console.log(`frame ${i}/${N}  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }
    await venc.flush();

    const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
    const vAll = new Uint8Array(vChunks.reduce((s, c) => s + c.data.length, 0)); let o = 0; for (const c of vChunks) { vAll.set(c.data, o); o += c.data.length; }
    console.log(`video frames=${vChunks.length} peak=${peak.toFixed(3)} time=${((performance.now() - t0) / 1000).toFixed(0)}s`);
    return { W, H, FPS, DURATION, v: b64(vAll), sizes: vChunks.map(c => c.data.length), keys: vChunks.map(c => c.key), vDesc: b64(vDesc), wav: b64(new Uint8Array(wav.buffer)) };
  });
  const { encodeAAC, readWav } = require('./aac_enc');
  const { mux } = require('./mux');
  const wavPath = out.replace(/\.mp4$/, '') + '_soundtrack.wav';
  fs.writeFileSync(wavPath, Buffer.from(res.wav, 'base64'));
  const vAll = Buffer.from(res.v, 'base64'); let off = 0;
  const vChunks = res.sizes.map((n, i) => { const c = { data: vAll.subarray(off, off + n), key: res.keys[i] }; off += n; return c; });
  const { L, R } = readWav(wavPath);
  const { frames, asc, delay } = encodeAAC(L, R);
  const file = mux({ W: res.W, H: res.H, FPS: res.FPS, durationSec: res.DURATION, vChunks, vDesc: new Uint8Array(Buffer.from(res.vDesc, 'base64')), aFrames: frames, asc, aDelay: delay });
  fs.writeFileSync(out, file);
  console.log('wrote', out, file.length, 'bytes; AAC frames', frames.length);
  await browser.close();
})();
