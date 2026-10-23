import {
  scriptAudioKey,
  scriptLineSchema,
  scriptSpokenText,
  type ScriptLine,
  type VoiceScript,
} from './script';

export type ScriptGenerationStatus = 'waiting' | 'generating' | 'succeeded' | 'failed' | 'stopped';
export type ScriptGenerationJob = {
  id: string;
  rows: {
    lineId: string;
    key: string;
    position: number;
    text: string;
    spokenText: string;
    status: ScriptGenerationStatus;
    attempts: number;
    error?: string;
  }[];
};
export type ScriptRetryMode = 'failed' | 'unfinished';
export function generationRetryPlan(
  script: VoiceScript,
  job: ScriptGenerationJob,
  mode: ScriptRetryMode,
) {
  const selected = job.rows.filter((row) =>
    mode === 'failed' ? row.status === 'failed' : row.status !== 'succeeded',
  );
  const invalidIds = selected
    .filter((row) => {
      const line = script.lines.find((item) => item.id === row.lineId);
      return !line || scriptAudioKey(line) !== row.key;
    })
    .map((row) => row.lineId);
  const ids = new Set(selected.map((row) => row.lineId));
  return { lines: script.lines.filter((line) => ids.has(line.id)), invalidIds };
}
export function startGenerationJob(
  script: VoiceScript,
  targets: ScriptLine[],
  previous?: ScriptGenerationJob,
): ScriptGenerationJob {
  const ids = new Set(targets.map((line) => line.id));
  if (
    !ids.size ||
    ids.size !== targets.length ||
    targets.some((line) => {
      const current = script.lines.find((item) => item.id === line.id);
      return !current || scriptAudioKey(current) !== scriptAudioKey(line);
    })
  )
    throw new Error('生成対象の行を確認してください。');
  for (const line of targets) scriptLineSchema.parse(line);
  if (previous) {
    if (
      targets.some(
        (line) =>
          !previous.rows.some(
            (row) =>
              row.lineId === line.id &&
              row.key === scriptAudioKey(line) &&
              row.status !== 'succeeded',
          ),
      )
    )
      throw new Error('生成条件が変わりました。対象を選び直してください。');
    return {
      ...previous,
      rows: previous.rows.map((row) =>
        ids.has(row.lineId) ? { ...row, status: 'waiting', error: undefined } : row,
      ),
    };
  }
  return {
    id: crypto.randomUUID(),
    rows: script.lines
      .filter((line) => ids.has(line.id))
      .map((line) => ({
        lineId: line.id,
        key: scriptAudioKey(line),
        position: script.lines.findIndex((item) => item.id === line.id) + 1,
        text: line.text,
        spokenText: scriptSpokenText(line),
        status: 'waiting',
        attempts: 0,
      })),
  };
}
export function updateGenerationRow(
  job: ScriptGenerationJob,
  lineId: string,
  status: ScriptGenerationStatus,
  error?: string,
): ScriptGenerationJob {
  return {
    ...job,
    rows: job.rows.map((row) =>
      row.lineId === lineId
        ? {
            ...row,
            status,
            attempts: row.attempts + (status === 'generating' ? 1 : 0),
            error: status === 'failed' ? error?.slice(0, 250) : undefined,
          }
        : row,
    ),
  };
}
export function finishGenerationJob(job: ScriptGenerationJob): ScriptGenerationJob {
  return {
    ...job,
    rows: job.rows.map((row) =>
      row.status === 'generating' ? { ...row, status: 'stopped' } : row,
    ),
  };
}
