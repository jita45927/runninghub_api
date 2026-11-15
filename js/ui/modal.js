// ================= 通用弹窗与工具配置核心 =================
// 【公共核心】本文件由公共核心同步而来：请修改 runninghub_api/js/ui/modal.js，再运行「同步核心.ps1」。
// 应用专属设置与配置面板通过 initModals 的 panel 参数接入（见各应用 js/ui/panels.js）。
import { FIELD_TYPES, ICON_OPTIONS, esc } from "../config.js";
import { state, saveTools, saveActiveId, tagsOf } from "../store.js";
import { importToolFile, toolsDirGranted, persistTool } from "../tools.js";
import { showStatus } from "./form.js";

let editingToolId = null;
let editingFields = [];  // 配置弹窗中正在编辑的字段数组
let editingTags = [];    // 配置弹窗中正在编辑的标签（决定左侧分组，可多个）
let bigEditTarget = null;  // 大窗编辑时对应的输入框
let appPanel = {};       // 各应用专属设置与工具配置面板

// 打开大文本编辑窗（默认值 / 输入项名称 / 功能描述 共用）
function openBigEditor(targetEl, title, subText, height) {
  bigEditTarget = targetEl;
  document.getElementById("bigDefTitle").textContent = title;
  document.getElementById("bigDefFieldName").textContent = subText || "";
  const ta = document.getElementById("bigDefText");
  ta.value = targetEl.value;
  ta.style.height = (height || 320) + "px";
  document.getElementById("bigDefModal").classList.add("show");
  ta.focus();
}

// ================= 标签编辑器 =================
// 已有标签下拉选择，新标签手动输入；一个工具可打多个标签，即在多个分组里出现
function allKnownTags() {
  const set = new Set();
  state.tools.forEach(t => tagsOf(t).forEach(tag => set.add(tag)));
  return [...set].sort((a, b) => a.localeCompare(b, "zh"));
}

function renderTagEditor() {
  const chips = document.getElementById("tTagChips");
  const sel = document.getElementById("tTagSelect");
  if (!chips || !sel) return;
  chips.innerHTML = "";
  editingTags.forEach(tag => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    const text = document.createElement("span");
    text.textContent = tag;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "✕";
    del.title = "移除标签";
    del.onclick = () => {
      editingTags = editingTags.filter(x => x !== tag);
      renderTagEditor();
    };
    chip.append(text, del);
    chips.appendChild(chip);
  });
  const rest = allKnownTags().filter(x => !editingTags.includes(x));
  sel.innerHTML = '<option value="">' + (rest.length ? "＋ 选择已有标签…" : "暂无其他已有标签") + "</option>" +
    rest.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  sel.value = "";
  sel.disabled = rest.length === 0;
}

function addTagFromInput() {
  const input = document.getElementById("tTagInput");
  const v = input.value.trim();
  input.value = "";
  if (!v) return;
  if (!editingTags.includes(v)) editingTags.push(v);
  renderTagEditor();
}

// ================= 工具配置弹窗（含字段编辑器） =================
function renderFieldsEditor() {
  const box = document.getElementById("fieldsEditor");
  box.innerHTML = "";
  editingFields.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "field-edit-row";
    row.innerHTML = `
      <input type="text" data-k="label" placeholder="如：上传图片（点击编辑）" value="${esc(f.label)}" readonly title="点击弹出大窗口编辑" style="cursor:pointer">
      <select data-k="type">${Object.keys(FIELD_TYPES).map(k =>
        `<option value="${k}" ${f.type === k ? "selected" : ""}>${FIELD_TYPES[k]}</option>`).join("")}</select>
      <input type="text" data-k="nodeId" placeholder="如 1" value="${esc(f.nodeId)}">
      <input type="text" data-k="fieldName" placeholder="如 image" value="${esc(f.fieldName)}">
      <input type="text" data-k="def" placeholder="${f.type === "select" ? "选项1,选项2" : "可留空"}" value="${esc(f.def)}" readonly title="点击弹出大窗口编辑" style="cursor:pointer">
      <button class="del-field" title="删除">✕</button>`;
    row.querySelectorAll("[data-k]").forEach(inp => {
      inp.onchange = () => { f[inp.dataset.k] = inp.value.trim(); };
    });
    row.querySelector(".del-field").onclick = () => {
      editingFields.splice(i, 1);
      renderFieldsEditor();
    };
    // 点击输入项名称 / 默认值 → 弹出大窗口编辑
    row.querySelector('[data-k="label"]').onclick = e => {
      openBigEditor(e.target, "编辑输入项名称", "显示在工具界面上的名称", 120);
    };
    row.querySelector('[data-k="def"]').onclick = e => {
      openBigEditor(e.target, "编辑默认值",
        "输入项：" + (row.querySelector('[data-k="label"]').value || "未命名"),
        f.type === "select" ? 120 : 320);
    };
    box.appendChild(row);
  });
}

export function openToolModal(toolId) {
  editingToolId = toolId;
  const t = state.tools.find(x => x.id === toolId);
  document.getElementById("toolModalTitle").textContent = t ? "⚙️ 配置工具" : "＋ 添加工具";
  const iconSel = document.getElementById("tIcon");
  const curIcon = t ? t.icon : "🖼️";
  const opts = ICON_OPTIONS.includes(curIcon) ? ICON_OPTIONS : [curIcon, ...ICON_OPTIONS];
  iconSel.innerHTML = opts.map(o => `<option value="${esc(o)}"${o === curIcon ? " selected" : ""}>${esc(o)}</option>`).join("");
  document.getElementById("tName").value = t ? t.name : "";
  document.getElementById("tDesc").value = t ? t.desc : "";
  const srcEl = document.getElementById("tSourceUrl");  // 部分应用未提供该输入框
  if (srcEl) srcEl.value = t ? (t.sourceUrl || "") : "";
  editingTags = t ? tagsOf(t) : [];
  renderTagEditor();
  document.getElementById("tTagInput").value = "";
  editingFields = t && t.fields ? JSON.parse(JSON.stringify(t.fields)) : [];
  if (appPanel.openTool) appPanel.openTool(t);  // 应用 ID / 工作流等专属内容
  renderFieldsEditor();
  document.getElementById("deleteToolBtn").style.display = t ? "" : "none";
  document.getElementById("toolModal").classList.add("show");
}

// ================= 初始设置向导 =================
// 目录句柄当前是否已有 readwrite 权限（不触发授权弹窗）
async function dirGranted(h) {
  if (!h || !window.showDirectoryPicker) return false;
  try { return (await h.queryPermission({ mode: "readwrite" })) === "granted"; }
  catch (e) { return false; }
}

function setStepState(stepEl, statusEl, ok, dirName, isNext) {
  stepEl.classList.toggle("next", !!isNext);
  statusEl.className = "setup-step-status" + (ok ? " ok" : "");
  statusEl.textContent = ok ? "✅ 已授权" + (dirName ? "（" + dirName + "）" : "") : "⚠️ 未授权";
}

// 刷新向导中两项授权状态，并高亮引导到下一个待授权项
let toolsPathHintCache = null;  // bat 启动时写入的 tools 目录绝对路径（appinfo.txt 第一行）
async function refreshSetupWizard() {
  // 本地服务模式：tools 写入、结果保存都由 server 直接完成，浏览器不需要任何目录授权
  let info = null;
  if (location.protocol.startsWith("http")) {
    try { info = await (await fetch("/appinfo")).json(); } catch (e) { info = null; }
  }
  const serverMode = !!(info && (info.tools || info.download));

  const toolsBtn = document.getElementById("grantToolsDirBtn");
  const dlBtn = document.getElementById("grantDownloadDirBtn");
  const toolsStatus = document.getElementById("setupToolsDirStatus");
  const dlStatus = document.getElementById("setupDownloadDirStatus");
  const toolsStep = document.getElementById("setupStepToolsDir");
  const dlStep = document.getElementById("setupStepDownloadDir");
  const hint = document.getElementById("toolsDirPathHint");
  const dlHintEl = document.getElementById("dlAuthHint");

  const toolsOk = serverMode ? true : await toolsDirGranted();
  const dlOk = serverMode ? !!(info && info.download) : await dirGranted(state.dirHandle);

  // 非服务模式且浏览器不支持：只能提示换浏览器
  if (!serverMode && !window.showDirectoryPicker) {
    toolsBtn.disabled = dlBtn.disabled = true;
    toolsStatus.textContent = "浏览器不支持";
    dlStatus.textContent = "浏览器不支持";
    document.getElementById("setupDone").style.display = "none";
    return;
  }
  toolsBtn.disabled = dlBtn.disabled = false;

  const next = !toolsOk ? "tools" : (!dlOk ? "dl" : null);

  if (toolsOk) {
    toolsStep.classList.remove("next");
    toolsStatus.className = "setup-step-status ok";
    toolsStatus.textContent = serverMode
      ? "✅ 本地服务自动写入"
      : "✅ 已授权" + (state.toolsDirHandle ? "（" + state.toolsDirHandle.name + "）" : "");
  } else {
    setStepState(toolsStep, toolsStatus, false, "", next === "tools");
  }
  toolsBtn.style.display = serverMode ? "none" : "";

  if (hint) {
    if (serverMode) {
      hint.textContent = info.tools ? "📂 " + info.tools : "";
    } else if (toolsOk) {
      hint.textContent = "";
    } else {
      if (toolsPathHintCache === null) {
        try {
          const r = await fetch("appinfo.txt");
          if (r.ok) {
            const lines = (await r.text()).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            toolsPathHintCache = lines[0] || "";
          } else { toolsPathHintCache = ""; }
        } catch (e) { toolsPathHintCache = ""; }
      }
      hint.textContent = toolsPathHintCache ? "📂 " + toolsPathHintCache : "";
    }
  }

  if (dlOk) {
    dlStep.classList.remove("next");
    dlStatus.className = "setup-step-status ok";
    dlStatus.textContent = serverMode ? "✅ 已配置" : "✅ 已授权" + (state.dirHandle ? "（" + state.dirHandle.name + "）" : "");
    dlBtn.textContent = "更换目录";
    if (dlHintEl && serverMode) dlHintEl.textContent = info.download ? "📂 " + info.download : "";
  } else {
    setStepState(dlStep, dlStatus, false, "", next === "dl");
    dlBtn.textContent = "选择目录";
  }

  document.getElementById("setupDone").style.display = toolsOk && dlOk ? "" : "none";
}

// 绑定初始设置向导（grant 函数由入口传入，与顶栏/侧栏按钮共用同一套授权逻辑）
export function initSetupWizard({ grantToolsDir, grantDownloadDir }) {
  const modal = document.getElementById("setupModal");
  document.getElementById("setupBtn").onclick = () => {
    modal.classList.add("show");
    refreshSetupWizard();
  };
  // 每步授权需各自的用户点击（浏览器限制，不能一次点击连弹两个选择器）
  document.getElementById("grantToolsDirBtn").onclick = async () => {
    if (await grantToolsDir()) refreshSetupWizard();
  };
  document.getElementById("grantDownloadDirBtn").onclick = async () => {
    if (await grantDownloadDir()) refreshSetupWizard();
  };
}

// 绑定弹窗事件；panel 实现各应用自己的设置与工具配置面板
export function initModals(renderAll, panel) {
  appPanel = panel || {};
  const toolModal = document.getElementById("toolModal");
  if (appPanel.initSettings) appPanel.initSettings();
  if (appPanel.initToolPanel) appPanel.initToolPanel();

  document.getElementById("addFieldBtn").onclick = () => {
    editingFields.push({ label: "", type: "textarea", nodeId: "", fieldName: "", def: "" });
    renderFieldsEditor();
  };
  // 标签：下拉选已有标签，输入框回车或点「添加」新建
  document.getElementById("tTagAddBtn").onclick = addTagFromInput;
  document.getElementById("tTagInput").onkeydown = e => {
    if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); }
  };
  document.getElementById("tTagSelect").onchange = e => {
    const v = e.target.value;
    if (v && !editingTags.includes(v)) editingTags.push(v);
    renderTagEditor();
  };
  // 点击功能描述 → 弹出大窗口编辑
  document.getElementById("tDesc").onclick = e => {
    openBigEditor(e.target, "编辑功能描述", "一句话说明这个工具做什么", 140);
  };
  // 配置说明帮助
  document.getElementById("toolHelpBtn").onclick = () => {
    document.getElementById("toolHelpModal").classList.add("show");
  };
  // 免责声明
  document.getElementById("disclaimerBtn").onclick = () => {
    document.getElementById("disclaimerModal").classList.add("show");
  };
  // 大编辑窗：保存回写到对应输入框并同步数据
  document.getElementById("bigDefSaveBtn").onclick = () => {
    if (bigEditTarget) {
      bigEditTarget.value = document.getElementById("bigDefText").value;
      bigEditTarget.dispatchEvent(new Event("change"));
    }
    document.getElementById("bigDefModal").classList.remove("show");
    bigEditTarget = null;
  };
  document.getElementById("configToolBtn").onclick = () => { if (state.activeId) openToolModal(state.activeId); };
  document.getElementById("addToolBtn").onclick = () => openToolModal(null);

  // 导入配置文件生成新工具
  document.getElementById("importToolBtn").onclick = () => document.getElementById("importFileInput").click();
  document.getElementById("importFileInput").onchange = e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) importToolFile(file, renderAll);
  };

  document.getElementById("saveToolBtn").onclick = async () => {
    // 触发未失焦输入框的 onchange，确保数据已收集
    document.querySelectorAll("#fieldsEditor [data-k]").forEach(inp => inp.dispatchEvent(new Event("change")));
    if (appPanel.validateTool) {
      const message = appPanel.validateTool();
      if (message) { alert(message); return; }
    }
    const bad = editingFields.find(f => !f.label || !f.nodeId || !f.fieldName);
    if (bad) { alert("有输入项的「显示名称 / 节点ID / 字段名」没填完整，请检查"); return; }
    // 记录旧名称：改名后应用专属逻辑（如封面文件）需要跟随重命名
    const prevName = editingToolId
      ? ((state.tools.find(x => x.id === editingToolId) || {}).name || "")
      : "";
    const srcEl = document.getElementById("tSourceUrl");  // 部分应用未提供该输入框
    const sourceUrl = srcEl ? srcEl.value.trim() : "";
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) {
      alert("原始地址需要以 http:// 或 https:// 开头，可留空");
      return;
    }
    const data = {
      icon: document.getElementById("tIcon").value.trim() || "🧩",
      name: document.getElementById("tName").value.trim() || "未命名工具",
      desc: document.getElementById("tDesc").value.trim(),
      sourceUrl,
      tags: editingTags.slice(),
      fields: editingFields
    };
    Object.assign(data, appPanel.toolData ? appPanel.toolData() : {});
    if (editingToolId) {
      Object.assign(state.tools.find(x => x.id === editingToolId), data);
    } else {
      data.id = "t" + Date.now();
      state.tools.push(data);
      state.activeId = data.id;
    }
    saveTools();
    saveActiveId();
    toolModal.classList.remove("show");
    renderAll();
    // 应用专属的保存后处理（可选钩子，未实现的程序会跳过）
    const savedTool = state.tools.find(x => x.id === (editingToolId || data.id));
    if (savedTool && appPanel.afterToolSave) {
      try { appPanel.afterToolSave(savedTool, prevName); }
      catch (e) { /* 钩子异常不影响工具保存 */ }
    }
    // 写回 tools 目录：本地服务模式下由 server 直接写文件，无需浏览器授权
    try {
      const saved = state.tools.find(x => x.id === (editingToolId || data.id));
      const fn = await persistTool(saved);
      if (fn) showStatus("已保存到 tools/" + fn, "success");
    } catch (err) { showStatus("写入配置目录失败：" + err.message, "error"); }
  };
  document.getElementById("deleteToolBtn").onclick = async () => {
    if (!editingToolId) return;
    const delTool = state.tools.find(x => x.id === editingToolId);
    if (!delTool) return;
    if (state.currentRun && state.runningToolId === delTool.id) { alert("该工具正在运行，请先取消任务"); return; }
    // 与左侧列表的 ✕ 保持一致：移入回收站，配置文件保留
    if (!confirm("「" + (delTool.name || "未命名") + "」会被移动到回收站列表，并不会彻底删除配置文件。\n\n回收站中的工具不可使用，可随时还原。")) return;
    delTool.deleted = true;
    if (state.activeId === delTool.id) {
      const first = state.tools.find(x => !x.deleted);
      state.activeId = first ? first.id : null;
    }
    saveTools();
    saveActiveId();
    toolModal.classList.remove("show");
    renderAll();
    try { await persistTool(delTool); } catch (err) { /* 配置文件写入失败不影响列表状态 */ }
  };

  // 弹窗通用关闭
  document.querySelectorAll("[data-close]").forEach(b => {
    b.onclick = () => document.getElementById(b.dataset.close).classList.remove("show");
  });
  document.querySelectorAll(".modal-mask").forEach(m => {
    m.onclick = e => { if (e.target === m) m.classList.remove("show"); };
  });
}
