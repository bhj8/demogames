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

  /* --- 玩家 3C §11.2 --- */
  PLAYER: {
    maxHp: 120,
    height: 1.68,
    radius: 0.42,
    moveSpeed: 6.2,
    accel: 62,
    friction: 12,
    dashSpeed: 23,
    dashTime: 0.25,      // → 23 × 0.25 = 5.75m（TODO.md M1）
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
    /* 子弹的可视长度与粗细。子弹【就是】曳光，没有第二个特效 ——
       9m / 220m·s⁻¹ 意味着这条光带在画面上存在约 40ms，正好是一道快线。

       粗细是【屏幕角宽】，不是世界尺寸。这一条是踩过坑才写下来的：
       原来 streakRadius 是固定的世界半径 0.13m，于是同一条光带
       在飞出 2m 时占 106px、飞到 45m 时只剩 5px —— 而子弹 220m/s，
       前 10m 只要 45ms，射击间隔 111ms，所以画面上四成的帧里
       准星上都糊着一条 20~100px 的粗带子。
       固定的世界尺寸只可能在某一个距离上正确，这里需要的是
       「不管多远都是这么宽」，那就必须按到镜头的距离反算半径。 */
    streakLength: 9,
    streakPx: 2,                   // 头端在屏幕上的宽度（CSS 像素），重弹自动 ×1.55
    /* 尾巴挂在枪口上的距离。子弹 220m/s，这段距离决定了「看得见自己开枪」
       的时间窗：28m ≈ 127ms ≈ 一个开火间隔，所以连续射击时画面上
       总有一条从枪口拖出去的光带。超过这段，光带脱开、退化成拖尾。 */
    streakBlend: 28,
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
    maxOrbs: 2400,                // 同时存在的经验球上限（渲染只画 640 颗）
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
    /* Bao 定稿：怪物数量直接翻 10 倍。
       实测帧耗时随数量近似线性（1280×720 软件渲染，含 R.render）：
         50 只 1.74ms / 200 只 2.55ms / 400 只 3.37ms / 700 只 6.13ms / 1000 只 9.16ms
       所以 900 只这一档还有 ≈110fps 的余量，硬上限 1500 只是保险丝。 */
    aliveCap: 1500,
    /* todo12 后续修正（Bao：「刷怪距离太近了，刷怪都刷在脸上」）。
       实测确认了这句体感：平均 26.6m 听着没问题，但最近 9.4m、
       20m 内占 24%、背后半球占 45%。三个来源，一起改：
         1) pickSpawn 的打分是 -dist —— 它【专挑最近的合法点】
         2) 跨层豁免是 minDist × 0.62 = 9.3m，楼上楼下等于贴脸
         3) 背后只保护了正后方 ±50° 的锥，锥外 51° 的地方 15m 就能刷 */
    minDist: 20,                  // 硬性：同层绝不在玩家 20m 内刷怪
    minDistCross: 16,             // 跨层稍近可以接受（要爬/跳过来），但不是 9m
    preferDist: 30,               // 打分偏好的距离：靠这个数最近的点得分最高
    maxPickDist: 52,              // 超过这个距离的刷怪点不考虑
    maxDist: 34,                  // 平面兜底路径的最远距离
    rearConeDeg: 100,             // §31 背后禁区（正后方的锥，要求最远）
    rearMinDist: 26,              // 正后方锥内
    rearHalfMinDist: 23,          // 背后【半球】——锥外也不许贴着背刷
    /* 「必须刷在视线外」这条规则本身就把落点推到背后：视野只占 100°，
       剩下 260° 里有 180° 是背后半球。所以要主动把分数拉回正面 ——
       正面的合法落点必然是【被建筑挡住的】，那正是最好的一种出场：
       怪从你面前的拐角涌出来，而不是凭空出现在你背后。 */
    frontBonus: 12,
    frontBias: 0.65,              // 65% 刷在视野前方，保证"一直有怪打"
    hpScalePerMin: 0.26,
    dmgScalePerMin: 0.075,

    /* 刷怪规则：只有一个目标在场数。
       比目标缺得越多，刷得越快；即使不缺，最慢也 3 秒来一只。
       这样开局压力不会拉满，被清场后又能迅速补上。 */
    /* 整条曲线 ×10（形状不变，只是全体抬高）：
       0:30 →150　1:00 →186　3:00 →330　6:00 →529　12:00 →900
       todo12 §1 曾把 targetBase 提到 16、maxInterval 压到 1.6 来"加快节奏"，
       数字上确实动了（前 3 分钟击杀 233 → 278），但 Bao 实机试下来
       「一点用都没有」—— 那两个数已退回原值。节奏不在刷新速度，
       在场上到底能站几只。 */
    targetBase: 100,
    targetCoef: 800,
    targetExp: 0.9,
    maxInterval: 3.0,             // 不缺人时的最慢间隔
    engageRadius: 35,             // 「玩家身边」的定义，量刷怪密度时用它
    /* todo12 §3：后期远程怪太多，来不及躲。两道闸，各管一件事 ——
       rangedShare 管【场上有多少只】，rangedFiring 管【同时有几只在开火】。
       只做第一道不够：20% 的 150 只也有 30 只，齐射一样躲不掉。 */
    rangedShare: 0.20,
    /* 数量翻 10 倍之后，20% 就是 180 只远程 —— 那是躲不掉的弹幕。
       所以再加一道【绝对数量】闸：不管场上多少只，远程最多这么多。
       两个数取小的那个，小场面走比例、大场面走绝对值。 */
    rangedMax: 24,
    rangedFiring: 3,
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
    pickupRadius: 1.7             // 主动接触，不自动吸附
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
    /* 三个空投强化（todo11 §1）。原来只有过载供弹值得捡，另两个基本是空的：
       肾上腺素只给移动、相位护盾只挡伤害，都不改变这 14 秒能打死多少怪。
       现在三个都按「一次增益窗口内的击杀收益」拉到同一档，方向各不相同：
         过载供弹 = 无限火力   暴走针 = 机动与循环   强袭盾 = 保命 */
    ammoFireRate: 0.20,           // 过载供弹：射速 +20%，弹匣不减
    /* 暴走针：移速 + 射速 + 大幅加快换弹。换弹那一项是关键 ——
       高耗弹 Build 有一半时间在换弹，砍掉它才等价于「更多输出」。 */
    adrenSpeed: 0.35,
    adrenDashCd: 0.50,
    adrenFireRate: 0.55,
    adrenReload: 0.62,            // 换弹时间 -62%
    /* 强袭盾：Bao 选的保命型 —— 盾厚、伤害加成小，是逆风时的一口气，
       不是让你往人堆里冲的那种。 */
    shieldAbsorb: 150,            // 超过玩家满血（120）—— 实打实的一条命
    shieldDamage: 1.25,           // 护盾还在时所有伤害 ×1.25
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
    horde: '爆裂尸死亡后爆炸',
    hordeDetail: '爆裂尸死亡后闪烁 0.8 秒再爆炸，半径 3m，只伤害玩家。',
    enemy: { fuse: 0.8, radius: 3.0, dmg: 22 }
  },
  {
    id: 'fission', name: '分裂', en: 'Fission',
    color: 0xb060ff, css: '#b060ff',
    horde: '裂变尸死亡后生出幼体',
    hordeDetail: '裂变尸死亡后生成 2 只幼体，生命为母体的 20%，不掉经验，不再分裂。',
    enemy: { count: 2, hpRatio: 0.20 }
  },
  {
    id: 'overclock', name: '超频', en: 'Overclock',
    color: 0xff3355, css: '#ff3355',
    horde: '超频尸移动和攻击更快',
    hordeDetail: '超频尸移速 +45%、攻击间隔 -25%，但最大生命 -20%。',
    enemy: { speedMult: 1.45, atkMult: 0.75, hpMult: 0.80 }
  },
  {
    id: 'ossify', name: '骨化', en: 'Ossification',
    color: 0xf0f4ff, css: '#e8eeff',
    horde: '骨甲尸正面有三层骨板',
    hordeDetail: '骨甲尸正面命中会优先击碎一层骨板并抵消该次伤害，三层碎尽才暴露。背后与头部可绕过。',
    enemy: { plates: 3, frontDot: 0.25 }
  },
  {
    id: 'conduct', name: '电导', en: 'Conduction',
    color: 0x35e0ff, css: '#35e0ff',
    horde: '电尸死亡后留下电场',
    hordeDetail: '电尸死亡后地面预警 0.7 秒，随后生成半径 2.8m、持续 2.5 秒的电场。',
    enemy: { telegraph: 0.7, radius: 2.8, duration: 2.5, tick: 0.5, dmg: 9 }
  },
  {
    id: 'giant', name: '巨化', en: 'Gigantism',
    color: 0xffd21e, css: '#ffd21e',
    horde: '巨尸更强但经验更多',
    hordeDetail: '巨尸体型 2.1 倍、生命 3 倍、伤害 +50%、移速 -35%，掉落经验 3.5 倍。',
    enemy: { scale: 2.1, hpMult: 3.0, dmgMult: 1.5, speedMult: 0.65, xpMult: 3.5, weight: 0.5 }
  }
];

const MUT = {};
MUTATIONS.forEach(m => { MUT[m.id] = m; });

/* ============================================================================
   19 个普通改装 §23
   kind: fire | chain | life   ——  §24 的三选一生成规则要用
   ========================================================================== */
/* ============================================================================
   通用改装
   只保留【不属于 todo5 §1/§8 禁用原子】且有真实战斗消费者的项。
   被剔除的：大口径(伤害%)、轻量枪机(射速%)、稳定框架(散布%)、
   双联枪管(并发弹丸 —— 那是齐射模块的职责)、处决弹头、催化增幅、
   扩散培养(范围% —— 已改写成爆裂的 n_blast_radius 节点)、连锁许可(改成传奇规则)。
   ========================================================================== */
const MODS = [
  { id: 'mag',       kind: 'fire', name: '扩容弹匣', text: '弹匣容量提高',       detail: '弹匣 +40%',                       max: 2 },
  { id: 'reload',    kind: 'fire', name: '快速装填', text: '换弹速度提高',       detail: '换弹时间 -25%',                   max: 2 },
  { id: 'optic',     kind: 'fire', name: '瞄准模块', text: '弱点伤害提高',       detail: '弱点倍率 +0.5',                   max: 2 },
  { id: 'feedback',  kind: 'chain', name: '神经回授', text: '触发派生效果后返还弹药', detail: '每次有效触发返还 1 发，每秒最多 4 发', max: 1 },
  { id: 'hunter',    kind: 'chain', name: '猎群算法', text: '分裂与弹射优先寻找满血目标', detail: '同时使搜索距离 +25%',      max: 1 },
  { id: 'aftershock',kind: 'chain', name: '余震',     text: '击退目标撞到其他敌人会造成伤害', detail: '单发基础伤害的 50%',    max: 1 },
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

/* --- 功能开关 ---
   只保留【真的会被关掉】的那一个。todo3 的六个开关、todo4 的三个地图入口、
   todo5 的新旧 Build 开关都已删除：分支不是安全网，只是双份维护成本。 */
TUNE.FEATURES = {
  hotspotMigration: true     // 热点迁移（TODO.md M4，取代 todo3 的动态几何事件）
};

/* --- TODO.md M4：热点迁移 ---
   地图几何不动，动的是「哪里最危险、哪里最值钱」。
   迁移必须渐变：硬切会让玩家在切换那一帧发现「这里突然没人了」。 */
TUNE.HOTSPOT = {
  firstAt: 75,               // 首个热点持续多久后开始迁移
  interval: 105,             // 之后的迁移周期
  telegraph: 8,              // 预告时长：先告诉玩家去哪，再真的迁
  fade: 6,                   // 旧热点降温 / 新热点升温的渐变时长
  spawnBias: 0.55,           // 热点中心的刷怪权重加成
  xpBonus: 1.35              // 热点内的经验倍率 —— 留在危险的地方要有回报
};

/* --- 玩家机动 §2.3 ---
   数值是首轮起点。手感目标比具体数值更重要：宽容、不断流、不要求像素级对边。 */
TUNE.MOVEMENT = {
  /* ============================================================
     动作单位按 TODO.md M1（todo6 §3）的目标距离反推，不是拍脑袋：
       地面冲刺 5~6.5m   = dashSpeed × PLAYER.dashTime
       空中冲刺 6~8m     = airDashSpeed × airDashTime
       跑墙 12~18m       = wallRunSpeed × wallRunTime
       墙面攀升 4~6m     = wallClimbSpeed × wallClimbTime
       完整动作链 25~35m = 滑铲 → 跳 → 跑墙 → 蹬墙 → 空冲
     实测由 _movecheck.html 跑出来，改数值必须跟着重跑。
     ============================================================ */
  gravity: 21,
  jumpSpeed: 8.6,
  coyoteTime: 0.16,          // todo6 §3：输入宽容 120~180ms
  jumpBuffer: 0.16,
  airControl: 0.42,          // 空中相对地面的加速度比例
  airDrag: 0.55,

  /* --- 连续动量（todo6 §4）---
     动量 = 「你最近达到过的水平速度」，在空中按 momentumDecay 衰减。
     它让滑铲跳、跑墙出口、空中冲刺连成一句话，而不是五个互相清零的技能。 */
  momentumDecay: 5.0,        // 空中每秒衰减多少 m/s（约 4 秒回到战斗移动速度）
  momentumCap: 26,           // 硬上限：防止动作叠加无限加速
  slideKeep: 1.15,           // 落地接滑铲时对动量的继承倍率
  wallRunKeep: 1.0,          // 进入跑墙时对动量的继承倍率
  dashKeep: 1.0,             // 空中冲刺在已有速度上取大，而不是覆盖成孤立值
  wallExitBoost: 1.06,       // 出跑墙的轻微推力，保证「出口」读得出来

  vaultMaxHeight: 1.3,       // 自动翻越
  stepHeight: 0.45,          // 低于此高度直接抬脚，不播翻越
  vaultTime: 0.18,
  mantleMaxHeight: 2.6,      // 抓边攀爬
  mantleTime: 0.30,
  mantleProbe: 0.95,         // 前向探测距离
  headroom: 1.75,            // 落脚点上方所需净空，不足不允许爬进模型

  wallClimbTime: 0.80,       // 垂直登墙持续 → 6.4 × 0.80 ≈ 5.1m
  wallClimbSpeed: 6.4,
  wallClimbCooldown: 0.45,
  wallRunTime: 1.20,         // 横向墙跑上限 → 12.5 × 1.20 = 15m
  wallRunSpeed: 12.5,
  wallRunGravity: 2.2,       // 墙跑期间的残余重力
  wallRunRise: 1.6,          // 起步时的轻微上抬
  wallRunStickDist: 0.85,
  wallRunMinSpeed: 3.2,
  wallRunGrace: 0.18,        // 离墙输入宽限
  wallRunCameraTilt: 0.13,   // 只允许轻微、方向确定的倾斜
  wallJumpOut: 7.4,          // 蹬墙跳的离墙分量

  airDashCharges: 1,         // 地面与空中共用一次，接触稳定地面后恢复
  airDashTime: 0.27,         // → 26 × 0.27 ≈ 7.0m
  airDashSpeed: 26,

  slideMinSpeed: 5.6,        // 略低于走路稳态速度，保证「跑起来就能滑」
  slideTime: 0.75,
  slideSpeed: 12.5,
  slideFriction: 5.5,
  slideHeight: 0.95,

  zipSpeed: 18.0,
  /* 上索吸附半径。2.8m 在 46m 的屋顶上等于一个隐形小点，跑过去很难对上；
     4.2m 配合两端的立柱，才是「看见柱子跑过去就能上」。 */
  /* todo12 §3 改成手动挂索之后，这个半径的含义变了：
     以前是「靠这么近就被吸上去」，现在是「靠这么近才提示可以按 E」。
     所以可以放宽一点 —— 误吸的风险没有了，够不着才是新的问题。 */
  zipSnapDist: 6.0,
  padImpulse: 14.5,
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
/* --- TODO.md M3/M5：分层风险收益与跨单元压力 ---
   屋顶必须是「捷径与角度」，不是「安全的农场」。所以：
   地面击杀经验最高，高处击杀打折；玩家高速跨越单元时，
   目标单元前方补压力，旧尸潮里留一部分继续追。 */
TUNE.LAYER_PLAY = {
  transferDist: 26,          // 多快算「跨了一个单元」
  transferWindow: 3.0,       // 在这个时间内跨过去才算高速转场
  transferAhead: 4,          // 目标单元前方补多少压力
  transferChase: 0.45,       // 旧尸潮里有多大比例继续追
  roofPressureBias: 0.55     // 玩家在高处时，刷怪点偏向同层的额外权重
};

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
  /* todo10 §6.1：一局 16~20 次选择。原来是 15 —— 那是 todo5 的节奏，
     那时一次选择可能给 1~4 级（品质随机），现在固定 1~2 级，
     总级数要靠次数补回来。 */
  /* todo11 §4：普通局 19~20 次，强 Build 22~24 次。
     Bao 的判断比原文准：问题不在「等级和次数没分离」（它俩本来就是同一个数），
     而在【定价按经验收入算，而收入模型比真实战斗环境乐观】。
     所以三处一起调：目标次数、单次需求（progressBase）、硬下限。 */
  targetCount: 20,
  firstAt: 25,               // 第一次预计 0:22～0:30
  firstWindow: [22, 30],
  intervalMin: 32,           // 常态间隔 32～50 秒（从上次选择关闭后计算）
  intervalMax: 50,
  hardFloor: 20,             // 两次界面之间的硬下限（22~24 次需要它降下来）
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
  progressBase: 64,
  /* 单次需求里有多少比例跟着【当前】收入走。
     1.0 = 完全按收入定价 —— 强弱 Build 的次数会【精确相等】（这就是旧行为，
           也是「build 很强但还是 17 次」的根因）；
     0   = 完全固定 —— 强 Build 会无限刷次数。

     0.65 是按目标反解出来的，不是拍的：
       升级次数比 = m / (w·m + 1−w)，m 是收入倍数。
       要「收入 1.8 倍的强 Build 拿到约 +18% 的次数（19.5 → 23）」，
       解出 w ≈ 0.657。
     机器人跑出来的「强 Build」只比普通局多赚 12% 经验，分辨不出这个差，
     所以这个值不能用机器人去拟合 —— 只能由真人试玩确认。 */
  rateWeight: 0.65,
  firstNeed: 22,             // 第一次进化的固定需求（此时还没有收入样本）
  /* todo12 §1：开局几张卡打折。折扣不是白送 —— 经验依然只从击杀来，
     挂机一级都不涨。实测（种子 11，跑动机器人，只改这一个数）：
       关：22 80 115 144 183 …　8 分钟前 13 次
       开：22 60  89 120 159 …　8 分钟前 14 次
     第 2 次早 20 秒，第 5 次早 24 秒；全程次数不变（都是 19）。 */
  earlyCheapCount: 5,        // 索引 <5，即第 2~5 次这 4 次（第 1 次走的是 firstNeed）
  earlyCheapMult: 0.75,
  driftDeadband: 0.8,        // ±0.8 次以内完全不干预
  driftFullAt: 3.0,
  driftMin: 0.40,            // 落后时需求最低 40%
  driftMax: 1.00,            // 领先时不再反向加价（todo11 §4）—— 保留字段只为读数
  safeDelayMax: 12,          // 安全窗口最多延迟多久，超过则强制弹出
  /* todo11 §5：升级界面弹出后多久才允许选择。玩家几乎一定正按着左键，
     不锁的话那一下会替他选掉一张他根本没看见的卡。 */
  pickLockTime: 2.0
};

/* ============================================================================
   todo10 —— 自然反应 Build V3

   §6.3 品质档整个删掉。玩家抽到的是【固定的量】，不是一次赌博：
     大升级（核心分子 / 大玩法选择）= +2 级，小升级 = +1 级。
     Bao 2026-08-14：「传奇是最大的败笔，玩家随机到的应该是固定的，
     要不然玩家会非常挫败。」

   §0.3 这里【没有】反应矩阵、没有组合名、没有逐对配方。
   六个分子 + 一套统一攻击规律，组合结果自己长出来。
   ========================================================================== */
TUNE.BUILD = {
  /* --- 每次选择给几级（§6.3 改版）--- */
  bigLevels: 2,              // 核心分子 / 大玩法选择：首次与重复都给 2 级
  smallLevels: 1,            // 武器 / 机动 / 生存小升级

  /* --- §6.1 一局结构 --- */
  /* todo11 §4：普通局 19~20 次，强 Build 22~24 次。
     Bao 的判断比原文准：问题不在「等级和次数没分离」（它俩本来就是同一个数），
     而在【定价按经验收入算，而收入模型比真实战斗环境乐观】。
     所以三处一起调：目标次数、单次需求（progressBase）、硬下限。 */
  targetCount: 20,           // 与 TUNE.EVOLUTION.targetCount 保持一致（todo11 §4：19~24 次）
  cutoff: 630,               // 最后 90 秒停止升级（12 分钟局）
  /* 拿到第 3 个分子后，新分子的权重下降但不锁死 —— 幸运局仍能继续扩展。
     实测十局平均 4.1 个，比 Bao 要的「平均 3 个」高，所以门槛从 4 降到 3。 */
  moleculeSoftCap: 3,
  moleculeSoftWeight: 0.22,

  /* --- 保底（Bao：只托底不封顶，规则可以多一点）--- */
  firstDrawAllMolecules: true,   // 第 1 次固定三张不同分子
  secondMoleculeByDraw: 4,       // 第 4 次结束前必得第 2 个分子
  bigEveryDraws: 2,              // 连续 2 次没有大升级 → 下次至少 1 张
  /* 每一次发牌都至少有一张武器侧的卡（分子 / 大选择 / 武器小升级）。
     机动生存卡不允许占满三张 —— 那一次的武器成长会直接归零。 */
  ammoBiasAtCost: 2,             // 每枪耗弹 ≥2 时抬高弹药循环卡权重
  ammoBiasMult: 2.2,

  /* --- §8.3 性能上限。这是【对象与事件】的上限，不是伤害预算 ---
     伤害永远算满（纯数学，很便宜），触顶只合并视觉与音效、只砍对象。 */
  /* 单根攻击的效果事件。§8.3 列出的必保上限里【没有】这一条 ——
     它只是防死循环的保险丝，不是平衡旋钮。多发 8 颗 × 穿透 3 次 ×
     （爆炸 10 个目标 + 弹射 4 跳各自再爆）本来就上千，
     调低它等于静默削掉玩家已经看见并理解的伤害，正是 §8.3 禁止的事。 */
  eventsPerRoot: 4000,
  hitsPerTargetPerRoot: 3,   // 同一根攻击对同一目标的重复命中
  projectileCap: 260,
  perFrame: 6000,            // 单帧伤害事件（解耦后很便宜，只防死循环）
  perSecond: 90000,
  fxPerFrame: 40,            // 视觉对象：这才是真正稀缺的东西
  blastSoundWindow: 0.11,    // 同一时间窗内的爆炸音合并
  soundPerBlastWindow: 2,

  /* --- 距离曲线（多发的单弹衰减 §2.1）---
     近距离满伤，远距离掉到 farKeep。贴脸/远射是【另一条】曲线，
     Bao 已确认两者互斥就互斥，不做折中。 */
  pelletNear: 6,             // 6m 内每颗弹丸满伤
  pelletFar: 14,             // 14m 外只剩 farKeep
  pelletFarKeep: 0.45,

  /* --- §8.1 弹射的搜索半径 --- */
  bounceSearch: 14,

  /* 爆炸的统一衰减已经删掉：它是为「每次命中都炸」那版爆炸准备的。
     尸爆一只怪只炸一次，收敛靠连锁层数和「按死者生命算」，不靠衰减。 */
  corpseDepth: 2               // 尸爆连锁最多几层（沿用 procDepth）
};

/* --- todo12 §2 恶魔卡：红色、稀有、改写规则的一层 ---
   定位不是「更强的卡」，是【每一张都必须拿掉一样东西】。
   所以它们不分级、不叠加：拿到就是换了一把枪，再拿一次没有意义。 */
TUNE.DEMON = {
  css: '#ff3b4e',
  fromTime: 240,             // 4 分钟后进池 —— 前期还在长基本盘
  maxPerRun: 2,              // 一局最多 2 张
  chance: 0.35,              // 满足条件时，这一次发牌出现恶魔卡的概率
  /* 追踪不是制导导弹：目标在扣扳机那一刻锁死，锥内最靠近准星的那只。
     turn 是每秒的转向插值率 —— 14 足够在 60m 内把弹道掰过去，
     又不会让弹道拐成 90 度让玩家读不懂。 */
  /* 代价只剩「不能爆头」—— Bao 去掉了减射速那一项。
     turn 是每秒的转向插值率；目标在扣扳机那一刻锁死。 */
  autoaim: { cone: 0.62, range: 70, turn: 14 },
  drum:    { mag: 6.0, reload: 6.0 },            // 弹匣 ×6（+500%），换弹 ×6（+500%，与弹匣一致）
  glass:   { out: 3.0, in: 3.0 },                // 造成 ×3 / 受到 ×3（护盾同样按 ×3 扣）
  /* ×16 不是拍的：弹匣变 1 发后每发都要背一次换弹，
     ×11 算下来循环 DPS 只有 +8%（73.7 → 79.5），拿到手毫无感觉；
     ×16 → 115.6，即 +57%，并且天然吃快装（配满快装 +73%）。 */
  slug:    { dmg: 16 },
  scope:   { gain: 0.60, speed: 0.45, hipSpread: 8 },
  /* todo13 E12 恶魔复生：不是保险，是死亡之后正式进入第二形态。 */
  rebirth: { hpMult: 0.5, dmgMult: 2.0 },
  /* todo13 A04 轨道炮：找一条直线穿透整条街。
     Bao 确认【不设上限】—— 无限穿透配尸爆/弹射时总伤害随命中数线性增长，
     那是想要的运气组合，不去削它。 */
  railgun: { rate: 0.25, ammo: 3, dmg: 6 },
  /* todo13 坍缩炮（原案 A01+D05+G03 合并）。
     收益全部来自【蓄力时间与额外耗弹】，所以引力不会变成每颗普通子弹
     都免费触发的东西。原案里「弹匣固定 1 发」那条 Bao 已经取消。 */
  collapse: {
    minCharge: 0.30,          // 低于这个时长松手不发射
    maxCharge: 1.50,
    ammoAt0: 2, ammoAt1: 8,   // 蓄满耗 8 发
    dmgAt0: 3, dmgAt1: 14,    // 蓄满伤害 ×14（分摊在整片被吸住的敌人身上）
    radiusAt0: 5, radiusAt1: 12,
    pullTime: 0.55,           // 吸附持续多久
    pullAccel: 26,            // 吸力（写进 e.knock，和击退共用通道）
    coreSpeed: 42             // 引力核心的飞行速度，明显比子弹慢，看得清
  },
  /* todo13 G08 延迟清算。
     forceEvery 是给无限弹匣兜的底：过载供弹期间永远不换弹，
     不强制结算的话伤害永远不兑现，玩家会以为枪坏了。 */
  defer: { mult: 1.5, forceEvery: 4.0 }
};

/* --- 护盾池（todo13）---
   原来有两个来源（再生盾 / 跑墙盾），各自一套上限，加起来当总上限。
   再加击杀护盾和过量治疗就是四套上限四个数，HUD 上根本说不清
   「我现在有多少盾、还能涨多少」。所以合成【一个池 + 一个总上限】：
   每个来源只回答两件事 —— 往池里加多少上限、以什么速度往里加。 */
TUNE.SHIELD = {
  capFrac: 0.80,             // 总上限不超过最大生命的 80%
  /* 池子里超出「不衰减来源」那部分算临时护盾，按这个速度掉。
     击杀护盾是唯一的临时来源：停手就掉，逼你一直在杀。 */
  tempDecay: 14
};

/* --- §2 六个核心分子。数值全部是灰盒建议值，D 阶段用靶场调 --- */
TUNE.MOL = {
  volley: {
    name: '多发', css: '#7fd4ff',
    pelletsAt1: 3,           // 1 级 3 颗
    pelletPerLv: 1,
    ammoAt1: 2,              // 1 级单次耗弹 2
    ammoEveryLv: 2,          // 每两级再 +1
    fanDeg: 3.4
  },
  /* todo13 C01 尸爆 —— 取代原来的「爆炸」（Bao：爆炸太强了，先隐藏掉）。
     原来的爆炸是「每次命中都按本次伤害的百分比炸一圈」，配多发/穿透时
     一枪能炸几十次，伤害随命中数线性堆上去。
     尸爆改成【打死才炸，威力按死掉那只怪自己的生命算】：
       - 收益不跟你的枪走，跟你杀的东西走 —— 杀精英才有大爆
       - 连锁受 corpseDepth（2 层）约束，不会一路推平全图 */
  corpse: {
    name: '尸爆', css: '#ff9a3c',
    pctAt1: 0.25,            // 炸出死者最大生命的 25%
    pctPerLv: 0.10,
    radiusAt1: 4.0,
    radiusPerLv: 0.7
  },
  pierce: {
    name: '穿透', css: '#8affc1',
    countAt1: 2,
    countPerLv: 1,
    keepAt1: 0.80,
    keepPerLv: 0.03,
    keepMax: 0.95
  },
  ricochet: {
    name: '弹射', css: '#c58aff',
    countAt1: 1,
    countPerLv: 1,
    firstKeep: 0.68,         // 68% → 48% → 33% → 23%（§9.2 要求大升级 ≥ +40%）
    hopDecay: 0.70
  },
  heavy: {
    name: '重弹', css: '#ff6a4a',
    dmgAt1: 2.2,
    dmgPerLv: 0.35,
    rateAt1: 0.65,           // 射速降到 65%
    ratePerLv: 0.05,
    rateMax: 0.90,
    ammoExtra: 1,
    scale: 1.55,
    knock: 1.9
  },
  overclock: {
    name: '超频', css: '#ffd24a',
    peakAt1: 0.70,           // 峰值 +70% 射速
    peakPerLv: 0.15,
    rampAt1: 1.6,            // 达到峰值所需的持续射击时间（每个弹匣都要重新升，太慢就白拿）
    rampPerLv: -0.25,
    rampMin: 1.0,
    decay: 2.6               // 停火后每秒衰减多少档
  }
};

/* --- §3 七个大玩法选择。全部按「等级」缩放，首次到手就是 2 级 --- */
/* --- todo13 C03 过量伤害转移 ---
   只转移【超过敌人剩余生命的那部分】。天然收敛：每跳再乘 keep，
   而且高射速小伤害的 Build 本来就没有溢出，白赚不到。 */
/* --- todo13 A05 墙面反弹 ---
   子弹撞墙不消失，反弹并且【伤害提高】。代价不是衰减，是它和穿透
   抢同一颗子弹：穿透与反弹哪个先用完，子弹就在那里消失（Bao 定）。
   它顺带把「城市几何」拉进 Build —— 巷子和拐角第一次变成输出的一部分。 */
TUNE.MOL_WALL = {
  css: '#9fd8ff', name: '墙面反弹',
  countAt1: 1, countPerLv: 1,
  gainAt1: 1.35, gainPerLv: 0.15,   // 每次反弹之后伤害乘这个数
  nudge: 0.25                        // 反弹后沿新方向推开一点，避免同一帧再撞
};

TUNE.MOL_OVERFLOW = {
  css: '#ffb84d', name: '过量转移',
  keepAt1: 0.65, keepPerLv: 0.05, keepMax: 0.85,
  hopsAt1: 3, hopsPerLv: 1, hopsMax: 8,
  search: 12,                // 找下一个目标的半径
  minDamage: 1               // 转移量低于这个数就断链
};

TUNE.CHOICE = {
  /* todo11 §6：两条曲线不再对称。贴脸风险高得多，收益上限就该明显更高；
     远射安全，收益压低。到手即 2 级，所以每级的量是目标值的一半。
       贴脸 7m 内 ×2.0 / 14m 外 ×0.6     远射 15m 外 ×1.4 / 7m 内 ×0.8 */
  close:   { name: '贴脸', css: '#ff5f7a', near: 7,  far: 14, gainPerLv: 0.50, lossPerLv: 0.20, lossFloor: 0.35 },
  far:     { name: '远射', css: '#6ac8ff', near: 7,  far: 15, gainPerLv: 0.20, lossPerLv: 0.10, lossFloor: 0.50 },
  /* Bao：现在爆头太容易了，先按 1.5 / 0.7 走，等怪的形状改了再抬 */
  crit:    { name: '爆头', css: '#ffe066', gainPerLv: 0.25, lossPerLv: 0.15, lossFloor: 0.40 },
  lowhp:   { name: '低血', css: '#ff4d5e', threshold: 0.40, gainPerLv: 0.40 },
  root:    { name: '站桩', css: '#b0ffb0', moveEps: 0.55, delay: 0.5, rampTime: 2.5, gainPerLv: 0.50 },
  overload:{ name: '双倍装药', css: '#ff8ae0', ammoMult: 2, gainPerLv: 0.50 },
  focus:   { name: '专注目标', css: '#9affe0', perStackPerLv: 0.05, maxStacks: 10, resetAfter: 1.0 },
  /* todo13 E05 无伤压制：生命 100% 时全伤害提高。
     护盾扛住的伤害不算「生命受损」—— hurtPlayer 本来就先扣盾再扣血，
     所以这条不需要额外代码，读当前生命就是对的。 */
  pristine: { name: '无伤压制', css: '#8ff0ff', gainPerLv: 0.30 }
};

/* --- §4 七个武器小升级：允许是清楚的数值成长，不假装成新机制 --- */
TUNE.WUP = {
  power:    { name: '威力',   css: '#ffd0a0', perLv: 0.22 },
  rate:     { name: '射速',   css: '#ffd0a0', perLv: 0.22 },
  mag:      { name: '扩容',   css: '#a0d0ff', perLv: 0.50 },
  reload:   { name: '快装',   css: '#a0d0ff', perLv: 0.30, floor: 0.45 },
  weak:     { name: '弱点',   css: '#ffe066', perLv: 0.55 },
  thrift:   { name: '节弹',   css: '#a0ffd0', at1: 0.22, perLv: 0.08, cap: 0.75 },
  /* todo12 §3：击杀返还改成【按当前弹匣的百分比】，不再是固定 1 发。
     Bao 的理由：「用户用输出的选项换取了续航，没问题的」——
     大弹鼓 / 弹匣卡堆出来的容量，本来就该让这张卡跟着变强。
     单根攻击的返还上限仍然是这一枪耗弹的一半，所以它永远填不满弹匣。 */
  /* todo13 C04 开门枪：只对【满血】目标加成，没有代价。
     原设计带「对受伤敌人 ×0.8」的反面，但在 ×10 怪量下你打到的几乎都是
     满血怪，那个代价触发不到，等于无代价 ×2.5。Bao 决定削数值、去代价。 */
  opener: { name: '开门枪', css: '#ffe08a', perLv: 0.35 },
  killload: { name: '击杀装填', css: '#a0ffd0', pctPerLv: 0.03 }
};

/* --- §5 九个机动、生存与资源升级。它们不得成为地图基本路线的通行证 --- */
TUNE.MUP = {
  /* todo12 §3：强心从「+25 点」改成「+25% 并立即回满」。
     +25 点在 120 血的基线上只有 +21%，而且只补差额 ——
     拿到手既没有强度也没有当场救命的感觉。 */
  vigor:       { name: '强心',     css: '#7ef0a8', pctPerLv: 0.25 },
  regenshield: { name: '再生盾',   css: '#6ac8ff', quiet: 6.0, perLv: 25 },
  lifesteal:   { name: '近杀回血', css: '#7ef0a8', range: 8, perLv: 2, capPerSec: 6 },
  dash2:       { name: '二次冲刺', css: '#ffd24a', perLv: 1 },
  chainmove:   { name: '连续机动', css: '#ffd24a' },
  slam:        { name: '落地冲击', css: '#ff9a3c', minSpeed: 12, dmgPerSpeed: 3.0, radius: 5.5 },
  wallshield:  { name: '跑墙护盾', css: '#6ac8ff', distance: 8, perLv: 18, max: 60 },
  dashhit:     { name: '冲刺撞击', css: '#ff6a4a', perLv: 22, cooldown: 1.2, push: 7 },
  magnet:      { name: '拾取强化', css: '#a0ffd0', perLv: 0.5 },
  /* todo13 C10 击杀护盾：临时护盾，停手就掉。精英给得多。 */
  killshield:  { name: '击杀护盾', css: '#6ac8ff', perKill: 5, eliteMult: 4, capFrac: 0.30 },
  /* todo13 E01 过量治疗：满血之后的治疗不再浪费，转成护盾。 */
  overheal:    { name: '过量治疗', css: '#7ef0a8', convert: 1.0, capFrac: 0.50 }
};

/* --- 地图行为的兑现（§6 的地图奖励）---
   品质删掉之后，「下一抽史诗 +8%」这类修正没有兑现口了。
   Bao：地图本身是下一轮要大改的东西，这一版先按最直白的方式给。 */
TUNE.MAP_BUILD = {
  bannerTime: 6.0,
  roofDrop: 'forceBig',      // 屋顶开空投 → 下一次必含 1 张大升级
  wallrun: 'extraLevel',     // 连续墙跑 → 下一张卡多给 1 级
  eliteHunt: 'fourth'        // 猎杀跨层精英 → 下一次多一个选项（四选一）
};

/* --- todo5 §9 超频尸：加速过程必须可见，并存在失速窗口 ---
   「更快的普通丧尸」不构成共同变异 —— 玩家要能看出它在蓄速，
   也要等得到一个可以反打的空档。三段循环的时长都可调。 */
TUNE.HORDE_OVERCLOCK = {
  rampTime: 1.5,             // 蓄速：速度与自发光一起爬升
  runTime: 2.2,              // 全速冲刺
  stallTime: 1.4,            // 失速窗口：明显变慢、发光熄灭
  peakMult: 1.75,            // 峰值相对自身基础速度
  stallMult: 0.35
};
