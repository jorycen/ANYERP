@echo off
title ANY-ERP Stop Services

echo ========================================
echo       ANY-ERP Stop Services
echo ========================================
echo.

REM --- Stop Backend ---
echo [1/2] Stopping Backend...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTEN') do (
    taskkill /F /PID %%a >nul 2>&1
    echo     Backend stopped (PID: %%a)
)
echo.

REM --- Stop Frontend ---
echo [2/2] Stopping Frontend...
for /f "tokens=2" %%a in ('tasklist /FI "WINDOWTITLE eq ANY-ERP-Frontend*" /FO LIST 2^>nul ^| find "PID:"') do (
    taskkill /F /PID %%a >nul 2>&1
    echo     Frontend stopped (PID: %%a)
)
for /f "tokens=2" %%a in ('tasklist /FI "WINDOWTITLE eq ANY-ERP-Backend*" /FO LIST 2^>nul ^| find "PID:"') do (
    taskkill /F /PID %%a >nul 2>&1
    echo     Backend window closed (PID: %%a)
)

echo.
echo ========================================
echo     All services stopped!
echo ========================================
echo.
echo   NOTE: Tencent Cloud database is not affected
echo.

pause
