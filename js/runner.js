// ================= 任务运行流程：组装参数、提交、轮询、取消、自动下载、扣费提示 =================
import { state, activeTool, saveToDir, saveLastDone, saveTools } from "./store.js";
import { apiKey, uploadImage, createTask, queryTask, cancelTask, enrichSelectOptions, localFetch } from "./api.js";
import { showStatus, refreshSelectOptions } from "./ui/form.js";
import { buildResultHtml, bindResultImageDims } from "./ui/results.js";
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

// 结果按工具累计：新批次放最前，再次生成、切换工具都不清空，刷新页面仍保留，重启程序才重置
function appendResultBatch(toolId, resultHtml) {
  const hasHistory = !!state.toolResults[toolId];
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const batchHtml = hasHistory
    ? '<div class="result-batch"><div class="result-batch-head">生成于 ' + stamp + '</div>' + resultHtml + '</div>'
    : resultHtml;
  state.toolResults[toolId] = batchHtml + (state.toolResults[toolId] || "");
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

// 轮询查询任务（v2 查询接口直接返回状态+结果）
async function waitTask(taskId, run, onTick) {
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000));
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

// ================= 主流程 =================
export async function runActiveTool() {
  const runBtn = document.getElementById("runBtn");
  if (state.currentRun) {
    showStatus("已有任务正在运行，请先等待完成或取消当前任务", "error");
    return;
  }
  const tool = activeTool();
  if (!apiKey()) { showStatus("请先点击右上角设置 API Key", "error"); return; }
  if (!tool) { showStatus("请先在左侧选择一个工具", "error"); return; }
  if (tool.deleted) { showStatus("该工具在回收站中，请先在左侧还原再使用", "error"); return; }
  if (!tool.webappId) { showStatus("当前工具未填写应用 ID，请点击右上角「配置此工具」", "error"); return; }

  runBtn.disabled = true;
  const runToolId = tool.id;  // 记录本次运行属于哪个工具，防止运行中切换工具后结果串位
  state.runningToolId = runToolId;
  // 一开始就建立运行上下文并显示取消按钮：上传阶段也能随时中断
  const abortCtrl = new AbortController();
  const run = { taskId: null, cancelled: false, abortCtrl };
  state.currentRun = run;
  const cancelBtn = document.getElementById("cancelBtn");
  cancelBtn.style.display = ""; cancelBtn.disabled = false;
  refreshToolItemStates();  // 左侧列表立即显示"生成中"高亮
  // 不在开始时清空结果区：保留历史结果，进度由状态栏提示
  // 检查是否已被取消（各阶段之间调用，避免取消后继续提交）
  const throwIfCancelled = () => {
    if (run.cancelled) throw new DOMException("已取消", "AbortError");
  };
  try {
    // 逐字段组装 nodeInfoList
    const nodeInfoList = [];
    for (let i = 0; i < tool.fields.length; i++) {
      const f = tool.fields[i];
      if (f.type === "image") {
        if (!state.fieldFiles[i]) throw new Error("请上传「" + f.label + "」");
        throwIfCancelled();
        showStatus("⏫ 正在上传「" + f.label + "」…（可点「立即取消」中断）");
        const fileName = await uploadImage(state.fieldFiles[i], abortCtrl.signal);
        throwIfCancelled();
        nodeInfoList.push({ nodeId: f.nodeId, fieldName: f.fieldName, fieldValue: fileName });
      } else {
        const el = document.getElementById("ff_" + i);
        const v = el ? el.value.trim() : "";
        const val = v !== "" ? v : (f.def || "");
        if (val !== "") nodeInfoList.push({ nodeId: f.nodeId, fieldName: f.fieldName, fieldValue: val });
      }
    }
    // 仅当工具配置了输入项却全部为空时才视为配置错误；
    // 无输入项的"零参数工作流"允许空 nodeInfoList 提交
    if (!nodeInfoList.length && tool.fields && tool.fields.length) {
      throw new Error("没有可提交的参数，请检查工具配置");
    }

    throwIfCancelled();
    showStatus("🚀 正在创建任务…");
    const taskId = await createTask(tool, nodeInfoList, abortCtrl.signal);
    run.taskId = taskId;
    // 任务已提交成功但用户此刻点了取消：需要同时通知服务端停止，避免继续扣费
    if (run.cancelled) {
      try { await cancelTask(taskId); } catch (e) {}
      throw new DOMException("已取消", "AbortError");
    }
    showStatus("⏳ 任务运行中（taskId: " + taskId + "）…");
    const { results, usage, cancelled } = await waitTask(taskId, run, (s, i) => {
      showStatus("⏳ 任务状态：" + (s || "未知") + "（已等待 " + (i * 3 + 3) + " 秒）");
    });

    if (cancelled) {
      showStatus("⏹ 已取消，任务已停止", "");
      showResultNotice(runToolId, '<div class="result-placeholder">已取消</div>');
      return;
    }

    // 结果追加到该工具的历史记录；若用户还停留在该工具界面则直接更新显示
    appendResultBatch(runToolId, buildResultHtml(results));
    // 标记最近完成工具（左侧列表绿色高亮，刷新后保留）
    state.lastDoneToolId = runToolId;
    saveLastDone();
    // 图片加载完成后回填像素尺寸（仅在仍停留在该工具界面时操作 DOM）
    bindResultImageDims(runToolId);

    // 自动下载结果原图到本地（避免24小时后链接过期丢失）
    let downloaded = 0;
    let byServer = 0;
    for (let idx = 0; idx < results.length; idx++) {
      const it = results[idx];
      if (!it.url || !(it.outputType || "").match(/png|jpe?g|webp|gif|mp4|mov/i)) continue;
      const fname = (tool.name || "result") + "_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
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
            if (j && j.ok) { downloaded++; byServer++; continue; }
          }
        } catch (e) { /* 旧版服务没有该接口，走下面的兜底 */ }
      }
      try {
        const r = await fetch(it.url);
        const b = await r.blob();
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
    try {
      const filled = await enrichSelectOptions(tool);
      if (filled) {
        saveTools();
        if (state.activeId === runToolId) refreshSelectOptions(tool);
        try {
          await persistTool(tool);
        } catch (e) { /* 写目录失败时 localStorage 已更新 */ }
        optionTip = "；已自动补全 " + filled + " 个下拉列表的选项";
      }
    } catch (e) { /* 工作流接口可能不支持拉取，失败不影响本次结果 */ }

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
    showStatus(costText + optionTip + "。链接24小时内有效，请及时下载", "success");
  } catch (err) {
    // 用户主动取消（上传/提交阶段被中断）：静默收尾，不显示成错误
    if (err.name === "AbortError" || run.cancelled) {
      showStatus("⏹ 已取消", "");
      showResultNotice(runToolId, '<div class="result-placeholder">已取消</div>');
      return;
    }
    showStatus("❌ " + err.message, "error");
    showResultNotice(runToolId, '<div class="result-placeholder">生成失败</div>');
  } finally {
    const cur = activeTool();
    // 只允许本次运行清理自己的上下文，避免异步收尾误清除其它运行状态。
    if (state.currentRun === run) {
      state.currentRun = null;
      state.runningToolId = null;
      cancelBtn.style.display = "none";
    }
    runBtn.disabled = !!state.currentRun || !!(cur && cur.deleted);
    refreshToolItemStates();  // 运行结束：黄色高亮转为"最近完成"或恢复默认
  }
}

// 立即取消：上传阶段直接中断网络请求；已创建任务时再通知 RunningHub 停止
export async function cancelCurrentRun() {
  if (!state.currentRun || state.currentRun.cancelled) return;
  const run = state.currentRun;
  run.cancelled = true;
  document.getElementById("cancelBtn").disabled = true;
  showStatus("⏹ 正在取消…");
  // 中断仍在进行的上传/提交请求，避免流量与时间浪费
  try { run.abortCtrl && run.abortCtrl.abort(); } catch (e) {}
  // 任务已提交到服务端时才需要通知停止
  if (run.taskId) {
    try { await cancelTask(run.taskId); } catch (e) { /* 取消失败也不影响本地停止 */ }
  }
}
