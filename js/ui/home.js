// ================= 工具首页：按分类展示封面卡片，与工作页互斥切换 =================
import { state, saveActiveId, saveCats, tagsOf } from "../store.js";
import { coverUrlFor, refreshCoverIndex, saveCover } from "../covers.js";
import { trashTool, sortCatNames } from "./toollist.js";

let rerender = null;          // 入口传入的 renderAll，用于卡片点击后刷新全页
let currentView = "home";     // "home" | "work"

// 工具所属分组：与左侧列表一致，一个工具可打多个标签、在多个分组出现
function groupsOf(t) {
  const tags = tagsOf(t);
  return tags.length ? tags : ["未分类"];
}

// 工具状态：生成中 > 最近完成 > 已配置/待配置（与左侧列表判定一致）
function statusOf(t) {
  const hasApp = !!(t.webappId || t.workflow);
  const configured = hasApp && (t.fields || []).every(f => f.nodeId);
  if (state.runningToolId === t.id && state.currentRun) return { cls: "running", text: "◐ 生成中…" };
  if (state.lastDoneToolId === t.id) return { cls: "done", text: "✓ 最近完成" };
  return configured ? { cls: "ok", text: "● 已配置" } : { cls: "", text: "○ 待配置" };
}

function placeholder(t) {
  const ph = document.createElement("div");
  ph.className = "home-cover-ph";
  ph.textContent = t.icon || "🧩";
  return ph;
}

// 首页内的轻量提示（首页没有工作区的状态栏）
function toast(text) {
  const el = document.createElement("div");
  el.className = "home-toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ================= 卡片封面直接上传 =================
let coverInput = null;      // 复用的隐藏文件选择框
let uploadTarget = null;    // 当前要设置封面的工具

function pickCoverFor(t) {
  if (!coverInput) {
    coverInput = document.createElement("input");
    coverInput.type = "file";
    coverInput.accept = "image/png,image/jpeg";
    coverInput.style.display = "none";
    document.body.appendChild(coverInput);
    coverInput.onchange = async e => {
      const file = e.target.files[0];
      const tool = uploadTarget;
      e.target.value = "";
      if (!file || !tool) return;
      if (file.type !== "image/png" && file.type !== "image/jpeg") {
        toast("封面仅支持 PNG 或 JPG 图片");
        return;
      }
      if (file.size > 8 * 1024 * 1024) { toast("封面图片不能超过 8MB"); return; }
      try {
        const fn = await saveCover(tool.name, file);
        await refreshCoverIndex();
        renderHome();
        toast("封面已保存到 tools/" + fn);
      } catch (err) {
        if (/授权/.test(err.message)) {
          if (confirm(err.message + "\n\n现在前往授权 tools 目录？")) {
            document.dispatchEvent(new CustomEvent("rh:grant-tools-dir"));
          }
        } else {
          toast("封面保存失败：" + err.message);
        }
      }
    };
  }
  uploadTarget = t;
  coverInput.click();
}

// 封面：有文件则显示，加载失败先尝试 .jpg，仍失败退化为图标占位
function buildCover(t) {
  const box = document.createElement("div");
  box.className = "home-cover";
  const url = coverUrlFor(t.name);
  if (url) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = t.name || "工具封面";
    img.onerror = () => {
      if (!img.dataset.fallback && /\.png(\?|$)/i.test(url)) {
        img.dataset.fallback = "1";
        img.src = url.replace(/\.png(\?|$)/i, ".jpg$1");
        return;
      }
      img.remove();
      box.appendChild(placeholder(t));
    };
    img.src = url;
    box.appendChild(img);
  } else {
    box.appendChild(placeholder(t));
  }

  const up = document.createElement("button");
  up.type = "button";
  up.className = "home-cover-upload";
  up.title = "上传封面（自动裁剪缩放为 3:4，保存为 tools/工具名.png 或 .jpg）";
  up.textContent = "📷 封面";
  up.onclick = e => { e.stopPropagation(); pickCoverFor(t); };
  box.appendChild(up);
  return box;
}

function buildCard(t) {
  const st = statusOf(t);
  const card = document.createElement("div");
  card.className = "home-card" + (t.id === state.activeId ? " active" : "") + (st.cls ? " " + st.cls : "");

  const body = document.createElement("div");
  body.className = "home-card-body";
  const name = document.createElement("div");
  name.className = "home-card-name";
  name.textContent = t.name || "未命名";
  name.title = t.name || "未命名";
  body.appendChild(name);

  card.append(buildCover(t), body);

  // 首页卡片也支持移入回收站（与左侧列表的 ✕ 同一套逻辑）
  const del = document.createElement("button");
  del.type = "button";
  del.className = "home-card-del";
  del.title = "移入回收站（不删除配置文件）";
  del.textContent = "✕";
  del.onclick = e => { e.stopPropagation(); trashTool(t, rerender); };
  card.appendChild(del);

  card.onclick = () => {
    // 与左侧列表切换一致：先保存当前工具的结果，再恢复目标工具的界面（占位提示不写入历史）
    const area = document.getElementById("resultArea");
    if (state.activeId && state.activeId !== t.id && !area.querySelector(".result-placeholder")) {
      state.toolResults[state.activeId] = area.innerHTML;
    }
    state.activeId = t.id;
    saveActiveId();
    if (rerender) rerender();
    showWorkView();
  };
  return card;
}

export function renderHome(renderAll) {
  if (renderAll) rerender = renderAll;
  const grid = document.getElementById("homeGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const groups = new Map();
  state.tools.forEach(t => {
    if (t.deleted) return;  // 回收站里的工具不在首页展示
    groupsOf(t).forEach(tag => {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(t);
    });
  });

  if (!groups.size) {
    const empty = document.createElement("div");
    empty.className = "home-empty";
    empty.textContent = "还没有工具，请在左侧「＋ 添加工具」或「📥 导入配置文件」";
    grid.appendChild(empty);
    return;
  }

  // 与左侧工具栏共用同一套排序规则（拖动分组后的自定义顺序）
  const catNames = sortCatNames([...groups.keys()]);

  catNames.forEach(cat => {
    const tools = groups.get(cat);
    const section = document.createElement("div");
    section.className = "home-section";

    const collapsed = state.collapsedCats.includes(cat);  // 与左侧栏共用收起状态
    const head = document.createElement("div");
    head.className = "home-cat";
    head.title = collapsed ? "展开分组" : "收起分组";
    const arrow = document.createElement("span");
    arrow.className = "home-cat-arrow";
    arrow.textContent = collapsed ? "▶" : "▼";
    const label = document.createElement("span");
    label.textContent = cat;
    const count = document.createElement("span");
    count.className = "home-cat-count";
    count.textContent = tools.length;
    head.append(arrow, label, count);
    head.onclick = () => {
      const i = state.collapsedCats.indexOf(cat);
      if (i >= 0) state.collapsedCats.splice(i, 1); else state.collapsedCats.push(cat);
      saveCats();
      if (rerender) rerender(); else renderHome();
    };
    section.appendChild(head);

    if (!collapsed) {
      const cards = document.createElement("div");
      cards.className = "home-grid";
      tools.forEach(t => cards.appendChild(buildCard(t)));
      section.appendChild(cards);
    }
    grid.appendChild(section);
  });
}

// 切换视图：只控制右侧区域，左侧工具栏常驻
function applyView() {
  const home = document.getElementById("homeView");
  const ws = document.getElementById("workspace");
  const btn = document.getElementById("homeBtn");
  if (home) home.style.display = currentView === "home" ? "" : "none";
  if (ws) ws.style.display = currentView === "work" ? "" : "none";
  if (btn) btn.classList.toggle("active", currentView === "home");
}

// 进入首页：刷新封面索引后再绘制，避免首次启动读到空索引
export async function showHomeView() {
  currentView = "home";
  applyView();
  await refreshCoverIndex();
  if (currentView === "home") renderHome();
}

export function showWorkView() {
  currentView = "work";
  applyView();
}
