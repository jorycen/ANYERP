@echo off
cd /d "%~dp0"

echo.
echo ==========================================
echo   ANY-ERP cloud business data cleanup
echo ==========================================
echo.
echo This script clears CLOUD business data for production launch.
echo.
echo Will clear:
echo   sales orders, deposits
echo   inventory, SN, resource rights
echo   inbound, outbound, transfer, return stock
echo   split and assembly documents
echo   purchase requests and purchase orders
echo   daily statements, expenses
echo   pending payables, payables, settlements, payments
echo   rebates and account center balance sources
echo   approvals and product application test records
echo   manufacturer policy, price import batches, price change history
echo.
echo Will keep:
echo   system config, users, roles, stores
echo   suppliers and supplier payment accounts
echo   product master data and current product prices
echo   settlement account definitions
echo.
echo DB config comes from:
echo   cloud-db.env or DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
echo.
echo Make sure these variables point to the CLOUD database.
echo If cloud-db.env does not exist, copy cloud-db.env.example and fill it first.
echo The script will show row counts and create a backup before deletion.
echo This script will ask for CLEAR_TEST_DATA before deleting anything.
echo.

node "%~dp0backend\clear_data.js" --target=cloud
pause
