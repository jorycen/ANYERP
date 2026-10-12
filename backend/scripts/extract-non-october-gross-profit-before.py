"""Extract exact pre-migration database rows from MySQL row binlog; read only."""
import base64
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend' / 'tmp_mysql_replication'))
import pymysql
from pymysqlreplication import BinLogStreamReader
from pymysqlreplication.event import XidEvent
from pymysqlreplication.row_event import UpdateRowsEvent

TABLES = [
    'T_ORDER_GROSS_PROFIT', 'T_ORDER_ITEM', 'T_PRODUCT_SETTLEMENT_ORDER',
    'T_PRODUCT_SETTLEMENT_ITEM', 'T_SALES_RETURN_GROSS_PROFIT',
]
OUTPUT = ROOT / 'backup' / 'restore-non-october-gross-profit-20261012.jsonl'


def load_env(path):
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"\''))


for env_file in (ROOT / '.env', ROOT / 'cloud-db.env', ROOT / 'backend' / '.env',
                 ROOT / '.env.local', ROOT / 'backend' / '.env.local'):
    load_env(env_file)

settings = {
    'host': os.environ['DB_HOST'], 'port': int(os.environ.get('DB_PORT', '3306')),
    'user': os.environ['DB_USER'], 'passwd': os.environ['DB_PASSWORD'],
    'db': os.environ['DB_NAME'], 'charset': 'utf8mb4',
}


def serializable(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=' ') if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, bytes):
        try:
            return value.decode('utf-8')
        except UnicodeDecodeError:
            return {'__base64__': base64.b64encode(value).decode('ascii')}
    if isinstance(value, list):
        return [serializable(item) for item in value]
    if isinstance(value, dict):
        return {(key.decode('utf-8') if isinstance(key, bytes) else str(key)): serializable(item)
                for key, item in value.items()}
    return value


connection = pymysql.connect(**settings, cursorclass=pymysql.cursors.DictCursor)
try:
    with connection.cursor() as cursor:
        cursor.execute('''SELECT gp.ORDER_ID, o.CREATE_TIME, o.ARCHIVE_TIME
            FROM T_ORDER_GROSS_PROFIT gp JOIN T_ORDER o ON o.ORDER_ID=gp.ORDER_ID
            WHERE gp.CALCULATED_BY='final_snapshot_formula_migration'
              AND gp.FORMULA_VERSION='ORDER_GP_V11_PRODUCT_COST_MODE'
              AND o.IS_DELETED=0''')
        targets = {}
        for row in cursor.fetchall():
            is_october = any(value and date(2026, 10, 1) <= value.date() < date(2026, 11, 1)
                             for value in (row['CREATE_TIME'], row['ARCHIVE_TIME']))
            if not is_october:
                targets[row['ORDER_ID']] = True
        cursor.execute('''SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (%s,%s,%s,%s,%s)
            ORDER BY TABLE_NAME, ORDINAL_POSITION''', TABLES)
        columns = {}
        for row in cursor.fetchall():
            columns.setdefault(row['TABLE_NAME'], []).append(row['COLUMN_NAME'])
finally:
    connection.close()

assert len(targets) == 34963, f'Unexpected target count: {len(targets)}'
for table in TABLES:
    assert columns.get(table), f'Missing schema for {table}'


def named_values(table, values):
    names = columns[table]
    assert len(names) == len(values), (table, len(names), len(values))
    return {name: serializable(values[f'UNKNOWN_COL{index}']) for index, name in enumerate(names)}


stream = BinLogStreamReader(
    connection_settings=settings, server_id=9124262, blocking=False,
    resume_stream=True, log_file='mysql-bin.001909', log_pos=4,
    only_events=[UpdateRowsEvent, XidEvent], only_tables=TABLES,
    only_schemas=[settings['db']], enable_logging=False,
)
found = set()
transactions = 0
updates = 0
pending = []
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
try:
    with OUTPUT.open('w', encoding='utf-8') as output:
        for event in stream:
            if isinstance(event, UpdateRowsEvent):
                if event.timestamp < 1791789000:
                    continue
                table = event.table
                if table not in columns:
                    continue
                for row in event.rows:
                    before = named_values(table, row['before_values'])
                    after = named_values(table, row['after_values'])
                    pending.append({'table': table, 'before': before, 'after': after})
            elif isinstance(event, XidEvent):
                matching = [change for change in pending
                            if change['table'] == 'T_ORDER_GROSS_PROFIT'
                            and change['after'].get('CALCULATED_BY') == 'final_snapshot_formula_migration'
                            and change['after'].get('ORDER_ID') in targets]
                if matching:
                    assert len(matching) == 1, f'Unexpected gross profit rows at {stream.log_pos}'
                    order_id = matching[0]['after']['ORDER_ID']
                    assert order_id not in found, f'Duplicate migration for {order_id}'
                    assert all(change['table'] != 'T_ORDER_GROSS_PROFIT'
                               or change['after'].get('ORDER_ID') == order_id for change in pending)
                    coalesced = {}
                    for change in pending:
                        primary_key = {
                            'T_ORDER_GROSS_PROFIT': 'GROSS_PROFIT_ID',
                            'T_ORDER_ITEM': 'ITEM_ID',
                            'T_PRODUCT_SETTLEMENT_ORDER': 'SETTLEMENT_ID',
                            'T_PRODUCT_SETTLEMENT_ITEM': 'SETTLEMENT_ITEM_ID',
                            'T_SALES_RETURN_GROSS_PROFIT': 'LEDGER_ID',
                        }[change['table']]
                        key = (change['table'], change['after'][primary_key])
                        if key in coalesced:
                            coalesced[key]['after'] = change['after']
                        else:
                            coalesced[key] = change
                    changes = list(coalesced.values())
                    output.write(json.dumps({'order_id': order_id, 'log_file': stream.log_file,
                                             'log_pos': stream.log_pos, 'changes': changes},
                                            ensure_ascii=False) + '\n')
                    found.add(order_id)
                    transactions += 1
                    updates += len(changes)
                    if transactions % 5000 == 0:
                        print(json.dumps({'transactions': transactions, 'updates': updates,
                                          'log_pos': stream.log_pos}), flush=True)
                pending = []
finally:
    stream.close()

missing = set(targets) - found
print(json.dumps({'target_orders': len(targets), 'extracted_orders': len(found),
                  'row_updates': updates, 'missing_orders': len(missing),
                  'artifact': str(OUTPUT)}, ensure_ascii=False), flush=True)
if missing:
    raise RuntimeError(f'{len(missing)} migrated orders were not found in the binlog')
