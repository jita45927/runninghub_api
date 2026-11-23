// ================= 程序自动更新 =================
// 启动静默检查；点击「立即更新」→ 下载 → 校验 → 静默安装 → 自动重启
import { localFetch } from "./api.js";
import { showStatus } from "./ui/form.js";

const FALLBACK_PAGE = "https://github.com/jita45927/runninghub_api/releases";

let latestInfo = null;
let polling = null;
let countdownTimer = null;

const $ = id => document.getElementById(id);

function setStatus(text, kind) {
  const el = $("updateStatus");
  if (el) {
    el.textContent = text || "";
    el.className = "update-meta" + (kind ? " " + kind : "");
  }
  if (text && kind === "error") showStatus(text, "error");
}

function setBar(percent) {
  const fill = $("updateBarFill");
  if (fill) fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + "%";
}

function openModal() {
  const m = $("updateModal");
  if (m) m.classList.add("show");
}

function setButtons({ now, manual, cancel }) {
  if ($("updateNowBtn")) $("updateNowBtn").style.display = now ? "" : "none";
  if ($("updateManualBtn")) $("updateManualBtn").style.display = manual ? "" : "none";
  if ($("updateCancelBtn")) $("updateCancelBtn").style.display = cancel ? "" : "none";
}

function stopPolling() {
  if (polling) { clearInterval(polling); polling = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

async function checkUpdate(silent) {
  if (!location.protocol.startsWith("http")) return;
  try {
    const r = await localFetch("/update/check", { method: "POST" });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || "检查更新失败");
    latestInfo = j;
    const btn = $("checkUpdateBtn");
    if (j.hasUpdate) {
      if (btn) {
        btn.style.display = "";
        btn.textContent = "⬆ 有新版本 v" + j.latest;
        btn.classList.add("update-available");
      }
      if (!silent) {
        $("updateVersion").textContent = "当前版本 v" + j.current + " → 最新版本 v" + j.latest;
        $("updateNotes").textContent = j.notes || "本次更新没有提供说明。";
        setStatus("发现新版本，可立即更新（程序会自动关闭并重新启动）。");
        setButtons({ now: true, manual: true, cancel: false });
        openModal();
      }
    } else {
      if (btn) {
        btn.style.display = "";
        btn.textContent = "🔄 检查更新";
        btn.classList.remove("update-available");
      }
      if (!silent) {
        $("updateVersion").textContent = "当前已是最新版本 v" + j.current;
        $("updateNotes").textContent = "";
        setStatus("无需更新。");
        setButtons({ now: false, manual: false, cancel: false });
        openModal();
      }
    }
  } catch (e) {
    if (!silent) {
      $("updateVersion").textContent = "检查更新失败";
      $("updateNotes").textContent = "";
      setStatus(e.message || "无法连接到更新服务器", "error");
      setButtons({ now: false, manual: true, cancel: false });
      openModal();
    }
  }
}

async function pollProgress() {
  if (!location.protocol.startsWith("http")) return;
  try {
    const j = await (await localFetch("/update/progress")).json();
    if (!j || !j.ok) return;
    if (j.state === "downloading" || j.state === "starting") {
      setBar(j.percent || 0);
      const mb = v => (Number(v || 0) / 1048576).toFixed(1);
      setStatus("正在下载安装包… " + (j.percent || 0) + "%（" + mb(j.received) + " / " + mb(j.total) + " MB）");
      setButtons({ now: false, manual: false, cancel: true });
    } else if (j.state === "ready") {
      stopPolling();
      setBar(100);
      setStatus("下载完成，安装包校验通过。3 秒后自动安装并重启程序…");
      setButtons({ now: false, manual: false, cancel: false });
      let left = 3;
      countdownTimer = setInterval(() => {
        left--;
        if (left > 0) { setStatus("下载完成，安装包校验通过。" + left + " 秒后自动安装并重启程序…"); return; }
        clearInterval(countdownTimer);
        countdownTimer = null;
        installUpdate();
      }, 1000);
    } else if (j.state === "error" || j.state === "cancelled") {
      stopPolling();
      setStatus(j.state === "cancelled" ? "已取消下载。" : ("更新失败：" + (j.error || "下载失败") + "，可尝试手动下载。"), j.state === "error" ? "error" : "");
      setButtons({ now: true, manual: true, cancel: false });
    }
  } catch (e) { /* 服务重启或网络抖动时忽略下一次轮询会继续 */ }
}

async function startDownload() {
  try {
    setButtons({ now: false, manual: false, cancel: true });
    setBar(0);
    setStatus("正在准备下载…");
    const r = await localFetch("/update/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && j.error) || "下载失败");
    stopPolling();
    polling = setInterval(pollProgress, 500);
    pollProgress();
  } catch (e) {
    setStatus(e.message || "下载失败，可尝试手动下载", "error");
    setButtons({ now: true, manual: true, cancel: false });
  }
}

async function cancelDownload() {
  try { await localFetch("/update/cancel", { method: "POST" }); } catch (e) {}
  stopPolling();
  setStatus("已取消下载。");
  setButtons({ now: true, manual: true, cancel: false });
}

async function installUpdate() {
  try {
    setStatus("正在关闭程序并安装新版本，请稍候…");
    const r = await localFetch("/update/install", { method: "POST" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && j.error) || "安装失败");
  } catch (e) {
    setStatus("安装失败：" + (e.message || "未知错误") + "，可尝试手动下载安装。", "error");
    setButtons({ now: true, manual: true, cancel: false });
  }
}

function manualDownload() {
  const page = (latestInfo && latestInfo.page) || FALLBACK_PAGE;
  if (location.protocol.startsWith("http")) {
    localFetch("/open-url?u=" + encodeURIComponent(page), { method: "POST" }).catch(() => {});
  } else {
    window.open(page, "_blank");
  }
}

export function initUpdate() {
  if (!location.protocol.startsWith("http")) return;
  const btn = $("checkUpdateBtn");
  btn.style.display = "";
  btn.onclick = () => {
    openModal();
    $("updateVersion").textContent = "正在检查最新版本…";
    $("updateNotes").textContent = "";
    setBar(0);
    setStatus("");
    setButtons({ now: false, manual: false, cancel: false });
    checkUpdate(false);
  };
  const nowBtn = $("updateNowBtn");
  if (nowBtn) nowBtn.onclick = () => {
    if (latestInfo && latestInfo.hasUpdate) startDownload();
    else checkUpdate(false);
  };
  const manualBtn = $("updateManualBtn");
  if (manualBtn) manualBtn.onclick = manualDownload;
  const cancelBtn = $("updateCancelBtn");
  if (cancelBtn) cancelBtn.onclick = cancelDownload;
  const laterBtn = $("updateLaterBtn");
  if (laterBtn) laterBtn.onclick = () => {
    // 安装倒计时期间关闭弹窗等同于取消倒计时
    if (countdownTimer) { stopPolling(); setStatus("已取消本次自动安装，可稍后重新检查更新。"); }
  };
  // 启动静默检查：失败不打扰用户
  checkUpdate(true);
}
