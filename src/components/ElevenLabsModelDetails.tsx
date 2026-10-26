import type { ElevenLabsModel } from '../../shared/elevenlabs';

export function ElevenLabsModelDetails({
  model,
  modelId,
  checking = false,
}: {
  model?: ElevenLabsModel;
  modelId: string;
  checking?: boolean;
}) {
  if (!modelId) return <p className="footnote">声を追加する前に合成モデルを選んでください。</p>;
  if (checking) return <p className="footnote">選択したモデルの情報を確認中…</p>;
  if (!model)
    return (
      <p className="footnote">
        保存したモデル「{modelId}」の情報を現在取得できません。接続とモデル一覧を確認してください。
      </p>
    );
  const controls = [
    '安定性',
    '類似度',
    ...(model.canUseStyle ? ['スタイル'] : []),
    ...(model.canUseSpeakerBoost ? ['話者ブースト'] : []),
  ];
  return (
    <div className="eleven-model-details" role="group" aria-label={`${model.name}のモデル情報`}>
      <dl>
        <div>
          <dt>対応言語</dt>
          <dd>
            {model.languages.length > 6 ? (
              <details>
                <summary>
                  {model.languages.length}言語に対応
                  {model.languages.some((language) => language.id === 'ja')
                    ? '（日本語を含む）'
                    : ''}
                </summary>
                {model.languages.map((language) => language.name).join('、')}
              </details>
            ) : model.languages.length ? (
              model.languages.map((language) => language.name).join('、')
            ) : (
              '言語情報なし'
            )}
            {!model.languages.some((language) => language.id === 'ja') && '（日本語対応は未確認）'}
          </dd>
        </div>
        <div>
          <dt>入力上限</dt>
          <dd>
            この画面では{Math.min(300, model.maxCharacters).toLocaleString('ja-JP')}文字まで
            <span className="footnote">
              （モデル上限：{model.maxCharacters.toLocaleString('ja-JP')}文字）
            </span>
          </dd>
        </div>
        <div>
          <dt>使える調声</dt>
          <dd>
            {controls.join('・')}
            {model.modelId === 'eleven_v3' && '（安定性は3段階）'}
          </dd>
        </div>
      </dl>
    </div>
  );
}
