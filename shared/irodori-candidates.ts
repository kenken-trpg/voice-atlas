import { z } from 'zod';

export const irodoriVoiceIdSchema = z.enum(['old_mage', 'executive', 'male_ai']);
export type IrodoriVoiceId = z.infer<typeof irodoriVoiceIdSchema>;

export const irodoriSelectionSchema = z
  .array(irodoriVoiceIdSchema)
  .max(3)
  .refine((ids) => new Set(ids).size === ids.length, '同じ声を重複して保存できません。');

export const irodoriCandidates = [
  {
    id: 'old_mage',
    name: '老魔術師',
    caption:
      '60代後半の男性魔術師。太く低いバリトンの男声。長年の経験を感じさせる、少し乾いた声とゆったりした話し方。落ち着いた威厳があり、語尾まで明瞭に話す。',
    review: '参照音声ありで、だいぶ良い',
    samples: [
      {
        kind: 'reference',
        label: '基準の声',
        file: 'sample_20261024_074100_778062_001.wav',
        sha256: 'da7782c15b34f14a8233a7b4577fa76216367ac9d20a9922cf2095ab08b30c35',
      },
      {
        kind: 'another',
        label: '別の台詞',
        file: 'sample_20261024_080125_913270_001.wav',
        sha256: '08e6f64fb8eacbe93be3f695f9fa69ea31146c277e5e72b0468a24564f90efb1',
      },
    ],
  },
  {
    id: 'executive',
    name: '企業幹部',
    caption:
      '40代の女性企業幹部。落ち着いた中低音の女声。知的で冷静、抑制の効いた話し方。言葉を明瞭に発音し、感情を表に出しすぎない。',
    review: '参照音声ありで、いい感じ',
    samples: [
      {
        kind: 'reference',
        label: '基準の声',
        file: 'sample_20261024_074330_564495_001.wav',
        sha256: '82e9dbbf501f8c759a90574472dd2c4025eae099dd29dcf6f853617a90c11a37',
      },
      {
        kind: 'another',
        label: '別の台詞',
        file: 'sample_20261024_080331_340379_001.wav',
        sha256: '5102fa1f2595a2d2682581095d9885ac4f0a1e027fe1afc933cdeb73c1a3d515',
      },
    ],
  },
  {
    id: 'male_ai',
    name: '男性AI',
    caption:
      '中性的な人工知能の案内音声。澄んだ中音域で、音量と話す速さが安定している。感情表現は控えめ。機械的になりすぎず、すべての言葉を正確かつ明瞭に話す。',
    review: '参照音声ありで安定。長文も破綻なく期待どおり。実際の声は男性的',
    samples: [
      {
        kind: 'reference',
        label: '基準の声',
        file: 'sample_20261024_074617_972329_001.wav',
        sha256: '9f7e0de8eca88dc5a2f8840060a9e5aa4a82108db80739e6f0f36aeb7dbcdd38',
      },
      {
        kind: 'another',
        label: '別の台詞',
        file: 'sample_20261024_075439_497791_001.wav',
        sha256: '82495315ea2cefd24676f6a84884c45501c3115314fd0d8786002790f772ad17',
      },
    ],
  },
] as const;

export const irodoriModel = 'Aratako/Irodori-TTS-v4.1-Small';
export const irodoriModelRevision = '2b28324dc263ed5e6638b3cf3dd94c82ead07b4b';
