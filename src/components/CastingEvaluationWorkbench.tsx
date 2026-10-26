import { useMemo, useRef, useState } from 'react';
import {
  adoptedCastingCandidate,
  castingOutcomeLabels,
  castingVoiceLabel,
  defaultCastingFilters,
  filterCastingEvaluations,
  makeCastingDataset,
  mergeCastingEvaluations,
  parseCastingEvaluationFile,
  castingEvaluationsCsv,
  maxCastingBatchBytes,
  maxCastingFileBytes,
  maxCastingFiles,
  maxCastingRecords,
  type CastingFilters,
} from '../../shared/casting-dataset';
import { castingKey, castingRecipeSummary, type CastingEvaluation } from '../../shared/casting';
import { download } from '../lib/http';
import { CharacterContext } from './CharacterContext';
import { AivisModelDetails } from './AivisModelDetails';
import { axes, axisLabels } from '../../shared/schema';

export function CastingEvaluationWorkbench({
  currentEvaluations,
  disabled,
  onResume,
  onRegister,
}: {
  currentEvaluations: CastingEvaluation[];
  disabled: boolean;
  onResume: (item: CastingEvaluation) => void;
  onRegister: (item: CastingEvaluation) => void;
}) {
  const [records, setRecords] = useState<CastingEvaluation[]>([]);
  const [filters, setFilters] = useState<CastingFilters>({ ...defaultCastingFilters });
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const filtered = useMemo(() => filterCastingEvaluations(records, filters), [records, filters]);
  const summary = useMemo(() => {
    const outcomes = { a: 0, b: 0, tie: 0, undecided: 0 };
    const adopted: Record<'VOICEVOX' | 'AivisSpeech' | 'ElevenLabs', number> = {
      VOICEVOX: 0,
      AivisSpeech: 0,
      ElevenLabs: 0,
    };
    records.forEach((item) => {
      outcomes[item.outcome]++;
      const selected = adoptedCastingCandidate(item);
      if (selected) adopted[selected.voice.engine]++;
    });
    return { outcomes, adopted };
  }, [records]);
  const voiceOptions = useMemo(
    () =>
      [
        ...new Map(
          records.flatMap((record) =>
            record.candidates.map(
              (candidate) =>
                [castingKey(candidate.voice), castingVoiceLabel(candidate.voice)] as const,
            ),
          ),
        ).entries(),
      ].sort((a, b) => a[1].localeCompare(b[1], 'ja')),
    [records],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const visible = filtered.slice(currentPage * 25, (currentPage + 1) * 25);
  function changeFilter<K extends keyof CastingFilters>(key: K, value: CastingFilters[K]) {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPage(0);
  }
  function add(items: CastingEvaluation[]) {
    const merged = mergeCastingEvaluations(records, items);
    setRecords(merged.records);
    setPage(0);
    setNotice(
      `${merged.records.length - records.length}件追加・重複${merged.duplicates}件。製品比較の集計は${merged.records.length}件です。${items.length ? '' : '評価履歴はありません。'}`,
    );
  }
  async function importFiles(files: FileList | null) {
    if (!files?.length || importing.current) return;
    importing.current = true;
    setLoading(true);
    setNotice('');
    setError('');
    try {
      const selected = Array.from(files);
      if (selected.length > maxCastingFiles) throw new Error('一回20ファイルまで読み込めます。');
      if (selected.some((file) => file.size > maxCastingFileBytes))
        throw new Error('各JSONは32MiB以下にしてください。');
      if (selected.reduce((sum, file) => sum + file.size, 0) > maxCastingBatchBytes)
        throw new Error('一回の合計は64MiB以下にしてください。');
      const incoming: CastingEvaluation[] = [];
      for (const file of selected)
        incoming.push(...parseCastingEvaluationFile(JSON.parse(await file.text())));
      add(incoming);
    } catch (e) {
      setError(
        `${e instanceof Error && !(e instanceof SyntaxError) ? e.message : '有効なJSONでないファイルがあります。'} 集計と現在の比較は変更していません。`,
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }
  function resume(item: CastingEvaluation) {
    setError('');
    setNotice('');
    try {
      onResume(item);
      setNotice(
        '採用した声と当時の比較条件を比較欄へ戻しました。音声は再生成してください。集計と過去の履歴は保持しています。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '比較を再開できませんでした。');
    }
  }
  return (
    <section className="evaluation-workbench" aria-label="製品比較の履歴集計">
      <h2>採用した声を、記録から見つける</h2>
      <p>
        比較セッションJSONや製品比較の評価JSONをまとめて読み込めます。同じ記録の重複を除き、評価時の調声値と生成情報を保持します。取り込みと絞り込みは現在の比較を変更しません。
      </p>
      <p className="footnote">
        読み込みはブラウザー内で処理し、再読み込みで集計は消えます。最大{maxCastingRecords}
        件・一回20ファイル・各32MiB・合計64MiBです。
      </p>
      <div className="evaluation-actions">
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => inputRef.current?.click()}
        >
          {loading ? '製品比較の履歴を読み込み中…' : '製品比較のJSONをまとめて読み込む'}
        </button>
        <input
          ref={inputRef}
          hidden
          multiple
          type="file"
          accept=".json,application/json"
          aria-label="製品比較集計用JSONファイル"
          onChange={(event) => void importFiles(event.target.files)}
        />
        <button
          className="secondary-button"
          disabled={loading || !currentEvaluations.length}
          onClick={() => {
            if (importing.current) return;
            setError('');
            setNotice('');
            try {
              add(currentEvaluations);
            } catch (e) {
              setError(e instanceof Error ? e.message : '追加できませんでした。');
            }
          }}
        >
          現在の製品比較記録を追加（{currentEvaluations.length}件）
        </button>
        <button
          className="text-button"
          disabled={loading || !records.length}
          onClick={() => {
            setRecords([]);
            setPage(0);
            setFilters({ ...defaultCastingFilters });
            setError('');
            setNotice('製品比較の集計をクリアしました。現在の比較とその評価履歴は保持しています。');
          }}
        >
          製品比較の集計をクリア
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="evaluation-summary" aria-label="製品比較の全記録集計">
        <strong>集計した製品比較：{records.length}件</strong>
        <p>
          {Object.entries(castingOutcomeLabels)
            .map(
              ([key, title]) =>
                `${title}：${summary.outcomes[key as CastingEvaluation['outcome']]}件`,
            )
            .join(' ／ ')}
        </p>
        <p>
          採用した製品 — VOICEVOX：{summary.adopted.VOICEVOX}件 ／ AivisSpeech：
          {summary.adopted.AivisSpeech}件 ／ ElevenLabs：{summary.adopted.ElevenLabs}件
        </p>
      </div>
      <div className="evaluation-filters">
        <label>
          製品比較の判断
          <select
            aria-label="製品比較の判断"
            value={filters.outcome}
            disabled={loading}
            onChange={(event) =>
              changeFilter('outcome', event.target.value as CastingFilters['outcome'])
            }
          >
            <option value="all">すべての判断</option>
            {Object.entries(castingOutcomeLabels).map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          比較に含まれる製品
          <select
            aria-label="比較に含まれる製品"
            value={filters.engine}
            disabled={loading}
            onChange={(event) =>
              changeFilter('engine', event.target.value as CastingFilters['engine'])
            }
          >
            <option value="all">すべての製品</option>
            <option>VOICEVOX</option>
            <option>AivisSpeech</option>
            <option>ElevenLabs</option>
          </select>
        </label>
        <label>
          採用した製品
          <select
            aria-label="採用した製品"
            value={filters.adoptedEngine}
            disabled={loading}
            onChange={(event) =>
              changeFilter('adoptedEngine', event.target.value as CastingFilters['adoptedEngine'])
            }
          >
            <option value="all">すべての製品</option>
            <option>VOICEVOX</option>
            <option>AivisSpeech</option>
            <option>ElevenLabs</option>
          </select>
        </label>
        <label>
          製品の組み合わせ
          <select
            aria-label="製品の組み合わせ"
            value={filters.pair}
            disabled={loading}
            onChange={(event) => changeFilter('pair', event.target.value as CastingFilters['pair'])}
          >
            <option value="all">すべての比較</option>
            <option value="cross">異なる製品の比較</option>
            <option value="same">同じ製品の比較</option>
          </select>
        </label>
        <label>
          比較した話者・スタイル
          <select
            aria-label="比較した話者・スタイル"
            value={filters.voice}
            disabled={loading}
            onChange={(event) => changeFilter('voice', event.target.value)}
          >
            <option value="all">すべての話者・スタイル</option>
            {voiceOptions.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          製品比較の理由・セリフ・設定で検索
          <input
            type="search"
            maxLength={300}
            value={filters.query}
            disabled={loading}
            onChange={(event) => changeFilter('query', event.target.value)}
          />
        </label>
      </div>
      <div className="evaluation-actions">
        <button
          className="secondary-button"
          disabled={loading || !records.length}
          onClick={() =>
            download(
              'voice-atlas-casting-evaluations.json',
              JSON.stringify(makeCastingDataset(records), null, 2),
            )
          }
        >
          製品比較の集計全体をJSONで保存
        </button>
        <button
          className="secondary-button"
          disabled={loading || !filtered.length}
          onClick={() =>
            download(
              'voice-atlas-casting-evaluations.csv',
              castingEvaluationsCsv(filtered),
              'text/csv;charset=utf-8',
            )
          }
        >
          製品比較の絞り込み結果をCSVで保存
        </button>
      </div>
      <p role="status">表示条件に合う製品比較：{filtered.length}件</p>
      <p className="footnote">
        CSVは表示条件に合う全件、JSONは集計全体を保存します。記録にスコア・順位を補いません。「この採用声で比較を再開」は当時の2候補の調整と共通セリフを比較欄へ戻し、ほかの候補設定と過去の評価は保持します。再開する2候補で編集中の調整は置き換わります。
      </p>
      {!filtered.length && (
        <p>
          {records.length
            ? 'この条件に合う製品比較はありません。'
            : '評価履歴を含むJSONを読み込むか、現在の製品比較記録を追加してください。'}
        </p>
      )}
      <ol className="evaluation-records" start={currentPage * 25 + 1}>
        {visible.map((item, i) => {
          const adopted = adoptedCastingCandidate(item);
          return (
            <li key={currentPage * 25 + i}>
              <article>
                <h3>{castingOutcomeLabels[item.outcome]}</h3>
                {item.candidates.map((candidate, j) => (
                  <p key={j}>
                    {j === 0 ? 'A' : 'B'}：{castingVoiceLabel(candidate.voice)}
                  </p>
                ))}
                {adopted && <p>採用した声：{castingVoiceLabel(adopted.voice)}</p>}
                <p className="evaluation-text">セリフ：{item.text}</p>
                <p className="evaluation-text">理由：{item.reason || '記入なし'}</p>
                <p>記録日時：{new Date(item.recordedAt).toLocaleString('ja-JP')}</p>
                <details>
                  <summary>製品比較の評価時の条件</summary>
                  {item.candidates.map((candidate, j) => (
                    <div key={j}>
                      <strong>
                        {j === 0 ? 'A' : 'B'}：{candidate.voice.engine}
                      </strong>
                      <p className="evaluation-text">{castingRecipeSummary(candidate)}</p>
                      <p>
                        {item.generations[j]
                          ? `エンジン版：${item.generations[j]!.engineVersion ?? '未取得'} ／ 確認日時：${new Date(item.generations[j]!.checkedAt).toLocaleString('ja-JP')}`
                          : '生成情報：記録なし'}
                      </p>
                    </div>
                  ))}
                  <p>
                    声の方向：
                    {axes.map((axis) => `${axisLabels[axis]} ${item.profile[axis]}`).join(' ／ ')}
                  </p>
                </details>
                {item.candidates
                  .filter((candidate) => candidate.voice.engine === 'AivisSpeech')
                  .map((candidate, j) => (
                    <AivisModelDetails key={j} historical saved={candidate.modelInfo} />
                  ))}
                <CharacterContext input={item.characterInput ?? undefined} />
                <button
                  className="secondary-button"
                  disabled={loading || disabled || !adopted}
                  onClick={() => resume(item)}
                >
                  この採用声で比較を再開
                </button>
                {adopted && (
                  <button
                    className="secondary-button"
                    disabled={loading || disabled}
                    onClick={() => onRegister(item)}
                  >
                    採用声を登録
                  </button>
                )}
                {!adopted && <small>同程度・判断できない記録には採用した声がありません。</small>}
              </article>
            </li>
          );
        })}
      </ol>
      {filtered.length > 25 && (
        <div className="evaluation-actions">
          <button
            className="secondary-button"
            disabled={currentPage === 0 || loading}
            onClick={() => setPage(currentPage - 1)}
          >
            製品比較の前のページ
          </button>
          <span>
            {currentPage + 1} / {Math.ceil(filtered.length / 25)}ページ
          </span>
          <button
            className="secondary-button"
            disabled={(currentPage + 1) * 25 >= filtered.length || loading}
            onClick={() => setPage(currentPage + 1)}
          >
            製品比較の次のページ
          </button>
        </div>
      )}
    </section>
  );
}
