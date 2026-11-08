# 安全与稳定性修复 Spec

## Why
代码审查发现当前单文件应用存在 XSS 注入（恶意配置文件可窃取 API Key）、localStorage 损坏导致白屏、本地服务器对局域网暴露等问题，需在架构重构前优先修复。

## What Changes
- 渲染安全：工具列表、表单字段、配置编辑器、结果区中所有来自配置文件/接口的数据改用安全 DOM 构建（createElement/textContent）或先转义再拼接
- localStorage 读取（工具列表、选中项）加 try/catch 兜底，损坏时回退默认值，不再白屏
- 启动工具.bat 的 http 服务器加 `--bind 127.0.0.1`，仅本机可访问
- 任务运行中禁止删除正在运行的工具；删除/切换时若该工具在运行给出提示
- 接口响应非 JSON（如 502 HTML 页面）时给出可读错误信息
- tools/ 自动加载时单个文件解析失败不影响其余文件
- 结果区外链加 `rel="noopener"`；结果 URL 仅允许 http/https 协议
- 上传图预览复用 objectURL，灯箱关闭时回收，避免内存累积
- 下载 blob URL 延迟回收（setTimeout），防止个别浏览器下载中断

## Impact
- Affected code: index.html、启动工具.bat
- 不影响：功能行为、配置文件格式、已存数据

## ADDED Requirements
### Requirement: 配置数据安全渲染
系统 SHALL 对来自 .rhtool.json 与 RunningHub 接口的所有文本数据做安全渲染，任何字段内容不得以 HTML/属性形式执行。

#### Scenario: 恶意配置被中和
- **WHEN** 导入名称含 `<img src=x onerror=alert(1)>` 的工具配置
- **THEN** 界面显示原始文本，无脚本执行

### Requirement: 存储损坏兜底
系统 SHALL 在 localStorage 数据无法解析时回退到默认配置并正常渲染。

#### Scenario: 损坏数据不白屏
- **WHEN** 手动将 rh_tools_v4 改为非法 JSON 后刷新页面
- **THEN** 页面正常打开，加载默认示例工具

### Requirement: 服务器仅本机访问
启动工具.bat SHALL 绑定 127.0.0.1。

#### Scenario: 局域网不可访问
- **WHEN** 同局域网其他设备访问 本机IP:8899
- **THEN** 连接被拒绝

### Requirement: 运行状态保护
系统 SHALL 在某工具任务运行中时阻止删除该工具，并提示先取消任务。

#### Scenario: 运行中删除被阻止
- **WHEN** 任务运行中点击该工具的删除按钮
- **THEN** 弹出提示且不执行删除
