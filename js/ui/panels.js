// ================= RunningHub 专属设置与工具配置面板 =================
import { LS, esc } from "../config.js";
import { getAccountStatus } from "../api.js";

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
}

function initToolPanel() {
  // 类型切换时更新 ID 字段的说明文字
  document.getElementById("tToolType").onchange = e => {
    document.getElementById("tWebappIdLabel").textContent = e.target.value === "workflow"
      ? "工作流 ID（workflowId，工作流页面「API调用」中可见）"
      : "AI 应用 ID（webappId，应用详情页 URL 或「API调用」中可见）";
  };
}

function openTool(t) {
  document.getElementById("tWebappId").value = t ? t.webappId : "";
  document.getElementById("tToolType").value = t ? (t.toolType || "app") : "app";
  document.getElementById("tToolType").dispatchEvent(new Event("change"));
  document.getElementById("tInstanceType").value = t ? (t.instanceType || "default") : "default";
}

export const appPanel = {
  initSettings,
  initToolPanel,
  openTool,
  toolData: () => ({
    webappId: document.getElementById("tWebappId").value.trim(),
    toolType: document.getElementById("tToolType").value,
    instanceType: document.getElementById("tInstanceType").value
  })
};
