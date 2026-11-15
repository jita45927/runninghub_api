@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8900
set "RH_APP_DIR=%CD%"

rem ----------------------------------------------------------
rem ?? appinfo.txt?UTF-8??
rem   Line 1 = tools ??????? %CD%\tools?
rem   Line 2 = ?????????????? FolderBrowserDialog?
rem ----------------------------------------------------------
powershell -NoProfile -STA -Command ^
  "Add-Type -AssemblyName System.Windows.Forms;" ^
  "$tools = Join-Path $env:RH_APP_DIR 'tools';" ^
  "$fallback = Join-Path $env:RH_APP_DIR 'download';" ^
  "$dl = '';" ^
  "if (Test-Path 'appinfo.txt') {" ^
  "  $lines = Get-Content -Path 'appinfo.txt' -Encoding UTF8;" ^
  "  if ($lines.Count -ge 2 -and $lines[1].Trim()) { $dl = $lines[1].Trim() }" ^
  "}" ^
  "if (-not $dl) {" ^
  "  $d = New-Object System.Windows.Forms.FolderBrowserDialog;" ^
  "  $d.Description = 'Select download directory';" ^
  "  $d.ShowNewFolderButton = $true;" ^
  "  $d.SelectedPath = $fallback;" ^
  "  if ($d.ShowDialog() -eq 'OK') { $dl = $d.SelectedPath }" ^
  "}" ^
  "if (-not $dl) { $dl = $fallback }" ^
  "if (-not (Test-Path $dl)) { New-Item -ItemType Directory -Path $dl -Force | Out-Null }" ^
  "[System.IO.File]::WriteAllLines('appinfo.txt', @($tools, $dl), [System.Text.UTF8Encoding]::new($false))"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python first.
  pause
  exit /b 1
)

rem Stop old server instances on this port. Closing the black window does not
rem always kill python.exe, which leaves an old server.py occupying the port.
rem Only processes whose command line is "server.py %PORT%" are stopped,
rem so COMFYUI_api on port 8899 is not affected.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'server\.py\s+%PORT%' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

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
