// ================= 左侧工具列表（按分类分组，可展开/收起）【公共核心】 =================
// 本文件由公共核心同步而来：请修改 runninghub_api/js/ui/toollist.js，再运行「同步核心.ps1」。
import { state, saveTools, saveActiveId, saveCats, tagsOf } from "../store.js";
import { removeToolFile } from "../tools.js";
import { showStatus } from "./form.js";

// 左侧列表内拖动排序：只允许在同一分组内调整先后
let dragToolId = null;
let dragToolTag = null;  // 被拖动条目所在的分组

// 工具所属分组：一个工具可以打多个标签，因此在多组里各出现一次；没有标签归入「未分类」
function groupsOf(t) {
  const tags = tagsOf(t);
  return tags.length ? tags : ["未分类"];
}

// 工具条目状态：运行中（黄）> 最近完成（绿）> 已配置/待配置
function statusOf(t) {
  // 应用标识：RunningHub 用 webappId，ComfyUI 用 workflow；任一存在即视为已绑定应用
  const hasApp = !!(t.webappId || t.workflow);
  const configured = hasApp && (t.fields || []).every(f => f.nodeId);
  if (state.runningToolId === t.id && state.currentRun) return { cls: "running", text: "◐ 生成中…" };
  if (state.lastDoneToolId === t.id) return { cls: "done", text: "✓ 最近完成" };
  return configured ? { cls: "ok", text: "● 已配置" } : { cls: "", text: "○ 待配置" };
}

// 记录最近一次 renderAll，运行中的工具若在收起的分类里可自动展开重建
let lastRenderAll = null;

// 仅刷新各条目的运行/完成高亮与状态文字，不重建列表（供运行状态变化时调用）
export function refreshToolItemStates() {
  // 运行中的工具若所属分组全部收起，先展开第一个，保证能看到橙色脉动高亮
  const runTool = state.tools.find(x => x.id === state.runningToolId);
  if (runTool) {
    const groups = groupsOf(runTool);
    if (groups.every(g => state.collapsedCats.includes(g))) {
      state.collapsedCats = state.collapsedCats.filter(c => c !== groups[0]);
      saveCats();
      if (lastRenderAll) { lastRenderAll(); return; }
    }
  }
  document.querySelectorAll(".tool-item[data-tool-id]").forEach(el => {
    const t = state.tools.find(x => x.id === el.dataset.toolId);
    if (!t) return;
    const st = statusOf(t);
    el.classList.toggle("running", st.cls === "running");
    el.classList.toggle("done", st.cls === "done");
    const s = el.querySelector(".tool-status");
    if (s) { s.className = "tool-status" + (st.cls ? " " + st.cls : ""); s.textContent = st.text; }
  });
}

// 把 srcId 移动到 dstId 之前（after=true 时为之后）
function moveTool(srcId, dstId, after) {
  if (!srcId || srcId === dstId) return;
  const from = state.tools.findIndex(x => x.id === srcId);
  const target = state.tools.findIndex(x => x.id === dstId);
  if (from < 0 || target < 0) return;
  const [moved] = state.tools.splice(from, 1);
  const base = state.tools.findIndex(x => x.id === dstId);
  state.tools.splice(after ? base + 1 : base, 0, moved);
  saveTools();
}

// 单个工具条目（DOM 构建，防注入）；groupTag 是它当前所属的分组（同一工具可能在多组出现）
function buildToolItem(t, renderAll, groupTag) {
  const st = statusOf(t);
  const el = document.createElement("div");
  el.className = "tool-item" + (t.id === state.activeId ? " active" : "")
    + (st.cls === "running" ? " running" : "") + (st.cls === "done" ? " done" : "");
  el.dataset.toolId = t.id;
  el.dataset.groupTag = groupTag;
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
  statusEl.className = "tool-status" + (st.cls ? " " + st.cls : "");
  statusEl.textContent = st.text;
  metaEl.append(nameEl, descEl, statusEl);
  const delEl = document.createElement("div");
  delEl.className = "tool-del";
  delEl.title = "删除此工具";
  delEl.textContent = "✕";
  el.append(iconEl, metaEl, delEl);
  delEl.onclick = async e => {
    e.stopPropagation();
    if (state.currentRun && state.runningToolId === t.id) { alert("该工具正在运行，请先取消任务"); return; }
    if (!confirm("确定删除「" + (t.name || "未命名") + "」吗？\n将同时删除 tools 目录中的同名配置文件。")) return;
    const delTool = t;
    state.tools = state.tools.filter(x => x.id !== t.id);
    if (state.activeId === t.id) state.activeId = state.tools[0] && state.tools[0].id;
    saveTools();
    saveActiveId();
    renderAll();
    try {
      const okDel = await removeToolFile(delTool);
      showStatus(okDel ? "已删除 tools 目录中的同名配置文件" : "已从列表移除（未找到同名配置文件）", okDel ? "ok" : "error");
    } catch (err) {
      showStatus("删除配置文件失败：" + err.message, "error");
    }
  };
  el.onclick = () => {
    // 切换前保存当前工具的结果，切换后恢复目标工具的结果（占位提示不写入历史）
    const area = document.getElementById("resultArea");
    if (state.activeId && !area.querySelector(".result-placeholder")) {
      state.toolResults[state.activeId] = area.innerHTML;
    }
    state.activeId = t.id; saveActiveId(); renderAll();
  };

  // ===== 拖动排序 =====
  el.draggable = true;
  el.addEventListener("dragstart", e => {
    dragToolId = t.id;
    dragToolTag = groupTag;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);  // Firefox 需要设置数据才能拖动
  });
  el.addEventListener("dragend", () => {
    dragToolId = null;
    dragToolTag = null;
    el.classList.remove("dragging");
    document.querySelectorAll(".tool-item.drop-before, .tool-item.drop-after")
      .forEach(x => x.classList.remove("drop-before", "drop-after"));
  });
  el.addEventListener("dragover", e => {
    if (!dragToolId || dragToolId === t.id) return;
    if (dragToolTag !== groupTag) return;  // 跨分组不排序
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    el.classList.toggle("drop-after", after);
    el.classList.toggle("drop-before", !after);
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
  el.addEventListener("drop", e => {
    e.preventDefault();
    const after = el.classList.contains("drop-after");
    el.classList.remove("drop-before", "drop-after");
    const srcId = dragToolId;
    dragToolId = null;
    moveTool(srcId, t.id, after);
    renderAll();
  });
  return el;
}

export function renderToolList(renderAll) {
  lastRenderAll = renderAll;
  const list = document.getElementById("toolList");
  list.innerHTML = "";

  // 按分组归集：一个工具的每个标签都会生成一个分组，因此可以同时出现在多个分组里
  const groups = new Map();
  state.tools.forEach(t => {
    groupsOf(t).forEach(tag => {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(t);
    });
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

    if (!collapsed) tools.forEach(t => list.appendChild(buildToolItem(t, renderAll, cat)));
  });
}
