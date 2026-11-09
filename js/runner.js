// ================= 任务运行流程：组装参数、提交、轮询、取消、自动下载、扣费提示 =================
import { state, activeTool, saveToDir } from "./store.js";
import { apiKey, uploadImage, createTask, queryTask, cancelTask } from "./api.js";
import { showStatus } from "./ui/form.js";
import { buildResultHtml, bindResultImageDims } from "./ui/results.js";

// 轮询查询任务（v2 查询接口直接返回状态+结果）
async function waitTask(taskId, onTick) {
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 3000));
    if (state.currentRun && state.currentRun.cancelled) return { cancelled: true, results: [], usage: {} };
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
  const tool = activeTool();
  if (!apiKey()) { showStatus("请先点击右上角设置 API Key", "error"); return; }
  if (!tool) { showStatus("请先在左侧选择一个工具", "error"); return; }
  if (!tool.webappId) { showStatus("当前工具未填写应用 ID，请点击右上角「配置此工具」", "error"); return; }

  runBtn.disabled = true;
  const runToolId = tool.id;  // 记录本次运行属于哪个工具，防止运行中切换工具后结果串位
  state.runningToolId = runToolId;
  document.getElementById("resultArea").innerHTML = '<div class="result-placeholder">生成中…</div>';
  try {
    // 逐字段组装 nodeInfoList
    const nodeInfoList = [];
    for (let i = 0; i < tool.fields.length; i++) {
      const f = tool.fields[i];
      if (f.type === "image") {
        if (!state.fieldFiles[i]) throw new Error("请上传「" + f.label + "」");
        showStatus("⏫ 正在上传「" + f.label + "」…");
        const fileName = await uploadImage(state.fieldFiles[i]);
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

    showStatus("🚀 正在创建任务…");
    const taskId = await createTask(tool, nodeInfoList);
    state.currentRun = { taskId, cancelled: false };
    const cancelBtn = document.getElementById("cancelBtn");
    cancelBtn.style.display = ""; cancelBtn.disabled = false;
    showStatus("⏳ 任务运行中（taskId: " + taskId + "）…");
    const { results, usage, cancelled } = await waitTask(taskId, (s, i) => {
      showStatus("⏳ 任务状态：" + (s || "未知") + "（已等待 " + (i * 3 + 3) + " 秒）");
    });

    if (cancelled) {
      showStatus("⏹ 已取消，任务已停止", "");
      state.toolResults[runToolId] = '<div class="result-placeholder">已取消</div>';
      if (state.activeId === runToolId) document.getElementById("resultArea").innerHTML = state.toolResults[runToolId];
      return;
    }

    // 结果写入所属工具的存储；若用户还停留在该工具界面则直接更新显示
    const resultHtml = buildResultHtml(results);
    state.toolResults[runToolId] = resultHtml;
    if (state.activeId === runToolId) document.getElementById("resultArea").innerHTML = resultHtml;
    // 图片加载完成后回填像素尺寸（仅在仍停留在该工具界面时操作 DOM）
    bindResultImageDims(runToolId);

    // 自动下载结果原图到本地（避免24小时后链接过期丢失）
    let downloaded = 0;
    for (let idx = 0; idx < results.length; idx++) {
      const it = results[idx];
      if (!it.url || !(it.outputType || "").match(/png|jpe?g|webp|gif|mp4|mov/i)) continue;
      try {
        const r = await fetch(it.url);
        const b = await r.blob();
        const fname = (tool.name || "result") + "_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
          + (results.length > 1 ? "_" + (idx + 1) : "") + "." + (it.outputType || "png");
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
    // 组装扣费信息
    let costText = "✅ 生成完成！共 " + results.length + " 个输出";
    if (downloaded) costText += "，已自动下载 " + downloaded + " 个文件到「" + (state.dirHandle ? state.dirHandle.name : "浏览器下载目录") + "」";
    if (usage && (usage.consumeMoney || usage.consumeCoins || usage.taskCostTime)) {
      const parts = [];
      if (usage.taskCostTime) parts.push("耗时 " + usage.taskCostTime + " 秒");
      if (usage.consumeMoney && usage.consumeMoney !== "0") parts.push("扣费 ¥" + usage.consumeMoney);
      if (usage.consumeCoins && usage.consumeCoins !== "0") parts.push("消耗 " + usage.consumeCoins + " RH币");
      if (parts.length) costText += "（" + parts.join("，") + "）";
    }
    showStatus(costText + "。链接24小时内有效，请及时下载", "success");
  } catch (err) {
    showStatus("❌ " + err.message, "error");
    state.toolResults[runToolId] = '<div class="result-placeholder">生成失败</div>';
    if (state.activeId === runToolId) document.getElementById("resultArea").innerHTML = state.toolResults[runToolId];
  } finally {
    runBtn.disabled = false;
    document.getElementById("cancelBtn").style.display = "none";
    state.currentRun = null;
    state.runningToolId = null;
  }
}

// 立即取消：停止本地轮询 + 通知 RunningHub 停止任务
export async function cancelCurrentRun() {
  if (!state.currentRun || state.currentRun.cancelled) return;
  state.currentRun.cancelled = true;
  document.getElementById("cancelBtn").disabled = true;
  showStatus("⏹ 正在取消…");
  try {
    await cancelTask(state.currentRun.taskId);
  } catch (e) { /* 取消请求失败也不影响本地停止 */ }
}
