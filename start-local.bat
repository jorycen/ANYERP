@echo off
setlocal
title ANY-ERP Local Services

cd /d "%~dp0"
set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "FRONTEND_DIR=%ROOT%frontend\web"
set "BACKEND_PORT=3000"
set "FRONTEND_PORT=5173"

if /i "%~1"=="--check" (
    call :check
    if errorlevel 1 exit /b 1
    echo Check OK.
    exit /b 0
)

echo ========================================
echo       ANY-ERP Local Services
echo ========================================
echo.

call :check
if errorlevel 1 (
    echo.
    echo Startup check failed.
    pause
    exit /b 1
)

echo [1/4] Stop old backend on port %BACKEND_PORT%...
call :kill_port %BACKEND_PORT%

echo [2/4] Stop old frontend on port %FRONTEND_PORT%...
call :kill_port %FRONTEND_PORT%

echo [3/4] Start backend...
start "ANY-ERP Backend" cmd /k "cd /d ""%BACKEND_DIR%"" && set ""PORT=%BACKEND_PORT%"" && set ""BACKEND_PORT=%BACKEND_PORT%"" && npm start"
timeout /t 5 /nobreak >nul

echo [4/4] Start frontend...
start "ANY-ERP Frontend" cmd /k "cd /d ""%FRONTEND_DIR%"" && npm run dev"
timeout /t 3 /nobreak >nul

echo.
echo ========================================
echo              Started
echo ========================================
echo Backend : http://localhost:%BACKEND_PORT%
echo Frontend: http://localhost:%FRONTEND_PORT%
echo.
echo Opening browser...
start "" "http://localhost:%FRONTEND_PORT%"
echo.
echo You can close this window. Keep the Backend and Frontend windows open.
pause
exit /b 0

:check
where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: node was not found. Install Node.js first.
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found. Install Node.js first.
    exit /b 1
)

if not exist "%BACKEND_DIR%\package.json" (
    echo ERROR: backend package.json not found: "%BACKEND_DIR%\package.json"
    exit /b 1
)

if not exist "%FRONTEND_DIR%\package.json" (
    echo ERROR: frontend package.json not found: "%FRONTEND_DIR%\package.json"
    exit /b 1
)

if not exist "%BACKEND_DIR%\node_modules" (
    echo ERROR: backend dependencies are missing. Run this first:
    echo   cd /d "%BACKEND_DIR%" ^&^& npm install
    exit /b 1
)

if not exist "%FRONTEND_DIR%\node_modules" (
    echo ERROR: frontend dependencies are missing. Run this first:
    echo   cd /d "%FRONTEND_DIR%" ^&^& npm install
    exit /b 1
)

exit /b 0

:kill_port
set "PORT=%~1"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTEN"') do (
    if not "%%P"=="0" (
        taskkill /F /PID %%P >nul 2>nul
    )
)
exit /b 0
