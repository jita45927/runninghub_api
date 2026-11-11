@echo off
chcp 65001 >nul
cd /d %~dp0
set PORT=8900

rem ----------------------------------------------------------
rem ?? appinfo.txt?UTF-8??
rem   Line 1 = tools ??????? %CD%\tools?
rem   Line 2 = ?????????????? FolderBrowserDialog?
rem ----------------------------------------------------------
powershell -NoProfile -STA -Command ^
  "$tools = '%CD%\tools';" ^
  "$dl = '';" ^
  "if (Test-Path 'appinfo.txt') {" ^
  "  $lines = Get-Content -Path 'appinfo.txt' -Encoding UTF8;" ^
  "  if ($lines.Count -ge 2 -and $lines[1].Trim()) { $dl = $lines[1].Trim() }" ^
  "}" ^
  "if (-not $dl) {" ^
  "  $d = New-Object System.Windows.Forms.FolderBrowserDialog;" ^
  "  $d.Description = 'Select download directory';" ^
  "  $d.ShowNewFolderButton = $true;" ^
  "  $d.SelectedPath = '%CD%\download';" ^
  "  if ($d.ShowDialog() -eq 'OK') { $dl = $d.SelectedPath }" ^
  "}" ^
  "if (-not $dl) { $dl = '%CD%\download' }" ^
  "if (-not (Test-Path $dl)) { New-Item -ItemType Directory -Path $dl -Force | Out-Null }" ^
  "[System.IO.File]::WriteAllLines('appinfo.txt', @($tools, $dl), [System.Text.UTF8Encoding]::new($false))"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python first.
  pause
  exit /b 1
)

echo ============================================
echo   RunningHub AI Toolbox
echo   URL: http://127.0.0.1:%PORT%/
echo   Browser will open automatically.
echo   DO NOT close this window while using.
echo   Close this window = stop the server.
echo ============================================

start "" cmd /c "timeout /t 1 >nul & start """" http://127.0.0.1:%PORT%/"

python server.py %PORT%

echo.
echo Server stopped or failed to start. Check the message above.
pause
