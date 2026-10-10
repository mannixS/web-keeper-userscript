// 原生 DOM + 模拟每分钟一次的助手检查；不模拟实际 Windows 锁屏或 Edge 冻结。
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(path.join(__dirname,'../web-keeper.user.js'),'utf8');
async function main(){
  const server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<button id="keep">保活按钮</button>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,key='web-keeper:v1:'+origin;
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(source=>{
      const data={},listeners=new Map();
      window.GM_getValue=(key,fallback)=>key in data?JSON.parse(JSON.stringify(data[key])):fallback;
      window.GM_setValue=(key,value)=>{data[key]=JSON.parse(JSON.stringify(value));for(const fn of listeners.get(key)||[])fn();};
      window.GM_addValueChangeListener=(key,fn)=>listeners.set(key,[...(listeners.get(key)||[]),fn]);
      window.GM_getTab=fn=>fn({});window.GM_saveTab=()=>{};window.GM_getTabs=fn=>fn({});
      window.__menus={};window.GM_registerMenuCommand=(name,fn)=>window.__menus[name]=fn;
      window.__now=Date.now();Date.now=()=>window.__now;
      const interval=window.setInterval.bind(window);
      window.setInterval=(fn,delay,...args)=>{if(delay===500){window.__pulse=()=>fn(...args);return -1;}return interval(fn,delay,...args);};
      document.addEventListener('DOMContentLoaded',()=>{window.__clicks=0;document.querySelector('#keep').onclick=()=>window.__clicks++;(0,eval)(source);});
    },source);
    await page.goto(origin);await page.locator('#web-keeper-root').waitFor();
    await page.evaluate(()=>window.__menus['打开网页定时助手']());
    const run=()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run);
    const state=()=>page.evaluate(key=>GM_getValue(key),key);
    const clicks=()=>page.evaluate(()=>window.__clicks);
    const pulse=delta=>page.evaluate(delta=>{window.__now+=delta;window.__pulse();},delta);
    const step=id=>({id,type:'click',delayMs:0,target:{selectors:['#keep']}});
    async function start(id,steps,returnDelayMs=0){
      await page.evaluate(({id,steps,returnDelayMs,key,origin})=>{
        const state=GM_getValue(key,{version:1,enabled:false,tasks:[],samples:[],logs:[]});state.enabled=false;state.tasks=[{id,name:id,kind:'keep',enabled:false,entryUrl:origin+'/',schedule:{type:'interval',everyMs:60000},nextRun:Date.now()+60000,returnMode:'none',returnDelayMs,timeoutMs:1000,steps}];GM_setValue(key,state);
      },{id,steps,returnDelayMs,key,origin});
      await page.locator('[data-action="run-task"][data-id="'+id+'"]').click();
      await page.waitForFunction(id=>JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run?.taskId===id,id);
    }
    async function waitIndex(index){await page.waitForFunction(index=>JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run?.index===index,index);}
    async function waitDone(){await page.waitForFunction(()=>!JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run);}
    await start('每分钟检查',[step('a'),step('b'),step('c')],3000);
    const started=(await run()).started;
    for(let index=1;index<=3;index++){await pulse(60000);await waitIndex(index);assert.equal(await clicks(),index);}
    assert.equal((await run()).phase,'return');
    assert.ok((await run()).readyAt>started+180000,'最后一步后的返回等待不能省略');
    await pulse(60000);await waitDone();assert.equal((await state()).tasks[0].lastMessage,'成功');
    console.log('PASS 每分钟检查仍能按顺序执行三次真实点击，不会只因内部阶段耗时而超时');

    await start('保留等待',[{id:'wait',type:'wait',delayMs:5000},step('after-wait')]);
    const beforeWait=await clicks();await pulse(1000);
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run?.stepIndex===0);
    await pulse(4999);assert.equal((await run()).index,0);assert.equal(await clicks(),beforeWait);
    await pulse(1);await waitIndex(1);await pulse(1);await waitIndex(2);await pulse(1);await waitDone();
    assert.equal(await clicks(),beforeWait+1);
    console.log('PASS 合并内部阶段仍保留配置的等待时间');

    await start('找不到元素',[{...step('missing'),target:{selectors:['#missing']}}]);
    await pulse(60000);await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run?.stepIndex===0);
    const beforeMissing=await clicks();await pulse(60000);await waitDone();
    assert.ok((await state()).tasks[0].lastMessage.includes('匹配 0 个元素'));assert.equal(await clicks(),beforeMissing);
    console.log('PASS 调度余量不会解除元素超时或跳过定位失败');

    await start('长时间暂停',[step('must-not-click')]);
    const beforeSuspend=await clicks();await pulse(15*60000);await waitDone();
    assert.ok((await state()).tasks[0].lastMessage.includes('任务执行超时'));assert.equal(await clicks(),beforeSuspend);
    console.log('PASS 长时间暂停仍停止过期任务，截止时间不会无限后移');
    await page.getByRole('button',{name:'运行环境',exact:true}).click();
    assert.ok((await page.locator('#panel').textContent()).includes('IntensiveWakeUpThrottlingEnabled'));
    assert.equal(await page.locator('#guide-policy').inputValue(),'edge://policy');
    assert.deepEqual(errors,[]);
    console.log('ALL BACKGROUND BROWSER TESTS PASSED');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
