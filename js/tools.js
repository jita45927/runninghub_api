// ================= 工具配置：导入 / 导出 / tools 目录自动扫描 =================
import { state, saveTools, saveActiveId, tagsOf } from "./store.js";
import { showStatus } from "./ui/form.js";

// 工具对象 → 配置文件 JSON（与导出/目录文件格式一致）
function toolToConfigJSON(t) {
  return JSON.stringify({
    type: "runninghub-tool-config",
    version: 1,
    name: t.name, icon: t.icon, desc: t.desc, toolType: t.toolType || "app",
    webappId: t.webappId, instanceType: t.instanceType, tags: tagsOf(t), fields: t.fields
  }, null, 2);
}

// 导入配置文件：同应用ID或同名工具 → 更新而不是新增
export function importToolFile(file, renderAll) {
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data || !Array.isArray(data.fields)) throw new Error("文件格式不对");
      const idx = state.tools.findIndex(x => (data.webappId && x.webappId === data.webappId) || (data.name && x.name === data.name));
      const merged = {
        icon: data.icon || "🧩",
        name: data.name || file.name.replace(/\.rhtool\.json$/i, "").replace(/\.json$/i, ""),
        desc: data.desc || "",
        tags: tagsOf(data),
        webappId: data.webappId || "",
        toolType: data.toolType || "app",
        instanceType: data.instanceType || "default",
        fields: data.fields
      };
      if (idx >= 0) {
        state.tools[idx] = { ...merged, id: state.tools[idx].id };
        state.activeId = state.tools[idx].id;
        showStatus("已更新现有工具「" + merged.name + "」", "ok");
      } else {
        merged.id = "t" + Date.now();
        state.tools.push(merged);
        state.activeId = merged.id;
      }
      saveTools();
      saveActiveId();
      renderAll();
      // 已授权配置目录时，导入的配置同时写入目录文件
      const tool = idx >= 0 ? state.tools[idx] : merged;
      (async () => {
        if (!(await toolsDirGranted())) return;
        try {
          const fn = await writeToolToDir(tool);
          showStatus("已导入并保存到 tools/" + fn, "ok");
        } catch (err) { showStatus("写入配置目录失败：" + err.message, "error"); }
      })();
    } catch (err) {
      alert("导入失败：" + err.message);
    }
  };
  reader.readAsText(file);
}

// 重置工具缓存：只清浏览器 localStorage 缓存，不删除任何配置文件
// 随后优先按已授权的配置目录重读，未授权则回退到服务器 tools/ 目录扫描
export async function resetToolsCache(renderAll) {
  try { localStorage.removeItem("tools"); } catch (e) {}
  state.tools = [];
  state.toolFileNames = {};
  if (await toolsDirGranted()) {
    if (await loadToolsFromDir(renderAll)) return state.tools.length > 0;
  }
  await scanToolsDir(renderAll);
  renderAll();
  return state.tools.length > 0;
}

// ============ 本地服务器模式：自动加载 tools 目录下所有配置文件 ============
// file:// 双击打开时浏览器禁止读目录，此逻辑不生效，仍需手动导入
export async function scanToolsDir(renderAll) {
  if (!location.protocol.startsWith("http")) return;
  try {
    const html = await (await fetch("tools/")).text();
    const files = [...html.matchAll(/href="([^"]+\.rhtool\.json)"/gi)]
      .map(m => decodeURIComponent(m[1]).split("/").pop());
    let changed = false;
    let n = 0;
    for (const f of files) {
      let t;
      try {
        t = await (await fetch("tools/" + encodeURIComponent(f))).json();
        if (!t || typeof t !== "object") throw new Error("配置格式不对");
      } catch (e) {
        showStatus("⚠️ 配置文件「" + f + "」损坏，已跳过加载", "error");  // 单个文件损坏不影响其余加载
        continue;
      }
      if (!t.id) t.id = "t" + Date.now() + "_" + n++;  // 配置文件没有 id 时自动补一个
      t.tags = tagsOf(t);
      delete t.category;  // 旧版单值分类统一迁移为标签数组
      // 同应用ID或同名视为同一工具：以文件内容为准更新（保证 tools 目录是权威配置）
      const idx = state.tools.findIndex(x => (t.webappId && x.webappId === t.webappId) || (t.name && x.name === t.name));
      if (idx >= 0) { state.tools[idx] = { ...t, id: state.tools[idx].id }; }
      else { state.tools.push(t); }
      changed = true;
    }
    if (changed) { saveTools(); renderAll(); }
  } catch (e) { /* tools 目录不存在或为空时忽略 */ }
}

// ============ 配置目录授权模式：File System Access API 直接读写 tools 目录 ============
// 授权后 tools 目录是工具配置的唯一数据源，localStorage 仅作缓存

// 配置目录句柄当前是否已有 readwrite 权限（不触发授权弹窗）
export async function toolsDirGranted() {
  const h = state.toolsDirHandle;
  if (!h || !window.showDirectoryPicker) return false;
  try { return (await h.queryPermission({ mode: "readwrite" })) === "granted"; }
  catch (e) { return false; }
}

// 工具对应的配置文件名（替换文件系统不允许的字符，中文等 Unicode 字符直接保留）
export function toolFileName(t) {
  return String(t.name || "未命名工具").replace(/[\\/:*?"<>|]/g, "_") + ".rhtool.json";
}

// 遍历配置目录句柄读取全部 *.rhtool.json（文件内容为准，替代 HTTP 目录扫描）
export async function loadToolsFromDir(renderAll) {
  const dh = state.toolsDirHandle;
  if (!dh) return false;
  let changed = false;
  let n = 0;
  try {
    for await (const [name, handle] of dh.entries()) {
      if (handle.kind !== "file" || !/\.rhtool\.json$/i.test(name)) continue;
      let t;
      try {
        t = JSON.parse(await (await handle.getFile()).text());
        if (!t || typeof t !== "object" || !Array.isArray(t.fields)) throw new Error("配置格式不对");
      } catch (e) {
        showStatus("⚠️ 配置文件「" + name + "」损坏，已跳过加载", "error");  // 单个文件损坏不影响其余加载
        continue;
      }
      // 同应用ID或同名视为同一工具：以文件内容为准更新，并记住 id → 文件名映射
      t.tags = tagsOf(t);
      delete t.category;  // 旧版单值分类统一迁移为标签数组
      const idx = state.tools.findIndex(x => (t.webappId && x.webappId === t.webappId) || (t.name && x.name === t.name));
      if (idx >= 0) { t.id = state.tools[idx].id; state.tools[idx] = t; }
      else { t.id = "t" + Date.now() + "_" + n++; state.tools.push(t); }
      state.toolFileNames[t.id] = name;
      changed = true;
    }
  } catch (e) { return false; }  // 句柄失效等情况，调用方回退 HTTP 扫描
  if (changed) { saveTools(); renderAll(); }
  return true;
}

// 把工具配置写回目录文件；改名导致文件名变化时删除旧文件，返回写入的文件名
export async function writeToolToDir(t) {
  const dh = state.toolsDirHandle;
  if (!dh) return null;
  const fileName = toolFileName(t);
  const oldName = state.toolFileNames[t.id];
  const fh = await dh.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(toolToConfigJSON(t));
  await w.close();
  if (oldName && oldName !== fileName) {
    try { await dh.removeEntry(oldName); } catch (e) { /* 旧文件已不存在 */ }
  }
  state.toolFileNames[t.id] = fileName;
  return fileName;
}

// 删除工具对应的目录文件
export async function deleteToolFromDir(toolId) {
  const dh = state.toolsDirHandle;
  const name = state.toolFileNames[toolId];
  if (!dh || !name) return;
  try { await dh.removeEntry(name); } catch (e) { /* 文件已不存在 */ }
  delete state.toolFileNames[toolId];
}
