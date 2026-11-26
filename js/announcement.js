// ================= 公众号公告 =================
// 启动后静默检查，页面打开期间每 3 小时检查一次；失败一律静默，不打扰生成任务。
import { localFetch } from "./api.js";
import { LS, esc } from "./config.js";

const CHECK_DELAY = 3000;
const CHECK_INTERVAL = 3 * 60 * 60 * 1000;
const MAX_SEEN = 200;
const ALLOWED_HOST = "mp.weixin.qq.com";

const $ = id => document.getElementById(id);

let items = [];
let seenIds = [];

// 公告链接只允许微信公众号文章：服务端已校验一次，这里渲染前再校验一次
function isSafeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === ALLOWED_HOST
      && !u.username && !u.password && u.port === "";
  } catch (e) { return false; }
}

function loadSeen() {
  try {
    const raw = localStorage.getItem(LS.annSeen);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.seenIds)) return null;
    return obj.seenIds.map(String).filter(Boolean).slice(-MAX_SEEN);
  } catch (e) { return null; }
}

function saveSeen() {
  try {
    localStorage.setItem(LS.annSeen, JSON.stringify({ seenIds: seenIds.slice(-MAX_SEEN) }));
  } catch (e) { }
}

function markSeen(ids) {
  let changed = false;
  ids.forEach(id => {
    if (!id || seenIds.indexOf(id) >= 0) return;
    seenIds.push(id);
    changed = true;
  });
  if (changed) {
    if (seenIds.length > MAX_SEEN) seenIds = seenIds.slice(-MAX_SEEN);
    saveSeen();
  }
  return changed;
}

function renderBadge() {
  const badge = $("annBadge");
  if (!badge) return;
  const n = items.filter(it => seenIds.indexOf(it.id) < 0).length;
  badge.textContent = n ? (n > 99 ? "99+" : String(n)) : "";
  badge.style.display = n ? "" : "none";
}

function renderList() {
  const list = $("annList");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="ann-empty">暂无公告</div>';
    return;
  }
  list.innerHTML = items.map(it => {
    const unread = seenIds.indexOf(it.id) < 0;
    const summary = it.summary ? '<p class="ann-summary">' + esc(it.summary) + "</p>" : "";
    return '<a class="ann-item' + (unread ? " unread" : "") + '" data-ann-id="' + esc(it.id) + '"'
      + ' href="' + esc(it.url) + '" target="_blank" rel="noopener">'
      + '<div class="ann-item-head"><span class="ann-title">' + esc(it.title) + "</span>"
      + '<span class="ann-date">' + esc(it.publishedAt) + "</span></div>"
      + summary + "</a>";
  }).join("");
}

async function checkAnnouncements() {
  if (!location.protocol.startsWith("http")) return;
  try {
    const r = await localFetch("/announcement/check", { method: "POST" });
    const j = await r.json();
    if (!r.ok || !j || !j.ok || !Array.isArray(j.items)) return;
    // 非法条目直接丢弃，整份清单异常时视为无公告
    items = j.items.filter(it => it && it.id && it.title && isSafeUrl(it.url));
    const stored = loadSeen();
    if (stored === null) {
      // 首次成功拉取：把当前全部条目基线为已读，避免新装用户被历史公告轰炸
      seenIds = items.map(it => String(it.id)).slice(-MAX_SEEN);
      saveSeen();
    } else {
      seenIds = stored;
    }
    renderBadge();
    renderList();
  } catch (e) { /* 断网、清单缺失、超时等一律静默 */ }
}

export function initAnnouncement() {
  const btn = $("annBtn");
  if (!btn) return;
  if (!location.protocol.startsWith("http")) { btn.style.display = "none"; return; }
  btn.style.display = "";
  seenIds = loadSeen() || [];
  btn.onclick = () => {
    renderList();
    $("annModal").classList.add("show");
  };
  const readAll = $("annReadAllBtn");
  if (readAll) readAll.onclick = () => {
    markSeen(items.map(it => it.id));
    renderBadge();
    renderList();
  };
  // 点击条目立即记已读；链接由 main.js 的外部链接拦截统一交给系统浏览器打开
  const list = $("annList");
  if (list) list.addEventListener("click", e => {
    const a = e.target.closest(".ann-item");
    if (!a) return;
    if (markSeen([a.dataset.annId || ""])) {
      a.classList.remove("unread");
      renderBadge();
    }
  });
  setTimeout(checkAnnouncements, CHECK_DELAY);
  setInterval(checkAnnouncements, CHECK_INTERVAL);
}
