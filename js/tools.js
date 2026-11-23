// ================= 工具配置：导入 / 导出 / tools 目录自动扫描 =================
import { state, saveTools, saveActiveId, tagsOf } from "./store.js";
import { migrateSeedFields } from "./config.js";
import { showStatus } from "./ui/form.js";
import { localFetch } from "./api.js";

// 工具对象 → 配置文件 JSON（与导出/目录文件格式一致）
function toolToConfigJSON(t) {
  return JSON.stringify({
    type: "runninghub-tool-config",
    version: 1,
    name: t.name, icon: t.icon, desc: t.desc, sourceUrl: t.sourceUrl || "", toolType: t.toolType || "app",
    webappId: t.webappId, instanceType: t.instanceType, tags: tagsOf(t), fields: t.fields,
    // 回收站状态随配置文件持久化，重启后仍留在回收站
    ...(t.deleted ? { deleted: true } : {})
  }, null, 2);
}

// 导入配置文件：同应用ID或同名工具 → 更新而不是新增
export function importToolFile(file, renderAll) {
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data || !Array.isArray(data.fields)) throw new Error("文件格式不对");
      // 导入一律作为「我的工具」：只更新已有的用户工具，不覆盖系统工具
      const idx = state.tools.findIndex(x => toolSourceOf(x) !== "sys"
        && ((data.webappId && x.webappId === data.webappId) || (data.name && x.name === data.name)));
      const merged = {
        icon: data.icon || "🧩",
        name: data.name || file.name.replace(/\.rhtool\.json$/i, "").replace(/\.json$/i, ""),
        desc: data.desc || "",
        sourceUrl: data.sourceUrl || "",
        tags: tagsOf(data),
        webappId: data.webappId || "",
        toolType: data.toolType || "app",
        instanceType: data.instanceType || "default",
        fields: data.fields
      };
      migrateSeedFields(merged);  // 旧的 seed 数字字段升级为随机种子字段
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
      // 导入后写回 tools 目录（本地服务模式无需授权）
      const tool = idx >= 0 ? state.tools[idx] : merged;
      (async () => {
        try {
          const fn = await persistTool(tool);
          if (fn) showStatus("已导入并保存到我的工具目录/" + fn, "ok");
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
  state.toolSources = {};
  // 本地服务模式以 /tools-index 为唯一数据源，旧目录句柄不再参与
  if (location.protocol.startsWith("http")) {
    await scanToolsDir(renderAll);
    return state.tools.length > 0;
  }
  if (await toolsDirGranted()) {
    if (await loadToolsFromDir(renderAll)) return state.tools.length > 0;
  }
  await scanToolsDir(renderAll);
  renderAll();
  return state.tools.length > 0;
}

// ============ 本地服务器模式：按合并索引加载系统工具 + 我的工具 ============
// /tools-index 已处理：用户工具优先、同 webappId 隐藏系统原版、墓碑删除不返回
export async function scanToolsDir(renderAll) {
  if (!location.protocol.startsWith("http")) return;
  try {
    const r = await fetch("tools-index");
    if (!r.ok) return;
    const index = await r.json();
    if (!index || !Array.isArray(index.files)) return;

    // 同一配置文件保留原来的本地 id，避免选中状态/排序在刷新后跳变
    const prevIdByFile = new Map();
    state.tools.forEach(t => {
      const f = state.toolFileNames[t.id];
      if (f) prevIdByFile.set(f, t.id);
    });

    const nextTools = [];
    const nextNames = {};
    const nextSources = {};
    let n = 0;
    for (const entry of index.files) {
      const f = entry.file;
      let t;
      try {
        const resp = await fetch("tools/" + encodeURIComponent(f));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        t = await resp.json();
        if (!t || typeof t !== "object") throw new Error("配置格式不对");
      } catch (e) {
        showStatus("⚠️ 配置文件「" + f + "」损坏，已跳过加载", "error");  // 单个文件损坏不影响其余加载
        continue;
      }
      const id = prevIdByFile.get(f) || "t" + Date.now() + "_" + n++;
      t.id = id;
      t.tags = tagsOf(t);
      delete t.category;  // 旧版单值分类统一迁移为标签数组
      migrateSeedFields(t);  // 旧的 seed 数字字段升级为随机种子字段
      nextTools.push(t);
      nextNames[id] = f;  // 记录真实文件名，改名/删除时按它操作
      nextSources[id] = entry.source === "sys" ? "sys" : "user";
    }
    state.tools = nextTools;
    state.toolFileNames = nextNames;
    state.toolSources = nextSources;
    if (!state.tools.some(t => t.id === state.activeId)) {
      state.activeId = state.tools.length ? state.tools[0].id : null;
      saveActiveId();
    }
    saveTools();
    renderAll();
  } catch (e) { /* 旧版服务没有该接口时保持本地缓存 */ }
}

// 工具来源：sys（系统工具，随更新覆盖）| user（我的工具，永久保留）
export function toolSourceOf(tool) {
  return (tool && state.toolSources[tool.id] === "sys") ? "sys" : "user";
}

// 系统工具墓碑：删除/还原后刷新时保持一致
export async function setToolTombstone(webappId, deleted) {
  if (!webappId) return false;
  if (!location.protocol.startsWith("http")) return false;
  try {
    const r = await localFetch("/tool-tombstone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webappId, deleted: !!deleted })
    });
    return r.ok;
  } catch (e) { return false; }
}

// 复制为我的工具：系统工具配置与封面复制到 user_tools
export async function copyToolToUser(tool, renderAll) {
  if (!tool) return null;
  const file = state.toolFileNames[tool.id] || toolFileName(tool);
  try {
    const r = await localFetch("/copy-tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file })
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "复制失败");
    await scanToolsDir(renderAll);
    const newId = Object.keys(state.toolFileNames).find(id => state.toolFileNames[id] === j.file);
    if (newId) state.activeId = newId;
    saveActiveId();
    if (renderAll) renderAll();
    return j;
  } catch (e) {
    showStatus("复制为我的工具失败：" + e.message, "error");
    return null;
  }
}

// 重置系统工具：用安装包内 sys_tools.zip 恢复并清空墓碑
export async function resetSysTools(renderAll) {
  try {
    const r = await localFetch("/reset-sys-tools", { method: "POST" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || "重置失败");
    await resetToolsCache(renderAll);
    showStatus("系统工具已重置，恢复 " + (j.restored || 0) + " 个文件", "ok");
    return true;
  } catch (e) {
    showStatus("重置系统工具失败：" + e.message, "error");
    return false;
  }
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

// 配置文件基名（不含扩展名），封面图与它同名：tools/<基名>.png|jpg
export function toolBaseName(t) {
  return toolFileName(t).replace(/\.rhtool\.json$/i, "");
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
      migrateSeedFields(t);  // 旧的 seed 数字字段升级为随机种子字段
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

// ===== 统一持久化：本地服务可用时由 server 直接写 tools/，不再需要浏览器目录授权 =====
export async function persistTool(t) {
  if (!t) return null;
  if (location.protocol.startsWith("http")) {
    try {
      const file = toolFileName(t);
      const source = toolSourceOf(t);
      const r = await localFetch("/save-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, oldFile: state.toolFileNames[t.id] || "", source, content: toolToConfigJSON(t) })
      });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok) {
          state.toolFileNames[t.id] = j.file || file;  // 服务端可能已清理旧文件
          state.toolSources[t.id] = j.source === "sys" ? "sys" : "user";  // sys 不可写时服务端会降级
          return j.file || file;
        }
      }
    } catch (e) { /* 旧版服务没有该接口，退回目录句柄 */ }
  }
  if (await toolsDirGranted()) return writeToolToDir(t);
  return null;
}

// 删除工具配置文件：sys 由服务端写墓碑隐藏，user 直接删除
export async function removeToolFile(tool) {
  if (!tool) return false;
  if (location.protocol.startsWith("http")) {
    try {
      const r = await localFetch("/delete-tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: state.toolFileNames[tool.id] || toolFileName(tool), source: toolSourceOf(tool) })
      });
      if (r.ok) {
        delete state.toolFileNames[tool.id];
        return true;
      }
    } catch (e) { /* 旧版服务没有该接口，退回目录句柄 */ }
  }
  if (await toolsDirGranted()) {
    if (!state.toolFileNames[tool.id]) state.toolFileNames[tool.id] = toolFileName(tool);
    await deleteToolFromDir(tool.id);
    return true;
  }
  return false;
}
