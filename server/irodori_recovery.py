"""Inspect and reconcile interrupted local evaluation runs without loading Irodori."""
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from datetime import datetime, timezone


def _digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _load(directory):
    path = directory / "manifest.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("8MiB以下のmanifest.jsonが必要です。")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("format") != "voice-atlas-irodori-run" or manifest.get("version") != 1:
        raise ValueError("Irodori評価ランv1のmanifest.jsonではありません。")
    if not isinstance(manifest.get("samples"), list) or manifest.get("status") not in ("running", "completed", "failed", "interrupted"):
        raise ValueError("manifest.jsonの状態または音声一覧が不正です。")
    return manifest


def inspect_run(path):
    directory = Path(path).resolve()
    manifest = _load(directory)
    pid = manifest.get("runnerPid")
    if pid is not None and (type(pid) is not int or pid <= 0):
        raise ValueError("runnerPidが不正です。")
    active = _alive(pid) if pid is not None else None
    issues = []
    recorded = set()
    for sample in manifest["samples"]:
        name = sample.get("file") if isinstance(sample, dict) else None
        if not isinstance(name, str) or not re.fullmatch(r"sample-[0-9]{3}\.wav", name) or name in recorded:
            issues.append("音声一覧に不正または重複したファイル名があります。")
            continue
        recorded.add(name)
        file = directory / name
        if not file.is_file() or file.is_symlink():
            issues.append(f"{name}: 記録されたWAVがありません。")
        elif file.stat().st_size != sample.get("bytes") or _digest(file) != sample.get("sha256"):
            issues.append(f"{name}: 記録された容量またはSHA-256と一致しません。")
    unrecorded = sorted(item.name for item in directory.glob("sample-*.wav") if item.name not in recorded)
    if unrecorded:
        issues.append("記録にないWAVがあります: " + ", ".join(unrecorded))
    return {"output": str(directory), "status": manifest["status"], "phase": manifest.get("phase"),
            "failedSampleId": manifest.get("failedSampleId"), "savedSamples": len(manifest["samples"]),
            "runnerPid": pid, "runnerActive": active, "issues": issues,
            "recoverable": manifest["status"] == "running" and active is False and not issues,
            "legacyNeedsExplicitOverride": manifest["status"] == "running" and pid is None and not issues}


def recover_run(path, allow_legacy=False):
    report = inspect_run(path)
    if report["status"] != "running":
        raise ValueError("running状態の評価ランだけを整理できます。")
    if report["runnerActive"]:
        raise ValueError("記録された実行PIDが稼働中です。実行中のランは整理できません。")
    if report["issues"]:
        raise ValueError("保存済みWAVの検査に失敗しました。--inspect-runのissuesを確認してください。")
    if report["runnerPid"] is None and not allow_legacy:
        raise ValueError("古いランには実行PIDがありません。停止を別途確認し、--allow-legacy-runを明示してください。")
    directory = Path(report["output"])
    source = directory / "manifest.json"
    original = source.read_bytes()
    manifest = _load(directory)
    if manifest["status"] != "running":
        raise ValueError("点検後に状態が変わりました。再度--inspect-runしてください。")
    if source.read_bytes() != original:
        raise ValueError("点検後にmanifest.jsonが変わりました。再度--inspect-runしてください。")
    recovery_id = uuid.uuid4().hex
    backup = directory / f"manifest.before-recovery-{recovery_id}.json"
    with backup.open("xb") as saved:
        saved.write(original)
    manifest["status"] = "interrupted"
    manifest["recovery"] = {"recoveredAt": datetime.now(timezone.utc).isoformat(),
                            "reason": "runner-not-active" if report["runnerPid"] else "legacy-run-manually-confirmed"}
    # The process termination time is unknown. Keep finishedAt null and retain
    # the last phase/failedSampleId rather than inventing an exact stop point.
    pending = directory / f"manifest.recovery-{recovery_id}.pending.json"
    with pending.open("x", encoding="utf-8") as saved:
        json.dump(manifest, saved, ensure_ascii=False, indent=2, allow_nan=False)
    pending.replace(source)
    return {**inspect_run(directory), "backup": str(backup)}
