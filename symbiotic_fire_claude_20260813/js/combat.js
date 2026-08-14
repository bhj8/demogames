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
  stats: { kills: 0, shots: 0, hits: 0, procs: 0, dmgDealt: 0, dmgTaken: 0, blasts: 0, bolts: 0, splits: 0 },
  derived: null,
  conductCounter: 0,
  xpRate: 0, xpFrame: 0, pacingMult: 1,
  /* todo.md：医疗 / 空投 / 强化 */
  medNeed: 0, medCooldown: 0, medPending: false, medical: null,
  supplyCharge: 0, lastDropAt: -999, dropQueued: false, airdrop: null,
  buff: null,                        // {id, t, dur, shield}
  hurtCount: 0,                      // 受伤次数，用来观测近战前摇改动的影响
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
  const g = TUNE.GUN;
  const d = {};

  /* 基础火力。枪本身不再有「伤害 +X%」「射速 +X%」这类改装 ——
     那些原子按 todo5 §1/§8 禁止单独作为卡牌，只能作为模块内部的构成。 */
  d.damage = g.damage;
  d.fireInterval = g.fireInterval;
  d.magazine = Math.round(g.magazine * (1 + 0.40 * lvl('mag')));
  d.reloadTime = g.reloadTime * Math.pow(0.75, lvl('reload'));
  d.spreadBase = g.spreadBase;
  d.spreadBloom = g.spreadBloom;
  d.recoil = g.recoil;
  d.weakpointMult = g.weakpointMult + 0.5 * lvl('optic');
  d.pellets = g.pellets;
  d.executeBonus = 0;
  d.knockback = g.knockback;
  d.weaponHeavy = 1;
  d.bulletScale = 1;
  d.pierce = g.pierce;

  /* 派生效果的搜索与返还 */
  d.mutDamage = 1;
  d.mutRadius = 1;
  d.hunter = lvl('hunter') > 0;
  d.searchMult = d.hunter ? 1.25 : 1;
  d.aftershock = lvl('aftershock') > 0;
  d.feedback = lvl('feedback') > 0;
  d.maxDepth = TUNE.PROC.maxDepth;

  /* 生存与节奏 */
  d.moveSpeed = TUNE.PLAYER.moveSpeed * (1 + 0.12 * lvl('stim'));
  d.dashCooldown = TUNE.PLAYER.dashCooldown * Math.pow(0.80, lvl('dashcd'));

  /* 空投强化（临时，结束后 recompute 会完整还原） */
  d.infiniteMag = false;
  if (G.buff) {
    const A = TUNE.AIRDROP;
    if (G.buff.id === 'ammo') {
      d.fireInterval /= (1 + A.ammoFireRate);
      d.infiniteMag = true;                  // 弹匣不减少，也不允许进入换弹
    } else if (G.buff.id === 'adren') {
      d.moveSpeed *= (1 + A.adrenSpeed);
      d.dashCooldown *= (1 - A.adrenDashCd);
    }
  }
  d.traumaHeal = lvl('trauma');
  d.magnetRadius = TUNE.XP.magnetRadius * (1 + 0.50 * lvl('magnet'));

  const oldMax = G.player ? G.player.maxHp : TUNE.PLAYER.maxHp;
  d.maxHp = TUNE.PLAYER.maxHp * (1 + 0.20 * lvl('armor'));
  if (G.player && d.maxHp > oldMax) G.player.hp += (d.maxHp - oldMax);  // §23 等额治疗
  if (G.player) { G.player.maxHp = d.maxHp; G.player.hp = Math.min(G.player.hp, d.maxHp); }

  /* 可组合模块的折算是唯一的一次查表，热路径只读 G.derived。 */
  WMOD.applyDerived(d);

  G.derived = d;
  return d;
}

/* 有效射速：超频只改发射节奏（todo5 §6.1 第 7 条），不建平行伤害系统 */
function effectiveFireInterval() {
  const d = G.derived;
  if (!WMOD.has('overclock')) return d.fireInterval;
  return d.fireInterval / (1 + (d.ocRampMax || 0) * WMOD.oc.ramp);
}

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

  e.hp -= amount;
  e.hurtFlash = 0.12;
  /* 受击姿态：明显冲击时有极短的形变与后仰（todo2 §9） */
  e.hitReact = Math.min(0.16, 0.06 + amount / Math.max(1, e.maxHp) * 0.5);
  G.stats.dmgDealt += amount;

  G.bus.emit('damage', { enemy: e, amount: amount, ctx: ctx, opts: opts });
  /* §5.1 攀爬过程中可以被玩家射落 */
  if (typeof NAV !== 'undefined' && NAV.enabled) NAV.onDamaged(e);

  if (e.hp <= 0) killEnemy(e, ctx, opts);
  return amount;
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

  /* 创伤修复 §23 */
  if (G.derived.traumaHeal && G.stats.kills % 30 === 0) {
    const heal = G.player.maxHp * 0.02 * G.derived.traumaHeal;
    G.player.hp = Math.min(G.player.maxHp, G.player.hp + heal);
    G.ui.flashHeal();
  }

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
    speed: 0, dmg: 0, life: 0, pierce: 0, hitList: null, ctx: null, split: false, scale: 1,
    /* todo5 §6.2：谱系节点挂在子弹上，池化复位时必须清干净 */
    gene: null, baseDmg: 0, pierceHits: 0, bounceHits: 0,
    pendingBlast: false, homing: 0, splitBudget: 0, volleyIndex: 0
  }), b => {
    b.ctx = null; b.hitList = null; b.gene = null;
    b.pierceHits = 0; b.bounceHits = 0; b.pendingBlast = false;
    b.homing = 0; b.splitBudget = 0; b.volleyIndex = 0; b.baseDmg = 0;
  });
}

function spawnBullet(origin, dir, dmg, ctx, opts) {
  opts = opts || {};
  const cap = (typeof TUNE.GENEALOGY !== 'undefined') ? TUNE.GENEALOGY.projectileCap : 300;
  if (G.bullets.count >= cap) return null;
  const b = G.bullets.get();
  b.pos.copy(origin); b.prev.copy(origin);
  b.dir.copy(dir).normalize();
  b.speed = TUNE.GUN.muzzleVel * (opts.split ? 0.85 : 1);
  b.dmg = dmg;
  b.life = TUNE.GUN.bulletLife;
  b.pierce = opts.pierce !== undefined ? opts.pierce : G.derived.pierce;
  b.hitList = new Set();
  b.ctx = ctx;
  b.split = !!opts.split;
  b.scale = (opts.scale || 1) * G.derived.bulletScale;
  b.pierceHits = 0; b.bounceHits = 0;
  b.gene = opts.gene || null;
  b.baseDmg = opts.gene ? dmg : 0;
  b.pendingBlast = false; b.homing = 0;
  b.splitBudget = G.derived.splitCount || 0;
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

/* 子弹退场的唯一出口：谱系里还欠一次终点结算的，在这里补上（todo5 §4.3） */
function retireBullet(b) {
  if (b.gene && typeof AG !== 'undefined') AG.onBulletEnd(b, b.pos);
  G.bullets.release(b);
}

const _hitCand = [];
function updateBullets(dt) {
  const list = G.bullets.live;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b._dead) continue;
    b.life -= dt;
    /* todo5 §4.3：贯穿弹的「终点爆破」必须在子弹自然消失的那一刻兑现，
       否则打空的那一发就静静消失，玩家永远看不到终点这个概念。 */
    if (b.life <= 0) { retireBullet(b); continue; }

    b.prev.copy(b.pos);
    /* 追踪裂片分支（§7.3 史诗）：只在有限时间内轻微修正方向，不做制导导弹 */
    if (b.homing > 0) {
      b.homing -= dt;
      const t = pickChainTarget(b.pos.x, b.pos.z, 13, b.hitList ? null : null);
      if (t) {
        V3b.set(t.pos.x - b.pos.x, t.pos.y + t.height * 0.5 - b.pos.y, t.pos.z - b.pos.z).normalize();
        b.dir.lerp(V3b, Math.min(1, 4.5 * dt)).normalize();
      }
    }
    b.pos.addScaledVector(b.dir, b.speed * dt);

    /* 出界或撞掩体 */
    if (Math.abs(b.pos.x) > R.arenaHalf || Math.abs(b.pos.z) > R.arenaHalf || b.pos.y < 0.02) {
      R.spark(b.pos, null, 0x9fb4c8);
      retireBullet(b); continue;
    }
    /* 子弹撞城市几何。
       之前这里查的是旧平面竞技场的 R.obstacles 圆柱表 —— 城市地图下那张表恒为空，
       于是子弹会直接穿过整栋楼。城市地图里「墙能挡枪线」是战术的前提：
       没有它，掩体、街道峡谷和纵深选择全部不成立。 */
    if (CITY.segBlocked(b.prev.x, b.prev.y, b.prev.z, b.pos.x, b.pos.y, b.pos.z)) {
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
  b.hitList.add(e.uid);

  /* todo5 §6.3：同一目标在单根攻击里的重复命中上限。
     不通过就当没打中 —— 子弹继续飞，但不再对这只敌人结算第 N+1 次。 */
  if (b.gene && typeof AG !== 'undefined' && !AG.gate(b.gene, e)) {
    R.spark(point, b.dir, 0x8fa4b8);
    return;
  }

  /* 骨板判定 §19：正面命中才吃骨板；背后与头部绕过 */
  const toHit = V3b.set(point.x - e.pos.x, 0, point.z - e.pos.z).normalize();
  const facing = V3.set(e.face.x, 0, e.face.z).normalize();
  const fromFront = toHit.dot(facing) > MUT.ossify.enemy.frontDot;

  let dmg = b.dmg;
  if (weak) dmg *= G.derived.weakpointMult;
  const hpBefore = e.hp;
  const dealt = damageEnemy(e, dmg, b.ctx, { point: point, weakpoint: weak, fromFront: fromFront, bullet: b });
  const killed = e.dead && hpBefore > 0;

  G.stats.hits++;
  if (weak && dealt > 0) {
    /* 弱点世界反馈：金白粒子爆发，而不是只换个浅黄色 */
    G.stats.weakHits = (G.stats.weakHits || 0) + 1;
    if (killed) G.stats.weakKills = (G.stats.weakKills || 0) + 1;
    R.spark(point, b.dir, 0xfff4c0);
    R.spark(point, b.dir, 0xffd24a);
    R.puff(point, 0.12, 1.05, 0xfff0b0, 0.2);
    Audio2.weakConfirm(killed);
    G.ui.hitMark(killed ? 'weakkill' : 'weak');
    G.ui.dmgNumber(point, Math.round(dealt), killed);
  } else {
    R.spark(point, b.dir, b.split ? MUT.fission.color : 0xffd08a);
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

  /* todo5 §6.1：贯穿 → 弹射 → 分裂 → 爆裂 的顺序全部在 AG.onHit 里，
     是一个函数里的顺序语句，而不是若干个各自订阅、顺序靠优先级碰运气的回调。 */
  if (b.gene && typeof AG !== 'undefined') {
    if (!AG.onHit(b, e, point, weak, dealt)) G.bullets.release(b);
    return;
  }

  /* 贯穿（todo/todo2/todo3 的旧路径，?build=old 时仍然走这里） */
  if (b.pierce > 0) {
    b.pierce--; b.pierceHits++;
  } else {
    G.bullets.release(b);
  }
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

  p.hp -= amount;
  Audio2.hurt(kind);
  G.shake(0.16, null);

  /* 方向指示：把伤害来源投到屏幕平面 */
  let ang = 0;
  if (fromPos) {
    const dx = fromPos.x - p.pos.x, dz = fromPos.z - p.pos.z;
    const world = Math.atan2(dx, dz);
    ang = world - (p.yaw + Math.PI);
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang < -Math.PI) ang += Math.PI * 2;
  }
  G.ui.damageFrom(ang, DMG_COLOR[kind] || '#ff4d5e');

  if (p.hp <= 0) { p.hp = 0; G.lose(); }
}
