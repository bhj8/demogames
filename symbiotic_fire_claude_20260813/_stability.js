/* ============================================================================
   todo10 §10 阶段 D：多种子 12 分钟自动稳定性 —— 外层驱动

   为什么要一个 node 脚本，而不是在页面里 for 十遍：
   同一个页面里连跑十局会越跑越慢 —— 导演状态、事件总线订阅、对象池这些
   东西跨局残留，第十局的每帧开销是第一局的十几倍（实测三局 68 秒，
   十局跑到 38 分钟还没结束）。与其一个一个去堵那些残留，不如让每一局
   都从真正干净的页面开始 —— 这也更接近玩家实际开一局的样子。

   用法：node _stability.js [种子数，默认 10]
   ========================================================================== */
'use strict';

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111];
const n = Math.min(SEEDS.length, parseInt(process.argv[2], 10) || 10);
/* node _stability.js 10 strong —— 开局就给一套强 Build，验证 todo11 §4
   的第二档（强 Build 22~24 次）。不带这个参数就是普通局那一档。 */
const STRONG = process.argv.indexOf('strong') > 0;
/* node _stability.js 5 move —— 机器人在四个战斗单元之间巡逻。
   站着不动的机器人量不出刷怪问题：全图尸潮都会走到它身上。 */
const MOVING = process.argv.indexOf('move') > 0;
/* node _stability.js 3 move weak4 —— 把机器人输出打成 1/4，模拟菜一点的玩家 */
const WEAK = (process.argv.find(a => /^weak\d+$/.test(a)) || '').replace('weak', '');
const file = 'file://' + path.resolve(__dirname, '_stability.html');

(async () => {
  const browser = await chromium.launch();
  const rows = [];
  let fail = 0;

  for (const seed of SEEDS.slice(0, n)) {
    const page = await browser.newPage();
    const t0 = Date.now();
    await page.goto(file + '?seed=' + seed + (STRONG ? '&strong=1' : '') + (MOVING ? '&move=1' : '') + (WEAK ? '&weak=' + WEAK : ''), { timeout: 0, waitUntil: 'load' });
    try {
      await page.waitForFunction(() => document.title !== 'PENDING', null, { timeout: 600000 });
    } catch (e) {
      console.log('种子 ' + seed + ' 超时');
      fail++; await page.close(); continue;
    }
    const title = await page.title();
    const line = (await page.evaluate(() => document.getElementById('out').innerText)).trim();
    console.log(((Date.now() - t0) / 1000 | 0) + 's  ' + line);
    if (title.indexOf('FAILED') === 0) fail++;
    rows.push(title.replace(/^[A-Z]+>>|<<$/g, '').split('|')[0]);
    await page.close();
  }

  /* §11.4：连续两局不会因为固定配方自然长成同一把枪 */
  const uniq = new Set(rows).size;
  console.log('\n' + rows.length + ' 局里出现 ' + uniq + ' 种不同的分子组合');
  if (uniq < Math.ceil(rows.length * 0.6)) {
    console.log('FAIL 只长出 ' + uniq + ' 种枪 —— 说明还是配方在决定结果（§11.4）');
    fail++;
  }
  console.log(fail ? 'FAILED ' + fail + ' 条' : 'ALLPASS');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
