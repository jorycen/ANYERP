import json, sys, hashlib
from pathlib import Path
from decimal import Decimal, InvalidOperation
import openpyxl
sys.stdout.reconfigure(encoding='utf-8')
root=Path(__file__).parent
uploaded=Path('C:/Users/Administrator/Downloads/10月毛利待补资料清单（含SN）.xlsx')
original=root/'10月毛利待补资料清单（含SN）.xlsx'
before=openpyxl.load_workbook(original,data_only=False)
after=openpyxl.load_workbook(uploaded,data_only=False)
a=before['需要补充'];b=after['需要补充']
changes=[];mismatches=[];invalid=[]
def norm(v): return '' if v is None else str(v).strip()
for row in range(7,a.max_row+1):
    old=[a.cell(row,c).value for c in range(1,22)]
    new=[b.cell(row,c).value for c in range(1,22)]
    if any(b.cell(row,c).data_type=='f' for c in range(1,22)):
        invalid.append({'row':row,'reason':'存在公式'});continue
    altered=[c for c in list(range(0,8))+list(range(12,21)) if norm(old[c])!=norm(new[c])]
    if altered:mismatches.append({'row':row,'columns':[c+1 for c in altered]});continue
    try:
        raw=new[8]
        if raw is None or norm(raw)=='': invalid.append({'row':row,'reason':'成本空白'});continue
        cost=Decimal(str(raw))
        if not cost.is_finite() or cost<0 or cost!=cost.quantize(Decimal('.01')):raise ValueError('成本须非负且最多两位小数')
        confirm=norm(new[9])=='是'
        if cost==0 and not confirm:invalid.append({'row':row,'reason':'零成本未明确确认'});continue
        changes.append({'row':row,'itemId':norm(old[19]),'orderItemId':norm(old[18]),'orderNo':norm(old[2]),'name':norm(old[3]),'pn':norm(old[4]),'sn':norm(old[5]),'unitCost':float(cost),'confirmZero':confirm,'priceInput':new[10],'evidence':norm(new[11]),'beforeCost':old[12],'beforePrice':old[13],'foundationId':norm(old[20])})
    except (InvalidOperation,ValueError) as e:invalid.append({'row':row,'reason':str(e)})
result={'source':str(uploaded),'sha256':hashlib.sha256(uploaded.read_bytes()).hexdigest(),'changes':changes,'mismatches':mismatches,'invalid':invalid,'extraRows':max(0,b.max_row-a.max_row)}
(root/'returned-review.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'valid':len(changes),'zero':sum(x['unitCost']==0 for x in changes),'positive':sum(x['unitCost']>0 for x in changes),'priceFilled':sum(norm(x['priceInput'])!='' for x in changes),'mismatches':mismatches,'invalid':invalid,'extraRows':result['extraRows'],'positiveExamples':[x for x in changes if x['unitCost']>0][:20]},ensure_ascii=False,indent=2))
