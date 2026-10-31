@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === session-stats pills: 应用补丁 ===
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node 命令。
  echo        补丁器需要 Node.js 18+：请到 https://nodejs.org/ 安装 LTS 版，
  echo        安装时勾选 Add to PATH，装完后重新打开本脚本。
  echo.
  pause
  exit /b 1
)
node patch.mjs apply
echo.
pause
