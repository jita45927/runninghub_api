@echo off
cd /d %~dp0
set PORT=8899

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Please install Python first.
  pause
  exit /b 1
)

echo ============================================
echo   RunningHub AI Toolbox
echo   URL: http://localhost:%PORT%/
echo   Browser will open automatically.
echo   DO NOT close this window while using.
echo   Close this window = stop the server.
echo ============================================

start "" cmd /c "timeout /t 1 >nul & start """" http://localhost:%PORT%/"

python -m http.server %PORT%

echo.
echo Server stopped or failed to start. Check the message above.
pause
