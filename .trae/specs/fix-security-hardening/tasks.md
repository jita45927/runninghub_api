# Tasks

- [x] Task 1: 存储与加载兜底
  - [x] 1.1 localStorage 的 rh_tools_v4 / 选中项读取加 try/catch，损坏回退默认
  - [x] 1.2 tools/ 自动加载：单文件解析失败仅跳过该文件并提示，继续加载其余
  - [x] 1.3 接口响应统一先校验 resp.ok 再解析 JSON，非 JSON 给出可读错误
- [x] Task 2: 渲染安全（XSS）
  - [x] 2.1 工具列表（图标/名称/描述）改安全 DOM 构建
  - [x] 2.2 动态表单（label/def/placeholder/option）改安全构建或转义
  - [x] 2.3 配置弹窗的输入项编辑器（label/nodeId/fieldName/def）改安全构建
  - [x] 2.4 结果区 URL 校验 http/https、文本用 textContent、外链加 rel="noopener"
  - [x] 2.5 余额/错误信息渲染改安全构建
- [x] Task 3: 运行保护与资源管理
  - [x] 3.1 任务运行中禁止删除该工具（提示先取消）
  - [x] 3.2 上传预览 objectURL 复用与回收；下载 blob 延迟 revoke
- [x] Task 4: 服务器绑定
  - [x] 4.1 启动工具.bat 加 `--bind 127.0.0.1`
- [x] Task 5: 验证与提交
  - [x] 5.1 冒烟测试：页面加载、两工具显示、上传、表单、灯箱正常
  - [x] 5.2 XSS 用例验证：导入恶意配置不执行脚本
  - [x] 5.3 git 提交

# Task Dependencies
- Task 1-4 相互独立，可并行
- Task 5 依赖 Task 1-4

