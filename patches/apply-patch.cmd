@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === session-stats pills: 应用补丁 ===
if not exist "%~dp0patch.mjs" (
  echo [错误] 当前目录找不到 patch.mjs。
  echo        请先把整个 ZIP 解压到磁盘上的普通目录（如桌面或 D:	ools\），
  echo        再进入解压出的 patches 文件夹运行本脚本；
  echo        不要在压缩包预览窗口里直接双击运行。
  echo.
  pause
  exit /b 1
)
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
