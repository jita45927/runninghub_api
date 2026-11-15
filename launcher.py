# 打包入口：初始化数据目录 → 启动本地服务 → 用应用窗口打开界面
# 源码直接运行：python launcher.py（等价于 python server.py）
import json
import os
import sys
import time
import threading
import traceback
import subprocess
import webbrowser
import urllib.request


def app_dir():
    # 打包成 exe 后取 exe 所在目录，源码运行时取本文件所在目录
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


BASE = app_dir()
os.chdir(BASE)
LOG = os.path.join(BASE, "启动日志.log")

# 控制台编码不可用时避免打印中文直接抛异常
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass


def log(msg):
    """启动日志：闪退后可直接查看最后一步，便于定位问题。"""
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg + "\n")
    except Exception:
        pass


def start_log():
    try:
        with open(LOG, "w", encoding="utf-8"):
            pass
    except Exception:
        pass
    log("启动：frozen=%s" % getattr(sys, "frozen", False))
    log("exe=%s" % sys.executable)
    log("Python %s" % sys.version.replace("\n", " "))


def ensure_dirs():
    for name in ("tools", "download"):
        os.makedirs(os.path.join(BASE, name), exist_ok=True)


def write_appinfo():
    """第一行固定为本机 tools 目录；第二行保留用户已选下载目录，失效则回退到程序目录下 download。"""
    tools = os.path.join(BASE, "tools")
    download = ""
    path = os.path.join(BASE, "appinfo.txt")
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                lines = [l.strip() for l in f.read().splitlines() if l.strip()]
            download = lines[1] if len(lines) >= 2 else ""
        except OSError:
            download = ""
    if not download or not os.path.isdir(download):
        download = os.path.join(BASE, "download")
    os.makedirs(download, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(tools + "\n" + download + "\n")
    log("数据目录：tools=%s download=%s" % (tools, download))


def has_console():
    """无窗口打包（--noconsole）时 stdout/stdin 为 None，此时改用弹窗提示。"""
    try:
        return sys.stdin is not None and sys.stdout is not None and sys.stdin.isatty()
    except Exception:
        return False


def hold():
    """保持控制台窗口不立即关闭，避免用户只看到一闪而过。"""
    if not has_console():
        return
    try:
        input("按回车键关闭窗口…")
    except (EOFError, OSError):
        time.sleep(30)


def show_error(msg):
    """出错提示：有控制台就打印，无控制台弹系统对话框（否则用户完全看不到原因）。"""
    log("错误：" + msg)
    if has_console():
        try:
            print(msg, flush=True)
        except Exception:
            pass
        return
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, msg, "RunningHub AI 设计师工具箱", 0x10)
    except Exception:
        pass


def find_browser():
    """找 Edge / Chrome 可执行文件（应用窗口模式需要 Chromium 内核）。"""
    env = os.environ
    dirs = [env.get("ProgramFiles(x86)"), env.get("ProgramFiles"), env.get("LOCALAPPDATA")]
    cands = []
    for d in dirs:
        if d:
            cands.append(os.path.join(d, "Microsoft", "Edge", "Application", "msedge.exe"))
    for d in dirs:
        if d:
            cands.append(os.path.join(d, "Google", "Chrome", "Application", "chrome.exe"))
    for p in cands:
        if os.path.isfile(p):
            return p
    return None


def open_app_window(url):
    """用应用窗口模式打开：没有地址栏、标签页，看起来就是一个桌面程序。"""
    exe = find_browser()
    if not exe:
        log("未找到 Edge/Chrome，退回默认浏览器")
        webbrowser.open(url)
        return
    profile = os.path.join(os.environ.get("LOCALAPPDATA") or BASE, "RunningHubToolbox", "browser")
    try:
        os.makedirs(profile, exist_ok=True)
    except OSError:
        profile = os.path.join(BASE, "浏览器配置")
        os.makedirs(profile, exist_ok=True)
    args = [
        "--app=" + url,
        "--user-data-dir=" + profile,
        "--window-size=1400,900",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    try:
        subprocess.Popen([exe] + args)
        log("应用窗口已启动：" + exe)
    except Exception:
        log("应用窗口启动失败：" + traceback.format_exc())
        webbrowser.open(url)


def already_running(port=8900):
    """已有实例在跑：只打开窗口，避免重复启动第二个服务。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/appinfo" % port, timeout=1.5) as r:
            return r.status == 200 and "tools" in json.loads(r.read().decode("utf-8"))
    except Exception:
        return False


def main():
    start_log()
    ensure_dirs()
    write_appinfo()

    if already_running():
        log("检测到已有实例在运行，直接打开窗口")
        open_app_window("http://127.0.0.1:8900/")
        return

    import server  # 延迟导入：导入时会把工作目录切到程序根目录
    log("server 模块已加载")

    def on_ready(port):
        url = "http://127.0.0.1:%d/" % port
        log("服务已监听 " + url)
        if has_console():
            print("=" * 50)
            print("  RunningHub AI 设计师工具箱")
            print("  " + url)
            print("=" * 50, flush=True)

        def open_window():
            time.sleep(0.5)  # 等服务可以接受请求再开窗口，避免白屏
            open_app_window(url)

        threading.Thread(target=open_window, daemon=True).start()

    try:
        server.serve(8900, on_ready)
        log("服务已停止")
    except OSError as e:
        show_error("本地服务启动失败：" + str(e) + "\n\n可能原因：端口 8900-8909 被其它程序占用。\n详见安装目录下的 启动日志.log")
        return
    hold()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _tb = traceback.format_exc()
        show_error("程序启动失败：\n\n" + _tb)
        hold()
