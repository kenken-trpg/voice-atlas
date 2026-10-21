import type { Capabilities, Voice } from './schema';

export interface InstalledSpeaker {
  name: string;
  styles: { name: string; id: number; type?: string }[];
}

// Use exactly the same match for preflight and synthesis. Singing styles cannot talk.
export function findVoicevoxStyle(speakers: InstalledSpeaker[], voice: Voice) {
  if (voice.engine !== 'VOICEVOX') return undefined;
  return speakers
    .find((speaker) => speaker.name === voice.name)
    ?.styles.find((style) => style.name === voice.style && (!style.type || style.type === 'talk'));
}

export type VoiceAvailability =
  'available' | 'missing' | 'disconnected' | 'checking' | 'unsupported';
export const availabilityLabels: Record<VoiceAvailability, string> = {
  available: '試聴可能',
  missing: '未導入',
  disconnected: '未接続',
  checking: '確認中',
  unsupported: 'アプリ内試聴対象外',
};

export function voiceAvailability(
  voice: Voice,
  connection: Capabilities['voicevox'] | null | undefined,
  checking = false,
): VoiceAvailability {
  if (voice.engine !== 'VOICEVOX') return 'unsupported';
  if (checking) return 'checking';
  if (!connection?.ready) return 'disconnected';
  // An older server without inventory must not claim every catalog voice is installed.
  if (!connection.availableVoiceIds) return 'checking';
  return connection.availableVoiceIds.includes(voice.id) ? 'available' : 'missing';
}
