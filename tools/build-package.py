"""打一个可直接上传到 Edge 应用商店 / Chrome 应用商店的 zip。

只收运行时需要的文件：manifest、背景脚本、内容脚本与库、弹窗、设置页、图标。
不含 test/ demo/ tools/ docs/，避免把测试页面和截图传上去。

用法：python tools/build-package.py
产物：dist/<name>-<version>.zip
"""
import json
import pathlib
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist"

INCLUDE_DIRS = ["assets", "content", "lib", "options", "popup"]
INCLUDE_FILES = ["manifest.json", "background.js", "LICENSE"]


def collect():
    files = []
    for d in INCLUDE_DIRS:
        base = ROOT / d
        if not base.is_dir():
            raise SystemExit("缺少目录: " + d)
        for p in sorted(base.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(ROOT)
            if any(part.startswith(".") for part in rel.parts):
                continue
            files.append(p)
    for f in INCLUDE_FILES:
        p = ROOT / f
        if not p.exists():
            raise SystemExit("缺少文件: " + f)
        files.append(p)
    return files


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    name, version = manifest["name"], manifest["version"]

    # 上架前的基本自检
    problems = []
    if manifest.get("manifest_version") != 3:
        problems.append("manifest_version 不是 3")
    if not manifest.get("description"):
        problems.append("缺少 description")
    for key in ("16", "32", "48", "128"):
        icon = (manifest.get("icons") or {}).get(key)
        if not icon or not (ROOT / icon).exists():
            problems.append("缺少图标 %s: %s" % (key, icon))
    if problems:
        print("自检未通过：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        return 1

    files = collect()
    OUT.mkdir(exist_ok=True)
    target = OUT / ("%s-%s.zip" % (name, version))
    if target.exists():
        target.unlink()

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            z.write(p, p.relative_to(ROOT).as_posix())

    size = target.stat().st_size
    print("打包完成: %s" % target)
    print("  条目数: %d   压缩包: %.1f KB" % (len(files), size / 1024))
    print("  内容:")
    for p in files:
        print("    " + p.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    sys.exit(main())