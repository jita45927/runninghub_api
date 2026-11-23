// ================= RunningHub 专属设置与工具配置面板 =================
import { LS, esc } from "../config.js";
import { getAccountStatus } from "../api.js";
import { coverPreviewUrl, coverUrlFor, refreshCoverIndex, renameCover, saveCover } from "../covers.js";
import { toolSourceOf } from "../tools.js";
import { showStatus } from "./form.js";
import { renderHome, showWorkView } from "./home.js";

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

function initSettings() {
  const keyModal = document.getElementById("keyModal");
  const keyBtn = document.getElementById("keyBtn");
  const apiKeyInput = document.getElementById("apiKey");
  const siteInput = document.getElementById("site");
  if (!keyBtn || !keyModal || !apiKeyInput || !siteInput) return;  // 页面文件不完整时不绑定，避免点击后静默报错
  keyBtn.onclick = () => {
    try {
      apiKeyInput.value = localStorage.getItem(LS.key) || "";
      siteInput.value = localStorage.getItem(LS.site) || "https://www.runninghub.cn";
    } catch (e) {
      alert("浏览器禁止了本地存储，API Key 无法保存。请关闭无痕模式，或换用 Edge / Chrome 打开。");
    }
    keyModal.classList.add("show");
    fetchBalance();
  };
  document.getElementById("saveKeyBtn").onclick = () => {
    const k = apiKeyInput.value.trim();
    try {
      if (k) localStorage.setItem(LS.key, k);
      localStorage.setItem(LS.site, siteInput.value);
    } catch (e) {
      alert("保存失败：浏览器禁止了本地存储（" + e.message + "）");
      return;
    }
    keyModal.classList.remove("show");
    refreshKeyBtn();
  };
  document.getElementById("clearKeyBtn").onclick = () => {
    try { localStorage.removeItem(LS.key); } catch (e) {}
    apiKeyInput.value = "";
    refreshKeyBtn();
    keyModal.classList.remove("show");
  };
}

// ================= 工具封面选择（保存工具后写入 tools 目录） =================
let pendingCoverFile = null;    // 配置弹窗中已选、尚未随工具保存的封面
let pendingPreviewUrl = null;   // 暂存封面的本地预览地址

function clearPendingCover() {
  if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
  pendingPreviewUrl = null;
  pendingCoverFile = null;
}

function setCoverPreview(url) {
  const box = document.getElementById("coverPreview");
  if (!box) return;
  box.innerHTML = "";
  if (!url) { box.textContent = "暂无封面"; return; }
  const img = document.createElement("img");
  img.alt = "工具封面预览";
  img.onerror = () => { box.textContent = "暂无封面"; };
  img.src = url;
  box.appendChild(img);
}

function initCoverPicker() {
  const btn = document.getElementById("coverPickBtn");
  const input = document.getElementById("coverFileInput");
  if (!btn || !input) return;
  btn.onclick = () => input.click();
  input.onchange = async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") {
      alert("封面仅支持 PNG 或 JPG 图片");
      return;
    }
    if (file.size > 8 * 1024 * 1024) { alert("封面图片不能超过 8MB"); return; }
    clearPendingCover();
    pendingCoverFile = file;
    try {
      const url = await coverPreviewUrl(file);
      // 处理期间用户又换了图片，丢弃旧结果
      if (pendingCoverFile !== file) { URL.revokeObjectURL(url); return; }
      pendingPreviewUrl = url;
      setCoverPreview(url);
      const hint = document.getElementById("coverHint");
      if (hint) hint.textContent = "预览为最终裁剪效果（3:4）；保存工具后写入对应工具目录";
    } catch (err) {
      pendingCoverFile = null;
      setCoverPreview(null);
      alert(err.message);
    }
  };
}

function initToolPanel() {
  initCoverPicker();
  // 类型切换时更新 ID 字段的说明文字
  document.getElementById("tToolType").onchange = e => {
    document.getElementById("tWebappIdLabel").textContent = e.target.value === "workflow"
      ? "工作流 ID（workflowId，工作流页面「API调用」中可见）"
      : "AI 应用 ID（webappId，应用详情页 URL 或「API调用」中可见）";
  };
}

function openTool(t) {
  // 每次打开配置弹窗都重置未保存的封面，并展示工具当前封面
  clearPendingCover();
  setCoverPreview(t && t.name ? coverUrlFor(t.name) : null);
  const hint = document.getElementById("coverHint");
  if (hint) hint.textContent = "支持 PNG / JPG，自动居中裁剪缩放为 3:4（600×800），≤8MB";
  const sysHint = document.getElementById("sysToolHint");
  if (sysHint) {
    sysHint.style.display = t && toolSourceOf(t) === "sys" ? "" : "none";
    sysHint.textContent = "这是系统工具：修改会写回系统目录，并在程序更新时被整体覆盖。想长期保留修改，请先在左侧点 ⧉ 复制为我的工具。";
  }

  document.getElementById("tWebappId").value = t ? t.webappId : "";
  document.getElementById("tToolType").value = t ? (t.toolType || "app") : "app";
  document.getElementById("tToolType").dispatchEvent(new Event("change"));
  document.getElementById("tInstanceType").value = t ? (t.instanceType || "default") : "default";
}

// 工具保存后：写入新封面或跟随改名，然后刷新首页并进入工作页
async function afterToolSave(tool, prevName, source) {
  if (!tool) return;
  try {
    if (pendingCoverFile) {
      const fn = await saveCover(tool.name, pendingCoverFile, source);
      clearPendingCover();
      showStatus("封面已保存到 " + (source === "sys" ? "系统工具" : "我的工具") + " 目录/" + fn, "success");
    } else if (prevName && prevName !== tool.name) {
      const fn = await renameCover(prevName, tool.name, source);
      if (fn) showStatus("封面已随工具重命名为 " + fn, "success");
    }
  } catch (err) {
    showStatus("封面保存失败：" + err.message, "error");
  }
  await refreshCoverIndex();
  renderHome();
  showWorkView();
}

export const appPanel = {
  initSettings,
  initToolPanel,
  openTool,
  afterToolSave,
  toolData: () => ({
    webappId: document.getElementById("tWebappId").value.trim(),
    toolType: document.getElementById("tToolType").value,
    instanceType: document.getElementById("tInstanceType").value
  })
};
