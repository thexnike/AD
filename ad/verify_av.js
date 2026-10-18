// Plays the MP4 in Chromium and reports video size/duration and decoded audio bytes.
const { chromium } = require('/inner_container/opt/toolchains/.nvm/versions/node/v22.23.3/lib/node_modules/@playwright/mcp/node_modules/playwright-core');
const file = process.argv[2] || 'ad_full.mp4';
(async () => {
  const b = await chromium.launch({ executablePath: '/inner_container/opt/playwright/chromium_headless_shell-1232/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--no-sandbox', '--disable-crash-reporter', '--no-zygote', '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 540, height: 960 } });
  await p.goto('file://' + __dirname + '/blank.html');
  const r = await p.evaluate(async f => {
    const v = document.createElement('video'); v.src = f; v.style.cssText = 'width:540px;height:960px'; document.body.style.margin = 0; document.body.appendChild(v);
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('decode error ' + (v.error && v.error.message))); });
    v.currentTime = 6.5; await new Promise(r => v.onseeked = r);
    await v.play(); await new Promise(r => setTimeout(r, 1500)); v.pause();
    const ctx = new AudioContext(); const src = ctx.createMediaElementSource(v); const an = ctx.createAnalyser(); src.connect(an); an.connect(ctx.destination);
    v.currentTime = 6; await new Promise(r => v.onseeked = r); await v.play(); await new Promise(r => setTimeout(r, 800));
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf); let pk = 0; for (const x of buf) pk = Math.max(pk, Math.abs(x)); v.pause();
    return { audioPeakWhilePlaying: +pk.toFixed(3), width: v.videoWidth, height: v.videoHeight, duration: v.duration, audioBytesDecoded: v.webkitAudioDecodedByteCount, videoBytesDecoded: v.webkitVideoDecodedByteCount, error: v.error };
  }, file);
  await p.screenshot({ path: __dirname + '/decoded_check.png' });
  console.log(r); await b.close();
})();
