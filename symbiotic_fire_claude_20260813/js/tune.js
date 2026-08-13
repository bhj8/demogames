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
    weakpointMult: 2.5,   // todo P1：修好判定后的首轮值（12×2.5=30，开局一枪爆头）
    knockback: 3.2
  },

  /* --- 经验与节奏 ---
     静态经验曲线已废弃：它隐含一个不存在的“平均玩家”。
     实际上不同 build 的吞吐差 5–10 倍，任何固定曲线只能服务其中一种。
     改成两层动态控制（详见 game.js 的 nextRequirement）。 */
  XP: {
    pickupRadius: 2.6,
    magnetRadius: 7.5,            // 主动吸附
    autoHomeAfter: 9.0,           // §31 存在 8–12 秒后自动飞向玩家
    flySpeed: 15,
    crossLayerDelay: 2.5          // todo3 §6.1 玩家离开该层后多久进入跨层追踪
  },

  /* --- 节奏控制器 ---
     目标：约 30 秒一次升级 → 720/30 = 24 次，改装池 34 项取走 71%。

     内层：下一级的需求 = 你最近的经验速率 × targetInterval。
       需求只在升级瞬间改变，而进度条那一刻正好归零 —— 所以不可见。
       速率用长窗口（rateHalfLife）：短期爆发会真的升得快（保留波动），
       长期 build 强度会被窗口追上、归一化掉。

     外层：期望等级 vs 实际等级的漂移纠正，带死区。 */
  PACING: {
    targetInterval: 34,           /* 设 34 而不是 30：EMA 滞后会系统性把需求定低
                                     （收入上升时总是按旧速率定价）。
                                     校准实测：34 → 实际 24–25 级、均间隔 ≈29.4 秒。 */
    firstLevelAt: 22,             // 首次升级时点（§40 要求 20–25s）
    rateHalfLife: 75,             // 经验速率 EMA 半衰期，决定允许多大波动
    deadband: 1.0,                // ±1 级以内完全不干预 —— build 的体感差别靠它保住
    fullAt: 4.0,                  // ±4 级达到满纠正
    minReqMult: 0.45,             // 落后时需求最低打到 45%（补偿慊慨）
    maxReqMult: 1.80,             // 超前时需求最高 180%（压制克制）
    suppressFadeStart: 540,       // 9:00 起压制淡出
    suppressFadeEnd: 600,         // 10:00 完全放飞
    reqStepMin: 0.60,             // 相邻两级的需求变化限幅，避免狂振
    reqStepMax: 1.90,
    bootstrapXp: 18               // 第 1 级的固定需求（此时还没有速率样本）
  },

  /* --- 刷怪 §29 --- */
  SPAWN: {
    aliveCap: 150,                // §35 性能目标
    minDist: 15,                  // 硬性：绝不在玩家 15m 内刷怪
    maxDist: 24,
    rearConeDeg: 100,             // §31 背后禁区
    rearMinDist: 19,              // 背后更远，留出预警时间
    frontBias: 0.65,              // 65% 刷在视野前方，保证"一直有怪打"
    hpScalePerMin: 0.26,
    dmgScalePerMin: 0.075,

    /* 刷怪规则：只有一个目标在场数。
       比目标缺得越多，刷得越快；即使不缺，最慢也 3 秒来一只。
       这样开局压力不会拉满，被清场后又能迅速补上。 */
    targetBase: 10,
    targetCoef: 80,
    targetExp: 0.9,
    maxInterval: 3.0,             // 不缺人时的最慢间隔
    minInterval: 0.05,            // 缺口很大时的最快间隔
    deficitGain: 1.2              // 缺 1 只，刷怪频率提高多少
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

  /* --- 背后威胁三阶段提示（todo.md P0）---
     四面包围保留，公平性交给提示系统，而不是靠“少刷背后”掩盖。 */
  THREAT: {
    sectors: 8,                   // 玩家周围分 8 个方向扇区
    maxShown: 3,                  // 同时最多显示 3 个扇区
    warnRange: 12,                // 一般威胁距离
    warnTtc: 2.5,                 // 或预计 2.5 秒内接触
    dangerRange: 6,               // 升级为红色的距离
    dangerTtc: 1.2,
    meleeWindup: 0.5,             // 普通近战攻击前摇，不再接触即扣血
    sectorMaxScore: 6             // 弧宽/亮度饱和所需的分数
  },

  /* --- 自适应医疗掉落（todo.md P0）---
     不用固定击杀数也不用纯随机 —— 那会造成顺风局满地医疗、逆风局迟迟不掉。 */
  MEDICAL: {
    triggerHpFrac: 0.70,          // 生命 ≤ 70% 才开始积累需求
    healFrac: 0.20,               // 恢复最大生命的 20%
    lifetime: 30,
    cooldown: 35,
    needThreshold: 20,
    decayAbove: 0.5,              // HP > 70% 时每秒衰减
    gainBand70: 0.45,             // 50% < HP ≤ 70%
    gainBand50: 1.0,              // 35% < HP ≤ 50%
    gainBand35: 2.0,              // HP ≤ 35%
    band50: 0.50,
    band35: 0.35,
    pickupRadius: 1.7,            // 主动接触，不自动吸附
    offscreenHpFrac: 0.50         // 残血时才显示屏外方向标
  },

  /* --- 半动态战术空投（todo.md P1）---
     不是一局三次的播片；目标一局 7“9 次，反复产生“要不要偏离安全路线”的决策。 */
  AIRDROP: {
    firstAt: 55,                  // 首次固定，用于教学
    baseInterval: 75,             // 自然充满所需
    minInterval: 45,              // 再快也不得更短
    maxInterval: 90,              // 到点无视进度强制排队
    lastCallBy: 650,              // 10:50 前仍未触发则强制投放
    stopAfter: 690,               // 11:30 后不再新投
    telegraph: 5,                 // 坠落预告
    lifetime: 35,                 // 落地后可拾取时长
    buffDuration: 14,             // 拾取后强化时长
    minDist: 18, maxDist: 24,
    bossGrace: 10,                // Boss 登场演出后至少等多久
    moduleSpread: 2.4,            // 三个模块围着舱体的半径
    pickupRadius: 1.5,
    /* 击杀加速（占满进度的比例）—— 强玩家略早拿到，但弱玩家不会永远拿不到 */
    chargeKill: 0.001,
    chargeElite: 0.06,
    chargeBoss: 0.18,
    /* 三个首发模块 */
    ammoFireRate: 0.20,           // 过载供弹：射速 +20%，弹匣不减
    adrenSpeed: 0.35,             // 肾上腺素：移速 +35%
    adrenDashCd: 0.50,            // 冲刺冷却 -50%
    shieldAbsorb: 60,             // 相位护盾：吸收 60 点
    shieldMax: 15                 // 或 15 秒，先到先结束
  },

  /* --- 枪械表现（todo2.md）---
     所有手感参数集中在这里，weapon.js 里不允许出现魔法数字。
     需要强调的一条：震感来自多层反馈在同一时刻对齐，
     而不是画面随机乱晃 —— 相机与枪模的后坐倒数必须独立。 */
  WEAPON_FX: {
    rigScale: 0.72,

    /* 姿态基准位（腰射 / 稳枪） */
    hipX: 0.24, hipY: -0.21, hipZ: -0.66,
    adsX: 0.005, adsY: -0.115, adsZ: -0.50,
    adsSwayScale: 0.35,
    adsFov: -9,                    // 视野轻微收窄
    poseBlend: 12,

    /* 每枪冲击（弹簧）与持续累积，两条通道分开可调 */
    kickStiffness: 260, kickDamping: 15,
    shotKickZ: 1.5, shotKickPitch: 2.6, shotKickRoll: 1.1,
    climbPerShot: 0.010, climbMax: 0.075, climbDecay: 0.14,
    viewmodelRecoilScale: 0.055,   // 枪模后坐：可以很大
    cameraRecoilScale: 0.0075,     // 相机后坐：必须很小，且方向确定
    cameraYawScale: 0.0022,

    /* 枪机 */
    boltStiffness: 900, boltDamping: 26,
    boltKick: 4.2, boltTravel: 0.075,

    /* 步态 / 呼吸 / 鼠标惯性摆动 */
    bobRate: 1.9, bobAmpX: 0.016, bobAmpY: 0.012,
    breathAmp: 0.0035,
    swayGain: 0.55, swayK: 0.10, swayD: 0.28, swayMax: 0.055,
    swayYaw: 0.55, swayRoll: 0.42,
    strafeLean: 0.45, forwardLag: 0.35,

    /* 冲刺与换弹姿态 */
    sprintX: 0.05, sprintY: -0.07, sprintPitch: 0.22, sprintYaw: -0.30, sprintRoll: 0.18,
    reloadDrop: -0.10, reloadPitch: 0.30,
    dashKick: 1.2, dryKick: 0.6,

    /* 枪口 */
    flashScale: 0.115, flashOuterOpacity: 0.85, flashCoreOpacity: 1.0, flashDecay: 26,
    muzzleLightPeak: 2.4, muzzleLightRange: 3.2, worldFlashPeak: 2.2,

    /* 曳光 */
    tracerCap: 64, tracerLife: 0.055, tracerLength: 9,

    /* 抛壳与弹匣 */
    shellCap: 72, shellLife: 3.2, shellScale: 1.0,
    shellVelX: 3.4, shellVelY: 2.2,
    magLife: 6.0,

    /* 分阶段换弹的时间点（占总时长的比例）——
       用比例才能保证快速装填升级同比例加速整套动作与事件点 */
    reloadPhases: { magOut: 0.13, magFall: 0.30, magIn: 0.58, bolt: 0.82 },
    emptyBeat: 0.12               // 自动换弹前的空仓瞬间，让最后一发有结束感
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
    /* 后坐已迁到 WEAPON_FX 的 cameraRecoilScale / viewmodelRecoilScale（todo2 §4 要求两者独立） */
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
    id: 'grunt',
    /* 弱点球：yRatio / 前后偏移 / 半径，均为身高的比例（对齐 render.js 的模型头部） */
    weak: { y: 0.899, fwd: 0.010, r: 0.139 }, name: '普通丧尸',
    hp: 30, speed: 3.15, dmg: 9, atk: 1.0, xp: 1,
    radius: 0.46, height: 1.75, mass: 1,
    color: 0x93a68c, accent: 0xbccbb0,
    canVariant: true
  },
  heavy: {
    id: 'heavy',
    /* 弱点球：yRatio / 前后偏移 / 半径，均为身高的比例（对齐 render.js 的模型头部） */
    weak: { y: 0.854, fwd: 0.017, r: 0.161 }, name: '重型丧尸',
    hp: 175, speed: 1.75, dmg: 20, atk: 1.7, xp: 5,
    radius: 0.82, height: 2.25, mass: 3.4,
    color: 0x7d8270, accent: 0xa9ae95,
    knockResist: 0.62
  },
  spitter: {
    id: 'spitter',
    /* 弱点球：yRatio / 前后偏移 / 半径，均为身高的比例（对齐 render.js 的模型头部） */
    weak: { y: 0.880, fwd: 0.080, r: 0.156 }, name: '吐酸者',
    hp: 58, speed: 2.35, dmg: 11, atk: 2.6, xp: 3,
    radius: 0.5, height: 1.8, mass: 1.1,
    color: 0x93a84f, accent: 0xc8e063,
    ranged: { range: 17, projSpeed: 17, poolRadius: 2.4, poolTime: 3.4, poolTick: 0.5, poolDmg: 7, windup: 0.75 }
  },
  charger: {
    id: 'charger',
    /* 弱点球：yRatio / 前后偏移 / 半径，均为身高的比例（对齐 render.js 的模型头部） */
    weak: { y: 0.660, fwd: 0.264, r: 0.185 }, name: '冲撞精英',
    hp: 420, speed: 3.0, dmg: 28, atk: 1.5, xp: 22,
    radius: 0.92, height: 2.35, mass: 5,
    color: 0xa85b4c, accent: 0xf07a60,
    elite: true, knockResist: 0.8,
    charge: { range: 20, windup: 0.95, speed: 17, duration: 1.5, cooldown: 4.2, dmg: 40 }
  },
  midboss: {
    id: 'midboss',
    /* 弱点球：yRatio / 前后偏移 / 半径，均为身高的比例（对齐 render.js 的模型头部） */
    weak: { y: 0.788, fwd: 0.025, r: 0.156 }, name: '肉山',
    hp: 3400, speed: 2.15, dmg: 34, atk: 1.8, xp: 90,
    radius: 1.7, height: 3.6, mass: 14,
    color: 0x95505c, accent: 0xe87c8c,
    boss: true, knockResist: 0.95,
    slam: { range: 6.5, windup: 1.0, radius: 7.5, dmg: 32, cooldown: 5.5 },
    summon: { count: 6, cooldown: 9.0 }
  },
  king: {
    id: 'king',
    /* 弱点球：yRatio / 前后偏移 / 半径，均为身高的比例（对齐 render.js 的模型头部） */
    weak: { y: 0.788, fwd: 0.025, r: 0.156 }, name: '尸王',
    hp: 26000, speed: 2.5, dmg: 40, atk: 1.6, xp: 0,
    radius: 2.3, height: 4.8, mass: 30,
    color: 0x6e4256, accent: 0xff7f96,
    boss: true, king: true, knockResist: 1.0,
    slam: { range: 8, windup: 1.05, radius: 9.5, dmg: 34, cooldown: 4.6 },
    summon: { count: 8, cooldown: 8.0 }
  },

  /* --- todo3 §5.1 三类垂直威胁 ---
     navKind 决定它能走哪些连接边（CITY.links 的 allow 列表）。
     普通敌人只有 'grunt'，因此屋顶不会被普通尸潮直接淹没，
     但每个屋顶都至少存在一种敌人入侵方式（见 _citycheck 的 roof_enemy_access）。 */
  climber: {
    id: 'climber', navKind: 'climber',
    weak: { y: 0.899, fwd: 0.010, r: 0.139 }, name: '攀爬感染者',
    hp: 42, speed: 3.4, dmg: 10, atk: 1.1, xp: 2,
    radius: 0.44, height: 1.7, mass: 0.9,
    color: 0x6f8f9c, accent: 0xa8d4e0,
    vertical: 'climb'
  },
  leaper: {
    id: 'leaper', navKind: 'leaper',
    weak: { y: 0.870, fwd: 0.060, r: 0.150 }, name: '跳跃感染者',
    hp: 56, speed: 3.0, dmg: 16, atk: 1.6, xp: 4,
    radius: 0.48, height: 1.72, mass: 1.1,
    color: 0x9c7f5a, accent: 0xe0c08a,
    vertical: 'leap',
    leap: { range: 14, windup: 0.75, speed: 13, cooldown: 5.0, dmg: 18, recover: 0.9 }
  },
  roofcaster: {
    id: 'roofcaster', navKind: 'ranged',
    weak: { y: 0.880, fwd: 0.080, r: 0.156 }, name: '远程感染者',
    hp: 64, speed: 2.1, dmg: 12, atk: 3.0, xp: 4,
    radius: 0.5, height: 1.82, mass: 1.1,
    color: 0x8a5f9c, accent: 0xd0a0e8,
    vertical: 'ranged',
    /* 作用是迫使玩家换位，不是持续制造无法躲避的伤害（§5.1） */
    ranged: { range: 26, projSpeed: 15, poolRadius: 2.6, poolTime: 2.2, poolTick: 0.6, poolDmg: 6, windup: 0.9 }
  }
};

/* 既有敌人全部按“只能走地面与楼梯”处理 */
['grunt', 'heavy', 'spitter', 'charger', 'midboss', 'king'].forEach(k => { ENEMIES[k].navKind = 'grunt'; });

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
  /* todo3 §4.3～§4.6：垂直威胁按阶段进场。
     攀爬怪 100s 少量出现（§4.3「少量展示攀爬行为」），180s 正式加入。 */
  { t: 100, kind: 'intro', enemy: 'climber', note: '有东西在爬墙', quiet: true, city: true },
  { t: 180, kind: 'intro', enemy: 'climber', note: '攀爬感染者', city: true },
  { t: 330, kind: 'intro', enemy: 'leaper',  note: '跳跃感染者', city: true },
  { t: 430, kind: 'intro', enemy: 'roofcaster', note: '远程感染者', city: true },
  { t: 210, kind: 'intro', enemy: 'heavy',   note: '重型丧尸加入' },
  { t: 250, kind: 'intro', enemy: 'spitter', note: '吐酸者加入' },
  { t: 330, kind: 'squad', enemy: 'charger', count: 1, note: '冲撞精英' },
  { t: 365, kind: 'boss',  enemy: 'midboss', note: '肉山' },
  { t: 470, kind: 'squad', enemy: 'charger', count: 2 },
  { t: 600, kind: 'squad', enemy: 'charger', count: 3 },
  { t: 690, kind: 'surge', note: '撤离倒计时' },
  { t: 720, kind: 'boss',  enemy: 'king',    note: '尸王' }
];
/* updateTimeline 按顺序消费，插入垂直威胁后必须重新排好序 */
TIMELINE.sort((a, b) => a.t - b.t);

/* ============================================================================
   todo3 —— 立体城市 / 统一进化 / 构筑化学反应
   全部集中在这里。todo3 §1 明确要求：新增移动、地图与构筑数值不得散落在 game.js。
   ========================================================================== */

/* --- 功能开关 §1 ---
   任一开关关闭时，对应系统退回 todo/todo2 的既有实现。
   ?map=flat 会把全部 todo3 开关一次性关掉，回到平面版本。 */
TUNE.FEATURES = {
  verticalMovement: true,    // Y 轴、跳跃、攀爬、墙跑、空中冲刺
  verticalEnemies: true,     // 敌人分层寻路、攀爬与立体刷新
  dynamicMapEvents: true,    // 地图结构事件
  unifiedEvolution: true,    // 统一进化、品质抽取与候选生成
  buildSynergy: true,        // 基础反应、连接、融合与终局规则
  mapBuildInfluence: true,   // 地图能力卡与风险行为对下一抽的影响
  hordeEvolution: true       // 玩家选择对变体、融合精英与 Boss 的映射
};

/* --- 玩家机动 §2.3 ---
   数值是首轮起点。手感目标比具体数值更重要：宽容、不断流、不要求像素级对边。 */
TUNE.MOVEMENT = {
  gravity: 21,
  jumpSpeed: 8.2,
  coyoteTime: 0.12,
  jumpBuffer: 0.15,
  airControl: 0.42,          // 空中相对地面的加速度比例
  airDrag: 0.55,

  vaultMaxHeight: 1.2,       // 自动翻越
  stepHeight: 0.42,          // 低于此高度直接抬脚，不播翻越
  vaultTime: 0.20,
  mantleMaxHeight: 2.4,      // 抓边攀爬
  mantleTime: 0.34,
  mantleProbe: 0.85,         // 前向探测距离
  headroom: 1.75,            // 落脚点上方所需净空，不足不允许爬进模型

  wallClimbTime: 0.55,       // 垂直登墙持续
  wallClimbSpeed: 5.4,
  wallClimbCooldown: 0.5,
  wallRunTime: 1.1,          // 横向墙跑上限
  wallRunSpeed: 8.6,
  wallRunGravity: 2.6,       // 墙跑期间的残余重力
  wallRunRise: 1.5,          // 起步时的轻微上抬
  wallRunStickDist: 0.75,
  wallRunMinSpeed: 3.2,
  wallRunGrace: 0.16,        // 离墙输入宽限
  wallRunCameraTilt: 0.13,   // §8.4 只允许轻微、方向确定的倾斜

  airDashCharges: 1,         // 地面与空中共用一次，接触稳定地面后恢复
  airDashTime: 0.19,
  airDashSpeed: 23,

  slideMinSpeed: 6.0,
  slideTime: 0.7,
  slideSpeed: 11.5,
  slideFriction: 5.5,
  slideHeight: 0.95,

  zipSpeed: 15.5,
  zipSnapDist: 2.6,
  padImpulse: 13.5,
  padRearm: 0.9,             // 跳板再装填：站在板上不允许被无限弹起

  landHardVel: 12,           // 以上算重着陆（只作用于枪模与短暂镜头压缩）
  landRecover: 0.18,
  fallDamage: false,         // 第一版不造成坠落伤害
  stableCam: false           // “稳定跑酷镜头”设置
};

/* --- 立体城市 §3 --- */
TUNE.VERTICAL_MAP = {
  half: 35,                  // 70×70m
  streetTop: 3,              // 街道层 0～3
  midTop: 10,                // 建筑中层 4～10
  roofTop: 20,               // 屋顶层 12～20
  spawnCell: 6               // 碰撞宽相位网格
};

/* --- 立体敌人 §5 --- */
TUNE.VERTICAL_ENEMY = {
  climbSpeed: 2.6,
  climbTelegraph: 0.7,       // 抓墙预警
  climbRecover: 0.45,        // 到达平台后的恢复窗口
  leapWindup: 0.75,
  leapSpeed: 13,
  leapMaxDist: 14,
  leapCooldown: 5.0,
  leapRecover: 0.9,          // 扑击失败后的可惩罚窗口
  rangedWindup: 0.9,
  rangedRange: 26,
  rangedCooldown: 3.4,
  rangedDmg: 12,
  navRepathInterval: 0.75,
  navStuckTime: 2.5,         // 超时重新选路，不许堆在墙脚
  layerShareSame: 0.62,      // 目标数量在玩家所在层的占比
  layerShareAdj: 0.28,       // 相邻层
  antiCampRadius: 9,
  antiCampStage1: 8,         // 秒：提高攀爬压力
  antiCampStage2: 16,        // 秒：加入跳跃截击
  antiCampStage3: 26,        // 秒：加入远程压制
  antiCampDecay: 2.5         // 离开区域后的恢复速率
};

/* --- 地图事件 §4.5 / §4.7 --- */
TUNE.MAP_EVENT = {
  windows: [[360, 420], [450, 520], [540, 600]],  // 时间窗口，不是唯一固定秒数
  perRun: 2,                 // 每局从池中选 1～2 个持久事件
  maxPerRun: 3,
  telegraph: 4.0,            // 环境声音、灯光与地面提示的提前量
  safeWindowRetry: 2.0,      // 撞上选择界面/Boss/攀爬时的重试间隔
  minGapSameLayer: 1         // 同一局避免连续两次只影响同一层
};

/* --- 统一进化节奏 §4.2 --- */
TUNE.EVOLUTION = {
  targetCount: 15,           // 目标 15 次，允许 14～16
  firstAt: 25,               // 第一次预计 0:22～0:30
  firstWindow: [22, 30],
  intervalMin: 32,           // 常态间隔 32～50 秒（从上次选择关闭后计算）
  intervalMax: 50,
  hardFloor: 25,             // 两次界面之间的硬下限
  lastBy: 630,               // 10:30 前由导演主动安排最后一次
  lastWindow: [590, 630],    // 最后一次预计 9:50～10:30
  cutoff: 630,               // 10:30 后不再生成新选择
  originByDraw: 4,           // 第 4 次进化结束时必须已有两个基础变异
  maxBaseMutations: 3,       // 每局最多 3 个基础变异
  minBaseMutations: 2,
  relevantMin: 2,            // 至少 2 张候选与当前构筑直接相关
  /* 进度定价：沿用 PACING 的两层控制。目标平均间隔 =(cutoff-firstAt)/(targetCount-1)≈43s；
     EMA 滞后会系统性把需求定低，所以 progressBase 要比目标间隔高一截，
     具体值由 testsim 的 100/10000 局模拟校准，不是拍的。 */
  progressBase: 50,
  firstNeed: 22,             // 第一次进化的固定需求（此时还没有收入样本）
  driftDeadband: 0.8,        // ±0.8 次以内完全不干预
  driftFullAt: 3.0,
  driftMin: 0.40,            // 落后时需求最低 40%
  driftMax: 2.20,            // 超前时需求最高 220%
  safeDelayMax: 12           // 安全窗口最多延迟多久，超过则强制弹出
};

/* --- 品质概率 §7.3 ---
   分段按 [起, 止, 普通, 稀有, 史诗, 传奇]，10:30 后不再生成选择。 */
TUNE.RARITY = {
  order: ['common', 'rare', 'epic', 'legend'],
  name: { common: '普通', rare: '稀有', epic: '史诗', legend: '传奇' },
  css: { common: '#c8d4e0', rare: '#4fa8ff', epic: '#b060ff', legend: '#ffb020' },
  bands: [
    { from: 0,   to: 180, w: { common: 0.70, rare: 0.27, epic: 0.03, legend: 0.00 } },
    { from: 180, to: 480, w: { common: 0.52, rare: 0.33, epic: 0.13, legend: 0.02 } },
    { from: 480, to: 630, w: { common: 0.38, rare: 0.35, epic: 0.21, legend: 0.06 } }
  ],
  revealTime: 0.42           // §7.10 先揭示整体品质 0.35～0.5 秒，再展开三张
};

/* --- 保底 §7.4：只限制坏运气，不限制好运气 --- */
TUNE.PITY = {
  commonStreak: 3,           // 连续 3 次普通后，下一次至少稀有
  epicByTime: 450,           // 7:30 仍未出现史诗或传奇
  noLegendPity: true,        // 传奇永不保底
  noReverseBalance: true,    // 不做“连续高品质后强制普通”
  linkBiasAfter: 2           // 已有两个基础变异却长期没有连接时，抬高连接卡权重
};

/* --- 地图行为对下一抽的修正 §7.8 --- */
TUNE.MAP_BUILD = {
  roofDropEpicBonus: 0.08,   // 屋顶空投：史诗 +8 个百分点，从普通里扣
  qualityBonusCap: 0.12,     // 品质奖励叠加上限
  tagBiasMult: 1.8,          // 标签权重 ×1.8
  eliteHuntMinQuality: 'rare',
  bannerTime: 6.0            // HUD 上修正提示的显示时长
};

/* --- 效果预算 §7.7 / §12 性能 ---
   所有连锁统一经过它，禁止各卡自行无限生成对象。 */
TUNE.EFFECT_BUDGET = {
  perSecond: 220,            // 每秒可生成的效果事件总量
  perFrame: 48,
  maxDepth: 3,               // 融合与传奇的最大递归深度
  perTargetPerChain: 1,      // 同一根攻击对同一目标的同类效果次数
  spawnCapProjectile: 220,
  spawnCapZone: 28,
  soundConcurrent: 6         // 同一连锁的同时发声上限
};
