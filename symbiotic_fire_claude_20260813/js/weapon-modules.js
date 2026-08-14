/* ============================================================================
   SYMBIOTIC FIRE · 可组合武器模块（todo5 §2 / §3 / §8 / §11）

   这一层只做四件事：
     1. 定义八个玩家可见模块是什么（数据来自 TUNE.MODULES，这里不写数值）
     2. 维护本局持有的模块 / 节点 / 分支 / 规则
     3. 把「持有什么」折算成 G.derived 的原子参数（热路径不查表，§6.3）
     4. 按模块分别累计归因数据（§11）

   它【不】结算伤害、不生成弹丸、不管预算 —— 那些全在 attack-graph.js。
   设计口令（§0）：底层拆成原子，卡面合成模块，玩家组合出枪。
   ========================================================================== */
'use strict';

const MODULE_IDS = ['volley', 'blast', 'pierce', 'split', 'heavy', 'overclock', 'ricochet', 'momentum'];

/* ============================================================================
   §3 反应矩阵
   S 强化学反应：产生新的武器形态、覆盖几何或操作节奏
   A 有效反应：明显改变已有模块的效率或作用方式
   B 弱反应：主要是数值叠加
   X 冲突：默认不能同时出现（一期没有 X，但判定链留着）
   ========================================================================== */
const REACTION = {
  /*             volley blast pierce split heavy overclock ricochet momentum */
  volley:    { blast: 'S', pierce: 'S', split: 'S', heavy: 'S', overclock: 'A', ricochet: 'S', momentum: 'A' },
  blast:     { volley: 'S', pierce: 'S', split: 'S', heavy: 'S', overclock: 'A', ricochet: 'S', momentum: 'S' },
  pierce:    { volley: 'S', blast: 'S', split: 'S', heavy: 'S', overclock: 'A', ricochet: 'S', momentum: 'A' },
  split:     { volley: 'S', blast: 'S', pierce: 'S', heavy: 'S', overclock: 'A', ricochet: 'S', momentum: 'A' },
  heavy:     { volley: 'S', blast: 'S', pierce: 'S', split: 'S', overclock: 'S', ricochet: 'S', momentum: 'S' },
  overclock: { volley: 'A', blast: 'A', pierce: 'A', split: 'S', heavy: 'S', ricochet: 'S', momentum: 'S' },
  ricochet:  { volley: 'S', blast: 'S', pierce: 'S', split: 'S', heavy: 'S', overclock: 'S', momentum: 'A' },
  momentum:  { volley: 'A', blast: 'S', pierce: 'A', split: 'A', heavy: 'S', overclock: 'S', ricochet: 'A' }
};
/* 超频×分裂 / 超频×弹射 / 超频×动势 三对是 2026-08-14 从 A 提到 S 的。
   §14 要求每个模块至少 3 个 S，之前超频只有 1、动势只有 2。
   提级的依据是 §3 对 S 的定义（同时改变覆盖几何与操作节奏），
   而这三对的实现【本来就已经是形态改变】，缺的只是矩阵上的评级：
     · 超频×分裂：分裂攒成周期性合并波，射速越高波越密，而不是碎片越多
     · 超频×弹射：升速越过 bounceRampAt 才多一次折跳 —— 折跳次数挂在节奏上
     · 超频×动势：强化轮从「下 N 发」变成一段时间窗，窗口内超频不衰减
   §3 同时写了反向的降级条件（超频若只是「什么都更快」就不该占基础模块名额）：
   实测这三对分别改了派生几何、折跳次数与强化轮的计量方式，都不是纯倍率。
   这是设计判断，Bao 试玩后可以推翻 —— 推翻就把这三格改回 'A'。 */

function pairKey(a, b) { return a < b ? a + '+' + b : b + '+' + a; }
function reactionOf(a, b) { return (REACTION[a] && REACTION[a][b]) || '-'; }

/* S 级组合的名字 —— §7.2 的动态预览与 §11 的 HUD 都读这里。
   §4 的六组是必须优先成立的代表性组合，其余 S 由统一继承规则自然产生。 */
const PAIR_NAME = {
  'blast+volley':      { name: '多点爆破', key: true, desc: '多颗根弹在不同位置制造缩小版爆炸，齐射数量改变爆破覆盖形状' },
  'blast+split':       { name: '集束反应', key: true, desc: '主弹爆点长出多个携带部分爆裂载荷的小爆点' },
  'blast+pierce':      { name: '终点爆破', key: true, desc: '先贯穿整列，在最后有效目标或射程终点兑现主爆炸' },
  'pierce+ricochet':   { name: '折线贯穿', key: true, desc: '穿完一列后折向另一列，折向后贯穿次数降低' },
  'heavy+overclock':   { name: '重型机关炮', key: true, desc: '重型压低初速，持续射击逐步夺回速度，升成连续重炮' },
  'heavy+momentum':    { name: '动能炮', key: true, desc: '高速移动积蓄的动势显著放大下一轮重型攻击' },

  'pierce+volley':     { name: '箭弹墙', desc: '多条贯穿枪线同时推进' },
  'split+volley':      { name: '受限弹幕', desc: '多根弹各自产生次级弹，共享派生预算' },
  'heavy+volley':      { name: '重型齐射', desc: '少量高耗弹的重型齐射' },
  'ricochet+volley':   { name: '散射折线', desc: '多颗子弹分别寻找后续目标' },
  'blast+heavy':       { name: '重爆弹', desc: '更大、更强但更慢的爆裂弹' },
  'blast+ricochet':    { name: '跳爆', desc: '弹射落点携带衰减爆破' },
  'blast+momentum':    { name: '动能爆破', desc: '动势提高下一轮爆炸的范围与中心伤害' },
  'pierce+split':      { name: '贯穿裂片', desc: '次级弹继承低倍率穿透' },
  'heavy+pierce':      { name: '长枪贯列', desc: '大弹体形成长线贯穿' },
  'heavy+split':       { name: '重型碎片', desc: '数量更少、冲击更强的碎片' },
  'heavy+ricochet':    { name: '重弹折跳', desc: '大弹体转向并制造强碰撞反馈' },
  'ricochet+split':    { name: '折线增殖', desc: '次级弹获得有限弹射，共享派生预算' },

  'overclock+split':   { name: '分裂波', desc: '逐弹分裂攒成周期性合并波，射速越高波越密而不是碎片越碎' },
  'overclock+ricochet':{ name: '跳弹链', desc: '升速越过红线后每发多一次折跳，停火降速就断链' },
  'momentum+overclock':{ name: '持续动能', desc: '强化轮从「下 N 发」变成一段时间窗，窗口内超频不衰减' }
};
function pairInfo(a, b) { return PAIR_NAME[pairKey(a, b)] || null; }

/* ============================================================================
   §7.3 品质：普通给完整模块，稀有加一项原生离散强化，
   史诗加一项改变形态的原生分支，传奇只打破一条规则且必须有上限。
   ========================================================================== */

/* --- §8 后续节点：只深化行为，绝不是纯数值礼包 --- */
const MODULE_NODES = [
  { id: 'n_volley_pellet', mod: 'volley', name: '并联供弹', text: '齐射弹丸 +1',
    cost: '单次耗弹同步 +1', max: 2, consumer: 'volley.pellets' },
  { id: 'n_volley_focus', mod: 'volley', name: '聚焦图案', text: '齐射图案收窄，远距离更集中',
    cost: '近距离覆盖变小', max: 2, consumer: 'volley.pattern' },
  { id: 'n_blast_radius', mod: 'blast', name: '装药', text: '爆炸半径 +18%',
    cost: '—', max: 3, consumer: 'blast.radius' },
  { id: 'n_blast_core', mod: 'blast', name: '聚能核', text: '爆炸中心伤害 +25%',
    cost: '边缘伤害不变', max: 2, consumer: 'blast.core' },
  { id: 'n_pierce_count', mod: 'pierce', name: '骨刺', text: '贯穿次数 +1',
    cost: '—', max: 3, consumer: 'pierce.count' },
  { id: 'n_pierce_keep', mod: 'pierce', name: '尾迹稳流', text: '贯穿后排的伤害继承提高',
    cost: '—', max: 2, consumer: 'pierce.decay' },
  { id: 'n_split_count', mod: 'split', name: '增殖节点', text: '次级弹 +1',
    cost: '共享单根攻击的派生预算', max: 2, consumer: 'split.count' },
  { id: 'n_split_inherit', mod: 'split', name: '母体继承', text: '次级弹继承比例提高',
    cost: '—', max: 2, consumer: 'split.coef' },
  { id: 'n_heavy_rate', mod: 'heavy', name: '配重优化', text: '重型的射速惩罚减轻',
    cost: '—', max: 2, consumer: 'heavy.rate' },
  { id: 'n_heavy_knock', mod: 'heavy', name: '冲击锥', text: '重型击退与撞击反馈提高',
    cost: '—', max: 2, consumer: 'heavy.knock' },
  { id: 'n_oc_ramp', mod: 'overclock', name: '进气', text: '升速更快达到上限',
    cost: '—', max: 2, consumer: 'overclock.ramp' },
  { id: 'n_oc_mag', mod: 'overclock', name: '长弹链', text: '弹匣继续扩大',
    cost: '换弹时间略增', max: 2, consumer: 'overclock.mag' },
  { id: 'n_ric_count', mod: 'ricochet', name: '折射棱', text: '弹射次数 +1',
    cost: '—', max: 3, consumer: 'ricochet.count' },
  { id: 'n_ric_keep', mod: 'ricochet', name: '低损转向', text: '弹射衰减减轻',
    cost: '—', max: 2, consumer: 'ricochet.decay' },
  { id: 'n_mom_store', mod: 'momentum', name: '储能延时', text: '动势保存更久，强化轮更长',
    cost: '—', max: 2, consumer: 'momentum.window' },
  { id: 'n_mom_scale', mod: 'momentum', name: '释放增幅', text: '动势释放规模提高',
    cost: '—', max: 2, consumer: 'momentum.gain' },

  /* 每个模块的第三个节点。
     两个节点撑不住一局 15 次进化：满 3 模块之后普通/稀有池会被抽干，
     三选一就只能凑出 1~2 张（500 局模拟里真的发生了）。 */
  { id: 'n_volley_ammo', mod: 'volley', name: '供弹优化', text: '齐射的额外耗弹 -1',
    cost: '弹丸数量不变', max: 2, consumer: 'volley.ammo' },
  { id: 'n_blast_budget', mod: 'blast', name: '装药分配', text: '单次攻击的统一爆炸预算提高',
    cost: '仍然是一份预算，不是每颗一份', max: 2, consumer: 'blast.budget' },
  { id: 'n_pierce_width', mod: 'pierce', name: '破甲弹芯', text: '贯穿时弹体更大，更容易咬住整列',
    cost: '—', max: 2, consumer: 'pierce.width' },
  { id: 'n_split_scale', mod: 'split', name: '碎片增重', text: '次级弹的体积与击退提高',
    cost: '—', max: 2, consumer: 'split.scale' },
  { id: 'n_heavy_body', mod: 'heavy', name: '弹体扩张', text: '重型弹体进一步增大',
    cost: '—', max: 2, consumer: 'heavy.body' },
  { id: 'n_oc_hold', mod: 'overclock', name: '惯性飞轮', text: '停火后的升速衰减明显变慢',
    cost: '—', max: 2, consumer: 'overclock.hold' },
  { id: 'n_ric_range', mod: 'ricochet', name: '索敌增幅', text: '弹射的搜索范围提高',
    cost: '—', max: 2, consumer: 'ricochet.range' },
  { id: 'n_mom_gain', mod: 'momentum', name: '动势导流', text: '移动积蓄动势的速率提高',
    cost: '—', max: 2, consumer: 'momentum.gain' },

  /* §8 允许的条件分支：弱点 / 换弹 / 击杀 —— 稀有档 */
  { id: 'n_cond_weak', mod: null, q: 'rare', name: '弱点回响', text: '弱点命中让本次攻击的载荷继承提高',
    cost: '只在打中弱点时生效', max: 2, consumer: 'cond.weak' },
  { id: 'n_cond_reload', mod: null, q: 'rare', name: '退膛冲击', text: '换弹完成后的第一次攻击获得一轮强化',
    cost: '每次换弹只有一次', max: 1, consumer: 'cond.reload' },
  { id: 'n_cond_kill', mod: null, q: 'rare', name: '击杀续链', text: '击杀返还派生预算，让同一根攻击继续传播',
    cost: '仍受单根攻击上限约束', max: 2, consumer: 'cond.kill' }
];

/* --- §7.3 史诗：改变形态的原生分支，一个模块一条 --- */
const MODULE_BRANCHES = [
  { id: 'b_volley_wall', mod: 'volley', name: '扇形弹墙',
    text: '齐射再 +2 弹丸，展开成一面可读的宽扇', cost: '单弹伤害进一步下降', consumer: 'volley.wall' },
  { id: 'b_blast_ring', mod: 'blast', name: '空心爆破',
    text: '爆炸变成环形冲击，半径大幅扩大并向内击退', cost: '爆心不再造成伤害', consumer: 'blast.ring' },
  { id: 'b_pierce_over', mod: 'pierce', name: '过穿增幅',
    text: '贯穿不再衰减，改为每穿一个目标递增伤害', cost: '递增有明确上限', consumer: 'pierce.over' },
  { id: 'b_split_home', mod: 'split', name: '追踪裂片',
    text: '次级弹主动追踪新目标', cost: '追踪只在有限时间内有效', consumer: 'split.home' },
  { id: 'b_heavy_siege', mod: 'heavy', name: '攻城弹头',
    text: '重型弹终点沿飞行方向产生横向震波', cost: '震波每根攻击只有一次', consumer: 'heavy.siege' },
  { id: 'b_oc_redline', mod: 'overclock', name: '红线运转',
    text: '升速可以突破上限，峰值每发附带小型冲击', cost: '突破后进入一次强制冷却', consumer: 'overclock.redline' },
  { id: 'b_ric_lash', mod: 'ricochet', name: '链鞭',
    text: '弹射次数 +2，搜索范围随折向次数扩大', cost: '衰减仍逐次累积', consumer: 'ricochet.lash' },
  { id: 'b_mom_core', mod: 'momentum', name: '动能核心',
    text: '动势同时兑换弹药，强化轮覆盖更长', cost: '兑换比例受弹匣上限约束', consumer: 'momentum.core' }
];

/* --- §7.3 传奇：只打破一条既有规则，必须有明确次数 / 时间 / 深度上限 --- */
const MODULE_RULES = [
  { id: 'r_depth', name: '谱系深度改写', text: '派生弹的最大递归深度 +1',
    cost: '单根攻击的效果事件上限不变', consumer: 'rule.depth' },
  { id: 'r_derive', name: '派生预算改写', text: '单根攻击的最大派生弹数量 +6',
    cost: '深度与重复命中上限不变', consumer: 'rule.derive' },
  { id: 'r_blast', name: '爆炸预算改写', text: '单根攻击的统一爆炸预算 +0.6 份',
    cost: '仍然是一份预算，不是每颗一份', consumer: 'rule.blast' },
  { id: 'r_hit', name: '重复命中改写', text: '同一目标单根攻击的命中上限 +1',
    cost: '每次命中仍按继承系数衰减', consumer: 'rule.hit' },
  { id: 'r_mag', name: '弹匣规则改写', text: '不再消耗弹匣，改为过热节奏',
    cost: '过热会强制中断射击', consumer: 'rule.mag' }
];

const NODE_MAP = {}; MODULE_NODES.forEach(n => { NODE_MAP[n.id] = n; });
const BRANCH_MAP = {}; MODULE_BRANCHES.forEach(b => { BRANCH_MAP[b.id] = b; });
const RULE_MAP = {}; MODULE_RULES.forEach(r => { RULE_MAP[r.id] = r; });
const BRANCH_BY_MOD = {}; MODULE_BRANCHES.forEach(b => { BRANCH_BY_MOD[b.mod] = b; });

/* ============================================================================
   WMOD —— 本局构筑状态 + 派生折算 + §11 归因
   ========================================================================== */
const WMOD = {
  own: [],                 // 持有的基础模块（有序，最多 3）
  ownSet: {},
  nodes: {},               // nodeId -> stacks
  branches: [],            // branchId
  rules: [],               // ruleId
  taken: {},

  /* 动势状态（§2.8）：charge 攒、round 放 */
  mom: { charge: 0, round: 0, shots: 0, timer: 0, strength: 0, peak: 0 },
  /* 超频状态：ramp 0..1 */
  oc: { ramp: 0, idle: 0, redline: 0, cooling: 0 },
  /* 分裂×超频的合并波计数（§5 禁止逐弹对象爆炸） */
  wave: { hits: 0 },
  /* 条件分支的一次性标记 */
  flags: { reloadBoost: false },
  heat: 0, overheated: 0,

  /* §11 归因：每个模块分别统计 */
  stats: null,

  init() {
    this.own = []; this.ownSet = {};
    this.nodes = {}; this.branches = []; this.rules = []; this.taken = {};
    this.mom = { charge: 0, round: 0, shots: 0, timer: 0, strength: 0, peak: 0 };
    this.oc = { ramp: 0, idle: 0, redline: 0, cooling: 0 };
    this.wave = { hits: 0 };
    this.flags = { reloadBoost: false };
    this.heat = 0; this.overheated = 0;
    this.stats = {};
    MODULE_IDS.forEach(id => {
      this.stats[id] = { trigger: 0, direct: 0, derived: 0, targets: 0, ammo: 0 };
    });
    this._install();
    return this;
  },

  /* --------------------------------------------------------------------------
     §1.5 条件原子（冲刺 / 滑铲 / 墙跑 / 滞空 / 落地）已经是 movement.js 的总线事件，
     所以动势直接订阅它们，而不是每帧去猜移动状态机的内部状态。
     -------------------------------------------------------------------------- */
  _install() {
    if (this._installed) return;
    this._installed = true;
    const m = () => TUNE.MODULES.momentum;
    const add = v => {
      if (!this.has('momentum')) return;
      v *= 1 + 0.30 * this.node('n_mom_gain');
      this.mom.charge = Math.min(1, this.mom.charge + v);
      this.mom.peak = Math.max(this.mom.peak, this.mom.charge);
    };
    G.bus.on('dash', ev => add(ev && ev.airborne ? m().gainAirDash : m().gainDash));
    G.bus.on('slide', () => add(m().gainSlide));
    G.bus.on('wallrun', () => add(m().gainWallrun));
    G.bus.on('wallclimb', () => add(m().gainWallrun * 0.6));
    G.bus.on('zipline', () => add(m().gainWallrun * 0.8));
    G.bus.on('land', ev => { if (ev && ev.fall > 6) add((ev.fall - 6) * m().gainFallPerM); });
    /* §8 条件分支「换弹冲击」：换弹完成后的第一次攻击获得一轮强化 */
    G.bus.on('reloadDone', () => {
      if (this.node('n_cond_reload') <= 0) return;
      this.flags.reloadBoost = true;
      if (this.has('momentum')) this.startRound(Math.max(this.mom.charge, 0.55));
      recompute();
    });
    /* §8 条件分支「击杀续链」：击杀返还派生预算，让同一根攻击继续传播 */
    G.bus.on('kill', ev => {
      if (this.node('n_cond_kill') <= 0) return;
      const g = ev && ev.ctx;
      if (!g || !g.root) return;
      g.root.derived = Math.min(G.derived.genDerived, g.root.derived + WMOD.node('n_cond_kill'));
    }, 30);
  },

  has(id) { return !!this.ownSet[id]; },
  node(id) { return this.nodes[id] || 0; },
  hasBranch(id) { return this.branches.indexOf(id) >= 0; },
  hasRule(id) { return this.rules.indexOf(id) >= 0; },
  full() { return this.own.length >= TUNE.MODULE_BUILD.maxModules; },

  /* --------------------------------------------------------------- 授予 */
  grant(id) {
    if (this.has(id) || this.full()) return false;
    this.own.push(id);
    this.ownSet[id] = true;
    /* 枪械外观：模块必须看得出来（§11）。复用 todo2 已有的器官挂点。 */
    if (typeof R !== 'undefined' && R.setGunOrgan) R.setGunOrgan(MODULE_ORGAN[id], true);
    recompute();
    G.bus.emit('moduleTaken', { id: id });
    if (TUNE.FEATURES.hordeEvolution && typeof HORDE !== 'undefined') HORDE.onModule(id);
    return true;
  },
  grantNode(id) {
    const n = NODE_MAP[id];
    if (!n) return false;
    if (this.node(id) >= n.max) return false;
    this.nodes[id] = this.node(id) + 1;
    recompute();
    return true;
  },
  grantBranch(id) {
    if (this.hasBranch(id)) return false;
    this.branches.push(id);
    recompute();
    if (TUNE.FEATURES.hordeEvolution && typeof HORDE !== 'undefined') HORDE.onBranch(id);
    return true;
  },
  grantRule(id) {
    if (this.hasRule(id)) return false;
    this.rules.push(id);
    recompute();
    if (TUNE.FEATURES.hordeEvolution && typeof HORDE !== 'undefined') HORDE.onRule(id);
    return true;
  },

  /* ------------------------------------------------- 已成立的 S / A 组合 */
  pairs() {
    const out = [];
    for (let i = 0; i < this.own.length; i++)
      for (let j = i + 1; j < this.own.length; j++) {
        const a = this.own[i], b = this.own[j];
        out.push({ a: a, b: b, tier: reactionOf(a, b), info: pairInfo(a, b) });
      }
    return out;
  },
  /* 卡面动态预览用：这张模块卡与已有模块会形成哪些 S（§7.2）。
     §7.2 硬要求「动态预览必须来自真实实现状态，不允许只有文案」——
     所以这里除了矩阵评级，还必须存在 PAIR_EFFECTS 里登记的真实实现条目，
     每条都指向 attack-graph.js / weapon-modules.js 的一个具体代码位置。 */
  previewS(id) {
    const out = [];
    this.own.forEach(o => {
      if (o === id) return;
      if (reactionOf(id, o) !== 'S') return;
      const info = pairInfo(id, o);
      if (!info) return;
      const impl = (typeof PAIR_EFFECTS !== 'undefined') && PAIR_EFFECTS[pairKey(id, o)];
      if (!impl || !impl.length) return;
      out.push({ other: o, name: info.name });
    });
    return out;
  },

  /* ==========================================================================
     §6.3 把持有关系折算成原子参数。
     这里是唯一的折算点：热路径（attack-graph / updateBullets）只读 G.derived。
     ========================================================================== */
  applyDerived(d) {
    const M = TUNE.MODULES, A = TUNE.ATOMS, GE = TUNE.GENEALOGY;

    /* --- 预算上限：传奇规则是唯一能改它们的东西，且都带上限（§7.3）--- */
    d.genDerived = GE.derivedPerRoot + (this.hasRule('r_derive') ? 6 : 0);
    d.genEvents = GE.eventsPerRoot;
    d.genDepth = GE.maxDepth + (this.hasRule('r_depth') ? 1 : 0);
    d.genHits = GE.hitsPerTargetPerRoot + (this.hasRule('r_hit') ? 1 : 0);
    d.blastBudget = GE.blastPerRoot + (this.hasRule('r_blast') ? 0.6 : 0);

    /* --- 资源原子 --- */
    d.ammoPerShot = A.ammoPerShot;
    d.volleyFan = M.volley.fanDeg;
    d.pellets = 1;
    d.pierce = 0; d.bounce = 0;
    d.splitCount = 0;
    d.blastOn = false;
    d.heavyOn = false;

    /* --- 齐射 §2.1 --- */
    if (this.has('volley')) {
      const v = M.volley;
      let extra = v.pellets + this.node('n_volley_pellet');
      if (this.hasBranch('b_volley_wall')) extra += 2;
      d.pellets = 1 + extra;
      d.ammoPerShot += Math.max(1, v.ammo + this.node('n_volley_pellet') - this.node('n_volley_ammo'));
      /* 单弹衰减：总量上升，但不能让玩家觉得「只是数字拆开」 */
      const per = this.hasBranch('b_volley_wall') ? v.dmgPerPellet * 0.86 : v.dmgPerPellet;
      d.damage *= per;
      d.volleyFan = v.fanDeg * Math.pow(0.78, this.node('n_volley_focus'))
        * (this.hasBranch('b_volley_wall') ? 1.9 : 1);
      this.stats.volley.ammo = this.stats.volley.ammo;   // 归因在开火时累加
    }

    /* --- 重型 §2.5 --- */
    if (this.has('heavy')) {
      const h = M.heavy;
      d.heavyOn = true;
      d.damage *= h.dmg;
      d.bulletScale *= h.scale * (1 + 0.22 * this.node('n_heavy_body'));   // 动势的额外放大在强化轮里加
      d.knockback *= h.knock * (1 + 0.22 * this.node('n_heavy_knock'));
      d.fireInterval *= 1 + (h.rate - 1) * Math.pow(0.72, this.node('n_heavy_rate'));
      d.ammoPerShot += h.ammo;
      d.weaponHeavy += h.weaponHeavy;
    }

    /* --- 超频 §2.6 --- */
    if (this.has('overclock')) {
      const o = M.overclock;
      d.magazine = Math.round(d.magazine * (o.mag + 0.20 * this.node('n_oc_mag')));
      d.fireInterval *= o.rate;
      if (this.node('n_oc_mag')) d.reloadTime *= 1 + 0.10 * this.node('n_oc_mag');
      /* §4.5 重型×超频：升速幅度与时长专门放大，形成「逐步升成重炮」 */
      const pair = this.has('heavy') ? TUNE.MODULE_PAIRS['heavy+overclock'] : null;
      d.ocRampMax = o.rampMax * (pair ? pair.rampMult : 1)
        * (this.hasBranch('b_oc_redline') ? o.redlineMax / o.rampMax : 1);
      d.ocRampTime = (pair ? pair.rampTime : o.rampTime) * Math.pow(0.78, this.node('n_oc_ramp'));
    } else {
      d.ocRampMax = 0; d.ocRampTime = 1;
    }

    /* --- 穿透 §2.3 --- */
    if (this.has('pierce')) {
      const p = M.pierce;
      d.pierce = p.count + this.node('n_pierce_count');
      d.pierceDecay = Math.min(0.97, p.dmgDecay + 0.06 * this.node('n_pierce_keep'));
      d.piercePayload = p.payloadDecay + 0.07 * this.node('n_pierce_keep');
      d.pierceWidth = 1 + 0.30 * this.node('n_pierce_width');
      d.pierceRampOn = this.hasBranch('b_pierce_over');
      d.pierceRamp = p.rampPerHit; d.pierceRampMax = p.rampMax;
    }

    /* --- 分裂 §2.4 --- */
    if (this.has('split')) {
      const s = M.split;
      let n = s.count + this.node('n_split_count');
      /* §5 分裂×重型：少量、清晰、冲击强的重型碎片 */
      if (this.has('heavy')) n = Math.max(1, n - s.heavyFewer);
      d.splitCount = n;
      const bump = 1 + 0.18 * this.node('n_split_inherit');
      d.splitDmg = s.dmgCoef * bump * (this.has('heavy') ? 1.55 : 1);
      d.splitPayload = s.payloadCoef * bump;
      d.splitScale = s.scale * (this.has('heavy') ? 1.35 : 1) * (1 + 0.28 * this.node('n_split_scale'));
      d.splitHome = this.hasBranch('b_split_home');
      /* §5 分裂×超频：合并成周期性分裂波，绝不逐弹生成对象 */
      d.splitWave = this.has('overclock');
      d.splitWaveHits = s.waveHits;
      d.splitWaveCount = s.waveCount + this.node('n_split_count');
    }

    /* --- 弹射 §2.7 --- */
    if (this.has('ricochet')) {
      const r = M.ricochet;
      d.bounce = r.count + this.node('n_ric_count') + (this.hasBranch('b_ric_lash') ? 2 : 0);
      /* §5 超频×弹射：持续命中逐渐提高弹射次数 */
      if (this.has('overclock') && this.oc.ramp >= M.overclock.bounceRampAt) d.bounce += 1;
      /* §5 弹射×动势：下一轮攻击获得额外弹射次数【或更低衰减】——
         两半都要，只给 +1 次的话在密集尸群里几乎看不出来。 */
      const momKeep = this.mom.round > 0 ? TUNE.MODULES.momentum.bounceKeep * this.mom.strength : 0;
      d.bounceDecay = Math.min(0.95, r.dmgDecay + 0.07 * this.node('n_ric_keep') + momKeep);
      d.bouncePayload = r.payloadDecay + 0.07 * this.node('n_ric_keep') + momKeep;
      d.bounceSearch = r.search * (1 + 0.25 * this.node('n_ric_range'));
      d.bounceLash = this.hasBranch('b_ric_lash');
    }

    /* --- 爆裂 §2.2 --- */
    if (this.has('blast')) {
      const bl = M.blast;
      d.blastOn = true;
      d.blastRadius = bl.radius * (1 + 0.18 * this.node('n_blast_radius'))
        * (this.has('heavy') ? M.heavy.blastScale : 1)
        * (this.hasBranch('b_blast_ring') ? 1.85 : 1);
      d.blastDmg = bl.dmgRatio * (1 + 0.25 * this.node('n_blast_core'));
      d.blastRing = this.hasBranch('b_blast_ring');
      d.ammoPerShot += bl.ammo;
      /* §4.1 齐射×爆裂：预算随齐射数放大，但仍然是一份统一预算 */
      if (this.has('volley'))
        d.blastBudget += TUNE.MODULE_PAIRS['blast+volley'].budgetPerExtra * (d.pellets - 1);
      d.blastBudget += 0.25 * this.node('n_blast_budget');
      /* §4.3 穿透×爆裂：中途不炸，终点兑现 */
      d.blastTerminal = this.has('pierce');
    }

    /* --- 动势 §2.8：强化轮的加成在这里进 derived，一轮结束自动消失 --- */
    d.momOn = this.has('momentum');
    if (this.mom.round > 0) {
      const m = M.momentum, s = this.mom.strength;
      const gain = 1 + 0.25 * this.node('n_mom_scale');
      d.damage *= 1 + (m.dmg - 1) * s * gain;
      d.bulletScale *= 1 + m.scale * s * gain;
      d.knockback *= 1 + (m.knock - 1) * s * gain;
      if (this.has('heavy')) {
        const hp = TUNE.MODULE_PAIRS['heavy+momentum'];
        d.damage *= 1 + (hp.dmg - 1) * s;
        d.bulletScale *= 1 + (hp.scale - 1) * s;
      }
      if (d.pierce > 0 && s >= m.pierceAt) d.pierce += 1;
      if (d.splitCount > 0 && s >= m.splitAt) d.splitCount += 1;
      if (d.bounce > 0 && s >= m.bounceAt) d.bounce += (s >= m.bounceAtFull ? 2 : 1);
      if (d.blastOn) d.blastRadius *= 1 + m.blastR * s;
      d.momActive = s;
    } else d.momActive = 0;

    /* --- 条件分支：换弹后的第一次攻击（§8）--- */
    if (this.flags.reloadBoost) d.reloadBoost = true; else d.reloadBoost = false;

    /* --- 传奇：弹匣规则改写 --- */
    if (this.hasRule('r_mag')) { d.infiniteMag = true; d.heatMode = true; }

    d.ammoPerShot = Math.max(1, Math.round(d.ammoPerShot));
    d.pierce = Math.max(0, Math.round(d.pierce));
    d.bounce = Math.max(0, Math.round(d.bounce));

    /* 一个 NaN 能悄无声息地毁掉整局：bulletScale 变 NaN 之后，
       扫掠命中的半径是 NaN，所有 segCylinder 都返回 -1，于是「一发都打不中」，
       而屏幕上枪照开、曳光照飞，没有任何报错。这里守住这条线。 */
    NUMERIC_DERIVED.forEach(k => {
      if (typeof d[k] === 'number' && !isFinite(d[k])) {
        if (!this._nanWarned) {
          this._nanWarned = true;
          const msg = '派生数值 ' + k + ' 变成了 ' + d[k] + '（模块折算里有未定义的配置项）';
          if (typeof DebugPanel !== 'undefined' && DebugPanel.log) DebugPanel.log('⚠ ' + msg);
          if (G.ui && G.ui.toast) G.ui.toast('内部错误：' + msg, '#ff6a7a', true);
          console.error('[WMOD] ' + msg);
        }
        d[k] = NUMERIC_FALLBACK[k] !== undefined ? NUMERIC_FALLBACK[k] : 0;
      }
    });
    return d;
  },

  /* ==========================================================================
     每帧推进：超频升速、动势积蓄、过热、强化轮倒计时
     ========================================================================== */
  tick(dt, ctx) {
    const M = TUNE.MODULES, d = G.derived;

    /* --- 超频升速（§2.6）：只改发射节奏，不创建平行伤害系统（§6.1 第 7 条）--- */
    if (this.has('overclock')) {
      const o = M.overclock;
      if (this.oc.cooling > 0) {
        this.oc.cooling -= dt;
        this.oc.ramp = Math.max(0, this.oc.ramp - dt * 1.6);
      } else if (ctx.firing) {
        this.oc.idle = 0;
        this.oc.ramp = Math.min(1, this.oc.ramp + dt / Math.max(0.15, d.ocRampTime));
        /* 红线分支：突破上限后强制冷却（§7.3 传奇之外的分支也必须有代价）*/
        if (this.hasBranch('b_oc_redline') && this.oc.ramp >= 1) {
          this.oc.redline += dt;
          if (this.oc.redline > 1.6) { this.oc.cooling = 1.1; this.oc.redline = 0; }
        }
      } else {
        this.oc.idle += dt;
        /* §5 超频×动势：高速移动帮助保持超频 */
        const hold = o.holdGrace * (this.mom.round > 0 ? 2.4 : 1) * (1 + 0.55 * this.node('n_oc_hold'));
        if (this.oc.idle > hold) this.oc.ramp = Math.max(0, this.oc.ramp - o.decay * dt);
      }
    }

    /* --- 动势积蓄（§2.8）：离散动作由总线事件供给（见 _install），
           这里只处理「持续高速」与「停下衰减」两个连续量 --- */
    if (this.has('momentum')) {
      const m = M.momentum;
      if (ctx.speed > 8) {
        this.mom.charge = Math.min(1, this.mom.charge + (ctx.speed - 8) * m.gainSpeed * dt);
        this.mom.peak = Math.max(this.mom.peak, this.mom.charge);
      } else if (this.mom.round <= 0 && ctx.speed < 3.2) {
        this.mom.charge = Math.max(0, this.mom.charge - m.decay * dt);
      }
      /* 强化轮倒计时：时间型（超频）与发数型（齐射/重型）两条并存 */
      if (this.mom.round > 0 && this.mom.timer > 0) {
        this.mom.timer -= dt;
        if (this.mom.timer <= 0 && this.mom.shots <= 0) this.endRound();
      }
    }

    /* --- 过热节奏（传奇 r_mag）--- */
    if (this.hasRule('r_mag')) {
      if (ctx.firing && this.overheated <= 0) this.heat = Math.min(1, this.heat + dt * 0.42);
      else this.heat = Math.max(0, this.heat - dt * 0.55);
      if (this.heat >= 1 && this.overheated <= 0) {
        this.overheated = 1.5;
        if (G.ui) G.ui.toast('过热 —— 强制停火', M.overclock.css);
      }
      if (this.overheated > 0) { this.overheated -= dt; if (this.overheated <= 0) this.heat = 0; }
    }
  },

  /* 开火瞬间：决定这一枪是否处于强化轮，并累计弹药归因 */
  onFire() {
    const M = TUNE.MODULES, d = G.derived;
    /* 动势释放：达到阈值就在下一次射击开启强化轮（§2.8 强化「一轮」）*/
    if (this.has('momentum') && this.mom.round <= 0 && this.mom.charge >= M.momentum.releaseAt) {
      this.startRound(this.mom.charge);
      this.mom.charge = 0;
    }
    if (this.mom.round > 0 && this.mom.shots > 0) {
      this.mom.shots--;
      if (this.mom.shots <= 0 && this.mom.timer <= 0) this._endAfterShot = true;
    }
    this.flags.reloadBoost = false;
    /* §11 弹药归因：谁把弹匣吃掉了 */
    const per = d.ammoPerShot;
    if (per > 1) {
      const A = TUNE.ATOMS, M2 = TUNE.MODULES;
      if (this.has('volley')) this.stats.volley.ammo += M2.volley.ammo + this.node('n_volley_pellet');
      if (this.has('blast')) this.stats.blast.ammo += M2.blast.ammo;
      if (this.has('heavy')) this.stats.heavy.ammo += M2.heavy.ammo;
    }
  },
  /* 强化轮的长度随构筑变化 —— §2.8 明确不绑定「第 N 发」 */
  startRound(strength) {
    const m = TUNE.MODULES.momentum;
    const ext = 1 + 0.35 * this.node('n_mom_store') + (this.hasBranch('b_mom_core') ? 0.6 : 0);
    this.mom.round = 1;
    this.mom.strength = clamp(strength, 0, 1);
    /* 注意：下面几行读 this.mom.strength，所以必须在赋值之后 */
    const s = this.mom.strength;
    if (this.has('overclock')) { this.mom.timer = m.roundStreamT * (0.6 + 0.4 * s) * ext; this.mom.shots = 0; }
    else if (this.has('heavy')) { this.mom.shots = m.roundHeavy; this.mom.timer = 0; }
    else if (this.has('volley')) { this.mom.shots = m.roundVolley; this.mom.timer = 0; }
    else { this.mom.shots = Math.round((m.roundShots + m.roundExtra * s) * ext); this.mom.timer = 0; }
    /* 动能核心：动势兑换弹药 */
    if (this.hasBranch('b_mom_core') && G.player) {
      const back = Math.round(G.derived.magazine * m.ammoBack * this.mom.strength);
      G.player.gun.ammo = Math.min(G.derived.magazine, G.player.gun.ammo + back);
    }
    this.stats.momentum.trigger++;
    recompute();
    G.bus.emit('momentumRelease', { strength: this.mom.strength });
  },
  endRound() {
    this.mom.round = 0; this.mom.strength = 0; this.mom.shots = 0; this.mom.timer = 0;
    this._endAfterShot = false;
    recompute();
  },
  /* fire() 结束后调用：发数型强化轮在这一枪打完才结束，避免本枪自己被降级 */
  afterFire() { if (this._endAfterShot) this.endRound(); },

  /* --------------------------------------------------------------- §11 归因 */
  count(mod, field, v) {
    if (!this.stats[mod]) return;
    this.stats[mod][field] += (v === undefined ? 1 : v);
  },

  /* HUD：当前 1～3 个模块与它们的 S 级组合名（§11）*/
  hudText() {
    if (!this.own.length) return '';
    const mods = this.own.map(id => TUNE.MODULES[id].name).join(' + ');
    const s = this.pairs().filter(p => p.tier === 'S' && p.info).map(p => p.info.name);
    return mods + (s.length ? ' → ' + s.join(' / ') : '');
  },

  describe() {
    const L = [];
    L.push('基础模块：' + (this.own.map(i => TUNE.MODULES[i].name).join(' · ') || '—'));
    const ps = this.pairs();
    L.push('组合反应：' + (ps.map(p => TUNE.MODULES[p.a].name + '×' + TUNE.MODULES[p.b].name +
      ' [' + p.tier + ']' + (p.info ? ' ' + p.info.name : '')).join('；') || '—'));
    const nz = Object.keys(this.nodes).filter(k => this.nodes[k] > 0);
    L.push('节点：' + (nz.map(k => NODE_MAP[k].name + (this.nodes[k] > 1 ? '×' + this.nodes[k] : '')).join(' · ') || '—'));
    L.push('形态分支：' + (this.branches.map(b => BRANCH_MAP[b].name).join(' · ') || '—'));
    L.push('规则改写：' + (this.rules.map(r => RULE_MAP[r].name).join(' · ') || '—'));
    return L;
  }
};

/* applyDerived 出口处必须是有限数的字段，以及它们出问题时的兜底值。 */
const NUMERIC_DERIVED = ['damage', 'fireInterval', 'magazine', 'bulletScale', 'knockback',
  'ammoPerShot', 'pellets', 'pierce', 'bounce', 'splitCount', 'blastRadius', 'blastDmg',
  'blastBudget', 'ocRampMax', 'ocRampTime', 'volleyFan', 'weaponHeavy'];
const NUMERIC_FALLBACK = {
  damage: TUNE.GUN.damage, fireInterval: TUNE.GUN.fireInterval, magazine: TUNE.GUN.magazine,
  bulletScale: 1, knockback: TUNE.GUN.knockback, ammoPerShot: 1, pellets: 1,
  blastBudget: 1, ocRampTime: 1, volleyFan: 0, weaponHeavy: 1
};

/* 模块 → 枪械器官挂点。todo2 已经做好六个器官，这里复用而不是造第二套外观系统。 */
const MODULE_ORGAN = {
  volley: 'fission', blast: 'blast', pierce: 'ossify', split: 'fission',
  heavy: 'giant', overclock: 'overclock', ricochet: 'conduct', momentum: 'overclock'
};
