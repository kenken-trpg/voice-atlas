import { useMemo, useRef, useState } from 'react';
import { catalogReviewedAt, catalogRevision } from '../../shared/catalog';
import { recommendationRevision } from '../../shared/recommend';
import {
  analyzeEvaluation,
  evaluationVoiceLabel,
  evaluationsCsv,
  makeEvaluationDataset,
  maxEvaluationBatchBytes,
  maxEvaluationFileBytes,
  maxEvaluationFiles,
  maxEvaluationRecords,
  mergeEvaluationRecords,
  outcomeLabels,
  parseEvaluationFile,
  relationLabels,
  recordedRelationLabels,
  summarizeEvaluations,
  type EvaluationRecord,
  type ScoreRelation,
  type RecordedScoreRelation,
} from '../../shared/evaluation-dataset';
import type { Evaluation } from '../../shared/saved-recipe';
import { axes, axisLabels, recipeFields } from '../../shared/schema';
import { download } from '../lib/http';
import { EvaluationProvenance } from './EvaluationProvenance';
import { CharacterContext } from './CharacterContext';

const pageSize = 25;
export function EvaluationWorkbench({ currentEvaluations }: { currentEvaluations: Evaluation[] }) {
  const [records, setRecords] = useState<EvaluationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<'all' | Evaluation['outcome']>('all');
  const [relation, setRelation] = useState<'all' | ScoreRelation>('all');
  const [recordedRelation, setRecordedRelation] = useState<'all' | RecordedScoreRelation>('all');
  const [revision, setRevision] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const analyzed = useMemo(
    () => records.map((record) => ({ ...record, analysis: analyzeEvaluation(record.evaluation) })),
    [records],
  );
  const summary = useMemo(() => summarizeEvaluations(records), [records]);
  function revisionKey(evaluation: Evaluation) {
    return evaluation.evidence
      ? JSON.stringify([evaluation.evidence.algorithmRevision, evaluation.evidence.catalogRevision])
      : 'unrecorded';
  }
  const revisionGroups = [...new Set(records.map(({ evaluation }) => revisionKey(evaluation)))].map(
    (key) => ({
      key,
      label:
        key === 'unrecorded' ? '記録なし（旧記録）' : (JSON.parse(key) as string[]).join(' / '),
      count: records.filter(({ evaluation }) => revisionKey(evaluation) === key).length,
    }),
  );
  const filtered = analyzed.filter(({ evaluation, analysis }) => {
    const haystack = [
      evaluation.reason,
      evaluation.sampleText,
      evaluation.characterInput?.text ?? '',
      evaluation.characterInput?.direction ?? '',
      ...evaluation.candidates.map((candidate) => evaluationVoiceLabel(candidate.voiceId)),
    ]
      .join('\n')
      .toLocaleLowerCase();
    return (
      (outcome === 'all' || evaluation.outcome === outcome) &&
      (relation === 'all' || analysis.relation === relation) &&
      (recordedRelation === 'all' || analysis.recordedRelation === recordedRelation) &&
      (revision === 'all' || revisionKey(evaluation) === revision) &&
      haystack.includes(query.trim().toLocaleLowerCase())
    );
  });
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function addRecords(incoming: EvaluationRecord[]) {
    const merged = mergeEvaluationRecords(records, incoming);
    const added = merged.records.length - records.length;
    setRecords(merged.records);
    setPage(0);
    setMessage(
      `${added}件追加・重複${merged.duplicates}件。集計は${merged.records.length}件です。${incoming.length === 0 ? '読み込んだファイルに評価履歴はありません。' : ''}`,
    );
  }
  async function importFiles(files: FileList | null) {
    if (!files?.length || importingRef.current) return;
    importingRef.current = true;
    setLoading(true);
    setMessage('');
    setError('');
    try {
      const selected = Array.from(files);
      if (selected.length > maxEvaluationFiles)
        throw new Error('一度に読み込めるJSONは20ファイルまでです。');
      if (selected.some((file) => file.size > maxEvaluationFileBytes))
        throw new Error('各JSONは32MB以下にしてください。');
      if (selected.reduce((sum, file) => sum + file.size, 0) > maxEvaluationBatchBytes)
        throw new Error('一度に読み込むJSONの合計は64MB以下にしてください。');
      const incoming: EvaluationRecord[] = [];
      for (const file of selected) {
        let input: unknown;
        try {
          input = JSON.parse(await file.text());
        } catch {
          throw new Error('有効なJSONでないファイルがあります。集計は変更していません。');
        }
        incoming.push(...parseEvaluationFile(input));
      }
      // Validate every file before committing anything, including capacity checks.
      addRecords(incoming);
    } catch (e) {
      setError(e instanceof Error ? e.message : '評価を読み込めませんでした。');
    } finally {
      importingRef.current = false;
      setLoading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }
  function addCurrent() {
    setError('');
    setMessage('');
    try {
      addRecords(
        currentEvaluations.map((evaluation) => ({
          evaluation,
          sourceCatalogDates: [catalogReviewedAt],
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '評価を追加できませんでした。');
    }
  }
  return (
    <section className="evaluation-workbench" aria-label="評価記録の集計" id="evaluation-workbench">
      <h2>比較の記録から、推薦を確かめる</h2>
      <p>
        複数のレシピJSONや評価JSONをまとめ、選択理由と比較条件を確認できます。同じ記録の重複は除きます。
      </p>
      <p className="footnote">
        読み込みはブラウザー内で処理します。集計はこの画面のメモリーに保持し、再読み込みで消えます。作業中のレシピを置き換えずに追加できます。
      </p>
      <div className="evaluation-actions">
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => inputRef.current?.click()}
        >
          {loading ? '評価を読み込み中…' : '評価のJSONをまとめて読み込む'}
        </button>
        <input
          ref={inputRef}
          hidden
          type="file"
          accept=".json,application/json"
          multiple
          aria-label="集計用JSONファイル"
          onChange={(e) => void importFiles(e.target.files)}
        />
        <button
          className="secondary-button"
          disabled={loading || !currentEvaluations.length}
          onClick={addCurrent}
        >
          現在の比較記録を追加（{currentEvaluations.length}件）
        </button>
        <button
          className="text-button"
          disabled={loading || !records.length}
          onClick={() => {
            setRecords([]);
            setError('');
            setMessage('集計をクリアしました。');
            setPage(0);
            setRevision('all');
          }}
        >
          集計をクリア
        </button>
      </div>
      <p className="footnote">
        最大{maxEvaluationRecords}件。1回20ファイル・合計64MBまで、各ファイル32MBまで。
      </p>
      {error && (
        <p role="alert" className="evaluation-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="evaluation-summary" aria-label="全記録の集計">
        <strong>集計した評価：{summary.total}件</strong>
        <p>
          Aを採用：{summary.outcomes.a}件 ／ Bを採用：{summary.outcomes.b}件 ／ 同程度：
          {summary.outcomes.tie}件 ／ 判断できない：{summary.outcomes.undecided}件
        </p>
        <p>
          現行スコアとの関係 — 高スコアを採用：{summary.relations.higher}件 ／ 低スコアを採用：
          {summary.relations.lower}件 ／ スコア同点を採用：{summary.relations.equal}件 ／
          比較できない採用記録：
          {summary.relations.unavailable}件
        </p>
        <p>
          評価時スコアとの関係 — 高スコアを採用：{summary.recordedRelations.higher}件 ／
          低スコアを採用：{summary.recordedRelations.lower}件 ／ スコア同点を採用：
          {summary.recordedRelations.equal}件 ／ 評価時の記録なし：
          {summary.recordedRelations.unrecorded}件
        </p>
        {revisionGroups.length > 0 && (
          <details>
            <summary>評価時の版別の件数</summary>
            <ul>
              {revisionGroups.map((group) => (
                <li key={group.key}>
                  {group.label}：{group.count}件
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <p className="footnote">
        現行スコアは現在のカタログ（{catalogRevision}・確認日：{catalogReviewedAt}）と推薦式（
        {recommendationRevision}
        ）で再計算します。評価時スコアは保存した値を表示し、旧記録には補いません。順位はVOICEVOX全候補内で、利用可否・画面の絞り込みを適用しません。同点の順位差を採用スコアの高低に数えず、同程度・判断できない記録も高低の集計から除きます。調声値の効果はスコアに含みません。
      </p>
      <div className="evaluation-filters">
        <label>
          判断で絞り込む
          <select
            value={outcome}
            disabled={loading}
            onChange={(e) => {
              setOutcome(e.target.value as typeof outcome);
              setPage(0);
            }}
          >
            <option value="all">すべての判断</option>
            {Object.entries(outcomeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          現行スコアとの関係
          <select
            value={relation}
            disabled={loading}
            onChange={(e) => {
              setRelation(e.target.value as typeof relation);
              setPage(0);
            }}
          >
            <option value="all">すべての関係</option>
            {Object.entries(relationLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          評価時スコアとの関係
          <select
            value={recordedRelation}
            disabled={loading}
            onChange={(e) => {
              setRecordedRelation(e.target.value as typeof recordedRelation);
              setPage(0);
            }}
          >
            <option value="all">すべての関係</option>
            {Object.entries(recordedRelationLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          評価時の版で絞り込む
          <select
            value={revision}
            disabled={loading}
            onChange={(e) => {
              setRevision(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">すべての版</option>
            {revisionGroups.map((group) => (
              <option key={group.key} value={group.key}>
                {group.label}（{group.count}件）
              </option>
            ))}
          </select>
        </label>
        <label>
          理由・セリフ・候補名で検索
          <input
            type="search"
            value={query}
            maxLength={300}
            disabled={loading}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
      </div>
      <div className="evaluation-actions">
        <button
          className="secondary-button"
          disabled={loading || !records.length}
          onClick={() =>
            download(
              'voice-atlas-evaluations.json',
              JSON.stringify(makeEvaluationDataset(records), null, 2),
            )
          }
        >
          集計全体をJSONで保存
        </button>
        <button
          className="secondary-button"
          disabled={loading || !filtered.length}
          onClick={() =>
            download(
              'voice-atlas-evaluations.csv',
              evaluationsCsv(filtered),
              'text/csv;charset=utf-8',
            )
          }
        >
          絞り込み結果をCSVで保存
        </button>
      </div>
      <p className="footnote">
        保存にはセリフ・理由・比較条件を含みます。CSVは表示条件に合う全件、JSONは集計全体を保存します。
      </p>
      <p role="status">表示条件に合う評価：{filtered.length}件</p>
      {!filtered.length && (
        <p>
          {records.length
            ? 'この条件に合う評価はありません。絞り込みを変更してください。'
            : '比較記録を追加するか、評価履歴を含むJSONを読み込んでください。'}
        </p>
      )}
      <ol className="evaluation-records" start={currentPage * pageSize + 1}>
        {visible.map(({ evaluation, sourceCatalogDates, analysis }, index) => (
          <li key={currentPage * pageSize + index}>
            <article>
              <h3>
                {outcomeLabels[evaluation.outcome]}{' '}
                <small>
                  ／ 現行：{relationLabels[analysis.relation]} ／ 評価時：
                  {recordedRelationLabels[analysis.recordedRelation]}
                </small>
              </h3>
              <p>現行：VOICEVOX全{analysis.candidateCount}候補</p>
              {evaluation.candidates.map((candidate, candidateIndex) => (
                <div className="evaluation-score-comparison" key={candidate.voiceId}>
                  <strong>
                    {candidateIndex === 0 ? 'A' : 'B'}：{evaluationVoiceLabel(candidate.voiceId)}
                  </strong>
                  <p>
                    評価時スコア：
                    {evaluation.evidence
                      ? `${evaluation.evidence.candidates[candidateIndex].score}（${evaluation.evidence.candidates[candidateIndex].rank}位 / ${evaluation.evidence.candidateCount}候補）`
                      : '記録なし'}
                  </p>
                  <p>
                    現行スコア：
                    {analysis.scores[candidateIndex] === null
                      ? '未収録'
                      : `${analysis.scores[candidateIndex]}（${analysis.ranks[candidateIndex]}位 / ${analysis.candidateCount}候補）`}
                    {analysis.scoreDeltas[candidateIndex] !== null && (
                      <>
                        {' '}
                        ／ 差：{analysis.scoreDeltas[candidateIndex]! > 0 ? '+' : ''}
                        {analysis.scoreDeltas[candidateIndex]}
                      </>
                    )}
                  </p>
                </div>
              ))}
              {evaluation.evidence &&
                (evaluation.evidence.algorithmRevision !== recommendationRevision ||
                  evaluation.evidence.catalogRevision !== catalogRevision) && (
                  <p className="footnote">評価時と現在の推薦・カタログの版が異なります。</p>
                )}
              <p className="evaluation-text">セリフ：{evaluation.sampleText}</p>
              <p className="evaluation-text">理由：{evaluation.reason || '記入なし'}</p>
              <small>評価日時：{new Date(evaluation.recordedAt).toLocaleString('ja-JP')}</small>
              <details>
                <summary>比較条件を見る</summary>
                <p>
                  {axes
                    .map((axis) => `${axisLabels[axis]}：${evaluation.profile[axis]}`)
                    .join(' ／ ')}
                </p>
                <div className="evaluation-table">
                  <table>
                    <caption>評価時の調声値</caption>
                    <thead>
                      <tr>
                        <th scope="col">項目</th>
                        <th scope="col">A</th>
                        <th scope="col">B</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipeFields.map((field) => (
                        <tr key={field.key}>
                          <th scope="row">{field.label}</th>
                          {evaluation.candidates.map((candidate, i) => (
                            <td key={i}>
                              {candidate.parameters[field.key].toFixed(2)}
                              {field.unit}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="footnote">
                  取り込み元のカタログ確認日：{sourceCatalogDates.join(' ／ ') || '記録なし'}
                  。評価時に使ったカタログや推薦式のバージョンを特定する情報ではありません。
                </p>
                <EvaluationProvenance evaluation={evaluation} />
                <CharacterContext input={evaluation.characterInput} />
              </details>
            </article>
          </li>
        ))}
      </ol>
      {filtered.length > pageSize && (
        <nav className="evaluation-pagination" aria-label="評価一覧のページ">
          <button
            className="secondary-button"
            disabled={loading || currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            前の25件
          </button>
          <span>
            {currentPage + 1} / {Math.ceil(filtered.length / pageSize)}ページ
          </span>
          <button
            className="secondary-button"
            disabled={loading || (currentPage + 1) * pageSize >= filtered.length}
            onClick={() => setPage(currentPage + 1)}
          >
            次の25件
          </button>
        </nav>
      )}
    </section>
  );
}
