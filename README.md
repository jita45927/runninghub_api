# RunningHub AI 工具箱

一个纯前端的可视化工具，通过 RunningHub v2 OpenAPI 调用 RunningHub 上发布的 AI 应用/工作流。上传图片、填提示词、点运行，生成结果自动保存到本地。

**无需安装任何东西**：`index.html` 双击即可在浏览器中使用（推荐 Edge / Chrome）。

**推荐方式**：双击 `启动工具.bat`（需系统装有 Python）。它会启动一个本地服务器并自动打开浏览器，相比直接双击 html 多了一个好处：**自动加载系统工具和我的工具，无需手动导入**。关闭弹出的黑色命令行窗口即停止服务。

## 快速开始

1. **填 API Key**：打开页面 → 右上角「API Key」→ 粘贴你的 32 位 Key（RunningHub 控制台获取）
2. **导入工具配置**：左侧「📥 导入配置文件」→ 选择 `.rhtool.json`（导入的工具保存在「我的工具」）
3. **设置下载目录**（可选）：右上角「📁 下载目录」→ 选一个文件夹，之后生成结果静默存到该目录
4. **使用**：上传图片 → 填参数 → 「开始生成」，完成后自动下载原图并显示耗时与扣费

## 目录结构

```
runninghub_api/
├── index.html          # 程序本体（单文件，含全部界面和逻辑）
├── sys_tools/          # 系统工具配置（开发者维护，程序更新时整体覆盖）
│   └── *.rhtool.json
├── download/           # 默认出图目录（已 gitignore）
└── runninghub_tool.html # 早期单工作流版本（已废弃，仅留档）
```

安装版的用户工具保存在 `%LOCALAPPDATA%\RunningHubToolbox\data\user_tools\`，程序更新不会影响；系统工具被删除后可用「初始设置 → 重置系统工具」恢复。

## 工具配置文件（.rhtool.json）

每个文件对应一个 RunningHub 应用，字段说明：

| 字段 | 说明 |
|---|---|
| `name` / `icon` / `desc` | 工具名称、图标、描述 |
| `webappId` | AI 应用 ID（应用详情页「API 调用」中查看，即接口 URL 末尾的数字） |
| `fields` | 输入项列表，界面按此动态生成表单 |
| `fields[].label` | 输入项显示名称 |
| `fields[].type` | `image` 图片 / `textarea` 多行文本 / `text` 单行 / `number` 数字 / `select` 下拉 |
| `fields[].nodeId` | 节点 ID（照抄应用 API 示例中的 nodeId） |
| `fields[].fieldName` | 字段名（照抄 fieldName，如 `image` / `text` / `value`） |
| `fields[].def` | 默认值；select 类型填逗号分隔的选项 |

新增工具：在页面里「＋ 添加工具」配置并保存（自动写入「我的工具」目录），或直接把 json 放进用户工具目录。系统工具可点条目上的 ⧉ 复制为我的工具后再修改。

## API Key 安全机制

- Key **只存在浏览器 localStorage**，不写入任何文件
- 本仓库所有文件均不含 Key，可安全拷贝/分发/提交
- 公共电脑上使用完请点 Key 弹窗里的「清除 Key」

## 说明

- 计费：企业级共享 Key 按机器运行秒数从钱包扣费，每次生成后状态栏显示实际扣费
- 结果链接 24 小时有效，程序已在生成后自动下载原图，无需手动保存
- 选图对话框会记住上次选图目录（Edge/Chrome）
- 接口文档：https://www.runninghub.cn/openapi/v2
