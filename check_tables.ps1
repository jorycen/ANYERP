$mysqlPath = "d:\艾诺云\Soft\ANY-ERP\backend-package\mysql-8.0.36-winx64\bin\mysql.exe"
& $mysqlPath -u root -D any_erp -e "SHOW TABLES LIKE 't_return%';"
