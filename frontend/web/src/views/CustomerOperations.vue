<template>
  <section class="customer-operations">
    <div class="toolbar">
      <h2>{{ titles[tab] }}</h2>
      <el-select v-model="dealer" placeholder="选择经销商" @change="reload"><el-option v-for="d in options.distributors" :key="d.distributor_id" :label="d.name" :value="d.distributor_id" /></el-select>
      <el-input v-if="tab === 'points'" v-model="memberFilter" placeholder="按会员ID查询" clearable @change="reload" />
      <el-button @click="reload">刷新</el-button>
      <el-button v-if="tab === 'rewards'" type="primary" @click="editReward()">新增积分商品</el-button>
      <el-button v-if="tab === 'points'" @click="ruleOpen = true; loadRules()">积分规则</el-button>
      <el-button v-if="tab === 'points'" @click="adjustOpen = true">人工调整</el-button>
      <el-button v-if="tab === 'members'" @click="claimOpen = true">异常认领核验</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
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
        <el-table-column prop="name" label="商品名称" min-width="180" /><el-table-column label="类型"><template #default="{row}">{{row.kind==='gift'?'实物礼品':'服务权益'}}</template></el-table-column>
        <el-table-column prop="points" label="所需积分" /><el-table-column label="剩余数量"><template #default="{row}">{{row.stock ?? '不限'}}</template></el-table-column>
        <el-table-column prop="valid_days" label="有效天数" /><el-table-column label="状态"><template #default="{row}"><el-tag :type="row.on_sale?'success':'info'">{{row.on_sale?'已上架':'已下架'}}</el-tag></template></el-table-column>
        <el-table-column label="操作"><template #default="{row}"><el-button link type="primary" @click="editReward(row.id)">编辑</el-button></template></el-table-column>
      </template>
      <template v-else>
        <el-table-column prop="id" label="兑换ID" min-width="230" /><el-table-column prop="member_id" label="会员" min-width="230" />
        <el-table-column label="权益"><template #default="{row}">{{row.snapshot.name}}</template></el-table-column><el-table-column prop="points" label="所需积分" />
        <el-table-column label="状态"><template #default="{row}">{{states[row.status]}}</template></el-table-column>
        <el-table-column label="到期时间" width="180"><template #default="{row}">{{date(row.expires_at)}}</template></el-table-column>
      </template>
    </el-table>
    <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="total, prev, pager, next" @current-change="load" />
    <template v-if="tab==='exchanges'"><h3>门店核销记录</h3><el-table :data="redemptions" border><el-table-column prop="exchange_id" label="兑换ID" /><el-table-column prop="store_id" label="门店" /><el-table-column prop="staff_id" label="员工" /><el-table-column label="核销时间"><template #default="{row}">{{date(row.created_at)}}</template></el-table-column></el-table></template>
    <el-dialog v-model="rewardOpen" title="积分商品" width="600px">
      <el-form label-width="110px"><el-form-item label="名称"><el-input v-model="reward.name" /></el-form-item>
        <el-form-item label="类型"><el-radio-group v-model="reward.kind"><el-radio value="service" label="service">服务权益</el-radio><el-radio value="gift" label="gift">实物礼品</el-radio></el-radio-group></el-form-item>
        <el-form-item label="图片地址"><el-input v-model="reward.image" placeholder="公开HTTPS图片地址" /></el-form-item>
        <el-form-item label="所需积分"><el-input v-model="reward.points" /></el-form-item>
        <el-form-item label="剩余数量"><el-input-number v-model="reward.stock" :min="0" /><span>留空不限</span></el-form-item>
        <el-form-item label="每人限兑"><el-input-number v-model="reward.per_member_limit" :min="0" /><span>留空不限</span></el-form-item>
        <el-form-item label="有效天数"><el-input-number v-model="reward.valid_days" :min="1" :max="3650" /></el-form-item>
        <el-form-item label="适用门店"><el-select v-model="reward.store_ids" multiple><el-option v-for="s in dealerStores" :key="s.store_id" :label="s.name" :value="s.store_id" /></el-select></el-form-item>
        <el-form-item label="使用说明"><el-input v-model="reward.instructions" type="textarea" :rows="4" /></el-form-item><el-form-item label="上架"><el-switch v-model="reward.on_sale" /></el-form-item>
      </el-form><template #footer><el-button @click="rewardOpen=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveReward">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="ruleOpen" title="积分规则" width="680px">
      <p>发布后对新归档订单生效。已归档订单和已得积分不会重算。</p><p>金额按优惠后客户负担金额计分，包含抵扣定金，排除政策补贴；积分向下取整。</p>
      <el-form label-width="120px"><el-form-item label="消费金额（分）"><el-input v-model="rule.denominator" /></el-form-item><el-form-item label="获得积分"><el-input v-model="rule.numerator" /></el-form-item><el-form-item label="参与商品ID（可选）"><el-input v-model="rule.products" type="textarea" placeholder="留空表示所有消费商品均参与；填写后仅限指定商品" /></el-form-item></el-form>
      <el-table :data="rules"><el-table-column prop="numerator" label="积分" /><el-table-column prop="denominator" label="金额（分）" /><el-table-column label="生效时间"><template #default="{row}">{{date(row.effective_at)}}</template></el-table-column></el-table>
      <template #footer><el-button type="primary" :loading="saving" @click="publishRule">发布新版本</el-button></template>
    </el-dialog>
    <el-dialog v-model="adjustOpen" title="人工调整积分" width="500px"><el-form label-width="100px"><el-form-item label="会员ID"><el-input v-model="adjust.member_id" /></el-form-item><el-form-item label="积分变化"><el-input v-model="adjust.delta" placeholder="正数增加，负数扣减" /></el-form-item><el-form-item label="原因"><el-input v-model="adjust.reason" type="textarea" /></el-form-item></el-form><template #footer><el-button :loading="saving" type="primary" @click="saveAdjust">确认调整并记录流水</el-button></template></el-dialog>
    <el-dialog v-model="claimOpen" title="订单认领人工核验" width="500px"><p>核对原店购机凭据与客户身份后，允许指定会员领取；不会直接发积分。</p><el-input v-model="claim.order" placeholder="销售订单ID" /><el-input v-model="claim.member_id" placeholder="客户小程序显示的会员ID" /><el-input v-model="claim.reason" placeholder="核验依据与原因" type="textarea" /><template #footer><el-button :loading="saving" type="primary" @click="approveClaim">确认核验</el-button></template></el-dialog>
  </section>
</template>
<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { customerOpsRequest as request } from '../api'
const route=useRoute(), router=useRouter(), tab=computed(()=>route.meta.tab)
const titles={members:'会员管理',points:'积分管理',rewards:'积分商品',exchanges:'兑换核销'}, types={earn:'购机获得',exchange:'兑换扣减',return:'退货冲回',adjustment:'后台调整'}, states={pending:'待使用',redeemed:'已核销',expired:'已失效'}
const options=ref({distributors:[],stores:[]}), dealer=ref(''), rows=ref([]), page=ref(1), total=ref(0), error=ref(''), loading=ref(false), saving=ref(false), memberFilter=ref(''), redemptions=ref([])
const rewardOpen=ref(false), reward=ref({}), ruleOpen=ref(false), rules=ref([]), rule=ref({numerator:'1',denominator:'100',products:''}), adjustOpen=ref(false), adjust=ref({}), claimOpen=ref(false), claim=ref({})
const dealerStores=computed(()=>options.value.stores.filter(s=>s.distributor_id===dealer.value))
const date=v=>v?new Date(v).toLocaleString('zh-CN'):''
async function load(){if(!dealer.value)return;loading.value=true;error.value='';try{const result=await request('get',tab.value==='points'?'/points/ledger':`/${tab.value}`,{distributor_id:dealer.value,page:page.value,member_id:memberFilter.value||undefined});rows.value=result.list;total.value=result.total;if(tab.value==='exchanges')redemptions.value=(await request('get','/redemptions',{distributor_id:dealer.value,page:page.value})).list}catch(e){error.value=e.message}finally{loading.value=false}}
function reload(){page.value=1;return load()}
async function action(fn){saving.value=true;try{await fn();ElMessage.success('操作成功');await load()}catch(e){if(e!=='cancel')ElMessage.error(e.message||'操作失败')}finally{saving.value=false}}
async function editReward(id){try{reward.value=id?await request('get',`/rewards/${id}`):{name:'',kind:'service',image:'',points:'500',stock:null,per_member_limit:null,valid_days:30,instructions:'',on_sale:false,store_ids:[]};rewardOpen.value=true}catch(e){ElMessage.error(e.message)}}
function saveReward(){return action(async()=>{await request(reward.value.id?'patch':'post',reward.value.id?`/rewards/${reward.value.id}`:'/rewards',{...reward.value,distributor_id:dealer.value,stock:reward.value.stock??null,per_member_limit:reward.value.per_member_limit??null});rewardOpen.value=false})}
async function loadRules(){try{rules.value=(await request('get','/point-rules',{distributor_id:dealer.value})).list}catch(e){ElMessage.error(e.message)}}
function publishRule(){return action(async()=>{await ElMessageBox.confirm('新版本将用于后续归档订单，是否发布？','发布积分规则');await request('post','/point-rules',{...rule.value,distributor_id:dealer.value,product_ids:rule.value.products.split(/[,，\s]+/).filter(Boolean)});await loadRules()})}
let adjustKey=''
watch(adjust,()=>{adjustKey=''}, {deep:true})
function saveAdjust(){return action(async()=>{adjustKey ||= crypto.randomUUID();await request('post','/points/adjustments',{...adjust.value,distributor_id:dealer.value},adjustKey);adjustOpen.value=false;adjustKey=''})}
function approveClaim(){return action(async()=>{await request('post',`/claims/${encodeURIComponent(claim.value.order)}/approve`,claim.value);claimOpen.value=false})}
watch(()=>route.fullPath,()=>{memberFilter.value=String(route.query.member||'');if(route.query.dealer)dealer.value=String(route.query.dealer);reload()})
onMounted(async()=>{try{options.value=await request('get','/options');dealer.value=String(route.query.dealer||options.value.distributors[0]?.distributor_id||'');memberFilter.value=String(route.query.member||'');await load()}catch(e){error.value=e.message}})
</script>
<style scoped>
.customer-operations{padding:20px}.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:18px;flex-wrap:wrap}.toolbar h2{margin:0 auto 0 0}.toolbar .el-input{width:240px}.toolbar .el-select{width:200px}.el-pagination{margin:20px 0}.el-dialog .el-input{margin-bottom:8px}.el-form-item span{margin-left:12px;color:#64748b}
</style>
