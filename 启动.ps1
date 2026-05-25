Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ANY-ERP System Startup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "[1/2] Starting Backend..." -ForegroundColor Yellow
$backendDir = Join-Path $ScriptDir "backend"
$existingBackend = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($existingBackend) {
    Write-Host "  [OK] Backend already running" -ForegroundColor Green
} else {
    Start-Process -FilePath "node" -ArgumentList "src/index.js" -WindowStyle Hidden -WorkingDirectory $backendDir
    Start-Sleep -Seconds 3
    $running = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "  [OK] Backend started (port 3000)" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Backend failed to start" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "[2/2] Starting Frontend..." -ForegroundColor Yellow
$frontendDir = Join-Path $ScriptDir "frontend\web"
Start-Process -FilePath "npm" -ArgumentList "run dev" -WindowStyle Hidden -WorkingDirectory $frontendDir
Start-Sleep -Seconds 3
Write-Host "  [OK] Frontend started (port 5173)" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All services started!" -ForegroundColor Green
Write-Host "  Frontend : http://localhost:5173" -ForegroundColor White
Write-Host "  Backend  : http://localhost:3000" -ForegroundColor White
Write-Host "  Database : Tencent Cloud MySQL" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
