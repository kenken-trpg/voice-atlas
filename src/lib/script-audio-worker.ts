import { joinScriptAudio, type ScriptAudioSource } from '../../shared/script-audio-join';
import type { VoiceScript } from '../../shared/script';

self.onmessage = async (
  event: MessageEvent<{ script: VoiceScript; sources: ScriptAudioSource[] }>,
) => {
  try {
    const result = await joinScriptAudio(event.data.script, event.data.sources);
    self.postMessage({ ok: true, result }, { transfer: [result.bytes.buffer] });
  } catch (cause) {
    self.postMessage({
      ok: false,
      error: cause instanceof Error ? cause.message : '音声を結合できませんでした。',
    });
  }
};
