/* ============================================================================
   统一进化的无渲染模拟（todo3 §10 阶段 D 收尾 / §11.3）
   只加载 tune / core / build-synergy / evolution-pool / evolution-director，
   其余一律桩掉 —— 这里验证的是节奏与概率，不是渲染。

   跑法：node testsim_evo.js [局数]
   ========================================================================== */
const fs = require('fs'), vm = require('vm'), path = require('path');
const DIR = path.join(__dirname, 'js');
const RUNS = parseInt(process.argv[2], 10) || 10000;

/* ---------------- 最小桩 ---------------- */
const ctx = {
  console: console, Math: Math, JSON: JSON, Object: Object, Array: Array,
  Set: Set, Map: Map, Date: Date, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
  location: { search: '' }, performance: { now: () => 0 },
  URLSearchParams: URLSearchParams,
  window: {}, document: { getElementById: () => null, querySelector: () => null },
  addEventListener: () => {}
};
ctx.global = ctx;
vm.createContext(ctx);

const load = f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });

/* THREE 只用到 Vector3 的极少数方法 */
vm.runInContext(`
  class V3 {
    constructor(x,y,z){this.x=x||0;this.y=y||0;this.z=z||0;}
    set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}
    copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;}
    clone(){return new V3(this.x,this.y,this.z);}
    normalize(){const l=Math.hypot(this.x,this.y,this.z)||1;this.x/=l;this.y/=l;this.z/=l;return this;}
    setY(y){this.y=y;return this;}
  }
  var THREE = { Vector3: V3 };
`, ctx);

load('tune.js');
load('core.js');

/* 战斗层与渲染层的桩：只保留统一进化真正会碰到的入口 */
vm.runInContext(`
  var MODE = { city: true, vertMove: true, vertEnemy: true, mapEvents: true, evolution: true };
  var CITY = { enabled: true, layerOf: () => 'street', regionAt: () => null, links: [], byId: {} };
  var NAV = { enabled: false, invalidate(){}, camp:{stage:0} };
  var MAPEV = { executing: false };
  var MOVE = { pose: { state: 'ground', grounded: true }, st: {}, stats: { linkUse:{} } };
  var R = { setGunOrgan(){}, ring(){}, puff(){}, zones:{get:()=>({mesh:{position:{set(){},copy(){}},scale:{setScalar(){}},material:{color:{setHex(){}},opacity:0},visible:false},rim:{position:{copy(){}},scale:{setScalar(){}},material:{color:{setHex(){}},opacity:0},visible:false}})} };
  /* Audio2 直接用 core.js 的真身：ready=false，所有方法自然是空操作 */
  var WEAPON = { on(){}, setOrgan(){}, pose:{ads:0}, climb:0 };
  var V3g = new THREE.Vector3();

  var G = {
    time: 0, phase: 'play', paused:false, over:false,
    bus: new Bus(), player: { level: 1, pos: new THREE.Vector3(), maxHp:120, hp:120, gun:{} },
    mods: {}, mutations: [], mutationSet: {}, variantPool: [],
    enemies: { live: [] }, xp: [], hazards: [], pendings: [],
    stats: {}, derived: {}, conductCounter: 0, overclock: 0,
    xpRate: 0, xpFrame: 0, tutorialQueue: [],
    airdrop: null, bossAlive: null, bossSpawnAt: -999,
    shakeAdd(){}, dmgScale(){return 1;},
    ui: { toast(){}, hint(){}, hideCards(){}, mutationSlots(){}, showEvolution(q,c,i,pick){ G._pending = {q:q,cards:c,pick:pick}; }, flashHeal(){} }
  };
  function lvl(id){ return G.mods[id]||0; }
  function hasMut(id){ return !!G.mutationSet[id]; }
  function recompute(){
    var d = { damage:12, pierce:0, mutRadius:1, mutDamage:1, bulletScale:1, magazine:30,
              moveSpeed:6.2, dashCooldown:2.1, maxDepth:2, infiniteMag:false };
    if (typeof SYN !== 'undefined' && SYN.build) SYN.applyDerived(d);
    G.derived = d; return d;
  }
  function emitBuildChanged(){}
  function modAvailable(m){
    if ((G.mods[m.id]||0) >= m.max) return false;
    if (m.req && G.mutations.length < m.req) return false;
    return true;
  }
  function pickChainTarget(){ return null; }
  function spawnBullet(){ return null; }
  function areaDamage(){ }
  function fmtTime(s){ return String(Math.round(s)); }
`, ctx);

load('build-synergy.js');
load('horde-evolution.js');
load('map-build.js');
load('evolution-pool.js');
load('evolution-director.js');

/* tune.js / core.js 里的 TUNE、RNG 等都是 const —— 在 vm 里，顶层 const 不会挂到
   contextified object 上。所以在同一个上下文里跑一小段桥接脚本，把它们用 var 导出来。 */
vm.runInContext(`
  var __x = { RNG: RNG, TUNE: TUNE, SYN: SYN, EVO: EVO, EVOPOOL: EVOPOOL, HORDE: HORDE,
              MAPBUILD: MAPBUILD, G: G, recompute: recompute,
              BASE_IDS: BASE_IDS, COMBO_MAP: COMBO_MAP, comboKey: comboKey };
`, ctx);
const C = ctx.__x;

/* ---------------- 一局模拟 ---------------- */
/* 经验收入模型：随时间自然增长，乘以 build 强度。
   强度跨度 ×0.25～×8 —— 和 README 里那次经验曲线校准用的是同一个跨度，
   目的一样：证明节奏不是只服务某一种吞吐。 */
function runOnce(seed, strength) {
  C.RNG.init(seed);
  C.G.time = 0; C.G.phase = 'play';
  C.G.mods = {}; C.G.mutations = []; C.G.mutationSet = {}; C.G.tutorialQueue = [];
  C.G.player.level = 1;
  C.G.xpRate = C.TUNE.PACING.bootstrapXp / C.TUNE.PACING.firstLevelAt;
  C.G._pending = null;
  C.SYN.init(); C.HORDE.init(); C.MAPBUILD.init();
  C.EVOPOOL.init(); C.EVO.init();
  C.recompute();

  const dt = 1 / 12;                       // 12Hz 足够，节奏判定不依赖帧率
  const tau = C.TUNE.PACING.rateHalfLife / Math.LN2;
  const rec = { qualities: [], times: [], picks: [], bad: [] };

  while (C.G.time < C.TUNE.RUN_SECONDS) {
    C.G.time += dt;
    /* 收入：0 秒约 0.8 xp/s，12 分钟约 9 xp/s，再乘 build 强度 */
    /* build 强度随时间分化：开局大家都是同一把枪，差距是进化累积出来的。
       开局就按 8 倍算会把首次进化的时间判据变成一个假问题。 */
    const grown = 1 + (strength - 1) * Math.min(1, C.G.time / 240);
    const income = (0.8 + (C.G.time / 720) * 8.2) * grown * dt;
    C.EVO.addProgress(income);
    const inst = income / dt;
    C.G.xpRate += (inst - C.G.xpRate) * (1 - Math.exp(-dt / tau));

    C.EVO.update(dt);

    if (C.G._pending) {
      const p = C.G._pending; C.G._pending = null;
      /* --- 候选合法性检查（§11.3） --- */
      const cards = p.cards;
      if (cards.length !== 3) rec.bad.push('n=' + cards.length + '@' + Math.round(C.G.time));
      const ids = {};
      cards.forEach(c => {
        if (c.quality !== p.q) rec.bad.push('mixq:' + c.id + '!=' + p.q);
        if (ids[c.id]) rec.bad.push('dup:' + c.id);
        ids[c.id] = 1;
        if (!c.requires(C.SYN.build)) rec.bad.push('req:' + c.id);
      });
      rec.qualities.push(p.q);
      rec.times.push(C.G.time);
      /* 随机选一张，模拟不同玩家取向 */
      const pick = cards[C.RNG.mods.int(cards.length)];
      rec.picks.push(pick.id);
      p.pick(pick.id);
    }
  }
  rec.build = C.SYN.build;
  rec.log = C.EVO.log;
  return rec;
}

/* ---------------- 汇总 ---------------- */
function pct(n, d) { return (100 * n / Math.max(1, d)).toFixed(1) + '%'; }

console.log('统一进化模拟 —— ' + RUNS + ' 局\n');

const agg = {
  counts: [], first: [], intervals: [], q: { common: 0, rare: 0, epic: 0, legend: 0 },
  total: 0, runsWithLegend: 0, runsWithEpic: 0, afterCutoff: 0, bad: [],
  minGapViolation: 0, in14to16: 0, bandQ: {}, streakViolation: 0, pity730Violation: 0,
  reverseSuppression: 0
};
const strengths = [0.25, 0.5, 1, 1, 1, 2, 4, 8];

for (let i = 0; i < RUNS; i++) {
  const strength = strengths[i % strengths.length];
  const r = runOnce(1000 + i, strength);
  const n = r.qualities.length;
  agg.counts.push(n);
  agg.total += n;
  if (n >= 14 && n <= 16) agg.in14to16++;
  if (r.times.length) agg.first.push(r.times[0]);
  for (let k = 1; k < r.times.length; k++) {
    const gap = r.times[k] - r.times[k - 1];
    agg.intervals.push(gap);
    if (gap < C.TUNE.EVOLUTION.hardFloor - 0.2) agg.minGapViolation++;
  }
  r.times.forEach(t => { if (t >= C.TUNE.EVOLUTION.cutoff + 0.5) agg.afterCutoff++; });
  r.qualities.forEach((q, k) => {
    agg.q[q]++;
    const t = r.times[k];
    const band = t < 180 ? '0-3' : t < 480 ? '3-8' : '8-10.5';
    (agg.bandQ[band] || (agg.bandQ[band] = { common: 0, rare: 0, epic: 0, legend: 0, n: 0 }));
    agg.bandQ[band][q]++; agg.bandQ[band].n++;
  });
  if (r.qualities.indexOf('legend') >= 0) agg.runsWithLegend++;
  if (r.qualities.indexOf('epic') >= 0 || r.qualities.indexOf('legend') >= 0) agg.runsWithEpic++;

  /* §7.4 保底一：连续 3 次普通后，下一次不得再是普通 */
  let streak = 0;
  r.qualities.forEach(q => {
    if (streak >= C.TUNE.PITY.commonStreak && q === 'common') agg.streakViolation++;
    streak = q === 'common' ? streak + 1 : 0;
  });
  /* §7.4 保底二：7:30 之后的第一次进化必须已经有史诗或传奇 */
  let seenHigh = false, checked = false;
  for (let k = 0; k < r.qualities.length; k++) {
    if (r.qualities[k] === 'epic' || r.qualities[k] === 'legend') seenHigh = true;
    if (!checked && r.times[k] >= C.TUNE.PITY.epicByTime) {
      checked = true;
      if (!seenHigh) agg.pity730Violation++;
    }
  }
  /* 无反向压制：抽到高品质后，下一次高品质率不应低于整体 */
  for (let k = 0; k + 1 < r.qualities.length; k++) {
    if (r.qualities[k] === 'epic' || r.qualities[k] === 'legend') {
      agg.reverseSuppression += (r.qualities[k + 1] === 'epic' || r.qualities[k + 1] === 'legend') ? 1 : 0;
      agg._afterHigh = (agg._afterHigh || 0) + 1;
    }
  }
  if (r.bad.length && agg.bad.length < 12) agg.bad = agg.bad.concat(r.bad.slice(0, 4));
}

const avg = a => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const counts = agg.counts.slice().sort((a, b) => a - b);

console.log('【节奏】§4.2');
console.log('  单局次数  平均 ' + avg(agg.counts).toFixed(2) +
  '  中位 ' + counts[Math.floor(counts.length / 2)] +
  '  范围 ' + counts[0] + '~' + counts[counts.length - 1]);
console.log('  落在 14~16 的比例  ' + pct(agg.in14to16, RUNS));
console.log('  第一次出现  平均 ' + avg(agg.first).toFixed(1) + 's  (目标 22~30s)');
console.log('  常态间隔    平均 ' + avg(agg.intervals).toFixed(1) + 's  (目标 32~50s)');
console.log('  违反 25 秒硬下限  ' + agg.minGapViolation + ' 次');
console.log('  10:30 之后仍弹出  ' + agg.afterCutoff + ' 次');

console.log('\n【品质分布】§7.3   （' + agg.total + ' 次进化）');
['common', 'rare', 'epic', 'legend'].forEach(q =>
  console.log('  ' + C.TUNE.RARITY.name[q] + '  ' + pct(agg.q[q], agg.total) +
    '   平均每局 ' + (agg.q[q] / RUNS).toFixed(2) + ' 次'));
console.log('  出现过传奇的对局  ' + pct(agg.runsWithLegend, RUNS) + '  (目标 25%~35%)');
console.log('  出现过史诗以上的对局  ' + pct(agg.runsWithEpic, RUNS));

console.log('\n【分时段品质】');
Object.keys(agg.bandQ).forEach(b => {
  const x = agg.bandQ[b];
  console.log('  ' + b + '分  普通 ' + pct(x.common, x.n) + '  稀有 ' + pct(x.rare, x.n) +
    '  史诗 ' + pct(x.epic, x.n) + '  传奇 ' + pct(x.legend, x.n));
});

console.log('\n【保底】§7.4');
console.log('  三连普通后仍出普通  ' + agg.streakViolation + ' 次  (必须为 0)');
console.log('  7:30 后仍未见史诗    ' + agg.pity730Violation + ' 局  (必须为 0)');
const highRate = (agg.q.epic + agg.q.legend) / agg.total;
const afterHighRate = agg.reverseSuppression / Math.max(1, agg._afterHigh || 1);
console.log('  整体高品质率 ' + pct(agg.q.epic + agg.q.legend, agg.total) +
  ' vs 高品质之后 ' + (afterHighRate * 100).toFixed(1) + '%  (后者不得系统性更低)');

console.log('\n【候选合法性】§7.5');
console.log('  违规条目  ' + (agg.bad.length ? agg.bad.join(' ') : '0（品质一致、无重复、前置全部满足）'));

/* 任意两种基础变异都必须有自动反应、稀有连接与史诗融合 */
let missing = [];
for (let i = 0; i < C.BASE_IDS.length; i++)
  for (let j = i + 1; j < C.BASE_IDS.length; j++) {
    const k = C.comboKey(C.BASE_IDS[i], C.BASE_IDS[j]);
    if (!C.COMBO_MAP[k]) missing.push(k + ':combo');
    if (!C.EVOPOOL.byId['link_' + k]) missing.push(k + ':link');
    if (!C.EVOPOOL.byId['fusion_' + k]) missing.push(k + ':fusion');
  }
console.log('\n【化学反应覆盖】§7.7');
console.log('  15 组组合 / 连接 / 融合  ' + (missing.length ? '缺 ' + missing.join(' ') : '全部齐备'));

const fail =
  agg.minGapViolation + agg.afterCutoff + agg.streakViolation +
  agg.pity730Violation + agg.bad.length + missing.length;
console.log('\n结论：' + (fail === 0 ? 'PASS（硬性判据全部通过）' : 'FAIL（' + fail + ' 项硬性判据未通过）'));
process.exit(fail === 0 ? 0 : 1);
