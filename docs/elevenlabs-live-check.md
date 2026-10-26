# ElevenLabs実API動作確認

確認日：2026-10-26

## CLI

制限付きAPIキーでモデル9件、既定の声21件を取得した。Georgeと `eleven_multilingual_v2` で共通評価台詞6文を生成し、CLIは `completed`、6サンプル、`not-reviewed` を報告した。聴取評価は未実施。

## ブラウザー

ローカルの本番ビルドをChromiumから操作し、APIをモックせず次を確認した。

- ElevenLabsの声を検索し、モデル `eleven_multilingual_v2` を明示選択。
- GeorgeとBellaを比較候補A・Bへ追加。
- 「こんにちは。音声の接続テストです。」をA・Bで生成。音声生成要求は2回。
- 両候補のaudio要素の表示と、ブラウザーが音声メタデータを読み取れることを確認。
- GeorgeのWAVを画面からダウンロードし、RIFF形式、22,050Hzを確認。
- Aの採用記録を追加し、比較セッションJSONを保存。理由には音質評価未実施と明記。
- 再読み込み後にJSONを復元し、モデル、採用記録、理由の表示を確認。復元で音声生成要求が発生せず、audio要素も追加されないことを確認。

結果はローカルの `.local-artifacts/elevenlabs/ui-check/` に保存。APIキーは記載しない。今回の実API確認はデスクトップで実施し、モバイルを含む画面の回帰確認はモックE2Eで実施した。

## エラー表示

上流のエラー本文を16KiBまで読み、既知のコードから固定の案内へ変換する。権限名は `models_read`、`voices_read`、`text_to_speech` のみ案内へ反映する。不明・不正・サイズ超過の本文はHTTPステータスによる案内へ戻す。実アカウントの権限やクレジットを変更してエラーを起こす操作は行わず、エラー分類と秘密情報の非表示は自動テストで確認した。

参照：[公式エラー一覧](https://elevenlabs.io/docs/eleven-api/resources/errors)、[400・401](https://elevenlabs.io/docs/help-center/technical/api-error-code-400-or-401)、[429](https://elevenlabs.io/docs/help-center/technical/api-error-code-429)。
