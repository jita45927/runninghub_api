"""生成自动更新清单 update/latest.json，并可选择用 gh 创建 GitHub Release。

用法：
  python 发布更新.py --generate-only   只生成 update/latest.json（打包脚本会调用）
  python 发布更新.py                    生成清单并打印上传步骤
  python 发布更新.py --github           生成清单并用 gh 创建 Release、上传安装包
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OWNER_REPO = "jita45927/runninghub_api"
SETUP_NAME = "RunningHub-AI-Toolbox-Setup-{version}.exe"


def read_version():
    with open(os.path.join(ROOT, "server.py"), encoding="utf-8") as f:
        m = re.search(r'APP_VERSION\s*=\s*"([0-9.]+)"', f.read())
    if not m:
        raise SystemExit("无法从 server.py 读取 APP_VERSION")
    return m.group(1)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_notes(version):
    # 可选：update/notes-<版本>.md 写本次更新说明
    p = os.path.join(ROOT, "update", "notes-%s.md" % version)
    if os.path.isfile(p):
        with open(p, encoding="utf-8") as f:
            return f.read().strip()
    manifest = os.path.join(ROOT, "update", "latest.json")
    try:
        with open(manifest, encoding="utf-8") as f:
            old = json.load(f)
        if str(old.get("version")) == version:
            return old.get("notes") or ""
    except (OSError, ValueError):
        pass
    return "本次更新包含工具配置与功能优化，建议升级到最新版本。"


def build_manifest(version):
    exe = os.path.join(ROOT, "installer", SETUP_NAME.format(version=version))
    if not os.path.isfile(exe):
        raise SystemExit("未找到安装包：" + exe + "\n请先运行 打包安装包.bat")
    name = os.path.basename(exe)
    tag = "v" + version
    return {
        "app": "runninghub",
        "version": version,
        "date": __import__("datetime").date.today().isoformat(),
        "notes": load_notes(version),
        "page": "https://github.com/%s/releases/tag/%s" % (OWNER_REPO, tag),
        "installer": {
            "name": name,
            "size": os.path.getsize(exe),
            "sha256": sha256_of(exe),
            "urls": [
                "https://gitee.com/%s/releases/download/%s/%s" % (OWNER_REPO, tag, name),
                "https://github.com/%s/releases/download/%s/%s" % (OWNER_REPO, tag, name),
            ],
        },
    }


def write_manifest(manifest):
    d = os.path.join(ROOT, "update")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return path


def github_release(manifest):
    exe = os.path.join(ROOT, "installer", manifest["installer"]["name"])
    tag = "v" + manifest["version"]
    try:
        subprocess.run(["gh", "--version"], check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError):
        print("未检测到 gh CLI，跳过自动发布。请手动创建 GitHub Release：")
        print("  tag: %s  文件: %s" % (tag, exe))
        return False
    notes = manifest.get("notes") or ("RunningHub AI 设计师工具箱 " + tag)
    cmd = ["gh", "release", "create", tag, exe,
           "--repo", OWNER_REPO, "--title", "RunningHub AI 设计师工具箱 " + tag, "--notes", notes]
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print("GitHub Release 创建失败，请检查 gh 登录状态（gh auth login）")
        return False
    print("已创建 GitHub Release：" + manifest["page"])
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate-only", action="store_true", help="只生成 update/latest.json")
    parser.add_argument("--github", action="store_true", help="用 gh 创建 GitHub Release 并上传安装包")
    args = parser.parse_args()

    version = read_version()
    manifest = build_manifest(version)
    path = write_manifest(manifest)
    print("已生成更新清单：" + path)
    print("版本 %s  大小 %d  SHA256 %s" % (version, manifest["installer"]["size"],
                                        manifest["installer"]["sha256"]))
    if args.generate_only:
        return

    if args.github:
        github_release(manifest)

    print("\n还需要手动完成：")
    print("1) 在 Gitee 创建 tag v%s 的 Release，上传 installer\\%s" % (version, manifest["installer"]["name"]))
    print("2) 把 update/latest.json 提交到仓库 master 分支（Gitee 与 GitHub 都要推送）")
    print("3) 确认以下地址可匿名访问：")
    for url in ("https://gitee.com/%s/raw/master/update/latest.json" % OWNER_REPO,
                "https://raw.githubusercontent.com/%s/master/update/latest.json" % OWNER_REPO):
        print("   " + url)


if __name__ == "__main__":
    main()
