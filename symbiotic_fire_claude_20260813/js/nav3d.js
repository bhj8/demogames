/* ============================================================================
   SYMBIOTIC FIRE · 敌人分层导航（todo3 §5）
   底线只有一句：高处只能提供暂时的节奏优势，不能成为永久安全区。

   §5.2 明确不要求通用三维 NavMesh —— 这里用可控的分层路线图：
   区域（street / mid / roof）+ 连接边（climb / jump / drop / stairs / zip / walk）。
   普通地面移动仍然沿用 game.js 的二维逻辑，只有抵达连接节点才进入攀爬 / 跳跃 / 坠落状态。
   ========================================================================== */
'use strict';

const NAV = {
  enabled: false,
  camp: { t: 0, x: 0, z: 0, stage: 0, method: '-' },
  stats: { spawnRejected: 0, rejectReason: {}, navFail: 0, traversals: 0, shotOffWall: 0 },
  _pathCache: null, _cacheTick: 0,

  init() {
    this.enabled = CITY.enabled;
    this._pathCache = new Map();
    this.camp = { t: 0, x: 0, z: 0, stage: 0, method: '-' };
    this.stats = { spawnRejected: 0, rejectReason: {}, navFail: 0, traversals: 0, shotOffWall: 0 };
    return this;
  },

  /* 动态几何改变后，缓存的路线可能已经失效（§9） */
  invalidate() { if (this._pathCache) this._pathCache.clear(); },

  /* ------------------------------------------------------------ 路线查询 */
  /* 小图 BFS：25 个区域、约 100 条边，按 (from,to,kind) 缓存即可，
     绝不做每帧全图寻路（§12 性能：跨层导航不得造成明显卡顿）。 */
  findLink(fromId, toId, kind) {
    if (fromId === toId) return null;
    const key = fromId + '>' + toId + '|' + kind;
    const hit = this._pathCache.get(key);
    if (hit !== undefined) return hit;

    const prev = {}, seen = {};
    seen[fromId] = 1;
    const q = [fromId];
    let found = null;
    while (q.length && !found) {
      const cur = q.shift();
      const r = CITY.byId[cur];
      if (!r) continue;
      for (let i = 0; i < r.links.length; i++) {
        const l = r.links[i];
        if (l.allow.indexOf(kind) < 0) continue;
        if (l.dyn && !(CITY.dynamics[l.dyn] && CITY.dynamics[l.dyn].on)) continue;
        if (seen[l.to]) continue;
        seen[l.to] = 1; prev[l.to] = l;
        if (l.to === toId) { found = l; break; }
        q.push(l.to);
      }
    }
    /* 回溯出第一步 */
    let step = null;
    if (found) {
      let cur = toId;
      while (prev[cur] && prev[cur].from !== fromId) cur = prev[cur].from;
      step = prev[cur] || found;
    }
    this._pathCache.set(key, step);
    return step;
  },

  /* ------------------------------------------------- 分层刷怪点选择 §5.3 */
  /* 目标数量按玩家高度与邻近层动态分配；所有刷新点必须在视线外或被环境遮挡，
     且已在 CITYSCALE.buildSpawnPoints 里验证过可站立与可达。 */
  pickSpawn(forceFront, layerWant) {
    if (!CITY.spawnPoints.length) return null;
    const p = G.player, S = TUNE.SPAWN, V = TUNE.VERTICAL_ENEMY;
    const pl = CITY.layerOf(p.pos.y);
    const layer = layerWant || this._rollLayer(pl);

    const vFov = R.camera.fov * Math.PI / 180;
    const hHalf = Math.atan(Math.tan(vFov / 2) * R.camera.aspect) * 1.02;

    let best = null, bestScore = -Infinity;
    for (let n = 0; n < 36; n++) {
      const s = CITY.spawnPoints[RNG.spawn.int(CITY.spawnPoints.length)];
      if (s.layer !== layer) continue;
      const dx = s.x - p.pos.x, dz = s.z - p.pos.z, dy = s.y - p.pos.y;
      const dist = Math.hypot(dx, dz);
      /* 跨层的最近距离单独给一个数。原来写的是 minDist × 0.62 —— 9.3m，
         楼上楼下等于直接刷在脸上（实测最近 9.4m 就是这么来的）。 */
      if (dist < (layer === pl ? S.minDist : S.minDistCross)) { this._reject('too_close'); continue; }
      if (dist > S.maxPickDist) { this._reject('too_far'); continue; }

      /* 教学 / 正面生成：要求在视野内且不太远 */
      let rel = Math.atan2(dx, dz) - (p.yaw + Math.PI);
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      const inView = Math.abs(rel) < hHalf;
      if (forceFront) {
        if (!inView || dist > 22) { this._reject('not_front'); continue; }
      } else {
        /* §5.3 所有刷新点必须在玩家视线外或被明确环境遮挡；
           §5.3 也禁止直接在玩家身后近距离生成普通怪来解决追击问题。 */
        const occluded = CITY.segBlocked(p.pos.x, p.pos.y + 1.5, p.pos.z, s.x, s.y + 1.0, s.z);
        if (inView && !occluded) { this._reject('visible'); continue; }
        /* 背后分两圈：正后方的锥要求最远，锥外的整个背后半球也有下限。
           只保护锥的话，偏 51° 的地方 15m 就能刷 —— 玩家的体感是
           「怪凭空出现在我背后」，因为他根本没看到它走过来。 */
        const behind = Math.abs(rel) > Math.PI - 0.9;
        if (behind && dist < S.rearMinDist) { this._reject('rear_close'); continue; }
        if (!behind && Math.abs(rel) > Math.PI / 2 && dist < S.rearHalfMinDist) {
          this._reject('rear_half'); continue;
        }
      }
      /* 打分偏好【一个距离带】，不是「越近越好」。
         原来是 -dist —— 它专挑最近的合法点，于是每一只都贴着下限出现，
         下限是多少，玩家看到的就是多少。改成靠近 preferDist 得分最高：
         太近扣分，太远也扣分，落点自然散在一个能看见它走过来的圈上。 */
      const score = -Math.abs(dist - S.preferDist) - Math.abs(dy) * 0.35
        + (s.layer === layer ? 6 : 0)
        + (Math.abs(rel) < Math.PI / 2 ? S.frontBonus : 0)
        + MAPEV.spawnBias(s.x, s.z) * 24 + RNG.spawn.range(0, 3);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (!best) { this._reject('no_candidate'); return null; }
    return best;
  },

  _rollLayer(playerLayer) {
    const V = TUNE.VERTICAL_ENEMY;
    const r = RNG.spawn.next();
    if (r < V.layerShareSame) return playerLayer;
    const others = ['street', 'mid', 'roof'].filter(l => l !== playerLayer);
    if (r < V.layerShareSame + V.layerShareAdj) return others[0];
    return others[1];
  },

  _reject(why) {
    this.stats.spawnRejected++;
    this.stats.rejectReason[why] = (this.stats.rejectReason[why] || 0) + 1;
  },

  /* --------------------------------------------------------- 敌人物理 */
  /* 敌人也吃重力与地面判定，否则楼上的怪会浮在空中，楼下的会走进楼板里。 */
  stepPhysics(e, dt) {
    if (e.nav && e.nav.link) return;                 // 连接动作期间由 traversal 控制位置
    const nv = e.nav;
    const sup = CITY.supportY(e.pos.x, e.pos.z, e.radius * 0.85, e.pos.y + 0.35, 2.2, 0.35);
    if (sup > -Infinity && e.pos.y <= sup + 0.35 && nv.vy <= 0.01) {
      e.pos.y = sup; nv.vy = 0; nv.grounded = true;
    } else {
      nv.vy -= TUNE.MOVEMENT.gravity * dt;
      e.pos.y += nv.vy * dt;
      nv.grounded = false;
      const land = CITY.supportY(e.pos.x, e.pos.z, e.radius * 0.85, e.pos.y + 0.2, 0.4, 0.2);
      if (land > -Infinity && e.pos.y <= land) { e.pos.y = land; nv.vy = 0; nv.grounded = true; }
      if (e.pos.y < 0) { e.pos.y = 0; nv.vy = 0; nv.grounded = true; }
    }
  },

  ensure(e) {
    if (!e.nav) e.nav = { region: null, link: null, linkT: 0, repath: 0, stuck: 0, lastD: undefined, noPath: false, vy: 0, grounded: true, recover: 0, hpAtClimb: 1, falling: false };
    return e.nav;
  },

  navKind(e) { return (e.tpl && e.tpl.navKind) || 'grunt'; },

  /* ------------------------------------------------------- 每敌人更新 */
  /* 返回 true 表示本帧的移动已由导航接管，game.js 不再执行二维追击。 */
  update(e, dt) {
    if (!this.enabled) return false;
    const nv = this.ensure(e);
    const p = G.player;

    if (nv.recover > 0) {                            // §5.1 到达平台后的短恢复窗口
      nv.recover -= dt;
      this.stepPhysics(e, dt);
      e.grp.position.copy(e.pos);
      return true;
    }

    /* --- 正在通过连接边 --- */
    if (nv.link) {
      const l = nv.link;
      nv.linkT += dt / Math.max(0.2, l.dur);
      const k = Math.min(1, nv.linkT);
      /* 连接动作使用固定时长，但视觉位置必须连续（§5.2） */
      e.pos.x = lerp(l.a.x, l.b.x, k);
      e.pos.z = lerp(l.a.z, l.b.z, k);
      if (l.kind === 'jump' || l.kind === 'drop') {
        const arc = l.kind === 'jump' ? 1.8 : 0;
        e.pos.y = lerp(l.a.y, l.b.y, k) + Math.sin(k * Math.PI) * arc;
      } else {
        e.pos.y = lerp(l.a.y, l.b.y, k);
      }
      e.state = l.kind === 'climb' ? 'climb' : l.kind === 'jump' ? 'leap' : 'traverse';
      if (k >= 1) {
        nv.region = l.to; nv.link = null; nv.linkT = 0; nv.vy = 0;
        nv.recover = (l.kind === 'climb') ? TUNE.VERTICAL_ENEMY.climbRecover : 0;
        l.uses++;
        this.stats.traversals++;
        MOVE.stats && (MOVE.stats.linkUse[l.kind] = (MOVE.stats.linkUse[l.kind] || 0) + 1);
        e.state = 'walk';
      }
      e.grp.position.copy(e.pos);
      e.grp.rotation.y = Math.atan2(l.b.x - l.a.x, l.b.z - l.a.z);
      return true;
    }

    /* --- 区域归属 --- */
    nv.repath -= dt;
    if (!nv.region || nv.repath <= 0) {
      const r = CITY.regionAt(e.pos.x, e.pos.y, e.pos.z);
      nv.region = r ? r.id : nv.region;
      nv.repath = TUNE.VERTICAL_ENEMY.navRepathInterval * (0.8 + RNG.spawn.next() * 0.4);
    }
    const pr = CITY.regionAt(p.pos.x, p.pos.y, p.pos.z);
    if (!nv.region || !pr) { this.stepPhysics(e, dt); return false; }

    /* 同层同区：交给既有二维追击逻辑，只补重力 */
    if (nv.region === pr.id) { nv.stuck = 0; this.stepPhysics(e, dt); return false; }

    const kind = this.navKind(e);
    const step = this.findLink(nv.region, pr.id, kind);
    if (!step) {
      /* 这个敌人天生到不了玩家所在的层 —— 普通尸潮上不了停机坪，这是设计不是故障
         （§3.3：屋顶的入侵方式由攀爬/跳跃/远程承担）。
         退回二维追击，让它在下方持续施压，不计入导航失败。 */
      nv.noPath = true; nv.stuck = 0;
      this.stepPhysics(e, dt);
      return false;
    }
    nv.noPath = false;

    /* 同层相邻区域之间只是走过去，不进入任何特殊状态 */
    if (step.kind === 'walk') { nv.stuck = 0; this.stepPhysics(e, dt); return false; }

    /* 走向连接点入口 */
    const dx = step.a.x - e.pos.x, dz = step.a.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.4 && Math.abs(e.pos.y - step.a.y) < 2.6) {
      nv.link = step; nv.linkT = 0; nv.hpAtClimb = e.hp / e.maxHp;
      nv.stuck = 0; nv.lastD = undefined;
      if (step.kind === 'climb') {
        /* §5.1 攀爬前播放抓墙提示 */
        Audio2.telegraph(e.pos, 'climb');
        e.hurtFlash = Math.max(e.hurtFlash, 0.25);
      } else if (step.kind === 'jump') {
        Audio2.telegraph(e.pos, 'charge');
      }
      return true;
    }
    const sp = e.speed * (step.kind === 'climb' ? 1.0 : 1.12);
    e.pos.x += (dx / Math.max(d, 1e-4)) * sp * dt;
    e.pos.z += (dz / Math.max(d, 1e-4)) * sp * dt;
    R.collide(e.pos, e.radius, e.pos.y + 0.2, e.pos.y + e.height);
    this.stepPhysics(e, dt);

    /* “卡住”必须按进展衡量，不能按耗时衡量：
       连接点可能在 20m 外，正常走过去就要 7 秒，按耗时判定会把健康的寻路
       全部误判成失败。只有“朝目标一直没有推进”才算堆在墙脚（§5.2）。 */
    if (nv.lastD === undefined || d < nv.lastD - 0.25) { nv.lastD = d; nv.stuck = 0; }
    else {
      nv.stuck += dt;
      if (nv.stuck > TUNE.VERTICAL_ENEMY.navStuckTime) {
        nv.region = null; nv.stuck = 0; nv.lastD = undefined;
        this.stats.navFail++;
      }
    }
    e.grp.position.copy(e.pos);
    e.grp.rotation.y = Math.atan2(dx, dz);
    return true;
  },

  /* §5.1 攀爬过程中可以被玩家射落 */
  onDamaged(e) {
    const nv = e.nav;
    if (!nv || !nv.link || nv.link.kind !== 'climb') return;
    if (e.hp / e.maxHp < nv.hpAtClimb - 0.2) {
      const l = nv.link;
      nv.link = null; nv.linkT = 0; nv.vy = -2;
      nv.region = l.from;
      nv.recover = 0.4;
      this.stats.shotOffWall++;
      R.puff(TV.copy(e.pos), 0.2, 1.4, 0xff8a4a, 0.24);
    }
  },

  /* ------------------------------------------------ 防站桩导演 §5.4 */
  /* 压力逐级增加：先攀爬、再跳跃截击、最后远程压制。
     普通高处停留本身不惩罚，只有长期无风险站桩才触发修正。 */
  updateCamp(dt) {
    if (!this.enabled) return;
    const V = TUNE.VERTICAL_ENEMY, p = G.player;
    const c = this.camp;
    const moved = Math.hypot(p.pos.x - c.x, p.pos.z - c.z);
    if (moved > V.antiCampRadius) {
      c.x = p.pos.x; c.z = p.pos.z;
      c.t = Math.max(0, c.t - V.antiCampDecay * dt * 4);
    } else {
      c.t += dt;
    }
    /* 只有离开街道层的长期停留才计入 —— 街面本来就该是主战场 */
    if (CITY.layerOf(p.pos.y) === 'street') c.t = Math.max(0, c.t - V.antiCampDecay * dt);

    const s = c.t >= V.antiCampStage3 ? 3 : c.t >= V.antiCampStage2 ? 2 : c.t >= V.antiCampStage1 ? 1 : 0;
    if (s !== c.stage) {
      c.stage = s;
      c.method = ['-', '攀爬压力', '跳跃截击', '远程压制'][s];
      if (s > 0) G.bus.emit('antiCamp', { stage: s });
    }
  },

  /* 导演按当前压力阶段决定这次该刷什么 —— 不在固定秒数突然刷脸 */
  campTemplate() {
    const s = this.camp.stage;
    if (s <= 0) return null;
    const pool = [];
    if (s >= 1) pool.push(ENEMIES.climber);
    if (s >= 2) pool.push(ENEMIES.leaper);
    if (s >= 3) pool.push(ENEMIES.roofcaster);
    return RNG.spawn.pick(pool);
  },

  /* Debug：导航区域、连接边与敌人路径（§11.1） */
  debugDraw(on) {
    if (!this._dbg) {
      this._dbg = new THREE.Group();
      this._dbg.visible = false;
      R.scene.add(this._dbg);
      const rm = new THREE.MeshBasicMaterial({ color: 0x35e0ff, wireframe: true, transparent: true, opacity: 0.35 });
      CITY.regions.forEach(r => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(r.x1 - r.x0, 0.25, r.z1 - r.z0), rm);
        m.position.set(r.cx, r.y + 0.2, r.cz);
        this._dbg.add(m);
      });
      const lm = { climb: 0xffc14d, jump: 0xff4d5e, drop: 0x9a7fff, stairs: 0x7ef0a8, zip: 0xff8a1e, walk: 0x445566 };
      CITY.links.forEach(l => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([l.a.x, l.a.y + 0.4, l.a.z, l.b.x, l.b.y + 0.4, l.b.z]), 3));
        this._dbg.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: lm[l.kind] || 0xffffff })));
      });
    }
    this._dbg.visible = on;
  }
};
