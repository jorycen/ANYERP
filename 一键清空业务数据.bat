@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
echo.
echo ==========================================
echo   ANY-ERP 业务数据一键清空
echo ==========================================
echo.
node clear_data.js
pause