// ================= 左侧工具列表（按分类分组，可展开/收起）【公共核心】 =================
// 本文件由公共核心同步而来：请修改 runninghub_api/js/ui/toollist.js，再运行「同步核心.ps1」。
// 【不同步到 COMFYUI】系统工具隐藏/复制（toolSourceOf / setToolTombstone / copyToolToUser、系统/我的徽标、重置系统工具）仅适用于 RunningHub，同步时需剔除。
import { state, saveTools, saveActiveId, saveCats, saveCatOrder, tagsOf } from "../store.js";
import { removeToolFile, persistTool, toolSourceOf, setToolTombstone, copyToolToUser } from "../tools.js";
import { showStatus } from "./form.js";

// 回收站：工具级状态（deleted=true），所有分类里都不再显示，只在此分组出现且禁用
const TRASH = "🗑 回收站";

// 左侧列表内拖动排序：只允许在同一分组内调整先后
let dragToolId = null;
let dragToolTag = null;  // 被拖动条目所在的分组
let dragCat = null;      // 正在拖动的分类名（拖动分组头部时使用）
let catNamesShown = [];  // 当前渲染出的分类顺序（供分组拖动时计算落点）
let catDragEndedAt = 0;  // 防止拖动结束后的 click 误触发展开/收起

// 工具所属分组：一个工具可以打多个标签，因此在多组里各出现一次；没有标签归入「未分类」
function groupsOf(t) {
  if (t.deleted) return [TRASH];
  const tags = tagsOf(t);
  return tags.length ? tags : ["未分类"];
}

// 工具条目状态：运行中（黄）> 最近完成（绿）> 已配置/待配置
function statusOf(t) {
  if (t.deleted) return { cls: "", text: "🗑 在回收站" };
  // 应用标识：RunningHub 用 webappId，ComfyUI 用 workflow；任一存在即视为已绑定应用
  const hasApp = !!(t.webappId || t.workflow);
  const configured = hasApp && (t.fields || []).every(f => f.nodeId);
  if (state.runningToolId === t.id && state.currentRun) return { cls: "running", text: "◐ 生成中…" };
  const queued = state.runQueue.filter(q => q.toolId === t.id).length;
  if (queued) return { cls: "queued", text: "⏳ 排队中" + (queued > 1 ? "（" + queued + "）" : "") };
  if (state.lastDoneToolId === t.id) return { cls: "done", text: "✓ 最近完成" };
  return configured ? { cls: "ok", text: "● 已配置" } : { cls: "", text: "○ 待配置" };
}

// ===== 回收站操作：移入 / 还原 / 永久删除 / 清空 =====
function nameOf(t) { return t.name || "未命名"; }

// 移入回收站：左侧列表与首页卡片共用（导出供 home.js 使用）
export async function trashTool(t, renderAll) {
  if (state.currentRun && state.runningToolId === t.id) { alert("该工具正在运行，请先取消任务"); return; }
  const isSys = toolSourceOf(t) === "sys";
  if (!confirm(isSys
    ? "「" + nameOf(t) + "」是系统工具，将标记为删除并隐藏（程序更新后也不会自动恢复）。\n\n可用「重置系统工具」找回。"
    : "「" + nameOf(t) + "」会被移动到回收站列表，并不会彻底删除配置文件。\n\n回收站中的工具不可使用，可随时还原。")) return;
  t.deleted = true;
  if (state.activeId === t.id) {
    const first = state.tools.find(x => !x.deleted);
    state.activeId = first ? first.id : null;
    saveActiveId();
  }
  saveTools();
  renderAll();
  try {
    if (isSys) {
      if (t.webappId) await setToolTombstone(t.webappId, true);
      else await removeToolFile(t);  // 极端情况：系统配置缺少 webappId，只能移走文件
      showStatus("已从系统工具中移除，可在「初始设置 → 重置系统工具」找回", "ok");
    } else {
      await persistTool(t);
      showStatus("已移入回收站，配置文件保留在我的工具目录", "ok");
    }
  } catch (err) {
    showStatus("移入回收站失败：" + err.message, "error");
  }
}

async function restoreTool(t, renderAll) {
  delete t.deleted;
  saveTools();
  renderAll();
  const isSys = toolSourceOf(t) === "sys";
  try {
    if (isSys) await setToolTombstone(t.webappId, false);
    else await persistTool(t);
    showStatus("已还原「" + nameOf(t) + "」", "ok");
  } catch (err) {
    showStatus("已还原，但写回配置失败：" + err.message, "error");
  }
}

// 永久删除单个工具：配置文件一并删除
async function purgeTool(t, renderAll) {
  const isSys = toolSourceOf(t) === "sys";
  if (!confirm(isSys
    ? "确定移除系统工具「" + nameOf(t) + "」吗？\n\n系统文件不会被删除，但程序更新后也不会自动恢复；可用「重置系统工具」找回。"
    : "确定永久删除「" + nameOf(t) + "」吗？\n\n将删除我的工具目录中的配置文件，无法恢复。")) return;
  state.tools = state.tools.filter(x => x.id !== t.id);
  if (state.activeId === t.id) {
    const first = state.tools.find(x => !x.deleted);
    state.activeId = first ? first.id : null;
    saveActiveId();
  }
  saveTools();
  renderAll();
  try {
    let ok;
    if (isSys && t.webappId) { await setToolTombstone(t.webappId, true); ok = true; }
    else ok = await removeToolFile(t);
    showStatus(ok ? (isSys ? "已移除系统工具，可用「重置系统工具」找回" : "已永久删除，配置文件已移除")
      : "已从列表移除（未找到配置文件）", ok ? "ok" : "error");
  } catch (err) {
    showStatus("删除配置文件失败：" + err.message, "error");
  }
}

// 清空回收站：仅保留在回收站里的工具，配置文件会被删除
async function emptyTrash(renderAll) {
  const dead = state.tools.filter(t => t.deleted);
  if (!dead.length) return;
  if (!confirm("确定清空回收站吗？\n\n将永久删除 " + dead.length + " 个工具配置（系统工具只做隐藏，可用「重置系统工具」找回）。")) return;
  const ids = dead.map(t => t.id);
  state.tools = state.tools.filter(t => !t.deleted);
  if (ids.includes(state.activeId)) {
    const first = state.tools.find(x => !x.deleted);
    state.activeId = first ? first.id : null;
    saveActiveId();
  }
  saveTools();
  renderAll();
  let ok = 0;
  for (const t of dead) {
    try {
      if (toolSourceOf(t) === "sys" && t.webappId) { await setToolTombstone(t.webappId, true); ok++; }
      else if (await removeToolFile(t)) ok++;
    } catch (e) { /* 单个失败不影响其余 */ }
  }
  showStatus("回收站已清空，移除 " + ok + "/" + dead.length + " 个配置文件", ok ? "ok" : "error");
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
    el.classList.toggle("queued", st.cls === "queued");
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

// ===== 分类拖动排序 =====
// 排序规则：用户拖动保存的顺序优先；未记录的分类排在后面（按中文排序，「未分类」垫底），回收站永远最后
export function sortCatNames(names) {
  const rank = new Map();
  (state.catOrder || []).forEach((c, i) => rank.set(c, i));
  return names.slice().sort((a, b) => {
    if (a === TRASH) return 1;
    if (b === TRASH) return -1;
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    if (ra !== rb) return ra - rb;
    if (a === "未分类") return 1;
    if (b === "未分类") return -1;
    return a.localeCompare(b, "zh");
  });
}

// 把 src 分类移动到 dst 分类之前（after=true 时为之后），并持久化顺序
function moveCategory(src, dst, after) {
  if (!src || !dst || src === dst || src === TRASH || dst === TRASH) return false;
  const order = catNamesShown.filter(c => c !== TRASH);
  const from = order.indexOf(src);
  if (from < 0) return false;
  order.splice(from, 1);
  const base = order.indexOf(dst);
  if (base < 0) order.push(src);
  else order.splice(after ? base + 1 : base, 0, src);
  state.catOrder = order;
  saveCatOrder();
  return true;
}

// 清除分类头上的拖动落点提示
function clearCatDropMarks() {
  document.querySelectorAll(".cat-header.drop-before, .cat-header.drop-after")
    .forEach(x => x.classList.remove("drop-before", "drop-after"));
}

// 分组头部拖动：调整分类之间的先后，不改变工具归属
function bindCatDrag(head, cat, renderAll) {
  head.draggable = true;
  head.dataset.cat = cat;
  head.addEventListener("dragstart", e => {
    dragCat = cat;
    dragToolId = null;
    dragToolTag = null;
    head.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", cat);  // Firefox 需要设置数据才能拖动
    e.stopPropagation();
  });
  head.addEventListener("dragend", () => {
    dragCat = null;
    catDragEndedAt = Date.now();
    head.classList.remove("dragging");
    clearCatDropMarks();
  });
  head.addEventListener("dragover", e => {
    if (!dragCat || dragCat === cat || cat === TRASH) return;  // 只处理分类之间的拖动
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const r = head.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    head.classList.toggle("drop-after", after);
    head.classList.toggle("drop-before", !after);
  });
  head.addEventListener("dragleave", () => head.classList.remove("drop-before", "drop-after"));
  head.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    const after = head.classList.contains("drop-after");
    head.classList.remove("drop-before", "drop-after");
    const src = dragCat;
    dragCat = null;
    catDragEndedAt = Date.now();
    if (moveCategory(src, cat, after)) renderAll();
  });
}

// 单个工具条目（DOM 构建，防注入）；groupTag 是它当前所属的分组（同一工具可能在多组出现）
function buildToolItem(t, renderAll, groupTag) {
  const st = statusOf(t);
  const trashed = !!t.deleted;
  const el = document.createElement("div");
  el.className = "tool-item" + (t.id === state.activeId ? " active" : "")
    + (st.cls === "running" ? " running" : "") + (st.cls === "queued" ? " queued" : "")
    + (st.cls === "done" ? " done" : "")
    + (trashed ? " trashed" : "");
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
  const srcEl = document.createElement("span");
  const isSysTool = toolSourceOf(t) === "sys";
  srcEl.className = "tool-source " + (isSysTool ? "sys" : "user");
  srcEl.textContent = isSysTool ? "系统" : "我的";
  srcEl.title = isSysTool ? "系统工具：修改会在程序更新时被覆盖，可复制为我的工具" : "我的工具：不会随程序更新变化";
  nameEl.appendChild(srcEl);
  const descEl = document.createElement("div");
  descEl.className = "tool-desc";
  descEl.textContent = t.desc || "";
  const statusEl = document.createElement("div");
  statusEl.className = "tool-status" + (st.cls ? " " + st.cls : "");
  statusEl.textContent = st.text;
  metaEl.append(nameEl, descEl, statusEl);
  const delEl = document.createElement("div");
  delEl.className = "tool-del";
  delEl.textContent = "✕";

  // 回收站里的条目：禁用使用，只提供"还原 / 永久删除"
  if (trashed) {
    delEl.title = "永久删除（会删除配置文件）";
    delEl.onclick = e => { e.stopPropagation(); purgeTool(t, renderAll); };
    const restoreEl = document.createElement("div");
    restoreEl.className = "tool-restore";
    restoreEl.title = "还原到原分类";
    restoreEl.textContent = "↩";
    restoreEl.onclick = e => { e.stopPropagation(); restoreTool(t, renderAll); };
    el.append(iconEl, metaEl, restoreEl, delEl);
    // 回收站里的工具可以点开查看配置（只读预览），但运行已被禁用
    el.onclick = () => {
      state.activeId = t.id;
      saveActiveId();
      renderAll();
      showStatus("已打开回收站中的工具：" + nameOf(t) + "（仅预览，运行已禁用）", "");
    };
    return el;
  }

  delEl.title = "移入回收站（不删除配置文件）";
  if (isSysTool) {
    const copyEl = document.createElement("div");
    copyEl.className = "tool-copy";
    copyEl.textContent = "⧉";
    copyEl.title = "复制为我的工具（之后修改不会随程序更新被覆盖）";
    copyEl.onclick = async e => {
      e.stopPropagation();
      const j = await copyToolToUser(t, renderAll);
      if (j) showStatus("已复制为我的工具「" + (j.name || t.name) + "」", "ok");
    };
    el.append(iconEl, metaEl, copyEl, delEl);
  } else {
    el.append(iconEl, metaEl, delEl);
  }
  delEl.onclick = e => {
    e.stopPropagation();
    trashTool(t, renderAll);
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
    dragCat = null;
    clearCatDropMarks();
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);  // Firefox 需要设置数据才能拖动
  });
  el.addEventListener("dragend", () => {
    dragToolId = null;
    dragToolTag = null;
    el.classList.remove("dragging");
    clearCatDropMarks();
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
  const catNames = sortCatNames([...groups.keys()]);
  catNamesShown = catNames;

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
      if (cat === TRASH) {
        const clear = document.createElement("span");
        clear.className = "cat-clear";
        clear.textContent = "清空";
        clear.title = "清空回收站（删除全部配置文件）";
        clear.onclick = async e => { e.stopPropagation(); await emptyTrash(renderAll); };
        head.appendChild(clear);
      }
      head.onclick = () => {
        if (Date.now() - catDragEndedAt < 300) return;  // 刚结束拖动，不触发展开/收起
        const i = state.collapsedCats.indexOf(cat);
        if (i >= 0) state.collapsedCats.splice(i, 1); else state.collapsedCats.push(cat);
        saveCats();
        renderAll();
      };
      if (cat !== TRASH) bindCatDrag(head, cat, renderAll);  // 拖动分组头部调整分类顺序
      list.appendChild(head);
    }

    if (!collapsed) tools.forEach(t => list.appendChild(buildToolItem(t, renderAll, cat)));
  });
}
