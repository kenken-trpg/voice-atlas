# Irodoriの技術検証

Irodoriを画面の声選び・台本制作へ接続する前に、声の一貫性・生成速度・メモリーを確認するためのローカル評価コマンド。VoiceDesignの実エンジンで生成・計測した結果は[実機検証記録](verification.md#irodori-voicedesignの実機評価)に記載。聴取評価は未実施で、現時点では音質や実用性を確定していない。

## 対象にする構成

公式の[Irodori-TTS](https://github.com/Aratako/Irodori-TTS)と、手元のソース`2708d3cadf726d4389d25eb4bb7a0344517a9a40`の`InferenceRuntime`・`RuntimeKey`・`SamplingRequest`を確認した。

- [VoiceDesign v2](https://huggingface.co/Aratako/Irodori-TTS-500M-v2-VoiceDesign)：説明文（caption）で声を作る。参照音声の分岐を持たない。
- [通常モデル v2](https://huggingface.co/Aratako/Irodori-TTS-500M-v2)：参照音声で話者を条件付けする。VoiceDesignのcaption入力とは分けて扱う。

二つのモードを別の設定形式にし、チェックポイントの実際の構成と異なる場合は生成前に停止する。v1モデルは対象外。実機を通した互換性は未確認で、将来の上流変更も自動追従しない。VOICEVOXやAivisSpeechの調声値は使わない。

## 準備と診断

利用者が事前にIrodori本体・対応するPython環境・モデル・codec・tokenizerのキャッシュを用意する。準備は上流のインストール手順に従う。評価コマンドがインストールやモデル取得を始めることはない。

```sh
# リポジトリとパッケージの存在確認のみ。モデルは読み込まない。
npm run evaluate:irodori

# 別の配置・Pythonを使う場合
npm run evaluate:irodori -- \
  --repo /path/to/Irodori-TTS \
  --python /path/to/venv/bin/python
```

リポジトリの既定値は作業ディレクトリーからの`../Irodori-TTS`。その`.venv/bin/python`が実行可能なら使い、なければ`python3`を使う。macOS/Linux向けの初期検証で、Windowsでの動作は未確認。診断はパッケージの存在・配布版を調べるだけで、import・デバイス・モデル読み込み・キャッシュの完全性を保証しない。

2026-10-23の初回診断では、Irodoriのソースは存在したが仮想環境はなく、選ばれたPython 3.14.6にはtorch・torchaudio・transformers・huggingface-hub・safetensors・dacvaeがなかった。後続の調査で既存のPython 3.12.13と3.11.15も見つかったが、Python 3.12での事前チェックでもtorch・dacvaeなどとモデル/codecファイルの不足を確認した。搭載メモリーは8GiB、ディスク空きは調査時に約3.3GiBだった。大きな環境・モデルの取得は行わず、保存先の確保を実機検証の前提とする。未使用のモデルをPC全体から網羅検索した結果ではなく、既定のキャッシュにはIrodori/DACVAEの配置が見つからなかった。

## モデルを読み込む前の事前チェック

設定と出力先を決めたら、`--preflight`で検査する。

```sh
npm run evaluate:irodori -- \
  --repo ../Irodori-TTS \
  --python /path/to/venv/bin/python \
  --config .local-artifacts/irodori/design.json \
  --output .local-artifacts/irodori/design-run-1 \
  --preflight
```

出力先の作成・WAV生成・モデル/codecの重みの読み込み・ダウンロードは行わない。通常の診断と異なり、依存モジュールをimportし、指定デバイスの利用可否とtokenizerのオフライン読み込みまで確認する。torchのimportやtokenizerの読み込み自体には時間とメモリーを使う。

- Python 3.10以上、runtimeソース、空でないローカルのcheckpoint/codec/参照音声。
- safetensorsの最大1MiBのヘッダーと`config_json`。caption/referenceモードの一致。重みの内容・形状・完全性の検査ではない。
- runtimeのimportと指定デバイスの解決、DACVAEのimport。参照音声モードでは正規化に必要なaudiotoolsも確認する。
- checkpointで指定されたtext/caption tokenizerのキャッシュ読み込みと語彙数。`local_files_only: true`で不足を確認する。
- 出力先が未使用であること、作成予定先の既存の親ディレクトリーの書き込み権限と空き容量。ディレクトリーは作らない。

JSONの`status`は`passed`・`blocked`・`incomplete`。不明・不足項目はまとめて返し、`passed`以外は終了コード1にする。`.pt`は重みを読まずにメタデータを検査できないため`incomplete`となるが、従来の生成処理では引き続き使える。事前チェックを通っても、モデル/codecのロード成功やメモリー適合・音質は保証しない。codec内部の追加リソースなど、実ロード時だけ分かる不足もある。

音声出力の容量見積もりは、設定した生成秒数によらず1件につき30秒・48kHz・ステレオ・32bitとして約11MiBとヘッダー領域、全体に1MiBを加える保守的な値。28件の例では約309MiBになる。モデルやPython環境のインストール容量、swap、無制限のログ増加は含めない。容量は音声出力先のファイルシステムで測り、モデル配置先と同じとは限らない。通常の生成でも、モデルを読む前にこの容量チェックを実施し、不足なら出力先を作らず拒否する。空き容量は検査後にも変わるため、書き込み時の失敗は生成記録へ残す。

## 条件を確認してから生成する

[VoiceDesign設定例](templates/irodori-voice-design.example.json)または[参照音声設定例](templates/irodori-reference.example.json)を、Git対象外の`.local-artifacts/irodori/`などへコピーする。checkpoint・codecPath・referenceWavは**設定ファイルがあるディレクトリーを基準**に解決する。例のパスを実際のローカルファイルへ変更する。codecPathには、対応するDACVAEの`weights.pth`ファイルを指定する。

```sh
# プラン表示のみ。モデルもPythonも起動せず、出力先も作らない。
npm run evaluate:irodori -- \
  --config .local-artifacts/irodori/design.json --plan

# 生成。未使用の出力先を指定する。
npm run evaluate:irodori -- \
  --repo ../Irodori-TTS \
  --config .local-artifacts/irodori/design.json \
  --output .local-artifacts/irodori/design-run-1
```

VoiceDesign例はcaption 2種類×step 2種類×（seed 2種類×共通文3種類＋同条件の再生成1件）で**28音声**。参照音声例は1参照音声×step 2種類で**14音声**。最初はcaptionを1種類、stepを1種類に減らすと7音声になる。設定でseedは2〜4個、stepは1〜3個（各1〜100）、文は共通6文から2〜6個、captionは1〜3種類を指定できる。重複や不明なフィールドは拒否する。

同じcaptionまたは参照音声に対し、文章を変えたときの声の一貫性、seed変更時の違い、生成ステップの違いを比較する。各caption・stepの最後に、最初の文とseedをもう一度生成する。順番は固定で、ブラインド聴取や順序効果の補正は行わない。

モデルとcodecは同じ指定デバイスを使い、fp32・1候補・順次decode・compileなしに固定する。`seconds`は生成枠の秒数で、設定しなければ上流CLIと同じ30秒、指定できる範囲は1〜30秒。短文の初期評価では10秒などに減らせるが、発話が切れる可能性があるため長い文の読み切りは聴取で確かめる。生成後は末尾をtrimする。参照音声は先頭最大30秒を使い、上流の既定値に合わせて-16dBへ正規化する。これらの有効値と上流dataclassの既定値を生成記録へ保存する。

Hugging FaceとTransformersのオフライン設定を有効にし、Python内のsocket接続・名前解決も拒否する。必要なキャッシュが足りない場合は失敗する。これは評価処理の誤接続を防ぐための実装で、指定したPythonやIrodoriコードを隔離するセキュリティー境界ではない。

既存の出力ディレクトリーは、モデル読み込み前に拒否する。途中失敗後の続きの実行や自動再試行はしない。再実行には新しい出力先を指定する。Ctrl+Cで中止し、成功済み音声と停止箇所を残す。ただしOSによる強制終了やメモリー不足の強制停止では後処理を保証できず、最後の記録が`running`のまま残る場合がある。新しいランは実行PIDを記録する。

### 停止したランの点検と整理

```sh
# 読み取り専用。実行状態、保存済みWAVの容量・SHA-256と記録外のWAVを確認する。
npm run evaluate:irodori -- --inspect-run .local-artifacts/irodori/design-run-15

# runnerActiveがfalseでissuesが空のrunningランだけ整理する。
npm run evaluate:irodori -- --recover-run /path/to/stopped-run

# 実行PIDの記録がない旧ランは、プロセス停止を別途確認したうえで明示する。
npm run evaluate:irodori -- --recover-run /path/to/old-stopped-run --allow-legacy-run
```

整理は`status`を`interrupted`にして`recovery.recoveredAt`と理由を記録する。終了時刻は分からないため`finishedAt`はnullのまま残し、停止時に記録されていた`phase`・`failedSampleId`も保持する。元の記録は同じディレクトリーの`manifest.before-recovery-*.json`に保存する。WAV・`runtime.log`・聴取状態は変更しない。記録済みWAVの不在・不一致、記録外のWAV、稼働中のPIDがあれば整理を拒否する。PIDのない旧ランは稼働確認ができないため明示オプションなしでは拒否する。PIDは再利用され得るため、稼働中と判定されたら実際のプロセスを確認する。`--inspect-run`と`--recover-run`にはモデルやIrodoriの導入は不要で、Python標準ライブラリーだけを使う。

## 出力と測定値の範囲

出力先の`manifest.json`は`voice-atlas-irodori-run` v1。モデル読み込み前に作り、各音声の保存後に一時ファイルから置き換える。`runtime.log`には上流の標準出力・標準エラー、`sample-001.wav`以降には各生成音声を保存する。

- プラン、共通文の版、使用ソースのGit版・変更状態・runtimeファイルのSHA-256、Pythonと主なパッケージの版、機器情報。
- checkpoint・codec・参照音声のパス、ファイル容量とSHA-256。tokenizer一式やすべての依存ソースのハッシュまでは含めず、完全な再現環境を保証しない。
- モデル・codecの有効設定と、各文の実際のSamplingRequest、要求seedと生成結果のseed。
- WAVのSHA-256、バイト数、サンプリング周波数、音声長、同条件の再生成とのハッシュ一致。
- 読み込み時間・各文の生成時間・RTF・上流の段階別時間・メモリー観測値。
- 成否、停止した段階・対象行・失敗理由、未聴取の状態。

`loadMs`はtorch/runtimeのimportからモデル・codec読み込みとデバイス同期まで。事前のハッシュ計算・出力先作成・Node/Python起動は含めない。`elapsedMs`は各文のデバイス同期後にsynthesizeを開始し、生成後の同期完了までを測る。WAV保存・ハッシュ計算は含めない。最初の1件だけ`firstAfterLoad: true`で、残りは同じruntimeを再利用する。OSキャッシュを消したコールドスタートの測定ではない。

`realTimeFactor`は生成秒数÷出力音声秒数。小さいほど速く、1未満は出力音声長より短い生成時間を表す。読み込み時間と区別し、同じ機器・モデル・文章・設定で比較する。

メモリーは読み込み直後と各文の生成直後に観測する。値を足し合わせない。

| 項目                                        | 意味と限界                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| processMaxRssBytes                          | Pythonプロセスの開始から観測時点までのRSS最大値。macOS/LinuxのOS値をバイトへ統一。1文だけの増分ではなく、専用GPUメモリーやほかのプロセスは含まない。 |
| cudaPeakAllocatedBytes                      | torchのCUDA割り当て最大値。モデル読み込み前にカウンターをリセット。予約領域・非torch割り当て・総VRAM使用量ではない。                                 |
| mpsAllocatedBytes / mpsDriverAllocatedBytes | MPSの生成直後の割り当て観測値。ピーク値ではない。統合メモリーのRSSとの重複があり得る。                                                               |

非対応デバイスの値はnull。実際の低メモリー端末での最大消費量や同時実行の余裕は、この記録だけで判断しない。

### 実測メモリーの比較と次回実行前の注意

```sh
# モデルを読み込まず、既存ランを比較する。最初のランを基準にする。
npm run evaluate:irodori -- \
  --memory-report .local-artifacts/irodori/design-run-3 \
  --memory-report .local-artifacts/irodori/design-run-15

# 過去ランを指定して、生成・事前チェックの開始前に注意を表示する。
npm run evaluate:irodori -- \
  --config .local-artifacts/irodori/design-15.json \
  --output .local-artifacts/irodori/next-run \
  --memory-baseline .local-artifacts/irodori/design-run-3 \
  --preflight
```

比較結果はランごとの音声件数、生成枠、生成時間の中央値、MPSドライバー割り当て・CUDA割り当て・プロセスRSSの最大観測値をバイトで示す。差分は両方のランが完了し、mode・device・OS/CPU・checkpoint/codec（参照音声モードでは参照音声）のSHA-256・Irodori runtimeのSHA-256・生成枠・生成設定が一致する場合だけ出す。生成済み音声について、プランとの整合と、順序・文章・caption・seed・step・再生成の対応も確認する。未完了、条件違い、必要な記録の不足では理由を表示して差分をnullにする。差分は同条件で記録された値の差であり、OSのほかの負荷やキャッシュ状態を統制したベンチマークではない。

`--memory-baseline`はmode/deviceが違う基準ランを拒否し、同じ端末・checkpointか、基準ランが未完了か、今回の生成枠が長いかを表示する。同じ端末のMPSドライバー割り当て最大観測値が物理メモリーの65%以上なら、メモリー圧縮・swapの可能性を注意として出す。閾値は負荷の予測や安全上限ではなく、過去の観測値を見落とさないための表示基準。音声生成を自動停止せず、利用者が設定した条件のまま進む。MPS観測値はピークではなく、RSSとは合算しない。基準ランのWAVやmanifestは変更しない。

記録にはローカルの絶対パスと自由記述が含まれる。外へ共有するときは内容を確認する。通常の作品保存・台本・声ライブラリには取り込まず、評価用ディレクトリー内で管理する。

## 聴取して次の構成を決める

### ローカル試聴レビュー画面

既存ランのWAVと生成条件を画面で確認し、最大8ランの音声から2件を並べて選べる。モデルの読み込みや新しい音声生成は行わない。

```sh
npm run evaluate:irodori -- \
  --review-run .local-artifacts/irodori/design-run-3 \
  --review-run .local-artifacts/irodori/design-run-15
```

表示された`http://127.0.0.1:PORT`をローカルのブラウザーで開く。A/Bの再生は一方を開始すると他方を停止する。各音声の文章・caption・seed・step・生成枠・長さと、ランの状態を確認できる。WAVは表示前にmanifestのSHA-256と照合し、不一致なら配信を拒否する。未完了ランにある保存済み音声も表示する。

全体と音声ごとのメモは各ランの`review.json`に保存する。聴取前は「下書き・未判定」のままにし、聴取を終えた場合だけ「聴取済み」を選ぶ。別画面から先に保存された場合は上書きを拒否するので、再読み込みして内容を確認する。`manifest.json`とWAVは変更せず、manifest内の`listening.status`も更新しない。聴取結果は`review.json`を見る。レビュー記録には文章やローカルパスが含まれるため、共有時には内容を確認する。画面はループバックで一時ポートを使い、コマンドを停止すると終了する。

生成成功でも`listening.status`は`not-reviewed`。ハッシュ一致だけで異なる文章の話者一貫性や音質合格とは判断しない。既存の[聴取評価の観点](listening-evaluation.md)に加え、次を手動で記録する。

1. captionの意図に沿うか、文章が変わっても同じキャラクターとして使えるか。
2. 同じseedの再生成、異なるseed、20/40 stepでの声と発音の変化。
3. 通常モデルでは、参照音声の話者の特徴が別の文章でも保たれるか。
4. 読み違い・欠落・不自然な間・音割れ、台本の長さでの読み切り。
5. 読み込み待ち時間、連続生成時のRTF・メモリーと中止後の状態。

同じcaption・seedで十分か、VoiceDesignで作った声を通常モデルの参照音声へ渡す必要があるかを聴取結果で決める。実機を通過した構成を選んでから、製品固有の保存形式・画面・比較・台本へ接続する。

### 保留中の試聴TODO

現在は音声を聴けないため、次の確認を保留する。測定値やWAVのハッシュ一致を聴取結果の代わりにしない。

- [ ] `.local-artifacts/irodori/design-run-3/manifest.json`の条件を確認し、`sample-001.wav`〜`sample-006.wav`を聴く。同じseedの3文で声が保たれるか、seed 17と29でどう変わるか、読み違い・欠落・不自然な間・音割れを記録する。
- [ ] `design-run-3/sample-001.wav`と`sample-007.wav`（同条件の再生成）を聴く。WAVハッシュは一致済みだが、出力の読み切りと声の用途適合性は別に判断する。
- [ ] `design-run-3/sample-001.wav`（10秒枠）と`design-run-15/sample-001.wav`（15秒枠）を聴き比べ、末尾切れの有無を記録する。15秒枠の実行全体は未完了なので、この1件だけを比較対象とする。
- [ ] 結果を[聴取評価の手順](listening-evaluation.md)に従って記録し、VoiceDesignの試験的な採用可否と、通常モデル・参照音声の追加評価が必要かを決める。
