# ElevenLabs連携計画

作成日：2026-10-25

## 実装状況（2026-10-26）

初版の比較試聴を実装した。サーバー環境変数によるキー設定、声の検索・ページング、合成モデルの明示選択、製品固有の調声、PCMからWAVへの変換、比較・採用・保存・復元を接続している。比較セッション、評価JSON/CSV、採用声ライブラリ、作品JSONでElevenLabsの識別情報と調声値を保持する。

一覧取得は30秒間キャッシュし、同時要求をまとめる。声一覧は1ページ50件とし、上流の先頭ページに追加された既定声も取りこぼさず分割する。ブラウザーへ渡すページ情報はサーバー内の状態に対応するUUIDで、有効期限は10分、サーバー再起動後は検索し直す。認証・権限・利用枠・入力条件のエラーは固定メッセージへ変換する。クラウド音声生成にはローカル処理から独立した排他制御を使い、自動再試行を行わない。

`npm run check`で332件のテストとビルドが成功した。関連するPC・スマートフォンのE2Eでは、既存の比較・履歴・採用声比較に加え、モデル選択前の生成抑止、検索結果の入れ替え、ページング、失敗時の結果保持、試聴・保存・復元、キー未設定時の設定保持を確認した。

実アカウントでの日本語音質、応答のPCM形式・Content-Type、契約プラン・声ごとのAPI利用条件は未確認。`npm run probe:elevenlabs`で声・モデル一覧を取得でき、`--generate --voice-id VOICE_ID --model-id MODEL_ID --output 新規ディレクトリー`を付けたときだけ共通評価台詞6文を送信する。生成には利用枠を消費する。評価結果にはWAV、待ち時間、サイズ、生成条件、失敗箇所を保存する。

台本からのElevenLabs音声生成は初版の対象外として画面で無効化した。既存の台本・作品の保存形式は維持する。

比較画面の操作改善も実装した。声の検索結果をカード表示にし、種別・追加状況による絞り込みと名前順の並べ替えに対応する。モデル選択時は対応言語、画面とモデルそれぞれの入力上限、対応する調声を表示する。追加済みのElevenLabs候補は名前・モデル名で検索でき、A/Bの切り替えと削除ができる。削除時は比較対象を残った候補で補い、削除対象以外の生成済み音声・記録済み評価・採用声ライブラリを保持する。PC・スマートフォンのE2Eで絞り込み、モデル情報の切り替え、削除後の保存・再追加・復元を確認した。

## 方針

ElevenLabsを、既存のVOICEVOX・AivisSpeechに続く製品比較・試聴先として追加する。まずは利用者自身のElevenLabs APIキーによる、声一覧・モデル選択・単発プレビューを対象とする。キーはVoice Atlasのサーバー環境変数だけに置き、ブラウザー、作品データ、比較JSON、ログへ含めない。

ElevenLabsは外部SaaSである。送信前に、入力した台詞がElevenLabsへ送られ、契約プランに応じて利用量が発生することを画面で明示する。キー未設定時は未接続とし、音声生成を行わない。ローカルエンジンの接続状態とクラウド接続状態は別々に表示する。

## 現状と設計上の影響

- `shared/casting.ts`の話者・調声・履歴形式はVOICEVOXとAivisSpeechの2製品を列挙している。
- `server/tts/casting.ts`はローカルの話者一覧を並列取得し、製品別処理でプレビューを生成する。
- 台本、比較履歴、作品保存とアーカイブでも製品識別子・調声値を保持するため、エンジン追加時は過去データの読み込み互換性を維持する必要がある。
- 現在の台本音声キャッシュと作品アーカイブはWAVを検証する。ElevenLabsはMP3を標準出力し、PCM等も選べるため、保存形式への変換または形式拡張を先に決める。
- `server/config.ts`と`.env.example`に既存のAIサービスキー設定があり、キー管理の配置は既存構成に合わせられる。

## 提案する段階

### 1. 接続とAPI契約

- `ELEVENLABS_API_KEY`をサーバー設定に追加する。ブラウザーから任意のキーを送る設計にはしない。
- API接続先は公式ホストに固定し、キーを使うリクエストをサーバーからだけ送る。リダイレクト拒否、タイムアウト、応答サイズ上限、JSON/音声形式検証を適用する。
- `GET /v1/voices`のページングを処理し、アカウントで利用可能な声だけを取得する。取得件数と表示件数に上限を置き、検索語はAPIへ安全に渡す。
- `GET /v1/models`から音声合成可能なモデルを選び、未知・非対応モデルは拒否する。モデル一覧取得に失敗しても、エラー内容をキーや本文を含めず利用者へ案内する。
- 音声一覧とモデル一覧は同時取得を避け、画面操作時に取得する。課金のある合成APIは利用者の明示操作時だけ呼ぶ。

### 2. 製品別型とサーバー合成

- `shared/casting.ts`へElevenLabs用の話者識別子（voice ID、表示名）、モデルID、ネイティブ調声スキーマを追加する。既存のVOICEVOX用数値をElevenLabsの設定へ流用しない。
- 最初の調声項目はAPIが提供する安定した範囲に絞る。安定性・類似度・スタイル・話者ブーストの範囲とモデルごとの対応を公式モデル情報で検証し、未対応値を無視せず拒否する。
- `server/tts/elevenlabs.ts`を作り、公式の同期テキスト音声合成APIへテキスト、voice ID、model ID、調声値、出力形式を渡す。入力長を製品側の上限とモデルの`maximum_text_length_per_request`の両方で検査する。
- 初版では同期生成を使い、ストリーミング再生は後段とする。タイムアウト・HTTP 401/403/429・上流5xx・不正な音声を、再試行の可否が分かるエラーへ変換する。課金が重複する自動再試行はしない。
- 保存音声はPCM出力を優先して既存のWAV要件に合わせる。PCM応答にWAVヘッダーを付ける方式を実機検証し、サンプルレート・ビット深度・チャンネル数を記録する。APIプランや選択モデルで利用できない場合に備え、MP3を保存できるようキャッシュとアーカイブ形式を拡張する案も見積もる。

### 3. 比較画面とプレビュー

- 既存の「VOICEVOX・AivisSpeechを比較する」画面にElevenLabsを追加し、接続状況・アカウントの声・モデル・利用量発生の案内を表示する。
- ElevenLabs候補の追加、同じ台詞での比較、製品固有の調声、採用理由の記録を既存の比較ワークフローに接続する。
- APIキーがない場合は設定手順を案内し、キー設定後のサーバー再起動で反映する。ブラウザーのローカルストレージにはキーを保存しない。
- 台詞の送信先がクラウドであることを、初回利用時と生成操作の近くで明示する。APIキーの権限・利用上限の管理はElevenLabs側で行う。

### 4. 台本・作品保存への拡張

- 比較プレビューの安定後、台本の発話者割当と行別音声生成でElevenLabsを選べるようにする。
- 作品設定、台本JSON、比較履歴、作品アーカイブにvoice ID・model ID・当時のネイティブ調声値を保持する。APIキーは含めない。
- `voice-atlas-casting`等の既存形式は過去版を読み込めるようにし、新しいengine値の許容箇所をすべて棚卸しして更新する。現在の声一覧から消えた声も履歴として表示できるよう、保存済みの名前をスナップショットとして保持する。
- 生成済み音声キャッシュの再利用キーに、engine、voice ID、model ID、設定、実際に送った読み上げ文を含める。
- アーカイブには音声本体を引き続き格納し、別環境で音声だけ再生できる状態を保つ。復元先でElevenLabs未接続でも、設定・過去の比較記録・保存済み音声を壊さない。

### 5. 実機評価とリリース

- ElevenLabs専用の接続・生成CLIまたは評価コマンドを追加し、同じ評価台詞で待ち時間、出力形式、音声サイズ、失敗内容を保存する。APIキーは結果JSONへ含めない。
- 日本語の読み、句読点、長文、話速・安定性設定、Voice IDの権限差、無料/有料プランでの利用可否を実機確認する。
- 自動検証ではモックAPIでキー秘匿、APIエラー、応答形式、重複生成回避、データ移行を確認する。実機評価は利用量・料金が発生し得るため、専用キーに上限を設定して行う。
- READMEと操作マニュアルにAPIキー設定、送信されるデータ、料金の確認方法、利用可能なモデル・音声の条件、保存データにキーが含まれないことを記載する。

## 初版の完了条件

1. キー未設定・誤設定・利用権限不足が区別して表示され、キーや認証付きURLが画面・ログ・保存JSONへ漏れない。
2. 利用者の操作なしにElevenLabsへテキストを送信せず、生成前にクラウド送信と利用量発生を案内する。
3. 利用可能な声・モデルの取得と、選択した声・モデルでの単発プレビューができる。
4. 合成音声を既存の再生・保存経路で再生でき、実際の出力形式と生成条件を記録できる。
5. VOICEVOX・AivisSpeechの既存データ、既存接続、既存試聴に影響しない。

## 先に決めるべき境界

- 初版に含める範囲は「比較画面の試聴」までとし、台本一括生成は後段にする。
- 既定モデルは固定せず、アカウントから利用可能な日本語対応モデルを取得して利用者が選ぶ。API一覧の言語情報と実際の日本語音質は実機評価で確認する。
- 台本キャッシュ形式を保つため、初版はPCMからWAVへの変換を優先し、実現できない場合にMP3対応を別変更として判断する。
- 課金・プラン制限・Voice LibraryのAPI利用条件は変わり得るため、実装時に公式資料と対象アカウントで再確認する。

## 公式資料

- [API認証](https://elevenlabs.io/docs/api-reference/authentication) — `xi-api-key`ヘッダー、APIキーをクライアントへ露出しないこと。
- [声一覧API](https://elevenlabs.io/docs/api-reference/voices/search) — ページング、検索、取得可能な声。
- [モデル一覧API](https://elevenlabs.io/docs/api-reference/models/list) — モデルの音声合成可否、言語、最大入力長。
- [同期テキスト音声合成API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) — voice IDごとの合成、model ID、出力形式。
- [テキスト音声合成の形式とモデル](https://elevenlabs.io/docs/overview/capabilities/text-to-speech) — MP3/PCM等の形式と各モデルの情報。
- [Voice Library概要](https://elevenlabs.io/docs/overview/capabilities/voices) — 声の種別とプランによるAPI利用条件。
- [利用ポリシー](https://elevenlabs.io/use-policy) — プラン・商用利用・APIアクセスに関する制限。

---

## 詳細設計

以下は実装開始時点の設計案。ElevenLabsのモデル・出力形式・プラン条件は変わるため、公式API契約は実装時に再確認する。

### パッケージと変更単位

新しい依存ライブラリーは追加せず、既存の`fetch`、`remoteJson`、`remoteBytes`、Zodスキーマで実装する。連携を次の責務に分ける。

| 責務         | 主なファイル                                                                                  | 変更内容                                           |
| ------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 製品契約     | `shared/elevenlabs.ts`（新規）                                                                | ElevenLabs固有の声、モデル、調声、生成情報スキーマ |
| 共通比較契約 | `shared/casting.ts`                                                                           | engine union、候補、世代情報、インベントリーの拡張 |
| 外部API      | `server/tts/elevenlabs.ts`（新規）                                                            | キー認証、声/モデル取得、音声合成、応答検証        |
| 集約処理     | `server/tts/casting.ts`                                                                       | サービス状態の追加とElevenLabs候補の合成分岐       |
| 設定         | `server/config.ts`、`.env.example`                                                            | サーバー専用APIキー                                |
| HTTP         | `server/app.ts`                                                                               | 接続情報、声/モデル取得、プレビュー経路            |
| UI           | `CastingWorkspace.tsx`、`ConnectionGuide.tsx`、調声表示部                                     | SaaS接続状態、候補選択、クラウド送信表示           |
| データ横断   | `shared/voice-library.ts`、`casting-dataset.ts`、`project.ts`、`project-archive.ts`、台本関連 | 新engineの保存、読込、復元、音声条件キー対応       |

実装PRは「共通スキーマ・サーバークライアント」「試聴UI」「保存データと台本」の3段階に分ける。各段階でElevenLabs以外の挙動を変えない。

### データ契約

ElevenLabsをengine discriminatorに`ElevenLabs`として追加する。製品固有スキーマは独立したファイルに置き、他製品のレシピと共通化しない。

```ts
type ElevenLabsVoice = {
  engine: 'ElevenLabs';
  voiceId: string; // API voice_id。大小文字を保持する
  name: string; // 取得時の表示名スナップショット
  category?: string; // UI表示用。履歴上は任意
};

type ElevenLabsRecipe = {
  engine: 'ElevenLabs';
  modelId: string;
  stability: number; // 0..1
  similarityBoost: number; // 0..1
  style: number; // 0..1。モデルが対応する場合のみ表示/送信
  useSpeakerBoost: boolean; // モデルが対応する場合のみ表示/送信
  seed: number | null; // 0..4294967295。初期値null
  outputFormat: 'pcm_22050';
};
```

- `castingKey`は`JSON.stringify(['ElevenLabs', voiceId])`とする。voice IDは大文字小文字を保持し、表示名を識別子に使わない。
- `modelId`をレシピ側に置く。声候補自体はモデルに固定しない。同じ声を異なるモデル設定で候補化し、比較履歴に両方の条件を残せる。
- 現行APIのモデル一覧が返す`can_do_text_to_speech`、`can_use_style`、`can_use_speaker_boost`、`maximum_text_length_per_request`、`languages`を、モデル応答スキーマで許可した範囲に限って保持する。UIへは利用可能な合成モデルと調声項目だけを返す。
- スキーマの`superRefine`でvoice.engineとrecipe.engineの一致、モデル機能とstyle/speaker boost値の整合を検証する。サーバーもリクエストごとに再検証する。
- `generationSchema`に`engine: 'ElevenLabs'`を追加し、`engineVersion`は取得できないためnull、`checkedAt`を生成直後の時刻とする。別の`elevenLabs`生成情報に`modelId`、`outputFormat`、`seed`、`requestId`（応答ヘッダーがある場合のみ）を追加する。APIキー・台詞本文は生成メタデータに含めない。
- 評価履歴は調声を含む候補のスナップショットを記録する。カタログから削除された声でも`historicalCastingCandidateSchema`で読み込める。現行候補検証ではvoice IDをElevenLabsへ毎回照会せず、最新インベントリーに存在しない場合を利用不能として表示する。

### サーバー設定と秘密情報

- `Config`に`elevenLabsApiKey: string`を追加し、`ELEVENLABS_API_KEY`からtrimして読む。未設定は空文字で起動可能とする。
- `.env.example`の注記に、APIキーの作成場所、最小限のTTS/voice read権限、利用上限設定、サーバー再起動が必要なことを書く。キー値自体は例に置かない。
- APIホストはコード定数`https://api.elevenlabs.io`とし、環境変数による任意URL指定を設けない。Authorizationは`xi-api-key`ヘッダーでのみ送る。
- APIキーがないときは上流通信をせず、ローカルエンジンは通常どおり利用できる状態を返す。
- エラー本文、上流URLのクエリ、送信ヘッダーをアプリログへ出さない。リクエストID等を記録する場合もキー、台詞、音声データを除外する。
- キーはブラウザーへ返す接続レスポンス、HTML、localStorage、IndexedDB、プロジェクト、比較セッション、エクスポートファイルへ渡さない。

### ElevenLabsクライアント契約

`createElevenLabsClient(apiKey, fetcher)`をエクスポートし、テスト可能な`fetcher`を受け取る。公開する操作は次の通り。

```ts
getStatus(): Promise<{ ready: boolean; detail: string }>;
listVoices(): Promise<ElevenLabsVoice[]>;
listModels(): Promise<ElevenLabsModel[]>;
synthesize(input: {
  voice: ElevenLabsVoice;
  text: string;
  recipe: ElevenLabsRecipe;
}): Promise<{ wav: Buffer; generation: ElevenLabsGeneration }>;
```

- `getStatus`はキーが空なら未設定、設定済みなら`GET /v1/models`で認証と疎通を確認する。応答に含まれるプラン情報や利用残量を推測しない。
- `listVoices`は`GET /v2/voices?page_size=50&include_total_count=false`を`has_more`と`next_page_token`でページングする。API呼び出し1回につき1ページだけ返し、検索語とカーソルを受け取る。表示名・labelsはサイズ上限と文字種を検証する。
- `listModels`は`GET /v1/models`を呼び、未知フィールドを無視して`can_do_text_to_speech === true`のモデルだけを返す。model IDは各生成時にこの取得結果と照合する。取得失敗時のハードコード代替モデルへのフォールバックはしない。
- 接続確認用の声/モデル一覧レスポンスは、同じHTTPプロセス内で短時間（提案30秒）キャッシュして連続UI呼び出しをまとめる。キー変更がプロセス再起動を伴うためキャッシュ無効化APIは不要。
- `synthesize`は`POST /v1/text-to-speech/{encodeURIComponent(voiceId)}?output_format=pcm_22050`を使用し、`xi-api-key`と`Content-Type: application/json`を設定する。JSON本文は`text`、`model_id`、`voice_settings`、任意の`seed`を送る。
- `voice_settings`は`stability`、`similarity_boost`と、選択モデルで対応する場合の`style`、`use_speaker_boost`に限定する。アカウント保存済み設定は更新せず、当該生成リクエストにだけ適用する。
- `language_code`はMultilingual v2では非対応と公式資料に記載されているため初版では送らず、言語指定の誤認を避ける。日本語テキスト正規化はAPIの`apply_language_text_normalization`を実機で比較し、初版は既定値を維持する。
- タイムアウトは合成60秒、JSON取得8秒。音声本文は既存の20MiB上限内。リダイレクトは`redirect: 'error'`で拒否し、HTTP成功後もPCM長・空応答を検査する。
- HTTP 401/403はキーかvoice権限の確認を案内、404は声/モデルの利用不可、422は入力/モデル条件、429は利用枠・レート制限、5xxとtimeoutは再試行前に状態確認と案内する。自動再試行はしない。
- 応答上流の任意文字列をエンドユーザーへそのまま返さず、ステータス別の固定日本語メッセージへ変換する。上流レスポンスのログも出さない。

### PCMからWAVへの変換とHTTP応答

既存の`/api/casting/preview`は`audio/wav`を返し、保存音声検証はRIFF/WAVEを前提とする。初版はAPIの`pcm_22050`（16-bit PCM）を受け取り、サーバーで単一チャンネルの標準44-byte RIFF/WAVEヘッダーを付けて返す。

- 実装前に実API応答ヘッダーと音声バイト列で、PCM形式、チャンネル数、サンプルレートを有料/無料対象プラン別に確認する。想定と異なるときはWAVラップを行わず、MP3形式拡張へ設計を戻す。
- WAVラップ関数は入力長、RIFFサイズ上限、バイトレート、block alignを検証し、音声本体を再エンコードしない。
- プレビュー結果の`Content-Type`は`audio/wav`、`X-Voice-Atlas-Generation`にはスキーマ検証済みの生成条件だけをURIエンコードJSONで返す。
- 利用可能プランにPCM出力条件がある場合はUIの接続ガイドに記載し、プランが異なるエラーではMP3対応の有無を分かるようにする。ユーザーの契約プランをアプリ側で推定しない。

### Voice Atlas内部API

既存のAPIは互換性を保ち、読み取り用の補助エンドポイントを追加する。

| Method / path                        | 認証           | 入力                                                | 出力                                                                  |
| ------------------------------------ | -------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/casting/voices`            | ローカルアプリ | なし                                                | 既存`engines`へElevenLabs接続状態を追加。ElevenLabsの声一覧は含めない |
| `GET /api/casting/elevenlabs/voices` | ローカルアプリ | `search`最大100字、`cursor`任意                     | 最大50声、`hasMore`、opaque `nextCursor`                              |
| `GET /api/casting/elevenlabs/models` | ローカルアプリ | なし                                                | 合成対応モデル、対応調声、最大文字数、言語一覧                        |
| `POST /api/casting/preview`          | ローカルアプリ | 拡張`castingPreviewSchema`、台詞最大300字を初版維持 | WAVと既存生成ヘッダー                                                 |

- 既存`GET /api/casting/voices`はVOICEVOX/AivisSpeechの部分失敗を保持する。ElevenLabsキー不設定・上流停止も個別engineの`ready: false`へ反映し、全体のHTTP 500にはしない。
- `CastingInventory.engines`は3製品の固定順とし、`detail`は秘密を含まない固定メッセージにする。既存のvoice上限200件は変更しない。ElevenLabs専用声APIが`page_size=50`と上流のnext tokenを管理し、UIは検索・ページングで取得する。cursorは長さ・文字種を検査し、APIキーや内部状態を含めない。
- ElevenLabs声一覧取得に失敗した場合、ページを空一覧へ置き換えずエラー表示を出す。検索条件変更時は前ページのカーソルを破棄する。
- `GET /api/casting/elevenlabs/models`は`ready`, `checkedAt`, `models`を返す。modelの`maximumTextLengthPerRequest`と既存300文字上限の小さい方で生成可否を判定する。
- `POST /api/casting/preview`はエンジンの並行処理を既存`runExclusive`で直列化するか、ElevenLabs用個別Semaphore（初期値1）を導入する。ローカルエンジンの低遅延操作をクラウドAPI待ちで塞がないよう個別Semaphoreを推奨する。
- 外部送信の同意状態は作品設定に保存しない。確認は利用者の現在の操作とUI表示で示し、ページ再読込後も利用者が各合成ボタンを押した時だけ送る。

### 画面と操作フロー

1. 比較画面を開くと既存のVOICEVOX/AivisSpeechに加え、ElevenLabsの接続状態を表示する。
2. ElevenLabsが未設定の場合は`.env`へ設定して再起動する手順を表示する。キー入力欄は作らない。
3. 接続済みなら声一覧を検索・ページングして、名前・種別・簡潔なラベルを表示する。一覧表示だけでは音声プレビューAPIを呼ばない。
4. モデルを選ぶ。初期選択はモデル一覧の言語に日本語が含まれる候補を上位に提示し、実際に日本語対応可能とサーバーが確認していないモデルは明示する。自動で勝手に選択・送信しない。
5. voice settingsは初期値をAPI標準値に合わせる（stability 0.5、similarity 0.75、style 0、speaker boost false）。各値の変更はElevenLabs固有UIで行う。
6. 「ElevenLabsへ送信して試聴」操作の直近に、台詞を外部APIへ送る案内を表示する。クリック後だけ合成し、生成中・失敗・音声再生を既存プレビューと同じ状態管理で扱う。
7. A/B比較で採用を記録すると、声名・voice ID・model ID・調声・採用理由を比較履歴へ保存する。キーは一切含めない。

初版ではvoice cloning、voice design/create、Voice Libraryへの追加/削除、pronunciation dictionary管理、音声効果、ストリーミング再生、使用量取得、履歴取得を提供しない。

### キャッシュ、作品、履歴と互換性

- `shared/casting.ts`の`castingVoiceSchema`、`nativeRecipeSchema`、`generationSchema`、`castingInventorySchema`を拡張する。
- `castingSessionSchema`と`voice-atlas-casting` v1は外側のversionを変えず、候補のdiscriminated unionで新engine値を追加する。旧データの意味・JSON形状は変更しない。
- `shared/project.ts`、`voice-library.ts`、`library-comparison.ts`、`casting-dataset.ts`、`script.ts`、`script-audio-cache.ts`を監査し、engine switch、生成条件キー、履歴フィルター、CSV出力を追加する。
- 新voiceの表示スナップショットとnative recipeは作品JSON・比較JSONに保持する。APIキーやElevenLabsから返る音声バイナリーはメタデータJSONへ入れない。
- 台本の音声cache keyにはengine、voice ID、model ID、各native setting、output format、実際の読み上げ文字列を含める。同じ文字列・同条件だけを再利用する。
- `shared/script-audio-cache.ts`はWAVを維持し、音声本体はPCM→WAV変換した結果を保存する。作品`.vaarchive`は既存コンテナversionを保つ。圧縮形式拡張が必要になった場合は別途archive version bumpと移行仕様を作る。
- 保存キャッシュの生成情報上限に新しいモデル情報を追加する。旧音声は旧生成情報schemaで引き続き読み込めるよう任意フィールドとして追加する。
- `casting-dataset.ts`の製品フィルター/採用件数とCSV欄へElevenLabsを追加する。過去JSON/CSVに新engineがなくても既存通り読み込める。

### 実装・検証の詳細

#### APIクライアントの確認項目

- 空キーで外部fetchが0回。
- `xi-api-key`が正しいホストにだけ送られ、リダイレクト先へ転送されない。
- `/v2/voices`でページ取得、重複ID、壊れたJSON、異常なnext page tokenを処理する。
- `/v1/models`でTTS非対応を除外し、未知項目を安全に無視する。
- モデル最大文字数超過、未知モデル、voice/recipe engine混在、style未対応の組合せを上流課金前に拒否する。
- MP3やHTMLをPCMとして誤認しない。無音/空PCM、不正サイズ、timeout、body上限超過を拒否する。
- 401/403/404/422/429/5xxにキー/台詞/上流bodyを含まない固定エラーを返す。
- 同時操作で同一voice/model/text/recipeの重複生成要求を抑止するか、UIの単一操作中ロックを維持して二重課金を防ぐ。

#### 統合確認

- 旧`voice-atlas-casting`、作品JSON、採用声ライブラリ、作品アーカイブが変更なしで読み込める。
- 新engineの比較・採用・JSON保存・JSON読込・台本割当・音声生成・音声キャッシュ・アーカイブ往復が一貫する。
- APIキー文字列をHTML、全てのJSONレスポンス、生成ヘッダー、音声生成メタデータ、エクスポートへ挿入する検査を行う。
- ElevenLabs未設定・認証失敗・上流障害でもVOICEVOX/AivisSpeech比較、既存音声再生、作品復元が継続できる。
- 実機で日本語共通6文を少数生成し、音質を人が確認する。自動評価結果だけで日本語品質や商用利用条件を断定しない。

### 開始前の未確定項目

1. Voice Atlasの初版範囲を比較プレビューまでに限定するか、台本行別生成まで同時に含めるか。工数と外部課金リスクを抑えるため比較プレビュー先行を推奨する。
2. `pcm_22050`が対象プランで使用できるか、実アカウントで確認する。公式資料ではPCM/WAVの44.1kHz出力にPro以上の条件が示されているため、選択する周波数・プランに応じた実機確認が必要。
3. Voice Libraryの種類やプランによるAPI利用条件をREADMEにどこまで案内するか。アプリで商用利用許諾を一律表示せず、各声・プランの条件確認を促す。

### 参照したAPI契約

- [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) — `POST /v1/text-to-speech/{voice_id}`、`output_format`、`model_id`、`voice_settings`、`seed`、`apply_language_text_normalization`。公式資料ではPCM/WAV 44.1kHz出力にPro以上の条件が記載されている。
- [List voices](https://elevenlabs.io/docs/api-reference/voices/search) — `GET /v2/voices`、最大100件/ページ、`has_more`と`next_page_token`。
- [List models](https://elevenlabs.io/docs/api-reference/models/list) — TTS対応、voice settings対応可否、最大文字数、言語。
- [API Authentication](https://elevenlabs.io/docs/api-reference/authentication) — `xi-api-key`ヘッダーと秘密鍵の取り扱い。
