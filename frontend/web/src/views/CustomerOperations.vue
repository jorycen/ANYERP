<template>
  <section class="customer-operations">
    <div class="toolbar">
      <h2>{{ titles[tab] }}</h2>
      <el-select v-model="dealer" placeholder="积分归属经销商" @change="reload"><el-option v-for="d in options.distributors" :key="d.distributor_id" :label="d.name" :value="d.distributor_id" /></el-select>
      <el-input v-if="tab === 'points'" v-model="memberFilter" placeholder="按会员ID查询" clearable @change="reload" />
      <el-button @click="reload">刷新</el-button>
      <el-button v-if="tab === 'rewards'" type="primary" @click="editReward()">新增积分商品</el-button>
      <el-button v-if="tab === 'points'" @click="ruleOpen = true; loadRules()">积分规则</el-button>
      <el-button v-if="tab === 'points'" @click="adjustOpen = true">人工调整</el-button>
      <el-button v-if="tab === 'members'" @click="claimOpen = true">异常认领核验</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-card v-if="tab==='exchanges'" class="redemption-panel">
      <template #header>到店核销</template>
      <p>现金补差先通过门店现有收款流程收款；优惠券先核对门槛和范围，并在原销售单记录优惠。本入口记录核销凭据，不生成第二笔收款或自动改价。</p>
      <el-form label-width="120px"><el-form-item label="核销门店"><el-select v-model="redeemForm.store_id" @change="redemptionPreview=null"><el-option v-for="s in redemptionStores" :key="s.store_id" :label="storeLabel(s)" :value="s.store_id" /></el-select></el-form-item>
      <el-form-item label="客户核销码"><el-input v-model="redeemForm.code" @input="redemptionPreview=null" placeholder="客户在我的兑换或我的优惠券中出示的核销码" /></el-form-item>
      <el-form-item><el-button :loading="saving" @click="previewRedemption">查询凭证</el-button></el-form-item>
      <template v-if="redemptionPreview"><el-alert :title="redemptionPreview.name+' · '+(states[redemptionPreview.status] || redemptionPreview.status)" :closable="false" />
      <p>会员 {{redemptionPreview.member}} · {{redemptionPreview.selfOnly?'仅本人使用':'按权益说明使用'}} · 有效期 {{date(redemptionPreview.expiresAt)}}</p>
      <template v-if="Number(redemptionPreview.cashRequired)>0"><el-form-item label="应收现金补差">¥{{redemptionPreview.cashRequired}}</el-form-item><el-form-item label="实际已收（元）"><el-input v-model="redeemForm.cash_received" /></el-form-item><el-form-item><el-checkbox v-model="redeemForm.cash_confirmed">已核对门店收款记录并收齐现金补差</el-checkbox></el-form-item></template>
      <template v-if="redemptionPreview.kind==='coupon'"><p>使用范围：{{redemptionPreview.couponScope}}；门槛：¥{{redemptionPreview.couponMinSpend}}；面额：¥{{redemptionPreview.couponValue}}</p><el-form-item label="适用消费额（元）"><el-input v-model="redeemForm.eligible_amount" /></el-form-item><el-form-item><el-checkbox v-model="redeemForm.scope_confirmed">已核对消费属于券适用范围，优惠已在原单记录或服务已交付</el-checkbox></el-form-item></template>
      <el-form-item v-if="Number(redemptionPreview.cashRequired)>0 || redemptionPreview.kind==='coupon'" label="原单 / 收款凭据"><el-input v-model="redeemForm.receipt_reference" maxlength="128" placeholder="销售单号、收款流水或服务工单号" /></el-form-item>
      <el-form-item><el-button type="primary" :disabled="redemptionPreview.status!=='pending'" :loading="saving" @click="confirmRedemption">确认核销</el-button></el-form-item></template></el-form>
    </el-card>
    <el-table v-loading="loading" :data="rows" border stripe>
      <template v-if="tab === 'members'">
        <el-table-column prop="member_id" label="会员ID" min-width="240" />
        <el-table-column prop="phone" label="手机号" width="150" />
        <el-table-column prop="wechat_identity" label="微信身份" width="150" />
        <el-table-column prop="source_store_id" label="来源门店" />
        <el-table-column label="首次消费" width="180"><template #default="{row}">{{ date(row.first_purchase_at) }}</template></el-table-column>
        <el-table-column prop="balance" label="当前积分" />
        <el-table-column prop="earned" label="累计获得" />
        <el-table-column prop="reversed" label="累计冲回" />
        <el-table-column prop="spent" label="累计兑换积分" />
        <el-table-column prop="exchange_count" label="累计兑换次数" />
        <el-table-column label="操作"><template #default="{row}"><el-button link type="primary" @click="router.push({path:'/customer-ops/points', query:{member:row.member_id, dealer}})">积分流水</el-button></template></el-table-column>
      </template>
      <template v-else-if="tab === 'points'">
        <el-table-column label="时间" width="180"><template #default="{row}">{{ date(row.created_at) }}</template></el-table-column>
        <el-table-column prop="member_id" label="会员" min-width="230" />
        <el-table-column label="类型"><template #default="{row}">{{ types[row.type] || row.type }}</template></el-table-column>
        <el-table-column prop="delta" label="积分变化" /><el-table-column prop="before" label="变动前" /><el-table-column prop="after" label="变动后" />
        <el-table-column prop="order_id" label="关联订单" min-width="220" /><el-table-column prop="return_id" label="关联退单" min-width="220" />
        <el-table-column prop="exchange_id" label="关联兑换" min-width="220" /><el-table-column prop="actor" label="操作人" /><el-table-column prop="reason" label="原因" min-width="160" />
      </template>
      <template v-else-if="tab === 'rewards'">
        <el-table-column prop="name" label="商品名称" min-width="180" /><el-table-column label="类型"><template #default="{row}">{{rewardTypes[row.kind] || row.kind}}</template></el-table-column>
        <el-table-column prop="points" label="所需积分" /><el-table-column label="现金补差"><template #default="{row}">¥{{row.cash_required || row.snapshot?.cash_required || '0.00'}}</template></el-table-column><el-table-column label="剩余数量"><template #default="{row}">{{row.stock ?? '不限'}}</template></el-table-column>
        <el-table-column prop="valid_days" label="有效天数" /><el-table-column label="状态"><template #default="{row}"><el-tag :type="row.on_sale?'success':'info'">{{row.on_sale?'已上架':'已下架'}}</el-tag></template></el-table-column>
        <el-table-column label="操作"><template #default="{row}"><el-button link type="primary" @click="editReward(row.id)">编辑</el-button></template></el-table-column>
      </template>
      <template v-else>
        <el-table-column prop="id" label="兑换ID" min-width="230" /><el-table-column prop="member_id" label="会员" min-width="230" />
        <el-table-column label="权益"><template #default="{row}">{{row.snapshot.name}}</template></el-table-column><el-table-column prop="points" label="所需积分" /><el-table-column label="现金补差"><template #default="{row}">¥{{row.cash_required || row.snapshot?.cash_required || '0.00'}}</template></el-table-column>
        <el-table-column label="状态"><template #default="{row}">{{states[row.status]}}</template></el-table-column>
        <el-table-column label="到期时间" width="180"><template #default="{row}">{{date(row.expires_at)}}</template></el-table-column>
      </template>
    </el-table>
    <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="total, prev, pager, next" @current-change="load" />
    <template v-if="tab==='exchanges'"><h3>门店核销记录</h3><el-table :data="redemptions" border><el-table-column prop="exchange_id" label="兑换ID" /><el-table-column prop="store_id" label="门店" /><el-table-column prop="staff_id" label="员工" /><el-table-column label="核销时间"><template #default="{row}">{{date(row.created_at)}}</template></el-table-column></el-table></template>
    <el-dialog v-model="rewardOpen" title="积分商品" width="600px">
      <el-form label-width="130px"><el-form-item label="积分归属经销商"><el-select v-model="reward.distributor_id" :disabled="!!reward.id" @change="changeRewardDealer"><el-option v-for="d in options.distributors" :key="d.distributor_id" :label="d.name" :value="d.distributor_id" /></el-select><div class="form-help">兑换扣除此经销商的积分，适用门店可单独选择。</div></el-form-item><el-form-item label="名称"><el-input v-model="reward.name" /></el-form-item>
        <el-form-item label="类型"><el-radio-group v-model="reward.kind"><el-radio value="service" label="service">服务权益</el-radio><el-radio value="gift" label="gift">实物礼品</el-radio><el-radio value="coupon" label="coupon">优惠券</el-radio></el-radio-group></el-form-item>
        <el-form-item label="图片地址"><el-input v-model="reward.image" placeholder="公开HTTPS图片地址" /></el-form-item>
        <el-form-item label="简短介绍"><el-input v-model="reward.description" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="参考价值（元）"><el-input v-model="reward.original_price" /></el-form-item>
        <el-form-item label="兑换方式"><el-radio-group v-model="exchangeMode"><el-radio value="points" label="points">纯积分</el-radio><el-radio value="mixed" label="mixed" :disabled="reward.kind==='coupon'">积分＋现金</el-radio></el-radio-group></el-form-item>
        <el-form-item label="所需积分"><el-input v-model="reward.points" placeholder="例如800" /></el-form-item>
        <el-form-item v-if="exchangeMode==='mixed'" label="到店支付（元）"><el-input v-model="reward.cash_required" placeholder="例如39" /><div class="form-help">门店线下收款，member小程序只展示金额，不发起在线支付。</div></el-form-item>
        <el-form-item label="小程序展示"><el-tag size="large">{{reward.points || '0'}}积分{{exchangeMode==='mixed'?' + ¥'+(reward.cash_required || '0'):''}}</el-tag><span v-if="exchangeMode==='mixed'">现金到店支付</span></el-form-item>
        <el-form-item label="展示优先级"><el-input-number v-model="reward.sort" :min="-1000000" :max="1000000" /><span>同等可兑条件下，数值越大越靠前</span></el-form-item>
        <el-form-item label="兑换开始"><el-date-picker v-model="reward.valid_start_time" type="datetime" placeholder="不限" /></el-form-item>
        <el-form-item label="兑换结束"><el-date-picker v-model="reward.valid_end_time" type="datetime" placeholder="不限" /></el-form-item>
        <el-form-item label="限本人使用"><el-switch v-model="reward.self_only" /></el-form-item>
        <template v-if="reward.kind==='coupon'"><el-form-item label="券面金额（元）"><el-input v-model="reward.coupon_value" /><span>免费服务券填0，在说明中写明服务内容</span></el-form-item><el-form-item label="使用门槛（元）"><el-input v-model="reward.coupon_min_spend" /></el-form-item><el-form-item label="优惠券范围"><el-input v-model="reward.coupon_scope" placeholder="例如：指定配件；到店由员工核对范围" /></el-form-item></template>
        <el-form-item label="剩余数量"><el-input-number v-model="reward.stock" :min="0" /><span>留空不限</span></el-form-item>
        <el-form-item label="每人限兑"><el-input-number v-model="reward.per_member_limit" :min="0" /><span>留空不限</span></el-form-item>
        <el-form-item label="有效天数"><el-input-number v-model="reward.valid_days" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="适用门店"><el-select v-model="reward.store_ids" multiple filterable style="width:100%" placeholder="选择可使用的门店"><el-option-group v-for="g in rewardStoreGroups" :key="g.id" :label="g.name"><el-option v-for="s in g.stores" :key="s.store_id" :label="s.name" :value="s.store_id" /></el-option-group></el-select><div class="form-help"><el-button link type="primary" @click="reward.store_ids=rewardStores.map(s=>s.store_id)">全选可选门店</el-button><el-button link @click="reward.store_ids=[]">清空</el-button><div>{{options.canChooseAllRewardStores?'boss可同时选择成都、重庆等经销商下的门店；只在所选门店使用。':'仅可选择当前积分归属经销商内的授权门店。'}}</div></div></el-form-item>
        <el-form-item label="使用说明"><el-input v-model="reward.instructions" type="textarea" :rows="4" /></el-form-item><el-form-item label="上架"><el-switch v-model="reward.on_sale" /></el-form-item>
      </el-form><template #footer><el-button @click="rewardOpen=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveReward">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="ruleOpen" title="积分规则" width="680px">
      <p>手机号批量领取使用领取时有效的规则，已提交未归档订单也可领取。已领取订单保留原规则，不因发布新版本重算。</p><p>金额按优惠后客户负担金额计分，包含抵扣定金，排除政策补贴；积分向下取整。</p>
      <el-alert title="消费10元获得1积分；10积分可抵1元。全部消费商品使用同一基础比例，活动积分单独赠送。" type="info" :closable="false" />
      <el-table :data="rules"><el-table-column prop="numerator" label="积分" /><el-table-column prop="denominator" label="金额（分）" /><el-table-column label="生效时间"><template #default="{row}">{{date(row.effective_at)}}</template></el-table-column></el-table>
      <template #footer><el-button type="primary" :loading="saving" @click="publishRule">发布新版本</el-button></template>
    </el-dialog>
    <el-dialog v-model="adjustOpen" title="积分调整 / 活动赠送" width="500px"><el-form label-width="100px"><el-form-item label="类型"><el-select v-model="adjust.type"><el-option label="人工调整" value="adjustment" /><el-option label="活动赠送" value="activity" /></el-select></el-form-item><el-form-item label="会员ID"><el-input v-model="adjust.member_id" /></el-form-item><el-form-item label="积分变化"><el-input v-model="adjust.delta" placeholder="正数增加，负数扣减" /></el-form-item><el-form-item label="原因"><el-input v-model="adjust.reason" type="textarea" /></el-form-item></el-form><template #footer><el-button :loading="saving" type="primary" @click="saveAdjust">确认调整并记录流水</el-button></template></el-dialog>
    <el-dialog v-model="claimOpen" title="订单认领人工核验" width="500px"><p>核对原店购机凭据与客户身份后，允许指定会员领取；不会直接发积分。</p><el-input v-model="claim.order" placeholder="销售订单ID" /><el-input v-model="claim.member_id" placeholder="客户小程序显示的会员ID" /><el-input v-model="claim.reason" placeholder="核验依据与原因" type="textarea" /><template #footer><el-button :loading="saving" type="primary" @click="approveClaim">确认核验</el-button></template></el-dialog>
  </section>
</template>
<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { customerOpsRequest as request } from '../api'
const route=useRoute(), router=useRouter(), tab=computed(()=>route.meta.tab)
const titles={members:'会员管理',points:'积分管理',rewards:'积分商品',exchanges:'兑换核销'}, types={earn:'购机获得',exchange:'兑换扣减',return:'退货冲回',adjustment:'后台调整',activity:'活动赠送',order_adjust:'订单积分调整'}, states={pending:'待使用',redeemed:'已核销',expired:'已失效'}
const rewardTypes={service:'服务',gift:'实物礼品',product:'实物礼品',coupon:'优惠券'}
const exchangeMode=ref('points')
const options=ref({distributors:[],stores:[],canChooseAllRewardStores:false}), dealer=ref(''), rows=ref([]), page=ref(1), total=ref(0), error=ref(''), loading=ref(false), saving=ref(false), memberFilter=ref(''), redemptions=ref([])
const rewardOpen=ref(false), reward=ref({}), ruleOpen=ref(false), rules=ref([]), rule=ref({numerator:'1',denominator:'1000',products:''}), adjustOpen=ref(false), adjust=ref({type:'adjustment'}), claimOpen=ref(false), claim=ref({})
const redeemForm=ref({code:'',store_id:'',cash_received:'',cash_confirmed:false,eligible_amount:'',scope_confirmed:false,receipt_reference:''}), redemptionPreview=ref(null)
const rewardStores=computed(()=>options.value.stores.filter(s=>options.value.canChooseAllRewardStores || String(s.distributor_id)===String(reward.value.distributor_id)))
const rewardStoreGroups=computed(()=>options.value.distributors.map(d=>({id:d.distributor_id,name:d.name,stores:rewardStores.value.filter(s=>String(s.distributor_id)===String(d.distributor_id))})).filter(g=>g.stores.length))
const redemptionStores=computed(()=>options.value.stores)
function storeLabel(s){const d=options.value.distributors.find(d=>String(d.distributor_id)===String(s.distributor_id));return `${d?.name || ''} · ${s.name}`}
function changeRewardDealer(){if(!options.value.canChooseAllRewardStores)reward.value.store_ids=[]}
watch(()=>reward.value.kind,kind=>{if(kind==='coupon'){exchangeMode.value='points';reward.value.cash_required='0.00'}})
const date=v=>v?new Date(v).toLocaleString('zh-CN'):''
async function load(){if(!dealer.value)return;loading.value=true;error.value='';try{const result=await request('get',tab.value==='points'?'/points/ledger':`/${tab.value}`,{distributor_id:dealer.value,page:page.value,member_id:memberFilter.value||undefined});rows.value=result.list;total.value=result.total;if(tab.value==='exchanges')redemptions.value=(await request('get','/redemptions',{distributor_id:dealer.value,page:page.value})).list}catch(e){error.value=e.message}finally{loading.value=false}}
function reload(){redemptionPreview.value=null;page.value=1;return load()}
async function action(fn){saving.value=true;try{await fn();ElMessage.success('操作成功');await load()}catch(e){if(e!=='cancel')ElMessage.error(e.message||'操作失败')}finally{saving.value=false}}
async function editReward(id){try{reward.value=id?await request('get',`/rewards/${id}`):{distributor_id:dealer.value,name:'',kind:'service',image:'',description:'',original_price:'0.00',cash_required:'0.00',sort:0,valid_start_time:null,valid_end_time:null,self_only:true,coupon_value:'0.00',coupon_min_spend:'0.00',coupon_scope:'',points:'300',stock:null,per_member_limit:null,valid_days:30,instructions:'',on_sale:false,store_ids:[]};if(reward.value.kind==='product')reward.value.kind='gift';exchangeMode.value=Number(reward.value.cash_required)>0?'mixed':'points';rewardOpen.value=true}catch(e){ElMessage.error(e.message)}}
function saveReward(){return action(async()=>{if(exchangeMode.value==='mixed' && !(Number(reward.value.cash_required)>0))throw new Error('积分＋现金换购需要填写大于0的到店支付金额');await request(reward.value.id?'patch':'post',reward.value.id?`/rewards/${reward.value.id}`:'/rewards',{...reward.value,cash_required:exchangeMode.value==='mixed' && reward.value.kind!=='coupon'?reward.value.cash_required:'0.00',distributor_id:reward.value.distributor_id,stock:reward.value.stock??null,per_member_limit:reward.value.per_member_limit??null});rewardOpen.value=false})}
async function previewRedemption(){saving.value=true;redemptionPreview.value=null;try{redeemForm.value.cash_confirmed=false;redeemForm.value.scope_confirmed=false;redeemForm.value.cash_received='';redeemForm.value.eligible_amount='';redeemForm.value.receipt_reference='';redemptionPreview.value=await request('post','/redemptions/preview',redeemForm.value)}catch(e){ElMessage.error(e.message)}finally{saving.value=false}}
function confirmRedemption(){return action(async()=>{await ElMessageBox.confirm('请确认客户身份、权益范围与交付情况。核销后不能重复使用。','确认到店核销');await request('post',`/exchange/${redemptionPreview.value.id}/redeem`,redeemForm.value);redemptionPreview.value=null})}
async function loadRules(){try{rules.value=(await request('get','/point-rules',{distributor_id:dealer.value})).list}catch(e){ElMessage.error(e.message)}}
function publishRule(){return action(async()=>{await ElMessageBox.confirm('新版本将用于后续首次领取积分的订单，是否发布？','发布积分规则');await request('post','/point-rules',{...rule.value,distributor_id:dealer.value,product_ids:rule.value.products.split(/[,，\s]+/).filter(Boolean)});await loadRules()})}
let adjustKey=''
watch(adjust,()=>{adjustKey=''}, {deep:true})
function saveAdjust(){return action(async()=>{adjustKey ||= crypto.randomUUID();await request('post','/points/adjustments',{...adjust.value,distributor_id:dealer.value},adjustKey);adjustOpen.value=false;adjustKey=''})}
function approveClaim(){return action(async()=>{await request('post',`/claims/${encodeURIComponent(claim.value.order)}/approve`,claim.value);claimOpen.value=false})}
watch(()=>route.fullPath,()=>{memberFilter.value=String(route.query.member||'');if(route.query.dealer)dealer.value=String(route.query.dealer);reload()})
onMounted(async()=>{try{options.value=await request('get','/options');dealer.value=String(route.query.dealer||options.value.distributors[0]?.distributor_id||'');memberFilter.value=String(route.query.member||'');await load()}catch(e){error.value=e.message}})
</script>
<style scoped>
.form-help{width:100%;font-size:12px;color:#64748b;line-height:1.7;margin-top:6px}.redemption-panel{margin:20px 0}.customer-operations{padding:20px}.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:18px;flex-wrap:wrap}.toolbar h2{margin:0 auto 0 0}.toolbar .el-input{width:240px}.toolbar .el-select{width:200px}.el-pagination{margin:20px 0}.el-dialog .el-input{margin-bottom:8px}.el-form-item span{margin-left:12px;color:#64748b}
</style>
