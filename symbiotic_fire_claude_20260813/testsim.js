/* 无头逻辑校验：只加载 tune/core/combat，桩掉 THREE 与渲染层。
   目标是验证规格里最容易出事的三件事：
     §34 触发链不会无限递归
     §24 三选一生成规则
     §29 12 分钟的等级节奏落在 18–25 次
*/
const fs = require('fs'), vm = require('vm'), path = require('path');
const DIR = require('path').join(__dirname, 'js');

/* ---- 最小 THREE 桩 ---- */
class V3 {
  constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  setY(y) { this.y = y; return this; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  cross(v) { const x = this.y * v.z - this.z * v.y, y = this.z * v.x - this.x * v.z, z = this.x * v.y - this.y * v.x; return this.set(x, y, z); }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  applyAxisAngle(ax, a) { const c = Math.cos(a), s = Math.sin(a); const x = this.x, z = this.z; return this.set(x * c + z * s, this.y, -x * s + z * c); }
}
const NOOP = () => { };
class M4 { compose() { return this; } }
class Q4 { setFromAxisAngle() { return this; } identity() { return this; } setFromUnitVectors() { return this; } }
const THREE = { Vector3: V3, Matrix4: M4, Quaternion: Q4 };

const ctx = { THREE, console, performance: { now: () => Date.now() }, Math, Set, Map, Object, Array, JSON, Number, Float32Array, Uint16Array, Uint32Array, Infinity, setTimeout };
ctx.window = {}; ctx.location = { search: '', reload: NOOP };
ctx.URLSearchParams = class { constructor() { } has() { return false; } get() { return null; } };
ctx.addEventListener = NOOP;
ctx.document = {
  getElementById: () => ({
    style: {}, classList: { add: NOOP, remove: NOOP, toggle: NOOP, contains: () => false },
    appendChild: NOOP, removeChild: NOOP, children: [], innerHTML: '', textContent: '', dataset: {}
  }),
  createElement: () => ({ style: {}, classList: { add: NOOP }, appendChild: NOOP, innerHTML: '' }),
  addEventListener: NOOP, exitPointerLock: NOOP
};
ctx.globalThis = ctx;
vm.createContext(ctx);

const run = f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
run('tune.js'); run('core.js');

/* ---- 渲染层桩 ---- */
let fxCount = 0;
const stubZone = () => ({
  mesh: { position: { set: NOOP, copy: NOOP }, scale: { setScalar: NOOP }, material: { color: { setHex: NOOP } } },
  rim: { position: { copy: NOOP }, scale: { setScalar: NOOP }, material: { color: { setHex: NOOP } } }
});
ctx.R = {
  obstacles: [], arenaHalf: 36,
  rings: { count: 0 }, puffs: { count: 0 }, sparks: { count: 0 }, bolts: { count: 0 },
  zones: { get: stubZone, release: NOOP },
  ring() { fxCount++; }, puff() { fxCount++; }, spark() { fxCount++; }, bolt() { fxCount++; },
  setGunOrgan: NOOP, renderer: { domElement: { requestPointerLock: NOOP, addEventListener: NOOP } }
};
run('combat.js');
run('game.js');

/* top-level const 不会挂到 global 上，显式导出一次 */
const API = vm.runInContext(`({G,MUT,MUTATIONS,MODS,TUNE,RNG,recompute,makeAttack,
  installPlayerMutations,killEnemy,damageEnemy,hasMut,drawModCards,xpNeeded,makeBulletPool})`, ctx);
const { G, MUT, MUTATIONS, MODS, TUNE, RNG, recompute, makeAttack, installPlayerMutations,
  killEnemy, damageEnemy, hasMut } = API;
ctx.drawModCards = API.drawModCards;
ctx.xpNeeded = API.xpNeeded;
ctx.makeBulletPool = API.makeBulletPool;

RNG.init(12345);
G.shake = () => { };
G.ui = { flashHeal() { }, flashAmmo() { } };
G.player = { pos: new V3(), hp: 120, maxHp: 120, gun: { ammo: 30 }, iframe: 0, dashIFrame: 0, yaw: 0 };
G.bullets = ctx.makeBulletPool();
G.enemies = { get: () => ({}), release: () => { }, live: [], count: 0 };

/* ================================================================= 测试 1 */
/* §34 触发链终止性：全变异 + 连锁许可，密集怪堆，单次击杀不得无限递归 */
function makeField(n, spread) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 * 3.3, r = (i / n) * spread;
    arr.push({
      uid: i + 1, pos: new V3(Math.cos(a) * r, 0, Math.sin(a) * r),
      dead: false, hp: 6, maxHp: 30, radius: 0.46, height: 1.75,
      plates: 0, plateMeshes: [], hurtFlash: 0, knock: new V3(),
      face: new V3(0, 0, 1), knockResist: 0
    });
  }
  return arr;
}

MUTATIONS.forEach(m => { G.mutations.push(m.id); G.mutationSet[m.id] = true; });
G.mods.cascade = 1;                       // 连锁许可：深度上限 +1，压力最大
G.mods.catalyst = 2; G.mods.spread = 2;
recompute();
installPlayerMutations();

let maxDepthSeen = 0, killCount = 0, guard = 0;
const origKill = ctx.killEnemy;
G.bus.on('kill', ev => {
  killCount++;
  maxDepthSeen = Math.max(maxDepthSeen, ev.ctx.procDepth);
  if (++guard > 200000) throw new Error('递归未收敛');
}, -100);

const field = makeField(120, 9);
G.hash.clear();
field.forEach(e => G.hash.insert(e, e.pos.x, e.pos.z));

const t0 = Date.now();
/* 打死正中央那只，看链条能扩散多远 */
const seed = field[0];
killEnemy(seed, makeAttack('primary'));
const ms = Date.now() - t0;

const dead = field.filter(e => e.dead).length;
console.log('【测试1 · §34 触发链终止性】');
console.log('  怪堆 120 只密集排布，全 6 变异 + 连锁许可');
console.log('  单次击杀连锁致死 :', dead, '只  (' + ms + 'ms)');
console.log('  最大触发深度     :', maxDepthSeen, '/ 上限', G.derived.maxDepth);
console.log('  爆裂代数上限     :', TUNE.PROC.blastMaxGeneration);
console.log('  结果             :', maxDepthSeen <= G.derived.maxDepth ? '✅ 深度未越界' : '❌ 越界');
console.log('  收敛             :', guard < 200000 ? '✅ 有限步终止' : '❌ 未收敛');

/* ================================================================= 测试 2 */
/* §24 三选一生成规则 */
console.log('\n【测试2 · §24 三选一生成规则】');
G.mods = {}; G.mutations = []; G.mutationSet = {}; recompute();
let violFire = 0, violDup = 0, violReq = 0, violChain = 0;
const N = 4000;
for (let i = 0; i < N; i++) {
  /* 一半样本模拟"已有 2 个共同变异" */
  if (i === N / 2) { G.mutations = ['blast', 'conduct']; G.mutationSet = { blast: 1, conduct: 1 }; }
  const cards = ctx.drawModCards();
  if (!cards) break;
  if (!cards.some(c => c.kind === 'fire')) violFire++;
  if (new Set(cards.map(c => c.id)).size !== cards.length) violDup++;
  cards.forEach(c => { if (c.req && G.mutations.length < c.req) violReq++; });
  if (i >= N / 2 && !cards.some(c => c.kind === 'chain')) violChain++;
}
console.log('  样本               :', N);
console.log('  缺少基础火力卡     :', violFire, violFire === 0 ? '✅' : '❌');
console.log('  同一次出现重复卡   :', violDup, violDup === 0 ? '✅' : '❌');
console.log('  req 未满足却出现   :', violReq, violReq === 0 ? '✅' : '❌');
console.log('  有变异却无协同卡   :', violChain, violChain === 0 ? '✅' : '❌');

/* ================================================================= 测试 3 */
/* §26 变异敌人占比上限 32% */
console.log('\n【测试3 · §26 变种占比】');
[1, 2, 3, 4].forEach(n => {
  const share = Math.min(TUNE.VARIANT.cap, n * TUNE.VARIANT.perMutation);
  console.log('  ' + n + ' 种变异 → ' + Math.round(share * 100) + '%',
    share <= TUNE.VARIANT.cap ? '✅' : '❌');
});

/* ================================================================= 测试 4 */
/* §29 等级节奏：模拟 12 分钟刷怪与击杀，看总升级次数 */
console.log('\n【测试4 · §29 12 分钟等级节奏】');
function simulateRun() {
  let t = 0, acc = 0, xp = 0, level = 1, need = ctx.xpNeeded ? ctx.xpNeeded(1) : 0;
  const X = TUNE.XP;
  const xpNeed = L => Math.round(X.curveBase + X.curveCoef * Math.pow(L, X.curveExp));
  need = xpNeed(1);
  const marks = {}; let firstLevelAt = null; const gaps = []; let lastLevelT = 0;
  const dt = 0.1;
  while (t < TUNE.RUN_SECONDS) {
    t += dt;
    const rate = TUNE.SPAWN.baseRate + TUNE.SPAWN.rateCoef *
      Math.pow(Math.min(1, t / TUNE.RUN_SECONDS), TUNE.SPAWN.rateExp);
    acc += rate * dt;
    while (acc >= 1) {
      acc -= 1;
      /* 平均每只怪的经验：210s 前只有普通丧尸(1)；之后按权重混入 heavy(5)/spitter(3) */
      xp += t > 210 ? (1 * 1 + 0.16 * 5 + 0.20 * 3) / 1.36 : 1.0;
      while (xp >= need) {
        xp -= need; level++;
        gaps.push(t - lastLevelT); lastLevelT = t;
        if (firstLevelAt === null) firstLevelAt = t;
        need = xpNeed(level);
      }
    }
    [180, 360, 540].forEach(m => { if (!marks[m] && t >= m) marks[m] = level; });
  }
  return { level, firstLevelAt, marks, gaps };
}
const sim = simulateRun();
const early = sim.gaps.slice(0, 5), late = sim.gaps.slice(-5);
const avg = a => (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1);
console.log('  首次升级       :', sim.firstLevelAt.toFixed(1) + 's',
  sim.firstLevelAt <= 25 ? '✅ ≤25s' : '❌ 超过 25s');
console.log('  3:00 / 6:00 / 9:00 等级 :', sim.marks[180], '/', sim.marks[360], '/', sim.marks[540]);
console.log('  总升级次数     :', sim.level - 1,
  (sim.level - 1 >= 18 && sim.level - 1 <= 25) ? '✅ 落在 18–25' : '❌ 超出 18–25');
console.log('  前期平均间隔   :', avg(early) + 's   后期平均间隔:', avg(late) + 's');

/* ================================================================= 测试 5 */
/* §36 固定种子可复现 */
console.log('\n【测试5 · §36 种子复现】');
function draw3(seed) {
  RNG.init(seed);
  const rem = MUTATIONS.slice();
  return [1, 2, 3, 4].map(() => {
    const pick = RNG.mutation.sample(rem.filter(m => !m.taken), 3).map(m => m.id);
    const t = rem.find(m => m.id === pick[0]); if (t) t.taken = true;
    return pick.join(',');
  }).join(' | ');
}
const a1 = draw3(777); MUTATIONS.forEach(m => delete m.taken);
const a2 = draw3(777); MUTATIONS.forEach(m => delete m.taken);
const a3 = draw3(778); MUTATIONS.forEach(m => delete m.taken);
console.log('  同种子两次抽取一致 :', a1 === a2 ? '✅' : '❌');
console.log('  不同种子结果不同   :', a1 !== a3 ? '✅' : '❌');
