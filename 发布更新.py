"""生成自动更新清单，并可发布到独立 release 分支、创建 GitHub Release。

用法：
  python 发布更新.py --generate-only   只生成 build/latest.json（打包脚本会调用）
  python 发布更新.py                    生成清单并打印发版步骤
  python 发布更新.py --publish          把清单提交到 release 分支并推送到 GitHub/Gitee
  python 发布更新.py --publish --github 同时用 gh 创建 GitHub Release、上传安装包
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
GITEE_OWNER_REPO = "matt8469/runninghub_api"
SETUP_NAME = "RunningHub-AI-Toolbox-Setup-{version}.exe"
RELEASE_BRANCH = "release"  # 只存放 update/latest.json 的独立分支
REMOTES = ("origin", "gitee")


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
    manifest = os.path.join(ROOT, "build", "latest.json")
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
                "https://gitee.com/%s/releases/download/%s/%s" % (GITEE_OWNER_REPO, tag, name),
                "https://github.com/%s/releases/download/%s/%s" % (OWNER_REPO, tag, name),
            ],
        },
    }


def write_manifest(manifest):
    d = os.path.join(ROOT, "build")
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


def _run_git(*args, input_text=None):
    return subprocess.run(
        ["git"] + list(args), cwd=ROOT, check=True, capture_output=True,
        text=True, input=input_text,
    ).stdout.strip()


def publish_release(manifest_path):
    """把清单写入独立 release 分支并推送：分支里只保留 update/latest.json。"""
    rel = os.path.relpath(manifest_path, ROOT).replace(os.sep, "/")
    blob = _run_git("hash-object", "-w", rel)
    # 用 -z（NUL 分隔）避免 Windows 换行符被写进文件名
    inner = _run_git("mktree", "-z",
                     input_text="100644 blob %s\tlatest.json\0" % blob).split("\0")[0]
    tree = _run_git("mktree", "-z",
                    input_text="040000 tree %s\tupdate\0" % inner).split("\0")[0]
    args = ["commit-tree", tree, "-m", "发布更新清单 v%s" % read_version()]
    try:
        parent = _run_git("rev-parse", "--verify", "refs/heads/" + RELEASE_BRANCH)
        args[2:2] = ["-p", parent]
    except subprocess.CalledProcessError:
        pass  # 首次创建：孤儿提交
    commit = _run_git(*args)
    _run_git("update-ref", "refs/heads/" + RELEASE_BRANCH, commit)
    print("已生成 release 分支提交：%s" % commit[:8])
    ok = True
    for remote in REMOTES:
        try:
            subprocess.run(
                ["git", "push", remote, "%s:%s" % (RELEASE_BRANCH, RELEASE_BRANCH)],
                cwd=ROOT, check=True, capture_output=True, text=True,
            )
            print("已推送清单到 %s/%s" % (remote, RELEASE_BRANCH))
        except (OSError, subprocess.CalledProcessError) as e:
            ok = False
            print("推送到 %s 失败：%s" % (remote, e))
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate-only", action="store_true", help="只生成 build/latest.json")
    parser.add_argument("--publish", action="store_true", help="把清单发布到 release 分支并推送")
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

    if args.publish:
        publish_release(path)

    if args.github:
        github_release(manifest)

    print("\n发版还需要：")
    print("1) 在 Gitee 创建 tag v%s 的 Release，上传 installer\\%s"
          % (version, manifest["installer"]["name"]))
    print("2) 发布更新清单：python 发布更新.py --publish")
    print("   （清单只进入 release 分支，master 不再存放，日常推送 master 不会触发升级）")
    print("3) 确认以下地址返回本版本清单：")
    for url in ("https://gitee.com/%s/raw/release/update/latest.json" % GITEE_OWNER_REPO,
                "https://raw.githubusercontent.com/%s/release/update/latest.json" % OWNER_REPO):
        print("   " + url)


if __name__ == "__main__":
    main()
