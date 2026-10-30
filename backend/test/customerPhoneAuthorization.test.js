const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function fixture(member) {
  class Router {
    constructor() { this.entries = []; }
    use(...handlers) { this.entries.push({ handlers }); }
  }
  for (const method of ['get','post','patch','delete','put']) Router.prototype[method] = function(route,...handlers) { this.entries.push({route,handlers}); };
  const S = {fail(status,message) { throw Object.assign(new Error(message),{status}); }};
  let exchanged;
  const M = {Member:{findByPk:async()=>member},Account:{findAll:async()=>[]}};
  const V = {phoneInput:phone=>{if(!/^1\d{10}$/.test(phone))S.fail(400,'Invalid phone');return phone;},transaction:async work=>work({}),lock:()=>({})};
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/modules/customerOps/routes.js'),'utf8'), {
    module, require(name) {
      if(name==='koa-router')return Router;
      if(name==='./models')return M;
      if(name==='./service')return V;
      if(name==='./security')return S;
      if(name==='./wechat')return {phone:async code=>{exchanged=code;if(code!=='valid')S.fail(400,'Invalid code');return '13000000000';}};
      return {};
    }, Map, Date, console
  });
  const entries=module.exports.customer.entries;
  return {entries, exchanged:()=>exchanged, bind:entries.find(e=>e.route==='/member/phone').handlers[0],
    gate:entries[entries.findIndex(e=>e.route==='/member/profile')+1].handlers[0]};
}
test('member business routes have no phone authorization gate',()=>{
 const f=fixture({});
 const profile=f.entries.findIndex(e=>e.route==='/member/profile');
 assert.ok(f.entries.slice(profile+1).every(entry=>Boolean(entry.route)));
 assert.ok(f.entries.some(entry=>entry.route==='/member/bind-order'));
});
test('binding consumes WeChat code and only then persists verified phone',async()=>{
  const member={id:'member',async update(values){Object.assign(this,values);}};
  const f=fixture(member),ctx={state:{member},request:{body:{code:'valid',phone:'13999999999'}}};
  await f.bind(ctx);
  assert.equal(f.exchanged(),'valid');assert.equal(member.phone,'13000000000');assert.ok(member.phone_verified_at);assert.equal(ctx.body.phoneAuthorized,true);
});
test('manual input and conflicting authorized number cannot overwrite member phone',async()=>{
  const member={id:'member',phone:'13999999999',update:async()=>assert.fail('must not write')};
  const f=fixture(member);
  await assert.rejects(f.bind({state:{member},request:{body:{phone:'13000000000'}}}),{status:400});
  await assert.rejects(f.bind({state:{member},request:{body:{code:'valid'}}}),{status:409});
});
