# カタログ・実装の一次資料

既存資料の初回確認日：2026-10-20。VOICEVOXの話者・スタイルは2026-10-21に再確認・拡充しました。COEIROINK・A.I.VOICE2は従来の確認日のままです。声の特徴・推薦スコア・調整値はこのプロジェクト独自の編集値です。公式仕様と編集上の提案を区別してください。

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

## 2026-10-21のカタログ拡充

全体は16話者・24候補、うちVOICEVOXは12話者・20候補です。候補は話者とスタイルの組み合わせを表します。既存10候補のIDは変更していないため、以前の保存JSONも同じ話者・スタイルへ解決します。

スタイル名は[VOICEVOX公式の音声モデル対応表](https://github.com/VOICEVOX/voicevox_vvm/blob/main/README.md#音声モデルvvmファイルと声キャラクタースタイル名とスタイル-id-の対応表)のトーク欄で照合しました。白上虎太郎の「ふつう」、青山龍星の「囁き」、ナースロボ＿タイプＴの「内緒話」等は公式の表記を保持します。固定のエンジン数値IDは追加せず、生成時に接続中エンジンの話者・スタイル名で照合します。

| 話者                 | 収録スタイル                           | 公式製品ページ                                                       |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| 四国めたん           | ノーマル・あまあま・ツンツン・ささやき | [製品情報](https://voicevox.hiroshiba.jp/product/shikoku_metan/)     |
| ずんだもん           | ノーマル・あまあま・ささやき           | [製品情報](https://voicevox.hiroshiba.jp/product/zundamon/)          |
| 春日部つむぎ         | ノーマル                               | [製品情報](https://voicevox.hiroshiba.jp/product/kasukabe_tsumugi/)  |
| 波音リツ             | ノーマル                               | [製品情報](https://voicevox.hiroshiba.jp/product/namine_ritsu/)      |
| 青山龍星             | ノーマル・囁き                         | [製品情報](https://voicevox.hiroshiba.jp/product/aoyama_ryusei/)     |
| 九州そら             | ささやき・ノーマル                     | [製品情報](https://voicevox.hiroshiba.jp/product/kyushu_sora/)       |
| 玄野武宏             | ノーマル                               | [製品情報](https://voicevox.hiroshiba.jp/product/kurono_takehiro/)   |
| 白上虎太郎           | ふつう                                 | [製品情報](https://voicevox.hiroshiba.jp/product/shirakami_kotarou/) |
| 雨晴はう             | ノーマル                               | [製品情報](https://voicevox.hiroshiba.jp/product/amehare_hau/)       |
| 冥鳴ひまり           | ノーマル                               | [製品情報](https://voicevox.hiroshiba.jp/product/meimei_himari/)     |
| 剣崎雌雄             | ノーマル                               | [製品情報](https://voicevox.hiroshiba.jp/product/kenzaki_mesuo/)     |
| ナースロボ＿タイプＴ | ノーマル・内緒話                       | [製品情報](https://voicevox.hiroshiba.jp/product/nurserobo_typet/)   |

公式ページの声の説明と確認済みのスタイル名を参考に、比較試聴の出発点となる4軸・タグ・説明を編集しました。公式の声質評価や音響測定値ではなく、実機での聴取による校正も未実施です。各スタイルの`provenance`には公式資料のURL・確認日、`profileMethod: editorial-unverified`、`listeningReviewedAt: null`を保持します。公式情報を確認した日を聴取評価した日として扱いません。

ささやき系スタイルの`pitchPolicy: preserve`もアプリの調声提案方針であり、公式APIの制約ではありません。利用者は音高を手動調整できます。

音声ライブラリの規約は[ずんだもん・四国めたん・九州そら](https://zunko.jp/con_ongen_kiyaku.html)、[VirVox Project](https://www.virvoxproject.com/voicevoxの利用規約)、[冥鳴ひまり](https://www.meimeihimari.com/terms-of-use)、[倉成町私立病院](https://www.krnr.top/rules)を参照しました。青山龍星の法人・個人事業主等の利用条件、ナースロボ＿タイプＴの企業商用利用の連絡条件は、候補の規約リンクの近くにも案内します。用途別の許諾を自動判定する機能はありません。

剣崎雌雄は[権利者の規約掲載先](https://frontier.creatia.cc/fanclubs/413/posts/4507)を保持します。今回の取得では一覧・抜粋のみ表示され、本文全体の突合は未実施です。雨晴はう・春日部つむぎ・波音リツは公式製品ページから話者規約を確認する導線を維持します。春日部つむぎの外部規約ページは取得時に503、波音リツの外部規約ページは取得できなかったため、今回規約全文を再確認したとは扱いません。
