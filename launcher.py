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
    try:
        close_app_windows()
        stop_tray()
        time.sleep(0.3)
        subprocess.Popen([installer_path, "/SILENT", "/NORESTART", "/SP-"], close_fds=True)
    except Exception:
        log("启动更新程序失败：" + traceback.format_exc())
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
    """让已运行实例打开或置前主窗口，避免本次启动再起一个后台服务。"""
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:%d/show-window" % port, data=b"", method="POST",
            headers={TOKEN_HEADER: token},
        )
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status == 200
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
        if not request_show_window(port, token):
            # 兼容未提供 /show-window 的旧版本实例：直接打开它的界面
            show_or_open_app_window("http://127.0.0.1:%d/" % port)
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
        # 第二个启动的进程会请求该接口，由本进程负责打开或置前主窗口
        server.SHOW_WINDOW_HOOK = lambda: show_or_open_app_window(APP_URL)
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

        def serve_worker():
            try:
                server.serve(8900, on_ready)
                log("服务已停止")
            except OSError as e:
                errors["error"] = e
            except BaseException:
                errors["trace"] = traceback.format_exc()
            finally:
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
        close_app_windows()
        stop_tray()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _tb = traceback.format_exc()
        show_error("程序启动失败：\n\n" + _tb)
        hold()
