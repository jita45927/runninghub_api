// ================= 状态与存储层 =================
// localStorage（带损坏兜底）+ IndexedDB（记住目录/文件句柄）+ 跨模块共享的可变状态
import { LS, DEFAULT_TOOLS } from "./config.js";

// 跨模块共享状态（简单可变对象，各模块直接读写）
export const state = {
  tools: [],             // 全部工具配置
  activeId: null,        // 当前选中工具 id
  fieldFiles: {},        // 当前工具各图片字段已选的 File 对象（指向 fieldFilesByTool[当前工具id]）
  fieldFilesByTool: {},  // 每个工具各自的已选图片，切换工具后保留
  toolResults: {},       // 每个工具各自的生成结果（按工具 id 隔离）
  currentRun: null,      // 当前运行中的任务 {taskId, cancelled}
  runningToolId: null,   // 当前运行中任务所属的工具 id（用于阻止删除运行中的工具）
  dirHandle: null,       // 自定义下载目录句柄
  lastImgHandle: null,   // 上次选图所在位置（用于 showOpenFilePicker 的 startIn）
  toolsDirHandle: null,  // 配置目录（tools/）句柄，授权后 tools 目录成为工具配置唯一数据源
  toolFileNames: {},     // 工具 id → 配置目录中的文件名（用于改名时删除旧文件）
  collapsedCats: [],     // 左侧栏中被收起的分类名
};

// localStorage 数据损坏时回退到默认示例工具，避免页面白屏
let loadedTools = DEFAULT_TOOLS;
try {
  const rawTools = JSON.parse(localStorage.getItem(LS.tools) || "null");
  if (Array.isArray(rawTools)) loadedTools = rawTools;
} catch (e) { /* 存储数据损坏，使用默认示例 */ }
// 修正缺失 id 的工具（配置文件可能不带 id）
loadedTools.forEach((t, i) => { if (!t.id) t.id = "t" + Date.now() + "_" + i; });
// 去重：同应用ID或同名的工具只保留第一个（清理历史遗留的重复项）
state.tools = loadedTools.filter((t, i) =>
  loadedTools.findIndex(x => (t.webappId && x.webappId === t.webappId) || (t.name && x.name === t.name)) === i);

try { state.activeId = localStorage.getItem(LS.active) || (state.tools[0] && state.tools[0].id); }
catch (e) { state.activeId = state.tools[0] && state.tools[0].id; }
if (!state.tools.some(t => t.id === state.activeId)) state.activeId = state.tools[0] && state.tools[0].id;  // 修正失效的选中状态

export function saveTools() { localStorage.setItem(LS.tools, JSON.stringify(state.tools)); }
export function saveActiveId() { localStorage.setItem(LS.active, state.activeId || ""); }
export function activeTool() { return state.tools.find(t => t.id === state.activeId); }

// 分类收起状态持久化
try { state.collapsedCats = JSON.parse(localStorage.getItem("rhtool_cats_v1") || "[]"); }
catch (e) { state.collapsedCats = []; }
export function saveCats() { localStorage.setItem("rhtool_cats_v1", JSON.stringify(state.collapsedCats)); }

// ================= 极简 IndexedDB 封装，用于记住用户选择的目录/文件位置 =================
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("rhtool", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(v, k);
    tx.oncomplete = res; tx.onerror = rej;
  });
}
export async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction("kv").objectStore("kv").get(k);
    q.onsuccess = () => res(q.result); q.onerror = rej;
  });
}

// 直接写入所选目录（不弹保存框）
export async function saveToDir(dirHandle, name, blob) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}
