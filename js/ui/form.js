// ================= 工作区动态表单与图片上传交互 =================
import { esc } from "../config.js?v=20261112e";
import { state, activeTool, idbSet } from "../store.js?v=20261112e";
import { openLightbox, previewUrlFor } from "./lightbox.js?v=20261112e";
import { openMaskEditor, clearMaskCache } from "./maskeditor.js?v=20261112e";

// 每个图片字段的原始图片（未烧蒙版），再次编辑蒙版时以干净底图重画，保证"清除"有效
const fieldBaseFiles = new Map();
// 每个图片字段保存蒙版时的信息：颜色用于预览填充，开关状态用于在按钮下方显示说明
const fieldMaskInfo = new Map();
// 蒙版预览图（颜色已合成），供灯箱预览复用
const fieldPreviewUrls = new Map();
const baseKey = idx => (activeTool() ? activeTool().id : "tool") + "_" + idx;

// 参数值的存储键：nodeId + 字段名（配置改动后仍能对应上，不用下标）
const fieldKey = f => String(f.nodeId || "") + "|" + String(f.fieldName || "");

// 取某字段上次填写的值；没有记录时用传入的默认值
function savedFieldValue(t, f, fallback) {
  const bucket = state.fieldValuesByTool[t.id];
  const v = bucket ? bucket[fieldKey(f)] : undefined;
  return v === undefined ? fallback : v;
}

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
      const val = savedFieldValue(t, f, f.def || "");
      return `<div class="field${span}"><label>${esc(f.label)}</label><textarea id="ff_${i}" autocomplete="off" placeholder="${f.def ? "" : "请输入"}">${esc(val)}</textarea></div>`;
    }
    if (f.type === "select") {
      const opts = (f.def || "").split(",").map(s => s.trim()).filter(Boolean);
      const current = savedFieldValue(t, f, opts[0] || "");
      if (current && !opts.includes(current)) opts.unshift(current);
      return `<div class="field${span}"><label>${esc(f.label)}</label>
        <select id="ff_${i}" autocomplete="off">${opts.map(o => `<option value="${esc(o)}"${o === current ? " selected" : ""}>${esc(o)}</option>`).join("")}</select></div>`;
    }
    const inputType = f.type === "number" ? "number" : "text";
    const val = savedFieldValue(t, f, f.def || "");
    return `<div class="field${span}"><label>${esc(f.label)}</label><input type="${inputType}" id="ff_${i}" value="${esc(val)}" autocomplete="off" data-form-type="other" data-lpignore="true"></div>`;
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
      ua._clickTimer = setTimeout(() => {
        if (!state.fieldFiles[i]) return;
        openLightbox(fieldPreviewUrls.get(baseKey(i)) || previewUrlFor(state.fieldFiles[i]));
      }, 260);
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

  // 记录参数改动：按工具隔离保留，切换工具后恢复；
  // 只存内存，不写 localStorage，重启/刷新程序后回到配置默认值
  const persistField = el => {
    if (!el || !el.id || el.id.indexOf("ff_") !== 0) return;
    const f = t.fields[Number(el.id.slice(3))];
    if (!f || f.type === "image") return;
    const bucket = state.fieldValuesByTool[t.id] || (state.fieldValuesByTool[t.id] = {});
    bucket[fieldKey(f)] = el.value;
  };
  form.oninput = e => persistField(e.target);
  form.onchange = e => persistField(e.target);

  // 恢复当前工具自己的生成结果（各工具结果互相隔离）
  document.getElementById("resultArea").innerHTML =
    state.toolResults[t.id] || '<div class="result-placeholder">生成的内容会显示在这里</div>';

  // 恢复已选图片的预览（含尺寸）
  t.fields.forEach((f, i) => {
    if (f.type !== "image" || !state.fieldFiles[i]) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const ua = document.getElementById("ua_" + i);
      if (ua) renderImgPreview(ua, ev.target.result, i);
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
function renderImgPreview(ua, dataUrl, fieldIdx) {
  const img = new Image();
  img.onload = () => {
    // 蒙版图：透明区域用保存时所选颜色填充预览，避免显示成透明/棋盘格
    const info = fieldMaskInfo.get(baseKey(fieldIdx));
    const color = info ? info.color : null;
    const src = color ? colorizedPreview(img, color) : dataUrl;
    if (color) fieldPreviewUrls.set(baseKey(fieldIdx), src);
    else fieldPreviewUrls.delete(baseKey(fieldIdx));
    const modeText = info ? maskModeText(info) : "";
    ua.innerHTML = `<img src="${src}"><div class="img-dim">📐 ${img.naturalWidth} × ${img.naturalHeight} px<br><small style="color:#8a93a8;font-size:11px">单击预览，双击更改图片</small><br><button type="button" class="mask-edit-btn">✏️ 绘制蒙版</button>${modeText ? `<div class="img-mask-state">${modeText}</div>` : ""}</div>`;
    const btn = ua.querySelector(".mask-edit-btn");
    if (btn) btn.onclick = e => {
      e.stopPropagation();  // 避免冒泡触发单击灯箱预览
      const key = baseKey(fieldIdx);
      const base = fieldBaseFiles.get(key) || state.fieldFiles[fieldIdx];
      openMaskEditor(base, (file, info) => {
        if (!fieldBaseFiles.has(key)) fieldBaseFiles.set(key, base);  // 记住原图
        fieldMaskInfo.set(key, info || null);
        state.fieldFiles[fieldIdx] = file;
        const r = new FileReader();
        r.onload = ev => renderImgPreview(ua, ev.target.result, fieldIdx);
        r.readAsDataURL(file);
        showStatus("已生成含蒙版的图片（透明区域即 Mask），保存后会随图片一起提交", "ok");
      }, key);
    };
  };
  img.src = dataUrl;
}

// 蒙版预览图：透明区域填充成所选颜色（模拟最终叠加效果，不显示棋盘格）
function colorizedPreview(img, color) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}

// 蒙版状态说明：是否把蒙版按颜色叠加进图片 / 是否输出蒙版
function maskModeText(info) {
  return (info.paintMode ? "绘制到图片层" : "不修改原图") + "，" +
         (info.exportMask ? "输出蒙版" : "不输出蒙版");
}

function pickFile(fieldIdx, file) {
  if (!file.type.startsWith("image/")) { showStatus("请选择图片文件", "error"); return; }
  if (file.size > 30 * 1024 * 1024) { showStatus("图片不能超过 30MB", "error"); return; }
  state.fieldFiles[fieldIdx] = file;
  fieldBaseFiles.set(baseKey(fieldIdx), file);  // 换图后重置底图，蒙版从头开始
  fieldMaskInfo.delete(baseKey(fieldIdx));      // 换图后不再用旧颜色/状态预览蒙版
  fieldPreviewUrls.delete(baseKey(fieldIdx));
  clearMaskCache(baseKey(fieldIdx));            // 换图后丢弃上一个蒙版
  const reader = new FileReader();
  reader.onload = ev => renderImgPreview(document.getElementById("ua_" + fieldIdx), ev.target.result, fieldIdx);
  reader.readAsDataURL(file);
}
