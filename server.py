# 本地开发服务器：禁止一切缓存，保证浏览器永远拿到最新代码
# 扩展路由：
#   /appinfo            → 返回 {tools, download, session, token}，会话与令牌每次启动都不同
#   /open-dir?path=...  → 调起 Windows 资源管理器打开指定目录
#   /pick-download-dir  → 弹系统 FolderBrowserDialog 让用户选下载目录，写回 appinfo.txt 第二行
#   /downloads/<文件名> → 只读提供下载目录中的结果文件（支持 Range，供结果区本地预览）
import http.server, os, sys, json, locale, subprocess, shlex, uuid, re, urllib.request, threading, webbrowser, time
import hmac, ipaddress, socket, html
from urllib.parse import urlparse, parse_qs, unquote, quote

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
DATA_DIR = _data_dir()
os.makedirs(DATA_DIR, exist_ok=True)
APPINFO = os.path.join(DATA_DIR, "appinfo.txt")
SESSION_ID = uuid.uuid4().hex  # 每次启动 server 生成新会话号，用于清空上一次的生成结果
ACCESS_TOKEN = uuid.uuid4().hex  # 本地变更接口的每次启动随机凭证，不能依赖 CORS 防护
LOCAL_TOKEN_HEADER = "X-RunningHub-Token"

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

def _tools_dir():
    """工具配置目录；appinfo.txt 里的路径不可用时回退到用户数据目录下的 tools。"""
    d = _load_appinfo().get("tools") or ""
    if not d:
        d = os.path.join(DATA_DIR, "tools")
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        d = os.path.join(DATA_DIR, "tools")
        os.makedirs(d, exist_ok=True)
    return d

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


class Handler(http.server.SimpleHTTPRequestHandler):
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
        super().end_headers()

    def do_GET(self):
        if not self._check_host():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/appinfo":
            self._handle_appinfo()
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
            super().do_GET()

    def do_HEAD(self):
        if not self._check_host():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/tools" or parsed.path.startswith("/tools/"):
            self._handle_tools_static(parsed, head_only=True)
        elif parsed.path.startswith("/downloads/"):
            self._handle_downloads_static(parsed, head_only=True)
        else:
            super().do_HEAD()

    def do_POST(self):
        if not self._check_host() or not self._check_local_action():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/save-cover":
            self._handle_save_cover(parse_qs(parsed.query))
        elif parsed.path == "/rename-cover":
            self._handle_rename_cover()
        elif parsed.path == "/save-tool":
            self._handle_save_tool()
        elif parsed.path == "/delete-tool":
            self._handle_delete_tool()
        elif parsed.path == "/save-image":
            self._handle_save_image()
        elif parsed.path == "/shutdown":
            self._handle_shutdown()
        elif parsed.path == "/open-url":
            self._handle_open_url(parse_qs(parsed.query))
        else:
            self._send_json(404, {"ok": False, "error": "unknown endpoint"})

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

    def _read_json_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return None

    def _handle_tools_static(self, parsed, head_only=False):
        """从用户 tools 目录提供配置和封面，不再依赖安装目录中的静态 tools。"""
        if parsed.path == "/tools":
            self.send_response(301)
            self.send_header("Location", "/tools/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        d = _tools_dir()
        if parsed.path == "/tools/":
            try:
                names = sorted(
                    fn for fn in os.listdir(d)
                    if fn.lower().endswith((".rhtool.json", ".png", ".jpg", ".jpeg"))
                    and os.path.isfile(os.path.join(d, fn))
                )
            except OSError:
                self.send_error(404, "Tools directory unavailable")
                return
            items = "".join(
                '<li><a href="%s">%s</a></li>' % (html.escape(quote(fn), quote=True), html.escape(fn))
                for fn in names
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
                or not name.lower().endswith((".rhtool.json", ".png", ".jpg", ".jpeg"))):
            self.send_error(404, "File not found")
            return
        path = os.path.join(d, name)
        if not os.path.isfile(path):
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
        """保存封面：body 为图片二进制，name 为基名，按 PNG 魔数决定扩展名。"""
        base = _safe_filename(unquote((qs.get("name") or [""])[0]), "cover")
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n) if n else b""
        if not data:
            self._send_json(400, {"ok": False, "error": "empty body"})
            return
        ext = ".png" if data[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"
        d = _tools_dir()
        for old_ext in (".png", ".jpg"):
            if old_ext != ext:
                try: os.remove(os.path.join(d, base + old_ext))
                except OSError: pass
        fn = base + ext
        with open(os.path.join(d, fn), "wb") as f:
            f.write(data)
        self._send_json(200, {"ok": True, "file": fn})

    def _handle_rename_cover(self):
        """工具改名时同步重命名封面文件。"""
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        old = _safe_filename(obj.get("old"), "")
        new = _safe_filename(obj.get("new"), "")
        if not old or not new:
            self._send_json(400, {"ok": False, "error": "old/new required"})
            return
        d = _tools_dir()
        moved = []
        for ext in (".png", ".jpg"):
            src = os.path.join(d, old + ext)
            if not os.path.isfile(src):
                continue
            for other in (".png", ".jpg"):
                if other != ext:
                    try: os.remove(os.path.join(d, new + other))
                    except OSError: pass
            os.replace(src, os.path.join(d, new + ext))
            moved.append(new + ext)
        self._send_json(200, {"ok": True, "files": moved})

    def _handle_save_tool(self):
        """把工具配置 JSON 写入 tools 目录，免去浏览器的目录授权。"""
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        fn = _safe_filename(obj.get("file"), "tool.rhtool.json")
        if not fn.lower().endswith(".json"):
            fn += ".rhtool.json"
        content = obj.get("content") or ""
        try:
            cfg = json.loads(content)
        except Exception:
            cfg = {}
        try:
            with open(os.path.join(_tools_dir(), fn), "w", encoding="utf-8") as f:
                f.write(content)
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})
            return
        # 改名时清理旧配置文件；同一应用只保留一份（按 webappId 兜底去重）
        removed = []
        old = obj.get("oldFile") or ""
        if old and old != fn:
            removed += self._remove_tool_files(old)
        removed += self._remove_duplicate_tools(fn, cfg)
        self._send_json(200, {"ok": True, "file": fn, "removed": removed})

    def _remove_tool_files(self, fn):
        """删除配置文件及其同名封面，返回被删除的文件名列表。"""
        fn = _safe_filename(fn, "")
        if not fn:
            return []
        d = _tools_dir()
        removed = []
        if os.path.isfile(os.path.join(d, fn)):
            try:
                os.remove(os.path.join(d, fn))
                removed.append(fn)
            except OSError:
                pass
            base = re.sub(r"\.rhtool\.json$", "", fn, flags=re.I)
            for ext in (".png", ".jpg"):
                try:
                    os.remove(os.path.join(d, base + ext))
                    removed.append(base + ext)
                except OSError:
                    pass
        return removed

    def _remove_duplicate_tools(self, keep_fn, cfg):
        """同一 webappId（缺失时按工具名）的其它配置视为旧版本删除。"""
        wid = str(cfg.get("webappId") or "").strip()
        name = str(cfg.get("name") or "").strip()
        if not wid and not name:
            return []
        d = _tools_dir()
        removed = []
        try:
            entries = os.listdir(d)
        except OSError:
            return []
        for fn in entries:
            if fn == keep_fn or not fn.lower().endswith(".rhtool.json"):
                continue
            try:
                with open(os.path.join(d, fn), encoding="utf-8") as f:
                    other = json.load(f)
            except Exception:
                continue
            same = (wid and str(other.get("webappId") or "").strip() == wid) or \
                   (name and str(other.get("name") or "").strip() == name)
            if same:
                removed += self._remove_tool_files(fn)
        return removed

    def _handle_delete_tool(self):
        obj = self._read_json_body()
        if obj is None:
            self._send_json(400, {"ok": False, "error": "invalid json"})
            return
        fn = _safe_filename(obj.get("file"), "")
        if fn:
            try: os.remove(os.path.join(_tools_dir(), fn))
            except OSError: pass
            # 永久删除工具时一并清理同名封面 tools/<基名>.png|jpg
            base = re.sub(r"\.rhtool\.json$", "", fn, flags=re.I)
            for ext in (".png", ".jpg"):
                try: os.remove(os.path.join(_tools_dir(), base + ext))
                except OSError: pass
        self._send_json(200, {"ok": True})

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
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            opener = urllib.request.build_opener(_NoRedirectHandler)
            with opener.open(req, timeout=120) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            self._send_json(200, {"ok": True, "path": path, "size": len(data),
                                  "url": "/downloads/" + quote(fname)})
        except Exception as e:
            self._send_json(500, {"ok": False, "error": str(e)})

    def _handle_appinfo(self):
        info = _load_appinfo()
        info["session"] = SESSION_ID
        info["token"] = ACCESS_TOKEN
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
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
