
# ANY-ERP Start Script (PowerShell)
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "      ANY-ERP - Start All Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- Start Backend ---
Write-Host "[1/2] Starting Backend..." -ForegroundColor Yellow
$backendPath = Join-Path $projectRoot "backend"
$backendRunning = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*ANY-ERP-Backend*" }
if ($backendRunning) {
    Write-Host "    Backend is already running" -ForegroundColor Green
} else {
    $backendCmd = "cd /d `"$backendPath`" && npm run dev"
    Start-Process -FilePath cmd -ArgumentList "/k", "title ANY-ERP-Backend && $backendCmd"
    Write-Host "    Backend starting... (waiting 5s)" -ForegroundColor Gray
    Start-Sleep -Seconds 5
}

# --- Start Frontend ---
Write-Host "[2/2] Starting Frontend..." -ForegroundColor Yellow
$frontendPath = Join-Path $projectRoot "frontend\web"
$frontendRunning = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*ANY-ERP-Frontend*" }
if ($frontendRunning) {
    Write-Host "    Frontend is already running" -ForegroundColor Green
} else {
    $frontendCmd = "cd /d `"$frontendPath`" && npm run dev"
    Start-Process -FilePath cmd -ArgumentList "/k", "title ANY-ERP-Frontend && $frontendCmd"
    Write-Host "    Frontend starting... (waiting 5s)" -ForegroundColor Gray
    Start-Sleep -Seconds 5
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "             Started!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Database: Tencent Cloud MySQL"
Write-Host "  Backend:  http://localhost:3000"
Write-Host "  Frontend: http://localhost:5173"
Write-Host ""
Read-Host "Press Enter to open browser"
Start-Process "http://localhost:5173"
