// ================= 入口：初始化、事件绑定、模块装配 =================
import { state, activeTool, saveTools, idbGet, idbSet } from "./store.js";
import { renderToolList, refreshToolItemStates } from "./ui/toollist.js";
import { renderWorkspace, showStatus, syncRunControls } from "./ui/form.js";
import "./ui/fieldtypes.js";  // 注册 RunningHub 专属字段类型（随机种子）
import { initPromptWeight } from "./ui/prompt-weight.js";  // 提示词 Ctrl+↑/↓ 调权重
import { renderHome, showHomeView, showWorkView, setToolSearch } from "./ui/home.js";
import { initLightbox } from "./ui/lightbox.js";
import { initModals, initSetupWizard } from "./ui/modal.js";
import { appPanel, refreshKeyBtn } from "./ui/panels.js";
import { scanToolsDir, loadToolsFromDir, toolsDirGranted, resetToolsCache, persistTool, resetSysTools } from "./tools.js";
import { initUpdate } from "./update.js";
import { initAnnouncement } from "./announcement.js";
import { runActiveTool, queueActiveTool, cancelCurrentRun, clearQueuedRuns, restoreResultsSession, resumePendingTask } from "./runner.js";
import { localFetch, setLocalToken } from "./api.js";

let batDownloadDir = "";  // appinfo.txt 第二行：真实磁盘路径（唯一真相，server/资源管理器用）
let serverMode = false;   // 是否通过启动工具.bat（有 server）启动

function renderAll() { renderToolList(renderAll); renderWorkspace(); renderHome(renderAll); }

// ================= 工具函数：从 appinfo.txt 解析两行路径 =================
async function fetchAppinfo() {
  try {
    const r = await fetch("/appinfo");
    if (r.ok) {
      const j = await r.json();
      setLocalToken(j.token);
      if (j.version) {
        const verEl = document.getElementById("appVersion");
        if (verEl) verEl.textContent = "v" + j.version;
      }
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
      setLocalToken(info && info.token);
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
    try { j = await (await localFetch("/pick-download-dir")).json(); }
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
// 返回 appinfo/session 处理完成的 Promise，供启动流程判断「会话是否已就绪」
function initDirState() {
  return (async () => {
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
      const r = await localFetch("/open-dir?path=" + encodeURIComponent(batDownloadDir));
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
// 返回工具列表加载完成的 Promise，供启动流程在工具就绪后再恢复未完成任务
function initToolsDirState() {
  // 本地服务模式：系统工具/我的工具由 server 合并提供，不再使用浏览器目录授权
  if (location.protocol.startsWith("http")) return scanToolsDir(renderAll);
  if (!window.showDirectoryPicker) return scanToolsDir(renderAll);
  return (async () => {
    try {
      const h = await idbGet("toolsDir");
      if (!h) { await scanToolsDir(renderAll); return; }
      state.toolsDirHandle = h;
      if (await toolsDirGranted()) {
        if (!(await loadToolsFromDir(renderAll))) await scanToolsDir(renderAll);
      } else {
        await scanToolsDir(renderAll);
      }
    } catch (e) { await scanToolsDir(renderAll); }
  })();
}

// 重置工具缓存：解决旧缓存与 tools 目录配置不一致（如全部显示「待配置」）
document.getElementById("resetToolsBtn").onclick = async () => {
  if (!confirm("将清除浏览器中的工具列表缓存，并按系统工具 + 我的工具重新加载全部配置。\n\n不会删除任何配置文件，也不会影响 API Key。是否继续？")) return;
  const ok = await resetToolsCache(renderAll);
  if (ok) showStatus("已重置缓存，并重新加载 " + state.tools.length + " 个工具", "ok");
  else showStatus("缓存已清空，但未读到工具配置，请检查 sys_tools / user_tools 目录", "err");
};

// 重置系统工具：从安装包内的 sys_tools.zip 恢复，并清除删除记录
document.getElementById("resetSysToolsBtn").onclick = async () => {
  if (!confirm("将用安装包内的 sys_tools.zip 覆盖恢复全部系统工具，并清除已删除记录。\n\n「我的工具」和下载结果不受影响。是否继续？")) return;
  const btn = document.getElementById("resetSysToolsBtn");
  btn.disabled = true;
  try { await resetSysTools(renderAll); }
  finally { btn.disabled = false; }
};

// ================= 退出程序（仅本地服务模式） =================
// X 仅关闭窗口并保留托盘；此按钮确认后彻底退出，由启动器自动关闭窗口和托盘
function initQuitButton() {
  const btn = document.getElementById("quitBtn");
  if (!btn || !location.protocol.startsWith("http")) return;  // file:// 直接打开时没有后台服务
  btn.style.display = "";
  btn.onclick = async () => {
    if (!confirm("确定彻底退出程序吗？\n\n主窗口、后台服务和系统托盘都会关闭；正在运行的任务可能被中断。")) return;
    btn.disabled = true;
    btn.textContent = "正在退出…";
    try {
      const r = await localFetch("/shutdown", { method: "POST" });
      if (!r.ok) throw new Error("shutdown failed");
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "⏻ 退出程序";
      showStatus("退出失败，请重试或使用系统托盘菜单退出", "err");
    }
  };
}

// ================= 外部链接统一交给系统浏览器 =================
// 应用窗口没有地址栏，站外链接不能在窗口里跳走，否则回不来
function initExternalLinks() {
  if (!location.protocol.startsWith("http")) return;  // file:// 模式保持浏览器默认行为
  document.addEventListener("click", e => {
    const a = e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) return;
    if (a.origin === location.origin) return;
    e.preventDefault();
    localFetch("/open-url?u=" + encodeURIComponent(a.href), { method: "POST" }).catch(() => {});
  }, true);
}

// ================= 把当前面板参数保存为工具默认值 =================
async function saveCurrentDefaults() {
  const t = activeTool();
  if (!t) { showStatus("请先选择一个工具", "error"); return; }
  const btn = document.getElementById("saveDefaultsBtn");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    let count = 0;
    let skippedImages = 0;
    (t.fields || []).forEach((f, i) => {
      if (f.type === "image" || f.type === "audio") { skippedImages++; return; }  // File 对象不写入 JSON 配置
      const el = document.getElementById("ff_" + i);
      if (!el) return;
      const value = el.value;
      if (f.type === "select") {
        // def 同时保存候选列表：当前项移到首位成为默认值，其余选项保持原顺序
        const options = String(f.def || "").split(",").map(v => v.trim()).filter(Boolean);
        f.def = value ? [value, ...options.filter(v => v !== value)].join(",") : options.join(",");
      } else {
        f.def = value;
      }
      if (f.type === "seed") {
        const modeEl = document.getElementById("fm_" + i);
        if (modeEl) f.defMode = modeEl.value;
      }
      count++;
    });
    if (!count) { showStatus("当前工具没有可保存的参数", "error"); return; }

    saveTools();
    delete state.fieldValuesByTool[t.id];  // 清除旧的临时值，刷新后直接读取新默认值
    const fn = await persistTool(t);
    if (!fn) {
      showStatus("默认值已更新，但未能写入配置文件，请检查初始设置中的工具配置目录", "error");
      return;
    }
    showStatus("已保存 " + count + " 项参数为「" + t.name + "」的默认值"
      + (skippedImages ? "（图片/音频除外）" : "") + "：tools/" + fn, "success");
  } catch (err) {
    showStatus("保存默认值失败：" + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ================= 初始化 =================
document.getElementById("saveDefaultsBtn").onclick = saveCurrentDefaults;
document.getElementById("runBtn").onclick = runActiveTool;
document.getElementById("queueBtn").onclick = queueActiveTool;
document.getElementById("cancelBtn").onclick = cancelCurrentRun;
document.getElementById("clearQueueBtn").onclick = clearQueuedRuns;
// 任务状态变化时只刷新列表和按钮，不重建表单
document.addEventListener("tool-status", () => {
  refreshToolItemStates();
  syncRunControls();
});

// 首页入口；点击左侧工具条目后自动进入工作页（分类头的展开/收起不触发）
document.getElementById("homeBtn").onclick = () => showHomeView();
// 顶栏搜索：按工具名称关键词过滤首页工具（Esc 或 ✕ 清除）
(function initToolSearch() {
  const input = document.getElementById("toolSearch");
  const clearBtn = document.getElementById("toolSearchClear");
  if (!input || !clearBtn) return;
  const sync = () => {
    clearBtn.style.display = input.value ? "" : "none";
    setToolSearch(input.value);
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; sync(); input.blur(); }
  });
  clearBtn.onclick = () => { input.value = ""; sync(); input.focus(); };
})();
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

// ================= 首次使用分步向导 =================
(function initUsageGuide() {
  const openBtn = document.getElementById("guideBtn");
  const overlay = document.getElementById("guideOverlay");
  if (!openBtn || !overlay) return;
  const hole = document.getElementById("guideHole");
  const finger = document.getElementById("guideFinger");
  const callout = document.getElementById("guideCallout");
  const calloutText = document.getElementById("guideCalloutText");
  const calloutStep = document.getElementById("guideCalloutStep");
  const calloutNext = document.getElementById("guideCalloutNext");
  const shot = document.getElementById("guideShot");
  const shotImg = document.getElementById("guideShotImg");
  const shotText = document.getElementById("guideShotText");
  const shotStep = document.getElementById("guideShotStep");
  const shotNext = document.getElementById("guideShotNext");

  const steps = [
    { anchor: "#promoRegisterLink", text: "本软件调用Runninghub网站平台提供的API,需要注册Runninghub,点此连接注册赠送网站积分。" },
    { image: "ICO/guide/step1-api.png", text: "注册后点击网站【API】链接。" },
    { image: "ICO/guide/step2-key.png", text: "点击【获取密钥】，获取API-KEY." },
    { image: "ICO/guide/step3-type.png", text: "可获取企业级和消费级API,消费级消耗积分，企业级消耗钱包，建议获取企业级。钱包不随会员到期清空。" },
    { image: "ICO/guide/step4-new.png", text: "点击【新建】创建自己的API-key,并复制。调用企业级API扣除钱包金额，不扣除积分，这点与在网站使用应用与工作流不同，因此需充值钱包，保证钱包余额充足，API与网站使用扣除积分等价，且钱包余额永久有效，不受会员期限限制。" },
    { image: "ICO/guide/step5-recharge.png", text: "充值通道也可以点击自己头像，弹出窗口进行充值。" },
    { anchor: "#keyBtn", text: "点击此按钮填入拷贝的API-KEY即可使用。" }
  ];
  let step = -1;
  let anchorEl = null;
  let shotTries = 0;

  // 截图加载失败（如覆盖安装后旧页面仍引用已被替换的图片）：自动重试一次，仍失败则给出提示
  shotImg.onerror = () => {
    const base = shotImg.dataset.base || "";
    if (!base) return;
    if (shotTries < 1) {
      shotTries++;
      shotImg.src = base + "?r=" + Date.now();
      return;
    }
    shotImg.removeAttribute("src");
    shotText.textContent = "截图加载失败，请重启程序后再试。";
  };

  // 手指步骤：高亮挖孔对准目标元素，手指与提示卡跟随目标位置
  function placeAtAnchor() {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const pad = 5;
    const holeLeft = r.left - pad;
    const holeTop = r.top - pad;
    const holeW = r.width + pad * 2;
    const holeH = r.height + pad * 2;
    hole.style.left = holeLeft + "px";
    hole.style.top = holeTop + "px";
    hole.style.width = holeW + "px";
    hole.style.height = holeH + "px";

    callout.style.visibility = "hidden";
    callout.style.display = "block";
    const cw = callout.offsetWidth;
    const ch = callout.offsetHeight;
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - cw - 12));

    const below = holeTop + holeH + 46;
    if (below + ch > window.innerHeight - 12) {
      // 下方放不下时改为放在目标上方，手指朝下
      finger.textContent = "👇";
      finger.style.top = Math.max(12, holeTop - 44) + "px";
      callout.style.top = Math.max(12, holeTop - 46 - ch) + "px";
    } else {
      finger.textContent = "👆";
      finger.style.top = (holeTop + holeH + 4) + "px";
      callout.style.top = below + "px";
    }
    finger.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 18, window.innerWidth - 46)) + "px";
    callout.style.left = left + "px";
    callout.style.visibility = "";
  }

  function render() {
    const s = steps[step];
    const isShot = !!s.image;
    overlay.classList.add("show");
    overlay.classList.toggle("dim", isShot);
    shot.classList.toggle("show", isShot);
    hole.style.display = isShot ? "none" : "block";
    finger.style.display = isShot ? "none" : "block";
    callout.style.display = isShot ? "none" : "block";
    const progress = (step + 1) + " / " + steps.length;
    if (isShot) {
      shotTries = 0;
      shotImg.dataset.base = s.image;
      shotImg.src = s.image;
      shotText.textContent = s.text;
      shotStep.textContent = progress;
      shotNext.textContent = step === steps.length - 1 ? "完成" : "下一步";
    } else {
      anchorEl = document.querySelector(s.anchor);
      calloutText.textContent = s.text;
      calloutStep.textContent = progress;
      calloutNext.textContent = step === steps.length - 1 ? "完成" : "下一步";
      requestAnimationFrame(placeAtAnchor);
    }
  }

  function closeGuide() {
    overlay.classList.remove("show", "dim");
    shot.classList.remove("show");
    hole.style.display = "none";
    finger.style.display = "none";
    callout.style.display = "none";
    anchorEl = null;
    step = -1;
  }

  function nextStep() {
    if (step >= steps.length - 1) { closeGuide(); return; }
    step++;
    render();
  }

  // 无边框面板：拖动自定义标题栏移动
  function enableDrag(panel, handle) {
    let dragging = false;
    let sx = 0, sy = 0, sl = 0, st = 0, pid = null;
    handle.addEventListener("pointerdown", e => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      dragging = true;
      pid = e.pointerId;
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      panel.style.transform = "none";
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      try { handle.setPointerCapture(pid); } catch (err) {}
    });
    handle.addEventListener("pointermove", e => {
      if (!dragging) return;
      const left = Math.max(4, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth - 4));
      const top = Math.max(4, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight - 4));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (pid !== null) {
        try { handle.releasePointerCapture(pid); } catch (err) {}
        pid = null;
      }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function resetPanelPos(panel) {
    panel.style.left = "";
    panel.style.top = "";
    panel.style.transform = "";
  }

  enableDrag(callout, document.getElementById("guideCalloutBar"));
  enableDrag(shot, document.getElementById("guideShotBar"));

  openBtn.onclick = () => {
    step = 0;
    resetPanelPos(callout);
    resetPanelPos(shot);
    render();
  };
  calloutNext.onclick = nextStep;
  shotNext.onclick = nextStep;
  document.getElementById("guideCalloutClose").onclick = closeGuide;
  document.getElementById("guideShotClose").onclick = closeGuide;
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && step >= 0) closeGuide();
  });
  window.addEventListener("resize", () => {
    if (step >= 0 && !steps[step].image) placeAtAnchor();
  });
})();

initLightbox();
initModals(renderAll, appPanel);
initSetupWizard({ grantToolsDir, grantDownloadDir });
const sessionReady = initDirState();
initOpenDirButton();
initQuitButton();
initExternalLinks();
const toolsReady = initToolsDirState();
initUpdate();
initAnnouncement();
refreshKeyBtn();
initPromptWeight();
renderAll();
showHomeView();  // 启动默认进入工具首页

// 会话与工具列表都就绪后再尝试恢复刷新前未结束的任务：
// 避免工具尚未加载时误判「工具已不存在」，也避免和首次渲染争抢界面
Promise.all([sessionReady, toolsReady])
  .then(() => resumePendingTask())
  .catch(() => {});
