// ================= 工具封面：tools/<配置基名>.png|jpg =================
// 索引优先从已授权的 tools 目录读取；未授权时回退到 HTTP 目录列表或约定路径
import { state } from "./store.js";
import { toolsDirGranted, toolBaseName } from "./tools.js";
import { localFetch } from "./api.js";

const IMG_RE = /\.(png|jpe?g)$/i;
const MAX_COVER_SIZE = 8 * 1024 * 1024;
const COVER_WIDTH = 600;    // 封面统一输出尺寸（3:4，与首页卡片比例一致）
const COVER_HEIGHT = 800;

let coverMap = new Map();  // 基名小写 → { name, url, objectUrl }
let refreshSeq = 0;        // 防止并发刷新时旧结果覆盖新结果

function revokeMap(map) {
  map.forEach(item => { if (item.objectUrl) URL.revokeObjectURL(item.objectUrl); });
}

// 重建封面索引：已授权目录 → HTTP 目录列表 → 空索引（首页显示图标占位）
export async function refreshCoverIndex() {
  const seq = ++refreshSeq;
  const next = new Map();
  let ready = false;
  const dh = state.toolsDirHandle;

  if (dh && await toolsDirGranted()) {
    try {
      for await (const [name, handle] of dh.entries()) {
        if (handle.kind !== "file" || !IMG_RE.test(name)) continue;
        try {
          const objectUrl = URL.createObjectURL(await handle.getFile());
          next.set(name.replace(IMG_RE, "").toLowerCase(), { name, url: objectUrl, objectUrl });
        } catch (e) { /* 单个封面读取失败不影响其余 */ }
      }
      ready = true;
    } catch (e) { /* 句柄失效，退回 HTTP 目录列表 */ }
  }
  if (!ready && location.protocol.startsWith("http")) {
    try {
      const html = await (await fetch("tools/")).text();
      for (const m of html.matchAll(/href="([^"]+)"/gi)) {
        const name = decodeURIComponent(m[1]).split("/").pop();
        if (!IMG_RE.test(name)) continue;
        next.set(name.replace(IMG_RE, "").toLowerCase(), { name, url: "tools/" + encodeURIComponent(name) });
      }
      ready = true;
    } catch (e) { /* 目录不可列时保留空索引，首页显示图标占位 */ }
  }

  if (seq !== refreshSeq) { revokeMap(next); return; }  // 已有更新的刷新在进行
  revokeMap(coverMap);
  coverMap = next;
}

// 首次绘制时索引尚未建立，先显示占位；showHomeView 刷新索引后会重绘真实封面
export function coverUrlFor(toolName) {
  const base = toolBaseName({ name: toolName });
  const hit = coverMap.get(base.toLowerCase());
  return hit ? hit.url : null;
}

// 居中裁剪为 3:4 并缩放到固定尺寸，避免大图直接作为封面造成显示压力
async function normalizeCover(file) {
  const ext = file.type === "image/png" ? ".png" : ".jpg";
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { throw new Error("图片解析失败，请换一张 PNG / JPG 图片"); }

  const targetRatio = COVER_WIDTH / COVER_HEIGHT;
  let sw = bmp.width;
  let sh = bmp.height;
  if (sw / sh > targetRatio) sw = Math.round(sh * targetRatio);
  else sh = Math.round(sw / targetRatio);
  const sx = Math.round((bmp.width - sw) / 2);
  const sy = Math.round((bmp.height - sh) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = COVER_WIDTH;
  canvas.height = COVER_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (mime === "image/jpeg") {  // JPEG 无透明通道，先铺白底避免透明区域变黑
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, COVER_WIDTH, COVER_HEIGHT);
  if (bmp.close) bmp.close();

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("封面处理失败，请换一张图片")), mime, 0.88));
  return { blob, ext };
}

// 同一个文件只处理一次：预览与保存共用结果
const normalizedCache = new WeakMap();
function getNormalized(file) {
  let task = normalizedCache.get(file);
  if (!task) {
    task = normalizeCover(file);
    normalizedCache.set(file, task);
  }
  return task;
}

// 按最终裁剪效果生成预览地址（调用方负责 revoke）
export async function coverPreviewUrl(file) {
  const { blob } = await getNormalized(file);
  return URL.createObjectURL(blob);
}

// 保存封面到 tools 目录：优先由本地服务直接写入，未启动服务时才需要目录句柄授权
export async function saveCover(toolName, file) {
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("封面仅支持 PNG 或 JPG 图片");
  if (file.size > MAX_COVER_SIZE) throw new Error("封面图片不能超过 8MB");

  const { blob, ext } = await getNormalized(file);
  const base = toolBaseName({ name: toolName });
  let savedName = null;

  // 本地服务模式：POST /save-cover，浏览器无需任何文件夹授权
  if (location.protocol.startsWith("http")) {
    try {
      const r = await localFetch("/save-cover?name=" + encodeURIComponent(base), { method: "POST", body: blob });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.file) savedName = j.file;
      }
    } catch (e) { /* 旧版服务没有该接口，退回目录句柄 */ }
  }

  if (!savedName) {
    if (!(await toolsDirGranted())) throw new Error("保存封面失败：请用「启动工具.bat」启动新版服务，或在「初始设置」里授权工具配置目录");
    const dh = state.toolsDirHandle;
    // 同名的另一扩展名旧封面会导致索引冲突，先删除
    for (const oldExt of [".png", ".jpg"]) {
      if (oldExt === ext) continue;
      try { await dh.removeEntry(base + oldExt); } catch (e) { /* 旧文件不存在 */ }
    }
    const fh = await dh.getFileHandle(base + ext, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    savedName = base + ext;
  }

  const key = base.toLowerCase();
  const prev = coverMap.get(key);
  if (prev && prev.objectUrl) URL.revokeObjectURL(prev.objectUrl);
  const objectUrl = URL.createObjectURL(blob);
  coverMap.set(key, { name: savedName, url: objectUrl, objectUrl });
  return savedName;
}

// 工具改名时同步重命名封面文件；没有封面时静默返回 null
export async function renameCover(oldToolName, newToolName) {
  const oldBase = toolBaseName({ name: oldToolName });
  const newBase = toolBaseName({ name: newToolName });
  if (!oldBase || oldBase === newBase) return null;
  // Windows 文件系统不区分大小写，仅大小写不同的改名不处理，避免误删同一个文件
  if (oldBase.toLowerCase() === newBase.toLowerCase()) return null;

  // 本地服务模式：由 server 直接重命名文件
  if (location.protocol.startsWith("http")) {
    try {
      const r = await localFetch("/rename-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old: oldBase, new: newBase })
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) return j.files && j.files.length ? j.files[0] : null;
        return null;
      }
    } catch (e) { /* 旧版服务没有该接口，退回目录句柄 */ }
  }

  if (!(await toolsDirGranted())) return null;

  const dh = state.toolsDirHandle;
  for (const ext of [".png", ".jpg"]) {
    let file;
    try { file = await (await dh.getFileHandle(oldBase + ext)).getFile(); }
    catch (e) { continue; }  // 该扩展名没有封面，试下一个
    // 新基名已存在另一扩展名的封面时先清掉，避免同时存在两张
    for (const otherExt of [".png", ".jpg"]) {
      if (otherExt === ext) continue;
      try { await dh.removeEntry(newBase + otherExt); } catch (e) { /* 不存在 */ }
    }
    const fh = await dh.getFileHandle(newBase + ext, { create: true });
    const w = await fh.createWritable();
    await w.write(file);
    await w.close();
    try { await dh.removeEntry(oldBase + ext); } catch (e) { /* 旧文件不存在 */ }
    return newBase + ext;
  }
  return null;
}
