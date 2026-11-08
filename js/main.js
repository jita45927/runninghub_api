// ================= 入口：初始化、事件绑定、模块装配 =================
import { state, idbGet, idbSet } from "./store.js";
import { renderToolList } from "./ui/toollist.js";
import { renderWorkspace } from "./ui/form.js";
import { initLightbox } from "./ui/lightbox.js";
import { initModals, initSetupWizard, refreshKeyBtn } from "./ui/modal.js";
import { scanToolsDir, loadToolsFromDir, toolsDirGranted } from "./tools.js";
import { runActiveTool, cancelCurrentRun } from "./runner.js";
import { showStatus } from "./ui/form.js";

function renderAll() { renderToolList(renderAll); renderWorkspace(); }

// ================= 自定义下载目录（File System Access API） =================
function updateDirBtn(extra) {
  document.getElementById("dirBtnText").textContent =
    "下载目录：" + (state.dirHandle ? state.dirHandle.name : "默认") + (extra || "");
}

// 授权下载目录（供顶栏按钮和初始设置向导复用），返回是否成功
async function grantDownloadDir() {
  if (!window.showDirectoryPicker) {
    alert("当前浏览器不支持自定义下载目录，请使用 Edge 或 Chrome");
    return false;
  }
  try {
    // 已有记住的目录但权限失效时，先补授权
    if (state.dirHandle && (await state.dirHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
      if ((await state.dirHandle.requestPermission({ mode: "readwrite" })) === "granted") {
        updateDirBtn();
        return true;
      }
    }
    state.dirHandle = await showDirectoryPicker({ mode: "readwrite", ...(state.toolsDirHandle ? { startIn: state.toolsDirHandle } : {}) });
    await idbSet("dir", state.dirHandle);
    updateDirBtn();
    return true;
  } catch (e) { return false; }  // 用户取消选择
}

function initDirButton() {
  document.getElementById("dirBtn").onclick = grantDownloadDir;

  // 页面打开时尝试恢复上次选择的目录和选图位置
  (async () => {
    try { state.lastImgHandle = (await idbGet("lastImg")) || null; } catch (e) {}  // 恢复上次选图目录
    if (!window.showDirectoryPicker) return;
    try {
      const h = await idbGet("dir");
      if (!h) return;
      state.dirHandle = h;
      const perm = await h.queryPermission({ mode: "readwrite" });
      updateDirBtn(perm === "granted" ? "" : "（点我授权）");
    } catch (e) {}
  })();
}

// ================= 配置目录授权（tools/ 作为工具配置唯一数据源） =================
function updateToolsDirBtn(text) {
  document.getElementById("toolsDirBtn").textContent = "🗂 配置目录：" +
    (text || (state.toolsDirHandle ? "已授权（" + state.toolsDirHandle.name + "）" : "未授权"));
}

// 授权配置目录（供侧栏按钮和初始设置向导复用），返回是否成功
async function grantToolsDir() {
  try {
    if (!state.toolsDirHandle) {
      // 首次授权：选择 tools 目录
      state.toolsDirHandle = await showDirectoryPicker({ mode: "readwrite", ...(state.dirHandle ? { startIn: state.dirHandle } : {}) });
      await idbSet("toolsDir", state.toolsDirHandle);
    } else if (!(await toolsDirGranted())) {
      // 已记住目录但权限为 prompt：借点击手势补授权
      if ((await state.toolsDirHandle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
    }
    updateToolsDirBtn();
    if (await loadToolsFromDir(renderAll)) showStatus("已从配置目录读取工具列表", "ok");
    return true;
  } catch (e) { return false; }  // 用户取消选择
}

function initToolsDirButton() {
  const btn = document.getElementById("toolsDirBtn");
  // 浏览器不支持 File System Access 时隐藏按钮，整体回退为 HTTP 扫描 + localStorage
  if (!window.showDirectoryPicker) { btn.style.display = "none"; scanToolsDir(renderAll); return; }

  btn.onclick = grantToolsDir;

  // 页面打开时尝试恢复上次授权的目录
  (async () => {
    try {
      const h = await idbGet("toolsDir");
      if (!h) { updateToolsDirBtn(); scanToolsDir(renderAll); return; }  // 从未授权：保持原有 HTTP 扫描
      state.toolsDirHandle = h;
      if (await toolsDirGranted()) {
        updateToolsDirBtn();
        if (!(await loadToolsFromDir(renderAll))) scanToolsDir(renderAll);  // 句柄失效时回退
      } else {
        updateToolsDirBtn("点我授权（" + h.name + "）");  // 权限为 prompt，需用户手势补授权
        scanToolsDir(renderAll);
      }
    } catch (e) { scanToolsDir(renderAll); }
  })();
}

// ================= 初始化 =================
document.getElementById("runBtn").onclick = runActiveTool;
document.getElementById("cancelBtn").onclick = cancelCurrentRun;

initLightbox();
initModals(renderAll);
initSetupWizard({ grantToolsDir, grantDownloadDir });
initDirButton();
initToolsDirButton();
refreshKeyBtn();
renderAll();
