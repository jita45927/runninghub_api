# RunningHub AI 工具箱：系统性 BUG 与安全风险修复报告

- 审查日期：2026-11-16
- 代码基线：提交 `45ab1f9` 对应的当前第一方源代码
- 审查方式：完整静态调用链审查 + 隔离环境动态验证
- 审查范围：`server.py`、`launcher.py`、`index.html`、全部 `js/**/*.js`、安装与启动脚本
- 不包含：第三方依赖内部代码、真实 RunningHub 付费任务、真实 API Key、ComfyUI 项目

## 一、执行摘要

本次共确认 **12 项问题**：**高危 3 项、中危 7 项、低危 2 项**。其中系统性 BUG 8 项、安全风险 4 项。

| 类别 | 高危 | 中危 | 低危 | 合计 |
|---|---:|---:|---:|---:|
| 系统性 BUG | 2 | 5 | 1 | 8 |
| 安全风险 | 1 | 2 | 1 | 4 |
| 合计 | 3 | 7 | 2 | 12 |

最重要的四个系统性根因是：

1. **把环回地址误当成完整信任边界**：恶意网页无需读取响应，也能向本地服务发送简单请求；远程下载接口还允许控制请求主机。
2. **任务运行上下文是全局单例且仅存在于页面内存**：切换工具可覆盖运行状态，刷新或关闭窗口后无法恢复任务与自动下载。
3. **工具身份、文件名和缓存权威规则不统一**：前端、服务端分别按名称/`webappId` 去重，Windows 大小写语义又未统一，已实测造成配置和封面误删。
4. **程序资源与用户可变数据混放**：安装器递归覆盖整个程序目录，而工具配置、封面和下载数据也位于该目录。

建议在下一次广泛分发安装包前，优先处理 **SEC-03、SEC-01、SEC-02、BUG-01、BUG-07**。

## 二、系统性 BUG 清单

| ID | 严重级别 / 置信度 | 问题与确定性触发路径 | 影响 | 修复建议 | 回归验证 | 位置 |
|---|---|---|---|---|---|---|
| BUG-01 | HIGH / 0.99 | **切换工具可覆盖全局运行上下文。** A 运行后切换到 B，`renderWorkspace` 只按回收站状态重设运行按钮；启动 B 会覆盖 `currentRun` 和 `runningToolId`。A 的 `finally` 随后清空 B 的状态并隐藏取消按钮。 | 可同时提交多个付费任务；B 可能无法取消；运行高亮、删除保护和状态提示串扰。 | 当前架构下先禁止全局并发，任何工具运行时都保持其他运行按钮禁用；每次运行捕获独立的局部上下文，`finally` 只能清理属于自己的那一次运行。未来若支持并行任务，再改为按运行 ID/工具 ID 管理独立上下文。 | A 运行时切换 B 不能再次提交；A 结束不得清除 B 的取消按钮或状态；连续点击和切换均不得产生失控任务。 | [runner.js](file:///d:/project/runninghub_api/js/runner.js#L80-L96)、[runner.js](file:///d:/project/runninghub_api/js/runner.js#L227-L249)、[form.js](file:///d:/project/runninghub_api/js/ui/form.js#L77-L81)、[toollist.js](file:///d:/project/runninghub_api/js/ui/toollist.js#L283-L290) |
| BUG-02 | MEDIUM / 0.99 | **刷新或 X 关闭窗口后，已创建任务无法恢复。** 会话只保存结果和字段值，不保存 `taskId`；轮询与自动下载只存在于原页面 JavaScript 上下文。 | RunningHub 任务可能继续扣费运行，但重新打开后无法查看进度、取消、接收结果或自动下载；链接过期后结果可能丢失。 | 创建成功后立即按工具持久化任务 ID、阶段和时间；刷新/重开时恢复查询并去重追加结果。若要求窗口关闭期间仍持续轮询和下载，应把任务代理、轮询和下载移到本地后端，而不是仅依赖浏览器页面。 | 在轮询阶段刷新及 X 重开，任务可继续查询、取消并自动下载；恢复不得重复追加批次；上传尚未创建任务时应明确提示无法恢复。 | [runner.js](file:///d:/project/runninghub_api/js/runner.js#L12-L42)、[runner.js](file:///d:/project/runninghub_api/js/runner.js#L64-L76)、[runner.js](file:///d:/project/runninghub_api/js/runner.js#L129-L191)、[launcher.py](file:///d:/project/runninghub_api/launcher.py#L220-L227) |
| BUG-03 | MEDIUM / 0.99 | **同一 `webappId` 的不同版本被当作重复配置并物理删除。** 前端合并同 ID 工具，服务端保存时还会删除其他同 ID 配置及同名封面。隔离测试中保存 V1 后再保存同应用 V2，V1 配置和封面均不存在。 | 用户按 V1/V2 区分节点参数的同应用工具会丢失；导入、保存或自动补全下拉选项都可能触发清理。 | 使用稳定且唯一的内部工具 ID 作为身份主键并写入配置文件；`webappId` 只表示远程应用，不应唯一决定本地工具身份。仅在用户明确导入同一内部 ID 时执行更新，禁止静默删除名称不同的同应用版本。 | 同 `webappId`、不同名称和节点参数的两个工具可同时加载、改名、保存和重启；互不删除配置或封面。 | [store.js](file:///d:/project/runninghub_api/js/store.js#L57-L60)、[tools.js](file:///d:/project/runninghub_api/js/tools.js#L96-L108)、[server.py](file:///d:/project/runninghub_api/server.py#L345-L369) |
| BUG-04 | MEDIUM / 0.99 | **Windows 下仅修改工具名大小写会删除刚保存的配置。** 新旧文件名仅大小写不同，代码仍执行旧文件清理；在大小写不敏感文件系统上，新旧路径实际指向同一文件。隔离测试保存后目录中没有任何对应配置。 | 一次正常改名即可使工具配置消失，并可能同时删除封面。 | 在判断新旧文件是否为同一文件时使用规范化绝对路径和 Windows 大小写语义；同一文件不得进入旧文件删除分支。保存与改名应具备明确的顺序和失败回滚。 | 对 `CaseTool` → `casetool`、仅大小写改封面、普通改名三类情况分别测试，配置均存在且内容正确。 | [server.py](file:///d:/project/runninghub_api/server.py#L295-L320)、[server.py](file:///d:/project/runninghub_api/server.py#L323-L343) |
| BUG-05 | MEDIUM / 0.97 | **持久化失败可被表现为成功。** `persistTool` 在 HTTP 失败且无目录句柄时返回 `null`，不抛出错误；移入回收站的调用方无论返回值如何都显示成功。配置弹窗也先修改缓存、关闭并刷新，再尝试写盘。 | 用户认为配置或回收站状态已保存，实际只改了内存/localStorage；刷新或重置缓存后状态回退，磁盘与界面长期不一致。 | 服务端模式下的非成功响应、空响应和网络失败必须形成明确错误；调用方不能用 `null` 代表成功。写盘失败时回滚 UI 状态或显著标记“仅本次会话有效”，不得显示已写入 tools。 | 模拟 500、断连、无权限和无效 JSON；界面不得显示保存成功，重新扫描后状态必须与提示一致。 | [tools.js](file:///d:/project/runninghub_api/js/tools.js#L193-L215)、[toollist.js](file:///d:/project/runninghub_api/js/ui/toollist.js#L39-L55)、[modal.js](file:///d:/project/runninghub_api/js/ui/modal.js#L325-L340) |
| BUG-06 | LOW / 0.98 | **工具目录被外部删除或清理后，旧缓存仍保留“幽灵工具”。** 启动先加载 localStorage，目录扫描只新增或更新，不移除本次快照中已不存在的配置。 | tools 已不是界面所声称的唯一权威数据源；已删除工具可能继续显示、运行或被重新保存。手动“重置工具缓存”才能可靠清除。 | 在本地服务模式下，每次完整扫描成功后以目录快照替换缓存；扫描失败时保留旧数据并明确提示，不能把失败当作空目录。授权目录模式采用同样的对账规则。 | 外部删除一个配置后刷新，工具消失；模拟目录读取失败，旧工具保留但显示错误；空目录和读取失败必须可区分。 | [store.js](file:///d:/project/runninghub_api/js/store.js#L25-L65)、[tools.js](file:///d:/project/runninghub_api/js/tools.js#L79-L112)、[tools.js](file:///d:/project/runninghub_api/js/tools.js#L63-L75) |
| BUG-07 | HIGH / 0.99 | **覆盖安装会覆盖用户工具数据，卸载也会删除已安装的数据文件。** 安装器使用 `ignoreversion recursesubdirs` 将整包复制到 `{app}`；启动器又把 tools、download 和 appinfo 放在同一程序目录。 | 升级可用包内旧版本覆盖用户修改过的工具配置和封面；卸载会删除安装器登记过的文件，造成批量数据丢失。 | 将只读程序资源与可变用户数据分离；用户数据放到独立、明确的用户数据目录或用户选择目录。升级只更新程序资源，内置示例仅在首次安装或用户明确重置时复制；卸载默认保留数据，删除数据必须单独明确确认。发布修复版前提供迁移与备份逻辑。 | 先修改内置工具、增加自定义工具和下载结果，再覆盖安装与卸载；所有用户数据均应保留，升级后的默认资源不得回写用户目录。 | [installer.iss](file:///d:/project/runninghub_api/installer.iss#L39-L46)、[launcher.py](file:///d:/project/runninghub_api/launcher.py#L63-L85) |
| BUG-08 | MEDIUM / 0.96 | **服务落到非默认端口后，单实例检测失效。** 服务端可在 8900–8909 中顺延，但重复启动时只检查 8900。若当前实例在 8901 且 8900 被其他程序占用，再次启动会创建另一组服务和托盘。 | 多后台实例、多托盘图标、配置写入和退出目标不一致，浏览器可能连接不同实例。 | 使用 Windows 命名互斥体实现真正的进程级单实例；端口只负责连接，不负责身份判断。实例检测还应使用应用专属标识，而不是只检查响应里是否有 `tools` 字段。 | 分别占用 8900、让首实例落到 8901，再重复启动；始终只有一组服务和托盘，并能唤回正确窗口。 | [launcher.py](file:///d:/project/runninghub_api/launcher.py#L295-L336)、[server.py](file:///d:/project/runninghub_api/server.py#L491-L507) |

## 三、安全风险清单

| # | Category | Title | Severity | Confidence | Evidence (Source → Sink) | Recommendation | Location |
|---|---|---|---|---|---|---|---|
| SEC-01 | cross_site_request_forgery | 恶意网页可跨站写删本地工具配置，并调用其他本地系统接口 | MEDIUM | 0.99 | 恶意网页发送 `Origin: https://attacker.example`、`Content-Type: text/plain` 的简单 POST → `do_POST` 未校验来源、会话或用户确认 → `/save-tool`/`/delete-tool` 写删文件。隔离实测两次均返回 200，文件先创建后被删除。相同根因还覆盖打开 URL/目录及关闭服务。 | 不依赖 CORS 作为防护；所有变更类接口统一校验应用专属来源、Host 和每次启动随机令牌的自定义请求头，拒绝跨站简单请求和 DNS rebinding。打开目录、选择目录等 GET 副作用操作也应纳入同一保护。 | [server.py](file:///d:/project/runninghub_api/server.py#L199-L241)、[server.py](file:///d:/project/runninghub_api/server.py#L295-L321)、[server.py](file:///d:/project/runninghub_api/server.py#L371-L385) |
| SEC-02 | ssrf | `/save-image` 允许任意主机的服务端请求，并自动跟随重定向 | MEDIUM | 0.99 | 请求体 `url` 仅检查 http/https 前缀 → `urllib.request.urlopen` 发起请求并跟随 302 → 响应写入下载目录。隔离测试中本地模拟端点依次收到 `/redirect`、`/final`，标记内容成功落盘。结合 SEC-01，恶意网页可触发本机访问环回或内网 HTTP 服务。 | 优先仅允许预期的 RunningHub/CDN 主机和 HTTPS；解析目标并拒绝环回、内网、链路本地及保留地址；重定向应关闭或逐跳重新校验主机和解析地址。不要仅依赖 URL 字符串前缀。 | [server.py](file:///d:/project/runninghub_api/server.py#L387-L405) |
| SEC-03 | os_command_injection | 下载目录路径直接插入 PowerShell 脚本，可执行注入命令 | HIGH | 0.96 | `appinfo.txt` 中的下载路径/用户选择目录 → `start_hint` → f-string 插入单引号 PowerShell 脚本 → `powershell -Command`。隔离测试使用含引号的构造路径，无害标记命令被实际执行并在打开对话框前退出。启动批处理对 `%CD%` 也有相同插值模式。 | 路径不得拼入脚本源码；通过参数列表或环境变量传递，并在 PowerShell 内作为数据读取。同步修复服务端和启动批处理，避免只修一个入口。 | [server.py](file:///d:/project/runninghub_api/server.py#L80-L103)、[server.py](file:///d:/project/runninghub_api/server.py#L446-L469)、[启动工具.bat](file:///d:/project/runninghub_api/启动工具.bat#L11-L28) |
| SEC-04 | sensitive_data_exposure | 节点信息请求把 API Key 复制到 URL 查询字符串 | LOW | 0.85 | `localStorage` 中的 Key → `apiKey` 查询参数拼入 URL → `fetch` 请求完整 URL。URL 比请求头更容易进入浏览器网络错误信息、代理和服务端访问日志，增加密钥暴露面。 | 如果接口支持，统一只使用 Authorization 请求头，不再复制到查询字符串；若旧接口强制要求该参数，应明确记录例外，避免在日志和错误 UI 中输出完整 URL，并评估由本地后端转发。 | [api.js](file:///d:/project/runninghub_api/js/api.js#L4-L8)、[api.js](file:///d:/project/runninghub_api/js/api.js#L79-L93) |

## 四、优先修复顺序

### P0：下一次构建/分发前完成

1. **修复 PowerShell 命令注入（SEC-03）**：先消除命令执行入口，同时覆盖服务端和启动脚本。
2. **统一本地服务安全边界（SEC-01、SEC-02）**：来源验证、随机令牌、Host 校验和远程下载目标限制应作为一个整体实施，避免只修单个端点。
3. **阻止并发任务失控（BUG-01）**：先采用全局互斥的最小修复，再决定是否需要真正的多任务架构。
4. **保护升级与卸载数据（BUG-07）**：在下一份安装包发布前完成用户数据目录迁移和备份，否则修复其他问题后仍可能在升级时丢失配置。

### P1：随后完成数据一致性与任务恢复

1. 统一工具内部 ID、版本共存和 Windows 文件名语义（BUG-03、BUG-04）。
2. 持久化并恢复任务 ID；需要真正后台运行时，将任务代理移到后端（BUG-02）。
3. 让写盘失败可见且可回滚，消除假成功（BUG-05）。
4. 移除节点信息 URL 中的 Key，或明确旧接口例外并控制日志暴露（SEC-04）。

### P2：完成权威缓存与进程治理

1. 以成功读取的 tools 快照对账缓存，区分空目录和读取失败（BUG-06）。
2. 用命名互斥体保证单实例，端口扫描仅作为辅助（BUG-08）。

公共核心中的 BUG-01、BUG-02、BUG-03、BUG-05、BUG-06 修复完成后，应按项目既有同步流程评估 ComfyUI 版本；本次未修改或同步该项目。

## 五、已核实非问题与既定设计

- **未发现硬编码 API Key、密码或私钥**：第一方 Python、JavaScript、HTML 和脚本的密钥模式扫描无匹配。
- **未确认 DOM XSS**：表单字段、标签和配置编辑器使用统一转义；工具原始地址限制 http/https；结果区主要通过 DOM 构建并使用 `textContent`，结果 URL 有协议白名单。未把单纯 `innerHTML` 使用误报为漏洞。
- **测试的直接文件名穿越被清理**：`_safe_filename` 将 `..\outside.txt` 规范为 `outside.txt`，本次未确认通过该函数逃逸 tools/download 的路径。
- **localStorage 保存 API Key 是既定设计**：不单独计为漏洞；真正需要控制的是 XSS、恶意请求目标和 URL/日志泄露。
- **服务只监听 `127.0.0.1`**：因此未暴露为直接局域网监听服务，但这不能阻止浏览器跨站请求，SEC-01/SEC-02 仍成立。
- **X 与彻底退出的不同交互是既定设计**：本报告关注的是任务状态没有随窗口生命周期恢复，而不是要求移除 X 或托盘。

## 六、验证记录与限制

### 已执行

- 对 2 个 Python 文件完成无缓存 AST 解析，全部通过。
- 对 15 个 JavaScript 文件执行 `node --check`，全部通过。
- 在独立临时目录和 18973 端口启动隔离服务，未接触项目 `appinfo.txt`、真实 tools 或 download。
- 使用恶意 Origin + `text/plain` 请求实测跨站写入和删除，均返回 200 且文件状态符合预期。
- 使用本地模拟 HTTP 服务实测 SSRF 重定向和响应落盘，收到完整两次请求并读取到固定测试标记。
- 使用无害固定输出标记验证 PowerShell 插值命令确实执行，未执行任何系统修改命令。
- 实测同 `webappId` 的 V1 配置和封面被 V2 保存清理。
- 实测 Windows 大小写改名后配置文件不存在。
- 测试服务、Python 进程、临时脚本和临时文件均已停止或清理。

### 未执行及限制

- 未提交真实 RunningHub 任务，因此 BUG-01、BUG-02 基于确定性的前端状态和调用链证明，未产生真实费用。
- 未读取或验证真实 API Key；SEC-04 不评价 RunningHub 服务端是否实际记录查询字符串，只评价客户端造成的额外暴露面。
- 未对真实内网地址发起 SSRF；利用能力仅通过本地模拟端点证明。
- 未执行安装/卸载破坏性测试；BUG-07 由安装器的 `ignoreversion` 全目录覆盖规则和数据目录位置直接证明。
- 未进行第三方依赖 CVE 审查、浏览器内核漏洞审查或完整渗透测试。
- 未达到证据门槛的封面异步竞态、非原子写入等候选未列入正式问题清单，后续可在故障注入测试中单独验证。
