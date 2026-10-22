"""Local-only Irodori v2 spike. Invoked by irodori-probe.ts, not the web server."""
import argparse
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    hasher = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def version(package):
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return None


def git(repo, *args):
    try:
        return subprocess.check_output(
            ["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def memory(torch, device):
    # ru_maxrss is a cumulative process high-water mark: bytes on macOS, KiB on
    # Linux. It is not per-sample RSS and excludes dedicated GPU memory.
    rss = None
    if sys.platform in ("darwin", "linux"):
        import resource
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss = int(rss * (1 if sys.platform == "darwin" else 1024))
    result = {"processMaxRssBytes": rss, "cudaPeakAllocatedBytes": None,
              "mpsAllocatedBytes": None, "mpsDriverAllocatedBytes": None}
    if device == "cuda":
        result["cudaPeakAllocatedBytes"] = int(torch.cuda.max_memory_allocated())
    elif device == "mps":
        result["mpsAllocatedBytes"] = int(torch.mps.current_allocated_memory())
        result["mpsDriverAllocatedBytes"] = int(torch.mps.driver_allocated_memory())
    return result


def sync(torch, device):
    if device == "cuda":
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


def inspect(repo):
    packages = {name: {"available": importlib.util.find_spec(module) is not None,
                       "version": version(name)}
                for name, module in [("torch", "torch"), ("torchaudio", "torchaudio"),
                                     ("transformers", "transformers"),
                                     ("huggingface-hub", "huggingface_hub"),
                                     ("safetensors", "safetensors"), ("dacvae", "dacvae")]}
    return {"python": sys.version.split()[0], "executable": sys.executable,
            "repo": str(repo), "runtimeSourcePresent": (repo / "irodori_tts/inference_runtime.py").is_file(),
            "revision": git(repo, "rev-parse", "HEAD"), "packages": packages,
            "modelLoaded": False, "generated": False,
            "note": "パッケージの存在確認のみ。import・デバイス・モデル・キャッシュの動作確認ではありません。"}


def run(repo, output, plan):
    config = plan["config"]
    runtime_source = repo / "irodori_tts/inference_runtime.py"
    assets = {"checkpoint": Path(config["checkpoint"]), "codec": Path(config["codecPath"])}
    if config["mode"] == "reference":
        assets["reference"] = Path(config["referenceWav"])
    if not runtime_source.is_file():
        raise ValueError("Irodori v2の inference_runtime.py が見つかりません。--repo を確認してください。")
    for name, asset in assets.items():
        if not asset.is_file():
            raise ValueError(f"{name}: ローカルファイルがありません: {asset}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()  # Reserve before imports/hashing/generation; never overwrite a run.
    manifest = {"format": "voice-atlas-irodori-run", "version": 1, "id": str(uuid.uuid4()),
                "createdAt": now(), "finishedAt": None, "status": "running", "phase": "prepare",
                "plan": plan, "source": {"revision": git(repo, "rev-parse", "HEAD"),
                "dirty": git(repo, "status", "--porcelain", "--untracked-files=no"),
                "runtimeSha256": digest(runtime_source)},
                "machine": {"platform": platform.system(), "release": platform.release(),
                "arch": platform.machine(), "logicalCpus": os.cpu_count(), "python": sys.version.split()[0],
                "packages": {name: version(name) for name in ["torch", "torchaudio", "transformers", "dacvae"]}},
                "assets": {}, "loadMs": None, "afterLoadMemory": None,
                "samples": [], "failedSampleId": None, "error": None,
                "listening": {"status": "not-reviewed", "notes": "", "ratings": None}}

    def save():
        pending = output / "manifest.pending.json"
        pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        pending.replace(output / "manifest.json")

    save()
    try:
        with open(output / "runtime.log", "x", encoding="utf-8") as log:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                manifest["assets"] = {name: {"file": str(asset), "bytes": asset.stat().st_size,
                                              "sha256": digest(asset)} for name, asset in assets.items()}
                manifest["phase"] = "load"
                save()
                started = time.perf_counter()
                import torch
                from irodori_tts.inference_runtime import InferenceRuntime, RuntimeKey, SamplingRequest, save_wav
                device = config["device"]
                if device == "cuda":
                    torch.cuda.reset_peak_memory_stats()
                runtime = InferenceRuntime.from_key(RuntimeKey(
                    checkpoint=str(assets["checkpoint"]), codec_repo=str(assets["codec"]),
                    model_device=device, codec_device=device, **plan["runtime"]))
                sync(torch, device)
                manifest["loadMs"] = round((time.perf_counter() - started) * 1000, 3)
                manifest["afterLoadMemory"] = memory(torch, device)
                caption_enabled = bool(runtime.model_cfg.use_caption_condition)
                speaker_enabled = bool(runtime.model_cfg.use_speaker_condition)
                if (caption_enabled, speaker_enabled) != ((True, False) if config["mode"] == "voice-design" else (False, True)):
                    raise ValueError("設定モードとチェックポイントのcaption/reference構成が一致しません。")
                # Record every effective default too: future source changes must
                # remain visible even for fields not explicitly set by the plan.
                from dataclasses import asdict
                manifest["runtimeKey"] = asdict(runtime.key)
                manifest["phase"] = "generate"
                save()
                for sample in plan["samples"]:
                    manifest["failedSampleId"] = sample["id"]
                    save()
                    request = SamplingRequest(
                        text=sample["text"], caption=sample["caption"], seed=sample["seed"],
                        num_steps=sample["steps"], no_ref=config["mode"] == "voice-design",
                        ref_wav=str(assets["reference"]) if "reference" in assets else None,
                        **plan["sampling"])
                    sync(torch, device)
                    started = time.perf_counter()
                    result = runtime.synthesize(request)
                    sync(torch, device)
                    elapsed = (time.perf_counter() - started) * 1000
                    if result.used_seed != sample["seed"]:
                        raise ValueError("要求したseedと生成結果のseedが一致しません。")
                    duration = result.audio.shape[-1] / result.sample_rate
                    if duration <= 0:
                        raise ValueError("生成音声が空です。")
                    observed_memory = memory(torch, device)
                    file = sample["id"] + ".wav"
                    save_wav(output / file, result.audio, result.sample_rate)
                    sha256 = digest(output / file)
                    original = next((item for item in manifest["samples"] if item["id"] == sample["repeatOf"]), None)
                    manifest["samples"].append({**sample, "request": asdict(request), "file": file,
                        "firstAfterLoad": not manifest["samples"],
                        "usedSeed": result.used_seed, "elapsedMs": round(elapsed, 3),
                        "durationSeconds": duration, "realTimeFactor": elapsed / 1000 / duration,
                        "sampleRate": result.sample_rate, "bytes": (output / file).stat().st_size,
                        "sha256": sha256, "repeatHashMatches": original["sha256"] == sha256 if original else None,
                        "memory": observed_memory, "stageTimingsSeconds": result.stage_timings,
                        "totalToDecodeSeconds": result.total_to_decode, "messages": result.messages})
                    manifest["failedSampleId"] = None
                    save()
                    del result  # Avoid retaining previous waveforms across samples.
                manifest["status"] = "completed"
                manifest["phase"] = "finished"
    except BaseException as error:
        manifest["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        manifest["error"] = str(error)[:1000] or type(error).__name__
        raise
    finally:
        manifest["finishedAt"] = now()
        save()
    return {"status": manifest["status"], "samples": len(manifest["samples"]),
            "output": str(output), "listening": "not-reviewed"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--diagnose", action="store_true")
    parser.add_argument("--output")
    args = parser.parse_args()
    # Set before any third-party import; cached tokenizer files must already exist.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    def offline(event, _args):
        if event in ("socket.connect", "socket.getaddrinfo"):
            raise RuntimeError("Irodori評価中のネットワーク接続は禁止されています。必要なファイルを事前に準備してください。")
    sys.addaudithook(offline)
    repo = Path(args.repo).resolve()
    sys.path.insert(0, str(repo))
    if args.diagnose:
        print(json.dumps(inspect(repo), ensure_ascii=False, indent=2))
        return
    if not args.output:
        parser.error("--output is required for generation")
    print(json.dumps(run(repo, Path(args.output).resolve(), json.load(sys.stdin)), ensure_ascii=False))


def interrupt(_signal, _frame):
    # A terminal signal and the Node parent's forwarded signal can both arrive.
    # Ignore repeats so they do not interrupt manifest cleanup.
    if not getattr(interrupt, "received", False):
        interrupt.received = True
        raise KeyboardInterrupt("利用者が生成を中止しました。")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except KeyboardInterrupt:
        print("Irodoriの評価を中止しました。保存済みの音声とmanifest.jsonを確認してください。", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        print(f"Irodoriの評価に失敗しました: {error}", file=sys.stderr)
        sys.exit(1)
