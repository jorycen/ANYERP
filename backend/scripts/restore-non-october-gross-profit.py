"""Restore non-October order data from the exact pre-migration row binlog images."""
import argparse
import base64
import itertools
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend' / 'tmp_mysql_replication'))
import pymysql

ARTIFACT = ROOT / 'backup' / 'restore-non-october-gross-profit-20261012.jsonl'
CONFLICTS = ROOT / 'backup' / 'restore-non-october-gross-profit-conflicts.json'
PRIMARY_KEYS = {
    'T_ORDER_GROSS_PROFIT': 'GROSS_PROFIT_ID',
    'T_ORDER_ITEM': 'ITEM_ID',
    'T_PRODUCT_SETTLEMENT_ORDER': 'SETTLEMENT_ID',
    'T_PRODUCT_SETTLEMENT_ITEM': 'SETTLEMENT_ITEM_ID',
    'T_SALES_RETURN_GROSS_PROFIT': 'LEDGER_ID',
}
JSON_COLUMNS = {'PAYMENT_FEE_DETAILS', 'SETTLEMENT_COST_DETAILS',
                'PRODUCT_PRICING_DETAILS', 'SUPPLEMENT_DETAILS'}
local = threading.local()


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

SETTINGS = {
    'host': os.environ['DB_HOST'], 'port': int(os.environ.get('DB_PORT', '3306')),
    'user': os.environ['DB_USER'], 'passwd': os.environ['DB_PASSWORD'],
    'db': os.environ['DB_NAME'], 'charset': 'utf8mb4',
    'cursorclass': pymysql.cursors.DictCursor, 'autocommit': False,
}


def connection():
    if not hasattr(local, 'connection'):
        local.connection = pymysql.connect(**SETTINGS)
    else:
        local.connection.ping(reconnect=True)
    return local.connection


def canonical(value, column):
    if column in JSON_COLUMNS:
        if isinstance(value, str):
            value = json.loads(value)
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=' ') if isinstance(value, datetime) else value.isoformat()
    return value


def sql_value(value, column):
    if isinstance(value, dict) and '__base64__' in value:
        return base64.b64decode(value['__base64__'])
    if column in JSON_COLUMNS and value is not None:
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return value


def restore_one(record, execute, verify):
    order_id = record['order_id']
    db = connection()
    try:
        db.begin()
        changes_to_apply = []
        with db.cursor() as cursor:
            for change in record['changes']:
                table = change['table']
                pk = PRIMARY_KEYS[table]
                before, after = change['before'], change['after']
                cursor.execute(f'SELECT * FROM `{table}` WHERE `{pk}`=%s FOR UPDATE', (after[pk],))
                current = cursor.fetchone()
                if not current:
                    db.rollback()
                    return order_id, f'{table} {pk}={after[pk]} missing'
                changed = [column for column in before
                           if canonical(before[column], column) != canonical(after[column], column)]
                for column in changed:
                    expected = before[column] if verify else after[column]
                    if canonical(current[column], column) != canonical(expected, column):
                        db.rollback()
                        return order_id, f'{table} {pk}={after[pk]} {column} differs from expected value'
                if changed:
                    changes_to_apply.append((table, pk, after[pk], before, changed))
            if execute:
                for table, pk, pk_value, before, changed in reversed(changes_to_apply):
                    assignments = ', '.join(f'`{column}`=%s' for column in changed)
                    values = [sql_value(before[column], column) for column in changed]
                    cursor.execute(f'UPDATE `{table}` SET {assignments} WHERE `{pk}`=%s',
                                   (*values, pk_value))
                    if cursor.rowcount != 1:
                        raise RuntimeError(f'{table} {pk}={pk_value} update affected {cursor.rowcount} rows')
                db.commit()
            else:
                db.rollback()
        return order_id, None
    except Exception:
        db.rollback()
        raise


def records(skip, limit):
    with ARTIFACT.open(encoding='utf-8') as input_file:
        for line in itertools.islice(input_file, skip, skip + limit):
            yield json.loads(line)


parser = argparse.ArgumentParser()
parser.add_argument('--execute', action='store_true')
parser.add_argument('--verify', action='store_true')
parser.add_argument('--skip', type=int, default=0)
parser.add_argument('--limit', type=int, default=34963)
parser.add_argument('--workers', type=int, default=12)
args = parser.parse_args()
assert 0 <= args.skip < 34963
assert 1 <= args.limit <= 34963 - args.skip
assert 1 <= args.workers <= 16
assert not (args.execute and args.verify)
print(json.dumps({'mode': 'execute' if args.execute else 'verify' if args.verify else 'preview', 'skip': args.skip, 'limit': args.limit,
                  'workers': args.workers}), flush=True)
completed = 0
conflicts = []
with ThreadPoolExecutor(max_workers=args.workers) as pool:
    for order_id, conflict in pool.map(lambda record: restore_one(record, args.execute, args.verify), records(args.skip, args.limit)):
        completed += 1
        if conflict:
            conflicts.append({'order_id': order_id, 'reason': conflict})
        if completed % 1000 == 0:
            print(json.dumps({'processed': completed, 'restored_or_ready': completed - len(conflicts),
                              'conflicts': len(conflicts)}), flush=True)
if conflicts:
    CONFLICTS.write_text(json.dumps(conflicts, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'processed': completed, 'restored_or_ready': completed - len(conflicts),
                  'conflicts': len(conflicts), 'conflict_file': str(CONFLICTS) if conflicts else None},
                 ensure_ascii=False), flush=True)
if conflicts:
    sys.exit(1)
