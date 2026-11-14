// Read-only meeting extract; reuses the existing backend reporting service.
const fs = require('fs');
const path = require('path');
const { sequelize, Store } = require('../src/models');
const { RealtimeSqlDashboardDataSource } = require('../src/modules/report/dashboardDataSource');
const { buildRanges, comparisonRate } = require('../src/modules/report/dashboardService');
const { queryOperatingProfit } = require('../src/modules/report/operatingProfit');
async function main() {
  const stores = await Store.findAll({ where: { is_deleted: 0, status: 1 }, attributes: ['store_id','name'], raw: true });
  const filters = { storeIds: stores.map(x=>String(x.store_id)), archiveScope: 'archived' };
  const source = new RealtimeSqlDashboardDataSource();
  const results = [];
  for (const dates of [['2026-10-29','2026-11-04']]) {
    const ranges = buildRanges({startDate:dates[0],endDate:dates[1]});
    const periods = {};
    for (const key of ['current','previous','yoy']) {
      periods[key] = await queryOperatingProfit(filters,ranges[key],source);
    }
    const current = periods.current.summary;
    const comparisons = {};
    for (const field of ['salesAmount','grossProfit','orderCount']) comparisons[field] = {yoy:comparisonRate(current[field],periods.yoy.summary[field]),wow:comparisonRate(current[field],periods.previous.summary[field])};
    const rows=stores.map(s=>{
      const get=k=>periods[k].rows.find(r=>String(r.storeId)===String(s.store_id))||null;
      const c=get('current'),p=get('previous'),y=get('yoy');
      return {storeId:s.store_id,name:s.name,current:c,previous:p,yoy:y,salesWow:c&&p?comparisonRate(c.salesAmount,p.salesAmount):null,salesYoy:c&&y?comparisonRate(c.salesAmount,y.salesAmount):null,profitWow:c&&p?comparisonRate(c.grossProfit,p.grossProfit):null};
    });
    const comparableIds=rows.filter(x=>x.current&&x.yoy).map(x=>String(x.storeId));
    const sameStore={};
    for(const key of ['current','yoy']) sameStore[key]=(await queryOperatingProfit({...filters,storeIds:comparableIds},ranges[key],source)).summary;
    sameStore.salesYoy=comparisonRate(sameStore.current.salesAmount,sameStore.yoy.salesAmount);
    const retailIds=stores.filter(s=>!String(s.name).includes('自营仓')).map(s=>String(s.store_id));
    const retail={};
    for(const key of ['current','previous'])retail[key]=(await queryOperatingProfit({...filters,storeIds:retailIds},ranges[key],source)).summary;
    retail.salesWow=comparisonRate(retail.current.salesAmount,retail.previous.salesAmount);
    retail.profitWow=comparisonRate(retail.current.grossProfit,retail.previous.grossProfit);
    results.push({ranges,summaries:Object.fromEntries(Object.entries(periods).map(([k,v])=>[k,v.summary])),comparisons,comparableIds,sameStore,retail,stores:rows});
  }
  const report={generatedAt:new Date().toISOString(),source:'existing queryOperatingProfit; archived scope; active stores; read only',results};
  const output=path.resolve(__dirname,'../../reports/weekly-meeting-20261029-20261104-source.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.name,e.message);process.exitCode=1}).finally(()=>sequelize.close());
