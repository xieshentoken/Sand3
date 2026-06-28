@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "URL=http://127.0.0.1:8768"

curl.exe -fsS "%URL%/api/database/stats" >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  exit /b 0
)

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process '%URL%'"
echo Sand3 Industrial 正在启动。关闭此窗口或按 Ctrl+C 可停止服务。
node server.js

if errorlevel 1 (
  echo.
  echo 启动失败，请确认已安装 Node.js 22.5 或更高版本。
  pause
)
