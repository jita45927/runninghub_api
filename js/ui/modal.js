// ================= API Key 弹窗与工具配置弹窗（含输入项编辑器、导入导出入口） =================
import { LS, FIELD_TYPES, esc } from "../config.js";
import { state, saveTools, saveActiveId } from "../store.js";
import { getAccountStatus } from "../api.js";
import { importToolFile, toolsDirGranted, writeToolToDir, deleteToolFromDir } from "../tools.js";
import { showStatus } from "./form.js";

let editingToolId = null;
let editingFields = [];  // 配置弹窗中正在编辑的字段数组

// ================= API Key 弹窗 =================
export function refreshKeyBtn() {
  const has = !!localStorage.getItem(LS.key);
  document.getElementById("keyDot").className = "key-dot" + (has ? " ok" : "");
  document.getElementById("keyBtnText").textContent = has ? "API Key 已设置" : "API Key 未设置";
}

// 查询账户余额并渲染到弹窗内
async function fetchBalance() {
  const box = document.getElementById("balanceInfo");
  const k = document.getElementById("apiKey").value.trim();
  if (!k) { box.style.display = "none"; return; }
  box.style.display = "";
  box.innerHTML = "💰 正在查询账户余额…";
  try {
    const d = await getAccountStatus(k);
    const typeMap = { NORMAL: "消费级-会员", SHARED: "企业级-共享", EXCLUSIVE: "企业级-独占" };
    box.innerHTML = "💰 <b>钱包余额：" + esc(d.remainMoney ?? "-") + " " + esc(d.currency || "") + "</b>" +
      "　🪙 RH币：" + esc(d.remainCoins ?? "-") +
      "　⏱ 运行中任务：" + esc(d.currentTaskCounts ?? "0") +
      "　🏷 类型：" + esc(typeMap[d.apiType] || d.apiType || "-");
  } catch (e) {
    box.innerHTML = "💰 余额查询失败：" + esc(e.message);
  }
}

// ================= 工具配置弹窗（含字段编辑器） =================
function renderFieldsEditor() {
  const box = document.getElementById("fieldsEditor");
  box.innerHTML = "";
  editingFields.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "field-edit-row";
    row.innerHTML = `
      <input type="text" data-k="label" placeholder="如：上传图片" value="${esc(f.label)}">
      <select data-k="type">${Object.keys(FIELD_TYPES).map(k =>
        `<option value="${k}" ${f.type === k ? "selected" : ""}>${FIELD_TYPES[k]}</option>`).join("")}</select>
      <input type="text" data-k="nodeId" placeholder="如 1" value="${esc(f.nodeId)}">
      <input type="text" data-k="fieldName" placeholder="如 image" value="${esc(f.fieldName)}">
      <input type="text" data-k="def" placeholder="${f.type === "select" ? "选项1,选项2" : "可留空"}" value="${esc(f.def)}">
      <button class="del-field" title="删除">✕</button>`;
    row.querySelectorAll("[data-k]").forEach(inp => {
      inp.onchange = () => { f[inp.dataset.k] = inp.value.trim(); };
    });
    row.querySelector(".del-field").onclick = () => {
      editingFields.splice(i, 1);
      renderFieldsEditor();
    };
    box.appendChild(row);
  });
}

export function openToolModal(toolId) {
  editingToolId = toolId;
  const t = state.tools.find(x => x.id === toolId);
  document.getElementById("toolModalTitle").textContent = t ? "⚙️ 配置工具" : "＋ 添加工具";
  document.getElementById("tIcon").value = t ? t.icon : "";
  document.getElementById("tName").value = t ? t.name : "";
  document.getElementById("tDesc").value = t ? t.desc : "";
  document.getElementById("tWebappId").value = t ? t.webappId : "";
  document.getElementById("tToolType").value = t ? (t.toolType || "app") : "app";
  document.getElementById("tToolType").dispatchEvent(new Event("change"));
  document.getElementById("tInstanceType").value = t ? (t.instanceType || "default") : "default";
  editingFields = t && t.fields ? JSON.parse(JSON.stringify(t.fields)) : [];
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
async function refreshSetupWizard() {
  const supported = !!window.showDirectoryPicker;
  const toolsOk = await toolsDirGranted();
  const dlOk = await dirGranted(state.dirHandle);
  const toolsBtn = document.getElementById("grantToolsDirBtn");
  const dlBtn = document.getElementById("grantDownloadDirBtn");
  if (!supported) {
    // 浏览器不支持 File System Access：禁用授权按钮
    toolsBtn.disabled = dlBtn.disabled = true;
    document.getElementById("setupToolsDirStatus").textContent = "浏览器不支持";
    document.getElementById("setupDownloadDirStatus").textContent = "浏览器不支持";
    document.getElementById("setupDone").style.display = "none";
    return;
  }
  const next = !toolsOk ? "tools" : (!dlOk ? "dl" : null);
  setStepState(document.getElementById("setupStepToolsDir"), document.getElementById("setupToolsDirStatus"),
    toolsOk, state.toolsDirHandle && state.toolsDirHandle.name, next === "tools");
  setStepState(document.getElementById("setupStepDownloadDir"), document.getElementById("setupDownloadDirStatus"),
    dlOk, state.dirHandle && state.dirHandle.name, next === "dl");
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

// 绑定两个弹窗的全部事件（renderAll 由入口传入，保存/删除/导入后整体重绘）
export function initModals(renderAll) {
  const keyModal = document.getElementById("keyModal");
  const toolModal = document.getElementById("toolModal");

  document.getElementById("keyBtn").onclick = () => {
    document.getElementById("apiKey").value = localStorage.getItem(LS.key) || "";
    document.getElementById("site").value = localStorage.getItem(LS.site) || "https://www.runninghub.cn";
    keyModal.classList.add("show");
    fetchBalance();
  };
  document.getElementById("saveKeyBtn").onclick = () => {
    const k = document.getElementById("apiKey").value.trim();
    if (k) localStorage.setItem(LS.key, k);
    localStorage.setItem(LS.site, document.getElementById("site").value);
    keyModal.classList.remove("show");
    refreshKeyBtn();
  };
  document.getElementById("clearKeyBtn").onclick = () => {
    localStorage.removeItem(LS.key);
    document.getElementById("apiKey").value = "";
    refreshKeyBtn();
    keyModal.classList.remove("show");
  };

  document.getElementById("addFieldBtn").onclick = () => {
    editingFields.push({ label: "", type: "textarea", nodeId: "", fieldName: "", def: "" });
    renderFieldsEditor();
  };
  // 类型切换时更新 ID 字段的说明文字
  document.getElementById("tToolType").onchange = e => {
    document.getElementById("tWebappIdLabel").textContent = e.target.value === "workflow"
      ? "工作流 ID（workflowId，工作流页面「API调用」中可见）"
      : "AI 应用 ID（webappId，应用详情页 URL 或「API调用」中可见）";
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
    const bad = editingFields.find(f => !f.label || !f.nodeId || !f.fieldName);
    if (bad) { alert("有输入项的「显示名称 / 节点ID / 字段名」没填完整，请检查"); return; }
    const data = {
      icon: document.getElementById("tIcon").value.trim() || "🧩",
      name: document.getElementById("tName").value.trim() || "未命名工具",
      desc: document.getElementById("tDesc").value.trim(),
      webappId: document.getElementById("tWebappId").value.trim(),
      toolType: document.getElementById("tToolType").value,
      instanceType: document.getElementById("tInstanceType").value,
      fields: editingFields
    };
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
    // 已授权配置目录时，把工具 JSON 写回目录文件（改名时删除旧文件）
    if (await toolsDirGranted()) {
      try {
        const fn = await writeToolToDir(state.tools.find(x => x.id === (editingToolId || data.id)));
        showStatus("已保存到 tools/" + fn, "ok");
      } catch (err) { showStatus("写入配置目录失败：" + err.message, "error"); }
    }
  };
  document.getElementById("deleteToolBtn").onclick = async () => {
    if (!editingToolId) return;
    const inDir = await toolsDirGranted();
    if (!confirm("确定删除这个工具吗？" + (inDir ? "\n将同时删除 tools 目录中的配置文件。" : ""))) return;
    const delId = editingToolId;
    state.tools = state.tools.filter(x => x.id !== delId);
    if (state.activeId === delId) state.activeId = state.tools[0] && state.tools[0].id;
    saveTools();
    saveActiveId();
    toolModal.classList.remove("show");
    renderAll();
    if (inDir) {
      try { await deleteToolFromDir(delId); showStatus("已删除 tools 目录中的配置文件", "ok"); }
      catch (err) { showStatus("删除配置文件失败：" + err.message, "error"); }
    }
  };

  // 弹窗通用关闭
  document.querySelectorAll("[data-close]").forEach(b => {
    b.onclick = () => document.getElementById(b.dataset.close).classList.remove("show");
  });
  document.querySelectorAll(".modal-mask").forEach(m => {
    m.onclick = e => { if (e.target === m) m.classList.remove("show"); };
  });
}
