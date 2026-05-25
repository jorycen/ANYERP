@echo off
title ANY-ERP Stop

echo ========================================
echo       ANY-ERP - Stop All Services
echo ========================================
echo.

REM --- Stop Frontend ---
echo [1/3] Stopping Frontend...
for /f "tokens=2" %%a in ('tasklist /FI "WINDOWTITLE eq ANY-ERP-Frontend*" /FO LIST 2^>nul ^| find "PID:"') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo     Done.

REM --- Stop Backend ---
echo [2/3] Stopping Backend...
for /f "tokens=2" %%a in ('tasklist /FI "WINDOWTITLE eq ANY-ERP-Backend*" /FO LIST 2^>nul ^| find "PID:"') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo     Done.

REM --- Stop MySQL ---
echo [3/3] Stopping MySQL...
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq mysqld.exe" /FO LIST 2^>nul ^| find "PID:"') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo     Done.

echo.
echo ========================================
echo              All Stopped!
echo ========================================
pause
