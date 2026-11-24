// ================= 任务运行流程：快照、本地列队、提交、轮询、取消、自动下载、扣费提示 =================
import { state, activeTool, saveToDir, saveLastDone, saveTools } from "./store.js";
import { apiKey, uploadImage, createTask, queryTask, cancelTask, enrichSelectOptions, localFetch } from "./api.js";
import { showStatus, writeFieldValue, refreshSelectOptions } from "./ui/form.js";
import { buildResultHtml, bindResultImageDims, bindLocalFallback } from "./ui/results.js";
import { refreshToolItemStates } from "./ui/toollist.js";
import { persistTool } from "./tools.js";

const RESULTS_STORE_KEY = "rh_results_session";
let agentSession = "";

// 结果随页面刷新保留，但程序（启动工具.bat）重启后清空：
// server 每次启动都会给一个新的 session，旧 session 的结果直接丢弃
export function restoreResultsSession(session) {
  agentSession = session || "";
  if (!agentSession) return false;
  try {
    const raw = JSON.parse(localStorage.getItem(RESULTS_STORE_KEY) || "null");
    if (raw && raw.session === agentSession) {
      if (raw.results) state.toolResults = raw.results;
      if (raw.fields) state.fieldValuesByTool = raw.fields;
      return true;
    }
    localStorage.removeItem(RESULTS_STORE_KEY);
  } catch (e) {
    localStorage.removeItem(RESULTS_STORE_KEY);
  }
  return false;
}

export function saveResultsSession() {
  if (!agentSession) return;
  try {
    localStorage.setItem(RESULTS_STORE_KEY, JSON.stringify({
      session: agentSession,
      results: state.toolResults,
      fields: state.fieldValuesByTool
    }));
  } catch (e) { /* 空间不足时忽略，内存里的结果仍可用 */ }
}

window.addEventListener("pagehide", saveResultsSession);

// 结果按工具累计：新结果追加到同一网格末尾（旧图在左、新图在右，满行自动换行），
// 再次生成、切换工具都不清空，刷新页面仍保留，重启程序才重置
function appendResultBatch(toolId, resultHtml) {
  const box = document.createElement("div");
  box.innerHTML = state.toolResults[toolId] || "";
  const grid = document.createElement("div");
  grid.className = "result-grid";
  // 兼容旧存档里的批次结构：把历史结果项重新收进同一个网格
  box.querySelectorAll(".result-item, .result-text").forEach(el => grid.appendChild(el));
  const fresh = document.createElement("div");
  fresh.innerHTML = resultHtml;
  fresh.querySelectorAll(".result-grid > *").forEach(el => grid.appendChild(el));
  // 本批次无输出（只有占位提示）且此前也没有结果时，直接展示占位提示
  state.toolResults[toolId] = grid.childElementCount ? grid.outerHTML : resultHtml;
  if (state.activeId === toolId) document.getElementById("resultArea").innerHTML = state.toolResults[toolId];
  saveResultsSession();
}

// 失败/取消提示：已有历史结果时保留历史，只在空结果区显示提示
function showResultNotice(toolId, html) {
  if (state.toolResults[toolId]) return;
  state.toolResults[toolId] = html;
  if (state.activeId === toolId) document.getElementById("resultArea").innerHTML = html;
  saveResultsSession();
}

function cloneValue(v) {
  return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 轮询查询任务（v2 查询接口直接返回状态+结果）；取消状态只读取本任务
async function waitTask(taskId, run, onTick) {
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    if (run.cancelled) return { cancelled: true, results: [], usage: {} };
    const json = await queryTask(taskId);
    onTick(json.status, i);
    if (json.status === "SUCCESS") return { results: json.results || [], usage: json.usage || {} };
    if (json.status === "FAILED") {
      throw new Error("任务执行失败：" + (json.errorMessage || "请到 RunningHub 控制台查看详情"));
    }
  }
  throw new Error("等待超时（10分钟），任务可能仍在运行，可稍后到官网查看");
}

// 通知左侧列表刷新「运行中 / 最近完成」高亮与按钮状态
function notifyToolStatus() {
  document.dispatchEvent(new CustomEvent("tool-status"));
}

// 随机种子上限：2^53-1，保证在 JS / JSON 中不丢精度
const SEED_MAX = Number.MAX_SAFE_INTEGER;
function randomSeed() { return Math.floor(Math.random() * SEED_MAX); }

// 点击「开始生成 / 进入列队」的快照时刻，按模式算出本次要提交的种子，
// 并把显示的基准值推进到下一次（固定值不变），实现每次点击就地变化。
// 递增/递减：本次提交当前基准值，之后基准 ±1，保证列队里每个任务种子连续独立。
function resolveSeedValue(t, f, i) {
  const el = document.getElementById("ff_" + i);
  const modeEl = document.getElementById("fm_" + i);
  const mode = modeEl ? modeEl.value : "random";
  const base = Number(el ? el.value.trim() : "");
  const baseValid = Number.isFinite(base);
  const val = (mode === "random" || !baseValid) ? randomSeed() : base;

  if (el) {
    let next = null;
    if (mode === "inc") next = (baseValid ? base : val) + 1;
    else if (mode === "dec") next = (baseValid ? base : val) - 1;
    else if (mode === "random") next = val;
    if (next !== null) {
      el.value = String(next);
      writeFieldValue(t, f, String(next));  // 写回内存态，切换工具/刷新后仍保持推进后的值
    }
  }
  return String(val);
}

let queuePumping = false;
let runSerial = 0;
let statusOwner = 0;

// 只有最新的远端任务可以写全局状态栏，旧任务的后台下载不能覆盖新任务进度
function runStatus(run, text, type) {
  if (run.id === statusOwner) showStatus(text, type);
}

// 同步固定点击时的完整参数；图片只保存不可变 File 引用，不做异步读取或上传
function captureActiveTask() {
  const tool = activeTool();
  if (!apiKey()) { showStatus("请先点击右上角设置 API Key", "error"); return null; }
  if (!tool) { showStatus("请先在左侧选择一个工具", "error"); return null; }
  if (tool.deleted) { showStatus("该工具在回收站中，请先在左侧还原再使用", "error"); return null; }
  if (!tool.webappId) { showStatus("当前工具未填写应用 ID，请点击右上角「配置此工具」", "error"); return null; }

  const fields = cloneValue(tool.fields || []);
  const files = Object.assign({}, state.fieldFiles);
  const values = fields.map((f, i) => {
    if (f.type === "image" || f.type === "audio") return "";
    if (f.type === "seed") return resolveSeedValue(tool, f, i);
    const el = document.getElementById("ff_" + i);
    const v = el ? el.value.trim() : "";
    return v !== "" ? v : (f.def || "");
  });

  // 仅当工具配置了输入项却全部为空时才视为配置错误；
  // 无输入项的"零参数工作流"允许空 nodeInfoList 提交；有图片/音频字段时允许空值提交
  const hasFileField = fields.some(f => f.type === "image" || f.type === "audio");
  const hasValue = values.some(v => v !== "");
  if (fields.length && !hasFileField && !hasValue) {
    showStatus("没有可提交的参数，请检查工具配置", "error");
    return null;
  }

  return {
    toolId: tool.id,
    toolName: tool.name || "result",
    tool: { toolType: tool.toolType || "app", webappId: tool.webappId, instanceType: tool.instanceType || "default" },
    fields,
    values,
    files
  };
}

// 执行一个任务的远端阶段，不读取全局 currentRun
async function executeRemote(run) {
  const task = run.task;
  const nodeInfoList = [];
  for (let i = 0; i < task.fields.length; i++) {
    const f = task.fields[i];
    if (f.type === "image" || f.type === "audio") {
      // 图片/音频均可选：有文件则上传，无文件则提交空值，由远端校验并返回错误
      const file = task.files[i];
      if (file) {
        runStatus(run, "⏫ 正在上传「" + f.label + "」…（可点「立即取消」中断）");
        const fileName = await uploadImage(file, run.abort.signal);
        if (run.cancelled) return { cancelled: true, results: [], usage: {} };
        nodeInfoList.push({ nodeId: f.nodeId, fieldName: f.fieldName, fieldValue: fileName });
      } else {
        nodeInfoList.push({ nodeId: f.nodeId, fieldName: f.fieldName, fieldValue: "" });
      }
      continue;
    }
    let out = task.values[i];
    if (out === "" || out == null) continue;
    // valueMap 翻译：下拉显示名 → 配置的提交值（如 风格名 → 序号）
    if (f.valueMap && Object.prototype.hasOwnProperty.call(f.valueMap, out)) out = String(f.valueMap[out]);
    // 数字字段/映射值以真实数字类型提交：自定义节点（如 YC Super Selector）不做字符串转数字
    if ((f.type === "number" || f.type === "seed" || f.valueMap) && out !== "" && isFinite(Number(out))) out = Number(out);
    nodeInfoList.push({ nodeId: f.nodeId, fieldName: f.fieldName, fieldValue: out });
  }

  if (run.cancelled) return { cancelled: true, results: [], usage: {} };

  runStatus(run, "🚀 正在创建任务…");
  let taskId;
  try {
    taskId = await createTask(task.tool, nodeInfoList, run.abort.signal);
  } catch (err) {
    // 网络中断时提交结果未知，必须暂停列队，避免重复提交
    if (/无法连接|Failed to fetch|NetworkError|网络/i.test(err && err.message || "")) err.remoteUncertain = true;
    throw err;
  }
  // 任务已提交成功但用户此刻点了取消：需要同时通知服务端停止，避免继续扣费
  if (run.cancelled) {
    try { await cancelTask(taskId); } catch (e) {}
    return { cancelled: true, results: [], usage: {} };
  }

  run.taskId = taskId;
  runStatus(run, "⏳ 任务运行中（taskId: " + taskId + "）…");
  try {
    return await waitTask(taskId, run, (s, i) => {
      runStatus(run, "⏳ 任务状态：" + (s || "未知") + "（已等待 " + (i * 3 + 3) + " 秒）");
    });
  } catch (err) {
    // 只有远端明确报告任务失败才可安全续跑；查询网络错误和超时状态未知
    if (!/^任务执行失败：/.test(err && err.message || "")) err.remoteUncertain = true;
    throw err;
  }
}

// 保存成功后的本地地址替换：按 data-item-key 只改目标结果项，其他批次不受影响。
// 预览先显示远端 URL，下载完成后静默切到本地 /downloads/，不再受远端 24 小时过期影响。
function useLocalResultUrl(toolId, itemKey, localUrl) {
  const apply = item => {
    if (!item || item.dataset.local) return;
    const img = item.querySelector("img");
    const video = item.querySelector("video");
    if (img) img.src = localUrl;
    if (video) {
      // 保持播放进度与播放状态，避免切换瞬间跳回开头
      const at = video.currentTime;
      const wasPlaying = !video.paused;
      video.src = localUrl;
      video.addEventListener("loadedmetadata", () => {
        if (at > 0) { try { video.currentTime = at; } catch (e) {} }
        if (wasPlaying) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
      }, { once: true });
    }
    const a = item.querySelector("a[download]");
    if (a) a.href = localUrl;
    item.dataset.local = localUrl;
  };

  const sel = '.result-item[data-item-key="' + itemKey + '"]';
  if (state.activeId === toolId) {
    const area = document.getElementById("resultArea");
    apply(area ? area.querySelector(sel) : null);
    bindLocalFallback();
    if (area) state.toolResults[toolId] = area.innerHTML;
  } else if (state.toolResults[toolId]) {
    // 用户已切到其他工具：直接改存档 HTML，切回来时也是本地地址
    const box = document.createElement("div");
    box.innerHTML = state.toolResults[toolId];
    apply(box.querySelector(sel));
    state.toolResults[toolId] = box.innerHTML;
  }
  saveResultsSession();
}

// 输出展示、自动下载与下拉补全独立后台执行，不阻塞本地 FIFO 的下一项远端提交
async function processResults(run, results, usage) {
  const task = run.task;
  appendResultBatch(task.toolId, buildResultHtml(results, String(run.id)));
  bindResultImageDims(task.toolId);
  bindLocalFallback();

  // 自动下载结果原图到本地（避免24小时后链接过期丢失）
  let downloaded = 0;
  let byServer = 0;
  for (let idx = 0; idx < results.length; idx++) {
    const it = results[idx];
    if (!it.url || !(it.outputType || "").match(/png|jpe?g|webp|gif|mp4|mov/i)) continue;
    const fname = task.toolName + "_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
      + (results.length > 1 ? "_" + (idx + 1) : "") + "." + (it.outputType || "png");
    // 本地服务模式：由 server 直接下载到已配置的下载目录，浏览器无需授权
    if (location.protocol.startsWith("http")) {
      try {
        const r = await localFetch("/save-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: it.url, filename: fname })
        });
        if (r.ok) {
          const j = await r.json();
          if (j && j.ok) {
            downloaded++; byServer++;
            // 服务端已落盘：把该结果项静默切到本地 /downloads/ 地址
            if (j.url) useLocalResultUrl(task.toolId, run.id + "_" + idx, j.url);
            continue;
          }
        } else {
          // 打印服务端拒绝原因，便于定位令牌/域名/网络问题
          console.warn("服务端保存结果失败", r.status, await r.text().catch(() => ""), it.url);
        }
      } catch (e) { /* 旧版服务没有该接口，走下面的兜底 */ }
    }
    try {
      const b = await (await fetch(it.url)).blob();
      // 已设置自定义目录：静默写入，不弹任何窗口
      if (state.dirHandle && (await state.dirHandle.queryPermission({ mode: "readwrite" })) === "granted") {
        try { await saveToDir(state.dirHandle, fname, b); downloaded++; continue; } catch (e) {}
      }
      // 否则走浏览器默认下载（受浏览器下载设置控制）
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);  // 延迟回收，避免下载未开始就被释放
      downloaded++;
    } catch (e) { /* 自动下载失败时仍可点页面上的下载按钮 */ }
  }

  // 运行成功后补全下拉选项：配置时只填一个默认值也会自动拉取完整候选列表
  let optionTip = "";
  const live = state.tools.find(t => t.id === task.toolId);
  if (live && !live.deleted) {
    try {
      const filled = await enrichSelectOptions(live);
      if (filled) {
        saveTools();
        if (state.activeId === live.id) refreshSelectOptions(live);
        try {
          await persistTool(live);
        } catch (e) { /* 写目录失败时 localStorage 已更新 */ }
        optionTip = "；已自动补全 " + filled + " 个下拉列表的选项";
      }
    } catch (e) { /* 接口可能不支持拉取，失败不影响本次结果 */ }
  }

  // 组装扣费信息
  let costText = "✅ 生成完成！共 " + results.length + " 个输出";
  if (downloaded) costText += "，已自动保存 " + downloaded + " 个文件到「" + (byServer ? "下载目录" : (state.dirHandle ? state.dirHandle.name : "浏览器下载目录")) + "」";
  if (usage && (usage.consumeMoney || usage.consumeCoins || usage.taskCostTime)) {
    const parts = [];
    if (usage.taskCostTime) parts.push("耗时 " + usage.taskCostTime + " 秒");
    if (usage.consumeMoney && usage.consumeMoney !== "0") parts.push("扣费 ¥" + usage.consumeMoney);
    if (usage.consumeCoins && usage.consumeCoins !== "0") parts.push("消耗 " + usage.consumeCoins + " RH币");
    if (parts.length) costText += "（" + parts.join("，") + "）";
  }
  runStatus(run, costText + optionTip + "。链接24小时内有效，请及时下载", "success");
}

function finishCancelled(run) {
  runStatus(run, "⏹ 已取消", "");
  showResultNotice(run.task.toolId, '<div class="result-placeholder">已取消</div>');
}

// 唯一 FIFO 消费器：远端明确完成后先续跑，下载与结果处理在后台并行完成
async function pumpRunQueue() {
  if (queuePumping) return;
  queuePumping = true;
  try {
    while (state.runQueue.length && !state.runQueuePaused) {
      const task = state.runQueue.shift();
      const run = {
        id: ++runSerial,
        task,
        taskId: null,
        cancelled: false,
        paused: false,
        abort: new AbortController()
      };
      statusOwner = run.id;
      state.currentRun = run;
      state.runningToolId = task.toolId;
      state.lastDoneToolId = null;
      saveLastDone();
      notifyToolStatus();

      try {
        const result = await executeRemote(run);
        if (result.cancelled) {
          finishCancelled(run);
        } else {
          state.lastDoneToolId = task.toolId;
          saveLastDone();
          processResults(run, result.results || [], result.usage || {}).catch(err => {
            showResultNotice(task.toolId, '<div class="result-placeholder">结果处理失败</div>');
            runStatus(run, "❌ 结果处理失败：" + err.message, "error");
          });
          notifyToolStatus();
        }
      } catch (err) {
        if ((err && err.name === "AbortError") || run.cancelled) {
          finishCancelled(run);
        } else {
          runStatus(run, "❌ " + err.message, "error");
          showResultNotice(task.toolId, '<div class="result-placeholder">生成失败</div>');
          if (err.remoteUncertain) {
            run.paused = true;
            state.runQueuePaused = true;
            runStatus(run, "❌ " + err.message + "；远端状态未确定，本地列队已暂停，可取消当前任务后续跑", "error");
          }
        }
      } finally {
        // 暂停项需要保留身份供用户取消；其他任务按对象身份清理，避免误清下一项
        if (!run.paused && state.currentRun === run) {
          state.currentRun = null;
          state.runningToolId = null;
        }
        notifyToolStatus();
      }
    }
  } finally {
    queuePumping = false;
    notifyToolStatus();
  }
}

// ================= 对外入口 =================
export function runActiveTool() {
  if (state.currentRun || queuePumping) return;
  if (state.runQueuePaused) {
    showStatus("当前任务状态未确定，请先取消当前任务", "error");
    return;
  }
  const task = captureActiveTask();
  if (!task) return;
  state.runQueue.push(task);
  notifyToolStatus();
  void pumpRunQueue();
}

export function queueActiveTool() {
  if (!state.currentRun || state.currentRun.cancelled || state.runQueuePaused) {
    showStatus("当前没有可继续列队的运行任务", "error");
    return;
  }
  const task = captureActiveTask();
  if (!task) return;
  state.runQueue.push(task);
  showStatus("已加入本地列队，当前等待 " + state.runQueue.length + " 个任务");
  notifyToolStatus();
}

export function clearQueuedRuns() {
  const count = state.runQueue.length;
  if (!count) return;
  if (!window.confirm("确定清空本地列队中的 " + count + " 个待提交任务吗？\n当前正在生成的任务不受影响。")) return;
  state.runQueue.length = 0;
  showStatus("已清空 " + count + " 个待提交任务");
  notifyToolStatus();
}

// 立即取消：只停止当前远端任务，本地 FIFO 保留并继续执行
export async function cancelCurrentRun() {
  const run = state.currentRun;
  if (!run || run.cancelled) return;
  const wasPaused = run.paused;
  run.cancelled = true;
  notifyToolStatus();
  runStatus(run, "⏹ 正在取消…");
  // 中断仍在进行的上传/提交请求，避免流量与时间浪费
  try { if (run.abort) run.abort.abort(); } catch (e) {}
  // 任务已提交到服务端时才需要通知停止
  if (run.taskId) {
    try { await cancelTask(run.taskId); } catch (e) { /* 取消失败也不影响本地停止 */ }
  }
  // 状态不明的暂停项已退出消费循环，需要在这里清理并重新启动后续 FIFO
  if (wasPaused) {
    run.paused = false;
    state.runQueuePaused = false;
    if (state.currentRun === run) {
      state.currentRun = null;
      state.runningToolId = null;
    }
    finishCancelled(run);
    notifyToolStatus();
    void pumpRunQueue();
  }
}
