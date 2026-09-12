#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_ACTIVATION_CONTRACT = json.loads(
    (ROOT / "packaging/distribution/activation-contract.json").read_text(encoding="utf-8-sig")
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()



def parse_checksums(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        if not raw.strip():
            continue
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", raw)
        if not match:
            raise SystemExit(f"invalid checksum line: {raw!r}")
        if match.group(2) in result:
            raise SystemExit(f"duplicate checksum entry: {match.group(2)}")
        result[match.group(2)] = match.group(1)
    return result


def verify_package_members(package: Path, expected_product: str, expected_version: str) -> dict[str, object]:
    with zipfile.ZipFile(package, "r") as archive:
        infos = archive.infolist()
        names = [info.filename.replace("\\", "/") for info in infos]
        if len(names) != len(set(names)):
            raise SystemExit("package contains duplicate members")
        if len(names) > 5000:
            raise SystemExit("package entry count rejected")
        name_set = set(names)
        if "RHEINAGENT_PACKAGE.json" not in name_set:
            raise SystemExit("package descriptor is missing")
        expanded = 0
        for info in infos:
            mode = (info.external_attr >> 16) & 0xFFFF
            if stat.S_IFMT(mode) == stat.S_IFLNK:
                raise SystemExit(f"package contains a symlink: {info.filename}")
            expanded += info.file_size
        if expanded > 256 * 1024 * 1024:
            raise SystemExit("package expanded size rejected")
        try:
            metadata = json.loads(archive.read("RHEINAGENT_PACKAGE.json").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SystemExit("package descriptor is invalid") from exc
        if not isinstance(metadata, dict) or metadata.get("format_version") != 2:
            raise SystemExit("File Upload distribution requires package format v2")
        if metadata.get("product_slug") != expected_product or metadata.get("version") != expected_version:
            raise SystemExit("package identity does not match manifest")
        if metadata.get("activation") != EXPECTED_ACTIVATION_CONTRACT:
            raise SystemExit("Package v2 activation contract does not match the reviewed Manager profile")
        files = metadata.get("files")
        if not isinstance(files, list) or not files:
            raise SystemExit("package file inventory is empty")
        described: dict[str, tuple[str, int]] = {}
        for entry in files:
            if not isinstance(entry, dict):
                raise SystemExit("package file inventory entry is invalid")
            name = entry.get("path")
            digest = entry.get("sha256")
            size = entry.get("size")
            if not isinstance(name, str) or not name.startswith("payload/") or name in described:
                raise SystemExit(f"package member path is invalid or duplicated: {name}")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                raise SystemExit(f"package member hash is invalid: {name}")
            if not isinstance(size, int) or size < 0:
                raise SystemExit(f"package member size is invalid: {name}")
            if name not in name_set:
                raise SystemExit(f"package member missing: {name}")
            data = archive.read(name)
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                raise SystemExit(f"package member verification failed: {name}")
            described[name] = (digest, size)
        if name_set != set(described) | {"RHEINAGENT_PACKAGE.json"}:
            raise SystemExit("package contains members not bound by the signed file inventory")
        required = {
            "payload/.runtime-version",
            "payload/package.json",
            "payload/node.exe",
            "payload/dist/server.js",
            "payload/dist/dataplane.js",
            "payload/audit/rheinagent-file-upload-v1.json",
            "payload/packaging/distribution/activation-contract.json",
            "payload/RHEINAGENT_NODE_RUNTIME.json",
        }
        missing = required - name_set
        if missing:
            raise SystemExit("File Upload Windows runtime is incomplete: " + ", ".join(sorted(missing)))
        if archive.read("payload/.runtime-version").decode("utf-8-sig").strip() != expected_version:
            raise SystemExit("runtime version marker mismatch")
        pkg = json.loads(archive.read("payload/package.json").decode("utf-8-sig"))
        if pkg.get("name") != "rheinagent-file-upload" or pkg.get("version") != expected_version:
            raise SystemExit("runtime package.json identity mismatch")
        runtime = json.loads(archive.read("payload/RHEINAGENT_NODE_RUNTIME.json").decode("utf-8-sig"))
        if runtime.get("product_slug") != "rheinagent-file-upload" or runtime.get("version") != expected_version:
            raise SystemExit("bundled Node runtime identity mismatch")
        if runtime.get("platform") != "windows-amd64":
            raise SystemExit("bundled Node runtime platform mismatch")
        installers = metadata.get("installers")
        if installers != {}:
            raise SystemExit("File Upload Windows installer metadata mismatch")
        return metadata


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", required=True)
    parser.add_argument("--public-key", default=str(ROOT / "packaging/distribution/keys/update-signing-ed25519.pub.pem"))
    args = parser.parse_args()
    release = Path(args.release_dir).resolve()
    public_key = Path(args.public_key).resolve()
    manifest_path = release / "manifest.json"
    sums_path = release / "SHA256SUMS"
    if not manifest_path.is_file() or not sums_path.is_file() or not public_key.is_file():
        raise SystemExit("release inputs are incomplete")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    artifact = manifest.get("artifact") or {}
    signature = manifest.get("signature") or {}
    package = release / str(artifact.get("name") or "")
    sig = release / str(signature.get("file") or "")
    if not package.is_file() or not sig.is_file():
        raise SystemExit("artifact or detached signature is missing")
    checksums = parse_checksums(sums_path)
    for item in (package, sig, manifest_path):
        if checksums.get(item.name) != sha256_file(item):
            raise SystemExit(f"checksum mismatch: {item.name}")
    if artifact.get("sha256") != sha256_file(package) or artifact.get("size") != package.stat().st_size:
        raise SystemExit("manifest artifact digest/size mismatch")
    public_bytes = public_key.read_bytes()
    expected_key_id = "ed25519-sha256:" + hashlib.sha256(public_bytes).hexdigest()
    if signature.get("algorithm") != "ed25519" or signature.get("key_id") != expected_key_id:
        raise SystemExit("manifest signing key identity mismatch")
    key = load_pem_public_key(public_bytes)
    if not isinstance(key, Ed25519PublicKey):
        raise SystemExit("public key must be Ed25519")
    try:
        key.verify(sig.read_bytes(), package.read_bytes())
    except InvalidSignature as exc:
        raise SystemExit("detached Ed25519 signature verification failed") from exc
    metadata = verify_package_members(package, str(manifest["product_slug"]), str(manifest["version"]))
    if metadata.get("channel") != manifest.get("channel") or metadata.get("min_manager_version") != manifest.get("min_manager_version"):
        raise SystemExit("package release metadata does not match manifest")
    print(json.dumps({"status":"verified","product_slug":manifest["product_slug"],"version":manifest["version"],"source_commit":metadata.get("source_commit"),"artifact":package.name,"artifact_sha256":artifact["sha256"],"key_id":expected_key_id}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
