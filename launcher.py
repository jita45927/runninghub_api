# 打包入口：初始化数据目录 → 启动本地服务 → 用应用窗口打开界面
# 源码直接运行：python launcher.py（等价于 python server.py）
import json
import os
import re
import sys
import time
import threading
import traceback
import subprocess
import webbrowser
import shutil
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
DATA = (os.path.join(os.environ["LOCALAPPDATA"], "RunningHubToolbox", "data")
        if getattr(sys, "frozen", False) and os.environ.get("LOCALAPPDATA") else BASE)
os.chdir(BASE)
LOG = os.path.join(BASE, "启动日志.log")
APP_TITLE = "RunningHub AI设计师工具箱"
APP_URL = "http://127.0.0.1:8900/"
APP_ID = "runninghub"
PORT_RANGE = range(8900, 8910)
TOKEN_HEADER = "X-RunningHub-Token"
MUTEX_NAME = "Local\\RunningHubToolbox.SingleInstance"
_TRAY = None
_MUTEX = None
_WINDOW_LOCK = threading.Lock()
_EXITING = False
_BROWSER_PID = None          # 本程序拉起的浏览器进程，用于窗口关闭后清理残留
_MONITOR_STOP = threading.Event()
_MONITOR_STARTED = False

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
    # 追加写：第二个实例启动时不能覆盖第一个实例的关键日志；仅在过大时清空
    try:
        if os.path.getsize(LOG) > 1024 * 1024:
            with open(LOG, "w", encoding="utf-8"):
                pass
    except OSError:
        pass
    log("启动：pid=%s frozen=%s" % (os.getpid(), getattr(sys, "frozen", False)))
    log("exe=%s" % sys.executable)
    log("Python %s" % sys.version.replace("\n", " "))


def read_app_version():
    """欢迎画面版本号：优先读打包时生成的 version.txt，源码运行回退解析 server.py。"""
    try:
        with open(os.path.join(BASE, "version.txt"), encoding="utf-8") as f:
            version = f.read().strip()
        if version:
            return version
    except OSError:
        pass
    try:
        with open(os.path.join(BASE, "server.py"), encoding="utf-8") as f:
            m = re.search(r'APP_VERSION\s*=\s*"([0-9.]+)"', f.read())
        return m.group(1) if m else ""
    except OSError:
        return ""


def create_splash():
    """创建启动欢迎画面；任何异常都退回无欢迎画面启动，绝不影响主流程。"""
    try:
        import splash
        image = os.path.join(BASE, "ICO", "welcome.png")
        return splash.Splash(read_app_version(), image if os.path.isfile(image) else None)
    except Exception:
        log("欢迎画面创建失败：" + traceback.format_exc())
        return None


def splash_call(ui, name, *args):
    """调用欢迎画面方法；画面不存在或异常时静默跳过。"""
    if ui is None:
        return
    try:
        getattr(ui, name)(*args)
    except Exception:
        log("欢迎画面调用失败 %s：%s" % (name, traceback.format_exc()))


def _same_path(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _read_download(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            lines = [l.strip() for l in f.read().splitlines() if l.strip()]
        return lines[1] if len(lines) >= 2 else ""
    except OSError:
        return ""


def ensure_dirs():
    """用户数据目录只放用户自己的工具，系统工具直接读安装目录 sys_tools。"""
    for name in ("user_tools", "download"):
        os.makedirs(os.path.join(DATA, name), exist_ok=True)


def write_appinfo():
    """记录用户工具/下载路径；系统工具路径不再写入 appinfo。"""
    tools = os.path.join(DATA, "user_tools")
    path = os.path.join(DATA, "appinfo.txt")
    source_path = path
    if not _same_path(DATA, BASE) and not os.path.isfile(path):
        source_path = os.path.join(BASE, "appinfo.txt")
    download = _read_download(source_path)
    if (not download or not os.path.isdir(download)
            or _same_path(download, os.path.join(BASE, "download"))):
        download = os.path.join(DATA, "download")
    os.makedirs(download, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(tools + "\n" + download + "\n")
    log("数据目录：tools=%s download=%s" % (tools, download))


def _read_tool_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else None
    except (OSError, ValueError):
        return None


def migrate_legacy_tools():
    """1.0.1 → 1.0.2：把 data/tools 整体备份，系统工具副本丢弃，其余迁入 user_tools。
    只处理安装版；任何异常都写日志，绝不阻塞启动。"""
    if not getattr(sys, "frozen", False):
        return
    legacy = os.path.join(DATA, "tools")
    status = os.path.join(DATA, ".migrated_sys_tools")
    if os.path.isfile(status):
        return
    try:
        if not os.path.isdir(legacy) or not os.listdir(legacy):
            with open(status, "w", encoding="utf-8") as f:
                f.write("nothing to migrate\n")
            return

        backup = os.path.join(DATA, "backup", "tools-" + time.strftime("%Y%m%d_%H%M%S"))
        os.makedirs(os.path.dirname(backup), exist_ok=True)
        try:
            os.replace(legacy, backup)
        except OSError:
            shutil.copytree(legacy, backup)

        sys_ids = set()
        sys_dir = os.path.join(BASE, "sys_tools")
        if os.path.isdir(sys_dir):
            for fn in os.listdir(sys_dir):
                if fn.lower().endswith(".rhtool.json"):
                    cfg = _read_tool_json(os.path.join(sys_dir, fn)) or {}
                    wid = str(cfg.get("webappId") or "").strip()
                    if wid:
                        sys_ids.add(wid)

        user_dir = os.path.join(DATA, "user_tools")
        os.makedirs(user_dir, exist_ok=True)
        tombstone_file = os.path.join(user_dir, ".deleted.json")
        tombstones = set()
        try:
            with open(tombstone_file, "r", encoding="utf-8") as f:
                tombstones = {str(x).strip() for x in (json.load(f).get("webappIds") or [])}
        except (OSError, ValueError, AttributeError):
            pass

        migrated = 0
        for fn in os.listdir(backup):
            path = os.path.join(backup, fn)
            if not os.path.isfile(path) or not fn.lower().endswith(".rhtool.json"):
                continue
            cfg = _read_tool_json(path) or {}
            wid = str(cfg.get("webappId") or "").strip()
            if wid and wid in sys_ids:
                if cfg.get("deleted"):
                    tombstones.add(wid)  # 旧版删掉的系统工具继续保持删除
                continue
            shutil.copy2(path, os.path.join(user_dir, fn))
            base = fn[:-len(".rhtool.json")] if fn.lower().endswith(".rhtool.json") else fn
            for ext in (".png", ".jpg", ".jpeg", ".webp"):
                cover = os.path.join(backup, base + ext)
                if os.path.isfile(cover):
                    shutil.copy2(cover, os.path.join(user_dir, base + ext))
                    break
            migrated += 1

        if tombstones:
            with open(tombstone_file, "w", encoding="utf-8") as f:
                json.dump({"webappIds": sorted(tombstones)}, f, ensure_ascii=False, indent=2)
        with open(status, "w", encoding="utf-8") as f:
            f.write("backup=%s migrated=%d\n" % (backup, migrated))
        log("旧工具配置已迁移：备份=%s 用户工具=%d" % (backup, migrated))
    except Exception:
        log("旧工具配置迁移失败：" + traceback.format_exc())


def perform_update(installer_path):
    """自动更新：关闭界面和托盘，静默安装新版本后退出，由安装器重新拉起程序。"""
    log("开始自动更新：" + installer_path)
    _MONITOR_STOP.set()  # 更新时关闭窗口属正常流程，不再做残留清理判断
    try:
        close_app_windows()
        stop_tray()
        time.sleep(0.3)
        subprocess.Popen([installer_path, "/SILENT", "/NORESTART", "/SP-"], close_fds=True)
    except Exception:
        log("启动更新程序失败：" + traceback.format_exc())
        _MONITOR_STOP.clear()  # 更新未发生，恢复窗口监视
        return
    os._exit(0)


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
    """按页面标题查找本程序可见的 Chromium 应用窗口。"""
    if os.name != "nt":
        return []
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        # 关闭动画/后台残留的隐藏窗口不能算作可用窗口，否则会误判为“窗口还在”
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        title = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, title, n + 1)
        if APP_TITLE in title.value:
            found.append(hwnd)
        return True

    user32.EnumWindows(callback, 0)
    return found


def _activate_window(hwnd):
    """还原并置前窗口：已在前台就不再动它，避免重复激活造成闪屏。"""
    user32 = ctypes.windll.user32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    if user32.GetForegroundWindow() == hwnd:
        return
    # SwitchToThisWindow 由系统任务栏使用，比 Alt 键模拟更平滑，不会触发菜单栏重绘
    user32.SwitchToThisWindow(hwnd, True)
    if user32.GetForegroundWindow() != hwnd:
        user32.SetForegroundWindow(hwnd)


def _wait_for_app_window(timeout):
    """等待应用窗口出现并置前；返回是否成功，避免“已拉起但没出现”被当成成功。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        windows = _app_windows()
        if windows:
            _activate_window(windows[0])
            log("应用窗口已就绪：hwnd=%s" % windows[0])
            return True
        time.sleep(0.2)
    log("等待应用窗口超时（%.0f 秒）" % timeout)
    return False


def open_app_window(url, wait=8.0):
    """用应用窗口模式打开：没有地址栏、标签页，看起来就是一个桌面程序。返回是否真正出现窗口。"""
    global _BROWSER_PID
    exe = find_browser()
    if not exe:
        log("未找到 Edge/Chrome，退回默认浏览器")
        webbrowser.open(url)
        return _wait_for_app_window(wait)
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
        _BROWSER_PID = subprocess.Popen([exe] + args).pid
        log("应用窗口已启动：%s（pid=%s）" % (exe, _BROWSER_PID))
    except Exception:
        log("应用窗口启动失败：" + traceback.format_exc())
        webbrowser.open(url)
    return _wait_for_app_window(wait)


def _kill_stale_browser():
    """清理本程序拉起的残留浏览器进程，避免同一配置目录被后台进程占用导致新窗口打不开。"""
    global _BROWSER_PID
    pid = _BROWSER_PID
    _BROWSER_PID = None
    if not pid:
        return
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return
        kernel32.CloseHandle(handle)
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            creationflags=0x08000000,  # CREATE_NO_WINDOW
            capture_output=True, timeout=10,
        )
        log("已清理残留浏览器进程 pid=%s" % pid)
    except Exception:
        log("清理残留浏览器进程失败：" + traceback.format_exc())


def show_or_open_app_window(url=None):
    """已有可见窗口则唤回；窗口已通过 X 关闭时，清理残留后重新打开。返回是否成功。"""
    url = url or APP_URL
    with _WINDOW_LOCK:
        windows = _app_windows()
        if windows:
            log("唤回已有窗口：hwnd=%s" % windows[0])
            _activate_window(windows[0])
            return True
        log("未找到主窗口，准备重新打开：" + url)
        _kill_stale_browser()
        if open_app_window(url):
            return True
        log("首次打开未出现窗口，清理残留后重试")
        _kill_stale_browser()
        if open_app_window(url):
            return True
        log("重新打开主窗口失败")
        return False


def _window_monitor():
    """监视主窗口：用户点 X 关闭后清理残留浏览器进程，保证再次单击托盘/启动 exe 能重新打开。"""
    appeared = False
    while not _MONITOR_STOP.is_set():
        try:
            windows = _app_windows()
            if windows:
                appeared = True
            elif appeared:
                appeared = False
                log("主窗口已关闭，程序继续驻留托盘")
                # 加锁复查：避免把“刚被重新打开”的新窗口进程误清理
                with _WINDOW_LOCK:
                    if not _app_windows():
                        _kill_stale_browser()
        except Exception:
            log("窗口监视异常：" + traceback.format_exc())
            return
        _MONITOR_STOP.wait(0.6)


def start_window_monitor():
    global _MONITOR_STARTED
    if _MONITOR_STARTED:
        return
    _MONITOR_STARTED = True
    threading.Thread(target=_window_monitor, daemon=True, name="window-monitor").start()


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
        import server
        req = urllib.request.Request(
            APP_URL + "shutdown", data=b"", method="POST",
            headers={server.LOCAL_TOKEN_HEADER: server.ACCESS_TOKEN},
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception as e:
        _EXITING = False
        log("托盘退出失败：" + str(e))
        show_error("退出失败，请稍后重试。\n\n" + str(e))


def _tray_restore(*_):
    """托盘恢复窗口：放到后台线程执行，避免等待窗口时卡住托盘消息循环。"""
    def worker():
        try:
            if not show_or_open_app_window():
                log("托盘恢复窗口失败")
        except Exception:
            log("托盘恢复窗口异常：" + traceback.format_exc())

    threading.Thread(target=worker, daemon=True).start()


def start_tray():
    """启动即显示托盘；单击图标恢复窗口，右键提供恢复/退出。"""
    global _TRAY
    icon_path = os.path.join(BASE, "RAPI.ico")
    if not os.path.isfile(icon_path):
        icon_path = os.path.join(BASE, "ICO", "RAPI.ico")
    with Image.open(icon_path) as source:
        image = source.copy()
    menu = pystray.Menu(
        pystray.MenuItem("恢复窗口", _tray_restore, default=True),
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


def acquire_instance_lock():
    """创建命名互斥体做单实例锁；返回 True 表示本进程是唯一运行实例。"""
    global _MUTEX
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        _MUTEX = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if not _MUTEX:
            log("单实例锁创建失败，继续启动")
            return True
        # 句柄需在进程生命周期内保持打开，进程退出时系统会自动释放互斥体
        return ctypes.get_last_error() != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        log("单实例锁异常：" + traceback.format_exc())
        return True


def _is_self(info):
    """识别本程序的实例；端口段与另一程序重叠，必须靠 app 标识区分。"""
    if not isinstance(info, dict) or "tools" not in info:
        return False
    app = info.get("app")
    if app:
        return app == APP_ID
    # 兼容无 app 字段的旧版本：仅本程序带 token
    return "token" in info


def find_running():
    """扫描本程序的端口，返回已在运行实例的 (端口, 令牌)。"""
    for port in PORT_RANGE:
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/appinfo" % port, timeout=0.8) as r:
                info = json.loads(r.read().decode("utf-8"))
            if _is_self(info):
                return port, str(info.get("token") or "")
        except Exception:
            continue
    return None, ""


def request_show_window(port, token):
    """让已运行实例打开或置前主窗口，返回它是否确认窗口已出现。"""
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:%d/show-window" % port, data=b"", method="POST",
            headers={TOKEN_HEADER: token},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode("utf-8", "replace")
        try:
            data = json.loads(body) if body else {}
        except ValueError:
            data = {}
        if "ok" not in data:
            return None  # 旧版本实例：无同步结果，由调用方等待窗口出现再判断
        if not data.get("ok"):
            log("已有实例唤回窗口失败：%s" % (data.get("error") or "未知原因"))
        return bool(data.get("ok"))
    except Exception:
        log("唤回已有窗口失败：" + traceback.format_exc())
        return False


def main():
    start_log()
    ui = create_splash()  # 最先弹出欢迎画面，后面每一步推进进度

    sole = acquire_instance_lock()
    port, token = find_running()
    if not sole:
        # 另一实例正在启动：等它的服务就绪后唤回窗口，绝不启动第二个后台服务
        for _ in range(60):
            if port:
                break
            time.sleep(0.25)
            port, token = find_running()
        log("检测到已有实例（端口 %s），本次启动不创建新服务" % (port or "未就绪"))
        splash_call(ui, "close_now")
        if not port:
            show_error("程序已在后台运行，但本地服务尚未就绪。\n请稍候通过系统托盘图标打开主界面。")
            return
    if port:
        log("已有实例在运行（端口 %d），唤回窗口中" % port)
        splash_call(ui, "close_now")
        url = "http://127.0.0.1:%d/" % port
        ok = request_show_window(port, token)
        log("唤回窗口请求结果：%s" % ok)
        # 无论请求结果如何，都以“屏幕上是否真的出现主窗口”为准做兜底
        if not _wait_for_app_window(5.0):
            log("仍未检测到主窗口，由本次启动直接打开")
            if not show_or_open_app_window(url):
                log("兜底打开主窗口失败")
        return

    ensure_dirs()
    splash_call(ui, "set_progress", 0.25)
    write_appinfo()
    splash_call(ui, "set_progress", 0.34)
    migrate_legacy_tools()
    splash_call(ui, "set_progress", 0.46)

    errors = {}

    try:
        start_tray()
        splash_call(ui, "set_progress", 0.58)
        import server  # 延迟导入：导入时会把工作目录切到程序根目录

        def show_window_hook():
            """第二个启动的进程请求唤回界面，返回窗口是否真的出现。"""
            try:
                return bool(show_or_open_app_window(APP_URL))
            except Exception:
                log("唤回窗口钩子异常：" + traceback.format_exc())
                return False

        # 第二个启动的进程会请求该接口，由本进程负责打开或置前主窗口
        server.SHOW_WINDOW_HOOK = show_window_hook
        server.UPDATE_INSTALL_HOOK = perform_update
        log("server 模块已加载")
        splash_call(ui, "set_progress", 0.72)

        def on_ready(port):
            global APP_URL
            APP_URL = "http://127.0.0.1:%d/" % port
            log("服务已监听 " + APP_URL)
            splash_call(ui, "set_progress", 0.92)
            splash_call(ui, "finish")  # 进度走到 100% 后停留 3 秒再消失
            if has_console():
                print("=" * 50)
                print("  RunningHub AI 设计师工具箱")
                print("  " + APP_URL)
                print("=" * 50, flush=True)

            def open_window():
                time.sleep(0.5)  # 等服务可以接受请求再开窗口，避免白屏
                show_or_open_app_window(APP_URL)

            threading.Thread(target=open_window, daemon=True).start()
            start_window_monitor()

        def serve_worker():
            try:
                server.serve(8900, on_ready)
                log("服务已停止")
            except OSError as e:
                errors["error"] = e
            except BaseException:
                errors["trace"] = traceback.format_exc()
            finally:
                _MONITOR_STOP.set()  # 服务停止后不再监视窗口
                splash_call(ui, "abort")  # 服务结束时欢迎画面必须消失

        if ui is None:
            serve_worker()  # 欢迎画面不可用时退回原来的阻塞启动方式
        else:
            worker = threading.Thread(target=serve_worker, daemon=True, name="http-server")
            worker.start()
            ui.run()  # 主线程只负责欢迎画面，关闭后返回
            if "error" not in errors and "trace" not in errors:
                while worker.is_alive():
                    time.sleep(0.5)

        if "error" in errors:
            show_error("本地服务启动失败：" + str(errors["error"])
                       + "\n\n可能原因：端口 8900-8909 被其它程序占用。\n详见安装目录下的 启动日志.log")
            return
        if "trace" in errors:
            show_error("程序启动失败：\n\n" + errors["trace"])
            return
    finally:
        _MONITOR_STOP.set()
        close_app_windows()
        stop_tray()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _tb = traceback.format_exc()
        show_error("程序启动失败：\n\n" + _tb)
        hold()
