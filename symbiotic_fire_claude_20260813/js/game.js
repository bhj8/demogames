/* ============================================================================
   SYMBIOTIC FIRE · 主循环
   玩家 / 敌人 / 投放导演 / 时间轴 / 三选一 / HUD / 调试面板
   ========================================================================== */
'use strict';

const $ = id => document.getElementById(id);

/* SVG 环形扇区路径：威胁弧要能变宽变亮，用弧比用三角形干净 */
function arcPath(a0, a1, r0, r1) {
  const cx = 200, cy = 200;
  const p = (a, r) => (cx + Math.sin(a) * r).toFixed(1) + ' ' + (cy - Math.cos(a) * r).toFixed(1);
  const big = (a1 - a0) > Math.PI ? 1 : 0;
  return 'M ' + p(a0, r0) + ' A ' + r0 + ' ' + r0 + ' 0 ' + big + ' 1 ' + p(a1, r0) +
         ' L ' + p(a1, r1) + ' A ' + r1 + ' ' + r1 + ' 0 ' + big + ' 0 ' + p(a0, r1) + ' Z';
}
const TV = new THREE.Vector3(), TV2 = new THREE.Vector3();
const _muzzleW = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/* ============================================================================
   地图模式（todo3 §1）
   ?map=flat 一次性关掉全部 todo3 开关，回到 todo/todo2 的平面版本；
   这是隔离与回滚的唯一入口，其余代码只读 MODE.city / TUNE.FEATURES.*
   ========================================================================== */
const MODE = {
  city: QS.get('map') !== 'flat',
  get vertMove() { return this.city && TUNE.FEATURES.verticalMovement; },
  get vertEnemy() { return this.city && TUNE.FEATURES.verticalEnemies; },
  get mapEvents() { return this.city && TUNE.FEATURES.dynamicMapEvents; },
  get evolution() { return TUNE.FEATURES.unifiedEvolution; }
};
if (!MODE.city) {
  /* 平面模式下 todo3 的系统全部让位，旧流程原样运行 */
  TUNE.FEATURES.verticalMovement = false;
  TUNE.FEATURES.verticalEnemies = false;
  TUNE.FEATURES.dynamicMapEvents = false;
  TUNE.FEATURES.mapBuildInfluence = false;
}
if (QS.get('evolution') === 'off') TUNE.FEATURES.unifiedEvolution = false;

/* ============================================================================
   敌人
   ========================================================================== */
let _enemyUid = 0;
function makeEnemyPool() {
  return new Pool(() => {
    const grp = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x6f7f6a });
    const body = new THREE.Mesh(R.zombieGeo('grunt'), bodyMat);
    grp.add(body);
    const markMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 });
    const mark = new THREE.Mesh(R.variantMarkGeo('blast'), markMat);
    mark.visible = false; grp.add(mark);
    const plateMat = new THREE.MeshLambertMaterial({ color: MUT.ossify.color, emissive: MUT.ossify.color, emissiveIntensity: 0.25 });
    const plates = [];
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(R.plateGeo(), plateMat);
      p.visible = false; grp.add(p); plates.push(p);
    }
    grp.visible = false;
    R.scene.add(grp);
    return {
      uid: ++_enemyUid, grp: grp, body: body, bodyMat: bodyMat, mark: mark, markMat: markMat,
      plateMeshes: plates,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), knock: new THREE.Vector3(),
      face: new THREE.Vector3(0, 0, 1),
      hp: 1, maxHp: 1, radius: 0.5, height: 1.8, speed: 3, dmg: 8, atk: 1, atkT: 0,
      xp: 1, mass: 1, knockResist: 0, dead: true, variant: null, plates: 0,
      tpl: null, hurtFlash: 0, state: 'walk', stateT: 0, cd: 0, highlight: 0,
      minion: false, boss: false, phase: 0, phaseT: 0, spawnGrace: 0
    };
  }, e => { e.grp.visible = false; });
}

function configureEnemy(e, tpl, pos, opts) {
  opts = opts || {};
  const hpScale = 1 + (G.time / 60) * TUNE.SPAWN.hpScalePerMin;
  e.tpl = tpl;
  e.variant = tpl.variant || null;
  e.maxHp = tpl.hp * hpScale * (opts.hpMult || 1);
  e.hp = e.maxHp;
  e.radius = tpl.radius; e.height = tpl.height;
  e.speed = tpl.speed; e.dmg = tpl.dmg * G.dmgScale();
  e.atk = tpl.atk; e.atkT = RNG.spawn.range(0, 0.5);
  e.xp = tpl.xp * (opts.xpMult !== undefined ? opts.xpMult : 1);
  e.mass = tpl.mass; e.knockResist = tpl.knockResist || 0;
  e.weak = tpl.weak || null;
  e.dead = false; e.hurtFlash = 0; e.state = 'walk'; e.stateT = 0; e.cd = RNG.spawn.range(0, 2);
  e.minion = !!opts.minion; e.boss = !!tpl.boss; e.king = !!tpl.king;
  e.phase = 0; e.phaseT = 0; e.highlight = opts.highlight || 0;
  e.spawnGrace = opts.grace || 0;
  e.pos.copy(pos); e.knock.set(0, 0, 0); e.vel.set(0, 0, 0);
  /* 池化对象必须清干净上一位住客的状态 */
  e.knockCtx = null; e.hitReact = 0; e.grp.rotation.x = 0;
  e.summonCd = tpl.summon ? tpl.summon.cooldown : 0;
  e.slamAt = null; e.chargeDir = { x: 0, z: 1 };

  const kind = tpl.boss ? 'boss' : (tpl.id === 'heavy' ? 'heavy' : tpl.id === 'spitter' ? 'spitter' :
    tpl.id === 'charger' ? 'charger' : 'grunt');
  e.body.geometry = R.zombieGeo(kind);
  e.bodyMat.color.setHex(tpl.color);
  e.bodyMat.emissive.setHex(tpl.variant ? MUT[tpl.variant].color : 0x000000);
  e.bodyMat.emissiveIntensity = tpl.variant ? 0.16 : 0;

  /* 变种标记 §30 */
  if (e.variant) {
    e.mark.geometry = R.variantMarkGeo(e.variant);
    e.markMat.color.setHex(MUT[e.variant].color);
    e.markMat.emissive.setHex(MUT[e.variant].color);
    e.mark.visible = true;
  } else e.mark.visible = false;

  /* 骨甲尸的三层骨板：可破坏部件，不是隐藏护甲值 §19。
     骨板是 grp 的子节点，而 grp 已按 height 缩放 —— 局部坐标必须用归一化单位。 */
  e.plates = tpl.plates || 0;
  for (let i = 0; i < 3; i++) {
    const on = i < e.plates;
    e.plateMeshes[i].visible = on;
    if (on) e.plateMeshes[i].position.set(0, 0.40 + i * 0.15, 0.26);
  }

  const s = e.height;
  e.grp.scale.set(s, s, s);
  e.grp.position.copy(e.pos);
  e.grp.visible = true;
  return e;
}

/* ============================================================================
   投放位置 §31：背后禁止无提示近距离刷怪
   ========================================================================== */
function spawnPosition(forceFront, layerWant) {
  const p = G.player;
  const S = TUNE.SPAWN;
  /* 立体城市：从预先验证过可站立、可达的分层刷怪点里挑（§5.3）。
     几何验证在 CITY._buildSpawnPoints 一次性做完，热路径只做距离与视线判断。 */
  if (CITY.enabled && MODE.vertEnemy) {
    const pick = NAV.pickSpawn ? NAV.pickSpawn(forceFront, layerWant) : null;
    if (pick) return TV.set(pick.x, pick.y, pick.z).clone();
  }
  for (let tries = 0; tries < 28; tries++) {
    /* 大部分刷在视野前方 —— 玩家转一圈找不到怪是最糟的体验。
       剩下的仍然四面八方，靠 §31 的背后距离与威胁指示器兜底。 */
    const front = forceFront || RNG.spawn.chance(S.frontBias);
    const ang = front
      ? p.yaw + Math.PI + RNG.spawn.range(-1.05, 1.05)   // 正面 ±60°
      : RNG.spawn.range(0, Math.PI * 2);
    const dist = forceFront ? TUNE.VARIANT.tutorialDist : RNG.spawn.range(S.minDist, S.maxDist);
    const x = p.pos.x + Math.sin(ang) * dist;
    const z = p.pos.z + Math.cos(ang) * dist;
    if (Math.abs(x) > R.arenaHalf - 2.5 || Math.abs(z) > R.arenaHalf - 2.5) continue;

    if (!forceFront) {
      /* 与玩家视线方向的夹角：背后锥内必须更远 */
      const toS = Math.atan2(x - p.pos.x, z - p.pos.z);
      let rel = toS - (p.yaw + Math.PI);
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const behind = Math.abs(rel) > (Math.PI - (S.rearConeDeg * Math.PI / 180) / 2);
      if (behind && dist < S.rearMinDist) continue;
    }
    let blocked = false;
    for (let o = 0; o < R.obstacles.length; o++) {
      const ob = R.obstacles[o];
      if (Math.hypot(x - ob.x, z - ob.z) < ob.r + 1.2) { blocked = true; break; }
    }
    if (blocked) continue;
    return TV.set(x, 0, z).clone();
  }
  /* 28 次都失败时的兜底：仍然保证不小于最小距离，并夹回场内 */
  const fa = RNG.spawn.range(0, Math.PI * 2);
  const fd = S.minDist + 3;
  const lim = R.arenaHalf - 2.5;
  return TV.set(
    clamp(p.pos.x + Math.sin(fa) * fd, -lim, lim), 0,
    clamp(p.pos.z + Math.cos(fa) * fd, -lim, lim)).clone();
}

/* ============================================================================
   投放导演 §26/§29
   ========================================================================== */
const Director = {
  timer: 0, target: 0, interval: 0,
  update(dt) {
    if (DebugPanel.rangeMode) return;              // 枪感实验场：暂停刷怪
    if (G.bossAlive && G.bossAlive.king) return;   // 尸王阶段停常规刷怪，避免不可读
    const t = G.time, S = TUNE.SPAWN;
    const k = Math.min(1, t / TUNE.RUN_SECONDS);

    /* 目标在场数 */
    const target = Math.min(S.aliveCap,
      Math.round(S.targetBase + S.targetCoef * Math.pow(k, S.targetExp)));
    this.target = target;

    /* 缺得越多，间隔越短；不缺也保持 maxInterval 的涓流 */
    const deficit = Math.max(0, target - G.enemies.count);
    let interval = S.maxInterval / (1 + deficit * S.deficitGain);
    if (G.surge) interval *= 0.55;
    interval = Math.max(S.minInterval, interval);
    this.interval = interval;

    this.timer -= dt;
    let guard = 0;
    while (this.timer <= 0 && guard++ < 16) {
      this.timer += interval;
      if (G.enemies.count >= S.aliveCap) { this.timer = interval; break; }
      this.spawnOne();
    }
  },
  spawnOne() {
    const tpl = this.pickTemplate();
    configureEnemy(G.enemies.get(), tpl, spawnPosition(false));
  },
  /* §26 变异敌人总占比 = 已选变异数 × 8%，上限 32%；巨化权重 0.5 */
  pickTemplate() {
    const t = G.time;
    /* 基础组成：随时间引入 heavy / spitter */
    const pool = [ENEMIES.grunt], w = [1];
    if (G.introduced.heavy) { pool.push(ENEMIES.heavy); w.push(0.16); }
    if (G.introduced.spitter) { pool.push(ENEMIES.spitter); w.push(0.20); }
    const base = RNG.spawn.weighted(pool, w);

    /* 只有 grunt 会被替换成变种模板 §25 */
    if (base !== ENEMIES.grunt || G.variantPool.length === 0) return base;
    const share = Math.min(TUNE.VARIANT.cap, G.variantPool.length * TUNE.VARIANT.perMutation);
    if (!RNG.spawn.chance(share)) return base;
    const weights = G.variantPool.map(id => (id === 'giant' ? MUT.giant.enemy.weight : 1));
    const id = RNG.spawn.weighted(G.variantPool, weights);
    return G.variantTpl[id];
  }
};

/* ============================================================================
   敌人更新
   ========================================================================== */
const _sepCand = [];
function updateEnemies(dt) {
  const p = G.player;
  const list = G.enemies.live;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e._dead) continue;

    if (e.dead) { retireEnemy(e); continue; }
    if (e.spawnGrace > 0) e.spawnGrace -= dt;
    if (e.hurtFlash > 0) {
      e.hurtFlash -= dt;
      e.bodyMat.emissiveIntensity = e.variant ? 0.16 + e.hurtFlash * 5 : e.hurtFlash * 6;
      if (e.hurtFlash <= 0 && !e.variant) e.bodyMat.emissive.setHex(0x000000);
      else if (e.hurtFlash > 0) e.bodyMat.emissive.setHex(e.variant ? MUT[e.variant].color : 0xffffff);
    }

    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
    const distSq = dx * dx + dz * dz;
    const dist = Math.sqrt(distSq);
    const nx = dist > 1e-4 ? dx / dist : 0, nz = dist > 1e-4 ? dz / dist : 1;
    e.face.set(nx, 0, nz);

    let moveX = nx, moveZ = nz, speed = e.speed;
    e.stateT -= dt; e.cd -= dt; e.atkT -= dt;

    /* --- 行为分支 --- */
    if (e.boss) {
      updateBoss(e, dt, dist, nx, nz);
      moveX = e.mvx; moveZ = e.mvz; speed = e.mvs;
    } else if (e.tpl.charge) {
      /* 冲撞精英：明显前摇后直线冲锋 §25 */
      if (e.state === 'walk' && dist < e.tpl.charge.range && e.cd <= 0) {
        e.state = 'windup'; e.stateT = e.tpl.charge.windup;
        Audio2.telegraph(e.pos, 'charge');
        e.chargeDir = { x: nx, z: nz };
      } else if (e.state === 'windup') {
        speed = 0.4;
        if (e.stateT <= 0) {
          e.state = 'charge'; e.stateT = e.tpl.charge.duration;
          e.chargeDir = { x: nx, z: nz };
        }
      } else if (e.state === 'charge') {
        moveX = e.chargeDir.x; moveZ = e.chargeDir.z;
        speed = e.tpl.charge.speed;
        if (dist < e.radius + p.radius + 0.5) {
          hurtPlayer(e.tpl.charge.dmg * G.dmgScale(), e.pos, 'charge');
          e.state = 'walk'; e.cd = e.tpl.charge.cooldown;
        }
        if (e.stateT <= 0) { e.state = 'walk'; e.cd = e.tpl.charge.cooldown; }
      }
    } else if (e.tpl.ranged) {
      const rg = e.tpl.ranged;
      if (e.state === 'walk' && dist < rg.range && e.cd <= 0 && e.spawnGrace <= 0) {
        e.state = 'spit'; e.stateT = rg.windup;
        Audio2.telegraph(e.pos, 'spit');
      } else if (e.state === 'spit') {
        speed = 0;
        if (e.stateT <= 0) {
          fireAcid(e, p);
          e.state = 'walk'; e.cd = e.tpl.atk;
        }
      } else if (dist < rg.range * 0.55) {
        speed = e.speed * 0.4;                    // 保持距离，不贴脸
        moveX = -nx * 0.6; moveZ = -nz * 0.6;
      }
    }

    /* 近战三阶段：接触不再直接扣血，必须先走一段前摇（todo.md 阶段二） */
    if (!e.tpl.ranged && !e.boss && e.state !== 'windup' && e.state !== 'charge') {
      const reach = e.radius + p.radius + 0.55;   // 必须大于 stopDist，否则永远够不到
      if (e.state === 'melee') {
        speed = 0;                                   // 前摇期间停住，动作可读
        if (e.stateT <= 0) {
          /* 前摇结束重新检查距离：玩家已经离开就落空 */
          if (dist < reach + 0.35) hurtPlayer(e.dmg, e.pos, 'melee');
          else G.meleeWhiffs++;
          e.state = 'walk'; e.atkT = e.atk;
        }
      } else if (dist < reach && e.atkT <= 0 && e.spawnGrace <= 0) {
        e.state = 'melee'; e.stateT = TUNE.THREAT.meleeWindup;
        Audio2.meleeWindup(e.pos);
      }
    }

    /* 分离力：不然一坨怪会挤成一个点，可读性崩掉 */
    let sx = 0, sz = 0;
    G.hash.query(e.pos.x, e.pos.z, e.radius * 2.2, _sepCand);
    for (let k = 0; k < _sepCand.length; k++) {
      const o = _sepCand[k];
      if (o === e || o.dead) continue;
      const ox = e.pos.x - o.pos.x, oz = e.pos.z - o.pos.z;
      const d2 = ox * ox + oz * oz;
      const rr = e.radius + o.radius;
      if (d2 < rr * rr && d2 > 1e-5) {
        const d = Math.sqrt(d2);
        const push = (rr - d) / rr;
        sx += (ox / d) * push; sz += (oz / d) * push;
      }
    }
    /* 敌人不能走进摄像机里 —— 一堵脸怼在屏幕上会彻底挡住视野。
       到达接触距离就停止靠近，但保留分离力，仍然会互相挤开。 */
    const stopDist = e.radius + p.radius + 0.25;
    if (dist < stopDist && e.state !== 'charge') {
      moveX = 0; moveZ = 0;
      const push = (stopDist - dist) * 6;
      moveX -= nx * push; moveZ -= nz * push;   // 已经嵌进去了就轻轻推出来
    }

    const sepK = e.state === 'charge' ? 0.4 : 2.6;
    moveX += sx * sepK; moveZ += sz * sepK;
    const ml = Math.hypot(moveX, moveZ);
    if (ml > 1e-5) { moveX /= ml; moveZ /= ml; }

    /* 击退衰减 + 余震判定 §23 */
    if (e.knock.lengthSq() > 0.01) {
      const before = { x: e.pos.x, z: e.pos.z };
      e.pos.x += e.knock.x * dt; e.pos.z += e.knock.z * dt;
      e.knock.multiplyScalar(Math.exp(-9 * dt));
      if (G.derived.aftershock && e.knockCtx) {
        G.hash.query(e.pos.x, e.pos.z, e.radius * 2, _sepCand);
        for (let k = 0; k < _sepCand.length; k++) {
          const o = _sepCand[k];
          if (o === e || o.dead) continue;
          if (Math.hypot(e.pos.x - o.pos.x, e.pos.z - o.pos.z) < e.radius + o.radius) {
            G.bus.emit('knockImpact', { enemy: e, other: o, ctx: e.knockCtx });
            e.knockCtx = null;
            break;
          }
        }
      }
      if (e.knock.lengthSq() < 0.01) e.knockCtx = null;
    }

    e.pos.x += moveX * speed * dt;
    e.pos.z += moveZ * speed * dt;
    R.collide(e.pos, e.radius);

    /* 朝向玩家；冲刺时朝冲刺方向 */
    const fx = e.state === 'charge' ? e.chargeDir.x : nx;
    const fz = e.state === 'charge' ? e.chargeDir.z : nz;
    e.grp.position.copy(e.pos);
    e.grp.rotation.y = Math.atan2(fx, fz);

    /* 受击反应：压扁 + 后仰，很短，不影响判定，只让命中"看得出来" */
    if (e.hitReact > 0) {
      e.hitReact -= dt;
      const k = Math.max(0, e.hitReact) / 0.16;
      const sq = 1 + k * 0.14;
      e.grp.scale.set(e.height * sq, e.height * (1 - k * 0.10), e.height * sq);
      e.grp.rotation.x = -k * 0.22;
      if (e.hitReact <= 0) { e.grp.scale.setScalar(e.height); e.grp.rotation.x = 0; }
    }

    /* 前摇的可读性：预警期抖动 + 抬高 */
    if (e.state === 'windup' || e.state === 'spit' || e.state === 'slam' || e.state === 'melee') {
      e.grp.position.x += RNG.fx.range(-0.06, 0.06);
      e.grp.position.z += RNG.fx.range(-0.06, 0.06);
      e.bodyMat.emissive.setHex(0xff6a3c);
      e.bodyMat.emissiveIntensity = 0.35 + Math.sin(G.time * 22) * 0.25;
    }

    /* 教学高亮 §13.3 */
    if (e.highlight > 0) {
      e.highlight -= dt;
      const f = Math.sin(G.time * 8) * 0.5 + 0.5;
      e.bodyMat.emissive.setHex(MUT[e.variant].color);
      e.bodyMat.emissiveIntensity = 0.3 + f * 0.7;
      if (e.highlight <= 0) e.bodyMat.emissiveIntensity = 0.16;
    }
  }
  G.enemies.compact();
}

function retireEnemy(e) {
  /* 掉经验 §11.3 —— 幼体与召唤物不掉 §17 */
  if (e.xp > 0) dropXp(e.pos, e.xp);
  R.puff(TV.copy(e.pos).setY(e.pos.y + e.height * 0.5), 0.2, e.radius * 3, e.variant ? MUT[e.variant].color : 0x8a6a5a, 0.26);
  Audio2.kill(e.pos);
  G.bus.emit('enemyDeath', { enemy: e });
  if (G.bossAlive === e) {
    G.bossAlive = null;
    if (e.king) G.win();
    else G.ui.toast('肉山已倒下', '#ffb35c');
  }
  G.enemies.release(e);
}

/* --- 吐酸者投射物 --- */
function makeAcidPool() {
  return new Pool(() => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, dmg: 0, cfg: null }), null);
}
function fireAcid(e, p) {
  const a = G.acids.get();
  a.pos.copy(e.pos).setY(e.pos.y + e.height * 0.7);
  const dx = p.pos.x - a.pos.x, dy = (p.pos.y + 0.6) - a.pos.y, dz = p.pos.z - a.pos.z;
  const d = Math.hypot(dx, dz);
  const cfg = e.tpl.ranged;
  const tt = d / cfg.projSpeed;
  a.vel.set(dx / tt, dy / tt + 0.5 * 9.8 * tt, dz / tt);
  a.life = 4; a.dmg = e.dmg; a.cfg = cfg;
}
function updateAcids(dt) {
  const list = G.acids.live;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a._dead) continue;
    a.life -= dt;
    a.vel.y -= 9.8 * dt;
    a.pos.addScaledVector(a.vel, dt);
    if (a.pos.y <= 0.1 || a.life <= 0) {
      /* 落地生成酸池 —— 玩家可以走开，不要求跳跃 §11.2 */
      const z = R.zones.get();
      z.mesh.position.set(a.pos.x, 0.04, a.pos.z);
      z.mesh.scale.setScalar(a.cfg.poolRadius);
      z.mesh.material.color.setHex(0xa8c24a); z.mesh.material.opacity = 0.3; z.mesh.visible = true;
      z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(a.cfg.poolRadius);
      z.rim.material.color.setHex(0xa8c24a); z.rim.material.opacity = 0.8; z.rim.visible = true;
      G.hazards.push({
        zone: z, t: 0, dur: a.cfg.poolTime, kind: 'acid',
        radius: a.cfg.poolRadius, dmg: a.cfg.poolDmg * G.dmgScale(), tick: a.cfg.poolTick, tickT: 0
      });
      R.puff(a.pos, 0.2, 1.6, 0xa8c24a, 0.24);
      G.acids.release(a);
    }
  }
  G.acids.compact();
}

/* ============================================================================
   Boss §27 —— 按生命阶段逐个激活玩家选过的共同变异
   ========================================================================== */
function updateBoss(e, dt, dist, nx, nz) {
  e.mvx = nx; e.mvz = nz; e.mvs = e.speed;

  if (e.king) {
    const frac = e.hp / e.maxHp;
    const want = frac > 0.75 ? 1 : frac > 0.5 ? 2 : frac > 0.25 ? 3 : 4;
    const target = Math.min(want, G.mutations.length);
    if (target > e.phase) {
      e.phase = target;
      e.phaseT = 1.5;
      const id = G.mutations[e.phase - 1];
      e.bodyMat.color.setHex(MUT[id].color);
      e.markMat.color.setHex(MUT[id].color);
      e.markMat.emissive.setHex(MUT[id].color);
      e.mark.geometry = R.variantMarkGeo(id);
      e.mark.visible = true;
      G.ui.bossPhase(e.phase, id);
      R.ring(e.pos, 1, 16, MUT[id].color, 1.1);
      Audio2.boss();
      G.shake(0.28, null);
      if (e.phase === 4) e.speed *= 1.25;         // 狂暴 §27
    }
    if (e.phaseT > 0) { e.phaseT -= dt; e.mvs = 0; return; }
  }

  /* 砸地：明显前摇 + 地面预警圈 */
  const sl = e.tpl.slam;
  if (e.state === 'walk' && dist < sl.range && e.cd <= 0) {
    e.state = 'slam'; e.stateT = sl.windup; e.cd = sl.cooldown;
    const z = R.zones.get();
    z.mesh.position.set(e.pos.x, 0.05, e.pos.z);
    z.mesh.scale.setScalar(sl.radius);
    z.mesh.material.color.setHex(0xff7a3c); z.mesh.material.opacity = 0.18; z.mesh.visible = true;
    z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(sl.radius);
    z.rim.material.color.setHex(0xff7a3c); z.rim.material.opacity = 0.9; z.rim.visible = true;
    G.hazards.push({ zone: z, t: 0, dur: sl.windup, kind: 'fuse', blink: true });
    e.slamAt = { x: e.pos.x, z: e.pos.z };
    Audio2.telegraph(e.pos, 'charge');
  } else if (e.state === 'slam') {
    e.mvs = 0;
    if (e.stateT <= 0) {
      const d = Math.hypot(G.player.pos.x - e.slamAt.x, G.player.pos.z - e.slamAt.z);
      if (d <= sl.radius) hurtPlayer(sl.dmg * G.dmgScale(), TV.set(e.slamAt.x, 0, e.slamAt.z), 'slam');
      R.ring(TV.set(e.slamAt.x, 0, e.slamAt.z), 0.5, sl.radius, 0xff7a3c, 0.5);
      Audio2.blast(e.pos, true);
      G.shake(0.30, null);
      /* 阶段变异的表达：借用概念，不照搬普通变种技能 §27 */
      bossMutationFlavor(e, TV.set(e.slamAt.x, 0, e.slamAt.z));
      e.state = 'walk';
    }
    return;
  }

  /* 召唤 */
  const sm = e.tpl.summon;
  if (sm && e.summonCd === undefined) e.summonCd = sm.cooldown;
  if (sm) {
    e.summonCd -= dt;
    if (e.summonCd <= 0) {
      e.summonCd = sm.cooldown;
      const n = e.king ? sm.count + e.phase : sm.count;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const pos = TV2.set(e.pos.x + Math.cos(a) * 3.2, 0, e.pos.z + Math.sin(a) * 3.2).clone();
        /* §26 Boss 生成物不再携带随机变异；标记 minion 以免被当成医疗掉落来源 */
        configureEnemy(G.enemies.get(), ENEMIES.grunt, pos, { grace: 0.6, minion: true, xpMult: 0.4 });
      }
      R.ring(e.pos, 1, 5, e.tpl.accent, 0.5);
    }
  }
}

function bossMutationFlavor(e, at) {
  if (!e.king || e.phase === 0) return;
  const active = G.mutations.slice(0, e.phase);
  active.forEach(id => {
    if (id === 'blast') {
      G.pendings.push({ t: 0.8, kind: 'enemyBlast', pos: at.clone(), radius: 4.5, dmg: 26 * G.dmgScale() });
      const z = R.zones.get();
      z.mesh.position.set(at.x, 0.05, at.z); z.mesh.scale.setScalar(4.5);
      z.mesh.material.color.setHex(MUT.blast.color); z.mesh.material.opacity = 0.18; z.mesh.visible = true;
      z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(4.5);
      z.rim.material.color.setHex(MUT.blast.color); z.rim.material.opacity = 0.85; z.rim.visible = true;
      G.hazards.push({ zone: z, t: 0, dur: 0.8, kind: 'fuse', blink: true });
    } else if (id === 'conduct') {
      for (let i = 0; i < 2; i++) {
        const a = RNG.spawn.range(0, 6.28), d = RNG.spawn.range(3, 8);
        G.pendings.push({
          t: 0.7, kind: 'enemyField',
          pos: TV2.set(at.x + Math.cos(a) * d, 0, at.z + Math.sin(a) * d).clone(),
          radius: 3.2, dmg: 10 * G.dmgScale(), duration: 3.0, tick: 0.5
        });
      }
    } else if (id === 'fission') {
      for (let i = 0; i < 2; i++) {
        const a = RNG.spawn.range(0, 6.28);
        configureEnemy(G.enemies.get(), ENEMIES.grunt,
          TV2.set(at.x + Math.cos(a) * 2.5, 0, at.z + Math.sin(a) * 2.5).clone(),
          { hpMult: 0.35, xpMult: 0, minion: true, grace: 0.5 });
      }
    } else if (id === 'giant') {
      R.ring(at, 1, 12, MUT.giant.color, 0.6);
      const d = Math.hypot(G.player.pos.x - at.x, G.player.pos.z - at.z);
      if (d < 12) {
        const k = (1 - d / 12) * 26;
        G.player.vel.x += (G.player.pos.x - at.x) / Math.max(d, 0.1) * k;
        G.player.vel.z += (G.player.pos.z - at.z) / Math.max(d, 0.1) * k;
      }
    }
  });
}

/* 幼体 §17 —— 不掉经验、不再分裂、不携带其他变异 */
G.spawnMinion = function (parent, ox, oz, hpRatio) {
  const pos = TV.set(parent.pos.x + ox, 0, parent.pos.z + oz).clone();
  const e = configureEnemy(G.enemies.get(), ENEMIES.grunt, pos, {
    hpMult: hpRatio * (parent.maxHp / (ENEMIES.grunt.hp * (1 + (G.time / 60) * TUNE.SPAWN.hpScalePerMin))),
    xpMult: 0, minion: true, grace: 0.45
  });
  e.grp.scale.multiplyScalar(0.72);
  e.radius *= 0.72; e.height *= 0.72;
  e.bodyMat.color.setHex(MUT.fission.color);
  e.bodyMat.emissive.setHex(MUT.fission.color);
  e.bodyMat.emissiveIntensity = 0.3;
};

/* ============================================================================
   经验 §11.3 / §31
   ========================================================================== */
function dropXp(pos, value) {
  if (G.xp.length > 620) { G.xp.shift(); }
  G.xp.push({ x: pos.x, y: 0.42, z: pos.z, v: value, t: 0, home: false, bob: RNG.fx.range(0, 6.28) });
}

const _xpMat = new THREE.Matrix4();
const _xpQ = new THREE.Quaternion();
const _xpS = new THREE.Vector3(1, 1, 1);
function updateXp(dt) {
  const p = G.player;
  const magnet = G.derived.magnetRadius;
  const pick = TUNE.XP.pickupRadius;
  let n = 0;
  for (let i = G.xp.length - 1; i >= 0; i--) {
    const c = G.xp[i];
    c.t += dt;
    const dx = p.pos.x - c.x, dz = p.pos.z - c.z;
    const d = Math.hypot(dx, dz);
    if (!c.home && (d < magnet || c.t > TUNE.XP.autoHomeAfter)) c.home = true;
    if (c.home) {
      const sp = TUNE.XP.flySpeed * (1 + Math.max(0, 3 - d));
      c.x += dx / Math.max(d, 0.01) * sp * dt;
      c.z += dz / Math.max(d, 0.01) * sp * dt;
      c.y = lerp(c.y, 1.0, 1 - Math.exp(-6 * dt));
    } else {
      c.y = 0.42 + Math.sin(G.time * 3 + c.bob) * 0.09;
    }
    if (d < pick) { gainXp(c.v); G.xp.splice(i, 1); continue; }
    if (n < 640) {
      _xpQ.setFromAxisAngle(UP, G.time * 2.4 + c.bob);
      const s = c.v >= 3 ? 1.7 : 1;
      _xpS.set(s, s, s);
      _xpMat.compose(TV.set(c.x, c.y, c.z), _xpQ, _xpS);
      R.xpMesh.setMatrixAt(n, _xpMat);
      n++;
    }
  }
  R.xpMesh.count = n;
  R.xpMesh.instanceMatrix.needsUpdate = true;
}

/* ============================================================================
   节奏控制器
   玩家看不到经验数值，只看得到一条进度条 —— 这给了我们一个可用的空间：
   只要需求只在【升级瞬间】变化，就完全不可见（那一刻进度条本来就归零）。
   反过来，中途改需求会让进度条倒退，那是立刻会被发现的，所以绝对不做。
   ========================================================================== */

/* 期望等级（分数）。玩家从 1 级开始，第一次升级在 firstLevelAt，此后每 targetInterval 一次 */
function expectedLevel(t) {
  const P = TUNE.PACING;
  return 1 + (t + (P.targetInterval - P.firstLevelAt)) / P.targetInterval;
}

/* 经验速率 EMA —— 只用来设定下一级需求，不参与任何战斗判定 */
function trackXpRate(dt) {
  const tau = TUNE.PACING.rateHalfLife / Math.LN2;
  const a = 1 - Math.exp(-dt / tau);
  const inst = G.xpFrame / Math.max(dt, 1e-5);
  G.xpRate += (inst - G.xpRate) * a;
  G.xpFrame = 0;
}

/* 下一级需要多少经验 */
function nextRequirement() {
  const P = TUNE.PACING, t = G.time;

  /* 内层：按最近的收入定价，让任何 build 都落在 targetInterval 附近 */
  const base = (G.xpRate > 0.02 ? G.xpRate : P.bootstrapXp / P.firstLevelAt) * P.targetInterval;

  /* 外层：漂移纠正。落后 → 便宜；超前 → 变贵；死区内完全不动 */
  const delta = expectedLevel(t) - G.player.level;     // >0 表示落后
  const mag = Math.abs(delta);
  let mult = 1;
  if (mag > P.deadband) {
    const k = Math.min(1, (mag - P.deadband) / (P.fullAt - P.deadband));
    if (delta > 0) {
      mult = 1 - k * (1 - P.minReqMult);
    } else {
      mult = 1 + k * (P.maxReqMult - 1);
      /* 后期取消压制，强 build 直接放飞 */
      const fade = clamp((t - P.suppressFadeStart) / (P.suppressFadeEnd - P.suppressFadeStart), 0, 1);
      mult = lerp(mult, 1, fade);
    }
  }
  G.pacingMult = mult;

  let req = base * mult;
  /* 相邻两级的需求不允许突变，否则一次爆发会让节奏抽风 */
  const prev = G.player.xpNext || req;
  req = clamp(req, prev * P.reqStepMin, prev * P.reqStepMax);
  return Math.max(4, Math.round(req));
}

function gainXp(v) {
  const p = G.player;
  p.xp += v;
  G.xpFrame += v;
  let guard = 0;
  while (p.xp >= p.xpNext && guard++ < 12) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = nextRequirement();
    G.pendingLevels++;
  }
  if (G.pendingLevels > 0 && G.phase === 'play') openModChoice();
}

/* ============================================================================
   补给：自适应医疗掉落 + 半动态战术空投（todo.md P0 / P1）
   两个系统职责不同：医疗是逆风兜底，空投是高频短时爽点 + 逼玩家改变路线。
   ========================================================================== */

/* ---- 医疗掉落 ---- */
G.spawnMedical = function (atPos) {
  const M = TUNE.MEDICAL;
  const pos = atPos.clone();
  R.collide(pos, 0.6);              // 掉在尸体位置，但不能卡进柱子里拿不到
  G.medical = { x: pos.x, z: pos.z, t: 0, life: M.lifetime };
  G.medNeed = 0;
  G.medCooldown = M.cooldown;
  R.medMesh.position.set(pos.x, 0, pos.z);
  R.medMesh.visible = true;
  Audio2.pickup('med');
  G.stats.medDropped = (G.stats.medDropped || 0) + 1;
};

function updateMedical(dt) {
  const M = TUNE.MEDICAL, p = G.player;
  const frac = p.hp / p.maxHp;
  if (G.medCooldown > 0) G.medCooldown -= dt;

  /* 隐藏的 medicalNeed：顺风衰减，逆风越急涨得越快。
     不用固定击杀数也不用纯随机 —— 那会造成反向反馈。 */
  if (frac > M.triggerHpFrac) G.medNeed = Math.max(0, G.medNeed - M.decayAbove * dt);
  else if (frac > M.band50) G.medNeed += M.gainBand70 * dt;
  else if (frac > M.band35) G.medNeed += M.gainBand50 * dt;
  else G.medNeed += M.gainBand35 * dt;

  if (!G.medPending && !G.medical && G.medCooldown <= 0 && G.medNeed >= M.needThreshold) {
    G.medPending = true;            // 下一只非召唤物敌人死亡时掉落
  }

  const m = G.medical;
  if (!m) return;
  m.t += dt;
  if (m.t >= m.life) { G.medical = null; R.medMesh.visible = false; return; }
  if (Math.hypot(p.pos.x - m.x, p.pos.z - m.z) < M.pickupRadius) {
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp * M.healFrac);
    G.ui.flashHeal();
    G.ui.floatText('+' + Math.round(p.hp - before), '#3ad07a');
    Audio2.pickup('med');
    G.medical = null; R.medMesh.visible = false;
    G.stats.medPicked = (G.stats.medPicked || 0) + 1;
    return;
  }
  const rem = m.life - m.t;
  R.medCore.rotation.y += dt * 2.2;
  R.medMesh.visible = rem > 5 ? true : (Math.sin(m.t * 18) > -0.3);
}

/* ---- 战术空投 ---- */
function airdropReady() {
  const A = TUNE.AIRDROP;
  if (G.phase !== 'play') return false;                              // 不与三选一抢注意力
  if (G.airdrop) return false;                                       // 场上只允许一个
  if (G.buff) return false;                                          // 强化生效期间不落下一个
  if (G.time - (G.bossSpawnAt || -999) < A.bossGrace) return false;  // Boss 登场演出让位
  return true;
}

function updateAirdrop(dt) {
  const A = TUNE.AIRDROP, p = G.player;

  if (G.time < A.stopAfter && !G.dropQueued) {
    if (G.time >= A.firstAt && G.dropCount === 0) {
      G.dropQueued = true;                                  // 首次固定，用于教学
    } else if (G.dropCount > 0) {
      G.supplyCharge += dt / A.baseInterval;
      const since = G.time - G.lastDropAt;
      if (since >= A.maxInterval) G.dropQueued = true;       // 保底：无视进度
      else if (G.supplyCharge >= 1 && since >= A.minInterval) G.dropQueued = true;
    }
  }

  if (G.dropQueued && airdropReady()) {
    G.dropQueued = false;
    G.supplyCharge = 0;
    G.lastDropAt = G.time;
    G.dropCount++;
    const pos = airdropPosition();
    G.airdrop = { x: pos.x, z: pos.z, state: 'falling', t: 0,
                  telegraph: A.telegraph, life: A.lifetime, modules: null };
    R.podMesh.position.set(pos.x, 26, pos.z);
    R.podMesh.visible = true;
    Audio2.airdropIncoming();
    G.ui.toast('补给舱正在坠落', '#5fe0ff');
  }

  const d = G.airdrop;
  if (!d) return;
  d.t += dt;

  if (d.state === 'falling') {
    const k = Math.min(1, d.t / d.telegraph);
    R.podMesh.position.y = lerp(26, 0, k * k);
    if (d.t >= d.telegraph) {
      d.state = 'open'; d.t = 0;
      R.podMesh.position.y = 0;
      R.ring(TV.set(d.x, 0, d.z), 0.5, 5, 0x5fe0ff, 0.6);
      G.shake(0.18, TV.set(d.x, 0, d.z));
      Audio2.blast(TV.set(d.x, 0, d.z), false);
      d.modules = ['ammo', 'adren', 'shield'].map((id, n) => {
        const a = (n / 3) * Math.PI * 2 - Math.PI / 2;
        const mx = d.x + Math.cos(a) * A.moduleSpread;
        const mz = d.z + Math.sin(a) * A.moduleSpread;
        const g = R.moduleMeshes[n];
        g.position.set(mx, 0, mz); g.visible = true;
        return { id: id, x: mx, z: mz, mesh: g };
      });
    }
    return;
  }

  if (d.t >= d.life) { clearAirdrop(); return; }
  const rem = d.life - d.t;
  for (let n = 0; n < d.modules.length; n++) {
    const m = d.modules[n];
    m.mesh.userData.spin.rotation.y += dt * 1.8;
    m.mesh.visible = rem > 5 ? true : (Math.sin(d.t * 16) > -0.3);
    if (Math.hypot(p.pos.x - m.x, p.pos.z - m.z) < A.pickupRadius) {
      applyBuff(m.id);              // 碰到一个即完成选择，其余两个立即消失
      clearAirdrop();
      return;
    }
  }
  R.podMesh.visible = rem > 5 ? true : (Math.sin(d.t * 16) > -0.3);
}

function airdropPosition() {
  const A = TUNE.AIRDROP, p = G.player;
  for (let i = 0; i < 30; i++) {
    const a = RNG.event.range(0, Math.PI * 2);
    const dist = RNG.event.range(A.minDist, A.maxDist);
    const x = p.pos.x + Math.sin(a) * dist, z = p.pos.z + Math.cos(a) * dist;
    if (Math.abs(x) > R.arenaHalf - 3 || Math.abs(z) > R.arenaHalf - 3) continue;
    let bad = false;
    for (let o = 0; o < R.obstacles.length; o++) {
      const ob = R.obstacles[o];
      if (Math.hypot(x - ob.x, z - ob.z) < ob.r + A.moduleSpread + 1) { bad = true; break; }
    }
    if (bad) continue;
    return TV.set(x, 0, z).clone();
  }
  return TV.set(clamp(p.pos.x + 20, -20, 20), 0, clamp(p.pos.z, -20, 20)).clone();
}

function clearAirdrop() {
  G.airdrop = null;
  R.podMesh.visible = false;
  for (let n = 0; n < R.moduleMeshes.length; n++) R.moduleMeshes[n].visible = false;
}

/* ---- 三种强化 ---- */
const BUFF_NAME = { ammo: '过载供弹', adren: '肾上腺素', shield: '相位护盾' };
const BUFF_CSS = { ammo: '#ffb020', adren: '#ff4d7a', shield: '#4fa8ff' };

function applyBuff(id) {
  const A = TUNE.AIRDROP;
  const dur = (id === 'shield') ? A.shieldMax : A.buffDuration;
  G.buff = { id: id, t: dur, dur: dur, shield: id === 'shield' ? A.shieldAbsorb : 0 };
  if (id === 'ammo') {
    G.player.gun.reloadT = 0;                 // 正在换弹则立即结束并补满
    G.player.gun.ammo = G.derived.magazine;
  }
  if (id === 'adren') G.player.dashCd = 0;    // 拾取时立即恢复一次冲刺
  if (id === 'shield') G.ui.shieldVig(1);
  recompute();
  Audio2.pickup('buff');
  G.ui.toast(BUFF_NAME[id], BUFF_CSS[id]);
  G.stats.buffsTaken = (G.stats.buffsTaken || 0) + 1;
}

function updateBuff(dt) {
  const b = G.buff;
  if (!b) return;
  b.t -= dt;
  if (b.id === 'shield') {
    /* 屏幕边缘蓝光，强度随剩余护盾衰减；绝不复用红色 hurtflash */
    G.ui.shieldVig(b.shield / TUNE.AIRDROP.shieldAbsorb);
  }
  if (b.t <= 0) {
    G.buff = null;
    G.ui.shieldVig(0);
    recompute();                              // 强化结束后完整恢复原始参数
  }
}

/* ============================================================================
   三选一 §13 / §24
   ========================================================================== */
function modAvailable(m) {
  if ((G.mods[m.id] || 0) >= m.max) return false;
  if (m.req && G.mutations.length < m.req) return false;
  return true;
}

function drawModCards() {
  const avail = MODS.filter(modAvailable);
  if (!avail.length) return null;
  const chosen = [];

  /* §24 至少一张基础火力 */
  const fire = avail.filter(m => m.kind === 'fire');
  if (fire.length) chosen.push(RNG.mods.pick(fire));

  /* §24 有共同变异后，至少一张尽量与已有变异协同 */
  if (G.mutations.length > 0) {
    const chain = avail.filter(m => m.kind === 'chain' && !chosen.includes(m));
    if (chain.length) chosen.push(RNG.mods.pick(chain));
  }

  const rest = avail.filter(m => !chosen.includes(m));
  while (chosen.length < 3 && rest.length) {
    chosen.push(rest.splice(RNG.mods.int(rest.length), 1)[0]);
  }
  /* 展示顺序打散，避免"第一张永远是火力"被玩家当成噪音 */
  for (let i = chosen.length - 1; i > 0; i--) {
    const j = RNG.mods.int(i + 1);
    const t = chosen[i]; chosen[i] = chosen[j]; chosen[j] = t;
  }
  return chosen;
}

function openModChoice() {
  const cards = drawModCards();
  if (!cards) {                       // 全部改装满级：不卡在 choose 相
    G.pendingLevels = 0;
    G.ui.hideCards(); G.phase = 'play';
    return;
  }
  G.phase = 'choose';
  Audio2.levelup();
  G.ui.showCards({
    kind: 'mod',
    title: 'LEVEL ' + G.player.level,
    sub: '普通改装',
    cards: cards.map(m => ({
      name: m.name, you: m.text, detail: m.detail,
      lvl: (G.mods[m.id] || 0), max: m.max, id: m.id, kind: m.kind
    })),
    pick: id => { takeMod(id); }
  });
}

function emitBuildChanged() {
  WEAPON.on('buildChanged', {
    twin: lvl('twin') > 0, magLevel: lvl('mag'),
    heavy: G.derived.weaponHeavy, mutations: G.mutations.slice()
  });
}

function takeMod(id) {
  G.mods[id] = (G.mods[id] || 0) + 1;
  recompute();
  emitBuildChanged();
  const gun = G.player.gun;
  gun.ammo = Math.min(gun.ammo, G.derived.magazine);
  if (id === 'mag') gun.ammo = G.derived.magazine;
  G.pendingLevels--;
  /* 连升多级时就地换一批卡，不要一开一关地闪指针锁 */
  if (G.pendingLevels > 0) { openModChoice(); return; }
  G.ui.hideCards();
  G.phase = 'play';
}

/* --- 共同变异事件 §12.2 --- */
function openMutationChoice() {
  const remaining = MUTATIONS.filter(m => !G.mutationSet[m.id]);
  const cards = RNG.mutation.sample(remaining, Math.min(3, remaining.length));
  G.phase = 'choose';
  Audio2.mutation();
  G.ui.showCards({
    kind: 'mutation',
    title: '病毒事件 ' + (G.mutations.length + 1) + ' / 4',
    sub: '共同变异 —— 你和尸潮一起进化',
    cards: cards.map(m => ({
      name: m.name, en: m.en, you: m.you, horde: m.horde,
      detail: m.detail, hordeDetail: m.hordeDetail, css: m.css, id: m.id
    })),
    pick: id => { takeMutation(id); }
  });
}

function takeMutation(id) {
  const m = MUT[id];
  G.mutations.push(id);
  G.mutationSet[id] = true;
  recompute();

  /* §13.3 ① 枪械立即出现对应变化 ② 一句话提示 */
  R.setGunOrgan(id, true);
  emitBuildChanged();
  G.ui.hideCards();
  G.ui.mutationSlots();
  G.ui.toast('你：' + m.you, m.css);
  G.phase = 'play';
  G.bus.emit('mutationChosen', { id: id });

  /* §13.3 ④ 先享受纯收益 ⑤ 提示尸潮已适应 ⑥ 正面教学生成 */
  G.tutorialQueue.push({ t: TUNE.VARIANT.tutorialDelay, id: id });
}

function runTutorialQueue(dt) {
  for (let i = G.tutorialQueue.length - 1; i >= 0; i--) {
    const q = G.tutorialQueue[i];
    q.t -= dt;
    if (q.t > 0) continue;
    G.tutorialQueue.splice(i, 1);
    const m = MUT[q.id];
    G.ui.toast('尸潮已适应：' + m.name + ' —— ' + m.horde, m.css, true);
    Audio2.mutation();
    /* 第一只从正面可见距离脚本生成，带描边 §40 */
    const e = configureEnemy(G.enemies.get(), G.variantTpl[q.id], spawnPosition(true), { highlight: 8, grace: 1.2 });
    G.ui.hint(m.name + '尸：' + m.hordeDetail, m.css);
    /* 之后才进入普通权重池 §26 */
    G.variantPool.push(q.id);
  }
}

/* ============================================================================
   玩家
   ========================================================================== */
function makePlayer() {
  return {
    pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3(),
    yaw: 0, pitch: 0, radius: TUNE.PLAYER.radius,
    hp: TUNE.PLAYER.maxHp, maxHp: TUNE.PLAYER.maxHp,
    level: 1, xp: 0, xpNext: TUNE.PACING.bootstrapXp,
    iframe: 0, dashIFrame: 0, dashCd: 0, dashT: 0, dashDir: new THREE.Vector3(),
    gun: {
      ammo: TUNE.GUN.magazine, reloadT: 0, reloadTotal: 0, fireT: 0, bloom: 0,
      held: false, holdT: 0, idleT: 0, emptyT: 0, dryT: 0, magFilled: true
    },
    /* 相机后坐独立于枪模后坐：方向确定、幅度很小，绝不随机平移（todo2 §4） */
    camRecoil: { pitch: 0, yaw: 0, vp: 0, vy: 0 },
    shotIndex: 0,
    bobT: 0
  };
}

const KEY = {};
addEventListener('keydown', e => {
  if (e.code === 'Escape') { G.togglePause(); return; }
  KEY[e.code] = true;
  if (e.code === 'KeyR') tryReload();
  /* §2.2 立体模式：Space 跳跃（按住时自动翻越/抓边/登墙），Shift 冲刺。
     平面模式保持旧绑定（两个键都是冲刺），避免破坏 todo/todo2 的手感。 */
  if (e.code === 'ShiftLeft') tryDash();
  if (e.code === 'Space') { if (MODE.vertMove) MOVE.onJump(); else tryDash(); }
  if (e.code === 'F1') { DebugPanel.toggle(); e.preventDefault(); }
  else if (BOOT.debug) handleDebugKey(e.code);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', e => { KEY[e.code] = false; });
addEventListener('mousedown', e => {
  if (e.button === 0) G.player.gun.held = true;
  if (e.button === 2) WEAPON.adsWant = true;      // 轻量稳枪，不是硬核 ADS
});
addEventListener('mouseup', e => {
  if (e.button === 0) G.player.gun.held = false;
  if (e.button === 2) WEAPON.adsWant = false;
});
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('mousemove', e => {
  if (document.pointerLockElement !== R.renderer.domElement) return;
  const p = G.player;
  const dx = e.movementX * TUNE.PLAYER.mouseSens;
  const dy = e.movementY * TUNE.PLAYER.mouseSens;
  p.yaw -= dx;
  p.pitch -= dy;
  p.pitch = clamp(p.pitch, -1.5, 1.5);
  G.mouseDX += dx; G.mouseDY += dy;    // 累积到本帧，供枪械惯性摆动使用
});

function tryReload() {
  const g = G.player.gun;
  if (G.derived.infiniteMag) return;          // 过载供弹期间不允许进入换弹状态
  if (g.reloadT > 0 || g.ammo >= G.derived.magazine) return;
  g.reloadT = G.derived.reloadTime;
  g.reloadTotal = G.derived.reloadTime;
  g.magFilled = false;                        // 弹量要等 magIn 事件才恢复
  /* §18 换弹期间保留一半超频进度 */
  G.overclock *= MUT.overclock.player.reloadKeep;
  /* 分阶段动作与声音由表现层按 total 的比例驱动，
     所以快速装填升级会同比例加速整套流程，不会动作与计时错位 */
  WEAPON.on('reloadStart', { total: g.reloadTotal });
  G.bus.emit('reload', {});
}

function tryDash() {
  const p = G.player;
  if (MODE.vertMove) { MOVE.onDash(); return; }   // 充能与无敌帧的核对在 movement.js
  if (p.dashCd > 0 || p.dashT > 0) return;
  const f = inputDir();
  if (f.lengthSq() < 0.01) { f.set(0, 0, -1).applyAxisAngle(UP, p.yaw); }
  p.dashDir.copy(f).normalize();
  p.dashT = TUNE.PLAYER.dashTime;
  p.dashIFrame = TUNE.PLAYER.dashIFrame;
  p.dashCd = G.derived.dashCooldown;
  Audio2.dash();
  G.bus.emit('dash', {});
}

function inputDir() {
  const p = G.player;
  let x = 0, z = 0;
  if (KEY.KeyW) z -= 1;
  if (KEY.KeyS) z += 1;
  if (KEY.KeyA) x -= 1;
  if (KEY.KeyD) x += 1;
  const v = TV2.set(x, 0, z);
  if (v.lengthSq() > 0) v.normalize().applyAxisAngle(UP, p.yaw);
  return v;
}

function updatePlayer(dt) {
  const p = G.player, g = p.gun, d = G.derived;

  if (p.iframe > 0) p.iframe -= dt;
  if (p.dashIFrame > 0) p.dashIFrame -= dt;
  if (p.dashCd > 0) p.dashCd -= dt;

  /* 移动 —— 立体城市走 movement.js 的状态机；平面模式保持原样（todo3 §1 回退要求） */
  if (MODE.vertMove) {
    MOVE.update(dt, p);
  } else if (p.dashT > 0) {
    p.dashT -= dt;
    p.pos.addScaledVector(p.dashDir, TUNE.PLAYER.dashSpeed * dt);
    R.collide(p.pos, p.radius);
  } else {
    const want = inputDir().multiplyScalar(d.moveSpeed);
    p.vel.x = smooth(p.vel.x, want.x, TUNE.PLAYER.accel * 0.14, dt);
    p.vel.z = smooth(p.vel.z, want.z, TUNE.PLAYER.accel * 0.14, dt);
    p.pos.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(Math.exp(-1.2 * dt));
    R.collide(p.pos, p.radius);
  }

  /* 换弹推进：弹量在 magIn 恢复，但要到 reloadEnd 才允许射击 */
  if (g.reloadT > 0) {
    g.reloadT -= dt;
    if (g.reloadT <= 0) { g.reloadT = 0; WEAPON.on('reloadEnd'); }
  }

  /* 超频 §18 */
  if (hasMut('overclock')) {
    const oc = MUT.overclock.player;
    if (g.held && g.ammo > 0 && g.reloadT <= 0) {
      g.idleT = 0;
      G.overclock = Math.min(1, G.overclock + dt / oc.rampTime);
    } else {
      g.idleT += dt;
      if (g.idleT > oc.holdGrace && g.reloadT <= 0) G.overclock = Math.max(0, G.overclock - oc.decayRate * dt);
    }
    /* 血管发光已由 weapon.js 的 update 统一驱动 */
  }

  /* 射击 §11.3 —— 弹匣打空后自动换弹，但先留一个可感知的空仓瞬间（todo2 §6.2） */
  g.fireT -= dt;
  g.dryT -= dt;
  if (g.reloadT <= 0 && G.phase === 'play') {
    if (!d.infiniteMag && g.ammo <= 0) {
      g.emptyT += dt;
      if (g.held && g.dryT <= 0) { WEAPON.on('empty'); g.dryT = 0.28; }
      if (g.emptyT >= TUNE.WEAPON_FX.emptyBeat) tryReload();
    } else if (g.held && g.fireT <= 0) {
      g.emptyT = 0;
      fire(); g.fireT = effectiveFireInterval();
    }
  }

  /* 相机后坐：方向确定的 pitch/yaw，回位用临界阻尼，不越过 */
  const cr = p.camRecoil, WF = TUNE.WEAPON_FX;
  cr.vp += (-cr.pitch * 190 - cr.vp * 26) * dt;
  cr.vy += (-cr.yaw * 190 - cr.vy * 26) * dt;
  cr.pitch += cr.vp * dt; cr.yaw += cr.vy * dt;
  g.bloom = Math.max(0, g.bloom - TUNE.GUN.bloomDecay * dt);

  /* 神经回授配额 §23 */
  G.feedbackTimer -= dt;
  if (G.feedbackTimer <= 0) { G.feedbackTimer = 1; G.feedbackBudget = 4; }

  /* 相机 */
  const speed = Math.hypot(p.vel.x, p.vel.z);
  p.bobT += dt * speed * 1.5;
  const grounded = MODE.vertMove ? MOVE.pose.grounded : true;
  /* 空中不做步态晃动 —— 跑酷中再叠 bob 会直接读不清准星（§8.4） */
  const bob = Math.sin(p.bobT * 2) * 0.022 * Math.min(1, speed / 6) * (grounded ? 1 : 0.15);
  /* 眼高 = 脚底 + 身高；滑铲下蹲与落地压缩只动高度，不动朝向 */
  const eye = TUNE.PLAYER.height
    - (MODE.vertMove ? MOVE.pose.crouch * (TUNE.PLAYER.height - TUNE.MOVEMENT.slideHeight) : 0)
    - (MODE.vertMove ? MOVE.pose.landImpact * 0.16 : 0);
  R.camera.position.set(p.pos.x, p.pos.y + eye + bob, p.pos.z);
  R.camera.rotation.set(0, 0, 0);
  R.camera.rotateY(p.yaw + p.camRecoil.yaw);
  R.camera.rotateX(p.pitch + p.camRecoil.pitch + G.shakePitch);
  R.camera.rotateZ(G.shakeRoll + (MODE.vertMove ? MOVE.pose.tilt : 0));
  R.camera.position.x += G.shakeX; R.camera.position.z += G.shakeZ;

  /* 速度用 FOV 表达，不用随机抖动 */
  const fastK = MODE.vertMove ? clamp((speed - 7) / 9, 0, 1) : 0;
  const fov = TUNE.PLAYER.fovBase + (p.dashT > 0 ? TUNE.PLAYER.fovSprintAdd : 0)
    + fastK * (TUNE.MOVEMENT.stableCam ? 2 : 6)
    + WEAPON.pose.ads * TUNE.WEAPON_FX.adsFov;
  R.camera.fov = smooth(R.camera.fov, fov, 9, dt);
  R.camera.updateProjectionMatrix();

  /* 武器摆动 */
  R.lamp.position.set(p.pos.x, p.pos.y + TUNE.PLAYER.height + 0.4, p.pos.z);

  /* 枪械表现层：只喂状态，动作全部由 weapon.js 自己解算 */
  WEAPON.update(dt, {
    vel: p.vel,
    sprinting: p.dashT > 0,
    yawDelta: G.mouseDX, pitchDelta: G.mouseDY,
    overclock: G.overclock,
    conductCharge: hasMut('conduct') ? G.conductCounter / MUT.conduct.player.hits : 0,
    stableLevel: lvl('stable'),
    ammo: g.ammo, magazine: d.magazine, infiniteMag: d.infiniteMag,
    onMagIn: () => { g.ammo = d.magazine; g.magFilled = true; }
  });
  G.mouseDX = 0; G.mouseDY = 0;

  Audio2.setListener(R.camera.position, R.camera.getWorldDirection(TV), UP);
}

/* 相机 yaw 的固定序列：可学习，不是随机噪声（todo2 §4） */
const YAW_PATTERN = [0.55, -0.35, 0.85, -0.7, 0.4, -0.9];

function fire() {
  const p = G.player, g = p.gun, d = G.derived, W = TUNE.WEAPON_FX;
  if (!d.infiniteMag) g.ammo--;
  G.stats.shots++;
  p.shotIndex++;
  g.bloom = Math.min(1, g.bloom + TUNE.GUN.bloomPerShot);

  /* 相机后坐：很小、方向确定 */
  const heavy = d.weaponHeavy;
  p.camRecoil.vp += W.cameraRecoilScale * heavy * (1 + WEAPON.climb * 5) * 60;
  p.camRecoil.vy += W.cameraYawScale * heavy * YAW_PATTERN[p.shotIndex % YAW_PATTERN.length] * 60;

  const spread = DebugPanel.noSpread ? 0
    : (d.spreadBase + d.spreadBloom * g.bloom) * Math.PI / 180;
  const origin = TV.copy(R.camera.position).clone();
  const baseDir = R.camera.getWorldDirection(new THREE.Vector3());

  /* 枪口位置：视觉上从枪管出，但弹道从准星出，避免"打不中我瞄的地方" */
  const muzzleWorld = origin.clone().addScaledVector(baseDir, 0.7);

  for (let i = 0; i < d.pellets; i++) {
    const dir = baseDir.clone();
    const a = RNG.fx.range(0, Math.PI * 2), r = Math.sqrt(RNG.fx.next()) * spread;
    const right = TV2.copy(dir).cross(UP).normalize();
    const up2 = right.clone().cross(dir).normalize();
    dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up2, Math.sin(a) * r).normalize();
    const ctx = makeAttack('primary');
    spawnBullet(muzzleWorld, dir, d.damage, ctx, {});
  }

  /* 曳光从真实枪口出发，但弹道仍从准星方向收敛 —— 避免"瞄哪打不到哪" */
  WEAPON.muzzleWorldPos(_muzzleW);
  const tracerColor = hasMut('giant') ? 0xffe08a : 0xffd9a0;
  WEAPON.addTracer(_muzzleW, baseDir, tracerColor, W.tracerLength * (hasMut('giant') ? 1.25 : 1));
  if (d.pellets > 1) WEAPON.addTracer(_muzzleW, baseDir, tracerColor, W.tracerLength * 0.8);

  const isLast = !d.infiniteMag && g.ammo <= 0;
  WEAPON.on('shot', {
    isLastRound: isLast, pellets: d.pellets, overclock: G.overclock,
    heavy: heavy, boltSpeed: 1 + G.overclock * 0.45
  });
  Audio2.shot(1 + G.overclock * 0.35, heavy);
  if (isLast) Audio2.lastRound();

  /* 开火不震屏 —— 力量全部由枪模、机械部件、枪口光和声音承担 */
  G.bus.emit('fire', {});
}

/* ============================================================================
   HUD / UI
   ========================================================================== */
const UI = {
  init() {
    this.hp = $('hpfill'); this.hpNum = $('hpnum');
    this.xpFill = $('xpfill'); this.lvl = $('lvlnum');
    this.clock = $('clock'); this.ammo = $('ammo'); this.ammoBar = $('ammobar');
    this.dash = $('dashfill'); this.slots = $('slots');
    this.cards = $('cards'); this.toastEl = $('toast'); this.hintEl = $('hint');
    this.bossWrap = $('bosswrap'); this.bossFill = $('bossfill'); this.bossName = $('bossname');
    this.dmgDirs = $('dmgdirs'); this.threatEl = $('threats');
    this.vig = $('vignette');
    this.buffEl = $('buffbar');
    this.reloadWrap = $('reloadwrap'); this.reloadBar = $('reloadbar');
    this.crossEl = $('cross'); this._lastAmmo = -1;
    this.medMark = $('medmark'); this.dropMark = $('dropmark');
    this._arcs = Array.prototype.slice.call(document.querySelectorAll('#threatarcs path'));
    this.hitMarkEl = $('hitmark');
    /* 伤害数字池：9 发/秒 + 高密度下不能每帧新建 DOM */
    this._dnums = []; this._dnumI = 0;
    for (let i = 0; i < 12; i++) {
      const d = document.createElement('div'); d.className = 'dnum';
      $('dmgnums').appendChild(d); this._dnums.push(d);
    }
    this._toastT = 0; this._hintT = 0; this._dirs = [];
    this._threats = [];
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div'); d.className = 'dmgdir'; this.dmgDirs.appendChild(d);
      this._dirs.push({ el: d, t: 0 });
    }
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('div'); d.className = 'threat'; this.threatEl.appendChild(d);
      this._threats.push(d);
    }
  },

  update(dt) {
    const p = G.player;
    const hpk = p.hp / p.maxHp;
    this.hp.style.width = (hpk * 100) + '%';
    this.hp.style.background = hpk > 0.5 ? 'linear-gradient(90deg,#3ad07a,#7ef0a8)'
      : hpk > 0.25 ? 'linear-gradient(90deg,#e0a634,#ffd06a)' : 'linear-gradient(90deg,#d03a4a,#ff6a7a)';
    this.hpNum.textContent = Math.ceil(p.hp) + ' / ' + Math.round(p.maxHp);
    this.vig.style.opacity = (1 - hpk) * 0.55;

    this.xpFill.style.width = (p.xp / p.xpNext * 100) + '%';
    this.lvl.textContent = p.level;
    this.clock.textContent = fmtTime(TUNE.RUN_SECONDS - G.time);
    if (G.time > TUNE.RUN_SECONDS - 30) this.clock.classList.add('urgent');

    /* 弹药：明确表达"当前弹匣 / 无限备弹"，换弹期间保留数字（todo2 §6.1） */
    const g = p.gun, cap = G.derived.magazine;
    const inf = G.derived.infiniteMag;
    const frac = inf ? 1 : g.ammo / cap;
    if (inf) {
      this.ammo.innerHTML = '&infin;<small>过载供弹</small>';
      this.ammo.className = '';
    } else {
      this.ammo.innerHTML = g.ammo + '<small>/ &infin;</small>';
      this.ammo.className = frac < 0.25 ? 'low' : '';
      if (g.ammo === 0 && this._lastAmmo !== 0) { this.ammo.classList.add('last'); }
    }
    this._lastAmmo = g.ammo;
    this.ammoBar.style.width = (frac * 100) + '%';
    this.ammoBar.style.background = inf ? '#7ef0a8' : (frac < 0.25 ? '#ff6a4a' : '#d8e4ee');

    /* 换弹进度用独立的条 */
    if (g.reloadT > 0) {
      this.reloadWrap.classList.add('on');
      this.reloadBar.style.width = ((1 - g.reloadT / Math.max(0.001, g.reloadTotal)) * 100) + '%';
    } else this.reloadWrap.classList.remove('on');

    this.dash.style.width = (p.dashCd > 0 ? (1 - p.dashCd / G.derived.dashCooldown) * 100 : 100) + '%';

    /* 动态准星：间距反映当前 bloom，但不能大到遮挡尸潮 */
    const sp = 4 + g.bloom * 13 + WEAPON.climb * 26 - WEAPON.pose.ads * 2.5;
    this.crossEl.style.setProperty('--sp', clamp(sp, 2.5, 22).toFixed(1) + 'px');

    /* 受伤方向 §31 */
    this._dirs.forEach(d => {
      if (d.t > 0) { d.t -= dt; d.el.style.opacity = Math.min(1, d.t * 2.2); }
      else d.el.style.opacity = 0;
    });

    /* 屏幕边缘威胁方向 §31 + todo.md 阶段一扇区聚合 */
    this._updateThreats();
    this._updateMarkers();
    this._updateBuff();

    if (this._toastT > 0) { this._toastT -= dt; if (this._toastT <= 0) this.toastEl.classList.remove('on'); }
    if (this._hintT > 0) { this._hintT -= dt; if (this._hintT <= 0) this.hintEl.classList.remove('on'); }

    if (G.bossAlive) {
      this.bossWrap.classList.add('on');
      this.bossFill.style.width = (G.bossAlive.hp / G.bossAlive.maxHp * 100) + '%';
    } else this.bossWrap.classList.remove('on');
  },

  _threatBuf: [],
  /* 威胁聚合（todo.md 阶段一）
     把玩家周围分成 8 个扇区，每个扇区累计 threatScore，
     而不是给每只怪画一个箭头 —— 后方几十只怪不能变成几十个箭头。 */
  _updateThreats() {
    const p = G.player, T2 = TUNE.THREAT;
    const N = T2.sectors;
    const score = this._sectorScore || (this._sectorScore = new Float32Array(N));
    const danger = this._sectorDanger || (this._sectorDanger = new Uint8Array(N));
    score.fill(0); danger.fill(0);

    /* 水平半视场角：进入镜头视野的一般威胁不再提示 */
    const vFov = R.camera.fov * Math.PI / 180;
    const hHalf = Math.atan(Math.tan(vFov / 2) * R.camera.aspect) * 0.92;

    const cand = enemiesInRadius(p.pos.x, p.pos.z, T2.warnRange + 6, this._threatBuf);
    const special = [];
    for (let i = 0; i < cand.length; i++) {
      const e = cand[i];
      if (e.dead) continue;
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      const world = Math.atan2(dx, dz);
      let rel = world - (p.yaw + Math.PI);
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;

      /* 接近速度 → 预计接触时间 */
      const closing = Math.max(0.1, e.speed);
      const ttc = Math.max(0, dist - (e.radius + p.radius)) / closing;

      /* 特殊敌人（Boss / 精英 / 正在释放特殊攻击）保留独立高危标记 */
      const isSpecial = e.boss || e.tpl.elite || e.state === 'charge' || e.state === 'windup';
      if (isSpecial && special.length < 4) {
        special.push({ rel: rel, css: e.boss ? '#ff5f7a' : '#ff8a4a' });
        continue;
      }

      if (dist > T2.warnRange && ttc > T2.warnTtc) continue;
      const inView = Math.abs(rel) < hHalf;
      const hot = dist <= T2.dangerRange || ttc <= T2.dangerTtc || e.state === 'melee';
      /* 进入视野的一般威胁隐藏；但已抬手的仍然提示 */
      if (inView && !(e.state === 'melee')) continue;

      const k = Math.floor(((rel + Math.PI) / (Math.PI * 2)) * N + 0.5) % N;
      const prox = 1 - Math.min(1, dist / T2.warnRange);
      score[k] += 0.55 + prox * 1.1 + (hot ? 1.0 : 0);
      if (hot) danger[k] = 1;
    }

    /* 只显示威胁最高的几个扇区 */
    const order = [];
    for (let k = 0; k < N; k++) if (score[k] > 0.01) order.push(k);
    order.sort((a, b) => score[b] - score[a]);
    const shown = order.slice(0, T2.maxShown);

    /* 升级为红时响一声，禁止持续蜂鸣 */
    this._wasDanger = this._wasDanger || new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      if (danger[k] && !this._wasDanger[k] && shown.indexOf(k) >= 0) {
        const a = (k / N) * Math.PI * 2 - Math.PI + (p.yaw + Math.PI);
        Audio2.incoming(TV.set(p.pos.x + Math.sin(a) * 4, 1, p.pos.z + Math.cos(a) * 4));
      }
      this._wasDanger[k] = danger[k];
    }

    /* 画弧：分数越高弧越宽越亮，而不是多画几个箭头 */
    const sectorArc = (Math.PI * 2) / N;
    for (let n = 0; n < this._arcs.length; n++) {
      const el = this._arcs[n];
      if (n >= shown.length) { el.setAttribute('opacity', 0); continue; }
      const k = shown[n];
      const sc = Math.min(T2.sectorMaxScore, score[k]) / T2.sectorMaxScore;
      const mid = (k / N) * Math.PI * 2 - Math.PI;
      const half = sectorArc * (0.42 + sc * 0.34);
      el.setAttribute('d', arcPath(mid - half, mid + half, 150, 150 + 10 + sc * 16));
      el.setAttribute('fill', danger[k] ? '#ff4d5e' : '#ffc14d');
      el.setAttribute('opacity', (danger[k] ? 0.55 : 0.34) + sc * 0.3);
    }

    /* 特殊敌人的独立标记保留 */
    this._threats.forEach((el, n) => {
      if (n < special.length) {
        el.style.opacity = 0.9;
        el.style.transform = 'translate(-50%,-50%) rotate(' + (special[n].rel * 180 / Math.PI) + 'deg)';
        el.style.borderBottomColor = special[n].css;
      } else el.style.opacity = 0;
    });
  },

  /* 屏外目标方向标（医疗 / 空投） */
  _updateMarkers() {
    const p = G.player;
    const vFov = R.camera.fov * Math.PI / 180;
    const hHalf = Math.atan(Math.tan(vFov / 2) * R.camera.aspect) * 0.95;
    const put = (el, obj, show) => {
      if (!obj || !show) { el.style.opacity = 0; return; }
      const dx = obj.x - p.pos.x, dz = obj.z - p.pos.z;
      let rel = Math.atan2(dx, dz) - (p.yaw + Math.PI);
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) < hHalf) { el.style.opacity = 0; return; }   // 进入视野后只留世界光柱
      el.style.opacity = 1;
      el.style.transform = 'translate(-50%,-50%) rotate(' + (rel * 180 / Math.PI) + 'deg)';
      el.firstChild.textContent = Math.round(Math.hypot(dx, dz)) + 'm';
      el.firstChild.style.transform = 'rotate(' + (-rel * 180 / Math.PI) + 'deg)';
    };
    put(this.medMark, G.medical, G.player.hp / G.player.maxHp < TUNE.MEDICAL.offscreenHpFrac);
    put(this.dropMark, G.airdrop, !!G.airdrop);
  },

  /* 强化 HUD */
  _updateBuff() {
    const b = G.buff;
    if (!b) { this.buffEl.classList.remove('on'); return; }
    this.buffEl.classList.add('on');
    this.buffEl.style.borderColor = BUFF_CSS[b.id];
    this.buffEl.style.color = BUFF_CSS[b.id];
    const extra = b.id === 'shield' ? ' · ' + Math.ceil(b.shield) : '';
    this.buffEl.textContent = BUFF_NAME[b.id] + extra + '  ' + b.t.toFixed(1) + 's';
  },

  hitMark(kind) {
    const el = this.hitMarkEl;
    el.className = '';
    void el.offsetWidth;
    el.className = kind;
  },

  /* 伤害数字锚在世界命中点上，投影到屏幕 */
  dmgNumber(worldPos, value, killed, plain) {
    const v = TV.copy(worldPos).project(R.camera);
    if (v.z > 1) return;                        // 在身后，别画
    const el = this._dnums[this._dnumI = (this._dnumI + 1) % this._dnums.length];
    el.className = 'dnum' + (killed ? ' kill' : '') + (plain ? ' plain' : '');
    el.style.left = ((v.x * 0.5 + 0.5) * innerWidth).toFixed(0) + 'px';
    el.style.top = ((-v.y * 0.5 + 0.5) * innerHeight).toFixed(0) + 'px';
    el.style.color = plain ? 'rgba(230,242,252,.75)' : (killed ? '#ff9a4a' : '#ffd24a');
    el.textContent = value;
    void el.offsetWidth;
    el.classList.add('on');
  },

  shieldVig(frac) {
    this.shieldEl = this.shieldEl || $('shieldvig');
    this.shieldEl.style.opacity = frac > 0 ? (0.28 + frac * 0.34).toFixed(2) : 0;
  },

  shieldHit(broken) {
    const el = $('shieldflash');
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
    if (broken) this.toast('护盾已穿', '#4fa8ff');
  },

  floatText(text, color) {
    const el = $('floattext');
    el.textContent = text; el.style.color = color;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  },

  damageFrom(ang, color) {
    const d = this._dirs.find(x => x.t <= 0) || this._dirs[0];
    d.t = 0.85;
    d.el.style.transform = 'translate(-50%,-50%) rotate(' + (ang * 180 / Math.PI) + 'deg)';
    d.el.style.borderBottomColor = color;
    d.el.style.opacity = 1;
    $('hurtflash').style.background = 'radial-gradient(ellipse at center,transparent 42%,' + color + '55 100%)';
    $('hurtflash').classList.remove('on'); void $('hurtflash').offsetWidth; $('hurtflash').classList.add('on');
  },
  flashHeal() { $('healflash').classList.remove('on'); void $('healflash').offsetWidth; $('healflash').classList.add('on'); },
  flashAmmo() { this.ammo.classList.remove('pulse'); void this.ammo.offsetWidth; this.ammo.classList.add('pulse'); },

  toast(text, color, big) {
    this.toastEl.innerHTML = text;
    this.toastEl.style.color = color || '#dbe7f0';
    this.toastEl.className = 'on' + (big ? ' big' : '');
    this._toastT = big ? 4.0 : 2.6;
  },
  hint(text, color) {
    this.hintEl.textContent = text;
    this.hintEl.style.borderLeftColor = color;
    this.hintEl.classList.add('on');
    this._hintT = 6.5;
  },
  bossPhase(n, id) {
    this.bossName.textContent = '尸王 · 阶段 ' + n + ' · ' + MUT[id].name;
    this.bossName.style.color = MUT[id].css;
    this.bossFill.style.background = 'linear-gradient(90deg,' + MUT[id].css + ',#ffffff88)';
    this.toast('尸王学会了：' + MUT[id].name, MUT[id].css, true);
  },
  mutationSlots() {
    this.slots.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      const id = G.mutations[i];
      if (id) {
        s.style.borderColor = MUT[id].css;
        s.style.color = MUT[id].css;
        s.style.boxShadow = '0 0 12px ' + MUT[id].css + '44';
        s.textContent = MUT[id].name[0];
        s.title = MUT[id].name;
      } else { s.classList.add('empty'); s.textContent = '·'; }
      this.slots.appendChild(s);
    }
  },

  /* 卡面 §13.1 —— 主卡只允许两句话，不出现数值 */
  showCards(cfg) {
    const wrap = this.cards;
    wrap.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'cardhead';
    head.innerHTML = '<div class="ct">' + cfg.title + '</div><div class="cs">' + cfg.sub + '</div>';
    wrap.appendChild(head);

    const row = document.createElement('div');
    row.className = 'cardrow';
    cfg.cards.forEach(c => {
      const el = document.createElement('div');
      el.className = 'card ' + cfg.kind;
      if (cfg.kind === 'mutation') {
        el.style.setProperty('--mc', c.css);
        el.innerHTML =
          '<div class="cname" style="color:' + c.css + '">' + c.name +
          '<span class="cen">' + c.en + '</span></div>' +
          '<div class="cico" style="background:' + c.css + '"></div>' +
          '<div class="cline you"><span class="tag">你</span>' + c.you + '</div>' +
          '<div class="cline horde"><span class="tag">尸潮</span>' + c.horde + '</div>' +
          '<div class="cdetail">' + c.detail + '<br><span style="color:#ff8a94">' + c.hordeDetail + '</span></div>';
      } else {
        const pips = '<span class="pips">' + Array.from({ length: c.max }, (_, i) =>
          '<i class="' + (i < c.lvl ? 'on' : '') + '"></i>').join('') + '</span>';
        el.innerHTML =
          '<div class="cname mod">' + c.name + pips + '</div>' +
          '<div class="cline you"><span class="tag k' + c.kind + '">' +
          ({ fire: '火力', chain: '触发', life: '生存' }[c.kind]) + '</span>' + c.you + '</div>' +
          '<div class="cdetail">' + c.detail + '</div>';
      }
      el.onclick = () => cfg.pick(c.id);
      row.appendChild(el);
    });
    wrap.appendChild(row);
    const foot = document.createElement('div');
    foot.className = 'cardfoot';
    foot.textContent = cfg.kind === 'mutation' ? '选择后你立刻获得能力，尸潮会在十几秒后适应' : '悬停查看具体数值';
    wrap.appendChild(foot);
    wrap.classList.add('on');
    document.exitPointerLock();
  },
  hideCards() {
    this.cards.classList.remove('on');
    if (!G.over) R.renderer.domElement.requestPointerLock();
  }
};
G.ui = UI;

/* ============================================================================
   震屏 §31 总强度上限
   ========================================================================== */
G.shakeAmt = 0; G.shakeX = 0; G.shakeZ = 0; G.shakePitch = 0; G.shakeRoll = 0;
G.shakeAdd = function (a) { G.shakeAmt = Math.min(TUNE.FX.shakeMax, G.shakeAmt + a); };
G.shake = function (a, pos) {
  if (pos) {
    const d = Math.hypot(G.player.pos.x - pos.x, G.player.pos.z - pos.z);
    a *= clamp(1 - d / 18, 0, 1);
  }
  G.shakeAdd(a);
};
function updateShake(dt) {
  const F = TUNE.FX;
  G.shakeAmt = Math.max(0, G.shakeAmt - dt * F.shakeDecay);
  const s = G.shakeAmt * G.shakeAmt;
  G.shakeX = RNG.fx.range(-1, 1) * s * F.shakePos;
  G.shakeZ = RNG.fx.range(-1, 1) * s * F.shakePos;
  G.shakePitch = RNG.fx.range(-1, 1) * s * F.shakePitch;
  G.shakeRoll = RNG.fx.range(-1, 1) * s * F.shakeRoll;
}

/* ============================================================================
   时间轴 §28
   ========================================================================== */
G.introduced = {};
function updateTimeline(dt) {
  /* 共同变异事件：固定时间，不受杀怪效率影响 §12.2 */
  while (G.mutIndex < TUNE.MUTATION_TIMES.length && G.time >= TUNE.MUTATION_TIMES[G.mutIndex]) {
    G.mutIndex++;
    openMutationChoice();
    return;
  }
  while (G.tlIndex < TIMELINE.length && G.time >= TIMELINE[G.tlIndex].t) {
    const ev = TIMELINE[G.tlIndex++];
    if (ev.kind === 'intro') {
      G.introduced[ev.enemy] = true;
      UI.toast('新敌人：' + ENEMIES[ev.enemy].name, '#9fd8ff');
    } else if (ev.kind === 'squad') {
      for (let i = 0; i < ev.count; i++) {
        configureEnemy(G.enemies.get(), ENEMIES[ev.enemy], spawnPosition(false), { grace: 1.0 });
      }
      UI.toast('精英来袭：' + ENEMIES[ev.enemy].name, '#ff8a4a');
      Audio2.telegraph(G.player.pos, 'charge');
    } else if (ev.kind === 'boss') {
      const e = configureEnemy(G.enemies.get(), ENEMIES[ev.enemy], spawnPosition(true), { grace: 2.0 });
      G.bossAlive = e;
      G.bossSpawnAt = G.time;                 // 空投要给 Boss 登场演出让位
      UI.bossName.textContent = ENEMIES[ev.enemy].name;
      UI.bossName.style.color = '#ff8a94';
      UI.bossFill.style.background = 'linear-gradient(90deg,#ff5f7a,#ffb0be)';
      UI.toast(ENEMIES[ev.enemy].name + ' 出现', '#ff5f7a', true);
      Audio2.boss();
      G.shakeAdd(0.40);
    } else if (ev.kind === 'surge') {
      G.surge = true;
      UI.toast('撤离倒计时 —— 尸潮全面涌来', '#ffd06a', true);
    }
  }
}

/* ============================================================================
   生命周期
   ========================================================================== */
G.dmgScale = function () { return 1 + (G.time / 60) * TUNE.SPAWN.dmgScalePerMin; };

function cleanupWorldPickups() {
  clearAirdrop();
  R.medMesh.visible = false;
  G.ui.shieldVig(0);
}

G.lose = function () {
  if (G.over) return;
  G.over = true; G.phase = 'over';
  cleanupWorldPickups();
  Audio2.defeat();
  document.exitPointerLock();
  showResults(false);
};
G.win = function () {
  if (G.over) return;
  G.over = true; G.won = true; G.phase = 'over';
  cleanupWorldPickups();
  Audio2.victory();
  document.exitPointerLock();
  showResults(true);
};

G.togglePause = function () {
  if (G.phase === 'choose' || G.over || G.phase === 'menu') return;
  G.paused = !G.paused;
  $('pause').classList.toggle('on', G.paused);
  if (G.paused) document.exitPointerLock();
  else R.renderer.domElement.requestPointerLock();
};

/* §37 结算页显示本局普通改装、四种共同变异和击杀数 */
function showResults(won) {
  const el = $('results');
  const mods = Object.keys(G.mods).filter(k => G.mods[k] > 0)
    .map(k => '<span class="rmod">' + MODMAP[k].name + (G.mods[k] > 1 ? ' ×' + G.mods[k] : '') + '</span>').join('');
  const muts = G.mutations.map(id =>
    '<div class="rmut" style="border-color:' + MUT[id].css + '">' +
    '<b style="color:' + MUT[id].css + '">' + MUT[id].name + '</b>' +
    '<span>你：' + MUT[id].you + '</span><span class="h">尸潮：' + MUT[id].horde + '</span></div>').join('');
  const unseen = MUTATIONS.filter(m => !G.mutationSet[m.id]).map(m => m.name).join(' / ');

  /* 本局触发链：只列实际发生过的，不做伤害瀑布 §32 */
  const aim = [];
  if (G.stats.weakHits) {
    aim.push('弱点命中 ×' + G.stats.weakHits);
    if (G.stats.weakKills) aim.push('爆头击杀 ×' + G.stats.weakKills);
    aim.push('爆头率 ' + Math.round(G.stats.weakHits / Math.max(1, G.stats.hits) * 100) + '%');
  }

  const supply = [];
  if (G.stats.medPicked) supply.push('医疗 ×' + G.stats.medPicked);
  if (G.stats.buffsTaken) supply.push('空投强化 ×' + G.stats.buffsTaken);

  const chain = [];
  if (G.stats.splits) chain.push('分裂 ×' + G.stats.splits);
  if (G.stats.blasts) chain.push('爆裂 ×' + G.stats.blasts);
  if (G.stats.bolts) chain.push('闪电 ×' + G.stats.bolts);

  el.innerHTML =
    '<div class="rtitle" style="color:' + (won ? '#7ef0a8' : '#ff6a7a') + '">' +
    (won ? '撤离成功' : '你没能撑到撤离') + '</div>' +
    '<div class="rsub">存活 ' + fmtTime(Math.min(G.time, TUNE.RUN_SECONDS)) + ' · 击杀 ' + G.stats.kills +
    ' · 等级 ' + G.player.level + '</div>' +
    '<div class="rsec">本局共同变异</div><div class="rmuts">' + (muts || '<i>无</i>') + '</div>' +
    (unseen ? '<div class="runseen">本局未出现：' + unseen + '</div>' : '') +
    '<div class="rsec">触发链</div><div class="rchain">' + (chain.join(' · ') || '<i>未成型</i>') + '</div>' +
    '<div class="rsec">枪法</div><div class="rchain" style="color:#ffd24a">' +
      (aim.join(' · ') || '<i>本局没打中过弱点</i>') + '</div>' +
    '<div class="rsec">补给</div><div class="rchain" style="color:#7ef0a8">' +
      (supply.join(' · ') || '<i>本局没用上</i>') + '</div>' +
    '<div class="rsec">普通改装</div><div class="rmods">' + (mods || '<i>无</i>') + '</div>' +
    '<div class="rseed">种子 ' + RNG.master + ' · 相同种子可复现本局抽卡与生成序列</div>' +
    '<div class="rbtns"><button onclick="location.reload()">再来一局</button>' +
    '<button onclick="location.search=\'?seed=' + RNG.master + '\'">用同种子重开</button></div>';
  el.classList.add('on');
}

/* ============================================================================
   调试面板 §36
   ========================================================================== */
function handleDebugKey(code) {
  const D = DebugPanel;
  if (code === 'F1') D.toggle();
  if (code === 'KeyG') D.god = !D.god;
  if (code === 'KeyL') { G.pendingLevels++; openModChoice(); }
  if (code === 'KeyM') { if (G.mutations.length < 4) openMutationChoice(); }
  if (code === 'KeyK') { G.enemies.live.forEach(e => { if (!e._dead && !e.boss) killEnemy(e, makeAttack('debug')); }); }
  if (code === 'Digit3') D.jump(180);
  if (code === 'Digit6') D.jump(360);
  if (code === 'Digit9') D.jump(540);
  if (code === 'Digit0') D.jump(719);
}

const DebugPanel = {
  el: null, god: false, showEvents: false, frames: 0, fpsT: 0, fps: 0,
  showWeak: false, noSpread: false, showDmg: false, rangeMode: false, _weakGizmos: null,
  init() {
    this.el = $('debug');
    if (BOOT.debug) this.el.classList.add('on');
    $('dbgbtns').innerHTML = [
      ['无敌 G', 'god'], ['升级 L', 'level'], ['变异 M', 'mut'], ['清怪 K', 'clear'],
      ['→3:00', 'j180'], ['→6:00', 'j360'], ['→9:00', 'j540'], ['→12:00', 'j719'],
      ['事件流', 'events'], ['重置种子', 'reseed'],
      ['医疗物', 'med'], ['充满空投', 'drop'],
      ['过载供弹', 'b_ammo'], ['肾上腺素', 'b_adren'], ['相位护盾', 'b_shield'],
      ['正后方刷怪', 'behind'],
      ['弱点球', 'weak'], ['无散布枪', 'nospread'], ['全部伤害数字', 'dmg'], ['靶场', 'range'],
      ['满弹', 'fullmag'], ['清空弹匣', 'emptymag'], ['立即换弹', 'doreload'],
      ['无限供弹', 'infammo'], ['相机后坐×0', 'camrec0'], ['相机后坐×1', 'camrec1'],
      ['枪感实验场', 'gunrange'], ['慢动作', 'slowmo']
    ].map(([t, a]) => '<button data-a="' + a + '">' + t + '</button>').join('');
    $('dbgbtns').onclick = e => {
      const a = e.target.dataset.a; if (!a) return;
      if (a === 'god') this.god = !this.god;
      else if (a === 'level') { G.pendingLevels++; openModChoice(); }
      else if (a === 'mut') { if (G.mutations.length < 4) openMutationChoice(); }
      else if (a === 'clear') G.enemies.live.forEach(x => { if (!x._dead && !x.boss) killEnemy(x, makeAttack('debug')); });
      else if (a === 'events') this.showEvents = !this.showEvents;
      else if (a === 'reseed') { RNG.resetAll(); this.log('种子通道已重置'); }
      else if (a === 'med') { G.medCooldown = 0; G.medPending = true; this.log('下一只非召唤物死亡将掉落医疗'); }
      else if (a === 'drop') { G.supplyCharge = 1; G.lastDropAt = -999; G.dropQueued = true; this.log('空投已排队'); }
      else if (a[0] === 'b' && a[1] === '_') { applyBuff(a.slice(2)); }
      else if (a === 'doreload') { G.player.gun.ammo = 0; G.player.gun.emptyT = 99; }
      else if (a === 'infammo') {
        if (G.buff && G.buff.id === 'ammo') { G.buff = null; recompute(); this.log('无限供弹 off'); }
        else { applyBuff('ammo'); G.buff.t = 9999; this.log('无限供弹 ON'); }
      }
      else if (a === 'slowmo') {
        BOOT.timescale = BOOT.timescale === 1 ? 0.15 : 1;
        this.log('时间倍率 ' + BOOT.timescale + ' —— 可逐帧看枪机/枪口/曳光/抛壳是否同帧');
      }
      else if (a === 'gunrange') {
        /* 枪感实验场：暂停刷怪，只留墙和静止靶（普通 / 弱点 / 护甲各一） */
        this.rangeMode = !this.rangeMode;
        G.enemies.live.forEach(x => { if (!x._dead && !x.dead) G.enemies.release(x); });
        G.enemies.compact();
        if (this.rangeMode) {
          const p = G.player;
          const targets = [
            { tpl: ENEMIES.grunt, off: -0.28, tag: '普通' },
            { tpl: ENEMIES.grunt, off: 0, tag: '弱点' },
            { tpl: G.variantTpl.ossify, off: 0.28, tag: '护甲' }
          ];
          targets.forEach(t => {
            const ang = p.yaw + Math.PI + t.off;
            const d = 13;
            const e = configureEnemy(G.enemies.get(), t.tpl,
              new THREE.Vector3(p.pos.x + Math.sin(ang) * d, 0, p.pos.z + Math.cos(ang) * d), { grace: 9999 });
            e.speed = 0; e.atk = 9999; e.maxHp = e.hp = 1e9;
            e.tpl = Object.assign({}, e.tpl, { ranged: null, charge: null });
          });
          G.player.gun.ammo = G.derived.magazine;
          this.log('实验场 ON：普通 / 弱点 / 护甲 三个静止靶，刷怪已暂停');
        } else this.log('实验场 OFF');
      }
      else if (a === 'fullmag') { G.player.gun.ammo = G.derived.magazine; G.player.gun.reloadT = 0; WEAPON.on('reloadEnd'); }
      else if (a === 'emptymag') { G.player.gun.ammo = 0; }
      else if (a === 'camrec0') { TUNE.WEAPON_FX.cameraRecoilScale = 0; TUNE.WEAPON_FX.cameraYawScale = 0; this.log('相机后坐已关闭（枪模仍然有力）'); }
      else if (a === 'camrec1') { TUNE.WEAPON_FX.cameraRecoilScale = 0.0075; TUNE.WEAPON_FX.cameraYawScale = 0.0022; this.log('相机后坐已恢复'); }
      else if (a === 'weak') { this.showWeak = !this.showWeak; this.log('弱点球 ' + (this.showWeak ? 'ON' : 'off')); }
      else if (a === 'nospread') { this.noSpread = !this.noSpread; this.log('无散布枪 ' + (this.noSpread ? 'ON' : 'off')); }
      else if (a === 'dmg') { this.showDmg = !this.showDmg; this.log('全部伤害数字 ' + (this.showDmg ? 'ON' : 'off')); }
      else if (a === 'range') {
        /* 静止靶场：每种敌人一只，不动不打人，用来验证弱点球对齐 */
        const p = G.player;
        ['grunt', 'heavy', 'spitter', 'charger', 'midboss'].forEach((k, n) => {
          const ang = p.yaw + Math.PI + (n - 2) * 0.22;
          const d = 14 + n * 1.5;
          const e = configureEnemy(G.enemies.get(), ENEMIES[k],
            new THREE.Vector3(p.pos.x + Math.sin(ang) * d, 0, p.pos.z + Math.cos(ang) * d), { grace: 9999 });
          e.speed = 0; e.atk = 9999; e.maxHp = e.hp = 1e7; e.tpl = Object.assign({}, e.tpl, { ranged: null, charge: null });
        });
        this.log('靶场已生成（静止、不攻击、高血量）');
      }
      else if (a === 'behind') {
        /* 正后方生成一只普通怪，验证完整提示链：接近预警 → 攻击预警 → 命中反馈 */
        const p = G.player;
        const ang = p.yaw;                      // yaw+PI 是正前方，所以 yaw 就是正后方
        const d = TUNE.THREAT.warnRange - 1;
        configureEnemy(G.enemies.get(), ENEMIES.grunt,
          new THREE.Vector3(p.pos.x + Math.sin(ang) * d, 0, p.pos.z + Math.cos(ang) * d), {});
        this.log('正后方 ' + d + 'm 生成普通丧尸');
      }
      else if (a[0] === 'j') this.jump(parseInt(a.slice(1), 10));
    };
    $('dbgvariant').innerHTML = MUTATIONS.map(m =>
      '<button data-v="' + m.id + '" style="color:' + m.css + '">' + m.name + '</button>').join('');
    $('dbgvariant').onclick = e => {
      const v = e.target.dataset.v; if (!v) return;
      configureEnemy(G.enemies.get(), G.variantTpl[v], spawnPosition(true), { highlight: 6 });
    };
  },
  toggle() { this.el.classList.toggle('on'); },
  /* 跳时间：把跳过的变异事件按 RNG 自动补齐，保证状态一致 */
  jump(t) {
    if (t <= G.time) return;
    G.time = t;
    TIMELINE.forEach((ev, i) => {
      if (ev.t <= t && i >= G.tlIndex && ev.kind === 'intro') G.introduced[ev.enemy] = true;
    });
    while (G.tlIndex < TIMELINE.length && TIMELINE[G.tlIndex].t <= t) {
      if (TIMELINE[G.tlIndex].kind === 'boss') break;
      G.tlIndex++;
    }
    while (G.mutIndex < TUNE.MUTATION_TIMES.length && TUNE.MUTATION_TIMES[G.mutIndex] <= t) {
      G.mutIndex++;
      const rem = MUTATIONS.filter(m => !G.mutationSet[m.id]);
      if (rem.length) {
        const pick = RNG.mutation.pick(rem);
        G.mutations.push(pick.id); G.mutationSet[pick.id] = true;
        R.setGunOrgan(pick.id, true);
        G.variantPool.push(pick.id);
      }
    }
    /* 补等级，让火力大致跟上时间点 */
    const wantLevel = Math.round(expectedLevel(t));
    while (G.player.level < wantLevel) {
      const avail = MODS.filter(modAvailable);
      if (!avail.length) break;
      const m = RNG.mods.pick(avail);
      G.mods[m.id] = (G.mods[m.id] || 0) + 1;
      G.player.level++;
    }
    recompute();
    G.player.gun.ammo = G.derived.magazine;
    UI.mutationSlots();
    this.log('跳转至 ' + fmtTime(t));
  },
  log(s) {
    const l = $('dbglog');
    l.innerHTML = '<div>' + s + '</div>' + l.innerHTML;
    if (l.children.length > 8) l.removeChild(l.lastChild);
  },
  /* 把每只敌人的弱点球画出来 —— 判据要求"弱点球与可见头部对齐"必须眼见为实 */
  updateWeakGizmos() {
    if (!this._weakGizmos) {
      this._weakGizmos = [];
      const geo = new THREE.SphereGeometry(1, 10, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd24a, wireframe: true, transparent: true, opacity: 0.75 });
      for (let i = 0; i < 40; i++) {
        const m = new THREE.Mesh(geo, mat); m.visible = false;
        R.scene.add(m); this._weakGizmos.push(m);
      }
    }
    let n = 0;
    if (this.showWeak) {
      const list = G.enemies.live;
      for (let i = 0; i < list.length && n < this._weakGizmos.length; i++) {
        const e = list[i];
        if (e._dead || e.dead || !e.weak) continue;
        const g = this._weakGizmos[n++];
        g.position.set(
          e.pos.x + e.face.x * e.weak.fwd * e.height,
          e.pos.y + e.weak.y * e.height,
          e.pos.z + e.face.z * e.weak.fwd * e.height);
        g.scale.setScalar(e.weak.r * e.height);
        g.visible = true;
      }
    }
    for (let i = n; i < this._weakGizmos.length; i++) this._weakGizmos[i].visible = false;
  },

  update(dt, raw) {
    this.frames++; this.fpsT += raw;
    this.updateWeakGizmos();
    if (this.fpsT >= 0.5) { this.fps = Math.round(this.frames / this.fpsT); this.frames = 0; this.fpsT = 0; }
    if (!this.el.classList.contains('on')) return;
    $('dbgstats').innerHTML =
      '<b>' + this.fps + '</b> fps &nbsp; 敌 <b>' + G.enemies.count + '</b>' +
      ' &nbsp; 弹 <b>' + G.bullets.count + '</b> &nbsp; 特效 <b>' +
      (R.rings.count + R.puffs.count + R.sparks.count + R.bolts.count) + '</b>' +
      ' &nbsp; 危险区 <b>' + G.hazards.count + '</b>' +
      '<br>期望 <b>' + expectedLevel(G.time).toFixed(1) + '</b> 实际 <b>' + G.player.level +
      '</b> 差 <b style="color:' + (Math.abs(expectedLevel(G.time) - G.player.level) > TUNE.PACING.deadband ? '#ffd06a' : '#7ef0a8') + '">' +
      (expectedLevel(G.time) - G.player.level).toFixed(1) + '</b>' +
      ' &nbsp; 需求倍率 <b>' + (G.pacingMult || 1).toFixed(2) + '</b>' +
      ' &nbsp; xp/s <b>' + (G.xpRate || 0).toFixed(1) + '</b>' +
      '<br>目标在场 <b>' + (Director.target || 0) + '</b> &nbsp; 刷怪间隔 <b>' + (Director.interval || 0).toFixed(2) + 's</b> &nbsp; 触发/帧 <b>' + G.procThisFrame + '</b> &nbsp; 深度上限 <b>' + G.derived.maxDepth + '</b>' +
      ' &nbsp; 经验球 <b>' + G.xp.length + '</b>' +
      '<br>医疗need <b>' + G.medNeed.toFixed(1) + '/' + TUNE.MEDICAL.needThreshold + '</b>' +
      ' 冷却 <b>' + Math.max(0, G.medCooldown).toFixed(0) + 's</b>' +
      ' 场上 <b>' + (G.medical ? 'Y' : '-') + '</b>' + (G.medPending ? ' <b style="color:#3ad07a">待掉落</b>' : '') +
      '<br>空投 <b>' + Math.round(G.supplyCharge * 100) + '%</b>' +
      ' 距上次 <b>' + (G.time - G.lastDropAt).toFixed(0) + 's</b>' +
      ' 次数 <b>' + (G.dropCount || 0) + '</b>' + (G.dropQueued ? ' <b style="color:#5fe0ff">排队中</b>' : '') +
      ' Buff <b>' + (G.buff ? G.buff.id + ' ' + G.buff.t.toFixed(1) + 's' : '-') + '</b>' +
      '<br>枪械 kick <b>' + WEAPON.kickZ.x.toFixed(3) + '</b>' +
      ' climb <b>' + WEAPON.climb.toFixed(3) + '</b>' +
      ' bolt <b>' + (WEAPON.boltLocked ? 'LOCK' : WEAPON.boltSpring.x.toFixed(3)) + '</b>' +
      ' reload <b>' + (WEAPON.reload.active ? 'P' + WEAPON.reload.phase : '-') + '</b>' +
      ' ads <b>' + WEAPON.pose.ads.toFixed(2) + '</b>' +
      '<br>曳光 <b>' + WEAPON.stats.tracers + '</b> 弹壳 <b>' + WEAPON.stats.shells + '</b>' +
      '<br>弱点命中 <b style="color:#ffd24a">' + (G.stats.weakHits || 0) + '</b>' +
      ' 弱点击杀 <b style="color:#ff9a4a">' + (G.stats.weakKills || 0) + '</b>' +
      ' 命中 <b>' + G.stats.hits + '</b>' +
      ' 爆头率 <b>' + (G.stats.hits ? Math.round((G.stats.weakHits || 0) / G.stats.hits * 100) : 0) + '%</b>' +
      '<br>受伤 <b>' + G.hurtCount + '</b> 次  近战落空 <b>' + G.meleeWhiffs + '</b> 次' +
      ' &nbsp; 威胁扇区 <b>' + (UI._sectorScore ? Array.prototype.slice.call(UI._sectorScore)
        .map((v, i) => ({ v: v, i: i })).sort((a, b) => b.v - a.v).slice(0, 3)
        .filter(x => x.v > 0.01).map(x => x.i + ':' + x.v.toFixed(1)).join(' ') || '-' : '-') + '</b>' +
      '<br>变种占比 <b>' + Math.round(Math.min(TUNE.VARIANT.cap, G.variantPool.length * TUNE.VARIANT.perMutation) * 100) + '%</b>' +
      ' &nbsp; 超频 <b>' + Math.round(G.overclock * 100) + '%</b>' +
      ' &nbsp; 电导 <b>' + G.conductCounter + '/6</b>' +
      '<br>无敌 <b style="color:' + (this.god ? '#7ef0a8' : '#8899aa') + '">' + (this.god ? 'ON' : 'off') + '</b>' +
      ' &nbsp; 种子 <b>' + RNG.master + '</b>';
  }
};
Object.defineProperty(G.hazards, 'count', { get() { return this.length; } });

/* ============================================================================
   启动与主循环
   ========================================================================== */
function boot() {
  RNG.init(BOOT.seed);
  R.init($('gl'));
  WEAPON.build(R.gunScene, R.geo);
  UI.init();

  G.player = makePlayer();
  if (MODE.vertMove) MOVE.init(G.player);
  G.enemies = makeEnemyPool();
  G.bullets = makeBulletPool();
  G.acids = makeAcidPool();
  G.variantTpl = {};
  MUTATIONS.forEach(m => { G.variantTpl[m.id] = variantTemplate(m.id); });
  G.tutorialQueue = [];
  G.pendingLevels = 0;
  G.mutIndex = 0; G.tlIndex = 0;
  /* EMA 预置成目标节奏，避免开局冷启动时需求算得离谱 */
  G.xpRate = TUNE.PACING.bootstrapXp / TUNE.PACING.firstLevelAt;
  G.xpFrame = 0; G.pacingMult = 1;
  G.bossAlive = null; G.surge = false; G.bossSpawnAt = -999;
  G.dropCount = 0; G.lastDropAt = 0; G.supplyCharge = 0; G.dropQueued = false;
  G.medNeed = 0; G.medCooldown = 0; G.medPending = false; G.medical = null;
  G.buff = null; G.meleeWhiffs = 0; G.hurtCount = 0;
  G.mouseDX = 0; G.mouseDY = 0;

  recompute();
  emitBuildChanged();
  installPlayerMutations();
  installHordeMutations();
  UI.mutationSlots();
  DebugPanel.init();

  /* 开场少量普通丧尸，20 秒内建立移动/射击/经验反馈 §28 */
  for (let i = 0; i < 5; i++) configureEnemy(G.enemies.get(), ENEMIES.grunt, spawnPosition(false));

  $('start').onclick = () => {
    Audio2.init(); Audio2.resume();
    $('menu').classList.remove('on');
    G.phase = 'play';
    R.renderer.domElement.requestPointerLock();
    last = performance.now();
    requestAnimationFrame(frame);
  };
  $('seedlabel').textContent = '种子 ' + BOOT.seed;
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== R.renderer.domElement && G.phase === 'play' && !G.over) {
      G.paused = true; $('pause').classList.add('on');
    }
  });
  /* 浏览器可能拒绝紧跟在 exitPointerLock 之后的重新锁定 —— 点画面即可恢复 */
  R.renderer.domElement.addEventListener('click', () => {
    if (G.phase === 'play' && !G.paused && !G.over &&
      document.pointerLockElement !== R.renderer.domElement) {
      R.renderer.domElement.requestPointerLock();
    }
  });
  $('resume').onclick = () => { G.paused = false; $('pause').classList.remove('on'); R.renderer.domElement.requestPointerLock(); };

  R.render();
}

let last = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.min(0.05, (now - last) / 1000);
  last = now;

  const active = G.phase === 'play' && !G.paused && !G.over;
  const dt = raw * BOOT.timescale;

  if (active) {
    G.time += dt;
    G.procThisFrame = 0;

    /* 空间哈希每帧重建 §35 */
    G.hash.clear();
    const el = G.enemies.live;
    for (let i = 0; i < el.length; i++) if (!el[i]._dead && !el[i].dead) G.hash.insert(el[i], el[i].pos.x, el[i].pos.z);

    updateTimeline(dt);
    if (G.phase === 'play') {
      Director.update(dt);
      updatePlayer(dt);
      updateBullets(dt);
      updateEnemies(dt);
      updateAcids(dt);
      updatePendings(dt);
      updateHazards(dt);
      updateXp(dt);
      trackXpRate(dt);
      updateMedical(dt);
      updateAirdrop(dt);
      updateBuff(dt);
      runTutorialQueue(dt);
      updateShake(dt);
      if (DebugPanel.god) G.player.hp = G.player.maxHp;
      if (G.time >= TUNE.RUN_SECONDS && !G.bossAlive && G.tlIndex >= TIMELINE.length) { /* Boss 已死由 retireEnemy 触发胜利 */ }
    }
  } else if (G.phase === 'choose') {
    /* §11.3 升级界面出现时游戏完全暂停 */
    updateShake(raw * 0.4);
  }

  /* 子弹与酸液的实例矩阵 */
  syncInstances();
  R.updateFx(active ? dt : 0);
  UI.update(raw);
  DebugPanel.update(dt, raw);
  R.render();
}

const _im = new THREE.Matrix4(), _iq = new THREE.Quaternion(), _is = new THREE.Vector3();
function syncInstances() {
  let a = 0, b = 0;
  const list = G.bullets.live;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p._dead) continue;
    _is.set(p.scale, p.scale, p.scale * 2.6);
    _iq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), p.dir);
    _im.compose(p.pos, _iq, _is);
    if (p.split) { if (b < 192) R.splitMesh.setMatrixAt(b++, _im); }
    else { if (a < 320) R.bulletMesh.setMatrixAt(a++, _im); }
  }
  R.bulletMesh.count = a; R.bulletMesh.instanceMatrix.needsUpdate = true;
  R.splitMesh.count = b; R.splitMesh.instanceMatrix.needsUpdate = true;

  let c = 0;
  const al = G.acids.live;
  _iq.identity(); _is.set(1, 1, 1);
  for (let i = 0; i < al.length; i++) {
    const p = al[i];
    if (p._dead || c >= 64) continue;
    _im.compose(p.pos, _iq, _is);
    R.acidMesh.setMatrixAt(c++, _im);
  }
  R.acidMesh.count = c; R.acidMesh.instanceMatrix.needsUpdate = true;
}

addEventListener('load', boot);
