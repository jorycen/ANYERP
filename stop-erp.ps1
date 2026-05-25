
# ANY-ERP Stop Script (PowerShell)
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "      ANY-ERP - Stop All Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- Stop Frontend ---
Write-Host "[1/3] Stopping Frontend..." -ForegroundColor Yellow
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*ANY-ERP-Frontend*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "    Done." -ForegroundColor Green

# --- Stop Backend ---
Write-Host "[2/3] Stopping Backend..." -ForegroundColor Yellow
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*ANY-ERP-Backend*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "    Done." -ForegroundColor Green

# --- Stop MySQL ---
Write-Host "[3/3] Stopping MySQL..." -ForegroundColor Yellow
Get-Process -Name mysqld -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "    Done." -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "             All Stopped!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Read-Host "Press Enter to exit"
