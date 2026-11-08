// ================= 入口：初始化、事件绑定、模块装配 =================
import { state, idbGet, idbSet } from "./store.js";
import { renderToolList } from "./ui/toollist.js";
import { renderWorkspace } from "./ui/form.js";
import { initLightbox } from "./ui/lightbox.js";
import { initModals, refreshKeyBtn } from "./ui/modal.js";
import { scanToolsDir } from "./tools.js";
import { runActiveTool, cancelCurrentRun } from "./runner.js";

function renderAll() { renderToolList(renderAll); renderWorkspace(); }

// ================= 自定义下载目录（File System Access API） =================
function updateDirBtn(extra) {
  document.getElementById("dirBtnText").textContent =
    "下载目录：" + (state.dirHandle ? state.dirHandle.name : "默认") + (extra || "");
}

function initDirButton() {
  document.getElementById("dirBtn").onclick = async () => {
    if (!window.showDirectoryPicker) {
      alert("当前浏览器不支持自定义下载目录，请使用 Edge 或 Chrome");
      return;
    }
    try {
      // 已有记住的目录但权限失效时，先补授权
      if (state.dirHandle && (await state.dirHandle.queryPermission({ mode: "readwrite" })) !== "granted") {
        if ((await state.dirHandle.requestPermission({ mode: "readwrite" })) === "granted") {
          updateDirBtn();
          return;
        }
      }
      state.dirHandle = await showDirectoryPicker({ mode: "readwrite" });
      await idbSet("dir", state.dirHandle);
      updateDirBtn();
    } catch (e) { /* 用户取消选择 */ }
  };

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

// ================= 初始化 =================
document.getElementById("runBtn").onclick = runActiveTool;
document.getElementById("cancelBtn").onclick = cancelCurrentRun;

initLightbox();
initModals(renderAll);
initDirButton();
refreshKeyBtn();
renderAll();
scanToolsDir(renderAll);
