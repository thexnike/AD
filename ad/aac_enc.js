// Minimal AAC-LC encoder (48 kHz stereo, long blocks, sine window) -> raw AAC frames for MP4.
// Huffman tables come from aac_tables.json (ISO/IEC 14496-3 codebooks).
const fs = require('fs');
const T = JSON.parse(fs.readFileSync(__dirname + '/aac_tables.json', 'utf8'));

const N = 2048, M = 1024;
const SWB = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160, 176, 196, 216,
  240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704, 736, 768, 800, 832, 864, 896, 928, 1024];
const MAX_SFB = 44;                 // up to bin 800 (~18.75 kHz)

// sine window + MDCT cosine table
const win = new Float64Array(N);
for (let n = 0; n < N; n++) win[n] = Math.sin(Math.PI / N * (n + 0.5));
const n0 = (N / 2 + 1) / 2;
const cosT = new Float64Array(N * M);
for (let k = 0; k < M; k++) for (let n = 0; n < N; n++) cosT[k * N + n] = Math.cos(2 * Math.PI / N * (n + n0) * (k + 0.5));
// Spec IMDCT: x[n] = 2/N * sum X[k] cos(...). Forward that reconstructs exactly with sine window TDAC:
function mdct(block) {           // block: Float64Array(N) of 16-bit-scale samples
  const z = new Float64Array(N); for (let n = 0; n < N; n++) z[n] = block[n] * win[n];
  const X = new Float64Array(M);
  for (let k = 0; k < M; k++) { let s = 0; const o = k * N; for (let n = 0; n < N; n++) s += z[n] * cosT[o + n]; X[k] = 2 * s; }
  return X;
}

class BitWriter {
  constructor() { this.buf = []; this.cur = 0; this.n = 0; this.bits = 0; }
  put(v, len) { for (let i = len - 1; i >= 0; i--) { this.cur = (this.cur << 1) | ((v >>> i) & 1); this.n++; this.bits++; if (this.n === 8) { this.buf.push(this.cur); this.cur = 0; this.n = 0; } } }
  align() { while (this.n) this.put(0, 1); }
  bytes() { return Uint8Array.from(this.buf); }
}

const cb11 = T['11'], sfT = T.sf;
const BITS_TARGET = 4600;           // ~430 kbps stereo (max 6144 per channel)
function quantBand(X, b, sf, q) {
  const istep = Math.pow(2, -0.25 * (sf - 100)); let nz = 0;
  for (let k = SWB[b]; k < SWB[b + 1]; k++) {
    const v = Math.min(8191, Math.floor(Math.pow(Math.abs(X[k]) * istep, 0.75) + 0.4054));
    q[k] = X[k] < 0 ? -v : v; if (v) nz = 1;
  }
  return nz;
}
function escBits(a) { if (a < 16) return 0; let Nn = 0; while (a >= (1 << (Nn + 5))) Nn++; return Nn + 1 + Nn + 4; }
function writeEsc(bw, a) { let Nn = 0; while (a >= (1 << (Nn + 5))) Nn++; for (let i = 0; i < Nn; i++) bw.put(1, 1); bw.put(0, 1); bw.put(a - (1 << (Nn + 4)), Nn + 4); }
function sections(cbs) { const s = []; for (let b = 0; b < cbs.length; b++) { if (s.length && s[s.length - 1].cb === cbs[b]) s[s.length - 1].len++; else s.push({ cb: cbs[b], len: 1 }); } return s; }
function sfDiffs(cbs, sfs) { const d = []; let prev = -1; for (let b = 0; b < MAX_SFB; b++) if (cbs[b]) { if (prev < 0) { d.push(0); } else d.push(sfs[b] - prev); prev = sfs[b]; } return d; }
function chBits(q, cbs, sfs) {
  let bits = 8 + 11 + 3 + sections(cbs).length * 9;
  for (const dd of sfDiffs(cbs, sfs)) bits += sfT.bits[dd + 60];
  for (let b = 0; b < MAX_SFB; b++) if (cbs[b]) for (let k = SWB[b]; k < SWB[b + 1]; k += 2) {
    const y = Math.abs(q[k]), z = Math.abs(q[k + 1]);
    bits += cb11.bits[Math.min(y, 16) * 17 + Math.min(z, 16)] + (y ? 1 : 0) + (z ? 1 : 0) + escBits(y) + escBits(z);
  }
  return bits;
}
function encodeChannel(X) {
  const rms = []; for (let b = 0; b < MAX_SFB; b++) { let e = 0; for (let k = SWB[b]; k < SWB[b + 1]; k++) e += X[k] * X[k]; rms.push(Math.sqrt(e / (SWB[b + 1] - SWB[b]))); }
  const peak = Math.max(...rms);
  let A = 24, res;
  for (let it = 0; it < 40; it++) {
    const q = new Int32Array(M), cbs = new Array(MAX_SFB).fill(0), sfs = new Array(MAX_SFB).fill(0);
    let prev = -1;
    for (let b = 0; b < MAX_SFB; b++) {
      if (rms[b] < 4 || rms[b] < peak * 1e-4) continue;
      const step = rms[b] / Math.pow(A, 4 / 3);
      let sf = Math.round(100 + 4 * Math.log2(step));
      // keep values within escape range
      let mx = 0; for (let k = SWB[b]; k < SWB[b + 1]; k++) mx = Math.max(mx, Math.abs(X[k]));
      sf = Math.max(sf, Math.ceil(100 + 4 * Math.log2(mx / Math.pow(8000, 4 / 3) + 1e-12)));
      sf = Math.min(255, Math.max(0, sf));
      if (prev >= 0) sf = Math.min(prev + 60, Math.max(prev - 60, sf));
      if (quantBand(X, b, sf, q)) { cbs[b] = 11; sfs[b] = sf; prev = sf; }
      else for (let k = SWB[b]; k < SWB[b + 1]; k++) q[k] = 0;
    }
    res = { q, cbs, sfs };
    if (chBits(q, cbs, sfs) <= BITS_TARGET || A < 0.3) break;
    A *= 0.85;
  }
  return res;
}
function writeICS(bw, { q, cbs, sfs }) {
  const first = cbs.findIndex(c => c);
  bw.put(first >= 0 ? sfs[first] : 0, 8);
  bw.put(0, 1); bw.put(0, 2); bw.put(0, 1); bw.put(MAX_SFB, 6); bw.put(0, 1);
  for (const s of sections(cbs)) { bw.put(s.cb, 4); let l = s.len; while (l >= 31) { bw.put(31, 5); l -= 31; } bw.put(l, 5); }
  for (const dd of sfDiffs(cbs, sfs)) bw.put(sfT.codes[dd + 60], sfT.bits[dd + 60]);
  bw.put(0, 1); bw.put(0, 1); bw.put(0, 1);
  for (let b = 0; b < MAX_SFB; b++) if (cbs[b]) for (let k = SWB[b]; k < SWB[b + 1]; k += 2) {
    const y = Math.abs(q[k]), z = Math.abs(q[k + 1]), idx = Math.min(y, 16) * 17 + Math.min(z, 16);
    bw.put(cb11.codes[idx], cb11.bits[idx]);
    if (y) bw.put(q[k] < 0 ? 1 : 0, 1);
    if (z) bw.put(q[k + 1] < 0 ? 1 : 0, 1);
    if (y >= 16) writeEsc(bw, y);
    if (z >= 16) writeEsc(bw, z);
  }
}

// L, R: Float32Array in [-1, 1], 48 kHz. Returns { frames: Uint8Array[], asc, delay }
function encodeAAC(L, R) {
  const len = L.length, nFrames = Math.ceil(len / M) + 1;
  const pad = ch => { const a = new Float64Array((nFrames + 1) * M); for (let i = 0; i < len; i++) a[i + M] = ch[i] * 32767; return a; };
  const P = [pad(L), pad(R)];
  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const bw = new BitWriter();
    bw.put(1, 3); bw.put(0, 4); bw.put(0, 1);              // CPE, tag 0, common_window 0
    for (let ch = 0; ch < 2; ch++) {
      const X = mdct(P[ch].subarray(f * M, f * M + N));
      writeICS(bw, encodeChannel(X));
    }
    bw.put(7, 3); bw.align();                              // END
    frames.push(bw.bytes());
  }
  return { frames, asc: Uint8Array.from([0x11, 0x90]), delay: M };
}

function readWav(path) {
  const b = fs.readFileSync(path); let o = 12, fmt, data;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'fmt ') fmt = o + 8; if (id === 'data') { data = [o + 8, sz]; break; } o += 8 + sz; }
  const ch = b.readUInt16LE(fmt + 2), sr = b.readUInt32LE(fmt + 4), n = data[1] / (2 * ch);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = b.readInt16LE(data[0] + i * 2 * ch) / 32768; R[i] = b.readInt16LE(data[0] + i * 2 * ch + (ch > 1 ? 2 : 0)) / 32768; }
  return { L, R, sr };
}

module.exports = { encodeAAC, readWav };
