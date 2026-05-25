@echo off
chcp 65001 >nul
echo ==========================================
echo 启动 MySQL 数据库...
echo ==========================================

cd /d "%~dp0backend-package\mysql-8.0.36-winx64\bin"

REM 检查是否已在运行
tasklist /FI "IMAGENAME eq mysqld.exe" 2>NUL | find /I /N "mysqld.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo MySQL 已经在运行中！
    timeout /t 3 >nul
    exit /b
)

echo 正在启动 MySQL...
start "MySQL Server" mysqld.exe --console --basedir="%~dp0backend-package\mysql-8.0.36-winx64" --datadir="%~dp0backend-package\mysql-8.0.36-winx64\data" --port=3306

echo 等待 MySQL 启动...
timeout /t 5 >nul

REM 检查是否启动成功
tasklist /FI "IMAGENAME eq mysqld.exe" 2>NUL | find /I /N "mysqld.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo ==========================================
    echo MySQL 启动成功！
    echo 端口: 3306
    echo 数据库: any_erp
    echo ==========================================
) else (
    echo ==========================================
    echo MySQL 启动失败，请检查！
    echo ==========================================
)

pause
