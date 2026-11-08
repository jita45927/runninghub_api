# 模块化架构重构 Spec

## Why
当前 index.html 已超过 1000 行，HTML/CSS/JS 混杂，难以维护；且未来要封装为桌面应用（Electron/Tauri），需要清晰的模块边界：核心逻辑（API、存储）与 UI 层分离，桌面壳才能直接复用。

## What Changes
- 将单文件拆分为多模块结构，浏览器原生 ES Modules（`type="module"`），不引入任何构建工具和框架，保持零依赖
- 目录结构：
  - `index.html` —— 仅保留布局骨架与入口脚本引用
  - `css/style.css` —— 全部样式
  - `js/config.js` —— 常量、默认工具配置
  - `js/store.js` —— 状态管理（localStorage / IndexedDB 封装）
  - `js/api.js` —— RunningHub API 层（上传/创建/查询/取消/余额）
  - `js/tools.js` —— 工具配置加载、导入导出、tools/ 自动扫描、去重
  - `js/runner.js` —— 任务运行流程（组装参数、提交、轮询、取消、自动下载）
  - `js/ui/form.js` —— 动态表单渲染与图片上传交互
  - `js/ui/toollist.js` —— 工具列表渲染
  - `js/ui/results.js` —— 结果渲染、尺寸显示
  - `js/ui/modal.js` —— API Key 与工具配置弹窗
  - `js/ui/lightbox.js` —— 灯箱预览（缩放/拖动）
  - `js/main.js` —— 入口：初始化、事件绑定、模块装配
- ~~重构同时修复审查发现的问题~~（安全修复已由 fix-security-hardening 完成，本重构保持其行为不变）
- `tools/`、`download/`、`启动工具.bat` 保留（bat 已绑定 127.0.0.1）
- **BREAKING**：旧 `index.html` 不再自包含，必须通过 http 服务访问（ES Modules 在 file:// 下被浏览器禁止）；双击 html 直接打开的方式失效，统一走启动工具.bat

## Impact
- Affected code: index.html（重写为骨架）、新增 css/ 与 js/ 目录、启动工具.bat
- 不影响：tools/*.rhtool.json 配置格式、localStorage 已存数据（键名不变）、用户已有配置

## ADDED Requirements
### Requirement: 模块化代码结构
系统 SHALL 将样式、API 层、状态层、运行流程、UI 组件拆分为独立 ES Module 文件，模块间通过显式 import/export 依赖。

#### Scenario: 模块边界清晰
- **WHEN** 查看 js/api.js
- **THEN** 只包含 RunningHub 接口调用，不含任何 DOM 操作

#### Scenario: 桌面壳可复用
- **WHEN** 未来用 Electron/Tauri 封装
- **THEN** js/api.js、js/store.js、js/runner.js 可直接复用，仅需替换 UI 层或壳入口

### Requirement: 功能零回归
系统 SHALL 保持现有全部功能行为不变：多工具管理、动态表单、图片上传记忆路径、按工具隔离的图片与结果、自动下载、尺寸显示、灯箱预览（滚轮缩放/中键拖动）、立即取消、扣费显示、余额查询。

#### Scenario: 重构后验收
- **WHEN** 重构完成
- **THEN** KLEIN-SU转绘效果图 与 效果图SEEDVR2放大 两个工具的配置、上传、生成、下载、预览、取消全流程行为与重构前一致

## MODIFIED Requirements
### Requirement: 渲染安全
原 innerHTML 拼接用户/配置数据改为安全 DOM 构建（createElement/textContent 或统一转义函数）。

#### Scenario: 恶意配置不执行脚本
- **WHEN** 导入的 .rhtool.json 名称字段含 `<img onerror=...>`
- **THEN** 该内容以纯文本显示，不执行任何脚本

### Requirement: 本地服务器仅本机访问
启动工具.bat  SHALL 使用 `--bind 127.0.0.1`，局域网其他机器无法访问。

## REMOVED Requirements
### Requirement: 双击 html 直接运行
**Reason**: ES Modules 被浏览器禁止在 file:// 协议下运行。
**Migration**: 统一使用 启动工具.bat（已实现自动打开浏览器）。
