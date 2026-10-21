# AivisSpeech連携の技術検証

確認日：2026-10-21。ローカルAivisSpeech Engine用の検証クライアントとCLIを追加した。製品横断比較の画面・専用保存形式も追加した。固定カタログの推薦スコアとは分けて扱う。

## 確認した一次資料

- [公式READMEの互換性説明](https://github.com/Aivis-Project/AivisSpeech-Engine#voicevox-api-との互換性について)
- [公式AudioQueryモデル](https://github.com/Aivis-Project/AivisSpeech-Engine/blob/master/voicevox_engine/model.py)
- [公式APIドキュメント](https://aivis-project.github.io/AivisSpeech-Engine/api/)

VOICEVOXと同名のAPIでも、調声値を流用しない。`intonationScale`は感情表現の強さ、`tempoDynamicsScale`はテンポの緩急で、いずれも0〜2。`pitchScale`は-0.15〜0.15で、変更時の音質低下が公式に記載されているため検証用の初期値は0にする。`kana`には通常の読み上げ文章を設定する。スタイルIDは符号付き32bitで、負数を許容する。

## 検証コマンド

AivisSpeechを利用者が起動した状態で実行する。モデルやエンジンのダウンロード・インストール・起動は自動実行しない。モデルの利用条件は個別に確認する。

```sh
# 導入済みの話者UUID・スタイル名・現在のスタイルIDを表示
npm run probe:aivis

# 一覧に表示されたUUIDとスタイル名を指定
npm run probe:aivis -- \
  --speaker-uuid "一覧に表示されたUUID" \
  --style "一覧に表示されたスタイル名" \
  --text "こちらは音声の比較用セリフです。" \
  --output .local-artifacts/aivis.wav
```

接続先は`AIVIS_BASE_URL`、省略時`http://127.0.0.1:10101`。`.env`からも読み込む。ループバックHTTP以外、ユーザー情報・パス・クエリ付きURLは拒否する。既存の`VOICEVOX_BASE_URL`は変更しない。

引数なしでは`/speakers`だけを呼ぶ。合成時は4引数すべてが必要で、セリフは空白以外の1〜300文字。調声値はAivisSpeech用の初期値を使い、CLIからの調整はまだ提供しない。クライアント関数では製品を明示した独立スキーマで7項目を検証できる。前後の無音は秒単位で0〜1に制限するが、これはVoice Atlas側の制限。

生成結果は指定したWAVと同名の`.wav.json`へ保存する。JSONは`format: "voice-atlas-aivis-probe"`、`version: 1`で、エンジン版（取得不可時null）・取得時刻・話者UUID・話者名・スタイル名・生成時ID・文章・調声値・出力サンプリングレート・ステレオ設定を保持する。通常のレシピJSONとは別形式で、現在の画面からの復元には対応しない。音声ライブラリやモデルファイルの版・ハッシュを含む完全な再現条件ではない。

既存のWAVまたはJSONがあれば、合成前に停止する。合成に失敗した場合は今回確保した出力ファイルを削除する。異常終了・強制終了時には空ファイル等が残る場合がある。`.local-artifacts/`はGit対象外。出力先を変える場合は生成音声と文章を含むJSONをコミットしない。

## 通信と識別

`server/tts/aivis.ts`は既存の通信制限（リダイレクト拒否、本文サイズ上限、タイムアウト）を使う。合成のたびに`/speakers`を取得し、話者UUIDとスタイル名で一意に照合する。表示名だけでは選ばず、以前の数値IDを再利用しない。歌唱スタイル・照合不能・重複した対象・ID衝突は生成前に拒否する。

`/audio_query`のアクセント句と追加フィールド、出力形式を保持し、AivisSpeech用調声値と読み上げ文章を設定して`/synthesis`へ渡す。WAVのRIFF/WAVEを確認後、任意で`/version`を取得する。版取得は1秒・1024バイトまで、失敗しても音声は返す。

製品横断比較は`shared/casting.ts`の製品別の話者・調声型と`server/tts/casting.ts`を経由してこのクライアントを利用する。既存のVOICEVOX用`TtsAdapter`とレシピ形式は互換性を維持する。

## 検証結果と次の実装

モックで、負数ID・再解決・製品固有パラメーター・クエリ保持・URL制限・不正入力・重複・異常応答・任意の版取得失敗・CLIの一覧/生成・上書き防止・失敗時の後片付けを検証した。実機の既定ポートへの接続は拒否されたため、実際の音声生成と聴取は未確認。

画面では導入済み話者の選択、製品固有の調声、同一セリフでの比較、採用理由の記録と比較セッションJSONの保存・復元に対応した。詳細は[操作マニュアル](manual.md#voicevoxとaivisspeechを比較する)と[設計](architecture.md#製品横断の比較)を参照。

今後は、個別モデルの出典・利用条件の表示、聴取による4軸の校正、モデル版/ハッシュの保持、製品比較の履歴集計、実機でのパラメーター効果と品質の確認を進める。
