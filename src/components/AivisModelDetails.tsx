import {
  modelInfoChanged,
  safeModelLink,
  type AivisModelInfo,
} from '../../shared/aivis-model-info';

function Contents({ info }: { info: AivisModelInfo }) {
  return (
    <>
      <p>
        <strong>{info.modelName}</strong> ／ モデル版：{info.modelVersion}
      </p>
      {info.description && <p className="evaluation-text">{info.description}</p>}
      <p>
        制作者（提供元の記載）：{info.creators.length ? info.creators.join(' ／ ') : '記載なし'}
      </p>
      <p>確認日時：{new Date(info.checkedAt).toLocaleString('ja-JP')}</p>
      <p className="footnote">情報源：AivisSpeechのモデル情報（取得時点）</p>
      <details>
        <summary>モデルの識別情報</summary>
        <p>モデルUUID：{info.modelUuid}</p>
        <p>話者UUID：{info.speakerUuid}</p>
      </details>
      {info.licenseStatus === 'provided' ? (
        <details>
          <summary>利用条件の本文（提供元の記載）</summary>
          <p className="model-license-text">{info.licenseText}</p>
        </details>
      ) : (
        <p>
          {info.licenseStatus === 'omitted'
            ? '利用条件の本文は表示・保存上限を超えるため未掲載です。AivisSpeechで全文を確認してください。'
            : '利用条件の本文は記載されていません。提供元に確認してください。'}
        </p>
      )}
      {info.links.length > 0 && (
        <details>
          <summary>提供元の関連リンク</summary>
          <ul>
            {info.links.map((link) => {
              const safe = safeModelLink(link);
              return safe ? (
                <li key={link}>
                  <a href={safe} target="_blank" rel="noopener noreferrer">
                    {safe}
                  </a>
                </li>
              ) : null;
            })}
          </ul>
        </details>
      )}
      <p className="footnote">
        クレジットの指定や用途ごとの条件は本文と提供元で確認してください。この表示から利用の可否を自動判定しません。
      </p>
    </>
  );
}
export function AivisModelDetails({
  current,
  saved,
  checking = false,
  historical = false,
}: {
  current?: AivisModelInfo;
  saved?: AivisModelInfo;
  checking?: boolean;
  historical?: boolean;
}) {
  const info = historical ? saved : current;
  return (
    <section
      className="aivis-model-details"
      aria-label={historical ? '評価時のモデル・利用条件' : 'モデル・利用条件'}
    >
      <h4>{historical ? '評価時のモデル・利用条件' : 'モデル・利用条件'}</h4>
      {historical ? (
        info ? (
          <Contents info={info} />
        ) : (
          <p>評価時のモデル情報：記録なし</p>
        )
      ) : (
        <>
          {checking ? (
            <p role="status">モデル情報を確認中…</p>
          ) : info ? (
            <Contents info={info} />
          ) : (
            <p>
              現在のモデル情報は未取得です。比較・生成は続けられます。利用条件はAivisSpeechや提供元で確認してください。
            </p>
          )}
          {!checking && current && saved && modelInfoChanged(current, saved) && (
            <p className="model-info-change" role="status">
              保存時からモデル情報または利用条件が変わっています。現在と保存時の内容を確認してください。
            </p>
          )}
          {saved && (
            <details>
              <summary>保存時のモデル情報・利用条件</summary>
              <Contents info={saved} />
            </details>
          )}
        </>
      )}
    </section>
  );
}
