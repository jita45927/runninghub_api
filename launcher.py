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
import ctypes
from ctypes import wintypes

import pystray
from PIL import Image


def app_dir():
    # 打包成 exe 后取 exe 所在目录，源码运行时取本文件所在目录
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


BASE = app_dir()
os.chdir(BASE)
LOG = os.path.join(BASE, "启动日志.log")
APP_TITLE = "RunningHub AI设计师工具箱"
APP_URL = "http://127.0.0.1:8900/"
_TRAY = None
_WINDOW_LOCK = threading.Lock()
_EXITING = False

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


def _app_windows():
    """按页面标题查找本程序的 Chromium 应用窗口。"""
    if os.name != "nt":
        return []
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        n = user32.GetWindowTextLengthW(hwnd)
        if n > 0:
            title = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, title, n + 1)
            if APP_TITLE in title.value:
                found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    return found


def _activate_window(hwnd):
    """还原并置前窗口；后台进程直接 SetForegroundWindow 可能只会闪任务栏。"""
    user32 = ctypes.windll.user32
    user32.ShowWindow(hwnd, 9 if user32.IsIconic(hwnd) else 5)  # SW_RESTORE / SW_SHOW
    fg = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    attached = bool(fg_thread and target_thread and fg_thread != target_thread)
    if attached:
        user32.AttachThreadInput(fg_thread, target_thread, True)
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    if attached:
        user32.AttachThreadInput(fg_thread, target_thread, False)


def _activate_app_window_later():
    def worker():
        for _ in range(30):
            windows = _app_windows()
            if windows:
                _activate_window(windows[0])
                return
            time.sleep(0.2)
    threading.Thread(target=worker, daemon=True).start()


def open_app_window(url):
    """用应用窗口模式打开：没有地址栏、标签页，看起来就是一个桌面程序。"""
    exe = find_browser()
    if not exe:
        log("未找到 Edge/Chrome，退回默认浏览器")
        webbrowser.open(url)
        _activate_app_window_later()
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
        "--disable-background-mode",
    ]
    try:
        subprocess.Popen([exe] + args)
        log("应用窗口已启动：" + exe)
    except Exception:
        log("应用窗口启动失败：" + traceback.format_exc())
        webbrowser.open(url)
    _activate_app_window_later()


def show_or_open_app_window(url=None):
    """已有窗口则唤回；窗口已通过 X 关闭时，重新打开应用窗口。"""
    with _WINDOW_LOCK:
        windows = _app_windows()
        if windows:
            _activate_window(windows[0])
        else:
            open_app_window(url or APP_URL)


def close_app_windows():
    """彻底退出时主动关闭应用窗口，不再要求用户额外点一次 X。"""
    windows = _app_windows()
    for hwnd in windows:
        ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    if not windows:
        return
    for _ in range(20):
        if not _app_windows():
            break
        time.sleep(0.1)


def request_exit(*_):
    """托盘退出：与页面按钮一样，每次都需要确认。"""
    global _EXITING
    if _EXITING:
        return
    flags = 0x04 | 0x20 | 0x40000 | 0x10000  # Yes/No、问号、置顶、置前
    msg = "确定彻底退出程序吗？\n\n主窗口、后台服务和系统托盘都会关闭；正在运行的任务可能被中断。"
    if ctypes.windll.user32.MessageBoxW(0, msg, APP_TITLE, flags) != 6:  # IDYES
        return
    _EXITING = True
    threading.Thread(target=_request_shutdown, daemon=True).start()


def _request_shutdown():
    global _EXITING
    try:
        req = urllib.request.Request(APP_URL + "shutdown", data=b"", method="POST")
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception as e:
        _EXITING = False
        log("托盘退出失败：" + str(e))
        show_error("退出失败，请稍后重试。\n\n" + str(e))


def start_tray():
    """启动即显示托盘；左键打开主界面，右键提供打开和彻底退出。"""
    global _TRAY
    icon_path = os.path.join(BASE, "RAPI.ico")
    if not os.path.isfile(icon_path):
        icon_path = os.path.join(BASE, "ICO", "RAPI.ico")
    with Image.open(icon_path) as source:
        image = source.copy()
    menu = pystray.Menu(
        pystray.MenuItem("打开主界面", lambda *_: show_or_open_app_window(), default=True),
        pystray.MenuItem("退出程序", request_exit),
    )
    _TRAY = pystray.Icon("RunningHubToolbox", image, APP_TITLE, menu)
    _TRAY.run_detached()
    log("系统托盘已启动")


def stop_tray():
    global _TRAY
    if _TRAY is not None:
        try:
            _TRAY.stop()
        except Exception:
            pass
        _TRAY = None


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
        log("检测到已有实例在运行，唤回或重新打开窗口")
        show_or_open_app_window("http://127.0.0.1:8900/")
        return

    try:
        start_tray()
        import server  # 延迟导入：导入时会把工作目录切到程序根目录
        log("server 模块已加载")

        def on_ready(port):
            global APP_URL
            APP_URL = "http://127.0.0.1:%d/" % port
            log("服务已监听 " + APP_URL)
            if has_console():
                print("=" * 50)
                print("  RunningHub AI 设计师工具箱")
                print("  " + APP_URL)
                print("=" * 50, flush=True)

            def open_window():
                time.sleep(0.5)  # 等服务可以接受请求再开窗口，避免白屏
                show_or_open_app_window(APP_URL)

            threading.Thread(target=open_window, daemon=True).start()

        try:
            server.serve(8900, on_ready)
            log("服务已停止")
        except OSError as e:
            show_error("本地服务启动失败：" + str(e) + "\n\n可能原因：端口 8900-8909 被其它程序占用。\n详见安装目录下的 启动日志.log")
            return
    finally:
        close_app_windows()
        stop_tray()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _tb = traceback.format_exc()
        show_error("程序启动失败：\n\n" + _tb)
        hold()
