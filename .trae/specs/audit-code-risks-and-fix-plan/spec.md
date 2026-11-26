# 当前代码多角度风险审计与修复 Spec

> 状态：审计完成，待确认修复计划；本轮不修改运行代码。
> 审计基线：`master` 当前工作区（含公告功能 `256721b` 之后未提交改动）。
> 审计范围：`server.py`、`launcher.py`、`index.html`、`js/**/*.js`、`installer.iss`、`启动工具.bat`、`发布更新.py`。
> 不包含：第三方依赖内部实现、RunningHub 云端接口真实计费行为。

## Why

项目已经具备本地 HTTP 服务、自动更新、工具配置读写、结果下载和公众号公告等能力，攻击面和数据一致性要求都比早期版本更大。上一份系统性审计基线较早，新增代码（公告、令牌校验、更新下载、静态文件服务）尚未经过一次完整复核。需要在下一份安装包分发前，确认当前代码仍存在的漏洞、BUG 和风险，并给出按优先级排序、可验证的修复计划。

## What Changes

- 本轮只产出审计结论和修复方案，不修改任何运行代码。
- 将问题按 P0/P1/P2 分级，并绑定到可验证的验收场景。
- 修复阶段将涉及：更新安装链校验、请求/响应大小限制、安全响应头、静态资源暴露范围、工具配置保存语义、持久化失败反馈、更新并发控制、压缩包解压、API Key 暴露面、任务状态恢复。
- **BREAKING**：无。若后续按本 Spec 实施，`/save-tool` 对同 `webappId` 工具的清理语义、静态资源可访问范围、更新安装前置校验会发生变化，需要同步更新使用说明。

## Impact

- 受影响能力：本地服务安全边界、自动更新、工具配置持久化、结果下载、公告、任务运行恢复。
- 受影响代码：`server.py`、`launcher.py`、`js/api.js`、`js/tools.js`、`js/store.js`、`js/ui/modal.js`、`js/ui/toollist.js`、`js/runner.js`、`js/update.js`、`index.html`、`installer.iss`。
- 不涉及：ComfyUI 项目、RunningHub 服务端接口协议。

## 审计结论总览

共确认 **13 项**问题：P0 4 项、P1 5 项、P2 4 项。

| ID | 级别 | 类型 | 结论 |
|---|---|---|---|
| SEC-01 | P0 | 供应链 / 更新 | 更新清单没有独立签名，SHA256 与下载地址来自同一份未签名清单 |
| SEC-02 | P0 | 资源耗尽 | 请求体和远程响应无大小上限，负 `Content-Length` 可挂起线程 |
| SEC-03 | P0 | 浏览器边界 | 缺少防框架与安全响应头，本地界面可被第三方页面嵌套 |
| SEC-04 | P0 | 信息暴露 | 静态服务回退到整个程序目录，源码、日志、配置目录可被直接访问 |
| BUG-01 | P1 | 数据丢失 | 保存时按 `webappId`/名称静默删除其他工具；仅改大小写会删掉刚保存的文件 |
| BUG-02 | P1 | 健壮性 | `/save-tool` 接受非对象 JSON，触发 500 并写入坏配置 |
| BUG-03 | P1 | 假成功 | 写盘失败时前端仍显示已保存/已删除，磁盘与界面不一致 |
| BUG-04 | P1 | 并发 | 更新下载只拦截 `downloading`，`starting` 阶段可启动第二个下载线程 |
| REL-01 | P1 | 可靠性 / 费用 | 刷新或关闭窗口后任务 ID 丢失，任务继续计费但无法查询/取消 |
| SEC-05 | P2 | 密钥暴露 | 节点信息接口把 API Key 拼进 URL 查询字符串 |
| SEC-06 | P2 | 系统边界 | 打开目录接口接受任意绝对路径和 UNC 路径 |
| BUG-05 | P2 | 事务性 | 重置系统工具先删后解压，失败时留下半成品；解压路径校验不完整 |
| BUG-06 | P2 | 内容校验 | 封面只按 PNG 魔数判断，其余一律存成 `.jpg`，可能类型错标 |

### 已核实、不计为漏洞的项

- 本地服务仅监听 `127.0.0.1`，并校验 `Host` 为 `127.0.0.1/localhost:实际端口`，可阻断常规 DNS rebinding。
- 变更类接口统一校验 `Origin` + 每次启动随机令牌，使用 `hmac.compare_digest`；未设置 CORS 响应头。
- 结果下载限制 HTTPS、主机白名单、默认端口、公网解析地址，并禁止重定向。
- 公告链接在服务端和前端各校验一次 `https://mp.weixin.qq.com`；标题/摘要/URL 使用 `esc()`。
- 结果渲染使用 DOM API 和 `textContent`，URL 仅允许 `http/https/blob`；未确认可利用的 DOM XSS。
- 安装包已把 `user_tools/download/appinfo` 排除在安装目录外，用户数据与程序资源分离。
- `requirements.txt` / `requirements-build.txt` 已锁定版本。
- PowerShell 选目录与资源管理器置前已改为通过环境变量传路径，未发现命令拼接注入。

---

## ADDED Requirements

### Requirement: 更新清单必须经过 Ed25519 独立签名

系统 SHALL 在客户端内置 Ed25519 公钥，并在接受任何更新清单前验签；签名覆盖版本、安装包大小、SHA256 和下载地址。任何缺失签名、签名不匹配或清单被篡改的源都必须视为失败，并继续尝试下一个源；全部失败时按无更新处理。安装包 Authenticode 签名仅作为可选的 SmartScreen 增强，不再作为自动更新的强制条件。

#### Scenario: 清单被篡改
- **WHEN** 更新清单中的版本、下载地址或 SHA256 被替换，但未重新用私钥签名
- **THEN** 客户端验签失败，拒绝该清单，不提示、不下载

#### Scenario: 缺少签名
- **WHEN** release 分支的清单没有 `signature` 字段
- **THEN** 新版本客户端按无更新处理，不进入下载流程

#### Scenario: 私钥签名发布
- **WHEN** 发布者运行 `python 发布更新.py --publish` 且本地存在签名私钥
- **THEN** 清单被签名后写入 release 分支，客户端验签通过并正常提示更新

### Requirement: 本地服务必须限制请求体与远程响应大小

系统 SHALL 对 JSON 请求体、封面上传、更新/公告清单、结果下载设置明确上限；SHALL 拒绝负数或超过上限的 `Content-Length`；SHALL 为每个连接设置读取超时，避免慢速请求长期占用线程。

#### Scenario: 超大请求体
- **WHEN** 客户端发送超过上限的 `Content-Length`
- **THEN** 服务端立即返回 413，不读取完整请求体，不分配对应内存

#### Scenario: 非法长度
- **WHEN** `Content-Length` 为负数或非数字
- **THEN** 服务端返回 400 并关闭连接，不调用无界 `read(-1)`

#### Scenario: 超大远程文件
- **WHEN** 结果下载或安装包超过配置上限
- **THEN** 中止传输、删除临时文件，并返回可读错误

### Requirement: 本地界面必须禁止被第三方页面嵌套

系统 SHALL 为 HTML 响应设置 `X-Frame-Options: DENY` 和 `Content-Security-Policy: frame-ancestors 'none'`，并至少补充 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

#### Scenario: 被 iframe 嵌入
- **WHEN** 第三方页面尝试以 iframe 加载 `http://127.0.0.1:<port>/`
- **THEN** 浏览器拒绝渲染该框架

### Requirement: 静态文件服务必须使用显式白名单

系统 SHALL 只通过白名单提供前端运行所需资源（`index.html`、`css/`、`js/`、`ICO/` 及明确允许的文件）；SHALL 禁止访问程序源码、日志、`appinfo.txt`、`user_tools/`、`sys_tools/`、`.git/`、`.trae/`；SHALL 关闭目录列表。

#### Scenario: 直接请求源码
- **WHEN** 请求 `/server.py`、`/appinfo.txt`、`/user_tools/` 或 `/启动日志.log`
- **THEN** 返回 404，不返回文件内容或目录列表

#### Scenario: 正常页面
- **WHEN** 请求 `/`、`/css/style.css`、`/js/main.js`
- **THEN** 正常返回，页面功能不受影响

### Requirement: 工具保存不得静默删除其他工具或刚保存的文件

系统 SHALL 校验工具配置为 JSON 对象；SHALL 仅在用户明确确认覆盖同一内部工具 ID 时更新；SHALL NOT 按 `webappId` 或名称自动删除其他配置文件；SHALL 在判断新旧文件是否同一文件时使用 Windows 大小写不敏感语义，避免仅改大小写时删除新文件。

#### Scenario: 同应用多版本
- **WHEN** 保存两个 `webappId` 相同但名称/参数不同的工具
- **THEN** 两个配置文件均保留，重启后均可加载

#### Scenario: 仅修改大小写
- **WHEN** 把 `CaseTool` 改名为 `casetool` 并保存
- **THEN** 配置存在且内容为新名称，不被旧文件清理逻辑删除

#### Scenario: 非法配置
- **WHEN** `/save-tool` 收到数组、`null` 或缺少必需字段的 `content`
- **THEN** 返回 400，不写入文件，不抛出未捕获异常

### Requirement: 持久化失败必须对用户可见

前端 SHALL 仅在服务端返回成功且文件确实写入后提示“已保存/已删除”；写盘失败或网络失败时 SHALL 抛出可读错误，回滚界面状态或明确标记“未写入磁盘”。

#### Scenario: 磁盘不可写
- **WHEN** `/save-tool` 返回 500 或连接失败
- **THEN** 配置弹窗不显示保存成功，用户可重试，缓存与磁盘状态一致

### Requirement: 更新下载必须单实例执行

系统 SHALL 在 `starting` 和 `downloading` 两个阶段都拒绝新的下载请求；SHALL 保证同一时刻只有一个线程写 `.part` 文件；取消或失败后 SHALL 清理临时文件并允许重新开始。

#### Scenario: 连续点击下载
- **WHEN** 在首个下载请求尚未进入 `downloading` 时再次请求 `/update/download`
- **THEN** 第二个请求返回 409，不产生第二个下载线程

### Requirement: 任务状态必须可恢复或明确提示

前端 SHALL 在任务创建成功后持久化 `taskId`、所属工具和阶段；页面刷新或窗口重开后 SHALL 能恢复查询/取消；无法恢复时 SHALL 明确提示本次任务状态已丢失，避免用户在不知情下重复提交。

#### Scenario: 轮询阶段刷新
- **WHEN** 任务已创建但尚未完成时刷新页面
- **THEN** 页面恢复该任务的查询，继续显示进度/结果，且不重复提交

### Requirement: 外部与系统操作必须限制目标范围

系统 SHALL 拒绝 UNC、设备路径及非本地绝对路径的 `/open-dir` 请求；SHALL 只打开本地磁盘目录。节点信息请求 SHALL 优先使用 `Authorization` 头传递 API Key；若接口强制要求查询参数，SHALL 在错误信息和日志中隐藏完整 URL。

#### Scenario: UNC 路径
- **WHEN** `/open-dir?path=\\attacker\share`
- **THEN** 返回 400，不触发系统网络认证

### Requirement: 系统工具重置必须事务化

系统 SHALL 先解压到临时目录并完成路径、大小校验，再替换 `sys_tools`；失败时 SHALL 保留原目录；SHALL 拒绝包含盘符、冒号、`..`、绝对路径或解压后超限的压缩条目。

#### Scenario: 压缩包损坏
- **WHEN** 解压中途中止
- **THEN** 现有系统工具目录保持不变，接口返回错误

#### Scenario: 恶意条目
- **WHEN** 条目名为 `C:/Windows/...` 或 `../outside`
- **THEN** 跳过该条目，不写出 `sys_tools` 目录

### Requirement: 封面上传必须校验真实图片类型

系统 SHALL 通过魔数识别 PNG/JPEG/WebP/GIF；SHALL 只接受受支持格式，或统一转换为 JPEG/PNG；SHALL 拒绝伪装成图片的 HTML/脚本内容，并对上传大小设限。

#### Scenario: 上传 HTML 伪装成图片
- **WHEN** 请求体以 `<html>` 开头且 `name=x`
- **THEN** 返回 400，不写入封面

### Requirement: 安装前必须完成版本、大小与摘要校验

系统 SHALL 在启动安装包前确认：清单版本必须大于当前 `APP_VERSION`；`sha256` 必须为 64 位十六进制；`size` 必须为正整数；实际文件大小与摘要必须与已验签清单完全一致。

#### Scenario: 缺少摘要字段
- **WHEN** 已验签清单未提供 `sha256` 或 `size`
- **THEN** 安装接口拒绝执行，并提示重新下载

#### Scenario: 降级安装
- **WHEN** 清单版本低于或等于当前 `APP_VERSION`
- **THEN** 安装接口拒绝执行

### Requirement: 更新与公告检查应有缓存和输入上限

系统 SHALL 对更新检查设置短时缓存，避免重复请求三个源；SHALL 限制公告/更新清单响应大小；SHALL 校验 `publishedAt` 为真实日期，而非仅匹配格式。

#### Scenario: 连续检查
- **WHEN** 多个页面在 5 分钟内重复请求 `/update/check`
- **THEN** 直接返回缓存结果，不重复外呼

---

## MODIFIED Requirements

### Requirement: 本地变更接口防护

保留现有 `Origin` + `Host` + 每次启动令牌校验；新增：所有响应统一附加安全头，所有读取请求体的入口统一走带上限的解析函数，不再各自直接 `rfile.read(Content-Length)`。

## REMOVED Requirements

无。
