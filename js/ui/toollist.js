// ================= 左侧工具列表（按分类分组，可展开/收起） =================
import { state, saveTools, saveActiveId, saveCats } from "../store.js";
import { toolsDirGranted, deleteToolFromDir } from "../tools.js";
import { showStatus } from "./form.js";

// 单个工具条目（DOM 构建，防注入）
function buildToolItem(t, renderAll) {
  const configured = t.webappId && t.fields && t.fields.length && t.fields.every(f => f.nodeId);
  const el = document.createElement("div");
  el.className = "tool-item" + (t.id === state.activeId ? " active" : "");
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
  return el;
}

export function renderToolList(renderAll) {
  const list = document.getElementById("toolList");
  list.innerHTML = "";

  // 按分类分组，保持首次出现顺序；「未分类」排最后
  const groups = new Map();
  state.tools.forEach(t => {
    const cat = (t.category || "").trim() || "未分类";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(t);
  });
  const catNames = [...groups.keys()].sort((a, b) =>
    a === "未分类" ? 1 : b === "未分类" ? -1 : a.localeCompare(b, "zh"));

  const UNC = "未分类";
  catNames.forEach(cat => {
    const tools = groups.get(cat);
    // 全是无分类工具且只有一个「未分类」组时，不显示分类头，保持旧版平铺样式
    const showHeader = !(cat === UNC && catNames.length === 1);
    const collapsed = state.collapsedCats.includes(cat);

    if (showHeader) {
      const head = document.createElement("div");
      head.className = "cat-header";
      const arrow = document.createElement("span");
      arrow.className = "cat-arrow";
      arrow.textContent = collapsed ? "▶" : "▼";
      const label = document.createElement("span");
      label.className = "cat-name";
      label.textContent = cat;
      const count = document.createElement("span");
      count.className = "cat-count";
      count.textContent = tools.length;
      head.append(arrow, label, count);
      head.onclick = () => {
        const i = state.collapsedCats.indexOf(cat);
        if (i >= 0) state.collapsedCats.splice(i, 1); else state.collapsedCats.push(cat);
        saveCats();
        renderAll();
      };
      list.appendChild(head);
    }

    if (!collapsed) tools.forEach(t => list.appendChild(buildToolItem(t, renderAll)));
  });
}
