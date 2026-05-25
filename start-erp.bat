@echo off
title ANY-ERP Start

echo ========================================
echo       ANY-ERP - Start All Services
echo ========================================
echo.

REM --- Start MySQL ---
echo [1/3] Starting MySQL...
tasklist /FI "IMAGENAME eq mysqld.exe" 2>nul | find /i "mysqld.exe" >nul
if %%errorlevel%% equ 0 (
    echo     MySQL is already running
) else (
    start "" "D:\~��\Soft\ANY-ERP\backend-package\mysql-8.0.36-winx64\bin\mysqld.exe" --basedir="D:\~��\Soft\ANY-ERP\backend-package\mysql-8.0.36-winx64" --datadir="D:\~��\Soft\ANY-ERP\backend-package\mysql-8.0.36-winx64\data" --port=3306 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
    echo     MySQL starting... (waiting 3s)
    timeout /t 3 /nobreak >nul
)

REM --- Start Backend ---
echo [2/3] Starting Backend...
tasklist /FI "WINDOWTITLE eq ANY-ERP-Backend*" 2>nul | find /i "node.exe" >nul
if %%errorlevel%% equ 0 (
    echo     Backend is already running
) else (
    start "ANY-ERP-Backend" cmd /k "cd /d D:\~��\Soft\ANY-ERP\backend && npm run dev"
    echo     Backend starting... (waiting 5s)
    timeout /t 5 /nobreak >nul
)

REM --- Start Frontend ---
echo [3/3] Starting Frontend...
tasklist /FI "WINDOWTITLE eq ANY-ERP-Frontend*" 2>nul | find /i "node.exe" >nul
if %%errorlevel%% equ 0 (
    echo     Frontend is already running
) else (
    start "ANY-ERP-Frontend" cmd /k "cd /d D:\~��\Soft\ANY-ERP\frontend\web && npm run dev"
    echo     Frontend starting... (waiting 5s)
    timeout /t 5 /nobreak >nul
)

echo.
echo ========================================
echo              Started!
echo ========================================
echo.
echo   MySQL:    localhost:3306
echo   Backend:  http://localhost:3000
echo   Frontend: http://localhost:5173
echo.
echo   Press any key to open browser...
pause >nul
start http://localhost:5173
