// ================= 提示词权重快捷键：Ctrl+↑ 加权重 / Ctrl+↓ 降权重 =================
// 作用范围：工作区表单（#formArea）里的所有 textarea（正向/负向提示词等）。
// 规则：
//   1. 若有选中文本，直接对选区加权；否则对光标所在的「逗号段」加权。
//   2. 逗号段分隔符：， , ； ;（仅逗号族，避免误切英文句子）。
//   3. 已带权重 (text:w) 只改数字；否则包一层 (text:1.1) / (text:0.9)。
//   4. 权重回到 1.0 时自动脱去括号，恢复纯文本。
//   5. 输入法组字中（isComposing）忽略，避免打断拼音。

const DELIMITERS = new Set(["，", ",", "；", ";"]);
const STEP = 0.1;
const MIN_WEIGHT = 0.1;
const MAX_WEIGHT = 2.0;

// 匹配 "(任意内容:数字)"，取最外层权重数字（贪婪 .* 适配嵌套）
const WEIGHT_RE = /^\((.*):(-?\d+(?:\.\d+)?)\)$/;

function clampWeight(w) {
  const n = Math.round(w * 100) / 100;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

function formatWeight(w) {
  // 去掉无意义的尾随零：1.10 -> 1.1
  return String(parseFloat(w.toFixed(2)));
}

// 找到 pos 所在逗号段的 [start, end)，不含分隔符本身
function findSegment(text, pos) {
  let start = pos;
  while (start > 0 && !DELIMITERS.has(text[start - 1])) start--;
  let end = pos;
  while (end < text.length && !DELIMITERS.has(text[end])) end++;
  return { start, end };
}

// 解析一段文本的现有权重；无显式权重返回 null
function parseWeight(content) {
  const m = content.match(WEIGHT_RE);
  if (!m) return null;
  return { inner: m[1], weight: parseFloat(m[2]) };
}

function applyWeight(textarea, direction) {
  const value = textarea.value;
  const selStart = textarea.selectionStart;
  const selEnd = textarea.selectionEnd;
  if (typeof value !== "string" || value.length === 0) return;

  // 选区优先：有选中就对选中文本加权；否则取光标所在逗号段
  let segStart, segEnd;
  if (selStart !== selEnd) {
    segStart = selStart;
    segEnd = selEnd;
  } else {
    const seg = findSegment(value, selStart);
    segStart = seg.start;
    segEnd = seg.end;
  }

  let raw = value.slice(segStart, segEnd);
  if (raw.trim() === "") return;  // 空段不操作

  // 保留段首尾空白，只对中间内容做加权
  const leftPad = raw.match(/^\s*/)[0];
  const rightPad = raw.match(/\s*$/)[0];
  let content = raw.slice(leftPad.length, raw.length - rightPad.length);

  const parsed = parseWeight(content);
  let inner, newWeight;
  if (parsed) {
    inner = parsed.inner;
    newWeight = clampWeight(parsed.weight + direction * STEP);
  } else {
    inner = content;
    newWeight = clampWeight(1 + direction * STEP);
  }

  let replacement;
  if (newWeight === 1) {
    // 回到 1.0：脱去括号
    replacement = leftPad + inner + rightPad;
  } else {
    replacement = leftPad + "(" + inner + ":" + formatWeight(newWeight) + ")" + rightPad;
  }

  textarea.value = value.slice(0, segStart) + replacement + value.slice(segEnd);
  // 光标移到改写段末尾
  const cursor = segStart + replacement.length;
  textarea.selectionStart = cursor;
  textarea.selectionEnd = cursor;
  textarea.dispatchEvent(new Event("input"));  // 触发现有参数持久化
  textarea.focus();
}

// 在 #formArea 上委托一次：容器本身不随切工具销毁，监听天然存活
export function initPromptWeight() {
  const formArea = document.getElementById("formArea");
  if (!formArea || formArea.dataset.promptWeightBound) return;
  formArea.dataset.promptWeightBound = "1";
  formArea.addEventListener("keydown", e => {
    const ta = e.target;
    if (!ta || ta.tagName !== "TEXTAREA") return;
    if (e.isComposing) return;
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === "ArrowUp") { e.preventDefault(); applyWeight(ta, +1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); applyWeight(ta, -1); }
  });
}
