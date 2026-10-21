import { z } from 'zod';
import {
  castingCandidateSchema,
  castingEvaluationSchema,
  castingKey,
  castingSessionSchema,
  type CastingCandidate,
  type CastingEvaluation,
  type CastingVoice,
} from './casting';
import { axes } from './schema';

export const maxCastingRecords = 1000;
export const maxCastingFiles = 20;
export const maxCastingFileBytes = 32 * 1024 * 1024;
export const maxCastingBatchBytes = 64 * 1024 * 1024;
export const castingOutcomeLabels = {
  a: 'Aを採用',
  b: 'Bを採用',
  tie: '同程度',
  undecided: '判断できない',
} as const;
const datasetSchema = z.object({
  format: z.literal('voice-atlas-casting-evaluations'),
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  records: z.array(castingEvaluationSchema).max(maxCastingRecords),
});
// Import only history. Current candidates need not exist in today's catalog.
const sessionHistorySchema = z.object({
  format: z.literal('voice-atlas-casting'),
  version: z.literal(1),
  evaluations: z.array(castingEvaluationSchema).max(100),
});
export function parseCastingEvaluationFile(input: unknown): CastingEvaluation[] {
  const dataset = datasetSchema.safeParse(input);
  if (dataset.success) return dataset.data.records;
  const session = sessionHistorySchema.safeParse(input);
  if (session.success) return session.data.evaluations;
  throw new Error(
    '製品比較セッションJSONまたは製品比較の評価JSONの形式・版・設定範囲を確認してください。',
  );
}
export function castingEvaluationKey(input: CastingEvaluation) {
  const item = castingEvaluationSchema.parse(input);
  item.recordedAt = new Date(item.recordedAt).toISOString();
  item.generations.forEach((info) => {
    if (info) info.checkedAt = new Date(info.checkedAt).toISOString();
  });
  item.candidates.forEach((candidate) => {
    if (candidate.voice.engine === 'AivisSpeech')
      candidate.voice.speakerUuid = candidate.voice.speakerUuid.toLowerCase();
    if (candidate.modelInfo) {
      candidate.modelInfo.checkedAt = new Date(candidate.modelInfo.checkedAt).toISOString();
      candidate.modelInfo.modelUuid = candidate.modelInfo.modelUuid.toLowerCase();
      candidate.modelInfo.speakerUuid = candidate.modelInfo.speakerUuid.toLowerCase();
    }
  });
  return JSON.stringify(item);
}
export function mergeCastingEvaluations(
  existing: CastingEvaluation[],
  incoming: CastingEvaluation[],
) {
  const records = new Map<string, CastingEvaluation>();
  let duplicates = 0;
  for (const [items, countDuplicate] of [
    [existing, false],
    [incoming, true],
  ] as const) {
    for (const item of items) {
      const clean = castingEvaluationSchema.parse(item),
        key = castingEvaluationKey(clean);
      if (records.has(key)) {
        if (countDuplicate) duplicates++;
      } else records.set(key, clean);
      if (records.size > maxCastingRecords)
        throw new Error('製品比較の集計は1000件までです。現在の集計は保持しています。');
    }
  }
  return {
    records: [...records.values()].sort(
      (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt),
    ),
    duplicates,
  };
}
export function makeCastingDataset(records: CastingEvaluation[]) {
  return datasetSchema.parse({
    format: 'voice-atlas-casting-evaluations',
    version: 1,
    createdAt: new Date().toISOString(),
    records,
  });
}
export function castingVoiceLabel(voice: CastingVoice) {
  return `${voice.engine} · ${voice.name} / ${voice.style}`;
}
export function adoptedCastingCandidate(item: CastingEvaluation) {
  return item.outcome === 'a'
    ? item.candidates[0]
    : item.outcome === 'b'
      ? item.candidates[1]
      : null;
}
export interface CastingFilters {
  outcome: 'all' | CastingEvaluation['outcome'];
  engine: 'all' | CastingVoice['engine'];
  adoptedEngine: 'all' | CastingVoice['engine'];
  pair: 'all' | 'cross' | 'same';
  voice: string;
  query: string;
}
export const defaultCastingFilters: CastingFilters = {
  outcome: 'all',
  engine: 'all',
  adoptedEngine: 'all',
  pair: 'all',
  voice: 'all',
  query: '',
};
export function filterCastingEvaluations(records: CastingEvaluation[], filter: CastingFilters) {
  return records.filter((item) => {
    const adopted = adoptedCastingCandidate(item);
    const cross = item.candidates[0].voice.engine !== item.candidates[1].voice.engine;
    const haystack = [
      item.text,
      item.reason,
      item.characterInput?.text ?? '',
      item.characterInput?.direction ?? '',
      ...item.candidates.map(
        (candidate) => `${castingVoiceLabel(candidate.voice)} ${castingKey(candidate.voice)}`,
      ),
      ...item.generations.map((info) => info?.engineVersion ?? ''),
      ...item.candidates.map((candidate) =>
        candidate.modelInfo
          ? [
              candidate.modelInfo.modelName,
              candidate.modelInfo.modelVersion,
              ...candidate.modelInfo.creators,
            ].join(' ')
          : '',
      ),
    ]
      .join('\n')
      .toLocaleLowerCase();
    return (
      (filter.outcome === 'all' || item.outcome === filter.outcome) &&
      (filter.engine === 'all' ||
        item.candidates.some((candidate) => candidate.voice.engine === filter.engine)) &&
      (filter.adoptedEngine === 'all' || adopted?.voice.engine === filter.adoptedEngine) &&
      (filter.pair === 'all' || (filter.pair === 'cross' ? cross : !cross)) &&
      (filter.voice === 'all' ||
        item.candidates.some((candidate) => castingKey(candidate.voice) === filter.voice)) &&
      haystack.includes(filter.query.trim().toLocaleLowerCase())
    );
  });
}
// Validate the entire new working state before the caller changes anything.
export function resumeCastingEvaluation(
  existing: Record<string, CastingCandidate>,
  input: CastingEvaluation,
) {
  const evaluation = castingEvaluationSchema.parse(input);
  const adopted = adoptedCastingCandidate(evaluation);
  if (!adopted)
    throw new Error('採用した声のない記録です。AまたはBを採用した評価を選んでください。');
  const candidates = { ...existing };
  for (const saved of evaluation.candidates) {
    const parsed = castingCandidateSchema.safeParse(saved);
    if (!parsed.success)
      throw new Error(
        '現在のカタログと照合できない話者が含まれています。履歴と現在の比較は保持しています。',
      );
    candidates[castingKey(parsed.data.voice)] = parsed.data;
  }
  if (Object.keys(candidates).length > 200)
    throw new Error('比較候補の上限200件を超えるため再開できません。現在の比較は保持しています。');
  const pair = evaluation.candidates.map((candidate) => castingKey(candidate.voice)) as [
    string,
    string,
  ];
  const selected = castingKey(adopted.voice);
  const context = { profile: evaluation.profile, characterInput: evaluation.characterInput };
  castingSessionSchema.parse({
    format: 'voice-atlas-casting',
    version: 1,
    createdAt: new Date().toISOString(),
    text: evaluation.text,
    candidates: Object.values(candidates),
    comparisonKeys: pair,
    selectedKey: selected,
    evaluations: [],
    comparisonContext: context,
  });
  return { candidates, pair, selected, text: evaluation.text, context };
}
function csvCell(value: string | number | null) {
  if (value === null) return '""';
  let text = String(value);
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function castingEvaluationsCsv(records: CastingEvaluation[]) {
  const fields = [
    'speedScale',
    'pitchScale',
    'intonationScale',
    'volumeScale',
    'prePhonemeLength',
    'postPhonemeLength',
    'tempoDynamicsScale',
  ] as const;
  const headers = [
    'recorded_at',
    'outcome',
    'adopted_engine',
    'adopted_voice',
    'sample_text',
    'reason',
    ...axes,
    'input_mode',
    'character_text',
    'direction',
    ...['a', 'b'].flatMap((prefix) =>
      [
        'engine',
        'voice_id',
        'speaker_uuid',
        'name',
        'style',
        ...fields,
        'engine_version',
        'checked_at',
        'observed_style_id',
        'model_uuid',
        'model_name',
        'model_version',
        'model_creators',
        'model_license_status',
        'model_license_text',
        'model_links',
        'model_source',
        'model_checked_at',
      ].map((field) => `${prefix}_${field}`),
    ),
  ];
  const rows = records.map((input) => {
    const item = castingEvaluationSchema.parse(input),
      adopted = adoptedCastingCandidate(item);
    return [
      item.recordedAt,
      item.outcome,
      adopted?.voice.engine ?? null,
      adopted ? castingVoiceLabel(adopted.voice) : null,
      item.text,
      item.reason,
      ...axes.map((axis) => item.profile[axis]),
      item.characterInput?.mode ?? null,
      item.characterInput?.text ?? null,
      item.characterInput?.direction ?? null,
      ...item.candidates.flatMap((candidate, i) => {
        const voice = candidate.voice,
          info = item.generations[i];
        return [
          voice.engine,
          voice.engine === 'VOICEVOX' ? voice.voiceId : null,
          voice.engine === 'AivisSpeech' ? voice.speakerUuid : null,
          voice.name,
          voice.style,
          ...fields.map((field) =>
            field === 'tempoDynamicsScale'
              ? candidate.recipe.engine === 'AivisSpeech'
                ? candidate.recipe.tempoDynamicsScale
                : null
              : candidate.recipe[field],
          ),
          info?.engineVersion ?? null,
          info?.checkedAt ?? null,
          info?.observedStyleId ?? null,
          candidate.modelInfo?.modelUuid ?? null,
          candidate.modelInfo?.modelName ?? null,
          candidate.modelInfo?.modelVersion ?? null,
          candidate.modelInfo?.creators.join(' ／ ') ?? null,
          candidate.modelInfo?.licenseStatus ?? null,
          candidate.modelInfo?.licenseText ?? null,
          candidate.modelInfo ? JSON.stringify(candidate.modelInfo.links) : null,
          candidate.modelInfo?.source ?? null,
          candidate.modelInfo?.checkedAt ?? null,
        ];
      }),
    ];
  });
  return (
    '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
