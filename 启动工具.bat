@echo off
chcp 65001 >nul
cd /d %~dp0
set PORT=8899

where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Python，请先安装 Python 后重试
  pause
  exit /b 1
)

echo ============================================
echo   RunningHub AI 工具箱
echo   地址: http://localhost:%PORT%/
echo   浏览器将自动打开，关闭本窗口即停止服务
echo ============================================

rem 延迟1秒后打开浏览器，等服务先启动
start "" cmd /c "timeout /t 1 >nul & start """" http://localhost:%PORT%/"

python -m http.server %PORT%
