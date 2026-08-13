/* ============================================================================
   SYMBIOTIC FIRE · 城市尺度地图（todo4）—— 阶段 A：纯灰盒

   设计口令（todo4 §0）：放大世界，减少东西；延长动作，降低噪声；让建筑本身成为玩法。

   本文件此刻只负责阶段 A 允许的内容：
     地面 / 主干道 / 次级街道 / 人行道 / 小巷 / 6~8 个建筑大体块 /
     自然边界与远景楼群 / 基础碰撞。
   §10 明确规定阶段 A 不制作滑索、跳板、动态事件、车辆群、栏杆和地图卡 ——
   这些要等 Bao 认可「像城市且尺度成立」之后，才在阶段 B 起逐步加入。

   一条纪律写在最前面（§0.1）：先有道路、街区和建筑大体块，
   再有移动路线，最后才有装饰物。顺序反了就会重新长成 todo3 那样的积木堆。
   ========================================================================== */
'use strict';

const CITYSCALE = {
  /* 首轮尺度（todo4 §2.1）。全部集中在这里，试玩后按「原值→改值→原因」修改。 */
  S: {
    halfX: 110, halfZ: 90,          // 可玩范围 220×180m
    mainRoad: 28,                   // 主干道走廊总宽（含两侧人行道）
    crossRoad: 18,                  // 次级街道走廊总宽
    walk: 4.5,                      // 单侧人行道
    alley: 8,                       // 小巷
    curb: 0.15,                     // 路沿高度（不参与碰撞，玩家直接跨过）
    shopH: 6.0,                     // 低层商铺 5~7m
    garageH: 15.0,                  // 停车楼 14~20m
    podiumH: 9.0,                   // 裙楼
    towerH: 36.0,                   // 可玩高楼 30~40m
    siteH: 30.0,                     // 在建大楼 25~35m
    fillerH: [20, 26],              // 围合街区
    farH: [60, 100],                // 远景天际线
    floorSpacing: 3.4               // 楼层线间距，用来建立真实楼层感
  },

  blocks: [],                        // 记录大体块，供审计与 Debug 使用

  build(C) {
    const S = this.S;
    C.half = Math.max(S.halfX, S.halfZ);
    C.halfX = S.halfX; C.halfZ = S.halfZ;
    this.blocks.length = 0;

    this._ground(C);
    this._roads(C);
    this._northWest(C);              // 低层商街：翻越后长距离屋顶奔跑
    this._northEast(C);              // 停车楼：一条宽大连续坡道
    this._southWest(C);              // 办公塔 + 裙楼：长立面墙跑
    this._southEast(C);              // 在建大楼：大楼板跨越
    this._fillers(C);                // 只负责围合街道与遮挡刷新
    this._boundary(C);               // 街区封锁 / 废墟，不做贴脸围墙
    this._skyline(C);                // 远景，不可碰撞
    this._scaleProps(C);             // 尺度参照：路灯与门（全部不参与碰撞）
    return this;
  },

  /* ---------------------------------------------------------------- 地面 */
  _ground(C) {
    const S = this.S;
    const g = new THREE.Mesh(new THREE.PlaneGeometry(S.halfX * 2 + 80, S.halfZ * 2 + 80),
      new THREE.MeshLambertMaterial({ color: 0x14181f }));
    g.rotation.x = -Math.PI / 2;
    C.group.add(g);
    /* 唯一的地面碰撞体 */
    C.addBox(0, -1, 0, S.halfX * 2 + 80, 2, S.halfZ * 2 + 80, { noDraw: true, surf: SURF.DECK });
  },

  /* ------------------------------------------------------- 道路与人行道 */
  /* §2.2：尺度主要由低成本视觉线索建立 —— 车道线、斑马线、路沿、人行道。
     这些全部不参与碰撞（§6.1），只负责让玩家读懂比例。 */
  _roads(C) {
    const S = this.S;
    const mainHalf = S.mainRoad / 2, crossHalf = S.crossRoad / 2;
    const carMain = mainHalf - S.walk, carCross = crossHalf - S.walk;

    /* 车行道 */
    C.addBox(0, 0.02, 0, S.halfX * 2, 0.04, carMain * 2, { noCollide: true, mat: 'road', surf: SURF.DECOR });
    C.addBox(0, 0.02, 0, carCross * 2, 0.04, S.halfZ * 2, { noCollide: true, mat: 'road', surf: SURF.DECOR });

    /* 人行道：抬高一个路沿，靠高度差读出人车尺度 */
    [-1, 1].forEach(sd => {
      C.addBox(0, S.curb / 2, sd * (carMain + S.walk / 2), S.halfX * 2, S.curb, S.walk,
        { noCollide: true, mat: 'walk', surf: SURF.DECOR });
      C.addBox(sd * (carCross + S.walk / 2), S.curb / 2, 0, S.walk, S.curb, S.halfZ * 2,
        { noCollide: true, mat: 'walk', surf: SURF.DECOR });
    });

    /* 车道线：主干道双向分隔 + 虚线 */
    for (let x = -S.halfX; x < S.halfX; x += 8) {
      C.addBox(x + 2, 0.05, 0, 4.2, 0.02, 0.36, { noCollide: true, mat: 'line', surf: SURF.DECOR });
    }
    for (let z = -S.halfZ; z < S.halfZ; z += 8) {
      if (Math.abs(z) < carMain + 1) continue;
      C.addBox(0, 0.05, z + 2, 0.32, 0.02, 4.2, { noCollide: true, mat: 'line', surf: SURF.DECOR });
    }
    /* 斑马线：四个路口，一眼确立「一个人有多宽」 */
    const zebra = (cx, cz, horiz) => {
      for (let i = -3; i <= 3; i++) {
        const o = i * 1.5;
        C.addBox(horiz ? cx : cx + o, 0.05, horiz ? cz + o : cz,
          horiz ? 5.0 : 0.7, 0.02, horiz ? 0.7 : 5.0,
          { noCollide: true, mat: 'line', surf: SURF.DECOR });
      }
    };
    zebra(-crossHalf - 3.5, 0, true); zebra(crossHalf + 3.5, 0, true);
    zebra(0, -mainHalf - 3.5, false); zebra(0, mainHalf + 3.5, false);
  },

  /* 建筑登记：一个大体块 = 一个碰撞盒 + 若干不参与碰撞的楼层线。
     §2.2 要求建筑有按真实楼层间距重复的窗带或结构线，否则大盒子读不出高度。 */
  _building(C, id, name, x0, x1, z0, z1, h, mat, opts) {
    opts = opts || {};
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const sx = x1 - x0, sz = z1 - z0;
    C.addBox(cx, h / 2, cz, sx, h, sz, { mat: mat, surf: opts.surf === undefined ? SURF.SOLID : opts.surf });
    /* 楼层线：只在朝向街道的两个面上画，控制在总量可接受的范围内 */
    if (!opts.noFloors) {
      const sp = this.S.floorSpacing;
      for (let y = sp; y < h - 0.4; y += sp) {
        C.addBox(cx, y, z0 - 0.06, sx * 0.985, 0.10, 0.12, { noCollide: true, mat: 'line', surf: SURF.DECOR });
        C.addBox(cx, y, z1 + 0.06, sx * 0.985, 0.10, 0.12, { noCollide: true, mat: 'line', surf: SURF.DECOR });
      }
    }
    this.blocks.push({ id: id, name: name, x0: x0, x1: x1, z0: z0, z1: z1, h: h,
      playable: !!opts.playable, zone: opts.zone || null });
    return { cx: cx, cz: cz, sx: sx, sz: sz, h: h };
  },

  /* ------------------------------ 西北：低层商街（可玩：长屋顶奔跑） ---- */
  /* §3.1 主要移动动词 = 翻越后长距离屋顶奔跑。
     两段长屋顶各约 40m，中间隔一条 8m 小巷 —— §4.2 要求单段 20~40m 连续移动，
     且屋顶之间最多连续跨越一两次，绝不做长串碎平台。 */
  _northWest(C) {
    const S = this.S;
    this._building(C, 'shopA', '商街西段', -100, -58, -46, -16, S.shopH, 'shop', { playable: true, zone: 'shops' });
    this._building(C, 'shopB', '商街东段', -50, -9, -46, -16, S.shopH, 'shop', { playable: true, zone: 'shops' });
  },

  /* -------------------------- 东北：停车楼（可玩：一条宽大连续坡道） ---- */
  /* §3.1 主要移动动词 = 沿宽坡道持续上升或下降，把追兵拉成长队。
     整栋楼只做这一件事，不再往上堆脚手架、跳板和攀爬砖（§3.1 最后一条）。 */
  _northEast(C) {
    const S = this.S;
    /* 楼体主动让出西侧 14m 作为坡道槽 —— 坡道绝不能嵌在实心楼体内部，
       否则玩家站上坡面就会被水平推出去。 */
    this._building(C, 'garage', '停车楼', 30, 88, -72, -16, S.garageH, 'garage',
      { playable: true, zone: 'garage' });
    /* 一条宽 14m、长 58m 的连续坡道，从街口直上顶层。
       真斜面，不是台阶盒 —— §6.2 明确禁止可见的坡道碰撞台阶。 */
    C.addSlope(23, -43, 14, 58, 0.1, S.garageH, 'z', { mat: 'garage' });
    /* 顶层楼板：坡道尽头就是可跑的大平面，顶面与坡道顶端齐平，不留台阶 */
    C.addBox(52, S.garageH - 0.25, -44, 72, 0.5, 56, { mat: 'garage', surf: SURF.DECK });
  },

  /* ------------------ 西南：办公塔 + 裙楼（可玩：长立面横向墙跑） ------ */
  /* §3.1 主要移动动词 = 长距离横向墙跑与一次换层。
     裙楼给出一条 90m 的连续立面，是全图最长的一面墙。 */
  _southWest(C) {
    const S = this.S;
    this._building(C, 'podium', '办公裙楼', -100, -9, 16, 30, S.podiumH, 'office',
      { playable: true, surf: SURF.WALLRUN, zone: 'office' });
    this._building(C, 'tower', '办公塔', -72, -30, 38, 80, S.towerH, 'office', { playable: true, zone: 'office' });
  },

  /* ----------------------- 东南：在建大楼（可玩：大楼板跨越） ---------- */
  /* §3.1 主要移动动词 = 大平台跨越。§3.2 要求删掉四层密集脚手架，
     若保留施工楼层只保留少量完整大楼板 —— 这里只有 2 层。 */
  _southEast(C) {
    const S = this.S;
    /* 在建大楼是「框架 + 大楼板」，不是实心盒：
       实心盒里塞楼板会让玩家站在楼板上却被楼体推开。
       同时这也才像一栋没封顶的楼 —— 远处一眼就能认出轮廓（§3.1）。 */
    const x0 = 16, x1 = 78, z0 = 16, z1 = 70;
    [[x0 + 4, z0 + 4], [x1 - 4, z0 + 4], [x0 + 4, z1 - 4], [x1 - 4, z1 - 4]].forEach(([cx, cz]) => {
      C.addBox(cx, S.siteH / 2, cz, 5, S.siteH, 5, { mat: 'site', surf: SURF.WALLRUN });
    });
    /* 核心筒：给建筑一个实体重心，也是唯一的实心部分 */
    C.addBox((x0 + x1) / 2, S.siteH / 2, (z0 + z1) / 2, 16, S.siteH, 16, { mat: 'site', surf: SURF.SOLID });
    /* 两层完整大楼板 —— §3.2 要求删掉密集脚手架，只保留少量完整楼板 */
    [12.0, 21.0].forEach(y => {
      C.addBox((x0 + x1) / 2, y, (z0 + z1) / 2, x1 - x0, 0.6, z1 - z0, { mat: 'site', surf: SURF.DECK });
    });
    this.blocks.push({ id: 'site', name: '在建大楼', x0: x0, x1: x1, z0: z0, z1: z1,
      h: S.siteH, playable: true, zone: 'site' });
  },

  /* --------------------------- 围合街区：只负责形成城市峡谷与遮挡 ------ */
  _fillers(C) {
    const S = this.S, F = S.fillerH;
    this._building(C, 'fillN', '北侧街区', -100, -9, -84, -54, F[1], 'filler');
    this._building(C, 'fillNE', '东北街区', 94, 106, -84, -16, F[1], 'filler');
    this._building(C, 'fillW', '西侧街区', -106, -84, 38, 84, F[0], 'filler');
    this._building(C, 'fillSE', '东南街区', 86, 106, 16, 84, F[0], 'filler');
  },

  /* ------------------------------------------------------------ 边界 */
  /* §2.1：地图边界用街区封锁、废墟或不可进入建筑自然表达，
     不使用贴脸的四面竞技场高墙。 */
  _boundary(C) {
    const S = this.S;
    const rubble = (x, z, sx, sz, h) =>
      C.addBox(x, h / 2, z, sx, h, sz, { mat: 'filler', surf: SURF.SOLID });
    /* 主干道东西两端：塌方与集装箱堆把街道自然封住 */
    rubble(-S.halfX + 4, 0, 10, S.mainRoad + 6, 9);
    rubble(S.halfX - 4, 0, 10, S.mainRoad + 6, 9);
    /* 次级街道南北两端 */
    rubble(0, -S.halfZ + 4, S.crossRoad + 6, 10, 9);
    rubble(0, S.halfZ - 4, S.crossRoad + 6, 10, 9);
    /* 四角用不可进入的街区补齐，避免玩家跑到空地上 */
    /* 四角必须整体落在可玩边界之内，否则站上楼顶会被判成越界 */
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
      C.addBox(sx * (S.halfX - 16), 12, sz * (S.halfZ - 16), 24, 24, 24, { mat: 'filler', surf: SURF.SOLID });
    });
  },

  /* --------------------------------------------------- 远景天际线 */
  /* §2.1：远景楼群不可碰撞、不可伪装成可达区域。 */
  _skyline(C) {
    const S = this.S;
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + 0.13;
      const d = 190 + (i % 6) * 42;
      const h = S.farH[0] + (i * 13 % (S.farH[1] - S.farH[0]));
      const w = 26 + (i % 5) * 12;
      C.addBox(Math.cos(a) * d, h / 2, Math.sin(a) * d, w, h, w,
        { noCollide: true, mat: 'far', surf: SURF.DECOR });
    }
  },

  /* ------------------------------------------------- 尺度参照物 */
  /* §2.2：车辆尺寸、门高和路灯高度必须与玩家保持一致。
     阶段 A 不做车辆群，但路灯与门洞是判断比例的最低成本依据，且全部不参与碰撞。 */
  _scaleProps(C) {
    const S = this.S;
    const carMain = S.mainRoad / 2 - S.walk;
    for (let x = -S.halfX + 14; x < S.halfX - 10; x += 26) {
      [-1, 1].forEach(sd => {
        const z = sd * (carMain + S.walk * 0.75);
        C.addBox(x, 2.6, z, 0.22, 5.2, 0.22, { noCollide: true, mat: 'line', surf: SURF.DECOR });
        C.addBox(x + sd * 0.9, 5.15, z, 2.0, 0.16, 0.22, { noCollide: true, mat: 'line', surf: SURF.DECOR });
      });
    }
    /* 商街门洞：2.2m 高，是全图最直接的人体尺度参照 */
    for (let x = -96; x < -12; x += 7) {
      C.addBox(x, 1.1, -15.9, 1.6, 2.2, 0.2, { noCollide: true, mat: 'road', surf: SURF.DECOR });
    }
  },

  /* ====================================================================== */
  /* 阶段 A 的导航：地面连续即可。
     低屋顶与高空的连接是阶段 B/C 的内容，这里不预埋 —— §0.1 要求
     先有街区与体块，再有路线。 */
  buildNav(C) {
    const S = this.S;
    const R2 = (id, x0, x1, z0, z1) => C._region(id, 'street', x0, x1, z0, z1, 0);
    /* 主干道分段 + 次级街道分段：按 40~70m 的战斗单元尺度切（§7.1） */
    R2('rd_w2', -S.halfX, -60, -14, 14);
    R2('rd_w1', -60, -9, -14, 14);
    R2('plaza', -9, 9, -14, 14);
    R2('rd_e1', 9, 60, -14, 14);
    R2('rd_e2', 60, S.halfX, -14, 14);
    R2('rd_n1', -9, 9, -52, -14);
    R2('rd_n2', -9, 9, -S.halfZ, -52);
    R2('rd_s1', -9, 9, 14, 52);
    R2('rd_s2', -9, 9, 52, S.halfZ);
    /* 小巷：商街之间那条，是地面路线的第二条分流（§4.1） */
    R2('alley_nw', -58, -50, -46, -14);
    C._autoAdjacency();
    const byId = {};
    C.regions.forEach(r => { byId[r.id] = r; });
    C.byId = byId;
    C.links.forEach(l => { const r = byId[l.from]; if (r) r.links.push(l); });
  },

  /* 阶段 A 的刷怪点：只有街面。
     §7.2 要求从街口、巷口、车辆或建筑转角外出现，不允许在宽阔街道中心凭空生成。 */
  buildSpawnPoints(C) {
    const S = this.S;
    const add = (x, z) => {
      if (!C.standable(x, z, 1.0, 0.5)) return;
      C.spawnPoints.push({ x: x, y: C.dropTo(x, z, 2.0, 0.5), z: z, layer: 'street', cover: 'corner' });
    };
    /* 建筑转角外侧 —— 玩家看不见的那一侧 */
    this.blocks.forEach(b => {
      if (b.h < 4) return;
      const pad = 3.2;
      add(b.x0 - pad, b.z0 - pad); add(b.x1 + pad, b.z0 - pad);
      add(b.x0 - pad, b.z1 + pad); add(b.x1 + pad, b.z1 + pad);
    });
    /* 巷口与街口 */
    [[-54, -12], [-54, -48], [0, -52], [0, 52], [-62, 0], [62, 0], [12, -14], [-12, 14]]
      .forEach(([x, z]) => add(x, z));
  },

  /* ---------------------------------------------------- 审计用测量 */
  /* §11.1：玩家跨越地图长边、短边的徒步时间。
     这里给出理论值，实测由 _scalecheck.html 跑出来。 */
  measure() {
    const S = this.S, sp = TUNE.PLAYER.moveSpeed;
    return {
      playable: (S.halfX * 2) + '×' + (S.halfZ * 2) + 'm',
      walkLong: ((S.halfX * 2) / sp).toFixed(1) + 's',
      walkShort: ((S.halfZ * 2) / sp).toFixed(1) + 's',
      blocks: this.blocks.length,
      playableBlocks: this.blocks.filter(b => b.playable).length,
      /* §3.1 数的是「真正可玩的建筑」= 功能区，不是碰撞盒 */
      zones: Object.keys(this.blocks.filter(b => b.zone).reduce((m, b) => (m[b.zone] = 1, m), {})).length
    };
  }
};
