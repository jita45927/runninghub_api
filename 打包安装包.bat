@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo [1/5] 检查 Python 和 pip ...
where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Python，请先安装 Python 3 并加入 PATH。
  pause
  exit /b 1
)
python --version >nul 2>&1
if errorlevel 1 (
  echo [错误] Python 无法运行，请检查 Python 安装。
  pause
  exit /b 1
)
python -m pip --version >nul 2>&1
if errorlevel 1 (
  echo [错误] pip 不可用，请先安装或修复 pip。
  pause
  exit /b 1
)

echo [2/5] 安装并校验构建依赖 ...
python -m pip install --disable-pip-version-check -r requirements-build.txt
if errorlevel 1 (
  echo [错误] 依赖安装失败，请检查网络或依赖版本。
  pause
  exit /b 1
)
python -c "from PIL import Image; import pystray._win32; import win32api; print('核心依赖导入检查通过')"
if errorlevel 1 (
  echo [错误] 核心依赖无法导入，已停止打包。
  pause
  exit /b 1
)

echo [3/5] 打包 exe ...
if not exist build mkdir build
set "BUILD_LOG=build\pyinstaller.log"
python -m PyInstaller --noconfirm --clean --onedir --contents-directory . --noconsole --name RunningHubToolbox --icon "ICO\RAPI.ico" --hidden-import "pystray._win32" --add-data "index.html;." --add-data "ICO\RAPI.ico;." --add-data "ICO;ICO" --add-data "css;css" --add-data "js;js" --add-data "tools;builtin-tools" launcher.py >"%BUILD_LOG%" 2>&1
set "PYINSTALLER_EXIT=%ERRORLEVEL%"
type "%BUILD_LOG%"
if not "%PYINSTALLER_EXIT%"=="0" (
  echo [错误] exe 打包失败，日志：%BUILD_LOG%
  pause
  exit /b 1
)
findstr /C:"ERROR: Hidden import" "%BUILD_LOG%" >nul
if not errorlevel 1 (
  echo [错误] PyInstaller 报告隐藏导入缺失，已停止打包。日志：%BUILD_LOG%
  pause
  exit /b 1
)
if not exist "dist\RunningHubToolbox\RunningHubToolbox.exe" (
  echo [错误] 未找到打包后的 RunningHubToolbox.exe。
  pause
  exit /b 1
)

del /q "dist\RunningHubToolbox\appinfo.txt" 2>nul
rmdir /s /q "dist\RunningHubToolbox\download" 2>nul
rmdir /s /q "dist\RunningHubToolbox\tools" 2>nul

echo [4/5] 检查 Inno Setup ...
set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" (
  echo [错误] 未找到 Inno Setup 6，请先安装。
  pause
  exit /b 1
)

echo [5/5] 生成安装包 ...
"%ISCC%" installer.iss
if errorlevel 1 (
  echo [错误] 安装包生成失败。
  pause
  exit /b 1
)
if not exist "installer\RunningHub-AI-Toolbox-Setup-1.0.0.exe" (
  echo [错误] 编译结束但未找到安装包。
  pause
  exit /b 1
)

echo.
echo 完成：installer\RunningHub-AI-Toolbox-Setup-1.0.0.exe
pause
endlocal
