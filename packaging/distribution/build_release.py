#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

PRODUCT_SLUG = "rheinagent-file-upload"
PRODUCT_NAME = "RheinAgent File Upload"
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)
MAX_ENTRIES = 5000
MAX_EXPANDED_BYTES = 256 * 1024 * 1024



def run(*args: str, cwd: Path | None = None) -> str:
    completed = subprocess.run(args, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return completed.stdout


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def package_version(repo: Path) -> str:
    value = json.loads((repo / "package.json").read_text(encoding="utf-8-sig"))
    return str(value["version"])


def git_commit(repo: Path) -> str:
    return str(run("git", "rev-parse", "HEAD", cwd=repo)).strip()


def git_commit_time(repo: Path) -> str:
    epoch = int(str(run("git", "show", "-s", "--format=%ct", "HEAD", cwd=repo)).strip())
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def load_signing_key(signing_key: Path) -> Ed25519PrivateKey:
    value = serialization.load_pem_private_key(signing_key.read_bytes(), password=None)
    if not isinstance(value, Ed25519PrivateKey):
        raise SystemExit("signing key must be Ed25519")
    return value


def public_key_bytes(signing_key: Path) -> bytes:
    return load_signing_key(signing_key).public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def key_id(signing_key: Path) -> str:
    return "ed25519-sha256:" + sha256_bytes(public_key_bytes(signing_key))


def runtime_files(runtime: Path) -> list[Path]:
    files: list[Path] = []
    total = 0
    for path in sorted(runtime.rglob("*"), key=lambda item: item.relative_to(runtime).as_posix()):
        if path.is_symlink():
            raise SystemExit(f"runtime contains symbolic link: {path}")
        if path.is_file():
            files.append(path)
            total += path.stat().st_size
    if not files or len(files) > MAX_ENTRIES - 1:
        raise SystemExit(f"runtime file count rejected: {len(files)}")
    if total > MAX_EXPANDED_BYTES:
        raise SystemExit(f"runtime expanded size rejected: {total}")
    return files


def zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def sign(signing_key: Path, package: Path, signature: Path) -> None:
    key = load_signing_key(signing_key)
    signature.write_bytes(key.sign(package.read_bytes()))


def verify_signature(signing_key: Path, package: Path, signature: Path) -> None:
    key = load_signing_key(signing_key)
    key.public_key().verify(signature.read_bytes(), package.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--out-dir", default=".state/distribution/release")
    parser.add_argument("--channel", choices=("stable", "candidate"), default="candidate")
    parser.add_argument("--min-manager-version", default="0.4.0-rc.7")
    parser.add_argument("--signing-key", required=True)
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    runtime = Path(args.runtime_dir).resolve()
    signing_key = Path(args.signing_key).resolve()
    if not runtime.is_dir() or not signing_key.is_file():
        raise SystemExit("runtime directory or signing key is missing")
    version = package_version(repo)
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise SystemExit("package version is not SemVer compatible")
    runtime_marker = runtime / ".runtime-version"
    if not runtime_marker.is_file() or runtime_marker.read_text(encoding="utf-8-sig").strip() != version:
        raise SystemExit("runtime version marker does not match source version")
    activation = json.loads((repo / "packaging/distribution/activation-contract.json").read_text(encoding="utf-8-sig"))
    files = runtime_files(runtime)
    metadata_files = []
    for path in files:
        rel = path.relative_to(runtime).as_posix()
        metadata_files.append({"path": f"payload/{rel}", "sha256": sha256_file(path), "size": path.stat().st_size})
    descriptor = {
        "format_version": 2,
        "product_slug": PRODUCT_SLUG,
        "product_name": PRODUCT_NAME,
        "version": version,
        "source_commit": git_commit(repo),
        "channel": args.channel,
        "min_manager_version": args.min_manager_version,
        "payload_root": "payload",
        "activation": activation,
        "installers": {},
        "files": metadata_files,
    }
    output = Path(args.out_dir)
    if not output.is_absolute():
        output = repo / output
    output.mkdir(parents=True, exist_ok=True)
    package = output / f"{PRODUCT_SLUG}-{version}.rapkg"
    signature = output / f"{package.name}.sig"
    manifest_path = output / "manifest.json"
    sums_path = output / "SHA256SUMS"
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(zip_info("RHEINAGENT_PACKAGE.json"), (json.dumps(descriptor, sort_keys=True, separators=(",", ":")) + "\n").encode())
        for path in files:
            archive.writestr(zip_info(f"payload/{path.relative_to(runtime).as_posix()}"), path.read_bytes())
    sign(signing_key, package, signature)
    verify_signature(signing_key, package, signature)
    manifest = {
        "schema_version": 1,
        "product_slug": PRODUCT_SLUG,
        "version": version,
        "channel": args.channel,
        "min_manager_version": args.min_manager_version,
        "published_at": git_commit_time(repo),
        "source": {"tag": f"v{version}", "commit": descriptor["source_commit"]},
        "artifact": {"name": package.name, "sha256": sha256_file(package), "size": package.stat().st_size, "platforms": ["windows-amd64"]},
        "signature": {"algorithm": "ed25519", "key_id": key_id(signing_key), "file": signature.name},
        "release_notes": f"{PRODUCT_NAME} {version} - Forgejo/Manager distribution candidate",
        "rollback_supported": True,
        "restart_required": True,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    sums_path.write_text("\n".join(f"{sha256_file(item)}  {item.name}" for item in (package, signature, manifest_path)) + "\n", encoding="utf-8")
    print(json.dumps({"status":"ready","product_slug":PRODUCT_SLUG,"version":version,"channel":args.channel,"source_commit":descriptor["source_commit"],"artifact":package.name,"artifact_sha256":manifest["artifact"]["sha256"],"artifact_size":manifest["artifact"]["size"],"key_id":manifest["signature"]["key_id"],"files":[package.name,signature.name,manifest_path.name,sums_path.name]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
