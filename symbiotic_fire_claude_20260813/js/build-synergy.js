/* ============================================================================
   SYMBIOTIC FIRE · 构筑化学反应（todo3 §7.6 / §7.7）
   三层生长：基础反应（自动） → 稀有连接（回路） → 史诗融合（改写形态）。

   一条硬纪律（§7.7 / §9）：所有连锁必须经过 effectBudget、递归深度与单目标次数，
   禁止卡牌直接递归调用另一张卡。这里是唯一的效果出口。
   ========================================================================== */
'use strict';

/* 六个基础变异沿用既有实现（combat.js 的订阅），只按 todo3 §7.7 统一命名。 */
const BASE_IDS = ['blast', 'fission', 'overclock', 'ossify', 'conduct', 'giant'];
MUT.overclock.name = '过载';
MUT.conduct.name = '传导';

/* 组合键：两个基础变异的无序对 */
function comboKey(a, b) { return a < b ? a + '+' + b : b + '+' + a; }

/* ============================================================================
   §7.7 十五组化学反应
   auto   —— 持有两者后自动发生，不额外占一次选择
   link   —— 稀有连接方向
   fusion —— 史诗融合形态
   每条都带 tags，供 §7.5 的候选权重与 §7.8 的地图标签倾向使用。
   ========================================================================== */
const COMBOS = [
  { a: 'blast', b: 'fission', autoText: '爆炸时额外释放 1 枚低伤裂片',
    linkName: '裂片引信', linkText: '裂片击杀可触发一次小型尸爆',
    fusionName: '追猎尸爆', fusionText: '爆炸释放追踪裂片，裂片击杀再次尸爆',
    tags: ['blast', 'split', 'kill', 'aoe'] },
  { a: 'blast', b: 'overclock', autoText: '爆炸击杀补充少量过载值',
    linkName: '燃烧循环', linkText: '满过载提高爆炸范围，爆炸击杀延长过载',
    fusionName: '热核退膛', fusionText: '满过载换弹释放热震波，并点燃一轮爆炸回路',
    tags: ['blast', 'charge', 'reload', 'aoe'] },
  { a: 'blast', b: 'ossify', autoText: '首次穿透目标时植入一枚死亡爆标',
    linkName: '连列起爆', linkText: '同一直线多个爆标会依次引爆',
    fusionName: '骨雷贯列', fusionText: '被穿透的敌人成为骨雷，沿射线方向链式爆炸',
    tags: ['blast', 'pierce', 'line', 'aoe'] },
  { a: 'blast', b: 'conduct', autoText: '爆炸命中为传导增加 1 层充能',
    linkName: '雷爆往返', linkText: '闪电击杀小爆、爆炸充能，每目标只往返一次',
    fusionName: '雷爆闭环', fusionText: '爆炸与电弧互相接力，在受限目标数内清扫尸群',
    tags: ['blast', 'shock', 'chain', 'aoe'] },
  { a: 'blast', b: 'giant', autoText: '爆炸范围和击退随弹体尺寸增长',
    linkName: '撞击起爆', linkText: '被巨弹撞飞的敌人碰撞后小爆一次',
    fusionName: '陨星连爆', fusionText: '巨型冲击爆炸将敌人撞飞，碰撞再爆一次',
    tags: ['blast', 'size', 'knock', 'aoe'] },
  { a: 'fission', b: 'overclock', autoText: '过载阶段提高分裂弹数量',
    linkName: '蜂群续航', linkText: '分裂命中维持过载衰减时间',
    fusionName: '蜂群过载', fusionText: '满过载时裂片变为短程追踪蜂群，命中继续续航',
    tags: ['split', 'charge', 'sustain'] },
  { a: 'fission', b: 'ossify', autoText: '分裂弹继承一次低伤穿透',
    linkName: '侧向骨针', linkText: '每次穿透向侧面射出骨针',
    fusionName: '骨树增殖', fusionText: '骨针继续分叉形成树状弹道，受节点预算限制',
    tags: ['split', 'pierce', 'spread'] },
  { a: 'fission', b: 'conduct', autoText: '分裂弹命中也能为传导充能',
    linkName: '电孢', linkText: '最后一名电击目标生成电孢子',
    fusionName: '雷孢繁殖', fusionText: '电孢子命中为下一次闪电充能，并可再繁殖一代',
    tags: ['split', 'shock', 'chain', 'charge'] },
  { a: 'fission', b: 'giant', autoText: '分裂弹变大并获得明显击退',
    linkName: '重型碎片', linkText: '重型碎片额外穿透一次',
    fusionName: '碎星弹群', fusionText: '巨弹裂成重型弹块，带击退和一次穿透覆盖整条街',
    tags: ['split', 'size', 'knock', 'pierce'] },
  { a: 'overclock', b: 'ossify', autoText: '高过载时每若干发获得穿透',
    linkName: '贯穿缓释', linkText: '穿透命中延缓过载衰减',
    fusionName: '骨钻洪流', fusionText: '满过载把弹道收束为持续贯穿的骨钻射流',
    tags: ['charge', 'pierce', 'sustain', 'line'] },
  { a: 'overclock', b: 'conduct', autoText: '射速越高，传导自然越快充满',
    linkName: '雷暴维持', linkText: '闪电命中延长过载',
    fusionName: '环形雷暴', fusionText: '满过载周期性释放环形闪电，命中继续维持过载',
    tags: ['charge', 'shock', 'aoe', 'sustain'] },
  { a: 'overclock', b: 'giant', autoText: '持续射击让后续弹体逐步增大',
    linkName: '动量存储', linkText: '停火把积累动量存入下一发巨弹',
    fusionName: '蓄势重炮', fusionText: '连续射击不断增重，停火后释放一次极限炮击',
    tags: ['charge', 'size', 'burst'] },
  { a: 'ossify', b: 'conduct', autoText: '被穿透的目标短暂成为导体',
    linkName: '导体路径', linkText: '下一次闪电优先沿穿透线传播',
    fusionName: '导骨雷脊', fusionText: '电弧沿整条穿透路径往返一次，形成清晰线杀',
    tags: ['pierce', 'shock', 'line', 'chain'] },
  { a: 'ossify', b: 'giant', autoText: '巨型弹完整继承穿透宽度',
    linkName: '攻城骨矛', linkText: '每若干发生成一枚攻城骨矛',
    fusionName: '街区骨矛', fusionText: '骨矛贯穿街道，撞墙后产生横向震波',
    tags: ['pierce', 'size', 'line', 'knock'] },
  { a: 'conduct', b: 'giant', autoText: '巨弹每次命中提供额外传导充能',
    linkName: '弹上锚定', linkText: '闪电可以锚定在飞行中的巨弹上',
    fusionName: '行星闪电', fusionText: '巨弹变为移动球状闪电，飞行中持续向周围放电',
    tags: ['shock', 'size', 'chain', 'aoe'] }
];
const COMBO_MAP = {};
COMBOS.forEach(c => { c.key = comboKey(c.a, c.b); COMBO_MAP[c.key] = c; });

/* ============================================================================
   SYN —— 构筑状态 + 效果预算 + 自动反应
   ========================================================================== */
const SYN = {
  build: null,
  budget: { spent: 0, frame: 0, merged: 0, rejected: 0, maxDepth: 0, sec: 0 },
  firstFire: {},          // 首次触发过的连接/融合，用于“首次一次更强反馈”

  init() {
    this.build = {
      baseMutations: [],
      commonNodes: {},     // cardId -> stacks
      rareLinks: [],       // comboKey
      epicFusions: [],     // comboKey
      legendaryRules: [],  // ruleId
      mapAbilities: [],    // cardId
      taken: {}
    };
    this.budget = { spent: 0, frame: 0, merged: 0, rejected: 0, maxDepth: 0, sec: 0 };
    this.firstFire = {};
    this._install();
    return this;
  },

  has(id) { return this.build.baseMutations.indexOf(id) >= 0; },
  hasLink(key) { return this.build.rareLinks.indexOf(key) >= 0; },
  hasFusion(key) { return this.build.epicFusions.indexOf(key) >= 0; },
  hasRule(id) { return this.build.legendaryRules.indexOf(id) >= 0; },
  hasAbility(id) { return this.build.mapAbilities.indexOf(id) >= 0; },
  node(id) { return this.build.commonNodes[id] || 0; },

  /* 当前已经成立的组合（持有两个基础变异即自动生效，不占选择） */
  activeCombos() {
    const out = [];
    const b = this.build.baseMutations;
    for (let i = 0; i < b.length; i++)
      for (let j = i + 1; j < b.length; j++) {
        const c = COMBO_MAP[comboKey(b[i], b[j])];
        if (c) out.push(c);
      }
    return out;
  },
  comboActive(key) {
    const c = COMBO_MAP[key];
    return !!c && this.has(c.a) && this.has(c.b);
  },

  /* --------------------------------------------------------- 效果预算 */
  /* §7.7：所有循环触发统一经过 effectBudget，不允许各卡自行无限生成对象。
     depth 用 AttackContext 的 procDepth，天然继承 §34 的递归保护。 */
  allow(ctx, cost) {
    const B = TUNE.EFFECT_BUDGET;
    const c = cost || 1;
    if (ctx && ctx.procDepth >= B.maxDepth) { this.budget.rejected++; return false; }
    if (this.budget.frame + c > B.perFrame) { this.budget.rejected++; return false; }
    if (this.budget.spent + c > B.perSecond) { this.budget.rejected++; return false; }
    this.budget.frame += c; this.budget.spent += c;
    if (ctx) this.budget.maxDepth = Math.max(this.budget.maxDepth, ctx.procDepth);
    return true;
  },
  /* 同一根攻击对同一目标的同类效果只算一次（复用 §34 的 hitSet） */
  once(ctx, target, tag) {
    if (!ctx || !ctx.hitSet) return true;
    const k = tag + ':' + (target && target.uid !== undefined ? target.uid : target);
    if (ctx.hitSet.has(k)) return false;
    ctx.hitSet.add(k);
    return true;
  },
  tick(dt) {
    this.budget.frame = 0;
    this.budget.sec += dt;
    if (this.budget.sec >= 1) { this.budget.sec = 0; this.budget.spent = 0; }
    /* 过载×巨化：射击时累积动量，停火后存进下一发 */
    if (this.hasLink('overclock+giant')) {
      this._momentum = (this._momentum || 0) + (G.overclock > 0.5 ? dt * 0.6 : -dt * 0.3);
      this._momentum = clamp(this._momentum, 0, 1.5);
    }
    /* 一次性重击标记在被 recompute 读走后清掉，避免永久生效 */
    if (this._spearUsed) { this._spear = false; this._spearUsed = false; }
    if (this._heavyUsed) { this._heavyNext = false; this._heavyUsed = false; }
    if (this._spear) this._spearUsed = true;
    if (this._heavyNext) this._heavyUsed = true;
  },

  /* 首次触发允许一次更强反馈，之后回到克制的常态（§8.1） */
  isFirst(key) {
    if (this.firstFire[key]) return false;
    this.firstFire[key] = 1;
    G.bus.emit('synFirstFire', { key: key });
    return true;
  },

  /* --------------------------------------------------------- 授予 */
  grantBase(id) {
    if (this.has(id) || this.build.baseMutations.length >= TUNE.EVOLUTION.maxBaseMutations) return false;
    this.build.baseMutations.push(id);
    /* 复用既有的玩家侧实现与枪械器官（§9：不复制第二套表现系统） */
    G.mutations.push(id);
    G.mutationSet[id] = true;
    R.setGunOrgan(id, true);
    recompute();
    G.bus.emit('mutationChosen', { id: id });
    if (TUNE.FEATURES.hordeEvolution) HORDE.onBaseMutation(id);
    return true;
  },
  grantNode(cardId) { this.build.commonNodes[cardId] = (this.build.commonNodes[cardId] || 0) + 1; },
  grantLink(key) {
    if (this.hasLink(key)) return false;
    this.build.rareLinks.push(key);
    if (TUNE.FEATURES.hordeEvolution) HORDE.onRareLink(key);
    return true;
  },
  grantFusion(key) {
    if (this.hasFusion(key)) return false;
    this.build.epicFusions.push(key);
    if (TUNE.FEATURES.hordeEvolution) HORDE.onEpicFusion(key);
    return true;
  },
  grantRule(id) {
    if (this.hasRule(id)) return false;
    this.build.legendaryRules.push(id);
    if (TUNE.FEATURES.hordeEvolution) HORDE.onLegendary(id);
    return true;
  },
  grantAbility(id) { if (!this.hasAbility(id)) this.build.mapAbilities.push(id); },

  /* --------------------------------------------------- 自动基础反应 §7.7 */
  /* 十五组全部挂在事件总线上，和 §33 的既有做法一致：
     新增一组反应 = 加一条数据 + 一个订阅，不动枪械或敌人主循环。 */
  _install() {
    if (this._installed) return;
    this._installed = true;
    const bus = G.bus;

    /* 全部挂在 combat.js 已有的 hit / kill / damage 三个事件上。
       §9 明确要求新模块不复制第二套命中与伤害系统 —— 所以这里只做“解读”：
       从 AttackContext 的 source 判断这次是主弹、分裂弹还是爆炸的次级伤害。 */
    const isBlast = ctx => ctx && typeof ctx.source === 'string' && ctx.source.indexOf('blast') === 0;

    bus.on('hit', ev => {
      if (!TUNE.FEATURES.buildSynergy) return;
      const ctx = ev.ctx, e = ev.enemy;
      const primary = ctx.source === 'primary';
      const split = ctx.source === 'split' || ctx.source === 'blastShard';

      /* 穿透命中：只有真的会继续飞的子弹才算 */
      if (primary && G.derived.pierce > 0) bus.emit('pierceHit', { enemy: e, ctx: ctx, point: ev.point, dir: ev.dir });
      if (split) bus.emit('splitHit', { enemy: e, ctx: ctx });
      if (G.derived.bulletScale > 1.3) bus.emit('bulletHit', { enemy: e, ctx: ctx, big: true });
      if (ctx.canBuildConduction) bus.emit('conductCharge', { enemy: e, ctx: ctx });
    }, 20);

    bus.on('damage', ev => {
      if (!TUNE.FEATURES.buildSynergy) return;
      if (isBlast(ev.ctx)) bus.emit('blastHit', { enemy: ev.enemy, ctx: ev.ctx });
      /* 连锁闪电的次级伤害在 combat.js 里 source 是 'lightning' */
      if (ev.ctx && ev.ctx.source === 'lightning') {
        bus.emit('shockHit', { enemy: ev.enemy, ctx: ev.ctx });
        this._lastShock = ev.enemy;
      }
    }, 20);
    /* 一条闪电打完的那一跳 —— 用于“最后一名电击目标生成电孢子” */
    bus.on('kill', ev => {
      if (ev.ctx && ev.ctx.source === 'lightning') bus.emit('chainEnd', { last: ev.enemy, ctx: ev.ctx, gen: 0 });
    }, 26);

    bus.on('kill', ev => {
      if (!TUNE.FEATURES.buildSynergy) return;
      if (isBlast(ev.ctx)) bus.emit('blastKill', { enemy: ev.enemy, ctx: ev.ctx });
      /* 爆裂本体在 combat.js 的订阅里已经炸过了；这里只负责“爆炸发生了”这件事的下游 */
      if (hasMut('blast') && ev.ctx && ev.ctx.canTriggerOnKill) {
        bus.emit('blastFired', { pos: ev.enemy.pos, ctx: ev.ctx });
      }
    }, 20);

    /* --- 爆裂 × 分裂：爆炸时额外释放 1 枚低伤裂片 --- */
    bus.on('blastFired', d => {
      if (!this.comboActive('blast+fission') || !this.allow(d.ctx, 2)) return;
      const n = this.hasFusion('blast+fission') ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const t = pickChainTarget(d.pos.x, d.pos.z, 14 * G.derived.mutRadius, null);
        if (!t) break;
        const dir = V3.set(t.pos.x - d.pos.x, 0.2, t.pos.z - d.pos.z).normalize();
        spawnBullet(d.pos, dir, G.derived.damage * 0.35 * G.derived.mutDamage,
          deriveAttack(d.ctx, 'blastShard'), { split: true, scale: 0.8 });
      }
      G.stats.shards = (G.stats.shards || 0) + n;
    });

    /* --- 爆裂 × 过载：爆炸击杀补充少量过载值 --- */
    bus.on('blastKill', d => {
      if (!this.comboActive('blast+overclock')) return;
      G.overclock = Math.min(1, G.overclock + (this.hasLink('blast+overclock') ? 0.10 : 0.05));
    });

    /* --- 爆裂 × 骨化：首次穿透目标时植入死亡爆标 --- */
    bus.on('pierceHit', d => {
      if (!this.comboActive('blast+ossify') || !this.once(d.ctx, d.enemy, 'boneMark')) return;
      d.enemy.boneMark = (d.enemy.boneMark || 0) + 1;
      d.enemy.boneMarkCtx = d.ctx;
    });

    /* --- 爆裂 × 传导：爆炸命中为传导增加 1 层充能 --- */
    bus.on('blastHit', d => {
      if (!this.comboActive('blast+conduct') || !this.once(d.ctx, d.enemy, 'blastCharge')) return;
      G.conductCounter++;
    });

    /* --- 爆裂 × 巨化：爆炸范围与击退随弹体尺寸增长 --- */
    /* 纯被动，读 derived 即可，见 recomputeSynergy */

    /* --- 分裂 × 传导：分裂弹命中也能为传导充能 --- */
    bus.on('splitHit', d => {
      if (!this.comboActive('fission+conduct') || !this.once(d.ctx, d.enemy, 'splitCharge')) return;
      G.conductCounter++;
    });

    /* --- 分裂 × 骨化：分裂弹继承一次低伤穿透（recomputeSynergy 处理） --- */

    /* --- 过载 × 传导：射速越高，传导充能越快 --- */
    bus.on('conductCharge', d => {
      if (!this.comboActive('overclock+conduct')) return;
      if (G.overclock > 0.6 && RNG.fx.chance(G.overclock * 0.35)) G.conductCounter++;
    });

    /* --- 骨化 × 传导：被穿透的目标短暂成为导体 --- */
    bus.on('pierceHit', d => {
      if (!this.comboActive('ossify+conduct')) return;
      d.enemy.conductor = 2.0;
    });

    /* --- 传导 × 巨化：巨弹每次命中提供额外传导充能 --- */
    bus.on('bulletHit', d => {
      if (!this.comboActive('conduct+giant') || !d.big) return;
      if (!this.once(d.ctx, d.enemy, 'giantCharge')) return;
      G.conductCounter++;
    });

    /* ------------------------------------------------------------------
       稀有连接（15 张）与史诗融合（15 张）
       连接把两个节点接成回路，融合再把回路放大一档。
       所有分支都先过 allow()/once()，所以任何一条都不可能自繁殖到失控。
       ------------------------------------------------------------------ */

    /* 1 爆裂×分裂：裂片击杀 → 小型尸爆；融合再让尸爆继续放追踪裂片 */
    bus.on('kill', ev => {
      if (ev.ctx.source !== 'blastShard') return;
      if (!this.hasLink('blast+fission') || !this.allow(ev.ctx, 3)) return;
      const r = 2.2 * G.derived.mutRadius;
      areaDamage(ev.enemy.pos, r, G.derived.damage * 0.45 * G.derived.mutDamage,
        deriveAttack(ev.ctx, 'blast'), 'shardBlast');
      R.ring(ev.enemy.pos, 0.3, r, MUT.blast.color, 0.3);
      this.isFirst('blast+fission');
    }, 25);

    /* 5 爆裂×巨化：被巨弹撞飞的敌人碰撞后小爆一次 */
    bus.on('knockImpact', d => {
      if (!this.hasLink('blast+giant') || !this.allow(d.ctx, 3)) return;
      const r = (this.hasFusion('blast+giant') ? 4.2 : 2.6) * G.derived.mutRadius;
      areaDamage(d.other.pos, r, G.derived.damage * 0.5 * G.derived.mutDamage,
        deriveAttack(d.ctx, 'blast'), 'slamBlast');
      R.ring(d.other.pos, 0.4, r, MUT.giant.color, 0.34);
      this.isFirst('blast+giant');
    }, 25);

    /* 7 分裂×骨化：每次穿透向侧面射出骨针；融合让骨针继续分叉 */
    bus.on('pierceHit', d => {
      if (!this.hasLink('fission+ossify') || !this.once(d.ctx, d.enemy, 'boneNeedle')) return;
      if (!this.allow(d.ctx, 2)) return;
      const n = this.hasFusion('fission+ossify') ? 3 : 2;
      const base = d.dir || V3.set(0, 0, 1);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const dir = V3b.set(Math.cos(a) * 0.9, 0.05, Math.sin(a) * 0.9).normalize();
        spawnBullet(d.point || d.enemy.pos, dir, G.derived.damage * 0.3 * G.derived.mutDamage,
          deriveAttack(d.ctx, 'split'), { split: true, scale: 0.7 });
      }
      this.isFirst('fission+ossify');
    }, 25);

    /* 8 分裂×传导：最后一名电击目标生成电孢子；融合让孢子再繁殖一代 */
    bus.on('chainEnd', d => {
      if (!this.hasLink('fission+conduct') || !d.last || !this.allow(d.ctx, 2)) return;
      const gen = (d.gen || 0);
      if (gen >= (this.hasFusion('fission+conduct') ? 2 : 1)) return;
      G.conductCounter += 2;
      R.puff(d.last.pos, 0.2, 2.0, MUT.conduct.color, 0.3);
      this.isFirst('fission+conduct');
    }, 25);

    /* 2 / 6 / 10 / 11：过载的四条“维持”连接统一在这里加时间 */
    bus.on('splitHit', () => { if (this.hasLink('fission+overclock')) G.overclock = Math.min(1, G.overclock + 0.02); }, 25);
    bus.on('pierceHit', () => { if (this.hasLink('overclock+ossify')) G.overclock = Math.min(1, G.overclock + 0.015); }, 25);
    bus.on('shockHit', () => { if (this.hasLink('overclock+conduct')) G.overclock = Math.min(1, G.overclock + 0.03); }, 25);

    /* 13 骨化×传导：下一次闪电优先沿穿透线传播（导体标记已由自动反应打上） */
    /* 15 传导×巨化：闪电锚定在飞行中的巨弹上 —— 表现为命中时额外一次充能 */
    bus.on('bulletHit', d => {
      if (!d.big || !this.hasLink('conduct+giant')) return;
      if (!this.once(d.ctx, d.enemy, 'anchor')) return;
      G.conductCounter += this.hasFusion('conduct+giant') ? 2 : 1;
    }, 25);

    /* 12 过载×巨化 / 14 骨化×巨化：按发数攒出一次重击 */
    bus.on('fire', () => {
      this._shots = (this._shots || 0) + 1;
      if (this.hasLink('ossify+giant') && this._shots % (this.hasFusion('ossify+giant') ? 8 : 14) === 0) {
        this._spear = true;
      }
      if (this.hasLink('overclock+giant') && G.overclock <= 0.02 && this._momentum > 0.5) {
        this._heavyNext = true; this._momentum = 0;
      }
    }, 25);

    /* --- 稀有连接：裂片击杀触发小型尸爆（blast+fission） --- */
    bus.on('enemyDeath', d => {
      const e = d.enemy;
      /* 骨雷：被穿透的敌人死亡时沿射线爆炸（blast+ossify） */
      if (e.boneMark && this.comboActive('blast+ossify')) {
        const ctx = e.boneMarkCtx || makeAttack('boneMark');
        if (this.allow(ctx, 2)) {
          const r = 2.6 * G.derived.mutRadius * (this.hasFusion('blast+ossify') ? 1.5 : 1);
          areaDamage(e.pos, r, G.derived.damage * 0.5 * G.derived.mutDamage,
            deriveAttack(ctx, 'boneBlast'), 'boneBlast');
          R.ring(e.pos, 0.4, r, MUT.ossify.color, 0.34);
        }
        e.boneMark = 0;
      }
    });
  },

  /* 把自动反应里的“纯被动”部分折进 derived，热路径不做查表（§9） */
  applyDerived(d) {
    if (!TUNE.FEATURES.buildSynergy || !this.build) return d;
    /* 爆裂 × 巨化：爆炸范围随弹体尺寸 */
    if (this.comboActive('blast+giant')) d.mutRadius *= 1 + (d.bulletScale - 1) * 0.5;
    /* 分裂 × 过载：过载阶段提高分裂弹数量（自动反应 6） */
    if (this.comboActive('fission+overclock')) d.splitExtra = (d.splitExtra || 0) + (G.overclock > 0.5 ? 1 : 0);
    /* 爆裂 × 过载连接：满过载提高爆炸范围 */
    if (this.hasLink('blast+overclock') && G.overclock > 0.9) d.mutRadius *= 1.35;
    /* 骨化 × 巨化连接：攻城骨矛就绪时，下一发穿透与体积拉满 */
    if (this._spear) { d.pierce += 4; d.bulletScale *= 1.8; }
    /* 过载 × 巨化连接：停火存下的动量给下一发 */
    if (this._heavyNext) { d.damage *= 2.2; d.bulletScale *= 1.6; }
    /* 融合整体再放大一档 —— 融合必须“看起来就不一样”，不是数值 +5% */
    if (this.build.epicFusions.length) d.mutDamage *= 1 + 0.12 * this.build.epicFusions.length;
    /* 分裂 × 骨化：分裂弹继承一次穿透 */
    if (this.comboActive('fission+ossify')) d.splitPierce = (d.splitPierce || 0) + 1;
    /* 分裂 × 巨化：分裂弹变大并获得击退 */
    if (this.comboActive('fission+giant')) { d.splitScale = 1.5; d.splitKnock = 1.0; }
    /* 过载 × 骨化：高过载时获得穿透 */
    if (this.comboActive('overclock+ossify')) d.pierce += G.overclock > 0.65 ? 1 : 0;
    /* 过载 × 巨化：持续射击让弹体增大 */
    if (this.comboActive('overclock+giant')) d.bulletScale *= 1 + G.overclock * 0.45;
    /* 骨化 × 巨化：巨弹继承穿透宽度 */
    if (this.comboActive('ossify+giant')) d.pierceWidth = 1.5;
    /* 普通节点 */
    d.damage *= 1 + 0.10 * this.node('node_dmg');
    d.pierce += this.node('node_pierce');
    if (this.node('node_split')) d.splitExtra = this.node('node_split');
    if (this.node('node_conduct')) d.conductThreshold = -this.node('node_conduct');
    /* 传奇规则 */
    if (this.hasRule('legend_chain')) d.chainSelfSeed = true;
    if (this.hasRule('legend_mag')) d.infiniteMag = true;
    return d;
  },

  /* 构筑图文本（§7.10 暂停面板可查看本局构筑关系） */
  describe() {
    const b = this.build;
    const line = [];
    line.push('基础变异：' + (b.baseMutations.map(id => MUT[id].name).join(' · ') || '—'));
    const autos = this.activeCombos().map(c => MUT[c.a].name + '×' + MUT[c.b].name + ' → ' + c.autoText);
    line.push('自动反应：' + (autos.join('；') || '—'));
    line.push('稀有连接：' + (b.rareLinks.map(k => COMBO_MAP[k].linkName).join(' · ') || '—'));
    line.push('史诗融合：' + (b.epicFusions.map(k => COMBO_MAP[k].fusionName).join(' · ') || '—'));
    line.push('传奇规则：' + (b.legendaryRules.length ? b.legendaryRules.join(' · ') : '—'));
    line.push('地图能力：' + (b.mapAbilities.length ? b.mapAbilities.join(' · ') : '—'));
    return line;
  }
};
