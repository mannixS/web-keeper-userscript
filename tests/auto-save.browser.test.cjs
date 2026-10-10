// 使用真实原生文件句柄、IndexedDB 和 Web Locks；文件选择器返回测试用 OPFS 文件。
// OPFS 不会弹出系统文件选择框，权限失效和占用通过 API 失败注入验证。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const core = require('../web-keeper.user.js');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '../web-keeper.user.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../demo/index.html'));
const output = path.join(__dirname, '../test-results');
fs.mkdirSync(output, { recursive: true });

async function main() {
  const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const key = 'web-keeper:v1:' + origin;
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const context = await browser.newContext({viewport:{width:1280,height:960}});
    const errors = [], live = new Set();
    await context.exposeBinding('__liveAutoTabs', () => [...live]);
    async function newPage(id, options = {}) {
      const page = await context.newPage(); live.add(id);
      page.on('close', () => live.delete(id)); page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({source,id,options}) => {
        const prefix='__tm__:'; const listeners=new Map();
        window.GM_getValue=(key,fallback)=>{const raw=localStorage.getItem(prefix+key);return raw===null?fallback:JSON.parse(raw);};
        window.GM_setValue=(key,value)=>{const old=GM_getValue(key,null);localStorage.setItem(prefix+key,JSON.stringify(value));for(const callback of listeners.get(key)||[])callback(key,old,value,false);};
        window.GM_addValueChangeListener=(key,callback)=>{if(!listeners.has(key))listeners.set(key,[]);listeners.get(key).push(callback);};
        window.addEventListener('storage',event=>{if(!event.key?.startsWith(prefix))return;const key=event.key.slice(prefix.length);for(const callback of listeners.get(key)||[])callback(key,JSON.parse(event.oldValue||'null'),JSON.parse(event.newValue||'null'),true);});
        window.GM_getTab=callback=>callback(GM_getValue('tab:'+id,{}));
        window.GM_saveTab=tab=>GM_setValue('tab:'+id,tab);
        window.GM_getTabs=callback=>window.__liveAutoTabs().then(ids=>callback(Object.fromEntries(ids.map(value=>[value,GM_getValue('tab:'+value,{})]))));
        window.__tmMenus={};window.GM_registerMenuCommand=(name,callback)=>{window.__tmMenus[name]=callback;};
        const originalQuery=FileSystemFileHandle.prototype.queryPermission;
        FileSystemFileHandle.prototype.queryPermission=function(options){return window.__denyWrites?Promise.resolve('denied'):originalQuery.call(this,options);};
        FileSystemFileHandle.prototype.requestPermission=function(){window.__denyWrites=false;return Promise.resolve('granted');};
        const originalCreate=FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable=async function(options){if(window.__writeFail)throw new DOMException('Busy','NoModificationAllowedError');return originalCreate.call(this,options);};
        window.showSaveFilePicker=options.unsupported?undefined:async()=>{
          if(window.__cancelPicker)throw new DOMException('Cancel','AbortError');
          return (await navigator.storage.getDirectory()).getFileHandle(window.__pickName||'automatic-collection.csv',{create:true});
        };
        document.addEventListener('DOMContentLoaded',()=>{const value=document.createElement('span');value.id='auto-count';value.textContent='17';document.body.appendChild(value);(0,eval)(source);});
      },{source,id,options});
      await page.goto(origin); await page.locator('#web-keeper-root').waitFor();
      await page.evaluate(()=>window.__tmMenus['打开网页定时助手']());
      await page.getByRole('button',{name:'采集历史',exact:true}).click();
      return page;
    }
    const page = await newPage('auto-a');
    const seed = id => ({id,time:0,taskName:'历史记录',name:'激活量',value:'1,"2"\n3',raw:'旧记录',url:origin});
    const state = () => page.evaluate(key=>GM_getValue(key),key);
    const disk = (target=page,name='automatic-collection.csv') => target.evaluate(async name=>(await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).text(),name);
    const rows = async () => core.parseCSV(await disk());
    const addSamples = async records => page.evaluate(({key,records})=>{const state=GM_getValue(key);state.samples.push(...records);GM_setValue(key,state);},{key,records});
    async function waitSaved(...ids) {
      await page.waitForFunction(key=>!!GM_getValue(key).fileSave?.lastCheckedAt,key);
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        const savedIds=new Set((await rows()).slice(1).map(row=>row[0]));
        if(ids.every(id=>savedIds.has(id))&&!(await state()).fileSave.lastError)return;
        await page.waitForTimeout(50);
      }
      assert.fail('文件未完成保存：'+ids.join(',')+'；'+JSON.stringify((await state()).fileSave));
    }
    await page.evaluate(({key,seed})=>GM_setValue(key,{version:1,enabled:false,tasks:[],samples:[seed],logs:[]}),{key,seed:seed('seed:0')});
    await page.getByRole('button',{name:'选择 CSV 文件并启用',exact:true}).click();
    await waitSaved('seed:0');
    assert.equal((await rows()).length,2);
    assert.equal((await rows())[1][4],'1,"2"\n3');
    const chosenId=(await state()).fileSave.id;
    await page.reload();await page.evaluate(()=>window.__tmMenus['打开网页定时助手']());
    await page.getByRole('button',{name:'采集历史',exact:true}).click();
    await page.getByRole('button',{name:'立即同步文件',exact:true}).click();
    assert.equal((await state()).fileSave.id,chosenId);
    assert.equal((await rows()).length,2,'刷新后不能重复追加已保存记录');
    console.log('PASS 原生文件写入、CSV 转义、IndexedDB 恢复和重复记录过滤');

    await page.evaluate(({key,origin})=>{
      const state=GM_getValue(key);state.tasks.push({id:'actual-collector',name:'自动保存采集测试',kind:'collect',enabled:false,entryUrl:origin+'/',schedule:{type:'interval',everyMs:60000},returnMode:'none',returnDelayMs:0,timeoutMs:1000,steps:[{id:'value',type:'collect',name:'激活量',source:'text',pattern:'',attribute:'',delayMs:0,target:{selectors:['#auto-count']}},{id:'jump',type:'click',delayMs:0,target:{selectors:['#activity-link']}}]});GM_setValue(key,state);
    },{key,origin});
    await page.getByRole('button',{name:'任务',exact:true}).click();
    await page.locator('[data-action="run-task"][data-id="actual-collector"]').click();
    await page.waitForURL(origin+'/activity');
    assert.ok((await rows()).some(row=>row[4]==='17'),'下一步整页跳转前必须完成采集文件写入');
    await page.waitForFunction(key=>GM_getValue(key).tasks[0].lastMessage==='成功',key);
    await page.evaluate(()=>window.__tmMenus['打开网页定时助手']());
    await page.evaluate(key=>{const state=GM_getValue(key);state.tasks[0].entryUrl=location.href;state.tasks[0].steps=state.tasks[0].steps.slice(0,1);state.tasks[0].lastMessage='';GM_setValue(key,state);window.__denyWrites=true;document.querySelector('#auto-count').textContent='29';},key);
    const beforeDenied=await disk();
    await page.locator('[data-action="run-task"][data-id="actual-collector"]').click();
    await page.waitForFunction(key=>GM_getValue(key).tasks[0].lastMessage==='成功'&&GM_getValue(key).fileSave.lastError.includes('权限'),key);
    assert.equal(await disk(),beforeDenied,'未授权时不得修改文件');
    assert.equal((await state()).samples.at(-1).value,'29','文件失败不能丢失采集记录');
    await page.getByRole('button',{name:'采集历史',exact:true}).click();
    await page.getByRole('button',{name:'重新授权并重试',exact:true}).click();
    await waitSaved((await state()).samples.at(-1).id);
    assert.ok((await rows()).some(row=>row[4]==='29'));
    assert.equal((await state()).fileSave.lastError,'');
    console.log('PASS 实际采集后写入、跨页面执行、权限失效保留数据和重新授权补写');

    await page.evaluate(()=>{window.__writeFail=true;});
    const beforeOccupied=await disk(); await addSamples([seed('seed:occupied')]);
    await page.waitForFunction(key=>GM_getValue(key).fileSave.lastError.includes('占用'),key);
    assert.equal(await disk(),beforeOccupied);
    await page.evaluate(()=>{window.__writeFail=false;});
    await page.getByRole('button',{name:'立即同步文件',exact:true}).click();
    await waitSaved('seed:occupied');
    assert.ok((await rows()).some(row=>row[0]==='seed:occupied'));
    const peer = await newPage('auto-b');
    await addSamples(Array.from({length:8},(_,index)=>seed('concurrent:'+index)));
    await Promise.all([page.getByRole('button',{name:'立即同步文件',exact:true}).click(),peer.getByRole('button',{name:'立即同步文件',exact:true}).click()]);
    await waitSaved(...Array.from({length:8},(_,index)=>'concurrent:'+index));
    const allIds=(await rows()).slice(1).map(row=>row[0]);
    assert.equal(new Set(allIds).size,allIds.length);
    assert.equal(allIds.filter(id=>id.startsWith('concurrent:')).length,8);
    await peer.close();
    await page.getByRole('button',{name:'停止自动保存',exact:true}).click();
    const beforePaused=await disk();await addSamples([seed('pending:paused')]);await page.waitForTimeout(1100);
    assert.equal(await disk(),beforePaused);
    await page.getByRole('button',{name:'重新授权并启用',exact:true}).click();
    await waitSaved('pending:paused');
    assert.ok((await rows()).some(row=>row[0]==='pending:paused'));
    console.log('PASS 写入失败后补写、多标签并发去重及停止/恢复自动保存');

    await page.evaluate(async()=>{const handle=await(await navigator.storage.getDirectory()).getFileHandle('unrelated.csv',{create:true});const writer=await handle.createWritable();await writer.write('KEEP ORIGINAL');await writer.close();window.__pickName='unrelated.csv';});
    const currentId=(await state()).fileSave.id;
    await page.getByRole('button',{name:'更换保存文件',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#web-keeper-root').shadowRoot.querySelector('#notice').textContent.includes('此文件不是自动保存格式'));
    assert.equal((await state()).fileSave.id,currentId);
    assert.equal(await disk(page,'unrelated.csv'),'KEEP ORIGINAL');
    await page.evaluate(()=>{window.__cancelPicker=true;});
    await page.getByRole('button',{name:'更换保存文件',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#web-keeper-root').shadowRoot.querySelector('#notice').textContent.includes('已取消文件选择'));
    assert.equal((await state()).fileSave.id,currentId);
    const valid=await disk();
    await page.evaluate(async()=>{const handle=await(await navigator.storage.getDirectory()).getFileHandle('automatic-collection.csv');const writer=await handle.createWritable();await writer.write('"BROKEN');await writer.close();});
    await addSamples([seed('corrupt-check:0')]);
    await page.waitForFunction(key=>GM_getValue(key).fileSave.lastError.includes('不完整'),key);
    assert.equal(await disk(),'"BROKEN','失败时不得覆盖不完整的原文件');
    await page.evaluate(async valid=>{const handle=await(await navigator.storage.getDirectory()).getFileHandle('automatic-collection.csv');const writer=await handle.createWritable();await writer.write(valid);await writer.close();},valid);
    await page.getByRole('button',{name:'立即同步文件',exact:true}).click();
    await waitSaved('corrupt-check:0');
    assert.ok((await rows()).some(row=>row[0]==='corrupt-check:0'));
    await page.locator('#panel').evaluate(panel=>{panel.scrollTop=0;});
    await page.screenshot({path:path.join(output,'auto-save.png')});
    fs.writeFileSync(path.join(output,'automatic-collection.csv'),await disk());
    await page.getByRole('button',{name:'停止自动保存',exact:true}).click();
    const unsupported=await newPage('unsupported',{unsupported:true});
    assert.ok(await unsupported.getByRole('button',{name:'更换保存文件',exact:true}).isDisabled());
    assert.ok((await unsupported.locator('#panel main').textContent()).includes('当前浏览器未提供'));
    assert.ok(await unsupported.getByRole('button',{name:'导出全部 CSV',exact:true}).isEnabled());
    await unsupported.close();
    assert.deepEqual(errors,[]);
    console.log('PASS 不相关文件和取消选择保护、损坏文件保护、修复补写及不支持 API 时手动导出');
    console.log('ALL AUTO-SAVE BROWSER TESTS PASSED');
  } finally { if(browser)await browser.close();await new Promise(resolve=>server.close(resolve)); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
