export function pcmWav(values: number[], sampleRate = 24000, channels = 1) {
  const bytes = new Uint8Array(44 + values.length * 2),
    view = new DataView(bytes.buffer);
  function tag(at: number, text: string) {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  }
  tag(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, values.length * 2, true);
  values.forEach((value, i) => view.setInt16(44 + i * 2, value, true));
  return bytes;
}
