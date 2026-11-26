# 本地开发服务器：禁止一切缓存，保证浏览器永远拿到最新代码
# 扩展路由：
#   /appinfo            → 返回 {tools, download, session, token}，会话与令牌每次启动都不同
#   /open-dir?path=...  → 调起 Windows 资源管理器打开指定目录
#   /pick-download-dir  → 弹系统 FolderBrowserDialog 让用户选下载目录，写回 appinfo.txt 第二行
#   /downloads/<文件名> → 只读提供下载目录中的结果文件（支持 Range，供结果区本地预览）
#   /show-window        → 第二个启动的进程请求打开/置前已有主窗口
import http.server, os, sys, json, locale, subprocess, shlex, uuid, re, urllib.request, threading, webbrowser, time
import hmac, ipaddress, socket, html, hashlib, shutil, zipfile, tempfile, datetime
from urllib.parse import urlparse, parse_qs, unquote, quote
from io import BytesIO
from PIL import Image
import update_sign

# 程序根目录：源码运行时是 server.py 所在目录；打包成 exe 后是 exe 所在目录
def _app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))

def _data_dir():
    """安装版把可变数据放到用户目录；源码运行仍使用项目目录。"""
    local = os.environ.get("LOCALAPPDATA")
    if getattr(sys, "frozen", False) and local:
        return os.path.join(local, "RunningHubToolbox", "data")
    return _app_dir()


os.chdir(_app_dir())
APP_VERSION = "1.0.7"  # 版本号唯一来源：打包脚本、更新清单与界面均读取此处
BASE_DIR = _app_dir()
DATA_DIR = _data_dir()
os.makedirs(DATA_DIR, exist_ok=True)
APPINFO = os.path.join(DATA_DIR, "appinfo.txt")
SESSION_ID = uuid.uuid4().hex  # 每次启动 server 生成新会话号，用于清空上一次的生成结果
ACCESS_TOKEN = uuid.uuid4().hex  # 本地变更接口的每次启动随机凭证，不能依赖 CORS 防护
LOCAL_TOKEN_HEADER = "X-RunningHub-Token"
SHOW_WINDOW_HOOK = None  # 由 launcher 注入：收到第二个实例的请求时打开或置前主窗口

# ===== 工具配置目录：系统工具随安装包覆盖，用户工具永远保留 =====
SYS_TOOLS_DIR = os.path.join(BASE_DIR, "sys_tools")
USER_TOOLS_DIR = os.path.join(DATA_DIR, "user_tools")
TOMBSTONE_FILE = os.path.join(USER_TOOLS_DIR, ".deleted.json")
SYS_ZIP = os.path.join(BASE_DIR, "sys_tools.zip")
TOOL_EXTS = (".rhtool.json",)
COVER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")

# ===== 请求与响应大小上限：避免无界读取耗尽内存 =====
MAX_JSON_BODY = 2 * 1024 * 1024            # JSON 请求体
MAX_COVER_BYTES = 30 * 1024 * 1024         # 封面图片
MAX_MANIFEST_BYTES = 512 * 1024            # 更新/公告清单
MAX_RESULT_BYTES = 512 * 1024 * 1024       # 生成结果文件
MAX_UPDATE_BYTES = 300 * 1024 * 1024       # 更新安装包
MAX_SYS_ZIP_BYTES = 200 * 1024 * 1024      # 重置系统工具：解压后累计大小上限
MAX_SYS_ZIP_ENTRIES = 5000                 # 重置系统工具：压缩包条目数上限

# ===== 自动更新 =====
# 更新清单放在独立的 release 分支：推送 master 不会触发客户端升级提示
UPDATE_MANIFEST_URLS = [
    "https://gitee.com/matt8469/runninghub_api/raw/release/update/latest.json",
    "https://cdn.jsdelivr.net/gh/jita45927/runninghub_api@release/update/latest.json",
    "https://raw.githubusercontent.com/jita45927/runninghub_api/release/update/latest.json",
]
# 清单只允许代码托管源；安装包额外允许 GitHub Release 的 CDN 域名。
# gitee.com 的 raw 文件会 302 到 raw.giteeusercontent.com，清单跟随重定向后仍需通过校验。
UPDATE_MANIFEST_HOSTS = {"gitee.com", "giteeusercontent.com", "cdn.jsdelivr.net",
                         "raw.githubusercontent.com"}
UPDATE_INSTALLER_HOSTS = {"gitee.com", "giteeusercontent.com", "github.com",
                          "objects.githubusercontent.com",
                          "github-releases.githubusercontent.com"}
# ===== 公众号公告 =====
# 与更新清单同源同白名单：公告由本地服务代理拉取，前端只访问本地接口
ANNOUNCEMENT_MANIFEST_URLS = [
    "https://gitee.com/matt8469/runninghub_api/raw/release/update/announcement.json",
    "https://cdn.jsdelivr.net/gh/jita45927/runninghub_api@release/update/announcement.json",
    "https://raw.githubusercontent.com/jita45927/runninghub_api/release/update/announcement.json",
]
ANNOUNCEMENT_ALLOWED_HOST = "mp.weixin.qq.com"
ANNOUNCEMENT_MAX_ITEMS = 20
ANNOUNCEMENT_CACHE_TTL = 300  # 5 分钟内存缓存，避免多个页面重复拉取
_ANN_LOCK = threading.Lock()
_ANN_FETCH_LOCK = threading.Lock()  # 缓存未命中时只允许一个请求外呼，避免并发重复拉取
_ANN_CACHE = {"ts": 0.0, "payload": None}

UPDATE_DIR = os.path.join(DATA_DIR, "update")
UPDATE_FILE_NAME = "RunningHubToolbox-update.exe"
UPDATE_INSTALL_HOOK = None  # 由 launcher 注入：关闭窗口/托盘后静默安装并退出
_UPDATE_LOCK = threading.Lock()
_UPDATE_CHECK_LOCK = threading.Lock()  # 更新检查缓存未命中时只放行一个清单外呼
_UPDATE_CACHE_TTL = 300                # 与公告一致：5 分钟内存缓存
_UPDATE_CACHE = {"ts": 0.0, "payload": None}
_UPDATE_CANCEL = threading.Event()
_UPDATE_STATE = {"state": "idle", "received": 0, "total": 0, "percent": 0,
                 "source": "", "error": "", "version": "", "sha256": "", "size": 0}

def _read_appinfo_lines():
    """读取 appinfo.txt，返回有效行列表。自动检测 UTF-8 / UTF-8-SIG / GBK。"""
    last_err = None
    for enc in ("utf-8-sig", "utf-8", locale.getpreferredencoding(False), "gbk"):
        try:
            with open(APPINFO, "r", encoding=enc) as f:
                text = f.read()
            return [l.strip() for l in text.splitlines() if l.strip()]
        except FileNotFoundError:
            return []
        except (UnicodeDecodeError, LookupError) as e:
            last_err = e
    if last_err:
        print("[server] WARNING: failed to decode appinfo.txt: " + str(last_err), file=sys.stderr)
    return []

def _write_appinfo(tools_path, download_path):
    """写入 appinfo.txt 两行（UTF-8 无 BOM）。"""
    content = (tools_path or "") + "\n" + (download_path or "") + "\n"
    with open(APPINFO, "w", encoding="utf-8") as f:
        f.write(content)

def _load_appinfo():
    """返回 {tools: str, download: str}。兼容单行旧格式和双行新格式。"""
    lines = _read_appinfo_lines()
    return {
        "tools": lines[0] if len(lines) >= 1 else "",
        "download": lines[1] if len(lines) >= 2 else "",
    }

def _safe_filename(name, fallback):
    """只保留文件名部分，去掉路径分隔符和 Windows 非法字符。"""
    name = os.path.basename(str(name or "").replace("\\", "/")).strip()
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    return name or fallback

def _cover_ext_from_bytes(data):
    """用 Pillow 校验图片真实性并返回扩展名；非 PNG/JPEG/WEBP/GIF 返回空串。"""
    try:
        with Image.open(BytesIO(data)) as img:
            img.verify()
            fmt = str(img.format or "").upper()
    except Exception:
        return ""
    return {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "GIF": ".gif"}.get(fmt, "")

def _sys_tools_dir():
    """系统工具目录；不存在时等同于禁用系统工具。"""
    return SYS_TOOLS_DIR if os.path.isdir(SYS_TOOLS_DIR) else None

def _user_tools_dir():
    os.makedirs(USER_TOOLS_DIR, exist_ok=True)
    return USER_TOOLS_DIR

def _tools_dir():
    """兼容旧调用：默认操作对象是用户工具目录。"""
    return _user_tools_dir()

def _source_dir(source):
    """按来源返回可写目录；sys 不可用时返回 (None, True) 由调用方降级。"""
    if str(source or "").strip().lower() == "sys":
        return SYS_TOOLS_DIR if os.path.isdir(SYS_TOOLS_DIR) else None
    return _user_tools_dir()

def _read_tombstones():
    try:
        with open(TOMBSTONE_FILE, "r", encoding="utf-8") as f:
            obj = json.load(f)
        ids = obj.get("webappIds") if isinstance(obj, dict) else None
        return {str(x).strip() for x in (ids or []) if str(x).strip()}
    except (OSError, ValueError):
        return set()

def _write_tombstones(ids):
    _user_tools_dir()
    tmp = TOMBSTONE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"webappIds": sorted(ids)}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, TOMBSTONE_FILE)

def _write_text_atomic(path, text):
    """同目录临时文件写完后 os.replace 原子替换，避免中断时留下半个配置文件。"""
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".write-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try: os.remove(tmp)
        except OSError: pass
        raise

def _read_tool_config(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else None
    except (OSError, ValueError):
        return None

def _cover_file(dir_path, base):
    if not dir_path:
        return ""
    for ext in COVER_EXTS:
        fn = base + ext
        if os.path.isfile(os.path.join(dir_path, fn)):
            return fn
    return ""

def _tools_index():
    """合并 user_tools 与 sys_tools：user 优先，同 webappId 的 sys 原版隐藏；
    sys 工具被墓碑删除时不再出现；user 允许同 ID 多份变体。"""
    tombstones = _read_tombstones()
    files = []
    user_ids = set()

    def scan(d, source):
        if not d or not os.path.isdir(d):
            return
        try:
            names = sorted(n for n in os.listdir(d) if n.lower().endswith(".rhtool.json"))
        except OSError:
            return
        for fn in names:
            path = os.path.join(d, fn)
            if not os.path.isfile(path):
                continue
            base = re.sub(r"\.rhtool\.json$", "", fn, flags=re.I)
            cfg = _read_tool_config(path)
            if cfg is None:
                files.append({"file": fn, "source": source, "webappId": "", "name": base,
                              "broken": True, "cover": _cover_file(d, base)})
                continue
            wid = str(cfg.get("webappId") or "").strip()
            if source == "sys" and wid and wid in tombstones:
                continue
            if source == "sys" and wid and wid in user_ids:
                continue  # 用户已有同 ID 工具，隐藏系统原版
            if source == "user" and wid:
                user_ids.add(wid)
            files.append({
                "file": fn,
                "source": source,
                "webappId": wid,
                "name": str(cfg.get("name") or base),
                "deleted": bool(cfg.get("deleted")),
                "cover": _cover_file(d, base),
            })

    scan(_user_tools_dir(), "user")
    scan(_sys_tools_dir(), "sys")
    return {"ok": True, "files": files, "deleted": sorted(tombstones)}

def _find_tool_file(name):
    """按合并视图查找静态文件：配置只暴露生效版本，封面 user 优先。"""
    if not name:
        return None
    if name.lower().endswith(".rhtool.json"):
        for e in _tools_index()["files"]:
            if e["file"] == name and not e.get("broken"):
                d = _user_tools_dir() if e["source"] == "user" else SYS_TOOLS_DIR
                p = os.path.join(d, name)
                if os.path.isfile(p):
                    return p
        return None
    for d in (_user_tools_dir(), SYS_TOOLS_DIR):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return None

def _download_dir():
    """下载目录；路径不可用时回退到用户数据目录下的 download，避免保存结果直接失败。"""
    d = _load_appinfo().get("download") or ""
    if not d:
        d = os.path.join(DATA_DIR, "download")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.join(DATA_DIR, "download")
        os.makedirs(d, exist_ok=True)
    return d

def _pick_download_dir_on_windows(start_hint):
    """用 PowerShell FolderBrowserDialog 弹框选目录，返回路径字符串（用户取消则返回空串）。
    必须 STA 线程，powershell.exe 默认 MTA，用 -STA 参数。"""
    script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "Add-Type -AssemblyName System.Drawing; "
        # 用一个 TopMost 的隐藏主窗体作为对话框 Owner，否则对话框会落到浏览器后面，用户以为没反应
        "$owner = New-Object System.Windows.Forms.Form; "
        "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; "
        "$owner.StartPosition = 'CenterScreen'; "
        "$owner.Size = New-Object System.Drawing.Size(1,1); "
        "$owner.Show(); $owner.Activate(); "
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
        "$d.Description = 'Select download directory'; "
        "$d.ShowNewFolderButton = $true; "
        "$startHint = [Environment]::GetEnvironmentVariable('RH_DOWNLOAD_START'); "
        "if ($startHint) { $d.SelectedPath = $startHint }; "
        "$r = $d.ShowDialog($owner); "
        "if ($r -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }; "
        "$owner.Close(); $owner.Dispose()"
    )
    try:
        env = os.environ.copy()
        env["RH_DOWNLOAD_START"] = start_hint or ""
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace", env=env,
        )
        path = result.stdout.strip()
        return path
    except subprocess.TimeoutExpired:
        return ""
    except Exception as e:
        print("[server] FolderBrowserDialog error: " + str(e), file=sys.stderr)
        return ""

# ================= 外部链接：默认浏览器打开并切到前台 =================
# server 不是前台进程，直接 ShellExecute 时浏览器窗口只会闪在任务栏，不会跑到前面
_BROWSER_EXES = ("msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe",
                 "vivaldi.exe", "360se.exe", "360chrome.exe", "qqbrowser.exe")
_APP_TITLE = "RunningHub AI设计师工具箱"

def _activate_window(hwnd):
    """把窗口提到前台。server 不是前台进程，用 ALT 键抖动 + AttachThreadInput 绕过前台锁。"""
    import ctypes
    user32 = ctypes.windll.user32
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE：最小化时先还原
    fg = user32.GetForegroundWindow()
    fg_thread = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    attached = False
    if fg_thread and target_thread and fg_thread != target_thread:
        user32.AttachThreadInput(fg_thread, target_thread, True)
        attached = True
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    if attached:
        user32.AttachThreadInput(fg_thread, target_thread, False)


def _open_external_url(url):
    if os.name != "nt":
        webbrowser.open(url)
        return
    import ctypes
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    def exe_name(pid):
        """取进程可执行文件名（小写），用于识别浏览器窗口。"""
        h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = ctypes.c_ulong(1024)
            if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return os.path.basename(buf.value).lower()
        finally:
            kernel32.CloseHandle(h)
        return ""

    def top_browser_window():
        found = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def callback(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            title = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, title, n + 1)
            if _APP_TITLE in title.value:
                return True  # 跳过本程序自己的应用窗口
            pid = ctypes.c_ulong(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if exe_name(pid.value) in _BROWSER_EXES:
                found.append(hwnd)
                return False  # EnumWindows 按 Z 序，第一个就是最上层，无需继续
            return True

        user32.EnumWindows(callback, 0)
        return found[0] if found else None

    def activate(hwnd):
        _activate_window(hwnd)

    webbrowser.open(url)
    # 浏览器打开窗口/切换标签需要一点时间，最多等 3 秒
    for _ in range(15):
        time.sleep(0.2)
        hwnd = top_browser_window()
        if hwnd:
            activate(hwnd)
            return

# 资源管理器窗口会被应用窗口挡在后面；按目录路径找到对应窗口后提到前台。
_EXPLORER_HWND_SCRIPT = r'''
$target = [Environment]::GetEnvironmentVariable('RH_OPEN_DIR')
if (-not $target) { exit 0 }
$target = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
try { $shell = New-Object -ComObject Shell.Application } catch { exit 0 }
for ($i = 0; $i -lt 25; $i++) {
  foreach ($w in $shell.Windows()) {
    try {
      $p = $w.Document.Folder.Self.Path
      if ($p -and [System.IO.Path]::GetFullPath($p).TrimEnd('\') -ieq $target) {
        Write-Output ([int64]$w.HWND)
        exit 0
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 200
}
exit 0
'''


def _focus_explorer_window(path):
    """打开目录后把对应资源管理器窗口置前；失败不影响目录已打开的结果。"""
    try:
        env = os.environ.copy()
        env["RH_OPEN_DIR"] = path
        result = subprocess.run(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", _EXPLORER_HWND_SCRIPT],
            capture_output=True, text=True, timeout=20,
            encoding="utf-8", errors="replace", env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        hwnd = int((result.stdout or "").strip() or "0")
        if hwnd:
            _activate_window(hwnd)
    except Exception as e:
        print("[server] focus explorer window failed: " + str(e), file=sys.stderr)

# 服务端自动下载只接受预期业务域名和常见云存储域名；其它结果仍可由浏览器直接下载。
# rh-images.xiaoyaoyou.com、*.tos-cn-*.volces.com 是 RunningHub 生成结果的官方 CDN，必须放行。
_DOWNLOAD_HOST_SUFFIXES = ("runninghub.cn", "runninghub.ai", "xiaoyaoyou.com", "volces.com", "aliyuncs.com", "myqcloud.com")


def _validate_download_url(url):
    """只允许 HTTPS 公网目标，阻断环回、内网、链路本地和保留地址。"""
    parsed = urlparse(url)
    host = (parsed.hostname or "").rstrip(".").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        raise ValueError("only HTTPS download URLs without credentials are allowed")
    if parsed.port not in (None, 443):
        raise ValueError("only the default HTTPS port is allowed")
    if not any(host == suffix or host.endswith("." + suffix) for suffix in _DOWNLOAD_HOST_SUFFIXES):
        raise ValueError("download host is not allowed: %s" % host)
    try:
        addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as e:
        raise ValueError("download host resolution failed") from e
    if not addresses:
        raise ValueError("download host resolution failed")
    for addr in addresses:
        ip = ipaddress.ip_address(addr[4][0])
        if not ip.is_global:
            raise ValueError("download target must be a public address")
    return url


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """结果下载不跟随重定向，避免重定向到内网或未校验主机。"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# ================= 自动更新辅助 =================
def _version_key(v):
    """把 1.0.10 这类版本号转成可比较的整数元组。"""
    parts = re.findall(r"\d+", str(v or ""))
    return tuple(int(x) for x in parts) if parts else (0,)

def _validate_update_url(url, hosts=UPDATE_MANIFEST_HOSTS):
    """更新清单与安装包只允许 HTTPS + 白名单主机，阻断内网目标。"""
    parsed = urlparse(url)
    host = (parsed.hostname or "").rstrip(".").lower()
    if parsed.scheme != "https" or not host or parsed.username or parsed.password:
        raise ValueError("更新地址必须是 HTTPS 且不能带账号密码")
    if parsed.port not in (None, 443):
        raise ValueError("更新地址只允许默认 HTTPS 端口")
    if not any(host == h or host.endswith("." + h) for h in hosts):
        raise ValueError("更新地址主机不在白名单：" + host)
    return url

def _fetch_update_manifest():
    """按 Gitee → jsDelivr → GitHub 顺序拉取清单，全部失败时汇总各源错误。"""
    errors = []
    for url in UPDATE_MANIFEST_URLS:
        host = urlparse(url).hostname or url
        try:
            _validate_update_url(url, UPDATE_MANIFEST_HOSTS)
            req = urllib.request.Request(url, headers={"User-Agent": "RunningHubToolbox/%s" % APP_VERSION})
            with urllib.request.urlopen(req, timeout=10) as r:
                _validate_update_url(r.geturl() or url, UPDATE_MANIFEST_HOSTS)
                raw = r.read(MAX_MANIFEST_BYTES + 1)
                if len(raw) > MAX_MANIFEST_BYTES:
                    raise ValueError("更新清单过大")
                obj = json.loads(raw.decode("utf-8"))
            if not isinstance(obj, dict) or not obj.get("version"):
                raise ValueError("清单格式不正确")
            update_sign.verify_manifest(obj)
            return obj
        except Exception as e:
            errors.append("%s：%s" % (host, e))
    raise RuntimeError("无法获取更新清单，请检查网络后重试（%s）" % "；".join(errors))

def _validate_announcement_url(url):
    """公告链接只允许微信公众号文章，防止清单被改成任意站点。"""
    parsed = urlparse(url)
    host = (parsed.hostname or "").rstrip(".").lower()
    if parsed.scheme != "https" or host != ANNOUNCEMENT_ALLOWED_HOST:
        raise ValueError("公告链接必须是 https://mp.weixin.qq.com/ 文章")
    if parsed.username or parsed.password:
        raise ValueError("公告链接不能带账号密码")
    if parsed.port not in (None, 443):
        raise ValueError("公告链接只允许默认 HTTPS 端口")
    return url

def _normalize_announcement_items(raw):
    """逐条校验公告；单条不合法只丢弃该条，不影响整份清单。"""
    items, used = [], set()
    for it in raw if isinstance(raw, list) else []:
        if not isinstance(it, dict):
            continue
        aid = str(it.get("id") or "").strip()[:64]
        title = str(it.get("title") or "").strip()[:40]
        published = str(it.get("publishedAt") or "").strip()
        if not aid or not title or aid in used:
            continue
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", published):
            continue
        try:
            datetime.date.fromisoformat(published)  # 拒绝 2026-99-99 这类格式合法但日期不存在
        except ValueError:
            continue
        try:
            _validate_announcement_url(str(it.get("url") or "").strip())
        except ValueError:
            continue
        used.add(aid)
        items.append({
            "id": aid,
            "title": title,
            "summary": str(it.get("summary") or "").strip()[:80],
            "url": str(it.get("url") or "").strip(),
            "publishedAt": published,
        })
    items.sort(key=lambda x: x["publishedAt"], reverse=True)
    return items[:ANNOUNCEMENT_MAX_ITEMS]

def _fetch_announcement_manifest():
    """按 Gitee → jsDelivr → GitHub 顺序拉取公告清单，失败自动切源。"""
    errors = []
    for url in ANNOUNCEMENT_MANIFEST_URLS:
        host = urlparse(url).hostname or url
        try:
            _validate_update_url(url, UPDATE_MANIFEST_HOSTS)
            req = urllib.request.Request(url, headers={"User-Agent": "RunningHubToolbox/%s" % APP_VERSION})
            with urllib.request.urlopen(req, timeout=10) as r:
                _validate_update_url(r.geturl() or url, UPDATE_MANIFEST_HOSTS)
                raw = r.read(MAX_MANIFEST_BYTES + 1)
                if len(raw) > MAX_MANIFEST_BYTES:
                    raise ValueError("公告清单过大")
                obj = json.loads(raw.decode("utf-8"))
            if not isinstance(obj, dict) or obj.get("schema") != 1:
                raise ValueError("公告清单格式不正确")
            return obj
        except Exception as e:
            errors.append("%s：%s" % (host, e))
    raise RuntimeError("无法获取公告（%s）" % "；".join(errors))

def _update_state_snapshot():
    with _UPDATE_LOCK:
        return dict(_UPDATE_STATE)

def _set_update_state(**kw):
    with _UPDATE_LOCK:
        _UPDATE_STATE.update(kw)

def _download_update_worker(manifest):
    installer = manifest.get("installer") or {}
    urls = [u for u in (installer.get("urls") or []) if isinstance(u, str)]
    sha = str(installer.get("sha256") or "").strip().lower()
    version = str(manifest.get("version") or "")
    try:
        expected = int(installer.get("size") or 0)
    except (TypeError, ValueError):
        expected = 0
    # 安装包必须带明确大小与 SHA256，否则下载完成也无法确认完整性
    if expected <= 0:
        _set_update_state(state="error", error="更新清单缺少安装包大小，已取消下载")
        return
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        _set_update_state(state="error", error="更新清单缺少有效的 SHA256，已取消下载")
        return
    os.makedirs(UPDATE_DIR, exist_ok=True)
    final = os.path.join(UPDATE_DIR, UPDATE_FILE_NAME)
    part = final + ".part"
    errors = []
    for url in urls:
        if _UPDATE_CANCEL.is_set():
            _set_update_state(state="cancelled")
            return
        try:
            _validate_update_url(url, UPDATE_INSTALLER_HOSTS)
            req = urllib.request.Request(url, headers={"User-Agent": "RunningHubToolbox/%s" % APP_VERSION})
            with urllib.request.urlopen(req, timeout=30) as r:
                _validate_update_url(r.geturl() or url, UPDATE_INSTALLER_HOSTS)
                total = int(r.headers.get("Content-Length") or 0) or expected
                if total > MAX_UPDATE_BYTES:
                    raise ValueError("安装包超过大小上限")
                _set_update_state(state="downloading", received=0, total=total, percent=0,
                                  source=urlparse(url).hostname or "", error="")
                digest = hashlib.sha256()
                received = 0
                with open(part, "wb") as f:
                    while True:
                        if _UPDATE_CANCEL.is_set():
                            raise KeyboardInterrupt("cancelled")
                        chunk = r.read(65536)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > MAX_UPDATE_BYTES:
                            raise ValueError("安装包超过大小上限")
                        f.write(chunk)
                        digest.update(chunk)
                        pct = int(received * 100 / total) if total else 0
                        _set_update_state(received=received, total=total, percent=min(pct, 100))
            if received != expected:
                raise ValueError("安装包大小不符：%d != %d" % (received, expected))
            if digest.hexdigest().lower() != sha:
                raise ValueError("安装包 SHA256 校验失败")
            os.replace(part, final)
            _set_update_state(state="ready", received=received, total=received, percent=100,
                              version=version, sha256=sha, size=received, error="")
            return
        except KeyboardInterrupt:
            try: os.remove(part)
            except OSError: pass
            _set_update_state(state="cancelled", error="")
            return
        except Exception as e:
            errors.append("%s：%s" % (urlparse(url).hostname or url, e))
            try: os.remove(part)
            except OSError: pass
    _set_update_state(state="error", error="下载失败，请检查网络或手动下载（%s）" % "；".join(errors)
                      if errors else "下载失败")


def _safe_zip_member_parts(name):
    """校验 sys_tools.zip 条目名并拆成路径片段；非法返回 None。
    拒绝绝对路径、盘符/冒号、.. 与反斜杠，只允许普通的相对 POSIX 路径。"""
    if not isinstance(name, str) or not name or "\x00" in name or "\\" in name:
        return None
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name) or ":" in name:
        return None
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return parts

def _extract_sys_zip(zf, dest):
    """把压缩包解压到 dest（必须是空目录）；任一条目非法或超限立即失败。
    返回写入的文件数。调用方保证 dest 是新建的临时目录，失败整体丢弃。"""
    infos = zf.infolist()
    if len(infos) > MAX_SYS_ZIP_ENTRIES:
        raise ValueError("sys_tools.zip 条目过多（上限 %d）" % MAX_SYS_ZIP_ENTRIES)
    root = os.path.realpath(dest)
    total = 0
    restored = 0
    for info in infos:
        if info.is_dir():
            continue
        parts = _safe_zip_member_parts(info.filename)
        if parts is None:
            raise ValueError("sys_tools.zip 含非法路径：" + str(info.filename)[:80])
        target = os.path.realpath(os.path.join(root, *parts))
        if not target.startswith(root + os.sep):
            raise ValueError("sys_tools.zip 含越权路径：" + str(info.filename)[:80])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            while True:
                chunk = src.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_SYS_ZIP_BYTES:
                    raise ValueError("sys_tools.zip 解压后超过大小上限")
                dst.write(chunk)
        restored += 1
    return restored


class _BodyError(Exception):
    """请求体读取失败；带 HTTP 状态码，由 do_POST 统一回一次错误响应。"""
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


STATIC_TOP_DIRS = ("css/", "js/", "ICO/")


def _resolve_static_path(path):
    """静态资源白名单：返回 BASE_DIR 内的真实文件路径；非法或不存在返回 None。
    只允许首页/工具说明页，以及 css/、js/、ICO/ 下的普通文件，
    目录、隐藏文件、含 .. 或反斜杠的路径一律拒绝。"""
    if path in ("/", "/index.html"):
        rel = "index.html"
    elif path == "/runninghub_tool.html":
        rel = "runninghub_tool.html"
    else:
        raw = path[1:] if path.startswith("/") else path
        parts = [p for p in raw.split("/") if p]
        if (not raw or "\\" in raw or "\x00" in raw or len(parts) < 2
                or any(p in (".", "..") or p.startswith(".") for p in parts)
                or parts[0] + "/" not in STATIC_TOP_DIRS):
            return None
        rel = os.path.join(*parts)
    root = os.path.realpath(BASE_DIR)
    target = os.path.realpath(os.path.join(root, rel))
    if not target.startswith(root + os.sep) or not os.path.isfile(target):
        return None
    return target


class Handler(http.server.SimpleHTTPRequestHandler):
    timeout = 30  # StreamRequestHandler 用该值设置 socket 超时，避免慢连接长期占用线程

    def _check_host(self):
        """Host 白名单同时阻止 DNS rebinding 读取令牌和静态资源。"""
        host = (self.headers.get("Host") or "").strip().lower()
        allowed = {"127.0.0.1:%d" % self.server.server_port, "localhost:%d" % self.server.server_port}
        if host in allowed:
            return True
        self._send_json(403, {"ok": False, "error": "invalid local host"})
        return False

    def _check_local_action(self):
        """写操作和系统副作用操作必须来自本应用，并持有本次启动令牌。"""
        origin = (self.headers.get("Origin") or "").strip()
        if origin:
            allowed = {"http://127.0.0.1:%d" % self.server.server_port,
                       "http://localhost:%d" % self.server.server_port}
            if origin not in allowed:
                self._send_json(403, {"ok": False, "error": "cross-site local action denied"})
                return False
        supplied = self.headers.get(LOCAL_TOKEN_HEADER) or ""
        if not hmac.compare_digest(supplied, ACCESS_TOKEN):
            self._send_json(403, {"ok": False, "error": "valid local token required"})
            return False
        return True

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        super().end_headers()

    def do_GET(self):
        if not self._check_host():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/appinfo":
            self._handle_appinfo()
        elif parsed.path == "/tools-index":
            self._send_json(200, _tools_index())
        elif parsed.path == "/update/progress":
            self._send_json(200, dict(ok=True, **_update_state_snapshot()))
        elif parsed.path == "/open-dir":
            if self._check_local_action():
                self._handle_open_dir(parse_qs(parsed.query))
        elif parsed.path == "/pick-download-dir":
            if self._check_local_action():
                self._handle_pick_download_dir(parse_qs(parsed.query))
        elif parsed.path == "/tools" or parsed.path.startswith("/tools/"):
            self._handle_tools_static(parsed)
        elif parsed.path.startswith("/downloads/"):
            self._handle_downloads_static(parsed)
        else:
            self._handle_static(parsed)

    def do_HEAD(self):
        if not self._check_host():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/tools" or parsed.path.startswith("/tools/"):
            self._handle_tools_static(parsed, head_only=True)
        elif parsed.path.startswith("/downloads/"):
            self._handle_downloads_static(parsed, head_only=True)
        else:
            self._handle_static(parsed, head_only=True)

    def do_POST(self):
        if not self._check_host() or not self._check_local_action():
            return
        parsed = urlparse(self.path)
        self._responded = False
        try:
            if parsed.path == "/save-cover":
                self._handle_save_cover(parse_qs(parsed.query))
            elif parsed.path == "/rename-cover":
                self._handle_rename_cover()
            elif parsed.path == "/save-tool":
                self._handle_save_tool()
            elif parsed.path == "/delete-tool":
                self._handle_delete_tool()
            elif parsed.path == "/tool-tombstone":
                self._handle_tool_tombstone()
            elif parsed.path == "/copy-tool":
                self._handle_copy_tool()
            elif parsed.path == "/reset-sys-tools":
                self._handle_reset_sys_tools()
            elif parsed.path == "/update/check":
                self._handle_update_check()
            elif parsed.path == "/announcement/check":
                self._handle_announcement_check()
            elif parsed.path == "/update/download":
                self._handle_update_download()
            elif parsed.path == "/update/cancel":
                _UPDATE_CANCEL.set()
                self._send_json(200, {"ok": True})
            elif parsed.path == "/update/install":
                self._handle_update_install()
            elif parsed.path == "/save-image":
                self._handle_save_image()
            elif parsed.path == "/shutdown":
                self._handle_shutdown()
            elif parsed.path == "/show-window":
                self._handle_show_window()
            elif parsed.path == "/open-url":
                self._handle_open_url(parse_qs(parsed.query))
            else:
                self._send_json(404, {"ok": False, "error": "unknown endpoint"})
        except _BodyError as e:
            if not self._responded:
                self._send_json(e.code, {"ok": False, "error": e.msg})

    def _handle_open_url(self, qs):
        """外部链接交给系统默认浏览器打开：应用窗口无地址栏，不能在窗口内跳走。"""
        url = (qs.get("u") or [""])[0]
        if not re.match(r"^https?://", url, re.I):
            self._send_json(400, {"ok": False, "error": "only http(s) allowed"})
            return
        threading.Thread(target=_open_external_url, args=(url,), daemon=True).start()
        self._send_json(200, {"ok": True})

    def _handle_shutdown(self):
        """退出程序：先返回响应，再由另一个线程停止服务（shutdown 不能在本线程调用）。"""
        self._send_json(200, {"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _handle_show_window(self):
        """第二个启动的进程请求唤回界面：同步执行并返回窗口是否真的出现。"""
        hook = SHOW_WINDOW_HOOK
        if not hook:
            self._send_json(503, {"ok": False, "error": "窗口唤回尚未就绪"})
            return
        try:
            ok = bool(hook())
            self._send_json(200, {"ok": ok})
        except Exception as e:
            self._send_json(200, {"ok": False, "error": str(e) or e.__class__.__name__})

    def _read_body(self, limit):
        """按 Content-Length 读取请求体并强制上限；异常交给 do_POST 统一回错误。"""
        raw_len = self.headers.get("Content-Length")
        if raw_len is None or not str(raw_len).strip():
            return b""
        try:
            n = int(str(raw_len).strip())
        except ValueError:
            raise _BodyError(400, "invalid content length")
        if n < 0:
            raise _BodyError(400, "invalid content length")
        if n > limit:
            raise _BodyError(413, "request body too large")
        if n == 0:
            return b""
        data = self.rfile.read(n)
        if len(data) != n:
            raise _BodyError(400, "incomplete request body")
        return data

    def _read_json_body(self):
        """读取 JSON 请求体；空体返回 {}，其余必须是 JSON 对象，避免调用方对 list/null 取键。"""
        raw = self._read_body(MAX_JSON_BODY)
        if not raw:
            return {}
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise _BodyError(400, "invalid json")
        if not isinstance(obj, dict):
            raise _BodyError(400, "json object required")
        return obj

    def _handle_static(self, parsed, head_only=False):
        """只提供页面、样式、脚本、图标；其余路径（含源码、日志、.git）一律 404。"""
        target = _resolve_static_path(unquote(parsed.path))
        if not target:
            self.send_error(404, "File not found")
            return
        try:
            with open(target, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404, "File not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(target))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def _handle_tools_static(self, parsed, head_only=False):
        """合并暴露 user_tools / sys_tools：同名文件 user 优先，系统工具隐藏的旧版本不对外。"""
        if parsed.path == "/tools":
            self.send_response(301)
            self.send_header("Location", "/tools/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if parsed.path == "/tools/":
            names = {e["file"] for e in _tools_index()["files"]}
            for d in (_user_tools_dir(), SYS_TOOLS_DIR):
                if not os.path.isdir(d):
                    continue
                try:
                    for fn in os.listdir(d):
                        if fn.lower().endswith(COVER_EXTS) and os.path.isfile(os.path.join(d, fn)):
                            names.add(fn)
                except OSError:
                    pass
            items = "".join(
                '<li><a href="%s">%s</a></li>' % (html.escape(quote(fn), quote=True), html.escape(fn))
                for fn in sorted(names)
            )
            body = ("<!DOCTYPE html><html><body><ul>" + items + "</ul></body></html>").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return

        name = unquote(parsed.path[len("/tools/"):])
        if (not name or name != _safe_filename(name, "") or "/" in name or "\\" in name
                or not name.lower().endswith(TOOL_EXTS + COVER_EXTS)):
            self.send_error(404, "File not found")
            return
        path = _find_tool_file(name)
        if not path:
            self.send_error(404, "File not found")
            return
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self.send_error(404, "File not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def _parse_byte_range(self, size):
        """解析单段 Range；返回 (start, end)、None（未请求）或 "invalid"。"""
        raw = (self.headers.get("Range") or "").strip()
        m = re.match(r"^bytes=(\d*)-(\d*)$", raw)
        if not m:
            return None
        start_s, end_s = m.group(1), m.group(2)
        if start_s == "" and end_s == "":
            return None
        if start_s == "":
            n = int(end_s)  # 后缀范围：最后 n 字节
            if n <= 0 or size == 0:
                return "invalid"
            return max(0, size - n), size - 1
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
        if size == 0 or start >= size or end < start:
            return "invalid"
        return start, min(end, size - 1)

    def _handle_downloads_static(self, parsed, head_only=False):
        """只读暴露下载目录里的结果文件；支持 Range，浏览器视频才能拖动进度。
        仅接受下载目录内的安全文件名，阻断目录穿越。"""
        name = unquote(parsed.path[len("/downloads/"):])
        if (not name or name != _safe_filename(name, "") or "/" in name or "\\" in name):
            self.send_error(404, "File not found")
            return
        path = os.path.join(_download_dir(), name)
        if not os.path.isfile(path):
            self.send_error(404, "File not found")
            return
        try:
            size = os.path.getsize(path)
        except OSError:
            self.send_error(404, "File not found")
            return
        rng = self._parse_byte_range(size)
        if rng == "invalid":
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start, end = (0, size - 1) if rng is None else rng
        length = max(0, end - start + 1)
        self.send_response(206 if rng is not None else 200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if rng is not None:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        if head_only:
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器中途取消（切换图片/关闭）时属正常断开

    def _handle_save_cover(self, qs):
        """保存封面：body 为图片二进制，name 为基名，source 决定写入系统还是用户目录。"""
        base = _safe_filename(unquote((qs.get("name") or [""])[0]), "cover")
        source = "sys" if str((qs.get("source") or [""])[0]).lower() == "sys" else "user"
        data = self._read_body(MAX_COVER_BYTES)
        if not data:
            self._send_json(400, {"ok": False, "error": "empty body"})
            return
        ext = _cover_ext_from_bytes(data)
        if not ext:
            self._send_json(400, {"ok": False, "error": "unsupported image format"})
            return
        d = _source_dir(source)
        downgraded = False
        if d is None:
            d = _user_tools_dir()
            source, downgraded = "user", True

        def write_to(dir_path):
            for old_ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                if old_ext != ext:
                    try: os.remove(os.path.join(dir_path, base + old_ext))
                    except OSError: pass
            with open(os.path.join(dir_path, base + ext), "wb") as f:
                f.write(data)

        try:
            write_to(d)
        except OSError as e:
            if source != "sys":
                self._send_json(500, {"ok": False, "error": str(e)})
                return
            d = _user_tools_dir()
            source, downgraded = "user", True
            write_to(d)
        self._send_json(200, {"ok": True, "file": base + ext, "source": source, "downgraded": downgraded})

    def _handle_rename_cover(self):
        """工具改名时同步重命名封面文件（仅在同一来源目录内操作）。"""
        obj = self._read_json_body()
        old = _safe_filename(obj.get("old"), "")
        new = _safe_filename(obj.get("new"), "")
        if not old or not new:
            self._send_json(400, {"ok": False, "error": "old/new required"})
            return
        source = "sys" if str(obj.get("source") or "").lower() == "sys" else "user"
        d = _source_dir(source)
        if d is None:
            d = _user_tools_dir()
        # 规范化后相同（含仅大小写不同）视为无需改名，避免删掉同一个封面文件
        if (os.path.normcase(os.path.abspath(os.path.join(d, old)))
                == os.path.normcase(os.path.abspath(os.path.join(d, new)))):
            self._send_json(200, {"ok": True, "files": [], "source": source})
            return
        moved = []
        for ext in COVER_EXTS:
            src = os.path.join(d, old + ext)
            if not os.path.isfile(src):
                continue
            for other in COVER_EXTS:
                if other != ext:
                    try: os.remove(os.path.join(d, new + other))
                    except OSError: pass
            os.replace(src, os.path.join(d, new + ext))
            moved.append(new + ext)
        self._send_json(200, {"ok": True, "files": moved, "source": source})

    def _handle_save_tool(self):
        """把工具配置 JSON 写入对应目录：source=sys 写系统目录，否则写用户目录。
        写入前先校验内容，非法请求一律 400 且不落盘。"""
        obj = self._read_json_body()
        fn = _safe_filename(obj.get("file"), "tool.rhtool.json")
        if not fn.lower().endswith(".json"):
            fn += ".rhtool.json"
        content = obj.get("content")
        if not isinstance(content, str):
            self._send_json(400, {"ok": False, "error": "content must be a json string"})
            return
        try:
            cfg = json.loads(content)
        except ValueError:
            self._send_json(400, {"ok": False, "error": "invalid tool json"})
            return
        if not isinstance(cfg, dict):
            self._send_json(400, {"ok": False, "error": "tool config must be a json object"})
            return
        name = cfg.get("name")
        if not isinstance(name, str) or not name.strip():
            self._send_json(400, {"ok": False, "error": "tool name required"})
            return
        if not isinstance(cfg.get("fields"), list):
            self._send_json(400, {"ok": False, "error": "tool fields must be an array"})
            return
        source = "sys" if str(obj.get("source") or "").lower() == "sys" else "user"
        downgraded = False
        d = _source_dir(source)
        if d is None:
            d = _user_tools_dir()
            source, downgraded = "user", True
        try:
            _write_text_atomic(os.path.join(d, fn), content)
        except OSError as e:
            if source == "sys":
                # 安装目录不可写（如被移到受保护目录）：自动改存为用户工具
                d = _user_tools_dir()
                source, downgraded = "user", True
                try:
                    _write_text_atomic(os.path.join(d, fn), content)
                except OSError as e2:
                    self._send_json(500, {"ok": False, "error": str(e2)})
                    return
            else:
                self._send_json(500, {"ok": False, "error": str(e)})
                return
        # 改名时清理同目录旧文件；规范化后与新文件相同（含仅大小写不同）时不删除，避免删掉刚写入的文件
        removed = []
        old = _safe_filename(obj.get("oldFile"), "")
        if old:
            old_abs = os.path.normcase(os.path.abspath(os.path.join(d, old)))
            new_abs = os.path.normcase(os.path.abspath(os.path.join(d, fn)))
            if old_abs != new_abs:
                removed += self._remove_tool_files(old, d)
        self._send_json(200, {"ok": True, "file": fn, "source": source,
                              "downgraded": downgraded, "removed": removed})

    def _remove_tool_files(self, fn, d):
        """删除指定目录中的配置文件及其同名封面，返回被删除的文件名列表。"""
        fn = _safe_filename(fn, "")
        if not fn:
            return []
        removed = []
        if os.path.isfile(os.path.join(d, fn)):
            try:
                os.remove(os.path.join(d, fn))
                removed.append(fn)
            except OSError:
                pass
            base = re.sub(r"\.rhtool\.json$", "", fn, flags=re.I)
            for ext in COVER_EXTS:
                try:
                    os.remove(os.path.join(d, base + ext))
                    removed.append(base + ext)
                except OSError:
                    pass
        return removed

    def _handle_delete_tool(self):
        """删除工具：sys 写墓碑隐藏（更新后可恢复），user 直接删除配置与封面。"""
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        fn = _safe_filename(obj.get("file"), "")
        source = "sys" if str(obj.get("source") or "").lower() == "sys" else "user"
        if fn and source == "sys":
            cfg = _read_tool_config(os.path.join(SYS_TOOLS_DIR, fn))
            wid = str((cfg or {}).get("webappId") or "").strip()
            if wid:
                ids = _read_tombstones()
                ids.add(wid)
                _write_tombstones(ids)
            else:
                self._remove_tool_files(fn, SYS_TOOLS_DIR)
        elif fn:
            self._remove_tool_files(fn, _user_tools_dir())
        self._send_json(200, {"ok": True})

    def _handle_tool_tombstone(self):
        """系统工具墓碑：deleted=true 隐藏，false 恢复。"""
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        wid = str(obj.get("webappId") or "").strip()
        if not wid:
            self._send_json(400, {"ok": False, "error": "webappId required"})
            return
        ids = _read_tombstones()
        if obj.get("deleted", True):
            ids.add(wid)
        else:
            ids.discard(wid)
        _write_tombstones(ids)
        self._send_json(200, {"ok": True})

    def _handle_copy_tool(self):
        """把系统工具（配置+封面）复制为用户工具，之后编辑不受更新影响。"""
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        fn = _safe_filename(obj.get("file"), "")
        if not fn.lower().endswith(".rhtool.json"):
            self._send_json(400, {"ok": False, "error": "invalid tool file"})
            return
        src_dir = None
        for d in (SYS_TOOLS_DIR, _user_tools_dir()):
            if os.path.isfile(os.path.join(d, fn)):
                src_dir = d
                break
        if not src_dir:
            self._send_json(404, {"ok": False, "error": "工具配置不存在"})
            return
        cfg = _read_tool_config(os.path.join(src_dir, fn))
        if cfg is None:
            self._send_json(400, {"ok": False, "error": "工具配置损坏"})
            return
        base = re.sub(r"\.rhtool\.json$", "", fn, flags=re.I)
        target_base = base
        n = 0
        # 两个目录都检查，避免覆盖系统工具或已有用户工具
        while any(os.path.isfile(os.path.join(d, target_base + ".rhtool.json"))
                  for d in (SYS_TOOLS_DIR, USER_TOOLS_DIR)):
            n += 1
            target_base = base + (" (我的)" if n == 1 else " (我的 %d)" % n)
        if target_base != base:
            cfg["name"] = target_base
        target_fn = target_base + ".rhtool.json"
        try:
            with open(os.path.join(_user_tools_dir(), target_fn), "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except OSError as e:
            self._send_json(500, {"ok": False, "error": str(e)})
            return
        for ext in COVER_EXTS:
            src = os.path.join(src_dir, base + ext)
            if os.path.isfile(src):
                try:
                    shutil.copy2(src, os.path.join(_user_tools_dir(), target_base + ext))
                except OSError:
                    pass
                break
        self._send_json(200, {"ok": True, "file": target_fn, "source": "user",
                              "name": cfg.get("name") or target_base})

    def _handle_reset_sys_tools(self):
        """重置系统工具：备份 → 解压到临时目录 → 原子替换 sys_tools → 清墓碑。
        旧目录在替换成功前始终完整保留，任何一步失败都回滚，避免半途清空。"""
        if not os.path.isfile(SYS_ZIP):
            self._send_json(400, {"ok": False, "error": "未找到 sys_tools.zip，无法重置"})
            return
        try:
            with zipfile.ZipFile(SYS_ZIP) as zf:
                zf.infolist()
        except (OSError, zipfile.BadZipFile) as e:
            self._send_json(400, {"ok": False, "error": "sys_tools.zip 损坏：" + str(e)})
            return
        backup = ""
        tmp_dir = ""
        old_dir = SYS_TOOLS_DIR + ".old"
        moved_old = False
        new_in_place = False
        try:
            if os.path.isdir(SYS_TOOLS_DIR):
                backup = os.path.join(DATA_DIR, "backup", "sys-" + time.strftime("%Y%m%d_%H%M%S"))
                shutil.copytree(SYS_TOOLS_DIR, backup)
            # 先解压到 BASE_DIR 下的临时目录（与 sys_tools 同盘，改名才能是原子的）
            tmp_dir = tempfile.mkdtemp(prefix="sys_tools_new-", dir=BASE_DIR)
            with zipfile.ZipFile(SYS_ZIP) as z:
                restored = _extract_sys_zip(z, tmp_dir)
            # 上一次失败可能留下 .old，先清掉再替换
            if os.path.exists(old_dir):
                shutil.rmtree(old_dir)
            if os.path.isdir(SYS_TOOLS_DIR):
                os.rename(SYS_TOOLS_DIR, old_dir)
                moved_old = True
            try:
                os.rename(tmp_dir, SYS_TOOLS_DIR)
                new_in_place, tmp_dir = True, ""
            except OSError:
                if moved_old and not os.path.isdir(SYS_TOOLS_DIR):
                    os.rename(old_dir, SYS_TOOLS_DIR)
                    moved_old = False
                raise
            if moved_old:
                shutil.rmtree(old_dir, ignore_errors=True)
            try:
                _write_tombstones(set())
            except OSError:
                pass  # 工具已就位；墓碑清理失败只会让旧隐藏项继续隐藏，不影响本次结果
            self._send_json(200, {"ok": True, "restored": restored, "backup": backup})
        except (OSError, ValueError, zipfile.BadZipFile) as e:
            # 恢复旧目录 / 清理临时目录，保证失败后原 sys_tools 完整
            if moved_old and not new_in_place:
                if os.path.isdir(old_dir) and not os.path.isdir(SYS_TOOLS_DIR):
                    try: os.rename(old_dir, SYS_TOOLS_DIR)
                    except OSError: pass
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            self._send_json(500, {"ok": False, "error": str(e), "backup": backup})

    # ---------- 自动更新 ----------
    def _handle_update_check(self):
        """更新检查带 5 分钟缓存；并发请求只放行一个清单外呼。"""
        with _UPDATE_CHECK_LOCK:
            now = time.time()
            payload = _UPDATE_CACHE.get("payload")
            if payload is not None and now - (_UPDATE_CACHE.get("ts") or 0) < _UPDATE_CACHE_TTL:
                result = payload
            else:
                try:
                    manifest = _fetch_update_manifest()
                    installer = manifest.get("installer")
                    if not isinstance(installer, dict):
                        installer = {}
                    try:
                        size = int(installer.get("size") or 0)
                    except (TypeError, ValueError):
                        size = 0
                    latest = str(manifest.get("version") or "")
                    result = {
                        "ok": True,
                        "current": APP_VERSION,
                        "latest": latest,
                        "hasUpdate": _version_key(latest) > _version_key(APP_VERSION),
                        "date": manifest.get("date") or "",
                        "notes": manifest.get("notes") or "",
                        "size": size,
                        "page": manifest.get("page") or "",
                    }
                except Exception as e:
                    result = {"ok": False, "error": str(e)}  # 失败不写缓存
                else:
                    _UPDATE_CACHE["ts"] = time.time()
                    _UPDATE_CACHE["payload"] = result
        self._send_json(200, result)

    # ---------- 公众号公告 ----------
    def _handle_announcement_check(self):
        payload = None
        with _ANN_LOCK:
            cached = _ANN_CACHE.get("payload")
            if cached is not None and time.time() - (_ANN_CACHE.get("ts") or 0) < ANNOUNCEMENT_CACHE_TTL:
                payload = cached
        if payload is None:
            with _ANN_FETCH_LOCK:
                # 二次检查：等锁期间可能已有请求完成拉取
                with _ANN_LOCK:
                    cached = _ANN_CACHE.get("payload")
                    if cached is not None and time.time() - (_ANN_CACHE.get("ts") or 0) < ANNOUNCEMENT_CACHE_TTL:
                        payload = cached
                if payload is None:
                    try:
                        manifest = _fetch_announcement_manifest()
                    except Exception as e:
                        payload = {"ok": False, "error": str(e)}
                    else:
                        payload = {
                            "ok": True,
                            "updatedAt": str(manifest.get("updatedAt") or ""),
                            "items": _normalize_announcement_items(manifest.get("items")),
                        }
                        with _ANN_LOCK:
                            _ANN_CACHE["ts"] = time.time()
                            _ANN_CACHE["payload"] = payload
        self._send_json(200, payload)

    def _handle_update_download(self):
        obj = self._read_json_body()
        manifest = obj.get("manifest")
        if manifest is not None and not isinstance(manifest, dict):
            self._send_json(400, {"ok": False, "error": "manifest must be a json object"})
            return
        if not isinstance(manifest, dict):
            # 允许前端不传清单：服务端自己重新拉取
            try:
                manifest = _fetch_update_manifest()
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
                return
        installer = manifest.get("installer")
        if not isinstance(installer, dict):
            self._send_json(400, {"ok": False, "error": "更新清单缺少 installer"})
            return
        raw_size = installer.get("size")
        if isinstance(raw_size, bool):
            size_ok = False
        elif isinstance(raw_size, int):
            size_ok = raw_size > 0
        elif isinstance(raw_size, str) and raw_size.strip().isdigit():
            size_ok = int(raw_size.strip()) > 0
        else:
            size_ok = False
        if not size_ok:
            self._send_json(400, {"ok": False, "error": "更新清单缺少有效的安装包大小"})
            return
        urls = installer.get("urls")
        if (not isinstance(urls, list) or not urls
                or not all(isinstance(u, str) and u.strip() for u in urls)):
            self._send_json(400, {"ok": False, "error": "更新清单缺少下载地址"})
            return
        with _UPDATE_LOCK:
            if _UPDATE_STATE.get("state") in ("starting", "downloading"):
                self._send_json(409, {"ok": False, "error": "正在下载中"})
                return
            _UPDATE_STATE.update({"state": "starting", "received": 0, "total": 0,
                                  "percent": 0, "source": "", "error": "",
                                  "version": str(manifest.get("version") or ""),
                                  "sha256": "", "size": 0})
        _UPDATE_CANCEL.clear()
        threading.Thread(target=_download_update_worker, args=(manifest,), daemon=True).start()
        self._send_json(200, {"ok": True})

    def _handle_update_install(self):
        state = _update_state_snapshot()
        if state.get("state") != "ready":
            self._send_json(400, {"ok": False, "error": "安装包尚未下载完成"})
            return
        if _version_key(state.get("version")) <= _version_key(APP_VERSION):
            self._send_json(400, {"ok": False, "error": "当前已是最新版本，无需安装"})
            return
        path = os.path.join(UPDATE_DIR, UPDATE_FILE_NAME)
        if not os.path.isfile(path):
            self._send_json(400, {"ok": False, "error": "安装包不存在，请重新下载"})
            return
        # 下载阶段已强制记录 sha256/size；这里再次确认，避免状态异常时跳过完整性校验
        expected_sha = str(state.get("sha256") or "").strip().lower()
        expected_size = state.get("size") or 0
        if (len(expected_sha) != 64
                or any(c not in "0123456789abcdef" for c in expected_sha)
                or not isinstance(expected_size, int) or isinstance(expected_size, bool)
                or expected_size <= 0):
            self._send_json(400, {"ok": False, "error": "安装包校验信息缺失，请重新下载"})
            return
        size = os.path.getsize(path)
        digest = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest().lower() != expected_sha:
            self._send_json(400, {"ok": False, "error": "安装包校验失败，请重新下载"})
            return
        if size != expected_size:
            self._send_json(400, {"ok": False, "error": "安装包大小不符，请重新下载"})
            return
        self._send_json(200, {"ok": True})

        def run():
            time.sleep(0.4)
            hook = UPDATE_INSTALL_HOOK
            try:
                if hook:
                    hook(path)
                else:
                    subprocess.Popen([path, "/SILENT", "/NORESTART", "/SP-"], close_fds=True)
                    time.sleep(0.5)
                    os._exit(0)
            except Exception as e:
                print("[server] update install failed: " + str(e), file=sys.stderr)

        threading.Thread(target=run, daemon=True).start()

    def _handle_save_image(self):
        """服务端直接把生成结果下载到已配置的下载目录，浏览器无需授权文件夹。"""
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        url = (obj.get("url") or "").strip()
        try:
            _validate_download_url(url)
        except ValueError as e:
            self._send_json(403, {"ok": False, "error": str(e)})
            return
        fname = _safe_filename(obj.get("filename"), "result.bin")
        path = os.path.join(_download_dir(), fname)
        tmp = path + ".part"
        oversize = False
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            opener = urllib.request.build_opener(_NoRedirectHandler)
            with opener.open(req, timeout=120) as r:
                total = int(r.headers.get("Content-Length") or 0)
                if total > MAX_RESULT_BYTES:
                    oversize = True
                    raise ValueError("结果文件超过大小上限")
                received = 0
                # 分块落盘：不把整个结果读进内存，超限立即中止并清理临时文件
                with open(tmp, "wb") as f:
                    while True:
                        chunk = r.read(65536)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > MAX_RESULT_BYTES:
                            oversize = True
                            raise ValueError("结果文件超过大小上限")
                        f.write(chunk)
            os.replace(tmp, path)
            self._send_json(200, {"ok": True, "path": path, "size": received,
                                  "url": "/downloads/" + quote(fname)})
        except Exception as e:
            try: os.remove(tmp)
            except OSError: pass
            self._send_json(400 if oversize else 500, {"ok": False, "error": str(e)})

    def _handle_appinfo(self):
        info = _load_appinfo()
        info["tools"] = _user_tools_dir()  # 工具配置统一由服务端管理，不再使用 appinfo 旧路径
        info["app"] = "runninghub"
        info["session"] = SESSION_ID
        info["token"] = ACCESS_TOKEN
        info["version"] = APP_VERSION
        body = json.dumps(info, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_open_dir(self, qs):
        raw = (qs.get("path") or [""])[0]
        path = unquote(raw).strip()
        if not path:
            self._send_json(400, {"ok": False, "error": "path parameter required"})
            return
        # 只接受普通本地绝对目录：拒绝 UNC、设备路径、盘符相对路径（C:foo）和含 NUL 的路径
        if ("\x00" in path or path.startswith("\\\\") or path.startswith("//")
                or path.startswith("\\??\\") or re.match(r"^[A-Za-z]:(?![\\/])", path)):
            self._send_json(400, {"ok": False, "error": "invalid local path"})
            return
        try:
            path = os.path.realpath(path)
        except (OSError, ValueError):
            self._send_json(400, {"ok": False, "error": "invalid local path"})
            return
        if not os.path.isabs(path):
            self._send_json(400, {"ok": False, "error": "path must be absolute"})
            return
        if not os.path.isdir(path):
            self._send_json(400, {"ok": False, "error": "directory not found: " + path})
            return
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)
                # 窗口可能被应用窗口挡住；后台等窗口出现后把它提到前台
                threading.Thread(target=_focus_explorer_window, args=(path,), daemon=True).start()
            else:
                import shutil as _shutil
                opener = _shutil.which("xdg-open") or _shutil.which("open")
                if opener:
                    subprocess.Popen([opener, path])
                else:
                    self._send_json(501, {"ok": False, "error": "unsupported platform"})
                    return
            self._send_json(200, {"ok": True, "path": path})
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})

    def _handle_pick_download_dir(self, qs):
        """弹系统目录选择框，用户确认后写回 appinfo.txt 第二行，返回新路径。"""
        if not sys.platform.startswith("win"):
            self._send_json(501, {"ok": False, "error": "FolderBrowserDialog only available on Windows"})
            return

        current = _load_appinfo()
        start_hint = current.get("download", "") or ""

        picked = _pick_download_dir_on_windows(start_hint)
        if not picked:
            self._send_json(200, {"ok": False, "cancelled": True, "path": ""})
            return

        # 自动创建（用户选了不存在的路径时）
        if not os.path.isdir(picked):
            try: os.makedirs(picked, exist_ok=True)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": "mkdir failed: " + str(e)})
                return

        # 写回 appinfo.txt（保留第一行 tools 路径）
        _write_appinfo(current.get("tools", ""), picked)
        self._send_json(200, {"ok": True, "cancelled": False, "path": picked})

    def _send_json(self, code, obj):
        self._responded = True
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()  # 安装更新会随即退出进程，必须确保响应已发出

    def log_message(self, *args):
        pass  # 静默日志

# 端口可用命令行参数覆盖：python server.py 8900
# 默认 8900，避免与同机的 COMFYUI_api 程序（8899）冲突
DEFAULT_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8900

class AppServer(http.server.ThreadingHTTPServer):
    # Windows 下默认允许重复占用同一端口，会出现新旧两个后台同时"监听"、
    # 刷新后时而旧版时而新版；这里禁止重复占用，配合启动脚本先清理旧进程
    allow_reuse_address = False

def serve(port=DEFAULT_PORT, on_ready=None):
    """启动本地服务（阻塞）。端口被占用时自动顺延，on_ready(实际端口) 在开始监听后回调。"""
    for p in range(port, port + 10):
        try:
            httpd = AppServer(("127.0.0.1", p), Handler)
        except OSError:
            continue
        try:
            if on_ready:
                on_ready(p)
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
        return p
    raise OSError("端口 %d-%d 均被占用，请关闭其它实例后重试" % (port, port + 9))

if __name__ == "__main__":
    try:
        serve()
    except KeyboardInterrupt:
        sys.exit(0)
