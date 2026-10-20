# 設計と初期版の範囲

## 体験

画像を選択 → 声の演出案を作成 → カタログの候補を比較 → 調声値を編集 → 試聴 → レシピを保存。

手動モードは画像を解析したように見せず、ユーザーが指定した4軸のみを使います。AI解析では視覚上の要素・演出提案・4軸をJSONで取得し、ユーザーがその4軸を修正できます。写真から実際の声や本人の属性を特定する設計にはしません。

## 分担

- React/ViteのUIとExpressを同じローカルオリジンで提供。
- TypeScript/Zodでプロバイダー出力とユーザー入力を検証。
- AIは演出のプロフィールだけを提案し、ソフト・話者名を作りません。
- ソフト・話者は出典付き固定カタログから選択。カタログ以外の話者がAI出力から追加されることはありません。
- 4軸のユークリッド距離で順位付けし、0〜100の編集上の目安として表示。確率・本人との一致率ではありません。
- VOICEVOXの提案値は控えめな範囲へ制限。ささやきスタイルの音高は0を維持。
- 話者IDはインストール済みエンジンの `/speakers` から解決し、`/audio_query` の値を上書きして `/synthesis` に渡す。
- COEIROINK・A.I.VOICE2にはソフト固有の数値が確認できるまで値を出さず、手動調整の方向と公式手順を示す。

## 実装の境界と性能

- `server/remote.ts`：外部通信のタイムアウト、リダイレクト拒否、応答サイズ上限、エラーの秘匿を共通化。
- `server/validation.ts`：リクエストスキーマをルート定義から分離。
- `server/analysis-schemas.ts`：プロバイダー向けスキーマを起動時に一度だけ生成。応答は毎回元のZodスキーマで検証。
- `src/components/`：調声コントロール、ツールチップ、話者マーク。`src/lib/http.ts`：JSON通信・ダウンロード。
- 接続確認は同じアプリへの実行中の要求だけを共有し、完了結果はキャッシュしない。再確認時に接続状態を再取得する。
- 本番のハッシュ付き `/assets` のみ1年間のimmutableキャッシュ。HTMLは再検証し、APIはno-store。

## 入出力

| API                     | 内容                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `GET /api/health`       | アプリの死活確認                                           |
| `GET /api/catalog`      | 話者カタログと確認日                                       |
| `GET /api/capabilities` | ローカルサービス・APIキー設定の状態                        |
| `POST /api/recommend`   | `{profile, preferences}` → カタログ候補                    |
| `POST /api/analyze`     | `{provider, image, direction, consent}` → 構造化した演出案 |
| `POST /api/preview`     | `{voiceId, text, recipe}` → WAV                            |

画像はData URLで受け、サーバーで最大8MB・25メガピクセルまで検証。向き補正・最大1536辺へ縮小・JPEG化を行い、Ollama・Anthropic Claude・Geminiにはbase64、OpenAIにはJPEG Data URLとして送信する。ファイル・DB保存は行わない。解析APIのJSON本文上限は12MiB、その他は16KiBで、入力圧縮は拒否する。外部JSON応答は2MiB、WAVは20MiBまで。本文の受信中もタイムアウトを適用する。

重い解析・音声合成はサーバーごとに同時1件とし、タイムアウトを設ける。別タブなどから競合した場合はHTTP 429で返す。サーバー側の処理はブラウザーの中止だけでは取り消せない。

## Claude接続

`ANTHROPIC_API_KEY`・`ANTHROPIC_MODEL` をサーバー側で読み、`provider: "anthropic"` を `POST /api/analyze` で受け付ける。キーはブラウザーへ返さない。外部AIへの送信同意はOpenAI・Claudeの切替時にリセットし、APIでも同意を必須とする。

Messages APIの `output_config.format` には対応範囲のJSONスキーマを渡し、数値・文字数などの制約は説明へ移す。応答は元のZodスキーマで再検証する。拒否・出力上限・不正応答では提案を作らずエラーを返す。

## Gemini接続

`GEMINI_API_KEY`・`GEMINI_MODEL` をサーバー側で読み、`provider: "gemini"` を受け付ける。Googleへの送信同意をAPIでも必須とし、`x-goog-api-key` ヘッダーで認証する。キーはURLに含めない。

`generateContent` へ `inlineData` のJPEGと補足を送り、`generationConfig.responseFormat` でJSON出力を指定する。送信用スキーマでは文字数制約を説明へ移し、応答は元のZodスキーマで検証する。完了した一つの候補のテキストだけを読み、思考ブロックは除外する。ブロック・未完了・不正応答はエラーにする。

## 公開開発

ソース・設計・カタログ・CIをGitHubで公開。`.env`、画像、生成音声、ログ、ビルド成果物を追跡しない。CIは実APIへの通信をモックして再現性を確保する。公開サーバー向けの認証・課金・保持ポリシーは将来別途設計する。

## CI

`npm run check` はユニット/APIテストと、型検査を含む本番ビルドを実行する。型検査を重複実行しない。単独の `npm run typecheck` も利用可能。

GitHub ActionsはmainへのpushとPull Requestで実行し、同じrefの古い実行はキャンセルする。npmキャッシュを使い、インストール時の監査通信は省く。監査は必要時に `npm audit --audit-level=high` で実行する。整形検査もCIで実施する。

ブラウザーテストはChromiumのデスクトップ・モバイルの2構成を維持し、CIのワーカー数は2。実行に使うheadless shellだけを `npx playwright install --with-deps --only-shell chromium` でインストールする。[Playwright公式のブラウザー設定](https://playwright.dev/docs/browsers)に沿い、不要なフルブラウザーの取得を省く。ブラウザーキャッシュは[公式CIガイド](https://playwright.dev/docs/ci)が推奨していないため追加しない。

実際のGitHubランナーでの所要時間の短縮率は未計測。
