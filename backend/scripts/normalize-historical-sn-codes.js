// One-off formatting migration. Preview first; --execute requires that preview's hash.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const M = require('../src/models');
const config = require('../src/config').database;
const { normalizeSnFields, normalizeSnCode } = require('../src/utils/snCode');
const dir = path.resolve(__dirname, '../../backup/sn-normalization-20261027');
const q = name => '`' + String(name).replace(/`/g, '``') + '`';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idOf = (row, keys) => JSON.stringify(keys.map(key => row[key]));
const scalar = name => /^(sn_code|old_sn_code|source_sn_code|direct_inbound_sn_code)$/i.test(name);

async function scan(db, lock = false) {
  const plans = [], collisions = [];
  const tables = new Set();
  for (const model of Object.values(M.sequelize.models)) {
    const table = model.getTableName();
    if (typeof table !== 'string' || tables.has(table)) continue;
    tables.add(table);
    const fields = Object.entries(model.rawAttributes).filter(([name]) => scalar(name) || name === 'received_sn_codes').map(([name, attr]) => attr.field || name);
    if (!fields.length) continue;
    const [columns] = await db.query('SELECT COLUMN_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table]);
    const actual = new Map(columns.map(row => [row.COLUMN_NAME.toUpperCase(), row.COLUMN_NAME]));
    const mapped = fields.map(f => actual.get(f.toUpperCase())).filter(Boolean);
    if (mapped.length !== fields.length) throw new Error('Missing schema field: ' + table);
    const [indexes] = await db.query('SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND NON_UNIQUE=0 ORDER BY INDEX_NAME,SEQ_IN_INDEX', [table]);
    const keys = indexes.filter(row => row.INDEX_NAME === 'PRIMARY').map(row=>row.COLUMN_NAME);
    if (!keys.length) throw new Error('No primary key: ' + table);
    const relevantIndexes = new Map();
    for (const row of indexes) {
      if (!relevantIndexes.has(row.INDEX_NAME)) relevantIndexes.set(row.INDEX_NAME, []);
      relevantIndexes.get(row.INDEX_NAME).push(row.COLUMN_NAME);
    }
    const [rows] = await db.query('SELECT * FROM ' + q(table) + ' ORDER BY ' + keys.map(q).join(',') + (lock ? ' FOR UPDATE' : ''));
    const changes = rows.map(before => {
      const values = {};
      for (const field of mapped) {
        const holder = { [field]: before[field] };
        normalizeSnFields(holder);
        if (holder[field] !== before[field]) values[field] = holder[field];
      }
      return { key: Object.fromEntries(keys.map(key=>[key,before[key]])), before, values };
    }).filter(row=>Object.keys(row.values).length);
    const changedIds = new Set(changes.map(row=>idOf(row.before,keys)));
    const blocked = new Set();
    // Include the SN master identity even when an old database lacks a unique index.
    if (table === 'T_PRODUCT_SN') relevantIndexes.set('normalized_sn_identity', [actual.get('SN_CODE')]);
    for (const [index, indexFields] of relevantIndexes) {
      if (!indexFields.some(field=>mapped.includes(field))) continue;
      const groups = new Map();
      for (const row of rows) {
        const values = indexFields.map(field=>scalar(field) ? normalizeSnCode(row[field]) : row[field]);
        if (values.some(v=>v===null || v===undefined)) continue;
        if (index === 'normalized_sn_identity' && !values[0]) continue;
        const key = JSON.stringify(values);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const group of groups.values()) {
        if (group.length < 2 || !group.some(row=>changedIds.has(idOf(row,keys)))) continue;
        group.forEach(row=>blocked.add(idOf(row,keys)));
        collisions.push({ table, index, records: group.map(row=>Object.fromEntries([...keys,...mapped].map(field=>[field,row[field]]))) });
      }
    }
    plans.push({ table, keys, autoUpdate: columns.filter(row=>/on update/i.test(row.EXTRA)).map(row=>row.COLUMN_NAME),
      changes: changes.filter(row=>!blocked.has(idOf(row.before,keys))), blocked: changes.filter(row=>blocked.has(idOf(row.before,keys))) });
  }
  return { plans, collisions };
}
async function main() {
  fs.mkdirSync(dir, {recursive:true});
  const args = process.argv.slice(2), execute = args.includes('--execute');
  const db = await mysql.createConnection({host:config.host,port:config.port,user:config.username,password:config.password,database:config.database,dateStrings:true});
  try {
    if (!execute) await db.query('SET TRANSACTION READ ONLY');
    await db.beginTransaction();
    const data = await scan(db, execute), hash = digest(data);
    const previewFile = path.join(dir,'preview.json');
    if (!execute) {
      await db.rollback();fs.writeFileSync(previewFile,JSON.stringify({hash,...data},null,2));
      console.log(JSON.stringify({hash,summary:data.plans.map(p=>({table:p.table,changes:p.changes.length,blocked:p.blocked.length})),collisionGroups:data.collisions.length},null,2));return;
    }
    const preview = JSON.parse(fs.readFileSync(previewFile,'utf8'));
    if (!args.includes('--expected-hash') || args[args.indexOf('--expected-hash')+1] !== preview.hash || hash !== preview.hash) throw new Error('Preview changed; rerun preview before execution');
    const batchNo = 'SNN20261027-' + crypto.randomBytes(4).toString('hex');
    const backupFile = path.join(dir,batchNo+'-before.json');
    fs.writeFileSync(backupFile,JSON.stringify(data,null,2));
    const results=[];
    for (const plan of data.plans) {
      for (let start=0;start<plan.changes.length;start+=100) {
        const chunk=plan.changes.slice(start,start+100);
        const changedFields=[...new Set(chunk.flatMap(row=>Object.keys(row.values)))];
        const args=[], assignments=[];
        for (const field of changedFields) {
          const cases=[];
          for (const row of chunk.filter(row=>Object.hasOwn(row.values,field))) {
            cases.push('WHEN '+plan.keys.map(key=>q(key)+' <=> ?').join(' AND ')+' THEN ?');
            args.push(...plan.keys.map(key=>row.key[key]),row.values[field]);
          }
          assignments.push(q(field)+' = CASE '+cases.join(' ')+' ELSE '+q(field)+' END');
        }
        for (const field of plan.autoUpdate) assignments.push(q(field)+' = '+q(field));
        const conditions=chunk.map(row=>{args.push(...plan.keys.map(key=>row.key[key]));return '('+plan.keys.map(key=>q(key)+' <=> ?').join(' AND ')+')';});
        const [result]=await db.query('UPDATE '+q(plan.table)+' SET '+assignments.join(',')+' WHERE '+conditions.join(' OR '),args);
        if(result.affectedRows!==chunk.length) throw new Error('Update count mismatch: '+plan.table);
      }
      if(plan.changes.length) {
        const [rows]=await db.query('SELECT * FROM '+q(plan.table));
        const map=new Map(rows.map(row=>[idOf(row,plan.keys),row]));
        for(const row of plan.changes) {
          const after=map.get(idOf(row.before,plan.keys));
          if(!after || digest(after)!==digest({...row.before,...row.values})) throw new Error('Non-SN data or expected value changed: '+plan.table);
        }
        results.push({table:plan.table,updated:plan.changes.length});
      }
    }
    await db.query(`INSERT INTO T_BUSINESS_ACTION_LOG (LOG_ID,BUSINESS_TYPE,BUSINESS_ID,BUSINESS_NO,ACTION,ACTOR_NAME,COMMENT,DETAIL_JSON,CREATE_TIME) VALUES (?,'sn_normalization',?,?,'normalize_sn_format',?,?,?,NOW(3))`,
      [crypto.randomUUID().replace(/-/g,''),batchNo,batchNo,'Codex（用户授权）','统一历史SN大写及首尾空格，冲突记录保留，不改ID、金额、数量或时间',JSON.stringify({hash,backupFile,results,collisionGroups:data.collisions.length})]);
    await db.commit();
    const result={committed:true,batchNo,hash,backupFile,results,collisionGroups:data.collisions.length};
    fs.writeFileSync(path.join(dir,batchNo+'-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  } catch(error) {await db.rollback();throw error;} finally {await db.end();await M.sequelize.close();}
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
