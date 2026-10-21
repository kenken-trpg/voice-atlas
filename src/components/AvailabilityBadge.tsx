import { availabilityLabels, type VoiceAvailability } from '../../shared/voicevox';

export function AvailabilityBadge({ status }: { status: VoiceAvailability }) {
  return (
    <span className={`availability-badge availability-${status}`}>
      {availabilityLabels[status]}
    </span>
  );
}

export function AvailabilityHelp({ status }: { status: VoiceAvailability }) {
  const help = {
    available: '',
    missing:
      'この話者・スタイルは接続中のVOICEVOXにありません。音声ライブラリを確認して「接続を再確認」を押すか、試聴可能な候補を選んでください。',
    disconnected: 'このPCでVOICEVOXを起動し、「接続を再確認」を押してください。',
    checking: '話者・スタイルを確認中です。確認が終わるまで音声生成をお待ちください。',
    unsupported: '',
  }[status];
  return help ? <p className="footnote availability-help">{help}</p> : null;
}
