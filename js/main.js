// ================= 入口：初始化、事件绑定、模块装配 =================
import { state, idbGet, idbSet } from "./store.js";
import { renderToolList } from "./ui/toollist.js";
import { renderWorkspace } from "./ui/form.js";
import { initLightbox } from "./ui/lightbox.js";
import { initModals, initSetupWizard } from "./ui/modal.js";
import { appPanel, refreshKeyBtn } from "./ui/panels.js";
import { scanToolsDir, loadToolsFromDir, toolsDirGranted, resetToolsCache } from "./tools.js";
import { runActiveTool, cancelCurrentRun } from "./runner.js";
import { showStatus } from "./ui/form.js";

let batDownloadDir = "";  // appinfo.txt 第二行：真实磁盘路径（唯一真相，server/资源管理器用）
let serverMode = false;   // 是否通过启动工具.bat（有 server）启动

function renderAll() { renderToolList(renderAll); renderWorkspace(); }

// ================= 工具函数：从 appinfo.txt 解析两行路径 =================
async function fetchAppinfo() {
  try {
    const r = await fetch("appinfo.txt");
    if (!r.ok) return null;
    const text = await r.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    return { tools: lines[0] || "", download: lines[1] || "" };
  } catch (e) { return null; }
}

// ================= 下载目录（统一入口：server FolderBrowserDialog + 浏览器授权） =================
function updateDirBtn(extra) {
  const label = batDownloadDir
    ? batDownloadDir.replace(/\\/g, "/")
    : (state.dirHandle ? state.dirHandle.name : "默认");
  document.getElementById("dirBtnText").textContent = "下载目录：" + label + (extra || "");
}

/**
 * 完整授权下载目录流程：
 *  1. 调 server /pick-download-dir 弹系统 FolderBrowserDialog → 拿到真实磁盘路径 → 写回 appinfo.txt
 *  2. 浏览器 showDirectoryPicker({ startIn: 该路径 }) 做 File System Access 授权
 *  3. 两者指向同一物理位置，runner.js 用 dirHandle 保存，server 用 batDownloadDir 打开资源管理器
 */
let pendingDlBrowserAuth = false;  // 系统目录框已选完，等待第二次点击完成浏览器授权

// 反馈直接写进初始设置弹窗：底部 statusBar 会被弹窗遮挡，用户看不到就等于「没反应」
function dlHint(msg) {
  const el = document.getElementById("dlAuthHint");
  if (el) el.textContent = msg || "";
}

async function grantDownloadDir() {
  if (!window.showDirectoryPicker) {
    alert("当前浏览器不支持自定义下载目录，请使用 Edge 或 Chrome");
    return false;
  }
  const dlBtn = document.getElementById("grantDownloadDirBtn");

  // Step 1: 让 server 弹系统目录选择框（拿真实磁盘路径字符串）
  // 注意：选目录耗时较长，浏览器要求的「用户点击激活」会失效，
  // 因此选完后必须让用户再点一次按钮，才能调 showDirectoryPicker
  if (serverMode && !pendingDlBrowserAuth) {
    dlHint("正在等待你在系统窗口中选择目录…（若没看到窗口，请检查任务栏）");
    let j = null;
    try { j = await (await fetch("/pick-download-dir")).json(); }
    catch (e) { /* server 不可用时降级为纯浏览器授权 */ }

    if (j && j.cancelled) {
      dlHint("已取消目录选择，可再次点击「去授权」重试");
      showStatus("已取消目录选择", "err");
      return false;
    }
    if (j && j.ok && j.path) {
      batDownloadDir = j.path;
      document.getElementById("openDirBtn").style.display = "";
      pendingDlBrowserAuth = true;
      dlBtn.textContent = "② 完成浏览器授权";
      dlHint("已选择：" + j.path + "\n请再点一次右侧按钮，在随后弹出的窗口中选中同一个文件夹（浏览器安全限制，必须再点一次）");
      showStatus("已选择下载目录，请再次点击按钮完成浏览器授权", "ok");
      return false;
    }
    dlHint("");
  }

  // Step 2: 浏览器 File System Access 授权
  try {
    const pickerOpts = { mode: "readwrite" };
    if (state.dirHandle) pickerOpts.startIn = state.dirHandle;
    else if (state.toolsDirHandle) pickerOpts.startIn = state.toolsDirHandle;
    state.dirHandle = await showDirectoryPicker(pickerOpts);
    await idbSet("dir", state.dirHandle);
    pendingDlBrowserAuth = false;
    dlBtn.textContent = "去授权";
    updateDirBtn();
    // 两处选择若指向不同文件夹，「打开下载目录」会开错位置，必须提示
    const sysName = (batDownloadDir || "").split(/[\\/]/).filter(Boolean).pop();
    if (sysName && state.dirHandle.name && sysName !== state.dirHandle.name) {
      dlHint("⚠️ 浏览器授权的是「" + state.dirHandle.name + "」，与系统选择的「" + sysName + "」不一致，请重新授权同一个文件夹");
    } else {
      dlHint("");
    }
    return true;
  } catch (e) {
    dlHint("浏览器授权未完成：" + (e && e.message ? e.message : "已取消"));
    return false;
  }
}

// 仅补浏览器权限（不改目录，不弹系统对话框）
async function ensureDownloadDirPerm() {
  if (!state.dirHandle) return false;
  try {
    if ((await state.dirHandle.queryPermission({ mode: "readwrite" })) === "granted") return true;
    if ((await state.dirHandle.requestPermission({ mode: "readwrite" })) === "granted") {
      updateDirBtn();
      return true;
    }
  } catch (e) {}
  return false;
}

function initDirButton() {
  const btn = document.getElementById("dirBtn");

  // 页面打开时检测 serverMode，读取 appinfo.txt 第二行作为初始 batDownloadDir
  (async () => {
    const info = await fetchAppinfo();
    if (info && info.download) {
      serverMode = true;
      batDownloadDir = info.download;
      document.getElementById("openDirBtn").style.display = "";
    }

    if (!window.showDirectoryPicker) return;
    try {
      const h = await idbGet("dir");
      if (!h) { updateDirBtn(); return; }
      state.dirHandle = h;
      const perm = await h.queryPermission({ mode: "readwrite" });
      updateDirBtn(perm === "granted" ? "" : "（点我授权）");
    } catch (e) { updateDirBtn(); }
  })();

  btn.onclick = async () => {
    // 如果已有 handle 且权限 OK，走完整换目录流程（用户主动点 = 想换或确认）
    // 否则走完整 grantDownloadDir（系统弹 + 浏览器弹）
    await grantDownloadDir();
  };
}

// ================= 打开下载目录（server 侧 /open-dir） =================
function initOpenDirButton() {
  const btn = document.getElementById("openDirBtn");
  btn.onclick = async () => {
    if (!batDownloadDir) { showStatus("尚未配置下载目录，请先点击顶栏「下载目录」按钮选择", "err"); return; }
    try {
      const r = await fetch("/open-dir?path=" + encodeURIComponent(batDownloadDir));
      const j = await r.json();
      if (j.ok) showStatus("📂 已打开资源管理器：" + batDownloadDir, "ok");
      else showStatus("打开失败：" + (j.error || "未知错误"), "err");
    } catch (e) { showStatus("打开失败，请确认是通过「启动工具.bat」启动的", "err"); }
  };
}

// ================= 配置目录授权（tools/ 作为工具配置唯一数据源） =================
function updateToolsDirBtn(text) {
  document.getElementById("toolsDirBtn").textContent = "🗂 配置目录：" +
    (text || (state.toolsDirHandle ? "已授权（" + state.toolsDirHandle.name + "）" : "未授权"));
}

async function grantToolsDir() {
  try {
    if (!state.toolsDirHandle) {
      state.toolsDirHandle = await showDirectoryPicker({ mode: "readwrite", ...(state.dirHandle ? { startIn: state.dirHandle } : {}) });
      await idbSet("toolsDir", state.toolsDirHandle);
    } else if (!(await toolsDirGranted())) {
      if ((await state.toolsDirHandle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
    }
    updateToolsDirBtn();
    if (await loadToolsFromDir(renderAll)) showStatus("已从配置目录读取工具列表", "ok");
    return true;
  } catch (e) { return false; }
}

function initToolsDirButton() {
  const btn = document.getElementById("toolsDirBtn");
  if (!window.showDirectoryPicker) { btn.style.display = "none"; scanToolsDir(renderAll); return; }

  btn.onclick = grantToolsDir;

  (async () => {
    try {
      const h = await idbGet("toolsDir");
      if (!h) { updateToolsDirBtn(); scanToolsDir(renderAll); return; }
      state.toolsDirHandle = h;
      if (await toolsDirGranted()) {
        updateToolsDirBtn();
        if (!(await loadToolsFromDir(renderAll))) scanToolsDir(renderAll);
      } else {
        updateToolsDirBtn("点我授权（" + h.name + "）");
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
initDirButton();
initOpenDirButton();
initToolsDirButton();
refreshKeyBtn();
renderAll();
