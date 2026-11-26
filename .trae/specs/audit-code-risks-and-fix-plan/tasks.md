# Tasks

> 状态：全部完成。按 P0 → P1 → P2 顺序实施；每项完成后在 `checklist.md` 勾选对应验收点。

- [x] Task 1: 加固自动更新安装链（SEC-01）
  - [x] 1.1 在 `_download_update_worker` 中强制要求 `sha256` 与 `size`，缺失即判定清单无效
  - [x] 1.2 在 `/update/install` 执行前校验版本必须大于当前 `APP_VERSION`，并重新核对大小与摘要
  - [x] 1.3 采用 Ed25519 清单签名：生成密钥对，公钥内置 `update_sign.py`，私钥放 `.private/` 并忽略提交
  - [x] 1.4 `发布更新.py` 发布前强制签名清单；客户端 `_fetch_update_manifest` 对每个源验签，失败切源
  - [x] 1.5 取消 Authenticode 强制，仅在打包脚本保留可选签名钩子；launcher 不再重复校验

- [x] Task 2: 限制请求体、远程响应与连接超时（SEC-02）
  - [x] 2.1 新增统一的请求体读取函数：上限（JSON 建议 2 MB）、拒绝负数/非数字 `Content-Length`、超限返回 413
  - [x] 2.2 `/save-cover` 改用统一读取函数，并限制封面大小（建议 30 MB）
  - [x] 2.3 更新/公告清单读取设置上限（建议 512 KB），使用 `read(limit+1)` 判断超限
  - [x] 2.4 `/save-image` 改为分块写盘并限制最大响应大小，失败时删除半成品
  - [x] 2.5 为 HTTP 连接设置读取超时，避免慢速请求长期占用线程

- [x] Task 3: 增加安全响应头与静态资源白名单（SEC-03、SEC-04）
  - [x] 3.1 在 `end_headers` 统一附加 `X-Frame-Options: DENY`、`Content-Security-Policy: frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`
  - [x] 3.2 将 `SimpleHTTPRequestHandler` 的回退路径改为显式白名单：`index.html`、`css/`、`js/`、`ICO/` 及明确允许的资源
  - [x] 3.3 阻断 `/server.py`、`appinfo.txt`、`*.log`、`user_tools/`、`sys_tools/`、`.git/`、`.trae/` 等路径
  - [x] 3.4 关闭目录列表；保留 `/appinfo`、`/tools-index`、`/tools/`、`/downloads/`、`/update/*` 等既有接口
  - [x] 3.5 验证页面、公告、更新、封面、结果预览均不受白名单影响

- [x] Task 4: 修正工具保存的删除与改名语义（BUG-01、BUG-02）
  - [x] 4.1 `/save-tool` 校验 `content` 必须是 JSON 对象；数组、`null`、缺字段返回 400
  - [x] 4.2 移除按 `webappId`/名称自动删除其他配置的逻辑；仅在明确覆盖同一内部 ID 时更新
  - [x] 4.3 旧文件与新文件使用 `os.path.normcase(os.path.abspath(...))` 判断是否同一文件，仅改大小写时不删除
  - [x] 4.4 保存改为临时文件 + `os.replace` 原子写入，失败不留下半截配置
  - [x] 4.5 同步调整前端 `store.js` / `loadToolsFromDir` 的同 `webappId` 去重规则
  - [x] 4.6 更新受影响的提示文案与配置说明

- [x] Task 5: 让持久化失败可见（BUG-03）
  - [x] 5.1 `persistTool` 在 HTTP 非 2xx、响应非 `ok`、网络异常时抛出错误，不再返回 `null`
  - [x] 5.2 配置弹窗保存流程：先写盘成功，再关闭弹窗并提示成功；失败保留弹窗并允许重试
  - [x] 5.3 `removeToolFile` 同样返回明确失败，删除/回收站流程不得静默吞错
  - [x] 5.4 保存失败时回滚 `state.tools` 或明确标记“未写入磁盘”

- [x] Task 6: 修复更新下载并发与清单校验（BUG-04）
  - [x] 6.1 `/update/download` 在 `starting` 与 `downloading` 阶段都返回 409
  - [x] 6.2 校验客户端传入的 `manifest`：`installer` 必须为对象，`size` 必须为合法整数
  - [x] 6.3 保证只有一个线程写 `.part`；取消/失败统一清理临时文件
  - [x] 6.4 增加回归用例：连续两次请求只产生一个下载任务

- [x] Task 7: 恢复运行中的任务状态（REL-01）
  - [x] 7.1 任务创建成功后持久化 `taskId`、`toolId`、阶段和创建时间
  - [x] 7.2 页面启动时恢复未完成任务并继续查询，避免重复提交
  - [x] 7.3 无法恢复时明确提示任务状态已丢失，并提供到 RunningHub 控制台查看的入口

- [x] Task 8: 收紧系统操作与密钥暴露面（SEC-05、SEC-06）
  - [x] 8.1 `/open-dir` 拒绝 UNC、设备路径和非本地绝对路径，规范化后校验
  - [x] 8.2 节点信息请求优先改为 `Authorization` 头；若接口不支持，记录为已知例外
  - [x] 8.3 错误信息和日志中不输出含 `apiKey` 的完整 URL

- [x] Task 9: 事务化重置系统工具并校验封面（BUG-05、BUG-06）
  - [x] 9.1 解压到临时目录，校验条目路径（拒绝盘符、冒号、`..`、绝对路径）与总大小
  - [x] 9.2 校验通过后原子替换 `sys_tools`；失败保留原目录
  - [x] 9.3 封面按魔数识别 PNG/JPEG/WebP/GIF，拒绝其他内容或统一转码
  - [x] 9.4 封面写入失败时返回明确错误，不留下错误扩展名文件

- [x] Task 10: 更新/公告检查的缓存与输入校验（SEC-02 补充）
  - [x] 10.1 `/update/check` 增加短时内存缓存（建议 5 分钟），避免重复外呼
  - [x] 10.2 公告 `publishedAt` 校验为真实日期；清单读取设置上限
  - [x] 10.3 并发检查时复用同一进行中的请求，避免线程堆积

- [x] Task 11: 回归与安全验证
  - [x] 11.1 静态检查：`python -m py_compile server.py launcher.py`，`node --check` 所有改动 JS
  - [x] 11.2 接口回归：保存/删除/改名/同应用多版本/仅改大小写
  - [x] 11.3 安全用例：超大请求体、负数 Content-Length、非法清单、UNC 路径、iframe 嵌入、API Key 不出现在 URL
  - [x] 11.4 功能冒烟：首页、工具列表、上传、生成、取消、结果下载、公告、更新检查
  - [x] 11.5 确认老版本客户端和既有工具配置不受影响

# Task Dependencies

- Task 2、Task 3 可并行，二者不依赖 Task 1
- Task 5 依赖 Task 4（保存语义稳定后再改前端失败处理）
- Task 7 依赖 Task 6（下载/状态机稳定后再做任务恢复）
- Task 9 依赖 Task 2（统一大小限制后再做压缩包上限）
- Task 10 依赖 Task 2
- Task 11 依赖 Task 1–10 全部完成
