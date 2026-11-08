// ================= 左侧工具列表 =================
import { state, saveTools, saveActiveId } from "../store.js";
import { toolsDirGranted, deleteToolFromDir } from "../tools.js";
import { showStatus } from "./form.js";

export function renderToolList(renderAll) {
  const list = document.getElementById("toolList");
  list.innerHTML = "";
  state.tools.forEach(t => {
    const configured = t.webappId && t.fields && t.fields.length && t.fields.every(f => f.nodeId);
    const el = document.createElement("div");
    el.className = "tool-item" + (t.id === state.activeId ? " active" : "");
    // 用 DOM/textContent 构建，避免工具配置里的恶意文本注入 HTML
    const iconEl = document.createElement("div");
    iconEl.className = "tool-icon";
    iconEl.textContent = t.icon || "🧩";
    const metaEl = document.createElement("div");
    metaEl.className = "tool-meta";
    const nameEl = document.createElement("div");
    nameEl.className = "tool-name";
    nameEl.textContent = t.name || "未命名";
    const descEl = document.createElement("div");
    descEl.className = "tool-desc";
    descEl.textContent = t.desc || "";
    const statusEl = document.createElement("div");
    statusEl.className = "tool-status" + (configured ? " ok" : "");
    statusEl.textContent = configured ? "● 已配置" : "○ 待配置";
    metaEl.append(nameEl, descEl, statusEl);
    const delEl = document.createElement("div");
    delEl.className = "tool-del";
    delEl.title = "删除此工具";
    delEl.textContent = "✕";
    el.append(iconEl, metaEl, delEl);
    delEl.onclick = async e => {
      e.stopPropagation();
      if (state.currentRun && state.runningToolId === t.id) { alert("该工具正在运行，请先取消任务"); return; }
      const inDir = await toolsDirGranted();
      if (!confirm("确定删除「" + (t.name || "未命名") + "」吗？" + (inDir ? "\n将同时删除 tools 目录中的配置文件。" : ""))) return;
      state.tools = state.tools.filter(x => x.id !== t.id);
      if (state.activeId === t.id) state.activeId = state.tools[0] && state.tools[0].id;
      saveTools();
      saveActiveId();
      renderAll();
      if (inDir) {
        try { await deleteToolFromDir(t.id); showStatus("已删除 tools 目录中的配置文件", "ok"); }
        catch (err) { showStatus("删除配置文件失败：" + err.message, "error"); }
      }
    };
    el.onclick = () => {
      // 切换前保存当前工具的结果，切换后恢复目标工具的结果
      if (state.activeId) state.toolResults[state.activeId] = document.getElementById("resultArea").innerHTML;
      state.activeId = t.id; saveActiveId(); renderAll();
    };
    list.appendChild(el);
  });
}
