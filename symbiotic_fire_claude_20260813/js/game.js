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
   地图与构筑：只有一套。

   todo3 的平面/立体双地图、todo4 的三个回退入口、todo5 的新旧 Build 开关
   全部删除 —— 冗余的分支不是安全网，它只是让每一处改动都要维护两遍。
   现在：城市尺度地图 + 可组合武器模块，没有第二条路径。
   ========================================================================== */

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
  /* 池化对象必须清干净上一位住客的导航状态，否则会带着旧区域与旧连接边复活 */
  if (e.nav) {
    e.nav.region = null; e.nav.link = null; e.nav.linkT = 0; e.nav.repath = 0;
    e.nav.stuck = 0; e.nav.vy = 0; e.nav.grounded = true; e.nav.recover = 0; e.nav.falling = false;
  }
  e.leapAt = null; e.leapVel = null; e.markedElite = false; e.boneMark = 0; e.boneMarkCtx = null;
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
     几何验证在 CITYSCALE.buildSpawnPoints 一次性做完，热路径只做距离与视线判断。 */
  if (CITY.enabled) {
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
  /* M3 / todo6 §6：玩家高速跨越单元时，目标单元前方要补压力。
     不补的话，新机动带来的直接后果就是「一转场就没怪打」——
     机动越强，游戏越空。 */
  trail: [], transferCd: 0,
  _transfer(dt) {
    const L = TUNE.LAYER_PLAY, p = G.player;
    this.transferCd -= dt;
    this.trail.push({ t: G.time, x: p.pos.x, z: p.pos.z });
    while (this.trail.length && G.time - this.trail[0].t > L.transferWindow) this.trail.shift();
    if (this.transferCd > 0 || this.trail.length < 2) return;
    const a = this.trail[0];
    const dx = p.pos.x - a.x, dz = p.pos.z - a.z;
    if (Math.hypot(dx, dz) < L.transferDist) return;
    /* 沿移动方向的前方补人：用既有的正面刷怪路径，不另造一套生成器 */
    this.transferCd = L.transferWindow * 2;
    const saveYaw = p.yaw;
    p.yaw = Math.atan2(dx, dz) + Math.PI;          // 让 spawnPosition 的"正面"对上移动方向
    for (let i = 0; i < L.transferAhead; i++) {
      const pos = spawnPosition(true);
      if (pos) configureEnemy(G.enemies.get(), this.pickTemplate(), pos, { grace: 0.8 });
    }
    p.yaw = saveYaw;
    G.stats.transfers = (G.stats.transfers || 0) + 1;
  },

  update(dt) {
    if (DebugPanel.rangeMode) return;              // 枪感实验场：暂停刷怪
    if (DebugPanel.freezeEnemies) return;         // §11.1 单独冻结敌人
    if (G.bossAlive && G.bossAlive.king) return;   // 尸王阶段停常规刷怪，避免不可读
    const t = G.time, S = TUNE.SPAWN;
    const k = Math.min(1, t / TUNE.RUN_SECONDS);
    this._transfer(dt);

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
    /* §5.4 防站桩：压力阶段会顶掉一次常规抽取，逐级换成攀爬 / 跳跃 / 远程 */
    let tpl = null;
    if (NAV.camp.stage > 0 && RNG.spawn.chance(0.20 + NAV.camp.stage * 0.12)) {
      tpl = NAV.campTemplate();
    }
    if (!tpl) tpl = this.pickTemplate();
    /* 远程感染者优先占据相邻屋顶或高台（§5.1） */
    const want = tpl.navKind === 'ranged'
      ? (RNG.spawn.chance(0.7) ? 'roof' : 'mid') : null;
    const pos = spawnPosition(false, want);
    if (!pos) return;
    configureEnemy(G.enemies.get(), tpl, pos);
  },
  /* §26 变异敌人总占比 = 已选变异数 × 8%，上限 32%；巨化权重 0.5 */
  pickTemplate() {
    const t = G.time;
    /* 基础组成：随时间引入 heavy / spitter；立体模式再叠三类垂直威胁。
       §5.3 不为展示新系统而无脑增加总怪量 —— 目标在场数逻辑保持不变，
       这里只改变“这一只是什么”，不改变“刷几只”。 */
    const pool = [ENEMIES.grunt], w = [1];
    if (G.introduced.heavy) { pool.push(ENEMIES.heavy); w.push(0.16); }
    if (G.introduced.spitter) { pool.push(ENEMIES.spitter); w.push(0.20); }
    {
      const early = G.time < 180;
      if (G.introduced.climber) { pool.push(ENEMIES.climber); w.push(early ? 0.07 : 0.30); }
      if (G.introduced.leaper) { pool.push(ENEMIES.leaper); w.push(0.18); }
      if (G.introduced.roofcaster) { pool.push(ENEMIES.roofcaster); w.push(0.14); }
    }
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

    /* 立体导航接管：跨层时走连接边，同层时交还给下面的二维追击（§5.2）。
       Boss 不参与分层导航 —— 它们只在街道层活动，行为由 updateBoss 负责。 */
    if (!e.boss && NAV.update(e, dt)) continue;

    const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z;
    const dy = p.pos.y - e.pos.y;
    const distSq = dx * dx + dz * dz;
    const dist = Math.sqrt(distSq);
    const sameFloor = Math.abs(dy) < 2.4;
    const nx = dist > 1e-4 ? dx / dist : 0, nz = dist > 1e-4 ? dz / dist : 1;
    e.face.set(nx, 0, nz);

    let moveX = nx, moveZ = nz, speed = e.speed;
    e.stateT -= dt; e.cd -= dt; e.atkT -= dt;

    /* todo5 §9：超频尸的加速过程必须【看得见】，并且存在失速窗口。
       原实现只是把 speedMult 常驻乘上去，玩家既看不到它在加速，
       也永远等不到一个可以反打的空档 —— 那只是一只更快的普通丧尸。
       现在改成「蓄速 → 冲刺 → 失速」的循环，失速期明显变慢且发光熄灭。 */
    if (e.variant === 'overclock' && !e.boss) {
      const OC = TUNE.HORDE_OVERCLOCK;
      e.ocT = (e.ocT || 0) + dt;
      const cycle = OC.rampTime + OC.runTime + OC.stallTime;
      const ph = e.ocT % cycle;
      if (ph < OC.rampTime) e.ocK = ph / OC.rampTime;               // 蓄速：越来越快
      else if (ph < OC.rampTime + OC.runTime) e.ocK = 1;            // 全速冲刺
      else e.ocK = -1;                                              // 失速窗口
      speed *= e.ocK < 0 ? OC.stallMult : (1 + (OC.peakMult - 1) * e.ocK);
      /* 发光强度跟着速度走：这是玩家判断「现在能不能反打」的唯一依据 */
      if (e.hurtFlash <= 0) {
        e.bodyMat.emissive.setHex(MUT.overclock.color);
        e.bodyMat.emissiveIntensity = e.ocK < 0 ? 0.02 : 0.10 + e.ocK * 0.55;
      }
    }

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
    } else if (e.tpl.leap) {
      /* 跳跃感染者 §5.1：起跳前显示姿态、声音与落点预警；
         扑击失败后有可惩罚窗口；绝不从玩家看不见的位置无提示瞬移过来。 */
      const lp = e.tpl.leap;
      if (e.state === 'walk' && dist < lp.range && dist > 3.0 && e.cd <= 0 && e.spawnGrace <= 0) {
        e.state = 'leapwind'; e.stateT = lp.windup;
        e.leapAt = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
        Audio2.telegraph(e.pos, 'charge');
        /* 落点预警圈：从高处扑下来时玩家必须能读到落点（§8.2） */
        const z = R.zones.get();
        z.mesh.position.set(p.pos.x, p.pos.y + 0.06, p.pos.z);
        z.mesh.scale.setScalar(2.4);
        z.mesh.material.color.setHex(0xe0c08a); z.mesh.material.opacity = 0.2; z.mesh.visible = true;
        z.rim.position.copy(z.mesh.position); z.rim.scale.setScalar(2.4);
        z.rim.material.color.setHex(0xe0c08a); z.rim.material.opacity = 0.9; z.rim.visible = true;
        G.hazards.push({ zone: z, t: 0, dur: lp.windup, kind: 'fuse', blink: true });
      } else if (e.state === 'leapwind') {
        speed = 0;
        if (e.stateT <= 0) {
          e.state = 'leap'; e.stateT = 1.3;
          const ddx = e.leapAt.x - e.pos.x, ddz = e.leapAt.z - e.pos.z;
          const dd = Math.max(1e-3, Math.hypot(ddx, ddz));
          const tt = dd / lp.speed;
          e.leapVel = { x: ddx / tt, z: ddz / tt, y: (e.leapAt.y - e.pos.y) / tt + 0.5 * TUNE.MOVEMENT.gravity * tt };
        }
      } else if (e.state === 'leap') {
        speed = 0; moveX = 0; moveZ = 0;
        e.leapVel.y -= TUNE.MOVEMENT.gravity * dt;
        e.pos.x += e.leapVel.x * dt; e.pos.y += e.leapVel.y * dt; e.pos.z += e.leapVel.z * dt;
        if (dist < e.radius + p.radius + 0.9 && Math.abs(dy) < 2.0) {
          hurtPlayer(lp.dmg * G.dmgScale(), e.pos, 'charge');
          e.state = 'leaprec'; e.stateT = lp.recover; e.cd = lp.cooldown;
        }
        const gy = CITY.enabled ? CITY.dropTo(e.pos.x, e.pos.z, e.pos.y + 0.4, e.radius) : 0;
        if (e.pos.y <= gy || e.stateT <= 0) {
          e.pos.y = Math.max(gy, e.pos.y);
          e.state = 'leaprec'; e.stateT = lp.recover; e.cd = lp.cooldown;
          if (e.nav) { e.nav.region = null; e.nav.vy = 0; }
          R.puff(TV.copy(e.pos), 0.2, 1.5, 0xe0c08a, 0.22);
        }
      } else if (e.state === 'leaprec') {
        speed = 0;                                   // 可惩罚窗口
        if (e.stateT <= 0) e.state = 'walk';
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

    /* 近战三阶段：接触不再直接扣血，必须先走一段前摇（todo.md 阶段二）。
       立体模式下还必须同层 —— 否则楼下的怪会隔着一层楼板打到玩家。 */
    if (!e.tpl.ranged && !e.tpl.leap && !e.boss && e.state !== 'windup' && e.state !== 'charge') {
      const reach = e.radius + p.radius + 0.55;   // 必须大于 stopDist，否则永远够不到
      if (e.state === 'melee') {
        speed = 0;                                   // 前摇期间停住，动作可读
        if (e.stateT <= 0) {
          /* 前摇结束重新检查距离：玩家已经离开就落空 */
          if (dist < reach + 0.35 && Math.abs(p.pos.y - e.pos.y) < 2.4) hurtPlayer(e.dmg, e.pos, 'melee');
          else G.meleeWhiffs++;
          e.state = 'walk'; e.atkT = e.atk;
        }
      } else if (dist < reach && sameFloor && e.atkT <= 0 && e.spawnGrace <= 0) {
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
    R.collide(e.pos, e.radius, e.pos.y + 0.25, e.pos.y + e.height);
    /* 同层追击也要吃重力与地面判定：走下平台边缘要掉下去，不能悬空 */
    if (!e.boss && e.state !== 'leap') NAV.stepPhysics(e, dt);

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

    /* 教学高亮 §13.3
       highlight 不等于「一定是变种」：todo3 §7.8 的跨层精英标记会给普通怪打
       highlight，Debug 面板生成攀爬/跳跃/远程怪时也会。
       原实现直接取 MUT[e.variant].color —— variant 为 null 时 MUT[null] 是 undefined，
       于是每帧在这里抛异常，updateEnemies 之后的 R.render() 再也执行不到：
       开枪、音效、相机全部正常，唯独画面不刷新，直到 highlight 递减到 0 才恢复。 */
    if (e.highlight > 0) {
      e.highlight -= dt;
      const f = Math.sin(G.time * 8) * 0.5 + 0.5;
      const hl = e.variant ? MUT[e.variant].color : (e.markedElite ? 0xffc14d : 0xffffff);
      e.bodyMat.emissive.setHex(hl);
      e.bodyMat.emissiveIntensity = 0.3 + f * 0.7;
      if (e.highlight <= 0) {
        e.bodyMat.emissiveIntensity = e.variant ? 0.16 : 0;
        if (!e.variant) e.bodyMat.emissive.setHex(0x000000);
      }
    }
  }
  G.enemies.compact();
}

function retireEnemy(e) {
  /* 掉经验 §11.3 —— 幼体与召唤物不掉 §17 */
  if (e.xp > 0) dropXp(e.pos, e.xp);
  if (e.nav) { e.nav.region = null; e.nav.link = null; }
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
    const gy = CITY.enabled ? CITY.dropTo(a.pos.x, a.pos.z, a.pos.y + 0.3, 0.4) : 0;
    if (a.pos.y <= gy + 0.1 || a.life <= 0) {
      /* 落地生成酸池 —— 玩家可以走开，不要求跳跃 §11.2。
         立体地图下必须落在实际支撑面上，否则酸池会飘在半空或穿进楼板。 */
      const z = R.zones.get();
      z.mesh.position.set(a.pos.x, gy + 0.04, a.pos.z);
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
/* 尸王按玩家的构筑逐阶段点亮能力。玩家侧现在是可组合模块，
   所以这里把模块映射成同主题的变体（HORDE.MODULE_VARIANT）——
   齐射/弹射/动势在 todo5 §9 里刻意没有对应怪物，自然被过滤掉。 */
function playerThemes() {
  const out = [];
  WMOD.own.forEach(m => {
    const v = HORDE.MODULE_VARIANT[m];
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

function updateBoss(e, dt, dist, nx, nz) {
  e.mvx = nx; e.mvz = nz; e.mvs = e.speed;

  if (e.king) {
    const frac = e.hp / e.maxHp;
    const want = frac > 0.75 ? 1 : frac > 0.5 ? 2 : frac > 0.25 ? 3 : 4;
    const themes = playerThemes();
    const target = Math.min(want, themes.length);
    if (target > e.phase) {
      e.phase = target;
      e.phaseT = 1.5;
      const id = themes[e.phase - 1];
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
  const active = playerThemes().slice(0, e.phase);
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
  /* M3：地面经验收益最高，让玩家有理由主动回到危险区域（todo4 §6 / todo6 §6）。
     不是「屋顶不掉经验」——那会变成惩罚；是屋顶打折，让登高成为取舍。 */
  if (CITY.enabled) {
    const L = TUNE.LAYER_PLAY, lay = CITY.layerOf(pos.y);
    value *= lay === 'roof' ? L.xpRoof : lay === 'mid' ? L.xpMid : L.xpStreet;
    value *= MAPEV.xpBonus(pos.x, pos.z);          // M4：热点内收益更高
  }
  /* §6.1 经验球记录所在高度，且绝不能停在墙面、空中或封闭模型内部 */
  let y = 0.42, base = 0;
  if (CITY.enabled) {
    base = CITY.dropTo(pos.x, pos.z, pos.y + 0.5, 0.35);
    y = base + 0.42;
  }
  G.xp.push({ x: pos.x, y: y, z: pos.z, base: base, v: value, t: 0, home: false,
    layer: CITY.enabled ? CITY.layerOf(base) : 'street', leftT: 0, bob: RNG.fx.range(0, 6.28) });
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
    const dy = (p.pos.y + 0.9) - c.y;
    const d = Math.hypot(dx, dz);
    const d3 = Math.hypot(dx, dy, dz);

    /* §6.1 玩家离开经验所在层后，短暂延迟自动进入跨层追踪，
       否则经验会大量永久滞留在回不去的下层。 */
    if (CITY.enabled && !c.home) {
      const sameLayer = CITY.layerOf(p.pos.y) === c.layer;
      if (!sameLayer) { c.leftT += dt; if (c.leftT > TUNE.XP.crossLayerDelay) c.home = true; }
      else c.leftT = 0;
    }
    if (!c.home && (d < magnet || c.t > TUNE.XP.autoHomeAfter)) c.home = true;
    if (c.home) {
      /* 跨层吸附可以穿过建筑几何，但必须快速、清楚，不长时间绕路 */
      const sp = TUNE.XP.flySpeed * (1 + Math.max(0, 3 - d3)) * (Math.abs(dy) > 2 ? 1.6 : 1);
      c.x += dx / Math.max(d3, 0.01) * sp * dt;
      c.z += dz / Math.max(d3, 0.01) * sp * dt;
      c.y += dy / Math.max(d3, 0.01) * sp * dt;
      G.stats.crossLayerPulls = (G.stats.crossLayerPulls || 0) + (Math.abs(dy) > 2 ? dt : 0);
    } else {
      c.y = c.base + 0.42 + Math.sin(G.time * 3 + c.bob) * 0.09;
    }
    if (d3 < pick) { gainXp(c.v); G.xp.splice(i, 1); continue; }
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
  G.xpFrame += v;
  /* §4.2 统一进化：等级与“弹一次选择”彻底解耦。
     经验只推进进化进度，什么时候弹界面由 EVO 的节奏与安全窗口决定，
     溢出进入下一段进度，绝不连弹多张界面。 */
  EVO.addProgress(v); return;

  p.xp += v;
  let guard = 0;
  while (p.xp >= p.xpNext && guard++ < 12) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = nextRequirement();
    G.pendingLevels++;
  }
}

/* ============================================================================
   补给：自适应医疗掉落 + 半动态战术空投（todo.md P0 / P1）
   两个系统职责不同：医疗是逆风兜底，空投是高频短时爽点 + 逼玩家改变路线。
   ========================================================================== */

/* ---- 医疗掉落 ---- */
G.spawnMedical = function (atPos) {
  const M = TUNE.MEDICAL;
  const pos = atPos.clone();
  R.collide(pos, 0.6, pos.y + 0.2, pos.y + 1.6);   // 掉在尸体位置，但不能卡进柱子里拿不到
  /* §6.2 立体地图下必须验证落点可达且可站立；站不住就顺到最近的合法落脚面 */
  if (CITY.enabled) {
    pos.y = CITY.dropTo(pos.x, pos.z, pos.y + 0.6, 0.6);
    if (!CITY.standable(pos.x, pos.z, pos.y + 0.2, 0.6)) {
      const s = CITY.spawnPoints.length ? CITY.spawnPoints[RNG.event.int(CITY.spawnPoints.length)] : null;
      if (s) { pos.set(s.x, s.y, s.z); } else { G.stats.unreachable = (G.stats.unreachable || 0) + 1; }
    }
  }
  G.medical = { x: pos.x, y: pos.y, z: pos.z, t: 0, life: M.lifetime };
  G.medNeed = 0;
  G.medCooldown = M.cooldown;
  R.medMesh.position.set(pos.x, pos.y, pos.z);
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
  if (Math.hypot(p.pos.x - m.x, p.pos.z - m.z) < M.pickupRadius
      && (!CITY.enabled || Math.abs(p.pos.y - (m.y || 0)) < 2.4)) {
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
    /* §6.3 / §4.1：箱内 Buff 在坠落时就公布，玩家在接近前判断值不值得冒险；
       开箱直接生效，不再弹空投三选一。 */
    const buffId = RNG.event.pick(['ammo', 'adren', 'shield']);
    G.airdrop = { x: pos.x, y: pos.y || 0, z: pos.z, state: 'falling', t: 0,
                  telegraph: A.telegraph, life: A.lifetime, modules: null, buff: buffId };
    R.podMesh.position.set(pos.x, (pos.y || 0) + 26, pos.z);
    R.podMesh.visible = true;
    Audio2.airdropIncoming();
    const layerTag = CITY.enabled ? ({ street: '街道', mid: '中层', roof: '屋顶' })[CITY.layerOf(pos.y || 0)] : '';
    G.ui.toast('补给舱：' + BUFF_NAME[buffId] + (layerTag ? '（' + layerTag + '）' : ''), BUFF_CSS[buffId]);
  }

  const d = G.airdrop;
  if (!d) return;
  d.t += dt;

  if (d.state === 'falling') {
    const k = Math.min(1, d.t / d.telegraph);
    R.podMesh.position.y = lerp(d.y + 26, d.y, k * k);
    if (d.t >= d.telegraph) {
      d.state = 'open'; d.t = 0;
      R.podMesh.position.y = d.y;
      R.ring(TV.set(d.x, d.y, d.z), 0.5, 5, 0x5fe0ff, 0.6);
      G.shake(0.18, TV.set(d.x, d.y, d.z));
      Audio2.blast(TV.set(d.x, d.y, d.z), false);
      /* 只放一个模块，就是坠落时已经公布的那个 */
      const idx = ['ammo', 'adren', 'shield'].indexOf(d.buff);
      const g = R.moduleMeshes[Math.max(0, idx)];
      g.position.set(d.x, d.y, d.z); g.visible = true;
      d.modules = [{ id: d.buff, x: d.x, y: d.y, z: d.z, mesh: g }];
    }
    return;
  }

  if (d.t >= d.life) { clearAirdrop(); return; }
  const rem = d.life - d.t;
  for (let n = 0; n < d.modules.length; n++) {
    const m = d.modules[n];
    m.mesh.userData.spin.rotation.y += dt * 1.8;
    m.mesh.visible = rem > 5 ? true : (Math.sin(d.t * 16) > -0.3);
    if (Math.hypot(p.pos.x - m.x, p.pos.z - m.z) < A.pickupRadius
        && (!CITY.enabled || Math.abs(p.pos.y - (m.y || 0)) < 2.4)) {
      applyBuff(m.id);              // 开箱直接生效，不弹第二套选择
      /* §7.8 高风险屋顶空投额外提高下一次进化的史诗概率 */
      G.bus.emit('airdropOpened', { id: m.id, y: m.y || 0 });
      clearAirdrop();
      return;
    }
  }
  R.podMesh.visible = rem > 5 ? true : (Math.sin(d.t * 16) > -0.3);
}

/* §6.3 空投落点：覆盖三层，且必须存在至少两种到达方式；
   绝不能穿过屋顶落进建筑模型内部。 */
function airdropPositionCity() {
  const A = TUNE.AIRDROP, p = G.player;
  const cands = [];
  for (let i = 0; i < 40; i++) {
    const s = CITY.spawnPoints[RNG.event.int(CITY.spawnPoints.length)];
    if (!s) continue;
    const dist = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
    if (dist < A.minDist * 0.7 || dist > 40) continue;
    /* 落点上方必须是通的，否则舱体会穿进楼板 */
    if (CITY.dropTo(s.x, s.z, s.y + 24, 1.0) > s.y + 0.4) continue;
    if (!CITY.standable(s.x, s.z, s.y + 0.2, 1.0)) continue;
    const region = CITY.regionAt(s.x, s.y, s.z);
    const outs = region ? CITY.links.filter(l => l.to === region.id).length : 0;
    if (outs < 2) continue;                      // 至少两种到达方式
    /* “前方可争取、但不是脚边白送” */
    cands.push({ s: s, score: -Math.abs(dist - 26) + (s.layer !== 'street' ? 4 : 0) + RNG.event.range(0, 5) });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const s = cands[0].s;
  return TV.set(s.x, s.y, s.z).clone();
}

function airdropPosition() {
  const A = TUNE.AIRDROP, p = G.player;
  if (CITY.enabled) {
    const c = airdropPositionCity();
    if (c) return c;
  }
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

/* 构筑变化 → 枪械外观。§11 要求模块看得出来，所以弹匣、双管、单发重量
   全部由当前模块推导，而不是由某几张改装卡的等级推导。 */
function emitBuildChanged() {
  WEAPON.on('buildChanged', {
    twin: G.derived.pellets > 1,
    magLevel: lvl('mag') + (WMOD.has('overclock') ? 1 : 0),
    heavy: G.derived.weaponHeavy,
    modules: WMOD.own.slice()
  });
}

/* ============================================================================
   选择界面：只有统一进化三选一（evolution-director.js）。
   todo3 §4.2 之后，旧的「等级三选一 + 四次病毒事件」两套弹窗已经作废；
   这里不再保留它们的入口 —— 两套并存只会让节奏与保底各算各的。
   ========================================================================== */

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
  if (e.code === 'Space') MOVE.onJump();
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
  WMOD.oc.ramp *= TUNE.MODULES.overclock.reloadKeep;
  /* 分阶段动作与声音由表现层按 total 的比例驱动，
     所以快速装填升级会同比例加速整套流程，不会动作与计时错位 */
  WEAPON.on('reloadStart', { total: g.reloadTotal });
  G.bus.emit('reload', {});
}

function tryDash() {
  const p = G.player;
  MOVE.onDash(); return;   // 充能与无敌帧的核对在 movement.js
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

  /* 移动：城市地图只有 movement.js 这一套状态机 */
  MOVE.update(dt, p);

  /* 换弹推进：弹量在 magIn 恢复，但要到 reloadEnd 才允许射击 */
  if (g.reloadT > 0) {
    g.reloadT -= dt;
    if (g.reloadT <= 0) { g.reloadT = 0; WEAPON.on('reloadEnd'); G.bus.emit('reloadDone', {}); }
  }

  /* todo5：模块状态机（超频升速 / 动势积蓄 / 过热）统一在这里推进。
     §6.1 第 7 条 —— 超频只改发射节奏，所以它没有资格进入伤害结算链。 */
  WMOD.tick(dt, {
    firing: g.held && g.ammo > 0 && g.reloadT <= 0,
    speed: Math.hypot(p.vel.x, p.vel.z)
  });

  /* 射击 §11.3 —— 弹匣打空后自动换弹，但先留一个可感知的空仓瞬间（todo2 §6.2） */
  g.fireT -= dt;
  g.dryT -= dt;
  /* 传奇「弹匣规则改写」：不再消耗弹匣，改为过热节奏 —— 过热期间强制停火 */
  const heatLock = WMOD.hasRule('r_mag') && WMOD.overheated > 0;
  if (g.reloadT <= 0 && G.phase === 'play' && !heatLock) {
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
  const grounded = MOVE.pose.grounded;
  /* 空中不做步态晃动 —— 跑酷中再叠 bob 会直接读不清准星（§8.4） */
  const bob = Math.sin(p.bobT * 2) * 0.022 * Math.min(1, speed / 6) * (grounded ? 1 : 0.15);
  /* 眼高 = 脚底 + 身高；滑铲下蹲与落地压缩只动高度，不动朝向 */
  const eye = TUNE.PLAYER.height
    - MOVE.pose.crouch * (TUNE.PLAYER.height - TUNE.MOVEMENT.slideHeight)
    - MOVE.pose.landImpact * 0.16;
  R.camera.position.set(p.pos.x, p.pos.y + eye + bob, p.pos.z);
  R.camera.rotation.set(0, 0, 0);
  R.camera.rotateY(p.yaw + p.camRecoil.yaw);
  R.camera.rotateX(p.pitch + p.camRecoil.pitch + G.shakePitch);
  R.camera.rotateZ(G.shakeRoll + MOVE.pose.tilt);
  R.camera.position.x += G.shakeX; R.camera.position.z += G.shakeZ;

  /* 速度用 FOV 表达，不用随机抖动 */
  const fastK = clamp((speed - 7) / 9, 0, 1);
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
    /* todo5 §11：枪模上的两条发光通道改由模块驱动 ——
       升速看得见（超频），蓄能看得见（动势）。 */
    overclock: WMOD.oc.ramp,
    conductCharge: Math.max(WMOD.mom.charge, WMOD.mom.round > 0 ? 1 : 0),
    stableLevel: lvl('stable'),
    ammo: g.ammo, magazine: d.magazine, infiniteMag: d.infiniteMag,
    onMagIn: () => { g.ammo = d.magazine; g.magFilled = true; }
  });
  G.mouseDX = 0; G.mouseDY = 0;
  /* §7.10 新手前两局显示一次“三张同品质”提示，之后自动隐藏 */
  G.evoHintsLeft = 2;

  Audio2.setListener(R.camera.position, R.camera.getWorldDirection(TV), UP);
}

/* 相机 yaw 的固定序列：可学习，不是随机噪声（todo2 §4） */
const YAW_PATTERN = [0.55, -0.35, 0.85, -0.7, 0.4, -0.9];

function fire() {
  const p = G.player, g = p.gun, d = G.derived, W = TUNE.WEAPON_FX;
  /* todo5：开火瞬间先决定「这一枪是否落在动势强化轮里」，
     因为 §2.8 强化的是一整轮射击，不是某一颗难以感知的子弹。 */
  WMOD.onFire();
  /* 单次耗弹是资源原子（§1.1）：齐射、爆裂、重型都会把它推高 */
  const cost = d.ammoPerShot;
  if (!d.infiniteMag) g.ammo = Math.max(0, g.ammo - cost);
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

  const right0 = TV2.copy(baseDir).cross(UP).normalize().clone();
  const up0 = right0.clone().cross(baseDir).normalize();

  /* --- §6.1 第 1～2 步：一次扳机 = 一个根攻击 = N 颗根弹 ---
     整次齐射共享同一份派生预算、事件预算与统一爆炸预算，
     这就是 todo5 §4.1「单次攻击有统一爆炸预算」在代码里的样子。 */
  const root = AG.beginRoot(d.pellets);
  const fan = (d.volleyFan || 0) * Math.PI / 180;
  for (let i = 0; i < d.pellets; i++) {
    const dir = baseDir.clone();
    /* 齐射图案是可读的扇形，不是把散布放大 N 倍（§2.1）*/
    if (d.pellets > 1) {
      const t = (i / (d.pellets - 1) - 0.5) * 2;
      dir.addScaledVector(right0, Math.sin(t * fan))
         .addScaledVector(up0, Math.sin(t * fan * 0.28));
    }
    /* 散布仍然叠在图案之上，但幅度小得多 */
    const a = RNG.fx.range(0, Math.PI * 2), r = Math.sqrt(RNG.fx.next()) * spread;
    dir.addScaledVector(right0, Math.cos(a) * r).addScaledVector(up0, Math.sin(a) * r).normalize();
    AG.rootBullet(root, muzzleWorld, dir, i);
  }

  /* 曳光从真实枪口出发，但弹道仍从准星方向收敛 —— 避免"瞄哪打不到哪" */
  WEAPON.muzzleWorldPos(_muzzleW);
  /* §11 每个模块的枪线必须能分辨：重型粗、动势蓄能亮、齐射多条 */
  let tracerColor = 0xffd9a0, tracerLen = W.tracerLength;
  if (d.momActive > 0.01) tracerColor = TUNE.MODULES.momentum.color;
  else if (d.heavyOn) { tracerColor = TUNE.MODULES.heavy.color; tracerLen *= 1.3; }
  else if (d.pellets > 1) tracerColor = TUNE.MODULES.volley.color;
  const nTracer = Math.min(3, d.pellets);
  for (let i = 1; i < nTracer; i++) WEAPON.addTracer(_muzzleW, baseDir, tracerColor, tracerLen * (0.8 - i * 0.1));
  WEAPON.addTracer(_muzzleW, baseDir, tracerColor, tracerLen);

  const ramp = WMOD.oc.ramp;
  const isLast = !d.infiniteMag && g.ammo <= 0;
  WEAPON.on('shot', {
    isLastRound: isLast, pellets: d.pellets, overclock: ramp,
    heavy: heavy, boltSpeed: 1 + ramp * 0.45,
    momentum: d.momActive
  });
  Audio2.shot(1 + ramp * 0.35, heavy, effectiveFireInterval());
  if (isLast) Audio2.lastRound();

  /* 动势强化轮的释放必须有区别于普通射击的视听轮廓（§4.6）*/
  if (d.momActive > 0.4) {
    G.shake(0.05 + d.momActive * 0.05, null);
    Audio2.blast(p.pos, false);
  }
  WMOD.afterFire();

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

    this.xpFill.style.width = (EVO.progressFrac() * 100) + '%';
    this.lvl.textContent = EVO.draw.evolutionIndex;
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
    const vert = this._sectorVert || (this._sectorVert = new Float32Array(N));
    score.fill(0); danger.fill(0); vert.fill(0);

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
      const rel = screenBearing(dx, dz, p.yaw);

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
      /* §8.2 同一方向的多个高度继续聚合，但要能读出主要威胁在上还是在下。
         用弧的“形态”（半径档位）表达，不额外画箭头。 */
      if (CITY.enabled) {
        const rise = e.pos.y - p.pos.y;
        if (rise > 2.2) vert[k] += 1; else if (rise < -2.2) vert[k] -= 1;
      }
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
      /* 上方威胁的弧推到外圈、下方收到内圈、同层保持基准 —— 三种形态一眼可分 */
      const v = this._sectorVert ? this._sectorVert[k] : 0;
      const r0 = 150 + (v > 0.5 ? 16 : v < -0.5 ? -16 : 0);
      el.setAttribute('d', arcPath(mid - half, mid + half, r0, r0 + 10 + sc * 16));
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
      const rel = screenBearing(dx, dz, p.yaw);
      if (Math.abs(rel) < hHalf) { el.style.opacity = 0; return; }   // 进入视野后只留世界光柱
      el.style.opacity = 1;
      el.style.transform = 'translate(-50%,-50%) rotate(' + (rel * 180 / Math.PI) + 'deg)';
      const dyM = (obj.y === undefined ? 0 : obj.y) - p.pos.y;
      const arrow = !CITY.enabled ? '' : (dyM > 2.2 ? ' ▲' : dyM < -2.2 ? ' ▼' : ' ●');
      el.firstChild.textContent = Math.round(Math.hypot(dx, dz)) + 'm' + arrow;
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
  /* HUD：当前 1～3 个基础模块及其 S 级组合名称（todo5 §11） */
  /* M6：暂停面板的构筑图 —— 当前模块、已成立组合、节点与规则一屏可读。
     这不是把 describe() 打印出来，而是把「因果」摆出来：
     模块用自己的颜色，组合写出它的名字与评级。 */
  buildGraph() {
    const el = $('buildgraph');
    if (!el) return;
    if (!WMOD.own.length) { el.innerHTML = '<i>还没有基础模块</i>'; return; }
    const mods = WMOD.own.map(id => {
      const M = TUNE.MODULES[id];
      return '<span class="bgm" style="color:' + M.css + '">' + M.name + '</span>';
    }).join('');
    const row = (k, v) => '<div class="bgrow"><span class="bgk">' + k + '</span><span>' + (v || '—') + '</span></div>';
    const pairs = WMOD.pairs().map(p2 => {
      const nm = p2.info ? p2.info.name : (TUNE.MODULES[p2.a].name + '×' + TUNE.MODULES[p2.b].name);
      return (p2.tier === 'S' ? '<b class="bgs">' + nm + '</b>' : nm) + ' [' + p2.tier + ']';
    }).join('　');
    const nodes = Object.keys(WMOD.nodes).filter(k => WMOD.nodes[k] > 0)
      .map(k => NODE_MAP[k].name + (WMOD.nodes[k] > 1 ? '×' + WMOD.nodes[k] : '')).join('　');
    el.innerHTML = '<div class="bgmods">' + mods + '</div>' +
      row('组合反应', pairs) +
      row('深化节点', nodes) +
      row('形态分支', WMOD.branches.map(b => BRANCH_MAP[b].name).join('　')) +
      row('规则改写', WMOD.rules.map(r => RULE_MAP[r].name).join('　')) +
      row('谱系预算', '派生 ' + AG.gBudget.derived + ' · 事件 ' + AG.gBudget.events +
        ' · 触顶 ' + AG.gBudget.rejected + ' · 最大深度 ' + AG.gBudget.maxDepth);
  },

  mutationSlots() {
    this.slots.innerHTML = '';
    {
      const max = TUNE.MODULE_BUILD.maxModules;
      for (let i = 0; i < max; i++) {
        const s = document.createElement('div');
        s.className = 'slot';
        const id = WMOD.own[i], M = id && TUNE.MODULES[id];
        if (M) {
          s.style.borderColor = M.css; s.style.color = M.css;
          s.style.boxShadow = '0 0 12px ' + M.css + '44';
          s.textContent = M.name[0];
          s.title = M.name + '：' + M.effect;
        } else { s.classList.add('empty'); s.textContent = '·'; }
        this.slots.appendChild(s);
      }
      const combos = WMOD.pairs().filter(p => p.tier === 'S' && p.info);
      if (combos.length) {
        const tag = document.createElement('div');
        tag.className = 'scombo';
        tag.innerHTML = combos.map(p =>
          '<i style="color:' + TUNE.MODULES[p.b].css + '">' + p.info.name + '</i>').join('');
        this.slots.appendChild(tag);
      }
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
  },

  /* ------------------------------------------------------------------
     统一进化界面 §7.10
     目标：玩家在一次暂停内 2～4 秒读懂三张卡的差别。
     先揭示本次整体品质，再同时展开三张同品质卡；
     卡面不展示后台权重、复杂公式或长段 lore。
     ------------------------------------------------------------------ */
  /* todo5 §7.2 卡面：最多四行 —— 名称 / 一句主效果 / 一句代价 / 动态 S 预览。
     十几个底层原子参数一律不上主卡面，只进展开说明。 */
  _moduleCardHtml(c, quality, RA) {
    const col = c.css || RA.css[quality];
    /* 动态预览只显示【真实成立】的 S 组合：
       模块卡问「拿了它会形成什么」，其他卡直接写它深化的那一对。 */
    let prev = '';
    if (c.kind === 'module') {
      const s = WMOD.previewS(c.module);
      if (s.length) prev = s.map(x =>
        '与你的【' + TUNE.MODULES[x.other].name + '】形成：<b>' + x.name + '</b>').join('<br>');
    } else if (c.pairName) {
      prev = '深化你的 <b>' + c.pairName + '</b>';
    } else if (c.module && WMOD.has(c.module)) {
      prev = '深化你的【' + TUNE.MODULES[c.module].name + '】';
    }
    const kindTag = { module: '基础模块', node: '深化节点', branch: '形态分支',
      pair: '组合深化', rule: '规则改写', cond: '条件分支', mod: '通用改装' }[c.kind] || '';
    return '<div class="qtag" style="color:' + RA.css[quality] + '">' + RA.name[quality] +
        (kindTag ? ' · ' + kindTag : '') + '</div>' +
      '<div class="cname" style="color:' + col + '">' + c.name +
        (c.en ? '<span class="cen">' + c.en + '</span>' : '') + '</div>' +
      '<div class="cline you"><span class="tag">效果</span>' + c.effect + '</div>' +
      (c.cost && c.cost !== '—' ? '<div class="cline cost"><span class="tag kcost">代价</span>' + c.cost + '</div>' : '') +
      (prev ? '<div class="crel spreview">' + prev + '</div>' : '') +
      (c.detail ? '<div class="cdetail">' + c.detail + '</div>' : '');
  },

  showEvolution(quality, cards, info, pick) {
    const RA = TUNE.RARITY;
    const wrap = this.cards;
    wrap.innerHTML = '';

    /* 保底 / 地图印记：只说明来源，绝不伪称必出（§7.10） */
    const marks = [];
    if (info && (info.pityRare || info.pityEpic)) marks.push('<span class="emark pity">保底生效</span>');
    if (info && info.mapMod > 0) marks.push('<span class="emark map">屋顶空投印记</span>');
    if (info && info.mapMin) marks.push('<span class="emark map">精英猎杀印记</span>');

    const head = document.createElement('div');
    head.className = 'cardhead';
    head.innerHTML =
      '<div class="qreveal q-' + quality + '" style="--qc:' + RA.css[quality] + '">' +
        '<b>' + RA.name[quality] + '</b><span>进化 ' + (EVO.draw.evolutionIndex + 1) + '</span>' +
      '</div>' +
      '<div class="cs">三张同品质 ' + marks.join('') + '</div>';
    wrap.appendChild(head);

    const row = document.createElement('div');
    row.className = 'cardrow evorow';
    cards.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card evo q-' + quality;
      el.style.setProperty('--mc', c.css || RA.css[quality]);
      /* 先揭示品质再展开三张：用动画延迟表达，不占一帧逻辑 */
      el.style.animationDelay = (RA.revealTime + i * 0.05) + 's';
      el.innerHTML = (c.effect !== undefined)
        ? this._moduleCardHtml(c, quality, RA)
        : ('<div class="qtag" style="color:' + RA.css[quality] + '">' + RA.name[quality] + '</div>' +
           '<div class="cname" style="color:' + (c.css || RA.css[quality]) + '">' + c.name + '</div>' +
           '<div class="cline you"><span class="tag">你</span>' + c.text + '</div>' +
           (c.horde ? '<div class="cline horde"><span class="tag">尸潮</span>' + c.horde + '</div>' : '') +
           (c.relation ? '<div class="crel">' + c.relation + '</div>' : ''));
      el.onclick = () => pick(c.id);
      row.appendChild(el);
    });
    wrap.appendChild(row);

    const foot = document.createElement('div');
    foot.className = 'cardfoot';
    /* 新手前两局提示一次，之后自动隐藏（§7.10） */
    const desc = WMOD.describe();
    foot.textContent = G.evoHintsLeft > 0
      ? '每局最多 3 个基础模块 —— 选组合方向，不用比颜色'
      : (desc[1] || '');
    if (G.evoHintsLeft > 0) G.evoHintsLeft--;
    wrap.appendChild(foot);

    wrap.classList.add('on');
    /* 史诗与传奇给一次明显但短促的音画奖励，不拖慢连续试玩（§7.10） */
    if (quality === 'epic' || quality === 'legend') { Audio2.levelup(); this.flashHeal(); }
    document.exitPointerLock();
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
  while (G.tlIndex < TIMELINE.length && G.time >= TIMELINE[G.tlIndex].t) {
    const ev = TIMELINE[G.tlIndex++];
    if (ev.kind === 'intro') {
      const first = !G.introduced[ev.enemy];
      G.introduced[ev.enemy] = true;
      /* quiet：§4.3 要求用尸潮位置自然诱导，不弹长教学文本 */
      if (!ev.quiet && first) UI.toast('新敌人：' + ENEMIES[ev.enemy].name, '#9fd8ff');
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

  /* todo5 §11：结算页分别统计各模块的触发次数、直接伤害、派生伤害、
     命中目标数与弹药消耗 —— 归因必须能和肉眼体验对上（§12.1 第 5 条）。 */
  let modBlock = '';
  {
    const rows = WMOD.own.map(id => {
      const s = WMOD.stats[id], M = TUNE.MODULES[id];
      return '<tr><td style="color:' + M.css + '">' + M.name + '</td>' +
        '<td>' + s.trigger + '</td><td>' + Math.round(s.direct) + '</td>' +
        '<td>' + Math.round(s.derived) + '</td><td>' + s.targets + '</td>' +
        '<td>' + s.ammo + '</td></tr>';
    }).join('');
    const combos = WMOD.pairs().filter(p => p.info).map(p =>
      '<span class="rmod" style="border-color:' + TUNE.MODULES[p.b].css + '">' +
      p.info.name + ' [' + p.tier + ']</span>').join('');
    modBlock =
      '<div class="rsec">本局武器模块</div>' +
      '<div class="rmods">' + (combos || '<i>没有形成组合</i>') + '</div>' +
      (rows ? '<table class="rmodtab"><tr><th>模块</th><th>触发</th><th>直接伤害</th>' +
        '<th>派生伤害</th><th>命中目标</th><th>耗弹</th></tr>' + rows + '</table>' : '') +
      '<div class="runseen">谱系预算：派生 ' + AG.gBudget.derived + ' · 事件 ' + AG.gBudget.events +
        ' · 触顶拒绝 ' + AG.gBudget.rejected + ' · 最大深度 ' + AG.gBudget.maxDepth + '</div>';
  }

  el.innerHTML =
    '<div class="rtitle" style="color:' + (won ? '#7ef0a8' : '#ff6a7a') + '">' +
    (won ? '撤离成功' : '你没能撑到撤离') + '</div>' +
    '<div class="rsub">存活 ' + fmtTime(Math.min(G.time, TUNE.RUN_SECONDS)) + ' · 击杀 ' + G.stats.kills +
    ' · 等级 ' + G.player.level + '</div>' +
    modBlock +
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
      else if (a === 'navdraw') { this.navDraw = !this.navDraw; NAV.debugDraw(this.navDraw); this.log('导航图 ' + (this.navDraw ? 'ON' : 'off')); }
      else if (a === 'freeze') { this.freezeEnemies = !this.freezeEnemies; this.log('冻结敌人 ' + (this.freezeEnemies ? 'ON' : 'off')); }
      else if (a === 'freezeev') { this.freezeEvents = !this.freezeEvents; this.log('冻结地图事件 ' + (this.freezeEvents ? 'ON' : 'off')); }
      else if (a.indexOf('tp_') === 0) {
        const lm = CITY.landmarks.find(l => l.id === a.slice(3));
        if (lm) { MOVE.teleport(G.player, lm.x, lm.y + 2.5, lm.z); this.log('传送：' + lm.name); }
      }
      else if (a.indexOf('ly_') === 0) {
        const y = { street: 1.2, mid: 7.0, roof: 19.0 }[a.slice(3)];
        MOVE.teleport(G.player, 0, y, a.slice(3) === 'street' ? 0 : (a.slice(3) === 'mid' ? -9.5 : 0));
        if (a.slice(3) === 'roof') MOVE.teleport(G.player, 19, 20, 19);
        this.log('传送到 ' + a.slice(3) + ' 层');
      }
      else if (a.indexOf('sp_') === 0 && ENEMIES[a.slice(3)]) {
        const pos = spawnPosition(true);
        if (pos) { configureEnemy(G.enemies.get(), ENEMIES[a.slice(3)], pos, { highlight: 6 }); this.log('生成 ' + ENEMIES[a.slice(3)].name); }
      }
      else if (a === 'tg_fall') { TUNE.MOVEMENT.fallDamage = !TUNE.MOVEMENT.fallDamage; this.log('坠落伤害 ' + (TUNE.MOVEMENT.fallDamage ? 'ON' : 'off')); }
      else if (a === 'tg_wallrun') { TUNE.MOVEMENT.wallRunTime = TUNE.MOVEMENT.wallRunTime > 0 ? 0 : 1.1; this.log('墙跑时长 ' + TUNE.MOVEMENT.wallRunTime); }
      else if (a === 'tg_dash') { TUNE.MOVEMENT.airDashCharges = TUNE.MOVEMENT.airDashCharges ? 0 : 1; this.log('空中冲刺充能 ' + TUNE.MOVEMENT.airDashCharges); }
      else if (a === 'tg_vault') { TUNE.MOVEMENT.vaultMaxHeight = TUNE.MOVEMENT.vaultMaxHeight > 0.5 ? 0.45 : 1.2; this.log('自动翻越高度 ' + TUNE.MOVEMENT.vaultMaxHeight); }
      else if (a === 'tg_stable') { TUNE.MOVEMENT.stableCam = !TUNE.MOVEMENT.stableCam; this.log('稳定跑酷镜头 ' + (TUNE.MOVEMENT.stableCam ? 'ON' : 'off')); }
      else if (a.indexOf('ev_') === 0) this.log(MAPEV.force());
      else if (a.indexOf('q_') === 0) { EVO.forceQuality(a.slice(2)); this.log('下一次品质强制为 ' + TUNE.RARITY.name[a.slice(2)]); }
      else if (a === 'evo_now') { EVO.progress = EVO.need + 1; EVO.draw.lastChoiceTime = -999; this.log('已把进化条打满'); }
      else if (a === 'grant_base') {
        MODULE_IDS.slice(0, 3).forEach(id => WMOD.grant(id));
        recompute(); UI.mutationSlots(); this.log('已授予三个基础模块');
      }
      else if (a === 'grant_branch') {
        WMOD.own.forEach(m => { const b = BRANCH_BY_MOD[m]; if (b) WMOD.grantBranch(b.id); });
        recompute(); this.log('已授予当前模块的全部形态分支');
      }
      else if (a[0] === 'j') this.jump(parseInt(a.slice(1), 10));
    };
    /* --- todo3 §11 立体城市 + 统一进化实验面板 --- */
    {
      $('dbgbtns').innerHTML += [
        ['导航图', 'navdraw'], ['冻结敌人', 'freeze'], ['冻结事件', 'freezeev'],
        ['→十字路口', 'tp_cross'], ['→停车楼', 'tp_parking'], ['→在建楼', 'tp_site'], ['→停机坪', 'tp_helipad'],
        ['→街道层', 'ly_street'], ['→中层', 'ly_mid'], ['→屋顶层', 'ly_roof'],
        ['刷攀爬怪', 'sp_climber'], ['刷跳跃怪', 'sp_leaper'], ['刷远程怪', 'sp_roofcaster'],
        ['坠落伤害', 'tg_fall'], ['关墙跑', 'tg_wallrun'], ['关空冲', 'tg_dash'], ['关翻越', 'tg_vault'],
        ['稳定镜头', 'tg_stable'],
        ['热点迁移', 'ev_next'],
        ['下次普通', 'q_common'], ['下次稀有', 'q_rare'], ['下次史诗', 'q_epic'], ['下次传奇', 'q_legend'],
        ['立刻进化', 'evo_now'], ['授予全部基础', 'grant_base'], ['授予连接+融合', 'grant_fuse'],
        ['融合精英', 'sp_fusion']
      ].map(x => '<button data-a="' + x[1] + '">' + x[0] + '</button>').join('');
    }

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
    /* 跳时间时把构筑也补上：随机拿满 3 个模块，
       否则跳到 10 分钟会得到一个「时间很晚但一个模块都没有」的假状态。 */
    while (WMOD.own.length < TUNE.MODULE_BUILD.maxModules) {
      const rem = MODULE_IDS.filter(id => !WMOD.has(id));
      if (!rem.length) break;
      WMOD.grant(RNG.mutation.pick(rem));
    }
    G.player.level = Math.max(G.player.level, Math.round(expectedLevel(t)));
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
      ' &nbsp; 超频 <b>' + Math.round(WMOD.oc.ramp * 100) + '%</b>' +
      ' &nbsp; 动势 <b>' + Math.round(WMOD.mom.charge * 100) + '%</b>' +
      '<br>无敌 <b style="color:' + (this.god ? '#7ef0a8' : '#8899aa') + '">' + (this.god ? 'ON' : 'off') + '</b>' +
      ' &nbsp; 种子 <b>' + RNG.master + '</b>';

    /* --- §11.1 空间与战斗 --- */
    {
      const p = G.player, st = MOVE.st;
      const sup = CITY.supportY(p.pos.x, p.pos.z, p.radius, p.pos.y + 0.2, 1.2, 0.4);
      const camp = NAV.camp;
      const layers = MOVE.stats ? MOVE.stats.layerTime : { street: 0, mid: 0, roof: 0 };
      const enemyLayers = { street: 0, mid: 0, roof: 0 };
      let traversing = 0;
      G.enemies.live.forEach(e => {
        if (e._dead || e.dead) return;
        enemyLayers[CITY.layerOf(e.pos.y)]++;
        if (e.nav && e.nav.link) traversing++;
      });
      $('dbgmove').innerHTML =
        '位置 <b>' + p.pos.x.toFixed(1) + ',' + p.pos.y.toFixed(1) + ',' + p.pos.z.toFixed(1) + '</b>' +
        ' 速度 <b>' + Math.hypot(p.vel.x, p.vel.z).toFixed(1) + '</b> vy <b>' + p.vel.y.toFixed(1) + '</b>' +
        ' 层 <b>' + MOVE.pose.layer + '</b> 状态 <b style="color:#7ef0a8">' + MOVE.pose.state + '</b>' +
        ' 冲刺充能 <b>' + (st ? st.dashCharge : 0) + '</b>' +
        '<br>脚下支撑 <b>' + (sup === -Infinity ? '无' : sup.toFixed(2)) + '</b>' +
        ' 头顶 <b>' + (function () { const c = CITY.ceilingY(p.pos.x, p.pos.z, p.radius, p.pos.y + 0.1); return c === Infinity ? '∞' : c.toFixed(1); })() + '</b>' +
        ' 墙面法线 <b>' + (st && st.state === 'wallrun' ? st.wallN.x.toFixed(2) + ',' + st.wallN.z.toFixed(2) : '-') + '</b>' +
        '<br>敌人分层 街<b>' + enemyLayers.street + '</b> 中<b>' + enemyLayers.mid + '</b> 顶<b>' + enemyLayers.roof + '</b>' +
        ' 通过连接中 <b>' + traversing + '</b> 累计 <b>' + NAV.stats.traversals + '</b> 射落 <b>' + NAV.stats.shotOffWall + '</b>' +
        '<br>刷怪点拒绝 <b>' + NAV.stats.spawnRejected + '</b> ' + JSON.stringify(NAV.stats.rejectReason) +
        ' 导航失败 <b>' + NAV.stats.navFail + '</b>' +
        '<br>antiCamp <b style="color:' + (camp.stage ? '#ff8a4a' : '#8899aa') + '">' + camp.stage + '</b>' +
        ' 手段 <b>' + camp.method + '</b> 停留 <b>' + camp.t.toFixed(1) + 's</b>' +
        '<br>各层停留 街<b>' + layers.street.toFixed(0) + 's</b> 中<b>' + layers.mid.toFixed(0) + 's</b> 顶<b>' + layers.roof.toFixed(0) + 's</b>' +
        ' 连接使用 ' + JSON.stringify(MOVE.stats ? MOVE.stats.linkUse : {}) +
        '<br>移动中射击 <b>' + (MOVE.stats ? MOVE.stats.shotsMoving : 0) + '</b>' +
        ' 移动中击杀 <b>' + (MOVE.stats ? MOVE.stats.killsMoving : 0) + '</b>' +
        ' 滞空击杀 <b>' + (MOVE.stats ? MOVE.stats.killsAirborne : 0) + '</b>' +
        ' 翻越<b>' + MOVE.stats.vault + '</b> 抓边<b>' + MOVE.stats.mantle + '</b> 墙跑<b>' + MOVE.stats.wallRun + '</b>' +
        ' 登墙<b>' + MOVE.stats.wallClimb + '</b> 空冲<b>' + MOVE.stats.airDash + '</b> 滑铲<b>' + MOVE.stats.slide + '</b>' +
        ' 滑索<b>' + MOVE.stats.zip + '</b> 跳板<b>' + MOVE.stats.pad + '</b>' +
        '<br>地图事件 <b>' + MAPEV.statusText() + '</b>' +
        ' 不可达资源 <b>' + (G.stats.unreachable || 0) + '</b>';
    }

    /* --- §11.2 进化与构筑 --- */
    {
      const d = EVO.draw, ld = EVO._lastDraw || {};
      const fmtw = w => w ? TUNE.RARITY.order.map(k => TUNE.RARITY.name[k] + (w[k] * 100).toFixed(0) + '%').join(' ') : '-';
      $('dbgevo').innerHTML =
        '进化 <b>' + d.evolutionIndex + '</b>/目标' + TUNE.EVOLUTION.targetCount +
        ' 距上次 <b>' + (G.time - d.lastChoiceTime).toFixed(1) + 's</b>(下限' + TUNE.EVOLUTION.hardFloor + ')' +
        ' 进度 <b>' + EVO.progress.toFixed(0) + '/' + EVO.need.toFixed(0) + '</b>' +
        ' 溢出 <b>' + EVO.overflow.toFixed(0) + '</b>' +
        ' pending <b>' + (d.pending ? (d.pending.open ? '已开' : '排队:' + d.deferReason) : '-') + '</b>' +
        '<br>原始概率 ' + fmtw(ld.raw) + '<br>最终概率 ' + fmtw(ld.final) +
        ' → <b style="color:' + (TUNE.RARITY.css[ld.q] || '#fff') + '">' + (TUNE.RARITY.name[ld.q] || '-') + '</b>' +
        (ld.pityRare ? ' <b style="color:#7ef0a8">三连普通保底</b>' : '') +
        (ld.pityEpic ? ' <b style="color:#7ef0a8">7:30史诗保底</b>' : '') +
        (ld.mapMod ? ' <b style="color:#ff8a1e">地图+' + (ld.mapMod * 100).toFixed(0) + '%</b>' : '') +
        '<br>连败普通 <b>' + d.commonStreak + '</b> 已出史诗 <b>' + (d.hasEpic ? 'Y' : 'N') + '</b>' +
        ' 下一抽修正 <b>' + (typeof MAPBUILD !== 'undefined' ? MAPBUILD.statusText() : '-') + '</b>' +
        '<br>' + WMOD.describe().join('<br>') +
        '<br>谱系预算 <b>' + AG.debugLine() + '</b>' +
        '<br>超频 <b>' + WMOD.oc.ramp.toFixed(2) + '</b>' +
        ' 动势 <b>' + WMOD.mom.charge.toFixed(2) + '</b>' +
        ' 强化轮 <b style="color:#7ec8ff">' + (WMOD.mom.round > 0
          ? WMOD.mom.strength.toFixed(2) + '(发' + WMOD.mom.shots + '/' + WMOD.mom.timer.toFixed(2) + 's)' : '-') + '</b>' +
        ' 耗弹/发 <b>' + G.derived.ammoPerShot + '</b>' +
        ' 弹丸 <b>' + G.derived.pellets + '</b>' +
        ' 贯穿 <b>' + G.derived.pierce + '</b> 弹射 <b>' + G.derived.bounce + '</b>' +
        '<br>卡池 <b>' + MODPOOL.cards.length + '</b> 审计拒绝 <b style="color:' +
          (MODPOOL.rejected.length ? '#ff6a7a' : '#7ef0a8') + '">' + MODPOOL.rejected.length + '</b>' +
        '<br>共同进化 <b>' + (typeof HORDE !== 'undefined' ? HORDE.describe() : '-') + '</b>';
    }
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
  MOVE.init(G.player);
  NAV.init();
  G.enemies = makeEnemyPool();
  G.bullets = makeBulletPool();
  G.acids = makeAcidPool();
  G.variantTpl = {};
  MUTATIONS.forEach(m => { G.variantTpl[m.id] = variantTemplate(m.id); });
  G.tutorialQueue = [];
  G.pendingLevels = 0;
  G.tlIndex = 0;
  /* EMA 预置成目标节奏，避免开局冷启动时需求算得离谱 */
  G.xpRate = TUNE.PACING.bootstrapXp / TUNE.PACING.firstLevelAt;
  G.xpFrame = 0; G.pacingMult = 1;
  G.bossAlive = null; G.surge = false; G.bossSpawnAt = -999;
  G.dropCount = 0; G.lastDropAt = 0; G.supplyCharge = 0; G.dropQueued = false;
  G.medNeed = 0; G.medCooldown = 0; G.medPending = false; G.medical = null;
  G.buff = null; G.meleeWhiffs = 0; G.hurtCount = 0;
  G.mouseDX = 0; G.mouseDY = 0;

  /* 模块状态 → 谱系/消费者登记 → 卡池审计 → 导演。顺序不能反：
     MODPOOL.audit() 要读 AG.consumers 和 WEAPON.moduleFx，
     所以必须排在 WEAPON.build() 和 AG.init() 之后。 */
  WMOD.init();
  AG.init();
  HORDE.init();
  MAPBUILD.init();
  MODPOOL.init();
  EVO.init();
  MAPEV.init();

  recompute();
  emitBuildChanged();
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
      G.paused = true; $('pause').classList.add('on'); UI.buildGraph();
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
   try {
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
      NAV.updateCamp(dt);
      AG.tick(dt);
      EVO.update(dt);
      if (!DebugPanel.freezeEvents) MAPEV.update(dt);
      HORDE.update(dt);
      MAPBUILD.update(dt);
      updateMedical(dt);
      updateAirdrop(dt);
      updateBuff(dt);
      runTutorialQueue(dt);
      updateShake(dt);
      if (DebugPanel.god) G.player.hp = G.player.maxHp;
      if (G.time >= TUNE.RUN_SECONDS && !G.bossAlive && G.tlIndex >= TIMELINE.length) { /* Boss 已死由 retireEnemy 触发胜利 */ }
    }
   } catch (err) {
    /* 逻辑异常绝不能顺带停掉渲染。
       rAF 在 frame() 开头就排好了，所以循环本身不会停 —— 但如果异常从这里冒出去，
       后面的 R.render() 每帧都执行不到，表现为「音效还在、也在开枪，画面卡住」。
       那是最难排查的故障形态，所以这里兜住它：世界继续渲染，错误只报一次。 */
    if (!G._loopErr) {
      G._loopErr = err;
      console.error('[frame] 逻辑异常，已兜住以保住渲染：', err);
      DebugPanel.log('⚠ 逻辑异常 ' + err.message);
      G.ui.toast('内部错误：' + err.message, '#ff6a7a', true);
    }
    G._loopErrCount = (G._loopErrCount || 0) + 1;
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
