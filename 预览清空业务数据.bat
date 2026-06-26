@echo off
cd /d "%~dp0"

echo.
echo ==========================================
echo   ANY-ERP cloud cleanup preview
echo   No data will be deleted in this mode
echo ==========================================
echo.
echo DB config comes from:
echo   cloud-db.env or DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
echo.
echo Make sure these variables point to the CLOUD database.
echo If cloud-db.env does not exist, copy cloud-db.env.example and fill it first.
echo.

node "%~dp0backend\clear_data.js" --target=cloud --dry-run
pause
