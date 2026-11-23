@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo [1/6] 检查 Python 和 pip ...
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

echo [2/6] 读取版本号并安装校验构建依赖 ...
rem 版本号唯一来源：server.py 的 APP_VERSION
del /q "%TEMP%\rh_version.txt" 2>nul
python -c "import re;print(re.search('APP_VERSION = .([0-9.]+).',open('server.py',encoding='utf-8').read()).group(1))" > "%TEMP%\rh_version.txt"
set /p APP_VER=<"%TEMP%\rh_version.txt"
del /q "%TEMP%\rh_version.txt" 2>nul
if not defined APP_VER (
  echo [错误] 无法从 server.py 读取 APP_VERSION。
  pause
  exit /b 1
)
echo    当前版本：%APP_VER%

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

echo [3/6] 打包 exe ...
if not exist build mkdir build
set "BUILD_LOG=build\pyinstaller.log"
python -m PyInstaller --noconfirm --clean --onedir --contents-directory . --noconsole --name RunningHubToolbox --icon "ICO\RAPI.ico" --hidden-import "pystray._win32" --add-data "index.html;." --add-data "ICO\RAPI.ico;." --add-data "ICO;ICO" --add-data "css;css" --add-data "js;js" --add-data "sys_tools;sys_tools" launcher.py >"%BUILD_LOG%" 2>&1
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
rem 系统工具随安装包覆盖；用户工具只能放在数据目录，绝不打进安装包
rem 先清掉旧版本残留，再完整复制，确保安装包内 sys_tools 与仓库逐文件一致
rmdir /s /q "dist\RunningHubToolbox\user_tools" 2>nul
rmdir /s /q "dist\RunningHubToolbox\tools" 2>nul
rmdir /s /q "dist\RunningHubToolbox\builtin-tools" 2>nul
rmdir /s /q "dist\RunningHubToolbox\sys_tools" 2>nul
xcopy "sys_tools" "dist\RunningHubToolbox\sys_tools" /e /i /y >nul
if not exist "dist\RunningHubToolbox\sys_tools" (
  echo [错误] 打包产物缺少 sys_tools 目录。
  pause
  exit /b 1
)
rem 生成「重置系统工具」用的压缩包，内容与 sys_tools 逐文件一致
if exist "dist\RunningHubToolbox\sys_tools.zip" del /q "dist\RunningHubToolbox\sys_tools.zip" 2>nul
powershell -NoProfile -Command "Compress-Archive -Path 'dist\RunningHubToolbox\sys_tools\*' -DestinationPath 'dist\RunningHubToolbox\sys_tools.zip' -Force" >nul
if not exist "dist\RunningHubToolbox\sys_tools.zip" (
  echo [错误] 生成 sys_tools.zip 失败。
  pause
  exit /b 1
)

echo [4/6] 检查 Inno Setup ...
set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" (
  echo [错误] 未找到 Inno Setup 6，请先安装。
  pause
  exit /b 1
)

echo [5/6] 生成安装包 ...
"%ISCC%" "/DMyAppVersion=%APP_VER%" installer.iss
if errorlevel 1 (
  echo [错误] 安装包生成失败。
  pause
  exit /b 1
)
if not exist "installer\RunningHub-AI-Toolbox-Setup-%APP_VER%.exe" (
  echo [错误] 编译结束但未找到安装包。
  pause
  exit /b 1
)

echo [6/6] 生成更新清单 update\latest.json ...
python 发布更新.py --generate-only
if errorlevel 1 (
  echo [警告] 更新清单生成失败，可稍后单独运行 python 发布更新.py --generate-only
)

echo.
echo 完成：installer\RunningHub-AI-Toolbox-Setup-%APP_VER%.exe
echo 更新清单：update\latest.json（上传到 Gitee/GitHub 后自动更新才会生效）
pause
endlocal
