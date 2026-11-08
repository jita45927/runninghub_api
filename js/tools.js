// ================= 工具配置：导入 / 导出 / tools 目录自动扫描 =================
import { state, saveTools, saveActiveId } from "./store.js";
import { showStatus } from "./ui/form.js";

// 导出工具为一个 .json 配置文件（不含 API Key）
export function exportToolConfig(t) {
  const data = {
    type: "runninghub-tool-config",
    version: 1,
    name: t.name, icon: t.icon, desc: t.desc, toolType: t.toolType || "app",
    webappId: t.webappId, instanceType: t.instanceType, fields: t.fields
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (t.name || "tool") + ".rhtool.json";
  a.click();
  URL.revokeObjectURL(a.href);
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
    } catch (err) {
      alert("导入失败：" + err.message);
    }
  };
  reader.readAsText(file);
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
      // 同应用ID或同名视为同一工具：以文件内容为准更新（保证 tools 目录是权威配置）
      const idx = state.tools.findIndex(x => (t.webappId && x.webappId === t.webappId) || (t.name && x.name === t.name));
      if (idx >= 0) { state.tools[idx] = { ...t, id: state.tools[idx].id }; }
      else { state.tools.push(t); }
      changed = true;
    }
    if (changed) { saveTools(); renderAll(); }
  } catch (e) { /* tools 目录不存在或为空时忽略 */ }
}
