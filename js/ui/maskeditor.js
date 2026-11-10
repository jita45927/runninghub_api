// ================= 蒙版编辑器：涂抹生成 alpha 遮罩（对齐 ComfyUI MaskEditor） =================
// 原理：ComfyUI 的 LoadImage 会把图片 alpha 通道反转为 MASK，
// 因此导出"涂抹区域透明"的 PNG，即可用同一张图同时提供 image 和 mask 两个输出。

const HINT = "左键涂抹（颜色仅为预览；保存时按「绘制到图片层」决定是否把蒙版按颜色叠加进图片）· 中键/右键拖动平移 · 滚轮缩放";

let stage, canvas, ctx, cursorEl;
let maskCanvas, maskCtx;   // 唯一涂抹层（原图分辨率）：颜色或蒙版共用同一份笔画数据
let strokeCanvas, strokeCtx;  // 当前笔画层（硬边）
let blurCanvas, blurCtx;      // 羽化后的当前笔画层（用于预览与合并）
let img = null;
let strokes = [];          // 笔画列表（撤销时整层重绘）
let scale = 1, offX = 0, offY = 0;
let brushSize = 40, erasing = false, feather = 0;
let paintMode = false, exportMask = true, strokeColor = "#ff3333";
let drawing = false, panning = false, panOrigin = null, curStroke = null, lastPt = null;
let onSaveCb = null;
let ready = false;
// 同一张图片再次打开编辑器时恢复上次涂抹的蒙版（key 由调用方提供，如工具ID_字段序号）
const maskCache = new Map();
let currentKey = null;

const $ = id => document.getElementById(id);

// ================= 初始化 DOM 事件（只执行一次） =================
function init() {
  if (ready) return;
  ready = true;
  stage = $("meStage");
  canvas = $("meCanvas");
  ctx = canvas.getContext("2d");
  cursorEl = $("meCursor");

  $("meBrush").onclick = () => { erasing = false; syncTools(); };
  $("meErase").onclick = () => { erasing = true; syncTools(); };
  $("meUndo").onclick = undo;
  $("meClear").onclick = () => { strokes = []; redrawMask(); render(); };
  $("meSize").oninput = e => {
    brushSize = +e.target.value;
    $("meSizeVal").textContent = brushSize + "px";
    applyCursorSize();
  };
  $("meFeather").oninput = e => {
    feather = +e.target.value;
    $("meFeatherVal").textContent = feather + "%";
    // 羽化程度改变时刷新当前笔画预览
    if (drawing && curStroke) { curStroke.feather = feather; strokeToPreview(curStroke); render(); }
  };
  $("meSave").onclick = saveMask;
  $("mePaintMode").onclick = () => {
    paintMode = !paintMode;
    syncModeUI();
    redrawMask();  // 同一份笔画按新模式重新上色
    render();
  };
  document.querySelectorAll("#meColors .me-color").forEach(b => {
    b.onclick = () => {
      strokeColor = b.dataset.color;
      syncModeUI();
      redrawMask();  // 统一换色：之前画过的区域也变成新颜色
      render();
    };
  });
  $("meExportMask").onchange = e => { exportMask = e.target.checked; };
  $("meCancel").onclick = close;

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerleave", () => { if (cursorEl) cursorEl.style.display = "none"; });
  canvas.addEventListener("contextmenu", e => e.preventDefault());

  window.addEventListener("resize", () => {
    if (!$("maskEditor").classList.contains("show")) return;
    resizeCanvas();
    render();
  });
  document.addEventListener("keydown", e => {
    if (!$("maskEditor").classList.contains("show")) return;
    if (e.key === "Escape") close();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if (e.key === "b" || e.key === "B") { erasing = false; syncTools(); }
    else if (e.key === "e" || e.key === "E") { erasing = true; syncTools(); }
    else if (e.key === "[") adjustSize(-8);
    else if (e.key === "]") adjustSize(8);
  });
}

function syncTools() {
  $("meBrush").classList.toggle("active", !erasing);
  $("meErase").classList.toggle("active", erasing);
  canvas.style.cursor = "none";
  if (cursorEl) cursorEl.classList.toggle("erase", erasing);
}

// 同步「绘制到图片层 / 颜色 / 输出蒙版」的界面状态
function syncModeUI() {
  $("mePaintMode").classList.toggle("active", paintMode);
  $("meExportMask").checked = exportMask;
  document.querySelectorAll("#meColors .me-color").forEach(b => {
    b.classList.toggle("active", b.dataset.color === strokeColor);
  });
}

// 圆形笔刷光标：跟随鼠标并反映当前笔刷直径
function updateCursor(e) {
  if (!cursorEl) return;
  if (panning || !img || e.pointerType === "touch") { cursorEl.style.display = "none"; return; }
  const r = stage.getBoundingClientRect();
  cursorEl.style.display = "block";
  cursorEl.style.left = (e.clientX - r.left) + "px";
  cursorEl.style.top = (e.clientY - r.top) + "px";
  applyCursorSize();
}

function applyCursorSize() {
  if (!cursorEl) return;
  cursorEl.style.width = brushSize + "px";
  cursorEl.style.height = brushSize + "px";
}

// 工具栏底部提示：短暂显示错误/状态信息
function flash(msg) {
  const h = $("meHint");
  if (!h) return;
  h.textContent = "⚠️ " + msg;
  h.classList.add("warn");
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { h.textContent = HINT; h.classList.remove("warn"); }, 2600);
}

function adjustSize(d) {
  brushSize = Math.min(200, Math.max(4, brushSize + d));
  $("meSize").value = brushSize;
  $("meSizeVal").textContent = brushSize + "px";
  applyCursorSize();
}

// 换图时清除该字段的蒙版记忆
export function clearMaskCache(key) {
  if (key) maskCache.delete(key);
}

// ================= 打开编辑器 =================
export async function openMaskEditor(file, onSave, cacheKey) {
  init();
  if (!file) { flash("请先选择图片"); return; }
  onSaveCb = onSave;
  currentKey = cacheKey || null;
  $("maskEditor").classList.add("show");

  try {
    img = await loadImage(file);
  } catch (e) {
    $("maskEditor").classList.remove("show");
    alert("图片加载失败：" + e.message);
    return;
  }

  maskCanvas = document.createElement("canvas");
  maskCanvas.width = img.naturalWidth;
  maskCanvas.height = img.naturalHeight;
  maskCtx = maskCanvas.getContext("2d");

  // 当前笔画的硬边层 + 羽化层（原图分辨率）
  strokeCanvas = document.createElement("canvas");
  strokeCanvas.width = img.naturalWidth;
  strokeCanvas.height = img.naturalHeight;
  strokeCtx = strokeCanvas.getContext("2d");
  blurCanvas = document.createElement("canvas");
  blurCanvas.width = img.naturalWidth;
  blurCanvas.height = img.naturalHeight;
  blurCtx = blurCanvas.getContext("2d");

  strokes = [];
  paintMode = false;
  exportMask = true;      // 「输出蒙版」默认打开
  strokeColor = "#ff3333";
  // 恢复上次保存的蒙版笔画与呈现方式（换图片时由调用方清除缓存）
  const cached = currentKey ? maskCache.get(currentKey) : null;
  if (cached) {
    strokes = cached.strokes.map(s => ({ ...s, points: s.points.slice() }));
    paintMode = !!cached.paintMode;
    exportMask = !!cached.exportMask;
    strokeColor = cached.strokeColor || "#ff3333";
  }
  redrawMask();
  erasing = false;
  syncTools();
  syncModeUI();
  $("meSize").value = brushSize;
  $("meSizeVal").textContent = brushSize + "px";
  resizeCanvas();
  resetView();
  render();
}

function close() {
  $("maskEditor").classList.remove("show");
  if (cursorEl) cursorEl.style.display = "none";
  currentKey = null;
  img = null;
  strokes = [];
  maskCanvas = null;
  maskCtx = null;
  strokeCanvas = null;
  strokeCtx = null;
  blurCanvas = null;
  blurCtx = null;
  onSaveCb = null;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法解析图片")); };
    im.src = url;
  });
}

// ================= 画布尺寸与视图变换 =================
function resizeCanvas() {
  const r = stage.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width));
  canvas.height = Math.max(1, Math.floor(r.height));
}

function resetView() {
  if (!img) return;
  const k = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight) * 0.96;
  scale = k > 0 ? k : 1;
  offX = (canvas.width - img.naturalWidth * scale) / 2;
  offY = (canvas.height - img.naturalHeight * scale) / 2;
  updateZoomLabel();
}

function updateZoomLabel() {
  $("meZoomVal").textContent = Math.round(scale * 100) + "%";
}

function render() {
  if (!img) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, offX, offY);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0);
  if (maskCanvas) {  // 同一份笔画：开启「绘制到图片层」时不透明显示（即输出效果），关闭时半透明预览
    ctx.globalAlpha = paintMode ? 1 : 0.55;
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  if (drawing && curStroke && blurCanvas) {
    ctx.globalAlpha = paintMode ? 1 : 0.55;
    ctx.drawImage(blurCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
}

// 屏幕坐标 → 原图坐标
function toImgPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left - offX) / scale,
    y: (e.clientY - r.top - offY) / scale
  };
}

// ================= 笔画绘制与撤销 =================
// 把一条笔画的硬边路径画到笔画层（不直接落到蒙版层）
function paintStrokePath(s) {
  strokeCtx.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
  strokeCtx.save();
  // 所有笔画共用当前选中的颜色：切换颜色后既有笔画也会一起变色（橡皮用黄色提示）
  strokeCtx.strokeStyle = s.erase ? "#ffd166" : strokeColor;
  strokeCtx.fillStyle = strokeCtx.strokeStyle;
  strokeCtx.lineWidth = s.w;
  strokeCtx.lineCap = "round";
  strokeCtx.lineJoin = "round";
  const pts = s.points;
  if (pts.length === 1) {
    strokeCtx.beginPath();
    strokeCtx.arc(pts[0].x, pts[0].y, s.w / 2, 0, Math.PI * 2);
    strokeCtx.fill();
  } else {
    strokeCtx.beginPath();
    strokeCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) strokeCtx.lineTo(pts[i].x, pts[i].y);
    strokeCtx.stroke();
  }
  strokeCtx.restore();
}

// 羽化半径：羽化强度 0~100 映射为笔刷半径的一定比例
function blurRadius(s) {
  return Math.max(0, ((s.feather || 0) / 100) * (s.w / 2) * 0.9);
}

// 把当前笔画做羽化后放到预览层
function strokeToPreview(s) {
  if (!strokeCtx) return;
  paintStrokePath(s);
  const br = blurRadius(s);
  blurCtx.clearRect(0, 0, blurCanvas.width, blurCanvas.height);
  if (br > 0.4) {
    blurCtx.filter = `blur(${br}px)`;
    blurCtx.drawImage(strokeCanvas, 0, 0);
    blurCtx.filter = "none";
  } else {
    blurCtx.drawImage(strokeCanvas, 0, 0);
  }
}

// 笔画结束后合并进涂抹层
function commitStroke(s) {
  if (!maskCtx) return;
  strokeToPreview(s);
  maskCtx.save();
  maskCtx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
  maskCtx.drawImage(blurCanvas, 0, 0);
  maskCtx.restore();
}

function redrawMask() {
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  strokes.forEach(commitStroke);
}

function undo() {
  if (!strokes.length) return;
  strokes.pop();
  redrawMask();
  render();
}

// ================= 指针交互 =================
function onDown(e) {
  if (!img) return;
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || e.altKey) {  // 中键/右键/Alt+拖动 = 平移
    e.preventDefault();
    panning = true;
    panOrigin = { x: e.clientX, y: e.clientY, ox: offX, oy: offY };
    canvas.style.cursor = "grabbing";
    if (cursorEl) cursorEl.style.display = "none";
    return;
  }
  if (e.button !== 0) return;
  drawing = true;
  const p = toImgPoint(e);
  curStroke = {
    erase: erasing,
    w: Math.max(1, brushSize / scale),
    feather,
    points: [p]
  };
  lastPt = p;
  strokes.push(curStroke);
  strokeToPreview(curStroke);
  render();
}

function onMove(e) {
  updateCursor(e);
  if (panning && panOrigin) {
    offX = panOrigin.ox + (e.clientX - panOrigin.x);
    offY = panOrigin.oy + (e.clientY - panOrigin.y);
    render();
    return;
  }
  if (!drawing || !curStroke) return;
  const p = toImgPoint(e);
  curStroke.points.push(p);
  // 整条笔画重绘到预览层（羽化需要整体模糊，不能逐段叠加）
  strokeToPreview(curStroke);
  lastPt = p;
  render();
}

function onUp(e) {
  if (panning) {
    panning = false;
    panOrigin = null;
    canvas.style.cursor = "none";
    return;
  }
  if (drawing) {
    if (curStroke) commitStroke(curStroke);  // 落笔后合并进蒙版层
    drawing = false;
    curStroke = null;
    lastPt = null;
    render();
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
}

function onWheel(e) {
  if (!img) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const ix = (mx - offX) / scale, iy = (my - offY) / scale;
  const next = Math.min(16, Math.max(0.05, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  offX = mx - ix * next;
  offY = my - iy * next;
  scale = next;
  updateZoomLabel();
  render();
}

// ================= 保存：导出带 alpha 的 PNG（透明区域保留原始 RGB） =================
// 不能用 canvas.toBlob：浏览器对完全透明像素做预乘，RGB 会被清零，导致 image 里出现黑洞。
// 这里手工编码 PNG，只修改 alpha，RGB 原样保留。
async function saveMask() {
  if (!img) return;
  // 允许空蒙版保存：等价于清除蒙版、恢复原图

  const W = img.naturalWidth, H = img.naturalHeight;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const octx = out.getContext("2d", { willReadFrequently: true });
  octx.drawImage(img, 0, 0);
  // 蒙版层与图片层是同一份笔画数据：
  // · 开启「绘制到图片层」→ 输出图片 = 原图 + 按笔画颜色叠加的蒙版；
  // · 关闭 → 输出图片 = 原图（不上色）；
  // · 「输出蒙版」钩选时，把涂抹区域写成透明 alpha（ComfyUI 里即黑白 MASK）。
  if (paintMode && maskCanvas) octx.drawImage(maskCanvas, 0, 0);

  try {
    const src = octx.getImageData(0, 0, W, H);
    const d = src.data;
    if (exportMask) {
      const m = maskCtx.getImageData(0, 0, W, H).data;
      // 只把涂抹区域的 alpha 置 0（边缘按羽化/抗锯齿比例过渡），RGB 通道保持原样
      for (let i = 0; i < d.length; i += 4) {
        const cover = m[i + 3];
        if (cover > 0) d[i + 3] = Math.round(d[i + 3] * (255 - cover) / 255);
      }
    }
    const blob = await encodePNG(W, H, d);
    const file = new File([blob], "masked_" + Date.now() + ".png", { type: "image/png" });
    // 记住本次蒙版与呈现方式，下次打开同一字段时回显
    if (currentKey) maskCache.set(currentKey, {
      strokes: strokes.map(s => ({ ...s, points: s.points.slice() })),
      paintMode, exportMask, strokeColor
    });
    const cb = onSaveCb;
    close();
    if (cb) cb(file, { color: strokeColor, paintMode, exportMask });
  } catch (e) {
    flash("导出失败：" + e.message);
  }
}

// ================= 最小 PNG 编码器（RGBA，滤波类型 0，zlib 压缩） =================
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// 用浏览器原生 CompressionStream 生成 zlib 流（PNG 的 IDAT 要求 zlib 格式）
async function zlibDeflate(bytes) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("当前浏览器不支持 PNG 编码，请使用新版 Edge/Chrome");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePNG(width, height, rgba) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型：RGBA
  // 扫描线：每行前置一个滤波字节 0
  const rowLen = width * 4;
  const raw = new Uint8Array((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    raw.set(rgba.subarray(y * rowLen, (y + 1) * rowLen), y * (rowLen + 1) + 1);
  }
  const idat = await zlibDeflate(raw);
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG 签名
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0))
  ], { type: "image/png" });
}
