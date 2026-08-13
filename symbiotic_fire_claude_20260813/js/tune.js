/* ============================================================================
   SYMBIOTIC FIRE · 调参数据层
   规格 v0.1 的所有数值集中在这里。行为定义不可改；数值可调。
   ========================================================================== */
'use strict';

const TUNE = {
  /* --- 单局结构 §11 --- */
  RUN_SECONDS: 720,               // 12:00
  BOSS_AT: 720,
  MIDBOSS_AT: 365,                // 06:05 —— 变异卡先出，Boss 后到
  MUTATION_TIMES: [45, 180, 360, 540],

  /* --- 玩家 3C §11.2 --- */
  PLAYER: {
    maxHp: 120,
    height: 1.68,
    radius: 0.42,
    moveSpeed: 6.2,
    accel: 62,
    friction: 12,
    dashSpeed: 21,
    dashTime: 0.17,
    dashCooldown: 2.1,
    dashIFrame: 0.26,
    hurtIFrame: 0.42,             // 全局受击无敌，防止怪堆瞬间融化玩家（可读性需要）
    mouseSens: 0.0021,
    fovBase: 76,
    fovSprintAdd: 4
  },

  /* --- 初始自动步枪 §11.3 --- */
  GUN: {
    damage: 12,
    fireInterval: 1 / 9,          // 9 发/秒
    magazine: 30,
    reloadTime: 1.55,
    spreadBase: 0.9,              // 度
    spreadBloom: 2.4,
    bloomPerShot: 0.26,
    bloomDecay: 3.4,
    recoil: 0.55,
    recoilRecover: 8,
    muzzleVel: 220,
    bulletLife: 0.9,
    pierce: 0,
    pellets: 1,
    weakpointMult: 2.0,
    knockback: 3.2
  },

  /* --- 经验 §29 ---
     曲线由数值反解得到，钉住两条硬性验收：首次升级 20–25s（§40）、总升级 18–25 次（§29）。
     注意：§29 另写"间隔从 25s 降到 15s"，这与 18–25 次在 720s 内不相容
     （25→15 线性收窄 ⟹ 约 37 级，而改装池总共只有 34 次可选，会被抽空）。
     取舍：保留"间隔收窄"的方向（41s → 24s），放弃绝对值。 */
  XP: {
    curveBase: 40,
    curveCoef: 8,
    curveExp: 0.90,
    pickupRadius: 2.6,
    magnetRadius: 7.5,            // 主动吸附
    autoHomeAfter: 9.0,           // §31 存在 8–12 秒后自动飞向玩家
    flySpeed: 15
  },

  /* --- 刷怪 §29 --- */
  SPAWN: {
    baseRate: 1.6,                // 每秒
    rateCoef: 8.0,
    rateExp: 1.4,
    aliveCap: 150,                // §35 性能目标
    minDist: 11,
    maxDist: 21,
    rearConeDeg: 100,             // §31 背后禁区
    rearMinDist: 17,              // 背后至少 17m ≈ 5.4 秒预警，仍比正面远
    frontBias: 0.65,              // 65% 刷在视野前方，保证"一直有怪打"
    hpScalePerMin: 0.26,
    dmgScalePerMin: 0.075,
    /* 保底在场数 —— 硬性要求：任何时刻都必须有怪可打。
       低于门槛就临时加速刷新，而不是一次性把人塞满（那会让怪凭空出现在视野里）。 */
    floorBase: 20,
    floorCoef: 108,
    floorExp: 0.85,
    floorTopUpRate: 30            // 低于保底时每秒额外补的只数
  },

  /* --- 变种投放 §26 --- */
  VARIANT: {
    perMutation: 0.08,            // 每种共同变异 +8%
    cap: 0.32,
    tutorialDelay: 12.0,          // §12.2 10–15 秒后才进入生成池
    tutorialDist: 17   // 场地缩小后必须跟着收，否则教学生成会顶到墙外
  },

  /* --- 触发链 §34/§35 --- */
  PROC: {
    maxDepth: 2,
    blastMaxGeneration: 2,
    splitProjectileCap: 128,
    lightningChain: 3,
    conductionHits: 6
  },

  /* --- 后期表现上限 §31 ---
     震屏纪律：位置抖动（相机平移）是晕动症的主因，几乎压到零；
     方向上只留很小的 roll。枪模型自己的后坐可以做大，那不晕。 */
  FX: {
    shakeMax: 0.55,
    shakeDecay: 4.5,
    shakePos: 0.03,               // 相机位移系数（原 0.16）
    shakePitch: 0.006,            // 俯仰抖动，最晕，压到最低
    shakeRoll: 0.010,
    recoilCamera: 0.012,          // 后坐传给相机的比例（原 0.06）
    recoilGunKick: 0.22,          // 后坐传给枪模型的比例（原 0.12，可以大）
    blastSoundMergeWindow: 0.06,
    maxConcurrentBlastFx: 24
  }
};

/* ============================================================================
   六种共同变异 §15–21
   每条既是数据也是文案；卡面只允许出现 you / horde 两句。
   ========================================================================== */
const MUTATIONS = [
  {
    id: 'blast', name: '爆裂', en: 'Detonation',
    color: 0xff8a1e, css: '#ff8a1e',
    you: '击杀会引爆尸体',
    horde: '爆裂尸死亡后爆炸',
    detail: '击杀时以尸体为中心爆炸，半径 3.2m，造成单发基础伤害的 80%。最多连续引爆 2 代。',
    hordeDetail: '爆裂尸死亡后闪烁 0.8 秒再爆炸，半径 3m，只伤害玩家。',
    player: { radius: 3.2, dmgRatio: 0.80 },
    enemy: { fuse: 0.8, radius: 3.0, dmg: 22 }
  },
  {
    id: 'fission', name: '分裂', en: 'Fission',
    color: 0xb060ff, css: '#b060ff',
    you: '子弹命中后分裂×2',
    horde: '裂变尸死亡后生出幼体',
    detail: '主弹首次命中后向附近目标分出 2 枚子弹，伤害为主弹的 45%。分裂弹不能再分裂。',
    hordeDetail: '裂变尸死亡后生成 2 只幼体，生命为母体的 20%，不掉经验，不再分裂。',
    player: { count: 2, dmgRatio: 0.45, searchRange: 16 },
    enemy: { count: 2, hpRatio: 0.20 }
  },
  {
    id: 'overclock', name: '超频', en: 'Overclock',
    color: 0xff3355, css: '#ff3355',
    you: '持续射击会越来越快',
    horde: '超频尸移动和攻击更快',
    detail: '持续按住射击 2 秒达到上限，射速最高提高 45%。停火 0.6 秒后开始衰减，换弹保留一半进度。',
    hordeDetail: '超频尸移速 +45%、攻击间隔 -25%，但最大生命 -20%。',
    player: { rampTime: 2.0, maxBonus: 0.45, holdGrace: 0.6, decayRate: 0.55, reloadKeep: 0.5 },
    enemy: { speedMult: 1.45, atkMult: 0.75, hpMult: 0.80 }
  },
  {
    id: 'ossify', name: '骨化', en: 'Ossification',
    color: 0xf0f4ff, css: '#e8eeff',
    you: '子弹获得额外贯穿',
    horde: '骨甲尸正面有三层骨板',
    detail: '所有子弹贯穿 +2。每贯穿一个敌人，下一次命中伤害 +10%，最多 +30%。',
    hordeDetail: '骨甲尸正面命中会优先击碎一层骨板并抵消该次伤害，三层碎尽才暴露。背后与头部可绕过。',
    player: { pierce: 2, rampPerPierce: 0.10, rampMax: 0.30 },
    enemy: { plates: 3, frontDot: 0.25 }
  },
  {
    id: 'conduct', name: '电导', en: 'Conduction',
    color: 0x35e0ff, css: '#35e0ff',
    you: '连续命中释放连锁闪电',
    horde: '电尸死亡后留下电场',
    detail: '每累计 6 次命中触发一次连锁闪电，最多跳 3 个目标，每跳造成单发基础伤害的 55%。',
    hordeDetail: '电尸死亡后地面预警 0.7 秒，随后生成半径 2.8m、持续 2.5 秒的电场。',
    player: { hits: 6, jumps: 3, dmgRatio: 0.55, jumpRange: 12 },
    enemy: { telegraph: 0.7, radius: 2.8, duration: 2.5, tick: 0.5, dmg: 9 }
  },
  {
    id: 'giant', name: '巨化', en: 'Gigantism',
    color: 0xffd21e, css: '#ffd21e',
    you: '子弹变大并强化击退',
    horde: '巨尸更强但经验更多',
    detail: '子弹体积 +60%、击退 +50%、基础伤害 +15%。射速不变。',
    hordeDetail: '巨尸体型 2.1 倍、生命 3 倍、伤害 +50%、移速 -35%，掉落经验 3.5 倍。',
    player: { sizeMult: 1.6, knockMult: 1.5, dmgMult: 1.15 },
    enemy: { scale: 2.1, hpMult: 3.0, dmgMult: 1.5, speedMult: 0.65, xpMult: 3.5, weight: 0.5 }
  }
];

const MUT = {};
MUTATIONS.forEach(m => { MUT[m.id] = m; });

/* ============================================================================
   19 个普通改装 §23
   kind: fire | chain | life   ——  §24 的三选一生成规则要用
   ========================================================================== */
const MODS = [
  /* --- 基础火力 --- */
  { id: 'caliber',   kind: 'fire', name: '大口径',   text: '子弹伤害提高',       detail: '伤害 +25%',                       max: 3 },
  { id: 'bolt',      kind: 'fire', name: '轻量枪机', text: '射速提高',           detail: '射速 +18%',                       max: 3 },
  { id: 'mag',       kind: 'fire', name: '扩容弹匣', text: '弹匣容量提高',       detail: '弹匣 +40%',                       max: 2 },
  { id: 'reload',    kind: 'fire', name: '快速装填', text: '换弹速度提高',       detail: '换弹时间 -25%',                   max: 2 },
  { id: 'stable',    kind: 'fire', name: '稳定框架', text: '散布与后坐降低',     detail: '散布 -25%，后坐 -20%',            max: 2 },
  { id: 'optic',     kind: 'fire', name: '瞄准模块', text: '弱点伤害提高',       detail: '弱点倍率 +0.5',                   max: 2 },
  { id: 'twin',      kind: 'fire', name: '双联枪管', text: '每次额外发射一枚子弹', detail: '弹丸 +1，单弹伤害 ×0.72',        max: 1 },
  { id: 'execute',   kind: 'fire', name: '处决弹头', text: '对濒死目标增伤',     detail: '对 30% 生命以下目标 +40%',        max: 1 },

  /* --- 触发链 --- */
  { id: 'catalyst',  kind: 'chain', name: '催化增幅', text: '共同变异伤害提高',   detail: '变异伤害 +25%',                   max: 2 },
  { id: 'spread',    kind: 'chain', name: '扩散培养', text: '爆炸、电场与链选范围提高', detail: '范围 +20%',                 max: 2 },
  { id: 'feedback',  kind: 'chain', name: '神经回授', text: '触发共同变异后返还弹药', detail: '每次有效触发返还 1 发，每秒最多 4 发', max: 1, req: 1 },
  { id: 'hunter',    kind: 'chain', name: '猎群算法', text: '分裂与闪电优先寻找满血目标', detail: '同时使搜索距离 +25%',      max: 1 },
  { id: 'aftershock',kind: 'chain', name: '余震',     text: '击退目标撞到其他敌人会造成伤害', detail: '单发基础伤害的 50%',    max: 1 },
  { id: 'cascade',   kind: 'chain', name: '连锁许可', text: '次级效果可以再触发一次其他变异', detail: '受全局触发深度限制',    max: 1, req: 2, rare: true },

  /* --- 生存与节奏 --- */
  { id: 'stim',      kind: 'life', name: '强心剂',   text: '移动速度提高',       detail: '移速 +12%',                       max: 2 },
  { id: 'dashcd',    kind: 'life', name: '应激冲刺', text: '冲刺更快恢复',       detail: '冷却 -20%',                       max: 2 },
  { id: 'trauma',    kind: 'life', name: '创伤修复', text: '每累计击杀恢复生命', detail: '每 30 杀恢复 2% 最大生命',        max: 2 },
  { id: 'armor',     kind: 'life', name: '皮下护甲', text: '最大生命提高',       detail: '最大生命 +20% 并等额治疗',        max: 2 },
  { id: 'magnet',    kind: 'life', name: '磁性采集', text: '经验吸附范围提高',   detail: '吸附范围 +50%',                   max: 2 }
];

const MODMAP = {};
MODS.forEach(m => { MODMAP[m.id] = m; });

/* ============================================================================
   敌人模板 §25
   变种不是任意敌人叠 buff —— 只有 grunt 会被替换成变种模板。
   ========================================================================== */
const ENEMIES = {
  grunt: {
    id: 'grunt', name: '普通丧尸',
    hp: 30, speed: 3.15, dmg: 9, atk: 1.0, xp: 1,
    radius: 0.46, height: 1.75, mass: 1,
    color: 0x93a68c, accent: 0xbccbb0,
    canVariant: true
  },
  heavy: {
    id: 'heavy', name: '重型丧尸',
    hp: 175, speed: 1.75, dmg: 20, atk: 1.7, xp: 5,
    radius: 0.82, height: 2.25, mass: 3.4,
    color: 0x7d8270, accent: 0xa9ae95,
    knockResist: 0.62
  },
  spitter: {
    id: 'spitter', name: '吐酸者',
    hp: 58, speed: 2.35, dmg: 11, atk: 2.6, xp: 3,
    radius: 0.5, height: 1.8, mass: 1.1,
    color: 0x93a84f, accent: 0xc8e063,
    ranged: { range: 17, projSpeed: 17, poolRadius: 2.4, poolTime: 3.4, poolTick: 0.5, poolDmg: 7, windup: 0.75 }
  },
  charger: {
    id: 'charger', name: '冲撞精英',
    hp: 420, speed: 3.0, dmg: 28, atk: 1.5, xp: 22,
    radius: 0.92, height: 2.35, mass: 5,
    color: 0xa85b4c, accent: 0xf07a60,
    elite: true, knockResist: 0.8,
    charge: { range: 20, windup: 0.95, speed: 17, duration: 1.5, cooldown: 4.2, dmg: 40 }
  },
  midboss: {
    id: 'midboss', name: '肉山',
    hp: 3400, speed: 2.15, dmg: 34, atk: 1.8, xp: 90,
    radius: 1.7, height: 3.6, mass: 14,
    color: 0x95505c, accent: 0xe87c8c,
    boss: true, knockResist: 0.95,
    slam: { range: 6.5, windup: 1.0, radius: 7.5, dmg: 32, cooldown: 5.5 },
    summon: { count: 6, cooldown: 9.0 }
  },
  king: {
    id: 'king', name: '尸王',
    hp: 26000, speed: 2.5, dmg: 40, atk: 1.6, xp: 0,
    radius: 2.3, height: 4.8, mass: 30,
    color: 0x6e4256, accent: 0xff7f96,
    boss: true, king: true, knockResist: 1.0,
    slam: { range: 8, windup: 1.05, radius: 9.5, dmg: 34, cooldown: 4.6 },
    summon: { count: 8, cooldown: 8.0 }
  }
};

/* 变种模板：从 grunt 派生，只改 §16–21 定义的那几项 */
function variantTemplate(mutId) {
  const base = ENEMIES.grunt, m = MUT[mutId], e = m.enemy;
  const t = Object.assign({}, base);
  t.id = 'v_' + mutId;
  t.variant = mutId;
  t.color = m.color;
  t.accent = m.color;
  t.name = { blast: '爆裂尸', fission: '裂变尸', overclock: '超频尸', ossify: '骨甲尸', conduct: '电尸', giant: '巨尸' }[mutId];
  if (mutId === 'overclock') { t.speed *= e.speedMult; t.atk *= e.atkMult; t.hp *= e.hpMult; }
  if (mutId === 'giant') {
    t.hp *= e.hpMult; t.dmg *= e.dmgMult; t.speed *= e.speedMult; t.xp *= e.xpMult;
    t.radius *= e.scale; t.height *= e.scale; t.mass *= 4; t.knockResist = 0.75;
  }
  if (mutId === 'ossify') { t.plates = e.plates; }
  return t;
}

/* 时间轴 §28 —— 只放"节奏事件"，不放刷怪常规逻辑 */
const TIMELINE = [
  { t: 210, kind: 'intro', enemy: 'heavy',   note: '重型丧尸加入' },
  { t: 250, kind: 'intro', enemy: 'spitter', note: '吐酸者加入' },
  { t: 330, kind: 'squad', enemy: 'charger', count: 1, note: '冲撞精英' },
  { t: 365, kind: 'boss',  enemy: 'midboss', note: '肉山' },
  { t: 470, kind: 'squad', enemy: 'charger', count: 2 },
  { t: 600, kind: 'squad', enemy: 'charger', count: 3 },
  { t: 690, kind: 'surge', note: '撤离倒计时' },
  { t: 720, kind: 'boss',  enemy: 'king',    note: '尸王' }
];
