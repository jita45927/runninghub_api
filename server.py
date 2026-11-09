# 本地开发服务器：禁止一切缓存，保证浏览器永远拿到最新代码
import http.server, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, *args):
        pass  # 静默日志

try:
    http.server.ThreadingHTTPServer(("127.0.0.1", 8899), Handler).serve_forever()
except KeyboardInterrupt:
    sys.exit(0)
