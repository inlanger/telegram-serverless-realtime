import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright-core';
import { createRealtimeService } from '../tgcloud/lib/realtime.js';

const root=fileURLToPath(new URL('../web', import.meta.url));
const output=new URL('../test-results/', import.meta.url);
await mkdir(output, {recursive:true});
const sql=new DatabaseSync(':memory:');
sql.exec(`CREATE TABLE realtime_rooms (room TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,guest_id INTEGER,expires_at INTEGER NOT NULL);
CREATE TABLE realtime_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,room TEXT NOT NULL,client_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);`);
const db={async run(q,p={}){return {rowsAffected:sql.prepare(q).run(p).changes};},async get(q,p={}){return sql.prepare(q).get(p);},async all(q,p={}){return sql.prepare(q).all(p);}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const service=createRealtimeService({db,wait:delay});
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://local').pathname;
  const file=path==='/' ? '/index.html' : path;
  if(!/^\/[a-z-]+\.(?:html|css|js)$/.test(file)){res.writeHead(404);return res.end();}
  try{const body=file==='/config.js' ? "export const BOT_USERNAME = 'realtime_test_bot';" : await readFile(root+file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);}
  catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const engine=process.env.LAB_BROWSER || 'chromium';
const browser=await (engine==='webkit' ? webkit.launch({headless:true}) : chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true,args:['--no-sandbox']}));
const failures=[],pages=[],report={engine,route:'Browser + SQLite with mocked Telegram bridge; NOT native Telegram or deployed signed /api',checks:[]};
const active=new Set();
async function page(uid,viewport){
  const context=await browser.newContext({viewport});
  await context.exposeBinding('labRpc',async(_,input)=>{
    const pending=service(input,{initData:{user:{id:uid}}});active.add(pending);
    try{return {result:await pending};}catch(e){return {error:{message:e.message,type:'ENDPOINT_ERROR',parameters:{code:e.code}}};}
    finally{active.delete(pending);}
  });
  await context.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',body:`
    window.Telegram={WebApp:{initData:'MOCK_NOT_A_SIGNED_TELEGRAM_SESSION',initDataUnsafe:{},platform:'browser-test',version:'test',ready(){},expand(){},BackButton:{hide(){}},Serverless:{call(name,input,cb){window.labRpc(input).then(r=>cb(r.error,r.result),e=>cb({message:e.message}));}}}};
  `}));
  const p=await context.newPage();p.on('pageerror',e=>failures.push(e.message));pages.push(p);return p;
}
try{
  const a=await page(1,{width:390,height:844});
  await a.goto(origin+'/?tgWebAppStartParam=rt#tgWebAppData=fake');
  await a.locator('#setup').waitFor({state:'visible'});
  assert.equal(new URL(a.url()).hash,'#tgWebAppData=fake');
  report.checks.push('standalone entry preserves launch fragment');
  await a.locator('#create').click();await a.locator('#session').waitFor({state:'visible'});
  const room=new URL(a.url()).searchParams.get('room');assert.match(room,/^[a-f0-9]{32}$/);
  const b=await page(2,{width:844,height:390});await b.goto(origin+'/?tgWebAppStartParam=rt_'+room+'#tgWebAppData=fake');
  await b.locator('#session').waitFor({state:'visible'});
  await a.locator('summary').click();await a.locator('#burst').click();
  await a.waitForFunction(()=>document.querySelector('#counters').textContent.includes('Acknowledged: 10.'),null,{timeout:30000});
  assert.equal(await b.locator('#received').innerText(),'10');report.checks.push('invite start parameter joins room; ten peer events and ten ACK round trips');
  await b.locator('#pause').click();
  for(let i=0;i<3;i++){await a.locator('#send').click();await a.waitForFunction(()=>!document.querySelector('#send').disabled);}
  assert.equal(await b.locator('#received').innerText(),'10');
  await b.locator('#pause').click();
  await a.waitForFunction(()=>document.querySelector('#counters').textContent.includes('Acknowledged: 13.'));
  assert.equal(await b.locator('#received').innerText(),'13');report.checks.push('pause + three events + resume replays all three');
  const before=await b.evaluate(()=>Object.entries(sessionStorage).find(([k])=>k.startsWith('realtime-lab:'))?.[1]);
  await b.reload();await b.locator('#session').waitFor({state:'visible'});
  const after=await b.evaluate(()=>Object.entries(sessionStorage).find(([k])=>k.startsWith('realtime-lab:'))?.[1]);
  assert.equal(JSON.parse(before).clientId,JSON.parse(after).clientId);
  await a.locator('#send').click();
  await a.waitForFunction(()=>document.querySelector('#counters').textContent.includes('Acknowledged: 14.'));
  assert.equal(await b.locator('#received').innerText(),'1');report.checks.push('reload preserves cursor/client and receives only new pulse');
  await a.locator('#mode').selectOption('short');
  await a.locator('#send').click();await a.waitForFunction(()=>document.querySelector('#counters').textContent.includes('Acknowledged: 15.'));
  report.checks.push('short polling mode delivers and acknowledges');
  const outsider=await page(3,{width:390,height:844});await outsider.goto(origin+'/?room='+room);
  await outsider.locator('#error').waitFor({state:'visible'});assert.equal(await outsider.locator('#session').isVisible(),false);
  report.checks.push('third user cannot join full room');
  for(const p of [a,b]){
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await p.screenshot({path:fileURLToPath(new URL(engine+'-'+(p===a?'portrait.png':'landscape.png'),output)),fullPage:true});
  }
  report.checks.push('390px portrait / 844px landscape have no horizontal overflow');
  report.displayedRoundTripMs=await a.locator('#roundtrip').innerText();report.failures=failures;
  assert.deepEqual(failures,[]);
}finally{
  for(const p of pages)if(!p.isClosed())await p.evaluate(()=>{const button=document.querySelector('#pause');if(button?.textContent==='Pause receiving')button.click();}).catch(()=>{});
  await browser.close();server.close();await Promise.allSettled(active);sql.close();
  await writeFile(new URL('browser-results-'+engine+'.json',output),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));
