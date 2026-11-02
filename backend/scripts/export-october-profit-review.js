const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const M = require('../src/models');
const { Op } = require('sequelize');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value || [];
const active = rows => rows.filter(row => row.状态 !== 'returned');

async function run() {
  const directory = path.resolve(__dirname, '../backup/october-external-pricing-audit');
  const audit = JSON.parse(fs.readFileSync(path.join(directory,'audit.json'),'utf8'));
  const pricing = active(audit.pricing), fees = active(audit.externalFee), freight = active(audit.freight);
  const impacts = new Map(active(audit.impact).map(row=>[row.订单,row]));
  const pricingMap = new Map(pricing.map(row=>[row.订单,row]));
  const rows = new Map();
  function row(base) {
    if (!rows.has(base.订单)) rows.set(base.订单, { 订单号: base.订单, 门店: base.门店, SN: new Set(), 问题: new Set(),
      核对状态: new Set(), 原计价: '', 采购价参考: '', 外调额度参考: '', 运费少计参考: 0, 当前毛利: impacts.get(base.订单)?.原毛利 ?? '',
      假设复核毛利: impacts.get(base.订单)?.假设修正后毛利 ?? '', 假设变化: impacts.get(base.订单)?.假设差额 ?? '', 依据或备注: new Set() });
    const current = rows.get(base.订单);
    if (base.SN) current.SN.add(base.SN);
    return current;
  }
  for (const source of pricing) {
    const current=row(source); current.问题.add('外调来源疑似误用公司定价');
    current.原计价=source.原计价;current.采购价参考=source.归档采购价;current.外调额度参考=source.外调额度;
    current.核对状态.add(source.判断.startsWith('采购来源明确')?'采购价快照与归档明确冲突':
      ['PF6B0PQT','MP2ZEEPG'].includes(source.SN)?'用户已指出，尚未执行纠错':'待确认历史计价选择');
    current.依据或备注.add(`${source.原入库采购单}；${source.判断}`);
  }
  for (const source of fees) {
    const current=row(source);current.问题.add('外调费疑似漏计');current.外调额度参考=source.外调额度;
    if (!pricingMap.has(source.订单)) current.核对状态.add('采购价口径已有依据，核对外调费');
    current.依据或备注.add(`外调额度${source.外调额度}元；实际适用仍须满足原毛利门槛`);
  }
  for (const source of freight) {
    const current=row(source);
    const manual=source.判断.startsWith('已有');
    current.问题.add(manual?'手工运费补录需排查重复':'自动运费漏带或少计');
    current.核对状态.add(manual?'需人工核对补录和原始运费':'来源及归档时间可追溯');
    current.运费少计参考=Math.round((current.运费少计参考+source.差额)*100)/100;
    current.依据或备注.add(`${source.来源单号}：自动${source.原自动运费}，来源${source.来源运费}；${source.判断}`);
    if(manual){current.假设复核毛利='';current.假设变化='';}
  }
  const knownNos=['ORD202610190158486358','ORD202610290950444702','ORD202610100929240987','ORD202610300301303940'];
  const known=await M.Order.findAll({where:{order_no:{[Op.in]:knownNos}},attributes:['order_id','order_no','store_id','order_status'],raw:true});
  const ids=known.map(order=>order.order_id);
  const gps=await M.OrderGrossProfit.findAll({where:{order_id:{[Op.in]:ids}},raw:true});
  const stores=await M.Store.findAll({attributes:['store_id','name'],raw:true});
  const storeMap=new Map(stores.map(store=>[store.store_id,store.name]));
  const knownMap=new Map(known.map(order=>[order.order_no,{...order,gp:gps.find(gp=>gp.order_id===order.order_id)}]));
  const repair=knownMap.get('ORD202610190158486358');
  const repairFinding=[];
  if(repair){
    const supp=parse(repair.gp.supplement_details);
    const manual=supp.filter(line=>line.source!=='freight_cost'&&Number(line.amount)===38);
    if(Number(repair.gp.freight_cost_amount)===377&&manual.length){
      const source={订单:repair.order_no,门店:storeMap.get(repair.store_id),SN:'PF3ESZGS / PF3ESZGS-1'};
      const current=row(source);current.问题.add('运费疑似误录及重复扣减');current.核对状态.add('待核实实际运费，不自动设定正确金额');
      current.当前毛利=Number(repair.gp.gross_profit_amount);current.假设复核毛利='';current.假设变化='';
      current.依据或备注.add('采购自动运费377=17+360元，另补录38元（17+21）；360与配件采购金额相同，17可能重复。');
      repairFinding.push({订单号:repair.order_no,门店:source.门店,当前毛利:current.当前毛利,自动运费:377,补录运费:38,判断:'需核对原凭证，尚未纠正'});
    }
  }
  const all=[...rows.values()].map(current=>({...current,SN:[...current.SN].join(' / '),问题:[...current.问题].join('；'),
    核对状态:[...current.核对状态].join('；'),依据或备注:[...current.依据或备注].join('；')}))
    .sort((a,b)=>a.订单号.localeCompare(b.订单号));
  const priority=all.filter(current=>fees.some(source=>source.订单===current.订单号));
  const processed=[
    ['ORD202610290950444702','报价1105元、外调费200元及运费36元已纠正'],
    ['ORD202610100929240987','1000元教育优惠补录已取消'],
    ['ORD202610300301303940','已转成都自营仓，不再归属万象城']
  ].map(([no,result])=>{const current=knownMap.get(no);return{订单号:no,当前归属:storeMap.get(current?.store_id),当前毛利:Number(current?.gp?.gross_profit_amount),处理结果:result};});
  // Same PN was explicitly raised by the user; check all October occurrences without generalizing the rule to other PNs.
  const [pnRows]=await M.sequelize.query(`SELECT o.ORDER_NO order_no,o.ORDER_STATUS order_status,s.NAME store_name,g.PRODUCT_PRICING_DETAILS pricing
    FROM T_ORDER o JOIN T_STORE s ON s.STORE_ID=o.STORE_ID JOIN T_ORDER_GROSS_PROFIT g ON g.ORDER_ID=o.ORDER_ID
    WHERE o.IS_DELETED=0 AND o.CREATE_TIME>='2026-10-01 00:00:00' AND o.CREATE_TIME<'2026-11-01 00:00:00'
      AND CAST(g.PRODUCT_PRICING_DETAILS AS CHAR) LIKE '%67D2UAS1CB%'`);
  const pnCheck=pnRows.flatMap(order=>parse(order.pricing).filter(line=>line.pnCode==='67D2UAS1CB').map(line=>({订单号:order.order_no,
    门店:order.store_name,状态:order.order_status,PN:line.pnCode,SN:line.snCode,当前计价:line.unitPricing,计价来源:line.source,
    结论:Number(line.unitPricing)===1105&&line.isCompanyPriced?'已按公司报价1105元':'报价口径需确认'})));
  const overview=[
    {项目:'扫描范围',数量:1309,说明:'按北京时间10月订单创建日期，已归档；另30张退货单单列'},
    {项目:'计价及外调费重点订单',数量:priority.length,说明:'其中6张计价待核对，3张仅外调费等线索；尚未自动纠正'},
    {项目:'自动运费漏带或少计',数量:audit.summary.freightOmissionOrders,说明:'包含与重点订单交叉的记录，不能相加'},
    {项目:'手工运费补录需核对',数量:audit.summary.freightManualReviewOrders,说明:'可能已手工补足，不直接重复补扣'},
    {项目:'已知运费误录/重复线索',数量:repairFinding.length,说明:'377元自动运费及38元补录的维修单'},
    {项目:'全部待核对去重订单',数量:all.length,说明:'线索清单，不等于已确认算错的订单数'},
    {项目:'已处理订单',数量:processed.length,说明:'单独列示，不混入待核对清单'},
    {项目:'报价同PN复核',数量:pnCheck.length,说明:'仅核对用户指出的67D2UAS1CB，其他PN不推定同一计价规则'},
    {项目:'假设毛利含义',数量:'',说明:'使用原快照其他商品、支付及开票依据，并按待确认计价和可追溯运费试算；不是已生效金额'},
    {项目:'人工确认要求',数量:'',说明:'当前供应商规则不能证明历史计价错误；手工运费、报价口径及原凭证需逐单确认。无数据库写入。'}
  ];
  const workbook=XLSX.utils.book_new();
  const sheets=[['说明及数量',overview],['重点订单',priority],['全部待核对',all],
    ['自动运费明细',active(audit.freight).filter(source=>!source.判断.startsWith('已有'))],
    ['手工补录运费核对',active(audit.freight).filter(source=>source.判断.startsWith('已有'))],
    ['已知运费误录',repairFinding],['已处理',processed],['同PN报价复核',pnCheck],['退货另列待核对',audit.review]];
  for(const [name,data]of sheets){
    const sheet=XLSX.utils.json_to_sheet(data);sheet['!cols']=Object.keys(data[0]||{}).map(key=>({wch:/订单号|SN|订单/.test(key)?29:/问题|状态|备注|说明|判断/.test(key)?48:18}));
    if(sheet['!ref'])sheet['!autofilter']={ref:sheet['!ref']};XLSX.utils.book_append_sheet(workbook,sheet,name);
  }
  const filename=path.join(directory,'2026年10月毛利问题待核对清单-20261102.xlsx');XLSX.writeFile(workbook,filename);
  fs.writeFileSync(path.join(directory,'consolidated-review.json'),JSON.stringify({overview,priority,all,processed,pnCheck},null,2));
  const check=XLSX.readFile(filename);const count=XLSX.utils.sheet_to_json(check.Sheets['全部待核对']).length;
  if(count!==all.length)throw new Error('Workbook row count mismatch');
  console.log(JSON.stringify({file:filename,total:all.length,priority:priority.length,processed,pnCheck,
    priorityRows:priority.map(current=>({order:current.订单号,store:current.门店,sn:current.SN,issues:current.问题,profit:current.当前毛利,preview:current.假设复核毛利}))}));
}
run().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>M.sequelize.close());
