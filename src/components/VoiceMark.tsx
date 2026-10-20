import type { CSSProperties } from 'react';

export function VoiceMark({ color, small = false }: { color: string; small?: boolean }) {
  return (
    <span
      className={`voice-mark ${small ? 'small' : ''}`}
      style={{ '--voice-color': color } as CSSProperties}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
