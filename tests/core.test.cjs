const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../web-keeper.user.js');
const origin = 'https://example.test';
test('普通 HTTP 页面没有 randomUUID 时仍可生成任务和标签 ID', () => {
  const cryptoApi = { getRandomValues: values => { values.fill(42); return values; } };
  assert.match(core.createId(cryptoApi), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(core.createId({randomUUID:()=> 'native-id'}), 'native-id');
  const ids = Array.from({length:100}, () => core.createId(null));
  assert.equal(new Set(ids).size, 100);
});
function validTask() {
  return { id: 'test', name: '激活量', kind: 'collect', enabled: true, entryUrl: origin + '/reports', schedule: { type: 'interval', everyMs: 5000 }, returnMode: 'history', returnDelayMs: 1000, timeoutMs: 15000, steps: [{ id: 'value', type: 'collect', name: '激活量', source: 'auto', target: { selectors: ['#count'] }, delayMs: 0 }] };
}
test('间隔从当前时间计算，不重放错过的每次任务', () => {
  assert.equal(core.nextRun({ type: 'interval', everyMs: 60000 }, 100000), 160000);
});
test('每日计划在本地日历上跨日，包含月底和年底', () => {
  for (const [start, expected] of [
    [new Date(2026, 9, 9, 8, 0), new Date(2026, 9, 9, 9, 0)],
    [new Date(2026, 9, 9, 9, 0), new Date(2026, 9, 10, 9, 0)],
    [new Date(2026, 9, 31, 23, 59), new Date(2026, 10, 1, 9, 0)],
    [new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 9, 0)]
  ]) assert.equal(core.nextRun({ type: 'daily', time: '09:00' }, +start), +expected);
});
test('提取保留 0、支持完整匹配和第一个捕获组', () => {
  assert.equal(core.extract('  0  ', ''), '0');
  assert.equal(core.extract('激活量：1,234 人', '([0-9,]+)'), '1,234');
  assert.equal(core.extract('今日 123', '\\d+'), '123');
  assert.throws(() => core.extract('尚无数据', '\\d+'), /没有匹配/);
  assert.throws(() => core.extract('123', '('));
});
test('CSV 保留逗号、换行、引号，包含 UTF-8 BOM 并处理公式前缀', () => {
  assert.equal(core.csvCell('1,"2"\n3'), '"1,""2""\n3"');
  for (const value of ['=HYPERLINK("evil")', '+1+1', '-2+3', '@SUM(A1)', '  =1', '\t=1']) assert.ok(core.csvCell(value).startsWith('"\''));
  const csv = core.toCSV([{ time: 0, taskName: '每日数据', name: '激活量', value: '0', raw: '0', url: origin }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('1970-01-01T00:00:00.000Z'));
  assert.ok(csv.includes('"0"'));
});
test('只允许 HTTP(S) 同站地址', () => {
  assert.ok(core.sameOrigin('/reports', origin));
  assert.ok(core.sameOrigin(origin + '/a?b=1', origin));
  for (const value of ['https://evil.test', 'http://example.test', 'javascript:alert(1)', 'data:text/html,hi', 'https://example.test:444']) assert.equal(core.sameOrigin(value, origin), false);
});
test('步骤页面比较忽略查询参数和末尾斜杠，但不能跳过页面和 hash', () => {
  assert.ok(core.sameRoute('/reports?date=1', '/reports/?date=2', origin));
  assert.equal(core.sameRoute('/reports', '/login', origin), false);
  assert.equal(core.sameRoute('/reports#all', '/reports#app', origin), false);
  assert.equal(core.sameRoute(origin + '/reports', 'https://evil.test/reports', origin), false);
});
test('组件前缀中的 active / selected / open 状态不作为稳定类名', () => {
  for (const name of ['active','ant-select-dropdown-menu-item-active','ant-select-item-option-selected','ant-select-open','el-select-dropdown__item-is-disabled']) assert.ok(core.isTransientClass(name),name);
  for (const name of ['ant-select-dropdown-menu-item','ant-select-selection','ant-select-item-option-content','province-selector']) assert.equal(core.isTransientClass(name),false,name);
});
test('录制不能把 rc_select 等运行时 ID 当成稳定 ID', () => {
  for (const id of ['rc_select_0','rc_select_1700023000','rc-select-17',':r3:']) assert.ok(core.isDynamicId(id),id);
  for (const id of ['province-select','activation','report']) assert.equal(core.isDynamicId(id),false,id);
});
test('旧下拉定位按录制文字匹配，不按高亮项或列表顺序匹配', () => {
  const target={selectors:['li.ant-select-dropdown-menu-item.ant-select-dropdown-menu-item-active'],text:' 甘肃\n ',tag:'li'};
  assert.equal(core.optionSelector(target),'.ant-select-dropdown-menu-item');
  assert.equal(core.optionText(target),'甘肃');
  assert.equal(core.optionSelector({selectors:['#popup > ul > li.ant-select-dropdown-menu-item:nth-of-type(2)'],text:'甘肃'}),'.ant-select-dropdown-menu-item');
  const current={selectors:['#popup .ant-select-dropdown-menu-item'],option:{text:'甘肃'},text:'旧名称'};
  assert.equal(core.optionSelector(current),'#popup .ant-select-dropdown-menu-item');
  assert.equal(core.optionText(current),'甘肃');
});
test('旧任务没有记录选项文字时必须提示补充，不能点击任意选项', () => {
  const task=validTask();task.kind='keep';task.steps=[{type:'click',delayMs:0,target:{selectors:['li.ant-select-dropdown-menu-item.ant-select-dropdown-menu-item-active']}}];
  assert.throws(()=>core.validateTask(task,origin),/缺少选项文字/);
  task.steps[0].target.text='甘肃';
  assert.doesNotThrow(()=>core.validateTask(task,origin));
});
test('有效的每日、间隔和多步骤任务可以通过校验', () => {
  assert.equal(core.validateTask(validTask(), origin).name, '激活量');
  const task = validTask(); task.schedule = { type: 'daily', time: '23:59' };
  task.steps.unshift({ type: 'wait', delayMs: 1000 }, { type: 'input', target: { selectors: ['#channel'] }, value: ['a', 'b'], delayMs: 0 });
  assert.doesNotThrow(() => core.validateTask(task, origin));
});
test('非法计划、跨站、缺少值、无效选择器和超长等待被拒绝', () => {
  const changes = [
    task => { task.schedule.everyMs = 0; },
    task => { task.schedule.everyMs = NaN; },
    task => { task.schedule = { type: 'daily', time: '24:00' }; },
    task => { task.entryUrl = 'https://evil.test'; },
    task => { task.returnDelayMs = -1; },
    task => { task.timeoutMs = 0; },
    task => { task.steps = []; },
    task => { task.steps[0].source = 'eval'; },
    task => { task.steps[0].pattern = '['; },
    task => { task.steps[0].target.selectors = ['']; },
    task => { task.steps[0].source = 'attribute'; },
    task => { task.steps[0].delayMs = Infinity; },
    task => { task.steps[0].type = 'click'; }
  ];
  for (const change of changes) { const task = validTask(); change(task); assert.throws(() => core.validateTask(task, origin)); }
  assert.throws(() => core.validateTask(validTask(), origin, () => { throw new Error('invalid'); }), /CSS/);
});
