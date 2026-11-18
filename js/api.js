// ================= RunningHub v2 API 层（纯接口请求，不含任何 DOM 操作） =================
import { LS } from "./config.js";

export function base() { return localStorage.getItem(LS.site) || "https://www.runninghub.cn"; }
export function apiKey() { return localStorage.getItem(LS.key) || ""; }
export function authHeaders() {
  return { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey() };
}

// 本地服务每次启动都会换令牌；跨站网页无法读取 /appinfo，也不能伪造自定义请求头。
let localToken = "";
export function setLocalToken(token) { localToken = token || ""; }

export async function localFetch(path, options = {}) {
  if (!localToken && location.protocol.startsWith("http")) {
    try {
      const r = await fetch("/appinfo");
      if (r.ok) {
        const info = await r.json();
        localToken = info.token || "";
      }
    } catch (e) { /* 非本地服务模式时由后续请求按原逻辑失败或回退 */ }
  }
  const headers = new Headers(options.headers || {});
  if (localToken) headers.set("X-RunningHub-Token", localToken);
  const resp = await fetch(path, { ...options, headers });
  // 本地服务重启后令牌会变化，页面若未刷新会一直拿旧令牌；遇到 403 自动换新令牌重试一次
  if (resp.status === 403 && location.protocol.startsWith("http")) {
    try {
      const r = await fetch("/appinfo");
      if (r.ok) {
        const info = await r.json();
        if (info.token && info.token !== localToken) {
          localToken = info.token;
          const retryHeaders = new Headers(options.headers || {});
          retryHeaders.set("X-RunningHub-Token", localToken);
          return fetch(path, { ...options, headers: retryHeaders });
        }
      }
    } catch (e) { /* 保留原始 403 响应 */ }
  }
  return resp;
}

// 接口响应兜底：HTTP 错误或非 JSON 响应统一抛出可读错误
export async function parseRespJson(resp) {
  let json = null;
  try { json = await resp.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!resp.ok || json === null) throw new Error("服务器返回异常(HTTP " + resp.status + ")");
  return json;
}

// 上传图片，返回 fileName（signal 用于取消时中断上传请求）
export async function uploadImage(file, signal) {
  const fd = new FormData();
  fd.append("file", file);
  const resp = await fetch(base() + "/openapi/v2/media/upload/binary", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey() },
    body: fd,
    signal
  });
  const json = await parseRespJson(resp);
  if (json.code !== 0) throw new Error("图片上传失败：" + (json.message || json.msg || JSON.stringify(json)));
  return json.data.fileName;
}

// 提交任务：AI 应用和 ComfyUI 工作流走不同的 v2 端点（nodeInfoList 由表单字段动态组装）
export async function createTask(tool, nodeInfoList, signal) {
  const path = tool.toolType === "workflow" ? "/openapi/v2/run/workflow/" : "/openapi/v2/run/ai-app/";
  const resp = await fetch(base() + path + tool.webappId, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ nodeInfoList, instanceType: tool.instanceType || "default" }),
    signal
  });
  const json = await parseRespJson(resp);
  if (!json.taskId) throw new Error("任务创建失败：" + (json.errorMessage || json.message || JSON.stringify(json)));
  return json.taskId;
}

// 单次查询任务状态（v2 查询接口直接返回状态+结果），轮询循环在 runner.js
export async function queryTask(taskId) {
  const resp = await fetch(base() + "/openapi/v2/query", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ taskId: String(taskId) })
  });
  return parseRespJson(resp);
}

// 通知 RunningHub 停止任务
export async function cancelTask(taskId) {
  const resp = await fetch(base() + "/openapi/v2/cancel", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ taskId: String(taskId) })
  });
  return parseRespJson(resp);
}

// 查询账户余额/状态，返回 json.data（调用方负责渲染）
export async function getAccountStatus(key) {
  const resp = await fetch(base() + "/uc/openapi/accountStatus", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ apikey: key })
  });
  const json = await parseRespJson(resp);
  if (json.code !== 0) throw new Error(json.msg || "查询失败");
  return json.data;
}

// 获取应用/工作流的节点信息（含下拉列表候选值）
export async function fetchNodeList(tool) {
  const key = apiKey();
  if (!key) throw new Error("未设置 API Key");
  const isWf = tool.toolType === "workflow";
  const path = isWf ? "/api/workflow/apiCallDemo" : "/api/webapp/apiCallDemo";
  const qs = "?apiKey=" + encodeURIComponent(key)
    + "&" + (isWf ? "workflowId" : "webappId") + "=" + encodeURIComponent(tool.webappId);
  const resp = await fetch(base() + path + qs, {
    headers: { "Authorization": "Bearer " + key }
  });
  const json = await parseRespJson(resp);
  if (json.code !== 0 || !json.data) throw new Error(json.msg || "获取节点信息失败");
  return json.data.nodeInfoList || [];
}

// 解析 fieldData 中的候选值，兼容 {name,index} 对象数组与嵌套数组两种格式
export function parseListOptions(fieldData) {
  if (!fieldData) return [];
  let arr;
  try { arr = typeof fieldData === "string" ? JSON.parse(fieldData) : fieldData; } catch (e) { return []; }
  if (!Array.isArray(arr) || !arr.length) return [];
  const out = [];
  const add = v => {
    const s = String(v == null ? "" : v).trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(arr[0])) {
    arr[0].forEach(add);
    return out;
  }
  if (arr.every(v => typeof v === "string")) {
    arr.forEach(add);
    return out;
  }
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    if (it.index != null) add(it.index);
    else if (it.name != null) add(it.name);
    else if (it.value != null) add(it.value);
  }
  return out;
}

// 运行成功后补全下拉选项：只处理「配置时只填了一个默认值」的 select 字段
// 带 valueMap 的字段跳过：显示名与提交值的映射由配置唯一决定，自动拉取的候选会破坏映射对应关系
export async function enrichSelectOptions(tool) {
  const targets = (tool.fields || []).filter(f =>
    f.type === "select" && !f.valueMap && (f.def || "").split(",").map(s => s.trim()).filter(Boolean).length <= 1
  );
  if (!targets.length) return 0;
  const nodes = await fetchNodeList(tool);
  const map = new Map(nodes.map(n => [String(n.nodeId) + "|" + n.fieldName, n]));
  let filled = 0;
  for (const f of targets) {
    const node = map.get(String(f.nodeId) + "|" + f.fieldName);
    const opts = parseListOptions(node && node.fieldData);
    if (!opts.length) continue;
    const cur = (f.def || "").trim();
    f.def = (cur ? [cur, ...opts.filter(v => v !== cur)] : opts).join(",");
    filled++;
  }
  return filled;
}
