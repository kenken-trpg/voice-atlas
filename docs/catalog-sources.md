# カタログ・実装の一次資料

確認日：2026-10-20。声の特徴・推薦スコア・調整値はこのプロジェクト独自の編集値です。公式仕様と編集上の提案を区別してください。

| 対象            | 一次資料                                                                                      | 用途                                               |
| --------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| VOICEVOX        | https://voicevox.hiroshiba.jp/                                                                | 製品・話者カタログへの入口                         |
| VOICEVOX        | https://voicevox.hiroshiba.jp/how_to_use/                                                     | 話速・音高・抑揚・音量・無音の意味と編集方法       |
| VOICEVOX        | https://voicevox.hiroshiba.jp/term/                                                           | ソフトと話者それぞれの規約の確認                   |
| VOICEVOX Engine | https://github.com/VOICEVOX/voicevox_engine/blob/master/voicevox_engine/tts_pipeline/model.py | AudioQueryのキー・データモデル                     |
| COEIROINK       | https://coeiroink.com/help                                                                    | エディターの操作・APIへの入口                      |
| COEIROINK       | https://coeiroink.com/terms                                                                   | 音声・ソフト・キャラクターの扱い                   |
| つくよみちゃん  | https://coeiroink.com/character/audio-character/tsukuyomi-chan                                | 話者情報・配布・規約への入口                       |
| AI声優-金苗     | https://coeiroink.com/character/audio-character/kana                                          | 話者情報・配布・規約への入口                       |
| 琴葉 茜・葵     | https://aivoice.jp/product/aivoice2_kotonoha/                                                 | A.I.VOICE2の製品・標準語と関西弁・スタイル・規約   |
| A.I.VOICE2      | https://aivoice.jp/manual/editor2/tuning.html                                                 | チューニング画面と全文・アクセント句ごとの音声効果 |
| OpenAI          | https://developers.openai.com/api/docs/guides/images-vision                                   | Responses APIの画像入力                            |
| OpenAI          | https://developers.openai.com/api/docs/guides/structured-outputs                              | JSONスキーマによる構造化出力                       |
| Ollama          | https://docs.ollama.com/capabilities/vision                                                   | ローカル画像入力のbase64形式                       |
| Ollama          | https://docs.ollama.com/capabilities/structured-outputs                                       | JSONスキーマ指定                                   |
| Anthropic       | https://platform.claude.com/docs/en/build-with-claude/vision                                  | Claude Messages APIの画像入力                      |
| Anthropic       | https://platform.claude.com/docs/en/build-with-claude/structured-outputs                      | 構造化出力、スキーマの制約と応答検証               |
| Anthropic       | https://platform.claude.com/docs/en/models/overview                                           | 画像対応モデルとAPIモデルID                        |
| Google Gemini   | https://ai.google.dev/api/generate-content                                                    | 画像入力、JSON出力形式、完了・ブロック判定         |
| Google Gemini   | https://ai.google.dev/gemini-api/docs/structured-output                                       | JSONスキーマ対応とアプリ側の応答検証               |
| Google Gemini   | https://ai.google.dev/gemini-api/docs/models                                                  | モデルIDと機能                                     |

数値の提案はVOICEVOXに限り、アプリ側の安全な調整範囲を使用します。API上の全許容範囲や、メーカー推奨の設定値という意味ではありません。

価格の固定額は掲載しません。無料・有料はソフトの入手区分で、生成音声・商用利用・キャラクター使用の権利を包括的に示しません。クレジットの参考表記だけで、各製品・音源の条件がすべて満たされると判断しないでください。
