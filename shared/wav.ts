// Browser-compatible PCM helpers. The original row WAVs are never modified.
export const joinedSampleRate = 48000;
export const maxJoinInputBytes = 64 * 1024 * 1024;
export const maxJoinedBytes = 128 * 1024 * 1024;
export type PcmWav = { sampleRate: number; channels: number; frames: number; samples: DataView };
const invalid = () =>
  new Error(
    '結合できないWAVです。16bit PCM・モノラル/ステレオ・8〜48kHzの音声を使用してください。行別WAVはそのまま保存できます。',
  );
export function readPcmWav(bytes: Uint8Array): PcmWav {
  if (bytes.byteLength < 44 || bytes.byteLength > 20 * 1024 * 1024) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength)
    throw invalid();
  let format: { sampleRate: number; channels: number } | undefined;
  let data: DataView | undefined;
  for (let at = 12; at < bytes.byteLength;) {
    if (at + 8 > bytes.byteLength) throw invalid();
    const size = view.getUint32(at + 4, true),
      start = at + 8,
      end = start + size;
    if (end + (size % 2) > bytes.byteLength) throw invalid();
    if (tag(at) === 'fmt ') {
      if (format || size < 16 || view.getUint16(start, true) !== 1) throw invalid();
      const channels = view.getUint16(start + 2, true),
        sampleRate = view.getUint32(start + 4, true);
      if (
        ![1, 2].includes(channels) ||
        sampleRate < 8000 ||
        sampleRate > 48000 ||
        view.getUint16(start + 14, true) !== 16 ||
        view.getUint16(start + 12, true) !== channels * 2 ||
        view.getUint32(start + 8, true) !== sampleRate * channels * 2
      )
        throw invalid();
      format = { sampleRate, channels };
    } else if (tag(at) === 'data') {
      if (data) throw invalid();
      data = new DataView(bytes.buffer, bytes.byteOffset + start, size);
    }
    at = end + (size % 2);
  }
  if (!format || !data || !data.byteLength || data.byteLength % (format.channels * 2))
    throw invalid();
  return { ...format, frames: data.byteLength / (format.channels * 2), samples: data };
}
export function outputFrames(wav: PcmWav) {
  return Math.round((wav.frames * joinedSampleRate) / wav.sampleRate);
}
export function checkJoinedFrames(frames: number) {
  if (!Number.isSafeInteger(frames) || frames < 1 || 44 + frames * 2 > maxJoinedBytes)
    throw new Error('結合WAVは128MiBまでです。台本を分けるか、行別WAVを保存してください。');
}
export function normalizePcm(wav: PcmWav): Int16Array {
  const frames = outputFrames(wav);
  checkJoinedFrames(frames);
  const result = new Int16Array(frames);
  function sample(frame: number) {
    let value = wav.samples.getInt16(frame * wav.channels * 2, true);
    if (wav.channels === 2) value = (value + wav.samples.getInt16(frame * 4 + 2, true)) / 2;
    return value;
  }
  for (let i = 0; i < frames; i++) {
    const position = Math.min(wav.frames - 1, (i * wav.sampleRate) / joinedSampleRate);
    const a = Math.floor(position),
      b = Math.min(wav.frames - 1, a + 1),
      fraction = position - a;
    result[i] = Math.max(
      -32768,
      Math.min(32767, Math.round(sample(a) * (1 - fraction) + sample(b) * fraction)),
    );
  }
  return result;
}
export function encodeJoinedWav(parts: Int16Array[], gapFrames: number) {
  if (
    !parts.length ||
    parts.some((part) => !part.length) ||
    parts.length > 20 ||
    !Number.isInteger(gapFrames) ||
    gapFrames < 0 ||
    gapFrames > 5 * joinedSampleRate
  )
    throw new Error('結合する行と行間の設定が不正です。');
  const frames =
    parts.reduce((total, part) => total + part.length, 0) + gapFrames * (parts.length - 1);
  checkJoinedFrames(frames);
  const bytes = new Uint8Array(44 + frames * 2),
    view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, joinedSampleRate, true);
  view.setUint32(28, joinedSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  let at = 44;
  parts.forEach((part, index) => {
    for (const value of part) {
      view.setInt16(at, value, true);
      at += 2;
    }
    if (index < parts.length - 1) at += gapFrames * 2;
  });
  return bytes;
}
