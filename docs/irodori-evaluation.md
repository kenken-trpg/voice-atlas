# Irodoriの技術検証

Irodoriを画面の声選び・台本制作へ接続する前に、声の一貫性・生成速度・メモリーを確認するためのローカル評価コマンド。実エンジンの生成・聴取は未実施で、現時点では対応構成や実用性を確定していない。

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

2026-10-23のこのPCでは、Irodoriのソースは存在したが仮想環境はなく、選ばれたPython 3.14.6にはtorch・torchaudio・transformers・huggingface-hub・safetensors・dacvaeがなかった。生成可能な状態ではない。今回、環境やモデルの追加は行っていない。

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

モデルとcodecは同じ指定デバイスを使い、fp32・1候補・順次decode・compileなしに固定する。各文は上流CLIと同じ最大30秒の生成枠で末尾をtrimする。長い文の読み切りは聴取で確かめる。参照音声は先頭最大30秒を使い、上流の既定値に合わせて-16dBへ正規化する。これらの有効値と上流dataclassの既定値を生成記録へ保存する。

Hugging FaceとTransformersのオフライン設定を有効にし、Python内のsocket接続・名前解決も拒否する。必要なキャッシュが足りない場合は失敗する。これは評価処理の誤接続を防ぐための実装で、指定したPythonやIrodoriコードを隔離するセキュリティー境界ではない。

既存の出力ディレクトリーは、モデル読み込み前に拒否する。途中失敗後の続きの実行や自動再試行はしない。再実行には新しい出力先を指定する。Ctrl+Cで中止し、成功済み音声と停止箇所を残す。ただしOSによる強制終了やメモリー不足の強制停止では後処理を保証できず、最後の記録が`running`のまま残る場合がある。

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

記録にはローカルの絶対パスと自由記述が含まれる。外へ共有するときは内容を確認する。通常の作品保存・台本・声ライブラリには取り込まず、評価用ディレクトリー内で管理する。

## 聴取して次の構成を決める

生成成功でも`listening.status`は`not-reviewed`。ハッシュ一致だけで異なる文章の話者一貫性や音質合格とは判断しない。既存の[聴取評価の観点](listening-evaluation.md)に加え、次を手動で記録する。

1. captionの意図に沿うか、文章が変わっても同じキャラクターとして使えるか。
2. 同じseedの再生成、異なるseed、20/40 stepでの声と発音の変化。
3. 通常モデルでは、参照音声の話者の特徴が別の文章でも保たれるか。
4. 読み違い・欠落・不自然な間・音割れ、台本の長さでの読み切り。
5. 読み込み待ち時間、連続生成時のRTF・メモリーと中止後の状態。

同じcaption・seedで十分か、VoiceDesignで作った声を通常モデルの参照音声へ渡す必要があるかを聴取結果で決める。実機を通過した構成を選んでから、製品固有の保存形式・画面・比較・台本へ接続する。
