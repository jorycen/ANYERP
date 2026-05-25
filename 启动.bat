@echo off
title ANY-ERP Launcher
cd /d "%~dp0"

echo Starting ANY-ERP...

REM Stop old processes if running
echo [1/3] Checking port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTEN') do (
    echo Killing old backend process...
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 2 >nul
)

REM Start backend
echo [2/3] Starting Backend...
start "ANY-ERP-Backend" cmd /k "cd /d %~dp0backend && node src/index.js"
echo Waiting for backend (5 sec)...
timeout /t 5 >nul

REM Start frontend
echo [3/3] Starting Frontend...
start "ANY-ERP-Frontend" cmd /k "cd /d %~dp0frontend\web && npm run dev"
echo Waiting for frontend (3 sec)...
timeout /t 3 >nul

echo.
echo ===============================
echo ALL SERVICES STARTED!
echo ===============================
echo.
echo Backend:  http://localhost:3000
echo Frontend: http://localhost:5173
echo.
echo Opening browser...
start http://localhost:5173

echo.
echo Press any key to close this window...
pause >nul
