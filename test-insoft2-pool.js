// Offline test for the insoft2 (Insoft "web SMS Server") adapter — stubs axios, self-cleaning.
const axios=require('axios'); const db=require('./db'); const i2=require('./providers/insoft2');
let n=0,f=0;const ok=(c,m)=>{n++;if(!c){f++;console.log('  ✗ '+m);}else console.log('  ✓ '+m);};
let lastGet=null;
function stub(map){
  const qsl=require('querystring');
  axios.get=async(url,cfg)=>{lastGet={url,cfg};
    if(url.includes('/credit/'))return{status:200,data:{response_code:200,body:'success',senderid:'PUSP',current_balance:17612.8}};
    const tok=cfg.params.token;const r=map[tok]||{response_code:200,response:'success',message_count:1,balance_deducted:2.5};
    return{status:200,data:r};};
  axios.post=async(url,body,cfg)=>{const p=qsl.parse(body);lastGet={url,cfg:{params:p}};
    const r=map[p.token]||{response_code:200,response:'success',message_count:1,balance_deducted:2.5};
    return{status:200,data:r};};
}
(async()=>{
  await db.connect();
  const route=await db.Route.create({name:'__insoft2_test__',type:'insoftsms2',api_url:'https://panel.example.com',http_method:'GET',sender_id:'PUSP',provides_dlr:true,config:{key_strategy:'highest'}});
  const rid=route._id;const lean=async()=>db.Route.findById(rid).lean();
  const mk=(t,c)=>db.ProviderKey.create({route_id:rid,token:t,sender_id:'s_'+t,credit_initial:c,credit_remaining:c,status:'active'});
  const get=t=>db.ProviderKey.findOne({route_id:rid,token:t}).lean();
  try{
    stub({});
    console.log('\n1) GET send shape + highest-first + deduct');
    await mk('kA',100);await mk('kB',500);
    let r=await i2.send(await lean(),'+9779801234567','hi');
    ok(r.success,'send ok: '+JSON.stringify(r).slice(0,200));
    ok(lastGet.url.endsWith('/api/sendsms'),'path /api/sendsms');
    ok(lastGet.cfg.params.to==='9801234567'&&lastGet.cfg.params.sender==='s_kB'&&lastGet.cfg.params.message==='hi','fields to/sender/message correct, +977 stripped');
    ok((await get('kB')).credit_remaining===497.5,'kB 500 -> 497.5 (deducted 2.5)');

    console.log('\n2) 402 No Credits -> exhaust + failover');
    await db.ProviderKey.updateMany({route_id:rid},{$set:{status:'disabled'}});
    await db.ProviderKey.updateOne({route_id:rid,token:'kA'},{$set:{status:'active'}});
    await mk('kEmpty',300);
    stub({kEmpty:{response_code:402,response:'No Credits Available'}});
    r=await i2.send(await lean(),'9801234567','hi');
    ok(r.success,'failover succeeded');
    ok((await get('kEmpty')).status==='exhausted','kEmpty exhausted on 402');
    ok((await get('kA')).credit_remaining===97.5,'kA took over 100 -> 97.5');

    console.log('\n3) 401 invalid token -> disable + failover');
    await db.ProviderKey.updateMany({route_id:rid},{$set:{status:'disabled'}});
    await mk('kBad',200);await mk('kGood',150);
    stub({kBad:{response_code:401,response:'Authentication Failed. Invalid Token'}});
    r=await i2.send(await lean(),'9801234567','hi');
    ok(r.success,'failover past bad token');
    ok((await get('kBad')).status==='disabled','kBad disabled on 401');

    console.log('\n4) creditCheck + testConnection (real /credit/ balance)');
    stub({});
    const c=await i2.creditCheck(await lean(),'kGood');
    ok(c.ok&&c.balance===17612.8,'creditCheck -> current_balance 17612.8');
    const tc=await i2.testConnection(await lean());
    ok(tc.success&&tc.rawData.top_key_live_balance===17612.8,'testConnection reports pool + live balance');
  }finally{
    await db.ProviderKey.deleteMany({route_id:rid});await db.Route.deleteOne({_id:rid});
    console.log(`\n${n-f}/${n} passed${f?' — '+f+' FAILED':' ✅'}`);process.exit(f?1:0);
  }
})().catch(e=>{console.error(e);process.exit(1);});
