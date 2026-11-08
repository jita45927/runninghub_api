# Tasks

- [x] Task 1: 建立骨架与基础层
  - [x] 1.1 创建 css/style.css，迁移全部样式
  - [x] 1.2 创建 js/config.js（常量、默认工具）
  - [x] 1.3 创建 js/store.js（localStorage 带损坏兜底、IndexedDB 目录句柄封装）
  - [x] 1.4 创建 js/api.js（上传/创建/查询/取消/余额，纯请求无 DOM）
  - [x] 1.5 index.html 重写为布局骨架 + `<script type="module" src="js/main.js">`
- [x] Task 2: UI 组件层
  - [x] 2.1 js/ui/lightbox.js（灯箱：滚轮缩放、中键拖动）
  - [x] 2.2 js/ui/toollist.js（工具列表，安全 DOM 构建，悬停删除）
  - [x] 2.3 js/ui/form.js（动态表单、图片上传、尺寸显示、单击预览/双击换图）
  - [x] 2.4 js/ui/results.js（结果渲染、尺寸回填、按工具隔离存取）
  - [x] 2.5 js/ui/modal.js（API Key 弹窗含余额显示、工具配置弹窗含输入项编辑/导入导出）
- [x] Task 3: 业务编排层
  - [x] 3.1 js/tools.js（tools/ 自动扫描按名称去重更新、导入导出）
  - [x] 3.2 js/runner.js（组装 nodeInfoList、提交、轮询、取消、自动下载、扣费提示；运行中禁止删除该工具）
  - [x] 3.3 js/main.js（初始化、事件绑定、模块装配）
- [x] Task 4: 收尾与安全修复
  - [x] 4.1 启动工具.bat 加 `--bind 127.0.0.1`
  - [x] 4.2 验证：启动服务 → 页面加载无控制台报错 → 两工具显示正常 → 表单/灯箱/取消功能冒烟测试
  - [x] 4.3 git 提交

# Task Dependencies
- Task 2 依赖 Task 1
- Task 3 依赖 Task 1、Task 2
- Task 4 依赖 Task 3

