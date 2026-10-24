"""Colab PoC for Irodori-TTS v4.1-Small Voice Design.

Run from /content/Irodori-TTS with: uv run --no-sync python /path/to/this-file
Uses the existing environment and loads the model once for all samples.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

MODEL_ID = "Aratako/Irodori-TTS-v4.1-Small"
MODEL_REVISION = "2b28324dc263ed5e6638b3cf3dd94c82ead07b4b"
CODEC_ID = "Aratako/Semantic-DACVAE-Japanese-32dim"
SEED = 17
STEPS = 40

# Set this to a mounted Drive directory to preserve WAVs and records across Colab resets.
OUTPUT_ROOT = Path("/content/drive/MyDrive/irodori-v41-poc")

VOICES = {
    "old_mage": "高齢の男性魔術師。低く少しかすれた声。落ち着いて威厳があり、一語ずつ明瞭に話す。",
    "executive": "冷静な企業幹部。中低音の大人の女性。知的で抑制の効いた声で、明瞭に話す。",
    "artificial_intelligence": "人工知能の案内音声。中性的で澄んだ声。抑揚は控えめで、正確かつ明瞭に話す。",
}

# All voices use the same lines so the listening comparison isolates voice identity.
LINES = {
    "normal": "ようこそ。あなたを待っていました。まずは話を聞かせてください。",
    "emotional": "待ってください！　その扉を開けたら、もう後戻りはできません。",
    "long": "この街には古い記録が残っています。百年前、北の塔で起きた出来事を知る者はほとんどいません。ですが、今夜その秘密を確かめることができます。準備ができたら、私に声をかけてください。",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_manifest(path: Path, manifest: dict) -> None:
    pending = path.with_suffix(".pending.json")
    pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    pending.replace(path)


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def git_value(*args: str) -> str | None:
    try:
        return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


class Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, text: str) -> None:
        for stream in self.streams:
            stream.write(text)

    def flush(self) -> None:
        for stream in self.streams:
            stream.flush()


def main() -> None:
    if not (Path.cwd() / "infer.py").is_file():
        raise RuntimeError("/content/Irodori-TTS から実行してください。")
    if not OUTPUT_ROOT.parent.is_dir():
        raise RuntimeError("Google Drive が未マウントです。先に drive.mount('/content/drive') を実行してください。")

    import torch
    from huggingface_hub import snapshot_download
    from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey, SamplingRequest, save_wav

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU が利用できません。ColabのGPUランタイムを確認してください。")

    run_dir = OUTPUT_ROOT / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    run_dir.mkdir(parents=True, exist_ok=False)
    manifest_path = run_dir / "manifest.json"
    gpu = torch.cuda.get_device_properties(0)
    manifest = {
        "format": "irodori-v41-voice-design-poc",
        "status": "running",
        "createdAt": utc_now(),
        "finishedAt": None,
        "source": {"gitRevision": git_value("rev-parse", "HEAD"), "gitStatus": git_value("status", "--porcelain")},
        "model": {"repo": MODEL_ID, "revision": MODEL_REVISION, "checkpoint": None, "sha256": None},
        "codec": CODEC_ID,
        "environment": {
            "python": sys.version.split()[0], "platform": platform.platform(),
            "packages": {name: package_version(name) for name in ("torch", "torchaudio", "transformers", "huggingface-hub", "dacvae")},
            "gpu": {"name": torch.cuda.get_device_name(0), "totalVramBytes": gpu.total_memory},
        },
        "settings": {"seed": SEED, "steps": STEPS, "seconds": None, "noRef": True,
                     "precision": "fp32", "voices": VOICES, "lines": LINES},
        "loadSeconds": None,
        "samples": [],
        "error": None,
        "listening": {"status": "not-reviewed", "notes": ""},
    }
    save_manifest(manifest_path, manifest)
    console_out, console_err = sys.stdout, sys.stderr
    log = (run_dir / "runtime.log").open("w", encoding="utf-8", buffering=1)
    sys.stdout, sys.stderr = Tee(console_out, log), Tee(console_err, log)

    try:
        print(f"Run: {run_dir}", flush=True)
        checkpoint_dir = Path(snapshot_download(
            repo_id=MODEL_ID, revision=MODEL_REVISION,
            allow_patterns=["model.safetensors", "tokenizer/**"],
        ))
        checkpoint = checkpoint_dir / "model.safetensors"
        if not checkpoint.is_file():
            raise FileNotFoundError(checkpoint)
        manifest["model"]["checkpoint"] = str(checkpoint)
        manifest["model"]["sha256"] = sha256(checkpoint)
        save_manifest(manifest_path, manifest)

        torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        runtime = InferenceRuntime.from_key(RuntimeKey(
            checkpoint=str(checkpoint), codec_repo=CODEC_ID,
            model_device="cuda", codec_device="cuda",
            model_precision="fp32", codec_precision="fp32",
        ))
        torch.cuda.synchronize()
        manifest["loadSeconds"] = round(time.perf_counter() - started, 3)
        manifest["loadCudaPeakAllocatedBytes"] = torch.cuda.max_memory_allocated()
        manifest["loadCudaPeakReservedBytes"] = torch.cuda.max_memory_reserved()
        if not runtime.model_cfg.use_caption_condition:
            raise RuntimeError("チェックポイントのcaption条件付けが無効です。")
        save_manifest(manifest_path, manifest)

        # Repeat the normal line after other lines to assess repeatability.
        for voice_id, caption in VOICES.items():
            for line_id in (*LINES.keys(), "normal_repeat"):
                text = LINES["normal" if line_id == "normal_repeat" else line_id]
                sample_id = f"{voice_id}-{line_id}"
                manifest["currentSample"] = sample_id
                save_manifest(manifest_path, manifest)
                torch.cuda.reset_peak_memory_stats()
                torch.cuda.synchronize()
                started = time.perf_counter()
                result = runtime.synthesize(SamplingRequest(
                    text=text, caption=caption, no_ref=True, seed=SEED,
                    num_steps=STEPS, seconds=None, num_candidates=1,
                    decode_mode="sequential", cfg_scale_text=3.0,
                    cfg_scale_caption=3.0, cfg_scale_speaker=5.0,
                ))
                torch.cuda.synchronize()
                elapsed = time.perf_counter() - started
                wav = run_dir / f"{sample_id}.wav"
                save_wav(wav, result.audio, result.sample_rate)
                duration = result.audio.shape[-1] / result.sample_rate
                sample = {
                    "id": sample_id, "voice": voice_id, "line": line_id,
                    "caption": caption, "text": text, "requestedSeed": SEED,
                    "usedSeed": result.used_seed, "steps": STEPS,
                    "file": wav.name, "sha256": sha256(wav), "bytes": wav.stat().st_size,
                    "sampleRate": result.sample_rate, "durationSeconds": duration,
                    "elapsedSeconds": elapsed, "realTimeFactor": elapsed / duration,
                    "totalToDecodeSeconds": result.total_to_decode,
                    "stageTimings": result.stage_timings,
                    "cudaPeakAllocatedBytes": torch.cuda.max_memory_allocated(),
                    "cudaPeakReservedBytes": torch.cuda.max_memory_reserved(),
                }
                manifest["samples"].append(sample)
                save_manifest(manifest_path, manifest)
                print(f"{sample_id}: {duration:.2f}s, RTF={elapsed / duration:.3f}, {wav}", flush=True)
                del result
        manifest["status"] = "completed"
        manifest.pop("currentSample", None)
    except BaseException as exc:
        manifest["status"] = "interrupted" if isinstance(exc, KeyboardInterrupt) else "failed"
        manifest["error"] = f"{type(exc).__name__}: {exc}"
        (run_dir / "error.log").write_text(traceback.format_exc(), encoding="utf-8")
        raise
    finally:
        manifest["finishedAt"] = utc_now()
        save_manifest(manifest_path, manifest)
        print(f"Record: {manifest_path}", flush=True)
        sys.stdout, sys.stderr = console_out, console_err
        log.close()


if __name__ == "__main__":
    main()
