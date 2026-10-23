"""Read-only checks for an Irodori evaluation; no model weights are loaded."""

import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import sys


# A deliberately conservative output estimate, not an installation size or a
# guarantee: 30 seconds, 48 kHz, stereo float32 + header space per sample.
def output_budget(plan):
    return len(plan["samples"]) * (30 * 48000 * 2 * 4 + 4096) + 1024 * 1024


def output_capacity(output, plan):
    ancestor = output.parent
    while not ancestor.exists() and ancestor.parent != ancestor:
        ancestor = ancestor.parent
    usage = shutil.disk_usage(ancestor)
    return {
        "checkedDirectory": str(ancestor),
        "freeBytes": usage.free,
        "estimatedOutputBytes": output_budget(plan),
        "enoughSpace": usage.free >= output_budget(plan),
    }


def require_output_capacity(output, plan):
    capacity = output_capacity(output, plan)
    if not capacity["enoughSpace"]:
        raise ValueError(
            "出力先の空き容量が評価音声の見積もりを下回っています。"
            f"空き {capacity['freeBytes']} bytes / 見積もり {capacity['estimatedOutputBytes']} bytes。"
            "出力先を変更するか、評価条件を減らしてください。"
        )
    return capacity


def checkpoint_config(path):
    if path.suffix != ".safetensors":
        return None  # Inspecting .pt safely requires loading its tensor payload.
    with path.open("rb") as source:
        length_bytes = source.read(8)
        if len(length_bytes) != 8:
            raise ValueError("safetensorsのヘッダーが途中で切れています。")
        length = struct.unpack("<Q", length_bytes)[0]
        if not 2 <= length <= 1024 * 1024:
            raise ValueError("safetensorsのヘッダー長が不正、または1MiBを超えています。")
        header_bytes = source.read(length)
        if len(header_bytes) != length:
            raise ValueError("safetensorsのヘッダーが途中で切れています。")
    header = json.loads(header_bytes)
    raw = header.get("__metadata__", {}).get("config_json")
    if not isinstance(raw, str):
        raise ValueError("safetensorsにIrodoriのconfig_jsonがありません。")
    config = json.loads(raw)
    if not isinstance(config, dict):
        raise ValueError("Irodoriのconfig_jsonがオブジェクトではありません。")
    caption = config.get("use_caption_condition", False)
    if not isinstance(caption, bool):
        raise ValueError("use_caption_conditionが真偽値ではありません。")
    return config


def preflight(repo, output, plan):
    checks = []

    def record(name, action):
        try:
            detail = action()
            checks.append({"name": name, "status": "passed", "detail": detail})
            return detail
        except Exception as error:
            checks.append({"name": name, "status": "blocked", "detail": str(error)[:1000]})
            return None

    def file_info(path):
        if not path.is_file():
            raise ValueError(f"ローカルファイルがありません: {path}")
        size = path.stat().st_size
        if size == 0:
            raise ValueError(f"ファイルが空です: {path}")
        with path.open("rb") as source:
            source.read(1)  # Report unreadable files without reading model tensors.
        return {"file": str(path), "bytes": size}

    config = plan["config"]
    record("python", lambda: check_python())
    runtime_source = repo / "irodori_tts/inference_runtime.py"
    record("runtime-source", lambda: file_info(runtime_source))
    assets = {"checkpoint": Path(config["checkpoint"]), "codec": Path(config["codecPath"])}
    if config["mode"] == "reference":
        assets["reference"] = Path(config["referenceWav"])
    present = {name: record(name, lambda path=path: file_info(path)) for name, path in assets.items()}

    def check_output():
        if output.exists() or output.is_symlink():
            raise ValueError("出力先が既に存在します。新しいディレクトリーを指定してください。")
        capacity = require_output_capacity(output, plan)
        if not Path(capacity["checkedDirectory"]).is_dir():
            raise ValueError("出力先の親がディレクトリーではありません。")
        if not os.access(capacity["checkedDirectory"], os.W_OK | os.X_OK):
            raise ValueError("出力先の親ディレクトリーへ書き込む権限がありません。")
        return capacity

    record("output", check_output)
    metadata = None
    if present["checkpoint"]:
        metadata = record("checkpoint-metadata", lambda: checkpoint_config(assets["checkpoint"]))
        if metadata is None and checks[-1]["status"] == "passed":
            checks[-1].update(status="incomplete", detail=".ptは重みを読まない事前検査の対象外です。")
    if metadata is not None:
        def check_mode():
            caption = metadata.get("use_caption_condition", False)
            if caption != (config["mode"] == "voice-design"):
                raise ValueError("設定モードとチェックポイントのcaption/reference構成が一致しません。")
            return {"mode": config["mode"]}
        record("checkpoint-mode", check_mode)

    # Import dependencies and resolve the requested device, but never call
    # InferenceRuntime.from_key. Redirect noisy import output to keep stdout JSON.
    imports = {}
    diagnostics = io.StringIO()

    def check_runtime():
        with contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
            from irodori_tts.inference_runtime import resolve_runtime_device
            from irodori_tts.config import ModelConfig
            from irodori_tts.tokenizer import PretrainedTextTokenizer
            imports.update(ModelConfig=ModelConfig, Tokenizer=PretrainedTextTokenizer)
            device = resolve_runtime_device(config["device"])
        return {"device": str(device)}

    imported = record("runtime-import-and-device", check_runtime) is not None
    def check_codec_import():
        with contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
            try:
                from dacvae import DACVAE
            except ImportError:
                # Match the upstream codec's supported sibling checkout fallback.
                fallback = repo.parent / "dacvae"
                if fallback.is_dir():
                    sys.path.insert(0, str(fallback))
                from dacvae import DACVAE
            if not callable(getattr(DACVAE, "load", None)):
                raise ValueError("DACVAE.loadがありません。対応するcodec環境を確認してください。")
            if config["mode"] == "reference":
                from audiotools import AudioSignal  # Required by -16 dB reference normalization.
        return {"weightsLoaded": False}
    record("codec-import", check_codec_import)
    if imported and metadata is not None:
        def check_tokenizers():
            model_metadata = {key: value for key, value in metadata.items()
                              if key not in {"max_text_len", "max_caption_len", "fixed_target_latent_steps"}}
            model = imports["ModelConfig"](**model_metadata)
            conditions = [("text", model.text_tokenizer_repo, model.text_add_bos, model.text_vocab_size)]
            if model.use_caption_condition:
                conditions.append(("caption", model.caption_tokenizer_repo_resolved,
                                   model.caption_add_bos_resolved, model.caption_vocab_size_resolved))
            result = []
            for kind, repo_id, bos, expected_vocab in conditions:
                with contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
                    tokenizer = imports["Tokenizer"].from_pretrained(
                        repo_id=repo_id, add_bos=bos, local_files_only=True)
                if tokenizer.vocab_size != expected_vocab:
                    raise ValueError(f"{kind} tokenizerの語彙数とチェックポイントが一致しません。")
                result.append({"kind": kind, "repo": repo_id, "vocabSize": tokenizer.vocab_size})
            return result
        record("cached-tokenizers", check_tokenizers)
    else:
        checks.append({"name": "cached-tokenizers", "status": "incomplete",
                       "detail": "runtimeのimportとsafetensorsメタデータの確認後に検査できます。"})
    statuses = {check["status"] for check in checks}
    status = "blocked" if "blocked" in statuses else "incomplete" if "incomplete" in statuses else "passed"
    return {
        "format": "voice-atlas-irodori-preflight",
        "version": 1,
        "status": status,
        "modelLoaded": False,
        "generated": False,
        "plannedSamples": len(plan["samples"]),
        "checks": checks,
        "importDiagnostics": diagnostics.getvalue()[-2000:],
        "note": "事前検査の成功は生成成功やメモリー適合を保証しません。モデル/codecの重みは読み込んでいません。",
    }


def check_python():
    if sys.version_info < (3, 10):
        raise ValueError("IrodoriにはPython 3.10以上を指定してください。")
    return {"version": sys.version.split()[0], "executable": sys.executable}
