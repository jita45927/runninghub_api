// ================= 图片预览灯箱（滚轮缩放 / 中键拖动 / objectURL 回收） =================
import { state } from "../store.js";

// 图片预览 objectURL 缓存：同一 File 复用不重复创建，灯箱关闭时回收不再使用的
const previewUrls = new Map();  // File -> objectURL
export function previewUrlFor(file) {
  let u = previewUrls.get(file);
  if (!u) { u = URL.createObjectURL(file); previewUrls.set(file, u); }
  return u;
}
function revokeUnusedPreviewUrls() {
  const live = new Set();
  Object.values(state.fieldFilesByTool).forEach(m => Object.values(m).forEach(f => live.add(f)));
  for (const [file, url] of previewUrls) {
    if (!live.has(file)) { URL.revokeObjectURL(url); previewUrls.delete(file); }
  }
}

let lbScale = 1, lbX = 0, lbY = 0;
function lbApply() {
  document.getElementById("lbImg").style.transform =
    "translate(" + lbX + "px," + lbY + "px) scale(" + lbScale + ")";
}
export function openLightbox(url) {
  lbScale = 1; lbX = 0; lbY = 0;
  const img = document.getElementById("lbImg");
  img.src = url; lbApply();
  document.getElementById("lbDownload").href = url;
  document.getElementById("lightbox").classList.add("show");
}

// 绑定灯箱全部交互（结果图点击预览用事件委托，兼容动态渲染的结果）
export function initLightbox() {
  const lightbox = document.getElementById("lightbox");
  document.getElementById("resultArea").addEventListener("click", e => {
    if (e.target.matches(".result-item img")) openLightbox(e.target.src);
  });
  // 滚轮缩放预览图
  lightbox.addEventListener("wheel", e => {
    e.preventDefault();
    lbScale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    lbScale = Math.min(10, Math.max(0.1, lbScale));
    lbApply();
  }, { passive: false });
  // 中键拖动平移预览图
  let lbDrag = false, lbLastX = 0, lbLastY = 0;
  lightbox.addEventListener("mousedown", e => {
    if (e.button !== 1) return;
    e.preventDefault();  // 阻止浏览器中键自动滚动
    lbDrag = true; lbLastX = e.clientX; lbLastY = e.clientY;
    document.getElementById("lbImg").style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", e => {
    if (!lbDrag) return;
    lbX += e.clientX - lbLastX; lbY += e.clientY - lbLastY;
    lbLastX = e.clientX; lbLastY = e.clientY;
    lbApply();
  });
  window.addEventListener("mouseup", e => {
    if (e.button !== 1) return;
    lbDrag = false;
    document.getElementById("lbImg").style.cursor = "";
  });
  lightbox.addEventListener("click", e => {
    if (e.target.id !== "lbDownload") { lightbox.classList.remove("show"); revokeUnusedPreviewUrls(); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { lightbox.classList.remove("show"); revokeUnusedPreviewUrls(); }
  });
}
