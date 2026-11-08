// ================= 工作区动态表单与图片上传交互 =================
import { esc } from "../config.js";
import { state, activeTool, idbSet } from "../store.js";
import { openLightbox, previewUrlFor } from "./lightbox.js";

// ================= 状态栏 =================
export function showStatus(text, type) {
  const statusBar = document.getElementById("statusBar");
  statusBar.className = "status-bar show" + (type ? " " + type : "");
  statusBar.textContent = text;
}

// ================= 工作区：按字段配置动态生成表单 =================
export function renderWorkspace() {
  const t = activeTool();
  document.getElementById("wsIcon").textContent = t ? (t.icon || "🧩") : "🖼️";
  document.getElementById("wsName").textContent = t ? t.name : "请选择工具";
  document.getElementById("wsDesc").textContent = t ? (t.desc || "点击右上角「配置此工具」完善参数") : "从左侧选择一个工具开始使用";

  state.fieldFiles = t ? (state.fieldFilesByTool[t.id] || (state.fieldFilesByTool[t.id] = {})) : {};  // 恢复当前工具已选的图片
  const form = document.getElementById("formArea");
  if (!t || !t.fields || !t.fields.length) {
    form.innerHTML = '<div style="color:#4a5470;font-size:13px;padding:8px 0">此工具还没有输入项，点右上角「配置此工具」添加。</div>';
    return;
  }

  form.innerHTML = '<div class="form-grid">' + t.fields.map((f, i) => {
    const span = (f.type === "textarea" || f.type === "image") ? " span2" : "";
    if (f.type === "image") {
      return `<div class="field${span}">
        <label>${esc(f.label)}</label>
        <div class="upload-area" id="ua_${i}"><span>双击选择图片，或拖拽到这里<br><small style="color:#4a5470">JPG / PNG / WEBP，≤30MB；上传后单击可预览缩放</small></span></div>
        <input type="file" id="fi_${i}" accept="image/*" style="display:none">
      </div>`;
    }
    if (f.type === "textarea") {
      return `<div class="field${span}"><label>${esc(f.label)}</label><textarea id="ff_${i}" autocomplete="off" placeholder="${f.def ? "" : "请输入"}">${esc(f.def)}</textarea></div>`;
    }
    if (f.type === "select") {
      const opts = (f.def || "").split(",").map(s => s.trim()).filter(Boolean);
      return `<div class="field${span}"><label>${esc(f.label)}</label>
        <select id="ff_${i}" autocomplete="off">${opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}</select></div>`;
    }
    const inputType = f.type === "number" ? "number" : "text";
    return `<div class="field${span}"><label>${esc(f.label)}</label><input type="${inputType}" id="ff_${i}" value="${esc(f.def)}" autocomplete="off" data-form-type="other" data-lpignore="true"></div>`;
  }).join("") + "</div>";

  // 给图片字段绑定事件
  t.fields.forEach((f, i) => {
    if (f.type !== "image") return;
    const ua = document.getElementById("ua_" + i);
    const fi = document.getElementById("fi_" + i);
    // 单击=预览已上传图片（可滚轮缩放），双击=重新选择图片
    ua.onclick = () => {
      if (!state.fieldFiles[i]) { pickImageField(i, fi); return; }
      clearTimeout(ua._clickTimer);
      ua._clickTimer = setTimeout(() => { if (state.fieldFiles[i]) openLightbox(previewUrlFor(state.fieldFiles[i])); }, 260);
    };
    ua.ondblclick = () => { clearTimeout(ua._clickTimer); pickImageField(i, fi); };
    fi.onchange = e => { if (e.target.files[0]) pickFile(i, e.target.files[0]); };
    ua.ondragover = e => { e.preventDefault(); ua.classList.add("dragover"); };
    ua.ondragleave = () => ua.classList.remove("dragover");
    ua.ondrop = e => {
      e.preventDefault(); ua.classList.remove("dragover");
      if (e.dataTransfer.files[0]) pickFile(i, e.dataTransfer.files[0]);
    };
  });

  // 恢复当前工具自己的生成结果（各工具结果互相隔离）
  document.getElementById("resultArea").innerHTML =
    state.toolResults[t.id] || '<div class="result-placeholder">生成的内容会显示在这里</div>';

  // 恢复已选图片的预览（含尺寸）
  t.fields.forEach((f, i) => {
    if (f.type !== "image" || !state.fieldFiles[i]) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const ua = document.getElementById("ua_" + i);
      if (ua) renderImgPreview(ua, ev.target.result);
    };
    reader.readAsDataURL(state.fieldFiles[i]);
  });
}

// 用文件系统API选择图片：通过 startIn 记住并打开上次选择的目录
async function pickImageField(i, fi) {
  if (!window.showOpenFilePicker) { fi.click(); return; }  // 老浏览器回退原生选择框
  try {
    const opts = {
      types: [{ description: "图片", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif"] } }],
      multiple: false
    };
    if (state.lastImgHandle) opts.startIn = state.lastImgHandle;  // 打开上次选图所在目录
    const [h] = await showOpenFilePicker(opts);
    state.lastImgHandle = h;
    idbSet("lastImg", h).catch(() => {});  // 记住这次的文件位置
    pickFile(i, await h.getFile());
  } catch (e) { /* 用户取消选择 */ }
}

// 显示图片预览及其像素尺寸
function renderImgPreview(ua, dataUrl) {
  const img = new Image();
  img.onload = () => {
    ua.innerHTML = `<img src="${dataUrl}"><div class="img-dim">📐 ${img.naturalWidth} × ${img.naturalHeight} px<br><small style="color:#8a93a8;font-size:11px">单击预览，双击更改图片</small></div>`;
  };
  img.src = dataUrl;
}

function pickFile(fieldIdx, file) {
  if (!file.type.startsWith("image/")) { showStatus("请选择图片文件", "error"); return; }
  if (file.size > 30 * 1024 * 1024) { showStatus("图片不能超过 30MB", "error"); return; }
  state.fieldFiles[fieldIdx] = file;
  const reader = new FileReader();
  reader.onload = ev => renderImgPreview(document.getElementById("ua_" + fieldIdx), ev.target.result);
  reader.readAsDataURL(file);
}
