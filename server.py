# 本地开发服务器：禁止一切缓存，保证浏览器永远拿到最新代码
# 扩展路由：
#   /appinfo            → 返回 {tools, download} 目录绝对路径
#   /open-dir?path=...  → 调起 Windows 资源管理器打开指定目录
#   /pick-download-dir  → 弹系统 FolderBrowserDialog 让用户选下载目录，写回 appinfo.txt 第二行
import http.server, os, sys, json, locale, subprocess, shlex
from urllib.parse import urlparse, parse_qs, unquote

os.chdir(os.path.dirname(os.path.abspath(__file__)))

APPINFO = "appinfo.txt"

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
        + (f"$d.SelectedPath = '{start_hint}'; " if start_hint else "") +
        "$r = $d.ShowDialog($owner); "
        "if ($r -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }; "
        "$owner.Close(); $owner.Dispose()"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True, text=True, timeout=120,
            encoding="utf-8", errors="replace",
        )
        path = result.stdout.strip()
        return path
    except subprocess.TimeoutExpired:
        return ""
    except Exception as e:
        print("[server] FolderBrowserDialog error: " + str(e), file=sys.stderr)
        return ""

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/appinfo":
            self._handle_appinfo()
        elif parsed.path == "/open-dir":
            self._handle_open_dir(parse_qs(parsed.query))
        elif parsed.path == "/pick-download-dir":
            self._handle_pick_download_dir(parse_qs(parsed.query))
        else:
            super().do_GET()

    def _handle_appinfo(self):
        info = _load_appinfo()
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
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8900

try:
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
except KeyboardInterrupt:
    sys.exit(0)
