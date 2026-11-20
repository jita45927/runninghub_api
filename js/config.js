// ================= 常量与默认配置 =================
// 注意：本应用不含任何 API Key 和用户配置。
// API Key 只保存在浏览器 localStorage；工具配置通过「导出/导入 .json 文件」迁移。
export const LS = {
  key: "rh_apikey",
  site: "rh_site",
  tools: "rh_tools_v4",
  active: "rh_active_v4",
  // 以下两个键供公共核心的 store.js 使用，两个应用各自定义自己的键名
  cats: "rhtool_cats_v1",
  lastDone: "rhtool_last_done_v1"
};

// 字段类型定义
export const FIELD_TYPES = {
  image:    "图片上传",
  textarea: "多行文本",
  text:     "单行文本",
  number:   "数字",
  select:   "下拉选择",
  seed:     "随机种子"
};

// 旧配置里把种子配成了普通数字字段，只能提交固定值。
// 这里在加载时自动升级为「随机种子」类型，使其具备固定/递增/递减/随机四种模式。
// 仅在内存中升级；写回磁盘由用户保存配置触发，不强制改写配置文件。
export function migrateSeedFields(t) {
  if (!t || !Array.isArray(t.fields)) return false;
  let changed = false;
  t.fields.forEach(f => {
    if (f && f.type === "number" && String(f.fieldName || "").trim().toLowerCase() === "seed") {
      f.type = "seed";
      changed = true;
    }
  });
  return changed;
}

// 工具图标可选项（配置弹窗下拉）
export const ICON_OPTIONS = ["🖼️","🎨","✨","🔍","⬆️","📐","🏞️","🌆","🏗️","🧱","🪄","✂️","🎞️","🖌️","📸","👤","💡","🌟","🎯","🧩"];

// HTML 转义：配置/接口数据拼进 HTML 前必须转义，防 XSS
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 内置占位示例（不含真实应用数据，导入配置文件后可替换或删除）
export const DEFAULT_TOOLS = [
  {
    id: "t1", icon: "🧩", name: "示例工具", desc: "点「配置此工具」填入你的应用信息，或从左侧导入配置文件",
    webappId: "", instanceType: "default",
    fields: [
      { label: "上传图片", type: "image", nodeId: "", fieldName: "image", def: "" },
      { label: "提示词", type: "textarea", nodeId: "", fieldName: "text", def: "" }
    ]
  }
];
