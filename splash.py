"""启动欢迎画面：无边框、置顶、居中，显示版本号与加载进度。

launcher.py 用法：
    ui = splash.Splash(version, image_path)
    ui.set_progress(0.3)   # 任意线程可调用（只改数值，不碰 Tk）
    ui.finish()            # 加载完成：进度走到 100%，停留 3 秒后淡出
    ui.abort()             # 立即关闭（出错或复用已有实例时）
    ui.run()               # 主线程事件循环，关闭后返回
"""
import os
import threading
import time

# 必须在导入 tkinter 之前声明 DPI 感知，否则高缩放下窗口会被系统拉伸、文字发虚
if os.name == "nt":
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import tkinter as tk

try:
    from PIL import Image, ImageTk
except Exception:  # Pillow 异常时退化为纯色背景，不影响启动
    Image = None

WIDTH, HEIGHT = 800, 600
MIN_SHOW_SECONDS = 1.4   # 最短展示时间，避免加载过快导致进度条一闪而过
HOLD_SECONDS = 3.0       # 进度到 100% 后的停留时间
TICK_MS = 30


class Splash:
    def __init__(self, version="", image_path=None):
        self.version = str(version or "").strip()
        self._lock = threading.Lock()
        self._target = 0.05
        self._finish_requested = False
        self._abort = False
        self._current = 0.0
        self._closing = False
        self._full_since = None
        self._shown_at = time.monotonic()
        self._root = None
        self._canvas = None
        self._photo = None
        self._track_id = None
        self._fill_id = None
        self._pct_id = None
        self._bar = (0, 0, 0, 0)
        self._build(image_path)

    # ---------- 对外接口（线程安全：只写状态） ----------
    def set_progress(self, value):
        try:
            value = max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return
        with self._lock:
            self._target = max(self._target, value)

    def finish(self):
        with self._lock:
            self._finish_requested = True

    def abort(self):
        with self._lock:
            self._abort = True

    def close_now(self):
        """立即关闭（主线程调用，用于复用已有实例等无需展示的场景）。"""
        self.abort()
        if self._root is not None and threading.current_thread() is threading.main_thread():
            self._destroy()

    def run(self):
        if self._root is not None:
            self._root.mainloop()

    # ---------- 界面构建 ----------
    def _build(self, image_path):
        root = tk.Tk()
        try:
            root.overrideredirect(True)          # 去掉窗口边框与标题栏
            root.attributes("-topmost", True)    # 始终置顶
            screen_w = root.winfo_screenwidth()
            screen_h = root.winfo_screenheight()
            x = max(0, (screen_w - WIDTH) // 2)
            y = max(0, (screen_h - HEIGHT) // 2)
            root.geometry("%dx%d+%d+%d" % (WIDTH, HEIGHT, x, y))
            root.configure(bg="#12351c")

            canvas = tk.Canvas(root, width=WIDTH, height=HEIGHT, bg="#1b5e20",
                               highlightthickness=0, bd=0)
            canvas.pack(fill="both", expand=True)
            if image_path and Image is not None and os.path.isfile(image_path):
                try:
                    img = Image.open(image_path).convert("RGB")
                    img = img.resize((WIDTH, HEIGHT), Image.LANCZOS)
                    self._photo = ImageTk.PhotoImage(img)
                    canvas.create_image(0, 0, anchor="nw", image=self._photo)
                except Exception:
                    self._photo = None
                    self._draw_fallback(canvas)
            else:
                self._draw_fallback(canvas)

            self._draw_version(canvas)
            self._draw_progress(canvas)

            root.update_idletasks()
            root.deiconify()
            root.lift()
        except Exception:
            try:
                root.destroy()
            except Exception:
                pass
            raise
        self._root = root
        self._canvas = canvas
        root.after(TICK_MS, self._tick)

    def _draw_fallback(self, canvas):
        canvas.configure(bg="#2e7d32")
        canvas.create_text(WIDTH // 2, HEIGHT // 2 - 40, text="RunningHub AI设计师工具箱",
                           font=("Microsoft YaHei", 30, "bold"), fill="#ffffff")
        canvas.create_text(WIDTH // 2, HEIGHT // 2 + 20, text="马特出品",
                           font=("Microsoft YaHei", 18), fill="#eaffd6")

    def _draw_version(self, canvas):
        if not self.version:
            return
        text = "v" + self.version
        font = ("Microsoft YaHei", 12, "bold")
        # 文字下方加版本号：先画阴影再画正文，保证浅色背景上清晰
        canvas.create_text(WIDTH // 2 + 1, 373, text=text, font=font, fill="#1c3b1c")
        canvas.create_text(WIDTH // 2, 372, text=text, font=font, fill="#ffffff")

    def _draw_progress(self, canvas):
        left, right = WIDTH // 2 - 280, WIDTH // 2 + 280
        cy = 518
        self._bar = (left, cy, right, cy)
        # 轨道用圆头线条，天然带圆角；Tk 不支持透明色，用较深实色近似
        self._track_id = canvas.create_line(left, cy, right, cy, width=10,
                                            capstyle=tk.ROUND, fill="#2f6b3c")
        self._fill_id = canvas.create_line(left, cy, left + 1, cy, width=10,
                                           capstyle=tk.ROUND, fill="#eaffc9")
        self._pct_id = canvas.create_text(WIDTH // 2, 545, text="正在加载… 0%",
                                          font=("Microsoft YaHei", 10), fill="#f2ffe0")

    # ---------- 动画 ----------
    def _tick(self):
        if self._root is None or self._closing:
            return
        with self._lock:
            target = self._target
            finish_requested = self._finish_requested
            abort = self._abort
        if abort:
            self._destroy()
            return

        elapsed = time.monotonic() - self._shown_at
        if finish_requested and elapsed >= MIN_SHOW_SECONDS:
            target = 1.0

        cur = self._current
        step = (target - cur) * 0.16
        if target > cur:
            step = max(step, 0.005)
        cur = min(target, cur + step)
        self._current = cur
        self._paint(cur)

        if cur >= 0.999:
            if self._full_since is None:
                self._full_since = time.monotonic()
            elif time.monotonic() - self._full_since >= HOLD_SECONDS:
                self._destroy()
                return
        self._root.after(TICK_MS, self._tick)

    def _paint(self, progress):
        left, cy, right, _ = self._bar
        width = max(1, int((right - left) * progress))
        self._canvas.coords(self._fill_id, left, cy, left + width, cy)
        self._canvas.itemconfig(self._pct_id, text="正在加载… %d%%" % int(progress * 100))

    def _destroy(self):
        self._closing = True
        root = self._root
        self._root = None
        if root is None:
            return
        try:
            root.quit()
        except Exception:
            pass
        try:
            root.destroy()
        except Exception:
            pass
