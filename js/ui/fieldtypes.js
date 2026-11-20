// ================= RunningHub 专属字段类型 =================
// 公共核心 form.js 只内置 image/text/textarea/select/number，
// 这里注册「随机种子」类型：界面显示基准值 + 模式，由 runner 在提交前本地生成种子。
import { esc } from "../config.js";
import { registerFieldType } from "./form.js";

// 远端接口不会像 ComfyUI 网页那样自动递增/随机种子，这里在本地实现四种模式
const SEED_MODES = [
  { v: "fixed",  label: "固定值" },
  { v: "inc",    label: "递增值" },
  { v: "dec",    label: "递减值" },
  { v: "random", label: "随机值" }
];

registerFieldType("seed",
  ({ t, f, i, span, saved, savedMode }) => {
    const current = saved(f.def || "");
    const mode = savedMode("random");
    const opts = SEED_MODES.map(m =>
      `<option value="${m.v}"${m.v === mode ? " selected" : ""}>${esc(m.label)}</option>`
    ).join("");
    return `<div class="field${span}"><label>${esc(f.label)}</label>
      <div class="seed-field">
        <input type="number" step="1" id="ff_${i}" value="${esc(current)}" autocomplete="off" data-lpignore="true">
        <select id="fm_${i}" autocomplete="off">${opts}</select>
      </div>
      <div class="field-note">提交前在本地生成种子：固定值不变，递增/递减每次 ±1，随机值每次重新生成</div>
    </div>`;
  }
);
