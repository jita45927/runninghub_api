// ================= 生成结果渲染（DOM 构建防 XSS；url 仅接受 http/https/blob） =================
// 【公共核心】本文件由公共核心同步而来：请修改 runninghub_api/js/ui/results.js，再运行「同步核心.ps1」。
import { state } from "../store.js";

const VIDEO_RE = /\.(mp4|mov|webm|mkv)(\?|#|$)/i;
const IMAGE_RE = /png|jpe?g|webp|gif|bmp/i;

function safeUrl(u) {
  return (typeof u === "string" && /^(https?:\/\/|blob:)/i.test(u)) ? u : "";
}

// 把接口返回的 results 渲染为结果区 HTML：图片/视频显示预览，文本直接展示
export function buildResultHtml(results) {
  const grid = document.createElement("div");
  grid.className = "result-grid";
  let hasOutput = false;
  for (const it of results) {
    const url = safeUrl(it.url);
    const type = String(it.outputType || "");
    const isVideo = /video/i.test(type) || VIDEO_RE.test(url);
    if (url && (IMAGE_RE.test(type) || isVideo)) {
      hasOutput = true;
      const item = document.createElement("div");
      item.className = "result-item";
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.download = "";
      a.textContent = "下载";
      if (isVideo) {
        const v = document.createElement("video");
        v.src = url; v.controls = true; v.preload = "metadata"; v.muted = true;
        item.append(v, a);
      } else {
        const img = document.createElement("img");
        img.src = url;
        const dim = document.createElement("div");
        dim.className = "img-dim";
        dim.textContent = "📐 读取中…";
        item.append(img, dim, a);
      }
      grid.appendChild(item);
    } else if (it.text) {
      hasOutput = true;
      const div = document.createElement("div");
      div.className = "result-text";
      div.textContent = it.text;
      grid.appendChild(div);
    } else if (url) {
      hasOutput = true;
      const div = document.createElement("div");
      div.className = "result-text";
      div.append("📎 ");
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener"; a.style.color = "#5b8cff";
      a.textContent = url;
      div.appendChild(a);
      grid.appendChild(div);
    }
  }
  return hasOutput
    ? grid.outerHTML
    : '<div class="result-placeholder">任务成功但没有输出内容</div>';
}

// 图片加载完成后回填像素尺寸（仅在仍停留在该工具界面时操作 DOM），尺寸写回该工具的存档
export function bindResultImageDims(runToolId) {
  if (state.activeId !== runToolId) return;
  document.querySelectorAll("#resultArea .result-item img").forEach(im => {
    const set = () => {
      const d = im.parentElement.querySelector(".img-dim");
      if (d) d.textContent = "📐 " + im.naturalWidth + " × " + im.naturalHeight + " px";
      state.toolResults[runToolId] = document.getElementById("resultArea").innerHTML;
    };
    if (im.complete && im.naturalWidth) set(); else im.onload = set;
  });
}
