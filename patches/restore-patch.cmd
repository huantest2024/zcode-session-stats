@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === session-stats pills: 还原 app.asar ===
node patch.mjs restore
echo.
pause
