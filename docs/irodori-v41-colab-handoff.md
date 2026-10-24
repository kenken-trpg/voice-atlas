# Irodori-TTS v4.1-Small: Colab Voice Design 検証

2026-10-24の基本音声生成PoCの次段階。既存のColabランタイムと`/content/Irodori-TTS/.venv`を使い、モデルを一度だけロードして12音声を生成する。既存の`docs/irodori-evaluation.md`はv2向けなので、この手順には使わない。

## Colabでの実行

1. Google Driveをマウントする。

   ```python
   from google.colab import drive
   drive.mount('/content/drive')
   ```

2. [検証スクリプト](../scripts/irodori-v41-voice-design.py)をColabへアップロードする。

   ```python
   %cd /content
   from google.colab import files
   uploaded = files.upload()  # irodori-v41-voice-design.py を選ぶ
   ```

3. 既存環境のまま実行する。ランタイムがリセットされている場合だけ、引き継ぎ報告書のcloneと`uv sync --extra cu128`を先に実施する。

   ```python
   %cd /content/Irodori-TTS
   !uv run --no-sync python /content/irodori-v41-voice-design.py
   ```

スクリプト先頭の`VOICES`、`LINES`、`SEED`、`STEPS`を変えるときは実行前に変更する。初回比較では変更せずに実行する。モデルは引き継ぎ報告書のHugging Faceリビジョン`2b28324dc263ed5e6638b3cf3dd94c82ead07b4b`へ固定し、captionと`no_ref=True`を指定する。公式の[VoiceDesign手順](https://github.com/Aratako/Irodori-TTS#voicedesign)と[パラメータ説明](https://github.com/Aratako/Irodori-TTS/blob/main/docs/parameters.md)に従い、40 step、fp32、予測尺を使う。

## 生成と評価

3話者それぞれに、共通の通常・感情・長文台詞を生成し、通常台詞を最後に同一条件で再生成する。全12件。各話者でcaption以外の条件を揃える。これにより、声質指定への追従と、異なる台詞間の一貫性を聴いて比較できる。同じseedで再生成したWAVの一致は補助情報であり、声の一貫性の聴取判定には代わらない。

Driveの`MyDrive/irodori-v41-poc/<UTC日時>-<ID>/`へ、WAV、`manifest.json`、`runtime.log`、失敗時は`error.log`を保存する。`manifest.json`にはGit版、モデルのSHA-256、Python・パッケージ版、GPU型番・総VRAM、モデルロード時間、各音声の生成時間・RTF・CUDAのtorch割当ピーク・WAVのSHA-256を記録する。CUDA割当ピークはGPU全体の使用量ではない。ColabのCompute Unit消費量はAPIから取得せず、Colab画面の値を別途控える。

実行後に各話者の4音声を試聴し、`manifest.json`の`listening`は未評価のまま保持する。別のメモに次を記録する。

| 話者     | 声質指定への追従 | 3台詞間の一貫性 | 発音・欠落・末尾切れ | 通常と再生成の差 | 採用判断 |
| -------- | ---------------- | --------------- | -------------------- | ---------------- | -------- |
| 老魔術師 |                  |                 |                      |                  |          |
| 企業幹部 |                  |                 |                      |                  |          |
| 人工知能 |                  |                 |                      |                  |          |

音声の試聴例：

```python
from IPython.display import Audio, display
display(Audio('/content/drive/MyDrive/irodori-v41-poc/<実際の実行ID>/old_mage-normal.wav'))
```

今回の条件で実際に生成した結果が揃うまで、v4.1 Voice Designの品質・再現性・ローカルGPU適合性は未判定とする。
