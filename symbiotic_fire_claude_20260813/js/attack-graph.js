/* ============================================================================
   SYMBIOTIC FIRE · 统一弹丸谱系与事件顺序（todo5 §6）

   §6 的硬纪律：所有模块共享同一套弹丸谱系，禁止各模块私自生成不受控制的新子弹。
   这个文件是【唯一】的派生出口。任何模块想生成弹丸、爆炸、震波，
   都必须走 AG.spawnDerived / AG.blast，因此必然经过：
     递归深度 → 单根派生数 → 单根事件数 → 单帧/每秒全局预算 → 同目标命中上限

   §6.1 的顺序也在这里，而且是一个函数里的顺序语句，不是若干个各自订阅的回调：
     1 齐射生成根弹              （fire() 调 AG.beginRoot + AG.rootBullet）
     2 应用重型/动势等根弹属性   （recompute 已折进 derived，rootBullet 直接读）
     3 命中先结算直接伤害与穿透  （AG.onHit 第 3 步）
     4 穿透耗尽后结算弹射        （第 4 步）
     5 分裂生成次级弹            （第 5 步）
     6 爆裂载荷按当前继承系数结算（第 6 步）
     7 超频只改节奏，不建平行伤害系统（不在本文件，见 WMOD.tick）
   ========================================================================== */
'use strict';

let _geneEvent = 0;
let _rootId = 0;

const AG = {
  /* 全局预算（§6.3 单帧与每秒） */
  gBudget: { frame: 0, sec: 0, secT: 0, rejected: 0, maxDepth: 0, roots: 0, derived: 0, events: 0 },
  /* 反馈合并（§11 高射速下禁止逐事件播放完整爆炸音） */
  fx: { blastSoundT: 0, blastSounds: 0, ringT: 0 },
  /* §10 的战斗消费者登记表：卡牌审计要靠它证明「这张卡真的有人消费」 */
  consumers: {},

  init() {
    this.gBudget = { frame: 0, sec: 0, secT: 0, rejected: 0, maxDepth: 0, roots: 0, derived: 0, events: 0 };
    this.fx = { blastSoundT: 0, blastSounds: 0, ringT: 0 };
    this._registerConsumers();
    return this;
  },

  /* --------------------------------------------------------------------------
     §10 战斗消费者登记。每一项都对应本文件或 weapon-modules.js 里真实存在的代码路径。
     module-pool.js 的 audit() 会拿卡牌声明的 consumer 名字来这里核对。
     -------------------------------------------------------------------------- */
  _registerConsumers() {
    const c = {};
    [
      'volley.pellets', 'volley.pattern', 'volley.wall', 'volley.ammo',
      'blast.radius', 'blast.core', 'blast.ring', 'blast.terminal', 'blast.budget',
      'pierce.count', 'pierce.decay', 'pierce.over', 'pierce.width',
      'split.count', 'split.coef', 'split.home', 'split.wave', 'split.scale',
      'heavy.rate', 'heavy.knock', 'heavy.siege', 'heavy.body',
      'overclock.ramp', 'overclock.mag', 'overclock.redline', 'overclock.cadence', 'overclock.hold',
      'ricochet.count', 'ricochet.decay', 'ricochet.lash', 'ricochet.range',
      'momentum.window', 'momentum.gain', 'momentum.core', 'momentum.round',
      'cond.weak', 'cond.reload', 'cond.kill',
      'rule.depth', 'rule.derive', 'rule.blast', 'rule.hit', 'rule.mag',
      /* 沿用 todo/todo2 已有实现的通用消费者 */
      'gun.mag', 'gun.reload', 'gun.optic', 'gun.feedback', 'gun.hunter',
      'gun.aftershock', 'life.speed', 'life.dashcd', 'life.hp', 'life.heal', 'life.magnet'
    ].forEach(k => { c[k] = true; });
    this.consumers = c;
  },
  hasConsumer(k) { return !!this.consumers[k]; },

  /* ==========================================================================
     每帧
     ========================================================================== */
  tick(dt) {
    this.gBudget.frame = 0;
    this.gBudget.secT += dt;
    if (this.gBudget.secT >= 1) { this.gBudget.secT = 0; this.gBudget.sec = 0; }
    this.fx.blastSoundT -= dt;
    if (this.fx.blastSoundT <= 0) { this.fx.blastSoundT = TUNE.GENEALOGY.blastSoundWindow; this.fx.blastSounds = 0; }
  },

  /* ==========================================================================
     §6.2 谱系节点
     effectBudgetRemaining 是【整根攻击共享】的，所以做成读 root 的取值器 ——
     如果每个节点各存一份，子弹一分裂预算就凭空翻倍，硬上限会形同虚设。
     ========================================================================== */
  beginRoot(pellets) {
    const d = G.derived;
    const root = {
      id: ++_rootId,
      pellets: Math.max(1, pellets || 1),
      derived: d.genDerived,           // 剩余可派生弹数（整根共享）
      events: d.genEvents,             // 剩余可产生效果事件数（整根共享）
      hits: new Map(),                 // uid -> 已命中次数
      hitSet: new Set(),               // 同类效果对同一目标只算一次（复用 §34 语义）
      blast: d.blastOn ? d.blastBudget : 0,   // §4.1 统一爆炸预算
      siegeUsed: false,
      waveFired: 0
    };
    this.gBudget.roots++;
    return root;
  },

  gene(root, opts) {
    opts = opts || {};
    const g = makeAttack(opts.source || 'primary', {
      hitSet: root.hitSet,
      procDepth: opts.depth || 0,
      canBuildConduction: false,       // todo5 没有电导；保留字段让旧订阅安全短路
      splitUsed: !!opts.splitUsed
    });
    g.rootAttackId = root.id;
    g.parentEventId = opts.parentEventId || 0;
    g.eventId = ++_geneEvent;
    g.depth = opts.depth || 0;
    g.sourceModule = opts.sourceModule || 'root';
    g.damageCoefficient = opts.damageCoefficient === undefined ? 1 : opts.damageCoefficient;
    g.payloadCoefficient = opts.payloadCoefficient === undefined ? 1 : opts.payloadCoefficient;
    g.remainingPierce = opts.remainingPierce || 0;
    g.remainingBounce = opts.remainingBounce || 0;
    g.root = root;
    Object.defineProperty(g, 'effectBudgetRemaining', { get: () => root.events, enumerable: true });
    if (g.depth > this.gBudget.maxDepth) this.gBudget.maxDepth = g.depth;
    return g;
  },

  /* --------------------------------------------------- §6.3 五道硬上限 */
  /* 效果事件：爆炸、震波、合并分裂波等一切「发生了一件事」 */
  allowEvent(gene, cost) {
    const B = TUNE.GENEALOGY, k = cost || 1;
    const root = gene && gene.root;
    if (gene && gene.depth >= G.derived.genDepth) { this.gBudget.rejected++; return false; }
    if (root && root.events < k) { this.gBudget.rejected++; return false; }
    if (this.gBudget.frame + k > B.perFrame) { this.gBudget.rejected++; return false; }
    if (this.gBudget.sec + k > B.perSecond) { this.gBudget.rejected++; return false; }
    if (root) root.events -= k;
    this.gBudget.frame += k; this.gBudget.sec += k; this.gBudget.events += k;
    return true;
  },
  /* 派生弹：与效果事件分开计数，因为对象数量和事件数量是两种资源 */
  allowDerived(gene, n) {
    const B = TUNE.GENEALOGY, root = gene && gene.root;
    const k = n || 1;
    if (gene && gene.depth + 1 >= G.derived.genDepth) { this.gBudget.rejected++; return 0; }
    if (G.bullets.count + k > B.projectileCap) { this.gBudget.rejected++; return 0; }
    if (!root) return 0;
    const give = Math.min(k, root.derived);
    if (give <= 0) { this.gBudget.rejected++; return 0; }
    root.derived -= give;
    this.gBudget.derived += give;
    return give;
  },
  /* 同一目标在单根攻击里的重复命中上限 */
  gate(gene, enemy) {
    const root = gene && gene.root;
    if (!root) return true;
    const n = root.hits.get(enemy.uid) || 0;
    if (n >= G.derived.genHits) return false;
    root.hits.set(enemy.uid, n + 1);
    return true;
  },

  /* ==========================================================================
     §6.1 第 1～2 步：齐射生成根弹，并应用重型 / 动势等根弹属性
     ========================================================================== */
  rootBullet(root, origin, dir, index) {
    const d = G.derived;
    const g = this.gene(root, {
      source: 'primary', sourceModule: 'root', depth: 0,
      damageCoefficient: 1, payloadCoefficient: 1,
      remainingPierce: d.pierce, remainingBounce: d.bounce
    });
    const b = spawnBullet(origin, dir, d.damage, g, {
      pierce: d.pierce, scale: 1, gene: g
    });
    if (b) {
      b.gene = g;
      b.baseDmg = d.damage;
      b.pierceHits = 0;
      b.pendingBlast = false;
      b.volleyIndex = index || 0;
    }
    return b;
  },

  /* ==========================================================================
     §6.1 第 3～6 步：一次命中的完整结算，顺序写死在这里
     返回 true = 子弹继续飞，false = 子弹终结
     ========================================================================== */
  onHit(b, e, point, weak, dealt) {
    const d = G.derived, g = b.gene;
    if (!g) return false;
    const M = TUNE.MODULES;

    /* --- 第 3 步：直接伤害已由 combat.js 结算完；这里记归因并处理穿透 --- */
    const mod = g.sourceModule === 'root' ? (d.heavyOn ? 'heavy' : null) : g.sourceModule;
    if (dealt > 0) {
      if (g.depth === 0) {
        if (d.heavyOn) WMOD.count('heavy', 'direct', dealt);
        if (d.pellets > 1) WMOD.count('volley', 'direct', dealt);
        if (b.pierceHits > 0) WMOD.count('pierce', 'derived', dealt);
        if (b.bounceHits > 0) WMOD.count('ricochet', 'derived', dealt);
      } else if (mod && WMOD.stats[mod]) {
        WMOD.count(mod, 'derived', dealt);
      }
    }

    /* §8 条件分支「弱点回响」：弱点命中提高本次攻击的载荷继承 */
    if (weak && WMOD.node('n_cond_weak') > 0) {
      g.payloadCoefficient = Math.min(1.6, g.payloadCoefficient * (1 + 0.22 * WMOD.node('n_cond_weak')));
    }

    /* --- 第 3 步（后半）：穿透。只有真的还能继续飞才算贯穿（§2.3）--- */
    let pierced = false;
    if (g.remainingPierce > 0) {
      g.remainingPierce--;
      b.pierceHits = (b.pierceHits || 0) + 1;
      WMOD.count('pierce', 'trigger');
      WMOD.count('pierce', 'targets');
      /* 过穿增幅分支：递增取代衰减，但有明确上限（§7.3 传奇之外也要有上限） */
      if (d.pierceRampOn) {
        const up = Math.min(d.pierceRampMax, d.pierceRamp * b.pierceHits);
        b.dmg = b.baseDmg * g.damageCoefficient * (1 + up);
      } else {
        g.damageCoefficient *= d.pierceDecay;
        b.dmg = b.baseDmg * g.damageCoefficient;
      }
      g.payloadCoefficient *= d.piercePayload;
      pierced = true;
    }

    /* 「这一列穿完了吗」必须在弹射改写 remainingPierce 之前记下来 ——
       _bounce 会把贯穿次数补回一半，之后再读就永远读不到列尾。 */
    const columnEnd = g.remainingPierce <= 0;

    /* --- 第 4 步：弹射在【贯穿预算耗尽的那一刻】结算（§6.1 第 4 步原文）---
       不能写成「等下一次命中再折」：那样一条只有 3 个人的队列被穿完之后，
       子弹会直接飞出去消失，「穿完一列再折向另一列」（§4.4）永远不会发生。 */
    let bounced = false;
    if (columnEnd && g.remainingBounce > 0) bounced = this._bounce(b, e, point);
    const terminal = !pierced && !bounced;

    /* --- 第 5 步：分裂生成次级弹 --- */
    if (d.splitCount > 0 && !g.splitUsed) this._split(b, e, point, terminal);

    /* --- 第 6 步：爆裂载荷按当前继承系数结算 ---
       §4.3 终点爆破：中途穿过普通敌人不炸，留到这一列的最后有效目标。
       列尾兑现而不是整根弹的最后一跳兑现 —— §12.3 的「爆裂+穿透+弹射」要的正是
       「终点爆破之后再折向新队列」，每一列都该有自己的终点。
       Boss 与精英例外：§2.2 要求对 Boss 保留直击 + 爆炸双份价值。 */
    if (d.blastOn) {
      const big = e.boss || (e.tpl && e.tpl.elite);
      if (d.blastTerminal && !columnEnd && !big) {
        b.pendingBlast = true;
      } else {
        this.blast(g, point, { pellets: g.root.pellets, terminal: columnEnd });
        b.pendingBlast = false;
      }
    }

    /* 攻城弹头分支：重型弹终点沿飞行方向产生一次横向震波 */
    if (terminal && d.heavyOn && WMOD.hasBranch('b_heavy_siege') && !g.root.siegeUsed) {
      this._siege(b, point);
    }
    return !terminal;
  },

  /* 子弹自然终结（射程 / 出界 / 撞掩体）：终点爆破必须在这里兑现（§4.3） */
  onBulletEnd(b, pos) {
    if (!b.gene) return;
    if (b.pendingBlast) {
      this.blast(b.gene, pos, { pellets: b.gene.root.pellets, terminal: true });
      b.pendingBlast = false;
    }
  },

  /* ==========================================================================
     爆裂 §2.2 / §4.1
     统一爆炸预算：单次攻击一份，按根弹数分摊。齐射越多，每个爆点越小、
     覆盖形状越散 —— 而不是把同一个完整倍率复制 N 遍。
     ========================================================================== */
  blast(gene, pos, opts) {
    opts = opts || {};
    const d = G.derived, B = TUNE.GENEALOGY, root = gene.root;
    if (!root || root.blast <= 0) return 0;
    if (!this.allowEvent(gene, 2)) return 0;

    const want = root.blast / Math.max(1, opts.pellets || 1);
    const grant = Math.min(root.blast, want) * gene.payloadCoefficient;
    if (grant <= 0.01) return 0;
    root.blast -= Math.min(root.blast, want);

    const rk = clamp(Math.cbrt(grant), B.blastRadiusFloor, B.blastRadiusCeil);
    const radius = d.blastRadius * rk;
    const dmg = b_baseDamage() * d.blastDmg * grant;

    const sub = this.gene(root, {
      source: 'blast', sourceModule: 'blast', depth: gene.depth + 1,
      parentEventId: gene.eventId, splitUsed: true,
      damageCoefficient: gene.damageCoefficient, payloadCoefficient: gene.payloadCoefficient
    });
    sub.blastGeneration = (gene.blastGeneration || 0) + 1;
    sub.canTriggerOnKill = false;    // 爆炸不再引爆下一具尸体：todo5 里连锁只走谱系

    const inner = d.blastRing ? radius * TUNE.MODULES.blast.ringInner : 0;
    const hits = this.areaDamage(sub, pos, radius, dmg, inner, d.blastRing);

    WMOD.count('blast', 'trigger');
    WMOD.count('blast', 'targets', hits);
    G.stats.blasts = (G.stats.blasts || 0) + 1;
    this._blastFx(pos, radius, opts.terminal, grant);
    return hits;
  },

  /* 区域伤害：支持环形（空心爆破分支）与中心加成，并统计归因目标数 */
  areaDamage(gene, center, radius, dmg, inner, ring) {
    const list = enemiesInRadius(center.x, center.z, radius, []);
    let hits = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const dist = Math.hypot(e.pos.x - center.x, e.pos.z - center.z);
      if (inner > 0 && dist < inner) continue;              // 环形爆心不伤害
      if (!markOnce(gene, e, 'blast' + gene.eventId)) continue;
      if (!this.gate(gene, e)) continue;
      /* 中心更疼：聚能核节点让这条曲线更陡，边缘不变 */
      const k = ring ? 1 : lerp(1, 0.55, clamp(dist / Math.max(0.01, radius), 0, 1));
      const before = e.hp;
      damageEnemy(e, dmg * k, gene, { area: true, point: e.pos });
      WMOD.count('blast', 'derived', Math.min(before, dmg * k));
      if (ring) {
        /* 向内击退：环形冲击的可读性全靠这个方向 */
        const kx = (center.x - e.pos.x) / Math.max(0.01, dist), kz = (center.z - e.pos.z) / Math.max(0.01, dist);
        e.knock.x += kx * G.derived.knockback * 0.8;
        e.knock.z += kz * G.derived.knockback * 0.8;
      }
      hits++;
    }
    return hits;
  },

  /* ==========================================================================
     分裂 §2.4 / §5（分裂×超频必须合并成波，禁止逐弹对象爆炸）
     ========================================================================== */
  _split(b, e, point, terminal) {
    const d = G.derived, g = b.gene;

    /* §5 分裂×超频：高速枪流下把分裂攒成周期性的一次合并波 */
    if (d.splitWave && WMOD.oc.ramp > 0.35) {
      WMOD.wave.hits++;
      if (WMOD.wave.hits < d.splitWaveHits) { g.splitUsed = true; return; }
      WMOD.wave.hits = 0;
      g.splitUsed = true;
      if (!this.allowEvent(g, 2)) return;
      this._spawnSplit(b, point, d.splitWaveCount, true);
      return;
    }

    g.splitUsed = true;
    this._spawnSplit(b, point, d.splitCount, false);
  },

  _spawnSplit(b, point, count, wave) {
    const d = G.derived, g = b.gene;
    const n = this.allowDerived(g, count);
    if (n <= 0) return;

    const exclude = new Set();
    const dmgCoef = g.damageCoefficient * d.splitDmg;
    const payload = g.payloadCoefficient * d.splitPayload;
    /* §5 穿透×分裂：次级弹继承低倍率穿透 */
    const inheritPierce = Math.floor(d.pierce * TUNE.MODULES.split.pierceInherit);
    /* §5 分裂×弹射：次级弹获得有限弹射，共享同一份派生预算 */
    const inheritBounce = d.bounce > 0 ? 1 : 0;

    for (let i = 0; i < n; i++) {
      let dir;
      const tgt = pickChainTarget(point.x, point.z, TUNE.ATOMS.splitSearch, exclude);
      if (tgt) {
        exclude.add(tgt.uid);
        dir = V3.set(tgt.pos.x - point.x, tgt.pos.y + tgt.height * 0.55 - point.y, tgt.pos.z - point.z).normalize().clone();
      } else {
        /* 找不到目标时按稳定图案展开（§2.4），不要随机乱飞 */
        const a = ((i + 0.5) / n - 0.5) * (wave ? 2.4 : 1.3);
        dir = b.dir.clone().applyAxisAngle(UP, a).normalize();
      }
      const sub = this.gene(g.root, {
        source: 'split', sourceModule: 'split', depth: g.depth + 1,
        parentEventId: g.eventId,
        damageCoefficient: dmgCoef, payloadCoefficient: payload,
        remainingPierce: inheritPierce, remainingBounce: inheritBounce,
        /* 次级弹能否再分裂完全由深度上限决定；数量还要再减半，所以必然收敛 */
        splitUsed: false
      });
      const nb = spawnBullet(point, dir, b.baseDmg * dmgCoef, sub,
        { split: true, pierce: inheritPierce, scale: d.splitScale, gene: sub });
      if (nb) {
        nb.gene = sub;
        nb.baseDmg = b.baseDmg;
        nb.pierceHits = 0;
        nb.pendingBlast = false;
        nb.homing = d.splitHome ? 0.9 : 0;
        /* 下一代的分裂数减半，配合深度上限形成收敛序列（§2.4 禁止无上限递归） */
        nb.splitBudget = Math.floor((b.splitBudget !== undefined ? b.splitBudget : d.splitCount) * 0.5);
        if (nb.splitBudget <= 0) sub.splitUsed = true;
      }
    }
    WMOD.count('split', 'trigger');
    G.stats.splits = (G.stats.splits || 0) + n;
    if (typeof Audio2 !== 'undefined') Audio2.derived(point, 'split');
    if (typeof R !== 'undefined' && R.puff)
      R.puff(point, 0.18, wave ? 2.4 : 1.3, TUNE.MODULES.split.color, wave ? 0.26 : 0.18);
  },

  /* ==========================================================================
     弹射 §2.7 / §4.4
     ========================================================================== */
  _bounce(b, e, point) {
    const d = G.derived, g = b.gene;
    if (!this.allowEvent(g, 1)) return false;
    const search = d.bounceSearch * (d.bounceLash ? 1 + 0.35 * (b.bounceHits || 0) : 1);
    const ex = new Set([e.uid]);
    if (b.hitList) b.hitList.forEach(u => ex.add(u));
    const tgt = pickChainTarget(point.x, point.z, search, ex);
    if (!tgt) return false;

    const from = b.dir.clone();
    b.pos.copy(point);
    b.prev.copy(point);
    b.dir.set(tgt.pos.x - point.x, tgt.pos.y + tgt.height * 0.55 - point.y, tgt.pos.z - point.z).normalize();
    /* 转折必须看得出来：角度太小就人为撑开，否则读起来像没折 */
    const minTurn = TUNE.MODULES.ricochet.minTurnDeg * Math.PI / 180;
    if (from.angleTo(b.dir) < minTurn) b.dir.applyAxisAngle(UP, minTurn);

    g.remainingBounce--;
    b.bounceHits = (b.bounceHits || 0) + 1;
    g.damageCoefficient *= d.bounceDecay;
    g.payloadCoefficient *= d.bouncePayload;
    b.dmg = b.baseDmg * g.damageCoefficient;
    /* §4.4 弹射后继承较低贯穿次数，避免无限折线 */
    g.remainingPierce = Math.floor(d.pierce * TUNE.MODULES.ricochet.pierceInherit);
    b.pierce = g.remainingPierce;
    b.life = Math.max(b.life, 0.45);
    b.hitList.clear();
    b.hitList.add(e.uid);

    WMOD.count('ricochet', 'trigger');
    WMOD.count('ricochet', 'targets');
    if (typeof Audio2 !== 'undefined') Audio2.derived(point, 'bounce');
    /* 折线曳光：这是弹射唯一的可读性来源（§11） */
    if (typeof WEAPON !== 'undefined' && WEAPON.ready)
      WEAPON.addTracer(point, b.dir, TUNE.MODULES.ricochet.color,
        Math.min(28, point.distanceTo(tgt.pos)));
    return true;
  },

  /* 攻城弹头：沿飞行方向的一条横向震波，每根攻击只有一次 */
  _siege(b, point) {
    const g = b.gene, d = G.derived;
    if (!this.allowEvent(g, 3)) return;
    g.root.siegeUsed = true;
    const len = TUNE.MODULES.heavy.siegeLen;
    const sub = this.gene(g.root, {
      source: 'siege', sourceModule: 'heavy', depth: g.depth + 1,
      parentEventId: g.eventId, splitUsed: true,
      damageCoefficient: g.damageCoefficient, payloadCoefficient: g.payloadCoefficient
    });
    sub.canTriggerOnKill = false;
    const step = 3.2;
    for (let t = step; t <= len; t += step) {
      const p = V3.copy(b.dir).multiplyScalar(t).add(point);
      this.areaDamage(sub, p, 2.6, b_baseDamage() * 0.34 * g.payloadCoefficient, 0, false);
    }
    WMOD.count('heavy', 'trigger');
    if (typeof R !== 'undefined' && R.ring) R.ring(point, 0.35, len * 0.55, TUNE.MODULES.heavy.color, 0.3);
    if (typeof Audio2 !== 'undefined') Audio2.blast(point, true);
  },

  /* --------------------------------------------------------------------------
     §11 反馈合并：同帧同源必须合并，高射速下禁止逐事件播放完整爆炸音
     -------------------------------------------------------------------------- */
  _blastFx(pos, radius, terminal, grant) {
    const B = TUNE.GENEALOGY, M = TUNE.MODULES;
    if (typeof R !== 'undefined' && R.rings && R.rings.count < TUNE.FX.maxConcurrentBlastFx) {
      R.ring(pos, 0.3, radius, M.blast.color, terminal ? 0.40 : 0.30);
      if (grant > 0.5) R.puff(V3.copy(pos).setY(pos.y + 0.7), 0.28, radius * 0.7, 0xffb35c, 0.24);
    }
    if (this.fx.blastSounds < B.soundPerBlastWindow) {
      this.fx.blastSounds++;
      if (typeof Audio2 !== 'undefined') Audio2.blast(pos, !!terminal);
      if (G.shake) G.shake(terminal ? 0.11 : 0.07, pos);
    }
  },

  /* Debug：把预算状态摊开给调试面板看（§11 的测量要求） */
  debugLine() {
    const g = this.gBudget;
    return 'root=' + g.roots + ' derived=' + g.derived + ' ev=' + g.events +
      ' rej=' + g.rejected + ' depth=' + g.maxDepth +
      ' f=' + g.frame + '/' + TUNE.GENEALOGY.perFrame +
      ' s=' + g.sec + '/' + TUNE.GENEALOGY.perSecond;
  }
};

/* 爆炸与震波的伤害基数：用「未经齐射衰减的单发基准」，
   否则齐射越多爆炸越弱两次，玩家会觉得爆裂被偷走了。 */
function b_baseDamage() {
  const d = G.derived;
  return d.pellets > 1 ? d.damage * d.pellets * 0.62 : d.damage;
}
