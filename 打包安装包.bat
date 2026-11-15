@echo off
chcp 65001 >nul
cd /d %~dp0

set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe

echo [1/2] 打包 exe ...
python -m PyInstaller --noconfirm --clean --onedir --contents-directory . --noconsole --name RunningHubToolbox --icon "ICO\RAPI.ico" --add-data "index.html;." --add-data "ICO\RAPI.ico;." --add-data "css;css" --add-data "js;js" --add-data "tools;tools" launcher.py
if errorlevel 1 (
  echo exe 打包失败
  pause
  exit /b 1
)

del /q "dist\RunningHubToolbox\appinfo.txt" 2>nul
rmdir /s /q "dist\RunningHubToolbox\download" 2>nul

echo [2/2] 生成安装包 ...
"%ISCC%" installer.iss
if errorlevel 1 (
  echo 安装包生成失败
  pause
  exit /b 1
)

echo.
echo 完成：installer\RunningHub-AI-Toolbox-Setup-1.2.1.exe
pause
