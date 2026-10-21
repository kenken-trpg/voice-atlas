import type { Evaluation } from '../../shared/saved-recipe';

export function EvaluationProvenance({ evaluation }: { evaluation: Evaluation }) {
  const evidence = evaluation.evidence;
  if (!evidence)
    return (
      <p className="footnote">評価時の推薦・エンジン情報：記録なし（旧記録の情報は補いません）。</p>
    );
  return (
    <div className="evaluation-provenance">
      <p>
        評価時の推薦ロジック：{evidence.algorithmRevision}
        <br />
        カタログ：{evidence.catalogRevision}（確認日：{evidence.catalogReviewedAt}）
      </p>
      <p className="footnote">
        順位は利用可否・画面の絞り込みを適用しないVOICEVOX全{evidence.candidateCount}
        候補内です。同点は候補ID順で並べます。スコアは調声後の音響評価ではありません。
      </p>
      {evidence.engines.map((engine, index) => (
        <p className="footnote" key={index}>
          候補{index === 0 ? 'A' : 'B'}のエンジン情報：
          {engine
            ? `${engine.engine} ${engine.version}（音声生成直後の確認：${new Date(engine.checkedAt).toLocaleString('ja-JP')}）`
            : '記録なし（取得できませんでした）'}
        </p>
      ))}
      <p className="footnote">
        エンジン情報は各音声の生成直後に取得したものです。音声ライブラリやコアの版を含む完全な再現条件ではありません。
      </p>
    </div>
  );
}
