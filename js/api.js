// ================= RunningHub v2 API 层（纯接口请求，不含任何 DOM 操作） =================
import { LS } from "./config.js?v=20261112e";

export function base() { return localStorage.getItem(LS.site) || "https://www.runninghub.cn"; }
export function apiKey() { return localStorage.getItem(LS.key) || ""; }
export function authHeaders() {
  return { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey() };
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
