/* ============================================================================
   SYMBIOTIC FIRE · 战斗与触发链
   共同变异全部注册在事件总线上（§33），触发白名单与递归保护见 §34。
   ========================================================================== */
'use strict';

/* 全局状态 —— game.js 负责填充与推进 */
const G = {
  time: 0, phase: 'menu',            // menu | play | choose | over
  paused: false, over: false, won: false,
  bus: new Bus(),
  hash: new SpatialHash(4),
  player: null,
  mods: {},                          // id -> level
  mutations: [],                     // 已选共同变异（有序）
  mutationSet: {},
  variantPool: [],                   // 已进入生成池的变种
  enemies: null, bullets: null, acids: null,
  xp: [], hazards: [], pendings: [],
  wells: [],                         // 坍缩炮的引力井（todo13）
  magnet: null, magPending: false, magNextAt: undefined,   // 磁铁掉落
  stats: { kills: 0, shots: 0, hits: 0, procs: 0, dmgDealt: 0, dmgTaken: 0, blasts: 0, bolts: 0 },
  derived: null,
  conductCounter: 0,
  xpRate: 0, xpFrame: 0, pacingMult: 1,
  /* todo.md：医疗 / 空投 / 强化 */
  medNeed: 0, medCooldown: 0, medPending: false, medical: null,
  supplyCharge: 0, lastDropAt: -999, dropQueued: false, airdrop: null,
  buff: null,                        // {id, t, dur, shield}
  hurtCount: 0,                      // 受伤次数，用来观测近战前摇改动的影响
  spitCount: 0,                      // 当前抬手中的远程怪数（todo12 §3）
  pierceRamp: 0,
  overclock: 0,
  feedbackBudget: 4, feedbackTimer: 0,
  procThisFrame: 0,
  _tmp: []
};

const V3 = new THREE.Vector3();
const V3b = new THREE.Vector3();
const _wc = { x: 0, y: 0, z: 0 };
const _ext = new THREE.Vector3();

/* ============================================================================
   派生数值 —— 所有改装与变异的加成在这里一次性算完，热路径不做查表
   ========================================================================== */
function lvl(id) { return G.mods[id] || 0; }

function recompute() {
  const d = {};

  /* Build 的折算是唯一的一次查表，热路径只读 G.derived（todo10 §8.2）。
     这里只折算「读武器状态」的东西；距离、爆头、低血、站桩、专注
     全部在命中时按受害者重算 —— 它们跟着位置和时间变，折进来就是错的。 */
  BUILD.derive(d);

  /* 空投强化是临时叠加，必须在 Build 折算【之后】乘，
     否则下一次 recompute 会把它算进基线里回不去。 */
  if (G.buff) {
    const A = TUNE.AIRDROP;
    if (G.buff.id === 'ammo') {
      d.fireInterval /= (1 + A.ammoFireRate);
      d.infiniteMag = true;                  // 弹匣不减少，也不允许进入换弹
    } else if (G.buff.id === 'adren') {
      /* 暴走针（todo11 §1）：机动 + 循环。换弹那一项是它真正的价值 ——
         高耗弹 Build 有一半时间耗在换弹上，砍掉才等价于「更多输出」。 */
      d.moveSpeed *= (1 + A.adrenSpeed);
      d.dashCooldown *= (1 - A.adrenDashCd);
      d.fireInterval /= (1 + A.adrenFireRate);
      d.reloadTime *= (1 - A.adrenReload);
    } else if (G.buff.id === 'shield' && G.buff.shield > 0) {
      /* 强袭盾：护盾【还在】的时候才给伤害加成 —— 盾被打穿就没了，
         所以它奖励的是「顶着压力继续输出」，不是无脑站着。 */
      d.damage *= A.shieldDamage;
    }
  }

  /* 最大生命由「强心」在 BUILD.take 里直接改玩家，这里只跟读 ——
     以前这行是 `G.player.maxHp = d.maxHp`，会把强心加的血每帧抹掉。 */
  if (G.player) {
    d.maxHp = G.player.maxHp;
    G.player.hp = Math.min(G.player.hp, d.maxHp);
  }

  G.derived = d;
  return d;
}

/* 有效射速：超频只更新下一次开火间隔（§8.1 第 9 步），不建平行伤害系统 */
function effectiveFireInterval() { return BUILD.fireInterval(); }

function procAllowed(ctx) { return ctx.procDepth < G.derived.maxDepth; }

/* 同一根攻击对同一目标只结算一次同类效果 §34 */
function markOnce(ctx, enemy, tag) {
  if (!ctx.hitSet) ctx.hitSet = new Set();
  const k = enemy.uid + ':' + tag;
  if (ctx.hitSet.has(k)) return false;
  ctx.hitSet.add(k);
  return true;
}

/* ============================================================================
   目标查询
   ========================================================================== */
function enemiesInRadius(x, z, r, out) {
  G.hash.query(x, z, r, out);
  let w = 0;
  const r2 = r * r;
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.dead) continue;
    const dx = e.pos.x - x, dz = e.pos.z - z;
    if (dx * dx + dz * dz <= r2 + e.radius * e.radius) out[w++] = e;
  }
  out.length = w;
  return out;
}

/* 猎群算法：优先满血目标 §23 */
/* 屏幕上离准星最近的敌人。「最近」按【与视线的夹角】算，不是按距离 ——
   自动瞄准要的是「我看着谁就打谁」，不是「谁贴我近就打谁」。 */
const _aimDir = new THREE.Vector3();
function crosshairTarget(maxAngle, maxRange) {
  const cam = R.camera;
  cam.getWorldDirection(_aimDir);
  const ox = cam.position.x, oy = cam.position.y, oz = cam.position.z;
  let best = null, bestCos = Math.cos(maxAngle);
  const list = G.enemies.live;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.dead || e._dead) continue;
    const dx = e.pos.x - ox, dy = e.pos.y + e.height * 0.55 - oy, dz = e.pos.z - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len > maxRange || len < 0.01) continue;
    const c = (dx * _aimDir.x + dy * _aimDir.y + dz * _aimDir.z) / len;
    if (c > bestCos) { bestCos = c; best = e; }
  }
  return best;
}

function pickChainTarget(x, z, range, exclude) {
  const cand = enemiesInRadius(x, z, range, G._tmp);
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < cand.length; i++) {
    const e = cand[i];
    if (exclude && exclude.has(e.uid)) continue;
    const dx = e.pos.x - x, dz = e.pos.z - z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let score = -dist;
    if (G.derived.hunter) score += (e.hp / e.maxHp) * range * 0.9;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

/* ============================================================================
   伤害结算
   ========================================================================== */
/* 玩家治疗的唯一入口（todo13）。
   过量治疗要接住「超过上限的那部分」，所以治疗不能再各处自己
   `hp = min(maxHp, hp + x)` —— 那样溢出就地丢掉了，谁也接不到。 */
function healPlayer(amount) {
  const p = G.player;
  if (amount <= 0 || !p) return 0;
  const room = Math.max(0, p.maxHp - p.hp);
  const used = Math.min(room, amount);
  p.hp += used;
  const over = amount - used;
  if (over > 0 && BUILD.has('overheal')) {
    BUILD.addShield(over * TUNE.MUP.overheal.convert);
  }
  if (G.ui) G.ui.flashHeal();
  return used;
}

function damageEnemy(e, amount, ctx, opts) {
  if (e.dead || amount <= 0) return 0;
  opts = opts || {};

  /* 骨化尸的三层骨板 §19：正面命中优先击碎一层并抵消该次伤害 */
  if (e.plates > 0 && opts.fromFront && !opts.weakpoint) {
    e.plates--;
    e.plateMeshes[e.plates].visible = false;
    /* 护甲命中必须一眼一耳都能和"正常造成伤害"区分开（todo2 §9） */
    R.spark(opts.point || e.pos, null, 0xdfe6f5);
    R.puff(opts.point || e.pos, 0.1, 0.7, 0xffffff, 0.14);
    Audio2.armorHit();
    G.ui.hitMark('armor');
    if (e.hurtFlash !== undefined) e.hurtFlash = 0.1;
    return 0;
  }

  /* 处决弹头 §23 */
  if (G.derived.executeBonus && e.hp / e.maxHp < 0.30) amount *= (1 + G.derived.executeBonus);

  /* 延迟清算（todo13 G08）：伤害先记在敌人身上，不进生命。
     opts.settled 是清算自己打出来的那一发，不能再被记账，否则永远兑现不了。
     结算之前敌人不掉血、不死、也不给经验 —— 那正是这张卡的代价。 */
  if (G.derived.deferOn && !(opts && opts.settled)) {
    e.deferred = (e.deferred || 0) + amount;
    e.hurtFlash = 0.12;
    G.stats.dmgDealt += amount;
    G.bus.emit('damage', { enemy: e, amount: amount, ctx: ctx, opts: opts });
    return amount;
  }

  e.hp -= amount;
  e.hurtFlash = 0.12;
  /* 受击姿态：明显冲击时有极短的形变与后仰（todo2 §9） */
  e.hitReact = Math.min(0.16, 0.06 + amount / Math.max(1, e.maxHp) * 0.5);
  G.stats.dmgDealt += amount;

  G.bus.emit('damage', { enemy: e, amount: amount, ctx: ctx, opts: opts });
  /* §5.1 攀爬过程中可以被玩家射落 */
  if (typeof NAV !== 'undefined' && NAV.enabled) NAV.onDamaged(e);

  /* §C03 过量伤害转移：只有【打过头】的那部分才转移。
     必须在 killEnemy 之前把溢出量记下来 —— 之后 e.hp 会被 killEnemy 归零。

     opts.blast 是尸爆/坍缩这类【派生范围伤害】打出来的。它不产生溢出：
     溢出转移的是「你这一枪打过头的那部分」，而尸爆的伤害不是你打出来的，
     它没有"打过头"可言。放开这一条的话，尸爆会不断往溢出链里注入
     全新的伤害，溢出「每跳衰减」的收敛论证就当场作废 ——
     实测尸爆 Lv4 + 溢出 Lv4 一枪连杀 88 只，而且和输入伤害无关
     （打 400 和打 1600 都是 88），那正是自持反应的样子。 */
  const over = e.hp < 0 ? -e.hp : 0;
  if (e.hp <= 0) killEnemy(e, ctx, opts);
  if (over > 0 && G.derived.overflowKeep > 0 && !(opts && opts.blast)) {
    overflowTransfer(e, over, ctx, opts);
  }
  return amount;
}

/* 溢出转移。链条本身是【线性】的：一次击杀只推向一个新目标，
   每跳乘 keep（<1），而且打不死就没有溢出可转、当场停。

   跳数与已命中集合都挂在 ctx 上，不用模块级变量：
   这条链是通过 damageEnemy 递归展开的，中途还会岔出尸爆的递归 ——
   模块级计数器在这种交叉重入下会被另一条链改写（改之前就是这样，
   每一次尸爆击杀都从 hop 0 重开一条全新的 6 跳链）。

   ctx 走 deriveAttack，所以 procDepth 每跳 +1：溢出链跑得再远，
   尸爆也只在最初的 maxDepth 代里还能被触发，不会一路跟着无限开花。 */
function overflowTransfer(from, over, ctx, opts) {
  const d = G.derived, M = TUNE.MOL_OVERFLOW;
  const hop = (ctx && ctx.ovHop) || 0;
  if (hop >= d.overflowHops) return;
  const dmg = over * d.overflowKeep;
  if (dmg < M.minDamage) return;

  /* 用普通对象而不是 Set：ATK._nearestNew 的排除是 `seen[e.uid]`。 */
  let seen = ctx && ctx.ovSeen;
  if (!seen) seen = {};
  seen[from.uid] = 1;
  const next = ATK._nearestNew(from.pos, seen, M.search);
  if (!next) return;
  seen[next.uid] = 1;

  const nctx = deriveAttack(ctx || makeAttack('overflow'), 'overflow');
  nctx.ovHop = hop + 1;
  nctx.ovSeen = seen;

  const m = BUILD.victimMul(next, false);
  const hp0 = next.hp;
  damageEnemy(next, dmg * m, nctx, { point: next.pos, overflow: true });
  BUILD.stats.overflow = (BUILD.stats.overflow || 0) + dmg * m;
  G.stats.hits++;
  if (next.dead && hp0 > 0) BUILD.onKill(next, ATK._closeTo(next));
  if (ATK.allowFx() && R.addBeam) R.addBeam(from.pos, next.pos, 0xffb84d);
}

function killEnemy(e, ctx, opts) {
  if (e.dead) return;
  e.dead = true;
  /* todo5 §9：尸群的死亡后果要能被玩家「利用或规避」，所以后果必须区分
     这一杀是不是打中弱点打出来的。retireEnemy 发 enemyDeath 时已经拿不到 opts，
     所以在死亡这一刻就把它记在敌人身上。 */
  e.killedWeak = !!(opts && opts.weakpoint);
  G.stats.kills++;

  /* 空投进度：精英与 Boss 明显加速，普通怪只有很小的贡献 */
  const A = TUNE.AIRDROP;
  G.supplyCharge += e.boss ? A.chargeBoss : ((e.tpl && e.tpl.elite) ? A.chargeElite : A.chargeKill);

  /* 医疗掉落：命中标记时，由这一只非召唤物敌人掉出 */
  if (G.medPending && !e.minion && !G.medical) {
    G.medPending = false;
    G.spawnMedical(e.pos);
  }
  /* 磁铁走同一条投放路线 */
  if (G.magPending && !e.minion && !G.magnet) {
    G.magPending = false;
    G.spawnMagnet(e.pos);
  }

  /* 创伤修复 §23 */
  if (G.derived.traumaHeal && G.stats.kills % 30 === 0) {
    const heal = G.player.maxHp * 0.02 * G.derived.traumaHeal;
    healPlayer(heal);        // healPlayer 自己会闪治疗反馈
  }

  /* 尸爆（todo13 C01）：挂在死亡上，而不是命中上。
     放在 emit('kill') 之前 —— 尸群共同进化那边也订阅 kill，
     顺序上先把这一具尸体炸掉，再让世界对这次死亡做反应。 */
  if (G.derived.corpsePct > 0) ATK.corpse(e, ctx);

  G.bus.emit('kill', { enemy: e, ctx: ctx || makeAttack('world'), opts: opts || {} });
}

/* 区域伤害 —— 玩家侧 §16/§20 共用 */
function areaDamage(center, radius, dmg, ctx, tag) {
  const list = enemiesInRadius(center.x, center.z, radius, []);
  let hits = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!markOnce(ctx, e, tag)) continue;
    damageEnemy(e, dmg, ctx, { area: true, point: e.pos });
    hits++;
  }
  return hits;
}

/* 神经回授 §23：每次有效触发返还 1 发，每秒最多 4 发 */
function onEffectiveProc() {
  G.stats.procs++;
  if (!G.derived.feedback) return;
  if (G.feedbackBudget <= 0) return;
  const gun = G.player.gun;
  if (gun.ammo < G.derived.magazine) { gun.ammo++; G.feedbackBudget--; G.ui.flashAmmo(); }
}

/* ============================================================================
   尸潮侧共同变异 §16–21 —— 后果只打玩家，绝不刷经验（§34 禁止项）
   ========================================================================== */
function installHordeMutations() {

  G.bus.on('enemyDeath', ev => {
    const e = ev.enemy;
    if (!e.variant) return;

    if (e.variant === 'blast') {
      const cfg = MUT.blast.enemy;
      /* todo5 §9：爆裂尸必须是【双向决策】而不是单纯的惩罚 ——
         弱点击破 → 当场炸向尸群，是玩家可以主动利用的清场手段；
         普通击杀 → 仍然是延迟引信，只伤害玩家，需要规避。 */
      if (e.killedWeak) {
        const r = cfg.radius * 1.15;
        const ctx = makeAttack('hordeBlast', { canTriggerOnKill: false, splitUsed: true });
        areaDamage(e.pos, r, cfg.dmg * 1.6 * G.dmgScale(), ctx, 'hordeBlast');
        R.ring(e.pos, 0.3, r, MUT.blast.color, 0.42);
        R.puff(V3.copy(e.pos).setY(e.pos.y + 0.9), 0.35, r * 0.8, 0xffd08a, 0.3);
        Audio2.blast(e.pos, true);
        G.shake(0.12, e.pos);
        G.stats.hordeBlasts = (G.stats.hordeBlasts || 0) + 1;
        return;
      }
      /* §16 死亡后闪烁再爆炸，玩家有充分时间离开 */
      G.pendings.push({
        t: cfg.fuse, kind: 'enemyBlast',
        pos: e.pos.clone(), radius: cfg.radius, dmg: cfg.dmg * G.dmgScale()
      });
      const z = R.zones.get();
      z.mesh.position.set(e.pos.x, 0.05, e.pos.z);
      z.mesh.scale.setScalar(cfg.radius);
      z.mesh.material.color.setHex(MUT.blast.color);
      z.mesh.material.opacity = 0.18; z.mesh.visible = true;
      z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(cfg.radius);
      z.rim.material.color.setHex(MUT.blast.color); z.rim.material.opacity = 0.8; z.rim.visible = true;
      G.hazards.push({ zone: z, t: 0, dur: cfg.fuse, kind: 'fuse', blink: true });
      Audio2.telegraph(e.pos, 'blast');

    } else if (e.variant === 'fission') {
      const cfg = MUT.fission.enemy;
      /* todo5 §9：弱点击杀破坏裂变核 —— 幼体不再生成。
         这给了玩家一个明确的「打哪里」的决策，而不是无差别地怕它死。 */
      if (e.killedWeak) {
        R.puff(e.pos, 0.25, 1.4, 0xfff0b0, 0.28);
        R.spark(e.pos, null, MUT.fission.color);
        Audio2.weakConfirm(true);
        G.stats.coresBroken = (G.stats.coresBroken || 0) + 1;
        return;
      }
      for (let i = 0; i < cfg.count; i++) {
        const a = (i / cfg.count) * Math.PI * 2 + RNG.spawn.range(0, 6.28);
        G.spawnMinion(e, Math.cos(a) * 1.1, Math.sin(a) * 1.1, cfg.hpRatio);
      }
      R.puff(e.pos, 0.3, 1.8, MUT.fission.color, 0.3);

    } else if (e.variant === 'conduct') {
      const cfg = MUT.conduct.enemy;
      G.pendings.push({
        t: cfg.telegraph, kind: 'enemyField',
        pos: e.pos.clone(), radius: cfg.radius, dmg: cfg.dmg * G.dmgScale(),
        duration: cfg.duration, tick: cfg.tick
      });
      const z = R.zones.get();
      z.mesh.position.set(e.pos.x, 0.05, e.pos.z);
      z.mesh.scale.setScalar(cfg.radius);
      z.mesh.material.color.setHex(MUT.conduct.color);
      z.mesh.material.opacity = 0.14; z.mesh.visible = true;
      z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(cfg.radius);
      z.rim.material.color.setHex(MUT.conduct.color); z.rim.material.opacity = 0.75; z.rim.visible = true;
      G.hazards.push({ zone: z, t: 0, dur: cfg.telegraph, kind: 'fuse', blink: true });
      Audio2.telegraph(e.pos, 'field');
    }
  });
}

/* 延迟事件推进（尸爆引信、电场铺设） */
function updatePendings(dt) {
  for (let i = G.pendings.length - 1; i >= 0; i--) {
    const p = G.pendings[i];
    p.t -= dt;
    if (p.t > 0) continue;
    G.pendings.splice(i, 1);

    if (p.kind === 'enemyBlast') {
      /* §16 尸爆不伤害其他丧尸 —— 只查玩家 */
      const d = Math.hypot(G.player.pos.x - p.pos.x, G.player.pos.z - p.pos.z);
      if (d <= p.radius) hurtPlayer(p.dmg, p.pos, 'blast');
      R.ring(p.pos, 0.3, p.radius, MUT.blast.color, 0.4);
      R.puff(V3.copy(p.pos).setY(1.0), 0.4, p.radius * 0.8, 0xff9a4a, 0.3);
      Audio2.blast(p.pos, false);
      G.shake(0.16, p.pos);

    } else if (p.kind === 'enemyField') {
      const z = R.zones.get();
      z.mesh.position.set(p.pos.x, 0.05, p.pos.z);
      z.mesh.scale.setScalar(p.radius);
      z.mesh.material.color.setHex(MUT.conduct.color);
      z.mesh.material.opacity = 0.34; z.mesh.visible = true;
      z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(p.radius);
      z.rim.material.color.setHex(MUT.conduct.color); z.rim.material.opacity = 0.95; z.rim.visible = true;
      G.hazards.push({
        zone: z, t: 0, dur: p.duration, kind: 'field',
        radius: p.radius, dmg: p.dmg, tick: p.tick, tickT: 0, arc: 0
      });
      Audio2.zap(p.pos);
    }
  }
}

/* 地面危险区在立体地图下必须同层才结算 ——
   屋顶的酸池不该穿过楼板伤到街面的玩家（todo3 §5 / §8.2）。 */
function hazardSameFloor(h) {
  if (typeof CITY === 'undefined' || !CITY.enabled) return true;
  return Math.abs(G.player.pos.y - h.zone.mesh.position.y) < 2.6;
}

function updateHazards(dt) {
  for (let i = G.hazards.length - 1; i >= 0; i--) {
    const h = G.hazards[i];
    h.t += dt;
    if (h.t >= h.dur) {
      R.zones.release(h.zone);
      G.hazards.splice(i, 1);
      continue;
    }
    if (h.blink) {
      /* 引信期闪烁：越接近爆炸越快 */
      const k = h.t / h.dur;
      const f = Math.sin(h.t * (8 + k * 30)) * 0.5 + 0.5;
      h.zone.rim.material.opacity = 0.35 + f * 0.6;
      h.zone.mesh.material.opacity = 0.10 + f * 0.16;
    }
    if (h.kind === 'field') {
      h.tickT -= dt;
      const d = Math.hypot(G.player.pos.x - h.zone.mesh.position.x, G.player.pos.z - h.zone.mesh.position.z);
      if (d <= h.radius && hazardSameFloor(h) && h.tickT <= 0) {
        hurtPlayer(h.dmg, h.zone.mesh.position, 'shock');
        h.tickT = h.tick;
      }
      h.arc += dt;
      const f = Math.sin(h.arc * 14) * 0.5 + 0.5;
      h.zone.mesh.material.opacity = 0.24 + f * 0.16;
      h.zone.rim.material.opacity = 0.7 + f * 0.3;
      /* 尾声淡出，避免"看起来还在但已经没伤害" */
      const rem = h.dur - h.t;
      if (rem < 0.5) { h.zone.mesh.material.opacity *= rem / 0.5; h.zone.rim.material.opacity *= rem / 0.5; }
    }
    if (h.kind === 'acid') {
      h.tickT -= dt;
      const d = Math.hypot(G.player.pos.x - h.zone.mesh.position.x, G.player.pos.z - h.zone.mesh.position.z);
      if (d <= h.radius && hazardSameFloor(h) && h.tickT <= 0) { hurtPlayer(h.dmg, h.zone.mesh.position, 'acid'); h.tickT = h.tick; }
      const rem = h.dur - h.t;
      if (rem < 0.5) { h.zone.mesh.material.opacity *= rem / 0.5; h.zone.rim.material.opacity *= rem / 0.5; }
    }
  }
}

/* ============================================================================
   子弹
   ========================================================================== */
let _bulletUid = 0;
function makeBulletPool() {
  return new Pool(() => ({
    uid: ++_bulletUid,
    pos: new THREE.Vector3(), prev: new THREE.Vector3(), dir: new THREE.Vector3(),
    speed: 0, dmg: 0, life: 0, pierce: 0, hitList: null, ctx: null, col: 0, scale: 1,
    /* todo5 §6.2：谱系节点挂在子弹上，池化复位时必须清干净 */
    gene: null, baseDmg: 0, pierceHits: 0, bounceHits: 0,
    pendingBlast: false, homeE: null, wallLeft: 0, core: null, volleyIndex: 0
  }), b => {
    b.ctx = null; b.hitList = null; b.gene = null;
    b.pierceHits = 0; b.bounceHits = 0; b.pendingBlast = false;
    b.homeE = null; b.wallLeft = 0; b.core = null; b.volleyIndex = 0; b.baseDmg = 0;
  });
}

function spawnBullet(origin, dir, dmg, ctx, opts) {
  opts = opts || {};
  const cap = TUNE.BUILD.projectileCap;
  if (G.bullets.count >= cap) return null;
  const b = G.bullets.get();
  b.pos.copy(origin); b.prev.copy(origin);
  b.dir.copy(dir).normalize();
  b.speed = TUNE.GUN.muzzleVel;
  b.dmg = dmg;
  b.life = TUNE.GUN.bulletLife;
  b.pierce = opts.pierce !== undefined ? opts.pierce : G.derived.pierce;
  b.hitList = new Set();
  b.ctx = ctx;
  b.scale = (opts.scale || 1) * G.derived.bulletScale;
  /* 光带颜色跟着分子走（§11 要求枪线能一眼分辨）。在生成时定死，
     不在渲染里每帧查 —— 穿透衰减后颜色也不该跳。 */
  b.col = G.derived.heavyOn ? 0xff6a4a : G.derived.pellets > 1 ? 0x7fd4ff : 0xffd9a0;
  b.pierceHits = 0; b.bounceHits = 0;
  b.gene = opts.gene || null;
  b.baseDmg = opts.gene ? dmg : 0;
  b.pendingBlast = false; b.homeE = null;
  b.wallLeft = G.derived.wallBounce || 0;
  b.core = null;
  return b;
}

/* 线段 vs 球 —— 弱点判定专用。
   绝不能再从身体圆柱的命中点反推头部：圆柱交点恒在圆柱表面上，
   水平距离恒等于 radius+0.09，永远大于任何"靠近中心"的阈值，
   结果就是 weak 永远为 false（这个 bug 让 weakpointMult 和瞄准模块彻底失效）。 */
function segSphere(p0, p1, cx, cy, cz, r) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const fx = p0.x - cx, fy = p0.y - cy, fz = p0.z - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > 1) return -1;
  return t;
}

/* 头部球的世界位置：跟随 pos / face / height */
function weakCenter(e, out) {
  const w = e.weak;
  out.x = e.pos.x + e.face.x * w.fwd * e.height;
  out.y = e.pos.y + w.y * e.height;
  out.z = e.pos.z + e.face.z * w.fwd * e.height;
  return out;
}

/* 线段 vs 竖直圆柱 —— 高速子弹必须做扫掠检测，否则会穿怪 */
function segCylinder(p0, p1, cx, cz, r, y0, y1) {
  const dx = p1.x - p0.x, dz = p1.z - p0.z;
  const fx = p0.x - cx, fz = p0.z - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-8) {
    if (fx * fx + fz * fz > r * r) return -1;
    const yl = Math.min(p0.y, p1.y), yh = Math.max(p0.y, p1.y);
    if (yh < y0 || yl > y1) return -1;
    return 0;
  }
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = (-b - sq) / (2 * a);
  if (t < 0) t = (-b + sq) / (2 * a);
  if (t < 0 || t > 1) return -1;
  const y = p0.y + (p1.y - p0.y) * t;
  if (y < y0 || y > y1) return -1;
  return t;
}

/* 命中反馈的颜色来源：谁造成的，就用谁的颜色（TODO.md M6）。
   根弹按当前最显著的根弹属性走，派生弹按它的 sourceModule 走。 */
/* 命中火花按【是什么打出来的】着色，玩家不看结算页也能读出因果。
   V3 只有三种主弹形态可分：穿透过的、重弹、普通。
   弹射与爆炸有自己的表现，不走这里。 */
function moduleHitColor(b) {
  const d = G.derived;
  if (b.pierceHits > 0) return 0x8affc1;
  if (d.heavyOn) return 0xff6a4a;
  if (d.pellets > 1) return 0x7fd4ff;
  return 0xffd08a;
}

/* 子弹退场的唯一出口：谱系里还欠一次终点结算的，在这里补上（todo5 §4.3） */
function retireBullet(b) {
  
  G.bullets.release(b);
}

const _hitCand = [];
const _wallHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
function updateBullets(dt) {
  const list = G.bullets.live;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b._dead) continue;
    b.life -= dt;
    /* todo5 §4.3：贯穿弹的「终点爆破」必须在子弹自然消失的那一刻兑现，
       否则打空的那一发就静静消失，玩家永远看不到终点这个概念。 */
    if (b.life <= 0) {
      if (b.core) spawnWell(b.pos, b.core);      // 飞到寿终也要落地开井
      retireBullet(b); continue;
    }

    b.prev.copy(b.pos);
    /* 自动瞄准（todo12 §2）：目标在开火那一刻就锁死，不中途改嫁 ——
       否则一枪打出去会追着「此刻最近的那只」乱拐，玩家完全读不懂弹道。
       目标死了就直着飞完，不再找下一个。 */
    if (b.homeE) {
      const t = b.homeE;
      if (t.dead || t._dead) b.homeE = null;
      else {
        V3b.set(t.pos.x - b.pos.x, t.pos.y + t.height * 0.55 - b.pos.y, t.pos.z - b.pos.z).normalize();
        b.dir.lerp(V3b, Math.min(1, TUNE.DEMON.autoaim.turn * dt)).normalize();
      }
    }
    b.pos.addScaledVector(b.dir, b.speed * dt);

    /* 出界：地图边缘不反弹，到边就没了 */
    if (Math.abs(b.pos.x) > R.arenaHalf || Math.abs(b.pos.z) > R.arenaHalf) {
      if (b.core) spawnWell(b.pos, b.core);
      R.spark(b.pos, null, 0x9fb4c8);
      retireBullet(b); continue;
    }
    /* 打地板。楼板与屋顶本身是 AABB，走下面 segBlocked 那条；
       但【世界地面】是一张平面，不在 CITY.solids 里，所以要单独接一下 ——
       否则「墙面反弹」在最常见的一种表面上反而不生效（Bao 指出）。 */
    if (b.pos.y < 0.02) {
      if (b.wallLeft > 0) {
        b.wallLeft--;
        /* 求线段与 y=0.02 平面的交点，从那里反弹，法线是 +Y */
        const dy = b.pos.y - b.prev.y;
        const k = Math.abs(dy) > 1e-6 ? (0.02 - b.prev.y) / dy : 0;
        _wallHit.x = lerp(b.prev.x, b.pos.x, k);
        _wallHit.y = 0.02;
        _wallHit.z = lerp(b.prev.z, b.pos.z, k);
        b.dir.y = -b.dir.y;
        b.dir.normalize();
        const nu = TUNE.MOL_WALL.nudge;
        b.pos.set(_wallHit.x + b.dir.x * nu, _wallHit.y + b.dir.y * nu, _wallHit.z + b.dir.z * nu);
        b.prev.copy(b.pos);
        b.hopDmg = (b.hopDmg || b.dmg) * G.derived.wallGain;
        b.dmg = b.hopDmg;
        b.hitList.clear();
        R.spark(_wallHit, b.dir, 0x9fd8ff);
        continue;
      }
      if (b.core) spawnWell(b.pos, b.core);
      R.spark(b.pos, null, 0x9fb4c8);
      retireBullet(b); continue;
    }
    /* 子弹撞城市几何。
       之前这里查的是旧平面竞技场的 R.obstacles 圆柱表 —— 城市地图下那张表恒为空，
       于是子弹会直接穿过整栋楼。城市地图里「墙能挡枪线」是战术的前提：
       没有它，掩体、街道峡谷和纵深选择全部不成立。 */
    if (CITY.segBlocked(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z)) {
      /* 墙面反弹（todo13 A05）：还有反弹次数就弹，没有就到此为止。
         穿透和反弹抢同一颗子弹 —— 哪个先用完，子弹就在那里消失（Bao 定）。 */
      if (b.wallLeft > 0 && CITY.segHit(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z, _wallHit)) {
        b.wallLeft--;
        const dot = b.dir.x * _wallHit.nx + b.dir.y * _wallHit.ny + b.dir.z * _wallHit.nz;
        b.dir.x -= 2 * dot * _wallHit.nx;
        b.dir.y -= 2 * dot * _wallHit.ny;
        b.dir.z -= 2 * dot * _wallHit.nz;
        b.dir.normalize();
        /* 从命中点沿新方向推开一点：不推的话下一帧的线段起点仍在墙里，
           会立刻再判一次撞墙，一颗子弹在一个角上把次数全耗掉。 */
        const nu = TUNE.MOL_WALL.nudge;
        b.pos.set(_wallHit.x + b.dir.x * nu, _wallHit.y + b.dir.y * nu, _wallHit.z + b.dir.z * nu);
        b.prev.copy(b.pos);
        /* 反弹之后伤害提高 —— 这是这张卡的收益，不是衰减 */
        b.hopDmg = (b.hopDmg || b.dmg) * G.derived.wallGain;
        b.dmg = b.hopDmg;
        b.hitList.clear();          // 弹回来可以再打同一只（重复命中仍受 root 的 gate 约束）
        R.spark(_wallHit, b.dir, 0x9fd8ff);
        continue;
      }
      if (b.core) spawnWell(b.pos, b.core);       // 引力核心撞墙就在墙根开井
      R.spark(b.pos, null, 0x9fb4c8);
      retireBullet(b); continue;
    }

    /* 扫掠命中 */
    const midX = (b.pos.x + b.prev.x) * 0.5, midZ = (b.pos.z + b.prev.z) * 0.5;
    const span = b.prev.distanceTo(b.pos) * 0.5 + 1.6;
    G.hash.query(midX, midZ, span, _hitCand);

    let bestT = 2, bestE = null, bestWeak = false, bestHitT = 0;
    for (let k = 0; k < _hitCand.length; k++) {
      const e = _hitCand[k];
      if (e.dead || b.hitList.has(e.uid)) continue;

      /* 头部球与身体圆柱分别检测。粗略碰撞体只是代理 ——
         准星穿过可见头部球时优先按弱点处理，即使身体交点更早。 */
      let headT = -1;
      if (e.weak) {
        weakCenter(e, _wc);
        headT = segSphere(b.prev, b.pos, _wc.x, _wc.y, _wc.z, e.weak.r * e.height + 0.06 * b.scale);
      }
      const bodyT = segCylinder(b.prev, b.pos, e.pos.x, e.pos.z,
        e.radius + 0.09 * b.scale, e.pos.y, e.pos.y + e.height);
      if (headT < 0 && bodyT < 0) continue;

      /* 已确定命中这只敌人。但子步扫掠会把大体型敌人切开：
         肉山身体半径 1.79、头球 0.98，两个入射点相差 0.8m，
         可能落在不同子步里 —— 身体先中并锁上 hitList，头部就永远判不到。
         所以再用一段覆盖整只敌人的射线复判一次头部。 */
      let weakNow = headT >= 0;
      let hitAt = weakNow ? headT : bodyT;
      if (!weakNow && e.weak) {
        const far = Math.hypot(_wc.x - b.prev.x, _wc.y - b.prev.y, _wc.z - b.prev.z)
          + e.weak.r * e.height + 0.25;
        _ext.copy(b.dir).multiplyScalar(far).add(b.prev);
        const ht = segSphere(b.prev, _ext, _wc.x, _wc.y, _wc.z, e.weak.r * e.height + 0.06 * b.scale);
        if (ht >= 0) {
          weakNow = true;
          /* 换算回当前子步的参数空间，供命中点插值使用 */
          const segLen = b.prev.distanceTo(b.pos) || 1e-6;
          hitAt = clamp(ht * far / segLen, 0, 1);
        }
      }

      const order = Math.min(headT >= 0 ? headT : 2, bodyT >= 0 ? bodyT : 2);
      if (order < bestT) { bestT = order; bestE = e; bestWeak = weakNow; bestHitT = hitAt; }
    }

    if (bestE) {
      const point = V3.copy(b.prev).lerp(b.pos, bestHitT).clone();
      resolveBulletHit(b, bestE, point, bestWeak);
    }
  }
  G.bullets.compact();
}

function resolveBulletHit(b, e, point, weak) {
  /* 引力核心不做直击：它的全部作用是「落点开一口引力井」（todo13 坍缩炮） */
  if (b.core) { spawnWell(point, b.core); G.bullets.release(b); return; }
  b.hitList.add(e.uid);
  /* 自动瞄准的代价：所有命中一律按身体结算（todo12 §2）。
     在这里一刀切掉，而不是在瞄准那边做手脚 —— 爆炸、弹射继承的
     也是这一次的爆头判定，所以只有这一个入口需要改。 */
  if (G.derived.noWeak) weak = false;

  /* todo5 §6.3：同一目标在单根攻击里的重复命中上限。
     不通过就当没打中 —— 子弹继续飞，但不再对这只敌人结算第 N+1 次。 */
  if (b.root && !ATK.gate(b.root, e)) {
    R.spark(point, b.dir, 0x8fa4b8);
    return;
  }

  /* 骨板判定 §19：正面命中才吃骨板；背后与头部绕过 */
  const toHit = V3b.set(point.x - e.pos.x, 0, point.z - e.pos.z).normalize();
  const facing = V3.set(e.face.x, 0, e.face.z).normalize();
  const fromFront = toHit.dot(facing) > MUT.ossify.enemy.frontDot;

  /* §8.2：读武器状态的倍率已经在 d.damage 里；读位置与目标的在这里按
     这一个受害者重算 —— 距离、爆头、低血、站桩、专注。
     爆炸与弹射继承的是【这一次攻击】的爆头判定，但距离各自重算。 */
  let dmg = b.dmg * BUILD.victimMul(e, weak);
  if (weak) dmg *= G.derived.weakpointMult;
  const hpBefore = e.hp;
  const dealt = damageEnemy(e, dmg, b.ctx, { point: point, weakpoint: weak, fromFront: fromFront, bullet: b });
  const killed = e.dead && hpBefore > 0;

  G.stats.hits++;
  /* §8.3：命中反馈也要走同一份视觉配额。
     多发 8 颗 × 穿透 3 次 = 单枪 24 次直击，每一次都建一个伤害数字 DOM、
     一次火花、一次音效 —— 伤害那边只是几次乘法（实测 0.15ms/帧），
     真正压垮帧率的是这些没有上限的表现。触顶时只合并表现，伤害照常结算。 */
  /* 统计与表现分开：触顶只砍表现，统计永远算满 */
  if (weak && dealt > 0) {
    G.stats.weakHits = (G.stats.weakHits || 0) + 1;
    if (killed) G.stats.weakKills = (G.stats.weakKills || 0) + 1;
  }
  const showFx = ATK.allowFx();
  if (!showFx) {
    /* 至少让击杀仍然有确认 —— 玩家可以看不见每一颗弹丸，但不能不知道死了 */
    if (killed) G.ui.hitMark('kill');
  } else if (weak && dealt > 0) {
    /* 弱点世界反馈：金白粒子爆发，而不是只换个浅黄色 */
    R.spark(point, b.dir, 0xfff4c0);
    R.spark(point, b.dir, 0xffd24a);
    R.puff(point, 0.12, 1.05, 0xfff0b0, 0.2);
    Audio2.weakConfirm(killed);
    G.ui.hitMark(killed ? 'weakkill' : 'weak');
    G.ui.dmgNumber(point, Math.round(dealt), killed);
  } else {
    /* M6 构筑因果：命中火花按【造成它的模块】着色，
       玩家不看结算页也能读出「这一下是分裂/弹射/重型打的」。 */
    R.spark(point, b.dir, moduleHitColor(b));
    Audio2.hit(point, false);
    if (dealt > 0) G.ui.hitMark(killed ? 'kill' : 'normal');
    if (DebugPanel.showDmg && dealt > 0) G.ui.dmgNumber(point, Math.round(dealt), false, true);
  }

  /* 击退 + 余震 §23 */
  if (dealt > 0) {
    const kb = G.derived.knockback * (1 - (e.knockResist || 0));
    e.knock.x += b.dir.x * kb; e.knock.z += b.dir.z * kb;
    e.knockCtx = b.ctx;
  }

  /* 命中事件 —— 分裂与电导挂在这里。
     打在骨板上也算一次命中（伤害被抵消，但确实命中了），所以无条件发出。 */
  G.bus.emit('hit', { enemy: e, ctx: b.ctx, point: point, dir: b.dir, weak: weak, dealt: dealt });

  /* §8.1 的攻击顺序全部在 ATK.onHit 里：直接伤害 → 爆炸 → 弹射链 → 穿透继续。
     是一个函数里的顺序语句，而不是若干个各自订阅、顺序靠优先级碰运气的回调。 */
  if (killed) BUILD.onKill(e, ATK._closeTo(e));
  if (b.root) {
    if (!ATK.onHit(b, e, point, weak, dealt)) G.bullets.release(b);
    return;
  }

  /* 没有根攻击的子弹（敌方投射物等）不走玩家的攻击流程 */
  G.bullets.release(b);
}

/* ============================================================================
   玩家受伤 §31：必须显示方向和伤害类型颜色
   ========================================================================== */
const DMG_COLOR = { melee: '#ff4d5e', blast: MUT.blast.css, shock: MUT.conduct.css, acid: '#a8c24a', charge: '#ff8a6a', slam: '#ff7a3c' };

function hurtPlayer(amount, fromPos, kind) {
  const p = G.player;
  if (G.over || p.hp <= 0) return;
  if (p.iframe > 0 || p.dashIFrame > 0) return;

  p.iframe = TUNE.PLAYER.hurtIFrame;
  /* 玻璃大炮：在【护盾之前】放大，所以护盾同样按 ×3 被扣掉（Bao 指定）。
     放在护盾之后就变成「盾能挡三倍伤害」，那这张卡就没有代价了。 */
  amount *= G.derived.hurtMult || 1;
  G.stats.dmgTaken += amount;
  G.hurtCount++;

  /* 相位护盾先吃伤害，再进入生命结算。反馈必须是蓝色，不能误用红色 hurtflash */
  if (G.buff && G.buff.id === 'shield' && G.buff.shield > 0) {
    const absorbed = Math.min(G.buff.shield, amount);
    G.buff.shield -= absorbed;
    amount -= absorbed;
    G.ui.shieldHit(G.buff.shield <= 0);
    Audio2.shieldHit(G.buff.shield <= 0);
    if (G.buff.shield <= 0) G.buff.t = 0;       // 吸满即结束
    if (amount <= 0.001) return;                // 完全挡下，不进入受伤流程
  }

  /* 再生盾 / 跑墙护盾：在生命之前吃伤害。受伤后重新计时（BUILD.onHurt）。 */
  const bc = BUILD.ctx;
  if (bc.shield > 0) {
    const eat = Math.min(bc.shield, amount);
    bc.shield -= eat; amount -= eat;
    G.ui.shieldHit(bc.shield <= 0);
    if (amount <= 0.001) { BUILD.onHurt(); return; }
  }
  BUILD.onHurt();

  p.hp -= amount;
  Audio2.hurt(kind);
  G.shake(0.16, null);

  /* 方向指示：把伤害来源投到屏幕平面 */
  let ang = 0;
  if (fromPos) ang = screenBearing(fromPos.x - p.pos.x, fromPos.z - p.pos.z, p.yaw);
  G.ui.damageFrom(ang, DMG_COLOR[kind] || '#ff4d5e');

  if (p.hp <= 0) {
    /* 恶魔复生：这一刻站起来，而不是读档。失败了才真的结束。 */
    if (BUILD.tryRevive()) {
      G.ui.toast('恶魔复生 —— 上限减半，伤害翻倍', TUNE.DEMON.css, true);
      G.shake(0.5, null);
      Audio2.mutation();
      return;
    }
    p.hp = 0; G.lose();
  }
}
