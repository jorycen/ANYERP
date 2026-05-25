$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mysqlBase = Join-Path $ScriptDir "backend-package\mysql-8.0.36-winx64"
$backupDir = Join-Path $ScriptDir "backup"

Write-Host "=== Import ERP Data ==="
$dumpFile = Join-Path $backupDir "any_erp_clean.sql"
if (-not (Test-Path $dumpFile)) {
    Write-Host "[ERROR] Backup file not found: $dumpFile"
    exit 1
}

Write-Host "[INFO] Importing data, please wait..."
$mysqlExe = Join-Path $mysqlBase "bin\mysql.exe"
$proc = Start-Process -FilePath $mysqlExe -WorkingDirectory (Join-Path $mysqlBase "bin") -ArgumentList "-u root -h 127.0.0.1 -P 3306 --default-character-set=utf8mb4" -RedirectStandardInput $dumpFile -NoNewWindow -Wait -PassThru

if ($proc.ExitCode -eq 0) {
    Write-Host "[OK] Data imported successfully!"
} else {
    Write-Host "[ERROR] Data import failed, exit code: $($proc.ExitCode)"
    exit 1
}

Write-Host "=== Create Return Stock Tables ==="
$tempSql = Join-Path $backupDir "create_return.sql"
@"
CREATE TABLE IF NOT EXISTS any_erp.t_return_stock (
  return_id VARCHAR(32) NOT NULL PRIMARY KEY,
  return_no VARCHAR(64) NOT NULL UNIQUE,
  inbound_id VARCHAR(32) NOT NULL,
  inbound_no VARCHAR(64),
  store_id VARCHAR(32) NOT NULL,
  total_quantity INT DEFAULT 0,
  total_amount DECIMAL(12,2) DEFAULT 0.00,
  reason VARCHAR(512),
  create_user VARCHAR(64),
  create_time DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS any_erp.t_return_stock_item (
  item_id BIGINT(20) NOT NULL AUTO_INCREMENT PRIMARY KEY,
  return_id VARCHAR(32) NOT NULL,
  product_id VARCHAR(32) NOT NULL,
  product_name VARCHAR(255),
  pn_code VARCHAR(64),
  sn_code VARCHAR(128),
  sn_id VARCHAR(32),
  quantity INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(12,2),
  remark VARCHAR(255),
  KEY idx_return_id (return_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"@ | Out-File -FilePath $tempSql -Encoding Default

$proc = Start-Process -FilePath $mysqlExe -WorkingDirectory (Join-Path $mysqlBase "bin") -ArgumentList "-u root -h 127.0.0.1 -P 3306 --default-character-set=utf8mb4" -RedirectStandardInput $tempSql -NoNewWindow -Wait -PassThru

if ($proc.ExitCode -eq 0) {
    Write-Host "[OK] Return stock tables created!"
} else {
    Write-Host "[WARN] Return stock tables may already exist"
}

Write-Host "=== Data Restore Complete ==="
