// ================= 入口：初始化、事件绑定、模块装配 =================
import { state, idbGet, idbSet } from "./store.js";
import { renderToolList } from "./ui/toollist.js";
import { renderWorkspace } from "./ui/form.js";
import { renderHome, showHomeView, showWorkView } from "./ui/home.js";
import { initLightbox } from "./ui/lightbox.js";
import { initModals, initSetupWizard } from "./ui/modal.js";
import { appPanel, refreshKeyBtn } from "./ui/panels.js";
import { scanToolsDir, loadToolsFromDir, toolsDirGranted, resetToolsCache } from "./tools.js";
import { runActiveTool, cancelCurrentRun, restoreResultsSession } from "./runner.js";
import { showStatus } from "./ui/form.js";

let batDownloadDir = "";  // appinfo.txt 第二行：真实磁盘路径（唯一真相，server/资源管理器用）
let serverMode = false;   // 是否通过启动工具.bat（有 server）启动

function renderAll() { renderToolList(renderAll); renderWorkspace(); renderHome(renderAll); }

// ================= 工具函数：从 appinfo.txt 解析两行路径 =================
async function fetchAppinfo() {
  try {
    const r = await fetch("/appinfo");
    if (r.ok) {
      const j = await r.json();
      return { tools: j.tools || "", download: j.download || "", session: j.session || "" };
    }
  } catch (e) { /* 非 server 模式，继续尝试静态文件 */ }
  try {
    const r = await fetch("appinfo.txt");
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return { tools: lines[0] || "", download: lines[1] || "", session: "" };
  } catch (e) { return null; }
}

// ================= 下载目录（统一入口：server FolderBrowserDialog + 浏览器授权） =================
/**
 * 设置下载目录：
 *  本地服务模式（启动工具.bat）：只需系统目录框选一次，server 负责把结果文件写进去，浏览器无需授权
 *  非服务模式（file:// 等）：退回浏览器 showDirectoryPicker 授权
 */
let dlGranting = false;            // 防止连点：上一次流程还没结束就再次调用，浏览器会判定「缺少用户手势」

// 反馈直接写进初始设置弹窗：底部 statusBar 会被弹窗遮挡，用户看不到就等于「没反应」
function dlHint(msg) {
  const el = document.getElementById("dlAuthHint");
  if (el) el.textContent = msg || "";
}

async function grantDownloadDir() {
  if (dlGranting) return false;  // 连点第二次直接忽略，避免弹出 "Must be handling a user gesture" 报错
  const dlBtn = document.getElementById("grantDownloadDirBtn");
  dlGranting = true;
  try {

  // 初始化尚未完成时也可能点到授权：先向服务端确认一次，避免误走浏览器授权流程
  if (!serverMode && location.protocol.startsWith("http")) {
    try {
      const info = await (await fetch("/appinfo")).json();
      if (info && (info.tools || info.download)) {
        serverMode = true;
        if (info.download) batDownloadDir = info.download;
      }
    } catch (e) {}
  }

  // 本地服务模式：选一次目录即可，结果由 server 直接保存，不再弹第二个浏览器窗口
  if (serverMode) {
    dlHint("正在等待你在系统窗口中选择目录…（若没看到窗口，请检查任务栏）");
    let j = null;
    try { j = await (await fetch("/pick-download-dir")).json(); }
    catch (e) { /* 旧版服务没有该接口，走下面的浏览器授权 */ }

    if (j && j.cancelled) {
      dlHint("已取消目录选择，可再次点击「选择目录」重试");
      return false;
    }
    if (j && j.ok && j.path) {
      batDownloadDir = j.path;
      document.getElementById("openDirBtn").style.display = "";
      dlHint("📂 " + j.path);
      dlBtn.textContent = "更换目录";
      showStatus("下载目录已设置为 " + j.path + "，生成结果会自动保存到这里", "ok");
      return true;
    }
  }

  if (!window.showDirectoryPicker) {
    dlHint("浏览器不支持目录授权：请使用 Edge/Chrome，并确认是通过「启动工具.bat」启动");
    return false;
  }

  // 浏览器 File System Access 授权（file:// 打开时的兜底方案）
  try {
    const pickerOpts = { mode: "readwrite" };
    if (state.dirHandle) pickerOpts.startIn = state.dirHandle;
    else if (state.toolsDirHandle) pickerOpts.startIn = state.toolsDirHandle;
    state.dirHandle = await showDirectoryPicker(pickerOpts);
    await idbSet("dir", state.dirHandle);
    dlBtn.textContent = "更换目录";
    // 两处选择若指向不同文件夹，「打开下载目录」会开错位置，必须提示
    const sysName = (batDownloadDir || "").split(/[\\/]/).filter(Boolean).pop();
    if (sysName && state.dirHandle.name && sysName !== state.dirHandle.name) {
      dlHint("⚠️ 浏览器授权的是「" + state.dirHandle.name + "」，与系统选择的「" + sysName + "」不一致，请重新授权同一个文件夹");
    } else {
      dlHint("");
    }
    return true;
  } catch (e) {
    const msg = e && e.message ? e.message : "";
    if (e && e.name === "AbortError") {
      dlHint("已取消浏览器授权，可再次点击「选择目录」重试");
    } else if (/user gesture|user activation/i.test(msg)) {
      dlHint("浏览器没有弹出授权窗口（安全限制），请再点一次右侧按钮");
    } else {
      dlHint("浏览器授权未完成：" + (msg || "未知错误"));
    }
    return false;
  }

  } finally {
    dlGranting = false;
  }
}

// 仅补浏览器权限（不改目录，不弹系统对话框）
async function ensureDownloadDirPerm() {
  if (!state.dirHandle) return false;
  try {
    if ((await state.dirHandle.queryPermission({ mode: "readwrite" })) === "granted") return true;
    if ((await state.dirHandle.requestPermission({ mode: "readwrite" })) === "granted") {
      return true;
    }
  } catch (e) {}
  return false;
}

// 下载目录状态初始化（授权入口已统一到顶栏「初始设置」）
function initDirState() {
  (async () => {
    const info = await fetchAppinfo();
    if (info) {
      // 同一程序会话内刷新页面 → 结果和参数保留；重启启动工具.bat → session 变化 → 清空
      if (info.session && restoreResultsSession(info.session)) renderAll();
      if (info.download) {
        serverMode = true;
        batDownloadDir = info.download;
        document.getElementById("openDirBtn").style.display = "";
      }
    }

    if (!window.showDirectoryPicker) return;
    try {
      const h = await idbGet("dir");
      if (h) state.dirHandle = h;
    } catch (e) {}
  })();
}

// ================= 打开下载目录（server 侧 /open-dir） =================
function initOpenDirButton() {
  const btn = document.getElementById("openDirBtn");
  btn.onclick = async () => {
    if (!batDownloadDir) { showStatus("尚未配置下载目录，请先点击顶栏「初始设置」完成授权", "err"); return; }
    try {
      const r = await fetch("/open-dir?path=" + encodeURIComponent(batDownloadDir));
      const j = await r.json();
      if (j.ok) showStatus("📂 已打开资源管理器：" + batDownloadDir, "ok");
      else showStatus("打开失败：" + (j.error || "未知错误"), "err");
    } catch (e) { showStatus("打开失败，请确认是通过「启动工具.bat」启动的", "err"); }
  };
}

// ================= 配置目录授权（tools/ 作为工具配置唯一数据源） =================
async function grantToolsDir() {
  try {
    if (!state.toolsDirHandle) {
      state.toolsDirHandle = await showDirectoryPicker({ mode: "readwrite", ...(state.dirHandle ? { startIn: state.dirHandle } : {}) });
      await idbSet("toolsDir", state.toolsDirHandle);
    } else if (!(await toolsDirGranted())) {
      if ((await state.toolsDirHandle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
    }
    if (await loadToolsFromDir(renderAll)) showStatus("已从配置目录读取工具列表", "ok");
    return true;
  } catch (e) { return false; }
}

// 配置目录状态初始化（授权入口已统一到顶栏「初始设置」）
function initToolsDirState() {
  if (!window.showDirectoryPicker) { scanToolsDir(renderAll); return; }
  (async () => {
    try {
      const h = await idbGet("toolsDir");
      if (!h) { scanToolsDir(renderAll); return; }
      state.toolsDirHandle = h;
      if (await toolsDirGranted()) {
        if (!(await loadToolsFromDir(renderAll))) scanToolsDir(renderAll);
      } else {
        scanToolsDir(renderAll);
      }
    } catch (e) { scanToolsDir(renderAll); }
  })();
}

// 重置工具缓存：解决旧缓存与 tools 目录配置不一致（如全部显示「待配置」）
document.getElementById("resetToolsBtn").onclick = async () => {
  if (!confirm("将清除浏览器中的工具列表缓存，并按 tools 目录重新加载全部工具配置。\n\n不会删除任何配置文件，也不会影响 API Key。是否继续？")) return;
  const ok = await resetToolsCache(renderAll);
  if (ok) showStatus("已重置缓存，并重新加载 " + state.tools.length + " 个工具", "ok");
  else showStatus("缓存已清空，但未读到工具配置，请检查 tools 目录或点击「配置目录」授权", "err");
};

// ================= 初始化 =================
document.getElementById("runBtn").onclick = runActiveTool;
document.getElementById("cancelBtn").onclick = cancelCurrentRun;

// 首页入口；点击左侧工具条目后自动进入工作页（分类头的展开/收起不触发）
document.getElementById("homeBtn").onclick = () => showHomeView();
document.getElementById("toolList").addEventListener("click", e => {
  if (e.target.closest(".tool-item")) showWorkView();
});
// 首页卡片上传封面时若未授权配置目录，由首页触发授权流程
document.addEventListener("rh:grant-tools-dir", () => { grantToolsDir(); });

(function initRepoCopy() {
  const btn = document.getElementById("repoCopyBtn");
  const REPO_URL = "https://github.com/jita45927/runninghub_api";
  btn.onclick = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(REPO_URL); ok = true; }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = REPO_URL; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch (e2) {}
      ta.remove();
    }
    const orig = btn.textContent;
    btn.textContent = ok ? "✅ 已复制" : "❌ 复制失败";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
  };
})();

initLightbox();
initModals(renderAll, appPanel);
initSetupWizard({ grantToolsDir, grantDownloadDir });
initDirState();
initOpenDirButton();
initToolsDirState();
refreshKeyBtn();
renderAll();
showHomeView();  // 启动默认进入工具首页
