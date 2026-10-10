// 使用真实 Chromium 和模拟 GM API，验证 DOM、跳转及多标签执行。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '../web-keeper.user.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../demo/index.html'));
const output = path.join(__dirname, '../test-results');
fs.mkdirSync(output, { recursive: true });

async function main() {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/test-slow-response') { setTimeout(() => response.end('done'), 6200); return; }
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, acceptDownloads: true });
    const tabs = new Set();
    await context.exposeBinding('__liveTabs', () => [...tabs]);
    async function newPage(id, options = {}) {
      const page = await context.newPage(); tabs.add(id);
      page.on('pageerror', error => errors.push(error.message));
      page.on('close', () => tabs.delete(id));
      await page.addInitScript(({ id, source, options }) => {
        if (options.noUUID) Object.defineProperty(crypto, 'randomUUID', {value:undefined, configurable:true});
        if (options.blockedSession) Object.defineProperty(window, 'sessionStorage', {get(){throw new DOMException('blocked','SecurityError');},configurable:true});
        if (options.wasDiscarded) Object.defineProperty(document, 'wasDiscarded', {value:true,configurable:true});
        const prefix = '__tm__:';
        const listeners = new Map();
        window.GM_getValue = (key, fallback) => { const raw = localStorage.getItem(prefix + key); return raw === null ? fallback : JSON.parse(raw); };
        window.GM_setValue = (key, value) => { const old = GM_getValue(key, null); localStorage.setItem(prefix + key, JSON.stringify(value)); for (const callback of listeners.get(key) || []) callback(key, old, value, false); };
        window.GM_addValueChangeListener = (key, callback) => { if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(callback); };
        window.addEventListener('storage', event => { if (!event.key?.startsWith(prefix)) return; const key = event.key.slice(prefix.length); for (const callback of listeners.get(key) || []) callback(key, JSON.parse(event.oldValue || 'null'), JSON.parse(event.newValue || 'null'), true); });
        window.GM_getTab = callback => callback(GM_getValue('tab:' + id, {}));
        window.GM_saveTab = (tab, callback) => { GM_setValue('tab:' + id, tab); callback?.(); };
        window.GM_getTabs = callback => window.__liveTabs().then(ids => callback(Object.fromEntries(ids.map(i => [i, GM_getValue('tab:' + i, {})]))));
        window.__tmMenus = {};
        window.GM_registerMenuCommand = (name, callback) => { window.__tmMenus[name] = callback; };
        document.addEventListener('DOMContentLoaded', () => {
          if (options.pageCSS) {const style=document.createElement('style');style.textContent=options.pageCSS;document.head.appendChild(style);}
          (0, eval)(source);
        });
      }, { id, source, options });
      await page.goto(origin);
      await page.locator('#web-keeper-root').waitFor();
      return page;
    }
    const boot = await newPage('boot', {noUUID:true,pageCSS:'div{display:none!important;opacity:0!important;pointer-events:none!important}'});
    await boot.locator('#launcher').click();
    assert.ok(await boot.locator('#panel').isVisible());
    await boot.getByRole('button',{name:'＋ 保活任务',exact:true}).click();
    assert.ok(await boot.locator('[data-field="name"]').isVisible());
    await boot.evaluate(() => document.querySelector('#web-keeper-root').remove());
    await boot.evaluate(() => window.__tmMenus['打开网页定时助手']());
    assert.ok(await boot.locator('#panel').isVisible());
    await boot.screenshot({path:path.join(output,'launcher-recovery.png')});
    await boot.close();
    const blocked = await newPage('blocked',{blockedSession:true});
    await blocked.locator('#launcher').click();
    assert.ok(await blocked.locator('#panel').isVisible());
    assert.ok((await blocked.locator('#notice').textContent()).includes('会话存储'));
    await blocked.close();
    console.log('PASS HTTP ID 兼容、页面样式隔离、菜单恢复和存储受限时打开入口');

    // 指引只能记录用户确认；模拟生命周期通知并实际暂停页面执行，验证调度延迟。
    const environmentPage = await newPage('environment');
    const environmentKey = 'web-keeper:v1:' + origin;
    await environmentPage.evaluate(() => window.__tmMenus['运行环境与设置指引']());
    assert.ok(await environmentPage.locator('#panel').isVisible());
    assert.ok((await environmentPage.locator('#panel main').textContent()).includes('不能读取或修改'));
    assert.ok((await environmentPage.locator('[data-environment="delays"]').textContent()).includes('不代表设置正确'));
    assert.equal(await environmentPage.locator('#guide-site').inputValue(),origin);
    await environmentPage.evaluate(() => Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.__guideCopied=value;}},configurable:true}));
    await environmentPage.getByRole('button',{name:'复制本站地址',exact:true}).click();
    assert.equal(await environmentPage.evaluate(()=>window.__guideCopied),origin);
    await environmentPage.evaluate(() => {navigator.clipboard.writeText=async()=>{throw new DOMException('Denied','NotAllowedError');};});
    await environmentPage.getByRole('button',{name:'复制 Edge 设置地址',exact:true}).click();
    await environmentPage.waitForFunction(()=>document.querySelector('#web-keeper-root').shadowRoot.querySelector('#notice').textContent.includes('Ctrl+C'));
    await environmentPage.waitForTimeout(700);
    assert.ok(await environmentPage.locator('#guide-edge').evaluate(field=>field.selectionStart===0&&field.selectionEnd===field.value.length),'复制被拒绝后地址应保持选中');
    await environmentPage.locator('[data-environment-check="edge"]').check();
    await environmentPage.waitForFunction(key=>!!GM_getValue(key).environmentAcknowledged?.edge,environmentKey);
    await environmentPage.locator('[data-environment-check="system"]').check();
    await environmentPage.waitForFunction(key=>!!GM_getValue(key).environmentAcknowledged?.system,environmentKey);
    await environmentPage.reload();
    await environmentPage.evaluate(() => window.__tmMenus['运行环境与设置指引']());
    assert.ok(await environmentPage.locator('[data-environment-check="edge"]').isChecked());
    assert.ok(await environmentPage.locator('[data-environment-check="system"]').isChecked());
    assert.ok((await environmentPage.locator('#panel main').textContent()).includes('非自动验证'));
    await environmentPage.locator('[data-environment-check="edge"]').uncheck();
    await environmentPage.waitForFunction(key=>!GM_getValue(key).environmentAcknowledged.edge,environmentKey);
    await environmentPage.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
    assert.ok((await environmentPage.locator('[data-environment="visibility"]').textContent()).includes('后台'));
    assert.ok((await environmentPage.locator('[data-environment="visibility"]').textContent()).includes('无法区分'));
    await environmentPage.evaluate(()=>{Object.defineProperty(document,'hidden',{value:false,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await environmentPage.locator('[data-environment="visibility"]').textContent(),'页面可见');
    await environmentPage.evaluate(()=>{Object.defineProperty(navigator,'onLine',{value:false,configurable:true});window.dispatchEvent(new Event('offline'));});
    assert.ok((await environmentPage.locator('[data-environment="network"]').textContent()).includes('离线'));
    assert.ok(await environmentPage.locator('#environment-warning').isVisible());
    await environmentPage.evaluate(()=>{Object.defineProperty(navigator,'onLine',{value:true,configurable:true});window.dispatchEvent(new Event('online'));});
    assert.ok((await environmentPage.locator('[data-environment="network"]').textContent()).includes('未验证网站连接'));
    await environmentPage.evaluate(key=>{const state=GM_getValue(key);state.enabled=true;GM_setValue(key,state);},environmentKey);
    await environmentPage.getByRole('button',{name:'重新开始观察',exact:true}).click();
    await environmentPage.evaluate(()=>{
      document.dispatchEvent(new Event('freeze'));
      const request=new XMLHttpRequest();request.open('GET','/test-slow-response',false);request.send();
      document.dispatchEvent(new Event('resume'));
    });
    await environmentPage.waitForFunction(()=>{const root=document.querySelector('#web-keeper-root').shadowRoot;return parseFloat(root.querySelector('[data-environment="interval"]').textContent)>=5&&root.querySelector('[data-environment="lifecycle"]').textContent.includes('最近恢复');},null,{timeout:5000,polling:100});
    assert.ok((await environmentPage.locator('[data-environment="delays"]').textContent()).includes('次，最近一次'));
    assert.ok((await environmentPage.locator('[data-environment="lifecycle"]').textContent()).startsWith('1 次冻结'));
    await environmentPage.waitForFunction(key=>GM_getValue(key).logs.some(l=>l.level==='warning'&&l.message.includes('两次调度检查间隔')&&l.message.includes('系统时钟变化')),environmentKey);
    assert.equal(await environmentPage.evaluate(key=>GM_getValue(key).tasks.length,environmentKey),0);
    await environmentPage.screenshot({path:path.join(output,'environment-guide.png')});
    await environmentPage.getByRole('button',{name:'重新开始观察',exact:true}).click();
    assert.ok((await environmentPage.locator('[data-environment="delays"]').textContent()).includes('尚未观测到'));
    await environmentPage.evaluate(key=>{const state=GM_getValue(key);state.enabled=false;GM_setValue(key,state);},environmentKey);
    await environmentPage.close();
    const discarded = await newPage('discarded',{wasDiscarded:true});
    await discarded.evaluate(() => window.__tmMenus['运行环境与设置指引']());
    assert.ok((await discarded.locator('[data-environment="discarded"]').textContent()).includes('此前被丢弃'));
    assert.ok(await discarded.locator('#environment-warning').isVisible());
    await discarded.evaluate(key=>GM_setValue(key,{version:1,enabled:false,tasks:[],samples:[],logs:[]}),environmentKey);
    await discarded.close();
    assert.deepEqual(errors, [], '运行环境检查不能产生未处理异常');
    console.log('PASS 设置指引、手动确认持久化、复制失败回退、离线提示、生命周期事件及实际暂停后的延迟记录');
    if (process.env.BROWSER_TEST_SCOPE === 'environment') { console.log('ENVIRONMENT BROWSER TESTS PASSED'); return; }

    // 自定义下拉框在 mousedown 打开；下拉 DOM 中同时有隐藏的同名旧菜单。
    const custom = await newPage('custom-select');
    const customKey='web-keeper:v1:'+origin;
    const customButton=name=>custom.getByRole('button',{name,exact:true});
    await custom.locator('#launcher').click();
    await customButton('＋ 采集任务').click();
    await custom.locator('[data-field="name"]').fill('甘肃激活量');
    await customButton('录制操作').click();
    await custom.locator('#province-select').click();
    await custom.locator('#province-popup').getByText('甘肃',{exact:true}).click();
    await customButton('采集值').click();await custom.locator('#gansu-activation').click();
    await customButton('完成录制').click();
    const recorded=await custom.evaluate(()=>JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).draft);
    assert.equal(recorded.steps.length,3);
    assert.equal(recorded.steps[0].target.selectors[0],'#province-select');
    assert.equal(recorded.steps[1].target.selectors[0],'.ant-select-dropdown-menu-item');
    assert.equal(recorded.steps[1].target.option.text,'甘肃');
    assert.equal(await custom.locator('[data-step-field="optionText"]').inputValue(),'甘肃');
    await customButton('保存任务').click();
    const customTask=await custom.evaluate(key=>GM_getValue(key).tasks[0],customKey);
    async function customRun() {
      await custom.goto(origin);
      await custom.evaluate(()=>{window.demoProvinceOrder=['甘肃','青海','河北'];window.demoActiveProvince='河北';});
      await custom.evaluate(()=>window.__tmMenus['打开网页定时助手']());
      await custom.locator(`[data-action="run-task"][data-id="${customTask.id}"]`).click();
    }
    async function customFinished(success=true) {
      await custom.waitForFunction(({key,id,success})=>{
        const message=GM_getValue(key).tasks.find(t=>t.id===id).lastMessage||'';
        return (success?message==='成功':message.startsWith('失败：'))&&!JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run;
      },{key:customKey,id:customTask.id,success},{timeout:20000});
    }
    await customRun();await customFinished();
    assert.equal(await custom.locator('#province-selected').textContent(),'甘肃');
    assert.equal(await custom.evaluate(key=>GM_getValue(key).samples[0].value,customKey),'588');
    await custom.evaluate(({key,id})=>{const state=GM_getValue(key);const task=state.tasks.find(t=>t.id===id);task.lastMessage='';task.steps[1].target={selectors:['li.ant-select-dropdown-menu-item.ant-select-dropdown-menu-item-active'],text:'甘肃',tag:'li'};GM_setValue(key,state);},{key:customKey,id:customTask.id});
    await customRun();await customFinished();
    assert.equal(await custom.locator('#province-selected').textContent(),'甘肃');
    assert.equal(await custom.evaluate(key=>GM_getValue(key).samples.length,customKey),2);
    assert.deepEqual(await custom.evaluate(()=>JSON.parse(localStorage.getItem('demo-province-selections'))),['甘肃','甘肃','甘肃']);
    console.log('PASS 甘肃选项录制、mousedown 打开、列表重排、隐藏重复菜单和旧 active 选择器兼容');

    // 可见菜单存在同名选项时，必须停止，不能选错省份或继续采集。
    await custom.goto(origin);
    await custom.evaluate(({key,id})=>{window.demoDuplicateProvince=true;const state=GM_getValue(key);const task=state.tasks.find(t=>t.id===id);task.lastMessage='';task.timeoutMs=1000;GM_setValue(key,state);},{key:customKey,id:customTask.id});
    await custom.evaluate(()=>window.__tmMenus['打开网页定时助手']());
    await custom.locator(`[data-action="run-task"][data-id="${customTask.id}"]`).click();
    await customFinished(false);
    assert.equal(await custom.evaluate(key=>GM_getValue(key).samples.length,customKey),2);
    assert.ok((await custom.evaluate(key=>GM_getValue(key).tasks[0].lastMessage,customKey)).includes('下拉选项「甘肃」'));
    assert.equal(await custom.locator('#province-selected').textContent(),'请选择省份');
    console.log('PASS 下拉选项不唯一时阻止后续采集');
    await custom.evaluate(key=>{GM_setValue(key,{version:1,enabled:false,tasks:[],samples:[],logs:[]});GM_setValue(key+':owner','');},customKey);
    await custom.close();

    const diagnostic=await newPage('diagnostic');
    await diagnostic.evaluate(()=>{
      window.demoDiagnosticClicks=0;
      const section=document.createElement('section');section.id='diagnostic-fixture';
      section.innerHTML='<button class="diagnostic-target" hidden>隐藏副本</button><button id="diagnostic-visible" class="diagnostic-target">可见入口</button><button class="diagnostic-hidden" hidden>只有隐藏</button><button class="diagnostic-ambiguous">相同入口一</button><button class="diagnostic-ambiguous">相同入口二</button><button id="diagnostic-disabled" disabled>禁用入口</button><div id="rc_select_192345" class="ant-select" role="combobox" aria-label="诊断省份入口" tabindex="0">请选择省份</div>';
      section.querySelector('#diagnostic-visible').onclick=()=>window.demoDiagnosticClicks++;
      document.body.appendChild(section);
    });
    await diagnostic.locator('#launcher').click();
    assert.ok((await diagnostic.locator('.brand').textContent()).includes('v1.0.5'));
    await diagnostic.getByRole('button',{name:'＋ 保活任务',exact:true}).click();
    await diagnostic.getByRole('button',{name:'点选点击元素',exact:true}).click();
    await diagnostic.locator('#diagnostic-visible').click();
    await diagnostic.locator('[data-field="timeout"]').fill('1');
    await diagnostic.locator('[data-field="returnDelay"]').fill('0');
    async function checkDiagnostic(selector) {
      await diagnostic.locator('[data-step="0"][data-step-field="selector"]').fill(selector);
      assert.equal(await diagnostic.locator('[data-inspection="0"]').count(),0,'修改步骤后不能保留旧定位诊断');
      await diagnostic.locator('[data-action="inspect-step"][data-index="0"]').click();
      return await diagnostic.locator('[data-inspection="0"]').inputValue();
    }
    let report=await checkDiagnostic('.diagnostic-target');
    assert.ok(report.includes('全部 2，可见 1'));
    assert.ok(report.includes('结果：已定位，可执行'));
    assert.equal(await diagnostic.evaluate(()=>window.demoDiagnosticClicks),0,'检查定位不能点击页面');
    await diagnostic.getByRole('button',{name:'试运行草稿',exact:true}).click();
    await diagnostic.waitForFunction(()=>window.demoDiagnosticClicks===1&&!JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run,null,{timeout:15000});
    await diagnostic.evaluate(()=>window.__tmMenus['打开网页定时助手']());
    report=await checkDiagnostic('#does-not-exist');assert.ok(report.includes('匹配 0 个元素'));
    report=await checkDiagnostic('.diagnostic-hidden');assert.ok(report.includes('全部隐藏'));
    report=await checkDiagnostic('.diagnostic-ambiguous');assert.ok(report.includes('2 个可见元素'));
    report=await checkDiagnostic('#diagnostic-disabled');assert.ok(report.includes('元素被禁用'));
    report=await checkDiagnostic('.diagnostic-ambiguous');
    await diagnostic.getByRole('button',{name:'试运行草稿',exact:true}).click();
    await diagnostic.waitForFunction(key=>GM_getValue(key).logs.some(l=>l.message.includes('第 1 步定位诊断')&&l.message.includes('2 个可见元素'))&&!JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run,customKey,{timeout:15000});
    assert.equal(await diagnostic.evaluate(()=>window.demoDiagnosticClicks),1);
    await diagnostic.evaluate(()=>window.__tmMenus['打开网页定时助手']());
    await diagnostic.locator('[data-action="repick"][data-index="0"]').click();
    await diagnostic.locator('#rc_select_192345').click();
    assert.equal(await diagnostic.locator('[data-inspection="0"]').count(),0);
    const stable=await diagnostic.locator('[data-step="0"][data-step-field="selector"]').inputValue();
    assert.ok(stable.includes('aria-label'));
    assert.ok(!stable.includes('rc_select_'));
    await diagnostic.screenshot({path:path.join(output,'locator-diagnostics.png')});
    await diagnostic.evaluate(key=>{GM_setValue(key,{version:1,enabled:false,tasks:[],samples:[],logs:[]});GM_setValue(key+':owner','');},customKey);
    await diagnostic.close();
    console.log('PASS 唯一可见元素、0/多个/隐藏/禁用诊断、无副作用检查、错误日志和动态 ID 录制');
    if (process.env.BROWSER_TEST_SCOPE === 'diagnostics') { console.log('DIAGNOSTIC BROWSER TESTS PASSED'); return; }

    const page = await newPage('a');
    await page.getByRole('button',{name:'打开定时助手',exact:true}).waitFor();
    await page.getByRole('button',{name:'打开定时助手',exact:true}).click();
    assert.ok(await page.locator('#panel').isVisible());
    const dbKey = 'web-keeper:v1:' + origin;
    const state = () => page.evaluate(key => GM_getValue(key), dbKey);
    const session = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('web-keeper:v1:session')));
    const button = (name) => page.getByRole('button', { name, exact: true });
    async function open() { if (await page.locator('#launcher').isVisible()) await page.locator('#launcher').click(); }
    async function taskList() { await open(); await button('任务').click(); }
    async function finished(taskId) {
      await page.waitForFunction(({ key, taskId }) => GM_getValue(key)?.tasks.find(t => t.id === taskId)?.lastMessage === '成功' && !JSON.parse(sessionStorage.getItem('web-keeper:v1:session') || '{}').run, { key: dbKey, taskId }, { timeout: 30000 });
    }
    async function runTask(taskId) { await taskList(); await page.locator(`[data-action="run-task"][data-id="${taskId}"]`).click(); }

    // 点选时不触发页面操作；执行后同站跳转，并按自定义时间返回。
    await open();
    assert.equal((await state())?.enabled || false, false);
    await button('＋ 保活任务').click();
    await page.locator('[data-field="name"]').fill('链接保活');
    await page.locator('[data-field="returnDelay"]').fill('1');
    await button('点选点击元素').click();
    await page.locator('#activity-link').click();
    assert.equal(page.url(), origin + '/');
    assert.equal(await page.evaluate(() => localStorage.getItem('demo-visits')), null);
    await button('保存任务').click();
    const keep = (await state()).tasks[0];
    assert.equal(keep.steps[0].target.selectors[0], '#activity-link');
    await runTask(keep.id);
    await page.waitForURL(origin + '/activity');
    const arrived = Date.now();
    await page.waitForURL(origin + '/');
    assert.ok(Date.now() - arrived >= 900, '应等待至少配置的返回时长');
    await finished(keep.id);
    assert.equal(await page.evaluate(() => localStorage.getItem('demo-visits')), '1');
    console.log('PASS 点选防误触、跨页面执行和定时返回');

    // 录制跨页面点击、输入、复选框、异步查询和两个采集值。
    await taskList(); await button('＋ 采集任务').click(); await button('录制操作').click();
    await page.locator('#report-link').click(); await page.waitForURL(origin + '/reports');
    assert.equal((await session()).recording, true);
    await page.locator('#filter').fill('2026-10-09');
    await page.locator('#channel').selectOption('app');
    await page.locator('#include-test').check();
    await page.locator('#secret').fill('never-record-me');
    await page.locator('#apply').click();
    await page.waitForFunction(() => document.querySelector('#query-status').textContent.startsWith('完成'));
    await button('采集值').click(); await page.locator('#activation').click();
    await button('采集值').click(); await page.locator('#users').click();
    await button('完成录制').click();
    await page.screenshot({ path: path.join(output, 'editor.png') });
    const draft = (await session()).draft;
    assert.equal(draft.steps.filter(s => s.type === 'collect').length, 2);
    assert.equal(draft.steps.filter(s => s.type === 'input').length, 3, JSON.stringify(draft.steps));
    assert.ok(!JSON.stringify(draft).includes('never-record-me'));
    const values = draft.steps.map((s,i) => s.type === 'collect' ? i : -1).filter(i => i >= 0);
    await page.locator(`[data-step="${values[0]}"][data-step-field="name"]`).fill('激活量');
    await page.locator(`[data-step="${values[0]}"][data-step-field="pattern"]`).fill('([0-9,]+)');
    await page.locator(`[data-step="${values[1]}"][data-step-field="name"]`).fill('新增用户');
    await button('保存任务').click();
    const collect = (await state()).tasks.find(t => t.kind === 'collect');
    assert.equal(collect.entryUrl, origin + '/');
    await page.goto(origin);
    await runTask(collect.id); await finished(collect.id);
    const samples = (await state()).samples.filter(s => s.taskId === collect.id);
    assert.deepEqual(samples.map(s => [s.name, s.value]), [['激活量', '430'], ['新增用户', '32']]);
    assert.equal(page.url(), origin + '/');
    assert.equal(new Set(samples.map(s => s.id)).size, 2);
    console.log('PASS 录制点击、输入、同站跳转、多值采集、密码排除和进度恢复');

    // Shadow DOM 选取、属性读取和 CSV 下载。
    await taskList(); await button('＋ 采集任务').click();
    await page.locator('[data-field="name"]').fill('Shadow 数值');
    await button('添加采集值').click(); await page.locator('#shadow-demo').locator('#shadow-value').click();
    const shadowDraft = (await session()).draft;
    assert.deepEqual(shadowDraft.steps[0].target.selectors, ['#shadow-demo', '#shadow-value']);
    await button('保存任务').click();
    const shadowTask = (await state()).tasks.find(t => t.name === 'Shadow 数值');
    await runTask(shadowTask.id); await finished(shadowTask.id);
    assert.equal((await state()).samples.at(-1).value, '256');
    await button('采集历史').click();
    const downloadEvent = page.waitForEvent('download'); await button('导出全部 CSV').click();
    const download = await downloadEvent; const csvPath = path.join(output, 'history.csv'); await download.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8'); assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"激活量","430"'));
    await page.screenshot({ path: path.join(output, 'history.png') });
    console.log('PASS Shadow DOM 采集和 CSV 导出');

    // 两个标签页同一到期任务只运行一次；随后第二个任务按队列执行。
    const other = await newPage('b');
    await page.evaluate(key => {
      const state = GM_getValue(key); state.enabled = true;
      state.tasks.forEach(t => { t.enabled = t.kind === 'collect'; t.nextRun = t.name === 'Shadow 数值' ? Date.now()-2000 : t.kind === 'collect' ? Date.now()-1000 : Date.now()+600000; t.schedule = { type: 'interval', everyMs: 3600000 }; });
      GM_setValue(key, state);
    }, dbKey);
    await page.waitForFunction(key => GM_getValue(key).samples.length === 6, dbKey, { timeout: 30000 });
    await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('web-keeper:v1:session')).run, null, { timeout: 30000 });
    assert.equal((await state()).samples.length, 6);
    assert.equal(await other.evaluate(() => JSON.parse(sessionStorage.getItem('web-keeper:v1:session') || '{}').run || null), null);
    await page.evaluate(key => { const state = GM_getValue(key); state.enabled=false; GM_setValue(key,state); }, dbKey);
    await other.close();
    console.log('PASS 到期调度、任务排队和多标签防重复');

    // 修改为找不到的元素，失败应被记录，并停止本轮执行。
    await page.evaluate(({ key, id }) => { const state = GM_getValue(key); const task=state.tasks.find(t=>t.id===id); task.steps[0].target.selectors=['#missing-element']; task.timeoutMs=1000; task.lastMessage=''; GM_setValue(key,state); }, { key: dbKey, id: shadowTask.id });
    await runTask(shadowTask.id);
    await page.waitForFunction(({ key, id }) => GM_getValue(key).tasks.find(t=>t.id===id).lastMessage.startsWith('失败：'), { key: dbKey, id: shadowTask.id }, { timeout: 15000 });
    assert.equal((await state()).samples.length, 6);
    console.log('PASS 元素超时、失败日志和停止执行');

    // 同一文档里的 history 后退，以及 target=_blank 链接的当前标签回放。
    async function createKeep(name, selector, mode) {
      await taskList(); await button('＋ 保活任务').click();
      await page.locator('[data-field="name"]').fill(name);
      await page.locator('[data-field="returnDelay"]').fill('0');
      await page.locator('[data-field="returnMode"]').selectOption(mode);
      await button('点选点击元素').click(); await page.locator(selector).click();
      await button('保存任务').click();
      return (await state()).tasks.find(t => t.name === name);
    }
    const spa = await createKeep('SPA 返回', '#spa-link', 'history');
    await runTask(spa.id); await page.waitForURL(origin + '/#detail'); await finished(spa.id);
    assert.equal(page.url(), origin + '/');
    const blank = await createKeep('新标签链接', '#blank-link', 'url');
    await runTask(blank.id); await page.waitForURL(origin + '/activity'); await finished(blank.id);
    assert.equal(page.url(), origin + '/'); assert.equal(context.pages().length, 1);
    console.log('PASS SPA 历史返回、地址返回和新标签链接回放');

    // 慢速 SPA 中旧元素仍存在时，要等待新页面再读取，不能采到旧的 0。
    const slowId = 'slow-task';
    await page.evaluate(({ key, origin, id }) => {
      const state=GM_getValue(key);
      state.tasks.push({id,name:'慢速页面采集',kind:'collect',enabled:false,entryUrl:origin+'/',schedule:{type:'interval',everyMs:3600000},nextRun:Date.now()+3600000,returnMode:'history',returnDelayMs:0,timeoutMs:4000,steps:[
        {id:'slow-click',type:'click',target:{selectors:['#slow-spa']},pageUrl:origin+'/',delayMs:0},
        {id:'slow-read',type:'collect',name:'切换后值',source:'auto',target:{selectors:['#slow-value']},pageUrl:origin+'/slow',delayMs:0}
      ]}); GM_setValue(key,state);
    }, {key:dbKey,origin,id:slowId});
    await runTask(slowId); await finished(slowId);
    assert.equal((await state()).samples.at(-1).value, '999');
    console.log('PASS 慢速 SPA 等待目标页面，避免读取旧值');

    // 配置导入按 ID 合并；错误的网站配置不能写入。
    await taskList();
    const exportEvent = page.waitForEvent('download'); await button('导出配置').click();
    const configDownload = await exportEvent; const configFile=path.join(output,'config.json'); await configDownload.saveAs(configFile);
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    const totalTasks=config.tasks.length;
    assert.equal(config.origin,origin);
    const invalid={...config,origin:'https://wrong.test'};
    let chooserEvent=page.waitForEvent('filechooser'); await button('导入配置').click();
    await (await chooserEvent).setFiles({name:'wrong.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});
    await page.waitForFunction(() => document.querySelector('#web-keeper-root').shadowRoot.querySelector('#notice').textContent.startsWith('导入失败：'));
    assert.equal((await state()).tasks.length,totalTasks);
    const restore={...config,tasks:config.tasks.filter(t=>t.id===shadowTask.id)};
    restore.tasks[0].steps[0].target.selectors=['#shadow-demo','#shadow-value'];
    restore.tasks[0].entryUrl='/'; // 导入时规范化相对地址。
    chooserEvent=page.waitForEvent('filechooser'); await button('导入配置').click();
    await (await chooserEvent).setFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(restore))});
    await page.waitForFunction(({key,id,origin}) => GM_getValue(key).tasks.find(t=>t.id===id).entryUrl===origin+'/' && GM_getValue(key).tasks.find(t=>t.id===id).steps[0].target.selectors[0]==='#shadow-demo', {key:dbKey,id:shadowTask.id,origin});
    assert.equal((await state()).tasks.length,totalTasks);
    console.log('PASS 配置导出、同站导入校验、合并和相对地址规范化');

    assert.deepEqual(errors, [], '页面不能产生未处理异常');
    await taskList(); await page.screenshot({ path: path.join(output, 'tasks.png') });

    // 执行标签关闭后，仍打开的同站标签可以接管下次到期任务。
    const successor=await newPage('c');
    await page.evaluate(({key,id}) => {const state=GM_getValue(key);state.enabled=true;state.tasks.forEach(t=>{t.enabled=t.id===id;t.nextRun=Date.now()+800;});GM_setValue(key,state);}, {key:dbKey,id:shadowTask.id});
    await page.close();
    await successor.waitForFunction(({key,id}) => GM_getValue(key).tasks.find(t=>t.id===id).lastMessage==='成功' && GM_getValue(key).samples.length===8, {key:dbKey,id:shadowTask.id}, {timeout:20000});
    assert.equal(await successor.evaluate(key=>GM_getValue(key).samples.length,dbKey),8);
    console.log('PASS 执行标签关闭后的同站任务接管');
    console.log('ALL BROWSER TESTS PASSED');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
