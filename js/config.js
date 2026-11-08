// ================= 常量与默认配置 =================
// 注意：本应用不含任何 API Key 和用户配置。
// API Key 只保存在浏览器 localStorage；工具配置通过「导出/导入 .json 文件」迁移。
export const LS = { key: "rh_apikey", site: "rh_site", tools: "rh_tools_v4", active: "rh_active_v4" };

// 字段类型定义
export const FIELD_TYPES = {
  image:    "图片上传",
  textarea: "多行文本",
  text:     "单行文本",
  number:   "数字",
  select:   "下拉选择"
};

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
