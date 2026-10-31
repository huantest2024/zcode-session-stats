@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === session-stats pills: 应用补丁 ===
node patch.mjs apply
echo.
pause
