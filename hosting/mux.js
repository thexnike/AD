// MP4 muxer: H.264 video track + AAC-LC audio track (plays in Windows Media Player, QuickTime, phones, TikTok).
function mux({ W, H, FPS, durationSec, vChunks, vDesc, aFrames, asc, aDelay, sampleRate = 48000 }) {
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = v => [(v >>> 8) & 255, v & 255];
  const str = s => [...s].map(c => c.charCodeAt(0));
  const cat = arrs => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const box = (type, ...parts) => { const body = cat(parts.map(p => p instanceof Uint8Array ? p : new Uint8Array(p))); return cat([new Uint8Array([...u32(body.length + 8), ...str(type)]), body]); };
  const full = (type, ver, flags, ...parts) => box(type, [ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const matrix = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  const movieDur = Math.round(durationSec * 1000);
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const desc = (tag, body) => [tag, 0x80, 0x80, 0x80, body.length, ...body];

  const build = (vOff, aOff) => {
    const VTS = FPS * 100, VD = 100;
    const avc1 = box('avc1', new Array(6).fill(0), u16(1), u16(0), u16(0), new Array(12).fill(0), u16(W), u16(H),
      u32(0x480000), u32(0x480000), u32(0), u16(1), new Array(32).fill(0), u16(0x18), u16(0xffff), box('avcC', vDesc));
    const keys = vChunks.map((c, i) => c.key ? i + 1 : 0).filter(Boolean);
    const vTrak = box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur), new Array(8).fill(0), u16(0), u16(0), u16(0), u16(0), matrix, u32(W << 16), u32(H << 16)),
      box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(VTS), u32(vChunks.length * VD), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), str('vide'), new Array(12).fill(0), str('VideoHandler'), [0]),
        box('minf', full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf,
          box('stbl', full('stsd', 0, 0, u32(1), avc1),
            full('stts', 0, 0, u32(1), u32(vChunks.length), u32(VD)),
            full('stss', 0, 0, u32(keys.length), ...keys.map(u32)),
            full('stsc', 0, 0, u32(1), u32(1), u32(vChunks.length), u32(1)),
            full('stsz', 0, 0, u32(0), u32(vChunks.length), ...vChunks.map(c => u32(c.data.length))),
            full('stco', 0, 0, u32(1), u32(vOff))))));

    const aBytes = aFrames.reduce((s, f) => s + f.length, 0);
    const avgBr = Math.round(aBytes * 8 / (aFrames.length * 1024 / sampleRate));
    const maxFrame = Math.max(...aFrames.map(f => f.length));
    const esds = full('esds', 0, 0, desc(3, [...u16(2), 0,
      ...desc(4, [0x40, 0x15, ...u32(maxFrame * 2).slice(1), ...u32(avgBr * 2), ...u32(avgBr), ...desc(5, [...asc])]),
      ...desc(6, [2])]));
    const mp4a = box('mp4a', new Array(6).fill(0), u16(1), new Array(8).fill(0), u16(2), u16(16), u16(0), u16(0), u32(sampleRate * 65536 >>> 0), esds);
    const aTrak = box('trak',
      full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(movieDur), new Array(8).fill(0), u16(0), u16(1), u16(0x100), u16(0), matrix, u32(0), u32(0)),
      box('edts', full('elst', 0, 0, u32(1), u32(movieDur), u32(aDelay), u16(1), u16(0))),
      box('mdia', full('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(aFrames.length * 1024), u16(0x55c4), u16(0)),
        full('hdlr', 0, 0, u32(0), str('soun'), new Array(12).fill(0), str('SoundHandler'), [0]),
        box('minf', full('smhd', 0, 0, u16(0), u16(0)), dinf,
          box('stbl', full('stsd', 0, 0, u32(1), mp4a),
            full('stts', 0, 0, u32(1), u32(aFrames.length), u32(1024)),
            full('stsc', 0, 0, u32(1), u32(1), u32(aFrames.length), u32(1)),
            full('stsz', 0, 0, u32(0), u32(aFrames.length), ...aFrames.map(f => u32(f.length))),
            full('stco', 0, 0, u32(1), u32(aOff))))));
    return box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDur), u32(0x10000), u16(0x100),
      new Array(10).fill(0), matrix, new Array(24).fill(0), u32(3)), vTrak, aTrak);
  };

  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const vData = cat(vChunks.map(c => c.data)), aData = cat(aFrames);
  // moov first (fast start): build once to learn its size, then with real offsets
  const moovSize = build(0, 0).length;
  const vOff = ftyp.length + moovSize + 8, aOff = vOff + vData.length;
  const moov = build(vOff, aOff);
  const mdatHdr = new Uint8Array([...u32(vData.length + aData.length + 8), ...str('mdat')]);
  return cat([ftyp, moov, mdatHdr, vData, aData]);
}
module.exports = { mux };
