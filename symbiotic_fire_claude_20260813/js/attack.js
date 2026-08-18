/* ============================================================================
   SYMBIOTIC FIRE · 统一攻击规律（todo10 §8）

   这个文件取代了 todo5 的 attack-graph.js。它保留了谱系、归因和性能上限，
   但删掉了所有针对组合的专属代码路径 —— §11.2 的验收条件是
   「删掉任意组合名称表后，战斗结果不发生变化」，所以这里根本没有那张表。

   §8.1 的攻击顺序是【一个函数里的顺序语句】，不是若干个各自订阅、
   顺序靠优先级碰运气的回调：

     1 结算耗弹（fire 里）
     2 多发生成所有主弹
     3 通用倍率（武器状态在 derive，位置与目标在 BUILD.victimMul）
     4 主弹命中结算直接伤害
     5 每次主弹命中【独立】触发爆炸
     6 每次主弹命中【独立】产生一条弹射链
     7 主弹若仍有穿透次数，继续沿原方向前进并衰减
     8 弹射链按自身次数继续寻找新目标并逐跳衰减
     9 超频只更新下一次开火间隔
     10 击杀装填、归因和反馈读取统一伤害事件

   §8.3 的一条纪律，也是这个文件最重要的设计：
   **伤害与对象解耦。** 伤害永远算满 —— 那只是纯数学，很便宜；
   上限只砍【对象与视觉】。多发 7 颗 × 穿透 3 次 × 弹射 5 跳 = 单枪上百次
   伤害结算，如果每一次都要生成一个弹丸对象和一次特效，帧率必死；
   但如果只是加法和乘法，它一点都不贵。
   所以弹射链在这里是【即时结算】的，不生成弹丸；爆炸也不生成区域对象。
   玩家看得见并理解的伤害，一次都不会被静默削掉。
   ========================================================================== */
'use strict';

const _AV = { x: 0, y: 0, z: 0 };

const ATK = {
  /* 全局预算。fx 是真正稀缺的那个，伤害那两个只是死循环的保险丝。 */
  budget: { frame: 0, sec: 0, secT: 0, fxFrame: 0, rejected: 0, events: 0, roots: 0 },
  fx: { blastSoundT: 0, blastSounds: 0 },

  init() {
    this.budget = { frame: 0, sec: 0, secT: 0, fxFrame: 0, rejected: 0, events: 0, roots: 0 };
    this.fx.blastSoundT = 0; this.fx.blastSounds = 0;
    return this;
  },

  tick(dt) {
    const B = this.budget;
    B.frame = 0; B.fxFrame = 0;
    B.secT += dt;
    if (B.secT >= 1) { B.secT = 0; B.sec = 0; }
    this.fx.blastSoundT += dt;
    if (this.fx.blastSoundT >= TUNE.BUILD.blastSoundWindow) {
      this.fx.blastSoundT = 0; this.fx.blastSounds = 0;
    }
  },

  /* 视觉配额：触顶就合并表现，绝不砍伤害 */
  allowFx() {
    if (this.budget.fxFrame >= TUNE.BUILD.fxPerFrame) return false;
    this.budget.fxFrame++;
    return true;
  },
  /* 伤害事件配额：只防失控，正常战斗永远碰不到 */
  allowDamage(root) {
    const B = this.budget, T = TUNE.BUILD;
    if (root.events >= T.eventsPerRoot || B.frame >= T.perFrame || B.sec >= T.perSecond) {
      B.rejected++;
      return false;
    }
    root.events++; B.frame++; B.sec++; B.events++;
    return true;
  },

  /* ------------------------------------------------------------ 一次扳机 */
  /* 一次扳机 = 一个根攻击 = N 颗主弹。它们共享事件预算、重复命中上限
     和爆炸衰减计数 —— 但【不共享伤害预算】，那是 todo5 用来把组合收益
     重新摊平的东西，§8.3 明确删掉了。 */
  beginRoot(pellets) {
    const root = {
      id: ++this.budget.roots,
      pellets: pellets,
      events: 0,
      hits: {},          // uid -> 本根攻击已命中次数
      blasts: 0,         // 本根攻击已经爆过几次（爆炸衰减读它）
      refunded: 0,       // 击杀装填本根已返还多少
      /* 自动瞄准的锁定目标：一次扳机锁一次 */
      aim: G.derived.homing ? crosshairTarget(TUNE.DEMON.autoaim.cone, TUNE.DEMON.autoaim.range) : null
    };
    G.curRoot = root;
    return root;
  },

  /* 同一根攻击对同一目标的重复命中上限（§8.3 保留项） */
  gate(root, e) {
    const n = root.hits[e.uid] || 0;
    if (n >= TUNE.BUILD.hitsPerTargetPerRoot) return false;
    root.hits[e.uid] = n + 1;
    return true;
  },

  rootBullet(root, origin, dir, index) {
    const d = G.derived;
    const b = spawnBullet(origin, dir, d.damage, makeAttack('primary'), { pierce: d.pierce });
    if (!b) return null;
    b.root = root;
    /* 自动瞄准：整根攻击共用一个目标，在 beginRoot 时选一次。
       每颗弹丸各自选目标的话，多发一枪会散成一把扇子追七个人 ——
       那不是「自动瞄准」，是自动分裂。 */
    if (d.homing) b.homeE = root.aim;
    b.muz = root.muz;                 // 光带的起点：真实枪口（见 syncInstances）
    b.hopDmg = d.damage;          // 这颗弹当前的基准伤害（穿透会衰减它）
    b.pierceLeft = d.pierce;
    b.pelletIndex = index;
    return b;
  },

  /* -------------------------------------------------------- §8.1 第 4~7 步 */
  /* 返回 true = 子弹继续飞（还有穿透次数），false = 这颗弹到此为止。 */
  onHit(b, e, point, weak, dealt) {
    const d = G.derived, root = b.root;
    if (!root) return false;

    BUILD.stats.direct += dealt;
    if (b.pierceHits) BUILD.stats.pierce += dealt;

    /* 第 5 步：每次主弹命中【独立】触发爆炸。
       不再有「整根攻击只有一份爆炸预算」，也不再是只有终点才爆。 */
    if (d.blastOn) this.blast(root, point, b.hopDmg, e);

    /* 第 6 步：每次主弹命中【独立】产生一条弹射链。
       穿 5 个人就是 5 条链 —— §2.4 点名说这是允许的自然化学反应。
       链只能继续自己，不能从每次弹射命中再长出新的并行链。 */
    if (d.bounce > 0) this.bounceChain(root, e, point, b.hopDmg);

    /* 第 7 步：穿透让主弹继续向前。
       它【不等待】—— 弹射不是「穿透结束后再转弯」，两件事在同一次命中里
       各做各的（§2.3 最后一条 / §2.4 的核心纠偏）。 */
    if (b.pierceLeft > 0) {
      b.pierceLeft--;
      b.pierceHits = (b.pierceHits || 0) + 1;
      b.hopDmg *= d.pierceKeep;
      b.dmg = b.hopDmg;
      return true;
    }
    return false;
  },

  /* 子弹自然终结（射程 / 出界 / 撞掩体）：V3 没有终点爆破，这里不欠账 */
  onBulletEnd() {},

  /* ---------------------------------------------------------- 第 5 步：爆炸 */
  /* 每一次真实命中都爆。同一根攻击里连续爆炸按统一衰减递减 ——
     max(floor, ratio^(n-1))，掉到地板就不再掉。这是【统一衰减】，
     不是针对某一对组合的专属折算（§8.4 的调整优先级第二档）。 */
  blast(root, point, hitDmg, source) {
    const d = G.derived, T = TUNE.BUILD;
    const decay = Math.max(T.blastDecayFloor, Math.pow(T.blastDecay, root.blasts));
    root.blasts++;
    const dmg = hitDmg * d.blastDmg * decay;
    const r = d.blastRadius;
    if (dmg <= 0 || r <= 0) return;

    /* 查询半径要比爆炸半径大一圈：enemiesInRadius 的粗筛是
       `d² ≤ r² + 敌人半径²`，比下面那句 `d ≤ r + 敌人半径` 严格 ——
       用同一个 r 去查，边缘上的敌人会在粗筛阶段就被丢掉，
       表现是「敌人间距一大，爆炸就一个都炸不到」。 */
    const list = enemiesInRadius(point.x, point.z, r + 1.5, _blastBuf);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead || e === source) continue;
      const dx = e.pos.x - point.x, dz = e.pos.z - point.z;
      const dist = Math.hypot(dx, dz);
      if (dist > r + e.radius) continue;
      if (!this.allowDamage(root)) break;
      /* 边缘衰减：中心满伤，边缘 45% —— 让「站在爆点上」有意义 */
      const fall = 1 - 0.55 * Math.min(1, dist / Math.max(0.01, r));
      const m = BUILD.victimMul(e, false);
      const hp0 = e.hp;
      const got = damageEnemy(e, dmg * fall * m, null, { point: point, blast: true });
      BUILD.stats.blast += got;
      if (e.dead && hp0 > 0) BUILD.onKill(e, this._closeTo(e));
    }
    this._blastFx(point, r);
  },

  /* -------------------------------------------------------- 第 6/8 步：弹射 */
  /* 弹射链即时结算，不生成弹丸对象：一枪可能有 20 条链，每条 5 跳，
     生成 100 颗弹丸会直接把帧率打死，而算 100 次乘法什么都不是。
     玩家看到的是一条折线光带（受 fx 配额约束）和真实的伤害数字。 */
  bounceChain(root, from, point, hitDmg) {
    const d = G.derived;
    const seq = d.bounceSeq;
    if (!seq || !seq.length) return;
    const seen = { [from.uid]: 1 };
    let cur = from, curPos = { x: point.x, y: point.y, z: point.z };

    for (let hop = 0; hop < seq.length; hop++) {
      const next = this._nearestNew(curPos, seen, TUNE.BUILD.bounceSearch);
      /* 找不到新目标就断链。Bao 已确认：AOE 选多了空转是玩家自己的选择，
         不做「回跳到已命中目标」的兜底。 */
      if (!next) break;
      if (!this.gate(root, next)) { seen[next.uid] = 1; continue; }
      if (!this.allowDamage(root)) break;
      seen[next.uid] = 1;

      const m = BUILD.victimMul(next, false);
      const dmg = hitDmg * seq[hop] * m;
      const hp0 = next.hp;
      const got = damageEnemy(next, dmg, null, { point: next.pos, bounce: true });
      BUILD.stats.bounce += got;
      G.stats.hits++;
      if (next.dead && hp0 > 0) BUILD.onKill(next, this._closeTo(next));

      /* 弹射命中一样触发爆炸 —— 它继承的是统一规律，不是专属分支 */
      if (d.blastOn) this.blast(root, next.pos, hitDmg * seq[hop], next);

      this._bounceFx(curPos, next.pos);
      curPos = { x: next.pos.x, y: next.pos.y + 0.9, z: next.pos.z };
      cur = next;
    }
  },

  _nearestNew(pos, seen, range) {
    const list = enemiesInRadius(pos.x, pos.z, range, _bounceBuf);
    let best = null, bd = range * range;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.dead || seen[e.uid]) continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  },

  _closeTo(e) {
    const p = G.player;
    return Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) <= TUNE.MUP.lifesteal.range;
  },

  /* ------------------------------------------------------------------ 表现 */
  /* 触顶时优先合并同帧视觉与音效（§8.3 的处理顺序第一条）。 */
  _blastFx(pos, r) {
    if (!this.allowFx()) return;
    R.puff(pos, r * 0.35, 1.0, 0xff9a3c, 0.22);
    R.spark(pos, null, 0xffc14d);
    if (this.fx.blastSounds < TUNE.BUILD.soundPerBlastWindow) {
      this.fx.blastSounds++;
      Audio2.blast(pos, false);
    }
  },
  _bounceFx(a, b) {
    if (!this.allowFx()) return;
    if (R.addBeam) R.addBeam(a, b, 0xc58aff);
    else R.spark(b, null, 0xc58aff);
  },

  debugLine() {
    const B = this.budget;
    return '事件 ' + B.events + '  拒绝 ' + B.rejected + '  特效/帧 ' + B.fxFrame;
  }
};

const _blastBuf = [];
const _bounceBuf = [];
