$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mysqlBase = Join-Path $ScriptDir "backend-package\mysql-8.0.36-winx64"
$mysqlData = Join-Path $mysqlBase "data"

$myiniContent = @"
[mysqld]
port=3306
basedir=$mysqlBase
datadir=$mysqlData
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
default-storage-engine=INNODB
max_connections=200

[client]
port=3306
default-character-set=utf8mb4

[mysql]
default-character-set=utf8mb4
"@

$myiniPath = Join-Path $mysqlBase "my.ini"
$myiniContent | Out-File -FilePath $myiniPath -Encoding Default -Force
Write-Host "[OK] my.ini updated"

$existing = Get-Process -Name "mysqld" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[INFO] MySQL is already running, PID: $($existing.Id)"
} else {
    Write-Host "[INFO] Starting MySQL..."
    $mysqldPath = Join-Path $mysqlBase "bin\mysqld.exe"
    $proc = Start-Process -FilePath $mysqldPath -WorkingDirectory (Join-Path $mysqlBase "bin") -ArgumentList "--console" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 5
    $running = Get-Process -Name "mysqld" -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "[OK] MySQL started successfully! PID: $($running.Id)"
    } else {
        $errLog = Join-Path $mysqlData "*.err"
        Write-Host "[ERROR] MySQL failed to start. Check error log in: $errLog"
    }
}
