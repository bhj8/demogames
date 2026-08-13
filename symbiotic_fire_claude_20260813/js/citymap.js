/* ============================================================================
   SYMBIOTIC FIRE · 立体城市（todo3 §3）
   职责：几何构建 / AABB 碰撞世界 / 路线表面标记 / 落点与空投点验证。
   不拥有玩家移动状态机（movement.js）、敌人导航（nav3d.js）或事件导演（map-events.js），
   但三者共享这里的同一套区域与连接标识 —— §9 要求避免三份坐标各自维护。
   ========================================================================== */
'use strict';

/* 表面标签。渲染与判定共用同一套，禁止装饰物伪装成可攀爬路线（§3.5）。 */
const SURF = {
  SOLID: 0,      // 普通建筑体
  VAULT: 1,      // 可翻越矮障碍：统一高亮边条
  WALLRUN: 2,    // 可墙跑立面：统一灯带
  DECK: 3,       // 可站立楼板 / 平台
  DECOR: 4       // 纯装饰，明确不可作为路线
};

const CITY = {
  enabled: false,
  half: 35, halfX: 35, halfZ: 35,      // 非方形地图必须分轴，否则会把边界夹错
  solids: [],
  dynamics: {},          // 事件可切换的几何：id -> {solids:[], meshes:[], on}
  regions: [],
  links: [],
  devices: [],           // 滑索与跳板
  landmarks: [],
  spawnPoints: [],
  group: null,
  _grid: null, _cell: 6, _parts: null, _built: false,

  /* ------------------------------------------------------------------ 构建 */
  build(scene, layout) {
    const M = TUNE.VERTICAL_MAP;
    this.half = M.half; this.halfX = M.half; this.halfZ = M.half;
    this._cell = M.spawnCell;
    this.solids.length = 0;
    this.regions.length = 0;
    this.links.length = 0;
    this.devices.length = 0;
    this.landmarks.length = 0;
    this.spawnPoints.length = 0;
    this.dynamics = {};
    this.climbAnchors = [];
    this._zipPend = null;
    this._parts = {};
    this.group = new THREE.Group();
    scene.add(this.group);

    this.layout = layout || 'vertical-old';
    if (this.layout === 'city-scale') {
      /* todo4：城市尺度地图。布局与旧立体地图完全独立，
         CITY 只提供碰撞、查询与层级 API，几何由 city-scale.js 注册。 */
      CITYSCALE.build(this);
      this._flushParts();
      this.reindex();
      CITYSCALE.buildNav(this);
      CITYSCALE.buildSpawnPoints(this);
    } else {
      this._buildShell();
      this._buildStreet();
      this._buildParking();
      this._buildConstruction();
      this._buildHospital();
      this._buildMall();
      this._buildMidRing();
      this._buildDevices();
      this._buildDynamics();

      this._flushParts();
      this._mountZips();
      this.reindex();
      this._buildNav();
      this._buildSpawnPoints();
    }
    this._built = true;
    this.enabled = true;
    return this;
  },

  /* --- 几何登记 ---------------------------------------------------------
     addBox 用中心 + 尺寸，和 render.js 的 mat4 保持一致。
     mesh 合并按材质分组，一种材质一个 draw call。 */
  addBox(x, y, z, sx, sy, sz, opts) {
    opts = opts || {};
    const s = {
      x0: x - sx / 2, x1: x + sx / 2,
      y0: y - sy / 2, y1: y + sy / 2,
      z0: z - sz / 2, z1: z + sz / 2,
      surf: opts.surf === undefined ? SURF.SOLID : opts.surf,
      id: opts.id || null,
      on: true
    };
    if (!opts.noCollide) this.solids.push(s);
    if (!opts.noDraw) {
      const key = opts.mat || 'concrete';
      (this._parts[key] || (this._parts[key] = [])).push({ geo: R.geo.box, mat: mat4(x, y, z, sx, sy, sz) });
      /* §3.5 统一可读性语言：可翻越边缘加高亮边条，可墙跑立面加灯带。
         标识由标签自动生成，避免美术与判定漂移。 */
      if (s.surf === SURF.VAULT) {
        (this._parts.edge || (this._parts.edge = [])).push(
          { geo: R.geo.box, mat: mat4(x, s.y1 + 0.03, z, sx * 1.02, 0.07, sz * 1.02) });
      }
    }
    if (opts.dyn) {
      const d = this.dynamics[opts.dyn] || (this.dynamics[opts.dyn] = { solids: [], meshes: [], on: true });
      d.solids.push(s);
    }
    return s;
  },

  /* --- 斜面 ---
     todo4 §6.2 点名禁止「可见的坡道碰撞台阶」，所以坡道不再用台阶近似，
     而是一个带高度函数的实体：表面高度沿 axis 线性插值，
     碰撞按「你在斜面之上就站住、在斜面之内才被推出」处理。
     可见模型是一块旋转过的连续板，与碰撞体各自独立（§6.2 可见/碰撞分离）。 */
  addSlope(cx, cz, sx, sz, yLow, yHigh, axis, opts) {
    opts = opts || {};
    const s = {
      x0: cx - sx / 2, x1: cx + sx / 2,
      z0: cz - sz / 2, z1: cz + sz / 2,
      y0: Math.min(yLow, yHigh) - (opts.thickness || 1.2), y1: Math.max(yLow, yHigh),
      surf: SURF.DECK, id: opts.id || null, on: true,
      ramp: { axis: axis, lo: yLow, hi: yHigh }
    };
    this.solids.push(s);
    if (!opts.noDraw) {
      const len = axis === 'x' ? sx : sz;
      const rise = yHigh - yLow;
      const ang = Math.atan2(rise, len);
      const m = new THREE.Mesh(R.geo.box,
        this._mats ? this._mats[opts.mat || 'deck'] : new THREE.MeshLambertMaterial({ color: 0x333d4c }));
      m.position.set(cx, (yLow + yHigh) / 2, cz);
      m.userData = { mat: opts.mat || 'garage' };
      if (axis === 'x') { m.rotation.z = -ang; m.scale.set(Math.hypot(len, rise), 0.5, sz); }
      else { m.rotation.x = ang; m.scale.set(sx, 0.5, Math.hypot(len, rise)); }
      this._slopeMeshes = this._slopeMeshes || [];
      this._slopeMeshes.push(m);
    }
    return s;
  },

  /* 斜面在 (x,z) 处的表面高度 */
  rampY(s, x, z) {
    const r = s.ramp;
    const t = r.axis === 'x'
      ? (x - s.x0) / Math.max(1e-6, s.x1 - s.x0)
      : (z - s.z0) / Math.max(1e-6, s.z1 - s.z0);
    return lerp(r.lo, r.hi, clamp(t, 0, 1));
  },

  /* 阶梯化坡道：保留给旧立体地图，新地图一律用 addSlope。 */
  addRamp(x0, z0, x1, z1, y0, y1, width, mat) {
    const rise = y1 - y0;
    const steps = Math.max(2, Math.ceil(rise / (TUNE.MOVEMENT.stepHeight * 0.8)));
    for (let i = 0; i < steps; i++) {
      const k0 = i / steps, k1 = (i + 1) / steps;
      const cx = lerp(x0, x1, (k0 + k1) / 2), cz = lerp(z0, z1, (k0 + k1) / 2);
      const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
      const len = Math.hypot(dx, dz) / steps + 0.05;
      const top = y0 + rise * k1;
      const sx = dx > dz ? len : width, sz = dx > dz ? width : len;
      this.addBox(cx, top / 2, cz, sx, top, sz, { surf: SURF.DECK, mat: mat || 'deck' });
    }
  },

  _flushParts() {
    const mats = {
      concrete: new THREE.MeshLambertMaterial({ color: 0x262d38 }),
      deck:     new THREE.MeshLambertMaterial({ color: 0x333d4c }),
      parking:  new THREE.MeshLambertMaterial({ color: 0x2c3a4e }),
      build:    new THREE.MeshLambertMaterial({ color: 0x3a2f2a }),
      hospital: new THREE.MeshLambertMaterial({ color: 0x27403a }),
      mall:     new THREE.MeshLambertMaterial({ color: 0x352a40 }),
      prop:     new THREE.MeshLambertMaterial({ color: 0x3d4654 }),
      decor:    new THREE.MeshLambertMaterial({ color: 0x1b212b }),
      /* todo4 城市尺度：不可玩建筑与可玩建筑在材质上必须能分开（§6.3） */
      road:     new THREE.MeshLambertMaterial({ color: 0x1a1f27 }),
      walk:     new THREE.MeshLambertMaterial({ color: 0x2b323c }),
      shop:     new THREE.MeshLambertMaterial({ color: 0x4a3f34 }),
      garage:   new THREE.MeshLambertMaterial({ color: 0x39434f }),
      office:   new THREE.MeshLambertMaterial({ color: 0x2c3646 }),
      site:     new THREE.MeshLambertMaterial({ color: 0x4d3f2c }),
      filler:   new THREE.MeshLambertMaterial({ color: 0x222833 }),
      far:      new THREE.MeshLambertMaterial({ color: 0x171c25 }),
      line:     new THREE.MeshBasicMaterial({ color: 0x6b7482 }),
      /* 路线语言：三种标识各自唯一，且都不复用变异色 */
      edge:     new THREE.MeshBasicMaterial({ color: 0xffc14d }),                 // 可翻越
      band:     new THREE.MeshBasicMaterial({ color: 0x35e0ff }),                 // 可墙跑
      device:   new THREE.MeshBasicMaterial({ color: 0xff8a1e })                  // 滑索/跳板/锚点
    };
    for (const k in this._parts) {
      const list = this._parts[k];
      if (!list.length) continue;
      const mesh = new THREE.Mesh(mergeGeom(list), mats[k] || mats.concrete);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this._parts = null;
    this._mats = mats;
    if (this._slopeMeshes) {
      this._slopeMeshes.forEach(m => { m.material = mats[m.userData.mat || 'garage']; this.group.add(m); });
      this._slopeMeshes = null;
    }
  },

  /* ------------------------------------------------------------ 宽相位索引 */
  reindex() {
    const c = this._cell;
    this._grid = new Map();
    for (let i = 0; i < this.solids.length; i++) {
      const s = this.solids[i];
      if (!s.on) continue;
      const ix0 = Math.floor(s.x0 / c), ix1 = Math.floor(s.x1 / c);
      const iz0 = Math.floor(s.z0 / c), iz1 = Math.floor(s.z1 / c);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = ((ix & 511) << 9) | (iz & 511);
          let b = this._grid.get(k);
          if (!b) { b = []; this._grid.set(k, b); }
          b.push(s);
        }
      }
    }
  },

  _q: [],
  query(x0, x1, z0, z1) {
    const out = this._q; out.length = 0;
    if (!this._grid) return out;
    const c = this._cell;
    const ix0 = Math.floor(x0 / c), ix1 = Math.floor(x1 / c);
    const iz0 = Math.floor(z0 / c), iz1 = Math.floor(z1 / c);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const b = this._grid.get(((ix & 511) << 9) | (iz & 511));
        if (!b) continue;
        for (let i = 0; i < b.length; i++) {
          const s = b[i];
          if (s.on && s._qm !== this._qtick) { s._qm = this._qtick; out.push(s); }
        }
      }
    }
    return out;
  },
  _qtick: 0,
  beginQuery() { this._qtick++; },

  /* ------------------------------------------------------------------ 碰撞 */

  /* 圆柱 vs AABB 的水平推出。返回是否发生了推出，并累计墙面法线。 */
  depenetrate(pos, radius, yBot, yTop, hit) {
    this.beginQuery();
    const list = this.query(pos.x - radius, pos.x + radius, pos.z - radius, pos.z + radius);
    let touched = false;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (yTop <= s.y0 + 1e-4 || yBot >= s.y1 - 1e-4) continue;
        /* 斜面：只有当脚底明显低于该处坡面时才算撞进坡体，
           否则玩家是「站在坡上」，绝不能被水平推开。 */
        if (s.ramp && yBot >= this.rampY(s, clamp(pos.x, s.x0, s.x1), clamp(pos.z, s.z0, s.z1)) - 0.35) continue;
        const cx = clamp(pos.x, s.x0, s.x1), cz = clamp(pos.z, s.z0, s.z1);
        const dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        let nx, nz, push;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          nx = dx / d; nz = dz / d; push = radius - d;
        } else {
          /* 圆心落在盒内：沿最浅的一侧推出 */
          const px0 = pos.x - s.x0, px1 = s.x1 - pos.x;
          const pz0 = pos.z - s.z0, pz1 = s.z1 - pos.z;
          const m = Math.min(px0, px1, pz0, pz1);
          if (m === px0) { nx = -1; nz = 0; push = px0 + radius; }
          else if (m === px1) { nx = 1; nz = 0; push = px1 + radius; }
          else if (m === pz0) { nx = 0; nz = -1; push = pz0 + radius; }
          else { nx = 0; nz = 1; push = pz1 + radius; }
        }
        pos.x += nx * push; pos.z += nz * push;
        moved = true; touched = true;
        if (hit) {
          hit.any = true;
          hit.nx = nx; hit.nz = nz; hit.solid = s;
          if (s.surf === SURF.WALLRUN) { hit.wallrun = true; hit.wnx = nx; hit.wnz = nz; hit.wsolid = s; }
          if (s.y1 > hit.topY && s.y1 <= yBot + TUNE.MOVEMENT.vaultMaxHeight) hit.topY = s.y1;
        }
      }
      if (!moved) break;
    }
    return touched;
  },

  /* 脚下支撑面：返回 [fromY - down, fromY + up] 区间内最高的顶面，找不到返回 -Infinity */
  supportY(x, z, radius, fromY, down, up) {
    this.beginQuery();
    const list = this.query(x - radius, x + radius, z - radius, z + radius);
    let best = -Infinity;
    const lo = fromY - down, hi = fromY + up;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const cx = clamp(x, s.x0, s.x1), cz = clamp(z, s.z0, s.z1);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz >= radius * radius) continue;
      /* 斜面按脚下位置求表面高度，而不是按包围盒顶面 */
      const top = s.ramp ? this.rampY(s, clamp(x, s.x0, s.x1), clamp(z, s.z0, s.z1)) : s.y1;
      if (top < lo || top > hi) continue;
      if (top > best) best = top;
    }
    return best;
  },

  /* 头顶净空：返回 fromY 之上最低的底面 */
  ceilingY(x, z, radius, fromY) {
    this.beginQuery();
    const list = this.query(x - radius, x + radius, z - radius, z + radius);
    let best = Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.y0 < fromY - 1e-3) continue;
      const cx = clamp(x, s.x0, s.x1), cz = clamp(z, s.z0, s.z1);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz >= radius * radius) continue;
      if (s.y0 < best) best = s.y0;
    }
    return best;
  },

  /* 某点是否可以站立：有支撑、且支撑之上有足够净空。
     医疗、空投与刷怪点全部走它 —— §5.3 / §6.2 / §6.3 要求验证可达且可站立。 */
  standable(x, z, y, radius, need) {
    const r = radius || 0.6, h = need || TUNE.MOVEMENT.headroom;
    if (Math.abs(x) > this.halfX - 1.5 || Math.abs(z) > this.halfZ - 1.5) return false;
    const sup = this.supportY(x, z, r, y, 0.9, 0.9);
    if (sup === -Infinity) return false;
    return this.ceilingY(x, z, r, sup + 0.05) >= sup + h;
  },

  /* 从高处竖直下落找落脚面 —— 空投不能穿过屋顶落进模型内部（§6.3） */
  dropTo(x, z, fromY, radius) {
    const r = radius || 0.6;
    this.beginQuery();
    const list = this.query(x - r, x + r, z - r, z + r);
    let best = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.y1 > fromY + 0.01) continue;
      const cx = clamp(x, s.x0, s.x1), cz = clamp(z, s.z0, s.z1);
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz >= r * r) continue;
      if (s.y1 > best) best = s.y1;
    }
    return best;
  },

  /* 前向探测一段线段是否被挡（滑索、跳跃怪落点、可见性粗判用） */
  segBlocked(x0, y0, z0, x1, y1, z1) {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 1.1));
    for (let i = 1; i < steps; i++) {
      const k = i / steps;
      const x = lerp(x0, x1, k), y = lerp(y0, y1, k), z = lerp(z0, z1, k);
      this.beginQuery();
      const list = this.query(x - 0.05, x + 0.05, z - 0.05, z + 0.05);
      for (let j = 0; j < list.length; j++) {
        const s = list[j];
        if (x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1 && y > s.y0 && y < s.y1) return true;
      }
    }
    return false;
  },

  /* 统一层级定义 §9：玩家与敌人共用 */
  layerOf(y) {
    const M = TUNE.VERTICAL_MAP;
    if (y < M.streetTop + 0.5) return 'street';
    if (y < M.midTop + 1.5) return 'mid';
    return 'roof';
  },
  layerIndex(y) { const l = this.layerOf(y); return l === 'street' ? 0 : l === 'mid' ? 1 : 2; },

  /* --------------------------------------------------------------- 布局 */
  _buildShell() {
    const H = this.half;
    /* 地面 */
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(H * 2, H * 2),
      new THREE.MeshLambertMaterial({ color: 0x1e242e }));
    floor.rotation.x = -Math.PI / 2;
    this.group.add(floor);
    this.addBox(0, -1, 0, H * 2, 2, H * 2, { noDraw: true, surf: SURF.DECK });

    const grid = new THREE.GridHelper(H * 2, 35, 0x2c3a4a, 0x232b36);
    grid.position.y = 0.014;
    grid.material.opacity = 0.4; grid.material.transparent = true;
    this.group.add(grid);

    /* 边界：高到不可翻越，明确是场地边缘而不是路线 */
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const cx = Math.round(Math.sin(a)) * H, cz = Math.round(Math.cos(a)) * H;
      this.addBox(cx, 11, cz, i % 2 ? 1.5 : H * 2, 22, i % 2 ? H * 2 : 1.5, { mat: 'decor', surf: SURF.DECOR });
    }
    /* 远景轮廓：纯装饰、无碰撞 */
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2, d = 52 + (i % 5) * 10;
      const h = 14 + (i * 7 % 30);
      this.addBox(Math.cos(a) * d, h / 2, Math.sin(a) * d, 8 + (i % 4) * 3, h, 8 + (i % 3) * 3,
        { noCollide: true, mat: 'decor', surf: SURF.DECOR });
    }
  },

  /* 地标一：中央十字路口 —— 主要街面战斗区与高密度经验区 */
  _buildStreet() {
    this.landmarks.push({ id: 'cross', name: '中央十字路口', x: 0, z: 0, y: 0, css: '#ffc14d' });

    /* 车辆 / 公交 / 集装箱 / 路障：全部 ≤1.2m 或可站立，构成第一条翻越教学 */
    const cars = [
      [-4.2, -5.5, 2.0, 1.1, 4.4], [4.0, -9.5, 2.0, 1.1, 4.4], [-3.6, 4.6, 2.0, 1.1, 4.4],
      [4.4, 11.0, 2.0, 1.1, 4.4], [-11.0, 2.4, 4.4, 1.1, 2.0], [12.5, -2.6, 4.4, 1.1, 2.0],
      [-16.0, -3.4, 4.4, 1.1, 2.0], [17.5, 3.2, 4.4, 1.1, 2.0]
    ];
    cars.forEach(([x, z, sx, sy, sz]) => this.addBox(x, sy / 2, z, sx, sy, sz, { surf: SURF.VAULT, mat: 'prop' }));

    /* 公交车：可站立的中继台，把街面和中层连起来 */
    const buses = [[-6.0, -16.5, 2.6, 3.0, 9.0], [6.2, 15.0, 2.6, 3.0, 9.0]];
    buses.forEach(([x, z, sx, sy, sz]) => this.addBox(x, sy / 2, z, sx, sy, sz, { surf: SURF.DECK, mat: 'prop' }));

    /* 集装箱：两级台阶，vault → 站上去 → 够到中层环 */
    const cont = [[-9.5, -9.5, 0, 2.4], [9.5, 9.5, 0, 2.4], [9.2, -9.2, 0, 2.4], [-9.2, 9.2, 0, 2.4]];
    cont.forEach(([x, z, y, h]) => {
      this.addBox(x, y + h / 2, z, 5.0, h, 2.6, { surf: SURF.DECK, mat: 'prop' });
      this.addBox(x + 3.4, y + 0.55, z, 1.6, 1.1, 2.6, { surf: SURF.VAULT, mat: 'prop' });
    });

    /* 店铺雨棚：街面 → 中层的第一段自然路线 */
    [[-7.6, -3.0], [7.6, 3.0], [-7.6, 13.0], [7.6, -13.0]].forEach(([x, z]) => {
      this.addBox(x, 3.4, z, 3.2, 0.3, 6.0, { surf: SURF.DECK, mat: 'prop' });
    });
  },

  /* 地标二：立体停车楼 —— 宽缓坡道、楼层绕行与快速跳楼路线 */
  _buildParking() {
    this.landmarks.push({ id: 'parking', name: '立体停车楼', x: 19, z: -19, y: 15, css: '#4fa8ff' });
    const x0 = 9, x1 = 29, z0 = -29, z1 = -9;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const decks = [5, 10, 15];
    decks.forEach((y, i) => {
      /* 楼板留出坡道井：x 23.5 以东是坡道 */
      const w = i === 2 ? (x1 - x0) : 14.5;
      const c = i === 2 ? cx : x0 + w / 2;
      this.addBox(c, y - 0.2, cz, w, 0.4, z1 - z0, { surf: SURF.DECK, mat: 'parking' });
      /* 外围矮护栏：可翻越，是主要的“跳楼”出口 */
      this.addBox(c, y + 0.5, z0 + 0.3, w, 1.0, 0.6, { surf: SURF.VAULT, mat: 'parking' });
      this.addBox(c, y + 0.5, z1 - 0.3, w, 1.0, 0.6, { surf: SURF.VAULT, mat: 'parking' });
      this.addBox(x0 + 0.3, y + 0.5, cz, 0.6, 1.0, z1 - z0, { surf: SURF.VAULT, mat: 'parking' });
    });
    /* 承重柱：立面可墙跑 */
    for (let i = 0; i < 4; i++) {
      const px = x0 + 2 + (i % 2) * 11, pz = z0 + 3 + Math.floor(i / 2) * 13;
      this.addBox(px, 7.5, pz, 1.2, 15, 1.2, { surf: SURF.WALLRUN, mat: 'parking' });
      this._band(px, 1.2, 1.2, pz, 15);
    }
    /* 宽缓坡道：ground → 5 → 10 → 15，全部用基础动作即可通过 */
    this.addRamp(26, z1 - 1.5, 26, z0 + 1.5, 0.4, 5, 5.0, 'parking');
    this.addRamp(26, z0 + 1.5, 26, z1 - 1.5, 5.2, 10, 5.0, 'parking');
    this.addRamp(26, z1 - 1.5, 26, z0 + 1.5, 10.2, 15, 5.0, 'parking');
  },

  /* 地标三：在建大楼与吊车 —— 墙跑、脚手架、吊车桥与楼间跨越 */
  _buildConstruction() {
    this.landmarks.push({ id: 'site', name: '在建大楼', x: -19, z: -19, y: 17, css: '#ff8a1e' });
    /* 核心塔：四面立面全部可墙跑 */
    this.addBox(-19, 8.5, -19, 10, 17, 10, { surf: SURF.WALLRUN, mat: 'build' });
    this._band(-19 - 5.05, 0.1, 10, -19, 17);
    this._band(-19 + 5.05, 0.1, 10, -19, 17);
    this._band(-19, 10, 0.1, -19 - 5.05, 17);
    this._band(-19, 10, 0.1, -19 + 5.05, 17);

    /* 脚手架：4 / 8 / 12 / 16，四层环绕两面，间距 4m —— 跳跃+登墙+抓边可达 */
    [4, 8, 12, 16].forEach(y => {
      this.addBox(-19, y - 0.15, -13.2, 12.5, 0.3, 2.6, { surf: SURF.DECK, mat: 'build' });
      this.addBox(-13.2, y - 0.15, -19, 2.6, 0.3, 12.5, { surf: SURF.DECK, mat: 'build' });
      this.addBox(-19, y + 0.5, -12.1, 12.5, 0.9, 0.4, { surf: SURF.VAULT, mat: 'build' });
    });
    /* 攀爬锚点：竖向标识，敌人也走同一条线（§5.1） */
    [4, 8, 12, 16].forEach(y => this._anchor(-13.2, y - 2, -13.2));

    /* 吊车：塔身 + 可行走吊臂，事件里会旋转 */
    this.addBox(-27, 11, -27, 1.6, 22, 1.6, { surf: SURF.WALLRUN, mat: 'build' });
    this.addBox(-19.5, 17.2, -19.5, 1.8, 0.4, 20, { surf: SURF.DECK, mat: 'build', dyn: 'craneA' });
    this.addBox(-19.5, 17.9, -19.5, 0.3, 1.0, 20, { surf: SURF.DECOR, mat: 'build', dyn: 'craneA', noCollide: true });
  },

  /* 地标四：医院停机坪 —— 高层空投点、精英事件与终局高压区域 */
  _buildHospital() {
    this.landmarks.push({ id: 'helipad', name: '医院停机坪', x: 19, z: 19, y: 18, css: '#2fe07a' });
    this.addBox(19, 9, 19, 16, 18, 16, { surf: SURF.WALLRUN, mat: 'hospital' });
    this._band(19 - 8.05, 0.1, 16, 19, 18);
    this._band(19, 16, 0.1, 19 - 8.05, 18);

    /* 阳台：6 / 11，两侧各一，构成两个独立出口 */
    [[6, -1], [11, 1]].forEach(([y, side]) => {
      this.addBox(19 + side * 9.2, y - 0.15, 19, 2.6, 0.3, 13, { surf: SURF.DECK, mat: 'hospital' });
      this.addBox(19, y - 0.15, 19 + side * 9.2, 13, 0.3, 2.6, { surf: SURF.DECK, mat: 'hospital' });
      this.addBox(19 + side * 10.4, y + 0.5, 19, 0.4, 0.9, 13, { surf: SURF.VAULT, mat: 'hospital' });
    });
    /* 消防梯：南面 0 → 11 的连续台阶，敌人走 stairs 连接 */
    this.addRamp(11.5, 28.0, 11.5, 12.0, 0.4, 6, 2.2, 'hospital');
    this.addRamp(13.9, 12.0, 13.9, 26.0, 6.2, 11, 2.2, 'hospital');
    [6, 11].forEach(y => this._anchor(10.6, y - 2, 19));

    /* 停机坪：屋顶 18 + 抬高的停机台 */
    this.addBox(19, 18.15, 19, 11, 0.3, 11, { surf: SURF.DECK, mat: 'hospital' });
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2;
      this.addBox(19 + Math.cos(a) * 5.2, 18.4, 19 + Math.sin(a) * 5.2, 0.6, 0.2, 0.6,
        { noCollide: true, mat: 'device', surf: SURF.DECOR });
    }
    /* 屋顶通风口：敌人的屋顶入侵口（§5.3） */
    this.addBox(24.5, 18.9, 14.5, 2.4, 1.6, 2.4, { surf: SURF.VAULT, mat: 'hospital' });
  },

  /* 商场街区：中层的连续移动通道，屋顶 9m 是三层之间的中转 */
  _buildMall() {
    this.addBox(-19, 4.5, 19, 16, 9, 16, { surf: SURF.WALLRUN, mat: 'mall' });
    this._band(-19 + 8.05, 0.1, 16, 19, 9);
    this._band(-19, 16, 0.1, 19 - 8.05, 9);
    this.addBox(-19, 9.15, 19, 16.4, 0.3, 16.4, { surf: SURF.DECK, mat: 'mall' });
    /* 雨棚：3.4m，街面 → 屋顶的中继 */
    [[-10.2, 15], [-10.2, 23], [-15, 10.4], [-23, 10.4]].forEach(([x, z]) => {
      const horiz = Math.abs(x) > Math.abs(z) - 8;
      this.addBox(x, 3.4, z, horiz ? 2.8 : 6.0, 0.3, horiz ? 6.0 : 2.8, { surf: SURF.DECK, mat: 'mall' });
    });
    /* 屋顶设备：水箱与空调机，提供掩体与二段落脚点 */
    this.addBox(-23, 10.4, 15, 3.0, 2.2, 3.0, { surf: SURF.DECK, mat: 'prop' });
    this.addBox(-14.5, 9.9, 23, 2.6, 1.2, 2.6, { surf: SURF.VAULT, mat: 'prop' });
    this.addBox(-19, 10.1, 19, 3.4, 1.6, 3.4, { surf: SURF.VAULT, mat: 'prop' });
    [3.4, 9].forEach(y => this._anchor(-10.6, y - 2, 19));
  },

  /* 中层环：围绕十字路口的一圈 y=6 连廊。
     §3.3 要求每层至少两条可连续循环的路线 —— 这是中层的主环，
     四条边分别接到四个街区，因此也是三层之间的换乘站。 */
  _buildMidRing() {
    const y = 6, w = 3.2;
    const seg = [
      [0, -9.5, 19.5, w], [0, 9.5, 19.5, w], [-9.5, 0, w, 19.5], [9.5, 0, w, 19.5]
    ];
    seg.forEach(([x, z, sx, sz]) => {
      this.addBox(x, y - 0.15, z, sx, 0.3, sz, { surf: SURF.DECK, mat: 'deck' });
      /* 两侧矮栏：既是可翻越标识，也是跳下街面的出口 */
      if (sx > sz) {
        this.addBox(x, y + 0.45, z - sz / 2 + 0.15, sx, 0.9, 0.3, { surf: SURF.VAULT, mat: 'deck' });
        this.addBox(x, y + 0.45, z + sz / 2 - 0.15, sx, 0.9, 0.3, { surf: SURF.VAULT, mat: 'deck' });
      } else {
        this.addBox(x - sx / 2 + 0.15, y + 0.45, z, 0.3, 0.9, sz, { surf: SURF.VAULT, mat: 'deck' });
        this.addBox(x + sx / 2 - 0.15, y + 0.45, z, 0.3, 0.9, sz, { surf: SURF.VAULT, mat: 'deck' });
      }
    });
    /* 四个角柱：把环连成闭合回路，同时是可墙跑面 */
    [[-9.5, -9.5], [9.5, -9.5], [-9.5, 9.5], [9.5, 9.5]].forEach(([x, z]) => {
      this.addBox(x, y - 0.15, z, w, 0.3, w, { surf: SURF.DECK, mat: 'deck' });
      this.addBox(x, 3, z, 1.0, 6, 1.0, { surf: SURF.WALLRUN, mat: 'deck' });
      this._band(x + 0.55, 0.1, 1.0, z, 6);
    });
  },

  /* 灯带 / 锚点：只做视觉，不参与碰撞 —— 判定仍看 surf 标签 */
  _band(x, sx, sz, z, h) {
    this.addBox(x, h / 2, z, sx, h * 0.86, sz, { noCollide: true, mat: 'band', surf: SURF.DECOR });
  },
  _anchor(x, y, z) {
    for (let i = 0; i < 3; i++) {
      this.addBox(x, y + i * 0.7, z, 0.5, 0.12, 0.5, { noCollide: true, mat: 'device', surf: SURF.DECOR });
    }
    this.climbAnchors = this.climbAnchors || [];
    this.climbAnchors.push({ x: x, y: y, z: z });
  },

  /* 快速装置：滑索与跳板。全局统一为“靠近自动吸附”，不增加新按键（§2.2） */
  _buildDevices() {
    const zip = (ax, ay, az, bx, by, bz, name) => {
      this.devices.push({ kind: 'zip', a: { x: ax, y: ay, z: az }, b: { x: bx, y: by, z: bz }, name: name });
      /* 钢索本体在材质就绪后补挂（_mountZips），这里只登记数据 */
      (this._zipPend || (this._zipPend = [])).push({ ax, ay, az, bx, by, bz });
    };
    /* 屋顶层的下行链：停机坪 → 停车楼 → 吊车 → 商场屋顶，构成屋顶回路 */
    zip(19, 18.6, 13.6, 19, 15.6, -9.6, '停机坪→停车楼');
    zip(13.0, 15.4, -19, -13.6, 12.4, -19, '停车楼→脚手架');
    zip(-19.5, 17.4, -10.0, -19, 9.8, 12.0, '吊臂→商场屋顶');
    zip(-11.0, 9.6, 19, 9.2, 6.4, 19, '商场屋顶→中层环');

    /* 跳板：把街面重新送回中层，保证屋顶不是单向路 */
    [[0, -2.4, 0], [-2.4, 0, 0], [13.5, 5.5, 0], [-5.5, -13.5, 0]].forEach(([x, z]) => {
      this.devices.push({ kind: 'pad', x: x, y: 0.25, z: z });
      this.addBox(x, 0.12, z, 2.2, 0.24, 2.2, { surf: SURF.DECK, mat: 'device' });
    });
    /* 商场屋顶与停车楼各放一块，制造二段起跳 */
    [[-19, 9.45, 24.5], [15.5, 15.35, -14]].forEach(([x, y, z]) => {
      this.devices.push({ kind: 'pad', x: x, y: y + 0.15, z: z });
      this.addBox(x, y + 0.12, z, 2.2, 0.24, 2.2, { surf: SURF.DECK, mat: 'device' });
    });
  },

  /* 事件可切换几何：预设状态切换，不做真实物理破坏（§3.4） */
  _buildDynamics() {
    /* 吊车旋转后的第二个吊臂位置：楼间新桥 */
    this.addBox(-11.5, 17.2, -19.5, 20, 0.4, 1.8, { surf: SURF.DECK, mat: 'build', dyn: 'craneB' });
    /* 广告牌倒塌后的登楼斜坡 */
    for (let i = 0; i < 12; i++) {
      const k = i / 12;
      this.addBox(lerp(-2.5, -9.0, k), lerp(0.3, 6.0, k) / 2, lerp(16, 21, k),
        2.6, lerp(0.3, 6.0, k), 2.2, { surf: SURF.DECK, mat: 'mall', dyn: 'billboard' });
    }
    /* 外墙坍塌后打开的攀爬路线 */
    for (let i = 0; i < 6; i++) {
      this.addBox(10.4, 1.2 + i * 2.0, 22 + (i % 2) * 1.4, 1.8, 0.5, 1.8,
        { surf: SURF.DECK, mat: 'hospital', dyn: 'facade' });
    }
    /* 巴士爆炸后的封路残骸：高到不可翻越，真的改变路线 */
    this.addBox(-6.0, 2.4, -16.5, 4.6, 4.8, 10.5, { surf: SURF.SOLID, mat: 'prop', dyn: 'wreck' });
    /* 电力恢复后启用的升降平台 */
    this.addBox(-26.5, 5.85, -6.0, 3.0, 0.3, 3.0, { surf: SURF.DECK, mat: 'device', dyn: 'power' });
    this.addBox(-26.5, 2.85, -6.0, 3.0, 0.3, 3.0, { surf: SURF.DECK, mat: 'device', dyn: 'power' });

    /* 全部默认关闭：事件触发时才接通 */
    ['craneB', 'billboard', 'facade', 'wreck', 'power'].forEach(id => this.setDynamic(id, false));
  },

  setDynamic(id, on) {
    const d = this.dynamics[id];
    if (!d) return false;
    if (d.on === on) return false;
    d.on = on;
    d.solids.forEach(s => { s.on = on; });
    d.meshes.forEach(m => { m.visible = on; });
    this.reindex();
    return true;
  },

  /* --------------------------------------------------- 导航区域与连接边 */
  _region(id, layer, x0, x1, z0, z1, y, opts) {
    const r = Object.assign({
      id: id, layer: layer, x0: x0, x1: x1, z0: z0, z1: z1, y: y,
      cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, links: []
    }, opts || {});
    this.regions.push(r);
    return r;
  },
  _link(from, to, kind, a, b, opts) {
    const l = Object.assign({
      from: from, to: to, kind: kind, a: a, b: b,
      allow: (opts && opts.allow) || ['climber', 'leaper', 'ranged', 'grunt'],
      dur: (opts && opts.dur) || 1.4, dyn: (opts && opts.dyn) || null, uses: 0
    }, opts || {});
    this.links.push(l);
    return l;
  },

  _buildNav() {
    /* 街道层：十字路口四臂 + 四个街区外沿 */
    this._region('st_cross', 'street', -8, 8, -8, 8, 0);
    this._region('st_n', 'street', -8, 8, -34, -8, 0);
    this._region('st_s', 'street', -8, 8, 8, 34, 0);
    this._region('st_w', 'street', -34, -8, -8, 8, 0);
    this._region('st_e', 'street', 8, 34, -8, 8, 0);
    this._region('st_ne', 'street', 8, 34, -34, -8, 0);
    this._region('st_nw', 'street', -34, -8, -34, -8, 0);
    this._region('st_se', 'street', 8, 34, 8, 34, 0);
    this._region('st_sw', 'street', -34, -8, 8, 34, 0);

    /* 中层 */
    this._region('mid_ring_n', 'mid', -11, 11, -11.2, -7.8, 6);
    this._region('mid_ring_s', 'mid', -11, 11, 7.8, 11.2, 6);
    this._region('mid_ring_w', 'mid', -11.2, -7.8, -11, 11, 6);
    this._region('mid_ring_e', 'mid', 7.8, 11.2, -11, 11, 6);
    this._region('mid_park1', 'mid', 9, 24, -29, -9, 5);
    this._region('mid_scaff1', 'mid', -25.5, -12.5, -14.5, -11.9, 4);
    this._region('mid_scaff2', 'mid', -25.5, -12.5, -14.5, -11.9, 8);
    this._region('mid_balc1', 'mid', 9.5, 28.5, 12.5, 25.5, 6);
    this._region('mid_mallroof', 'mid', -27, -11, 11, 27, 9.3);
    this._region('mid_awning', 'mid', -24, -9, 9, 25, 3.4);

    /* 屋顶层 */
    this._region('roof_park', 'roof', 9, 29, -29, -9, 15);
    this._region('roof_heli', 'roof', 13.5, 24.5, 13.5, 24.5, 18.3);
    this._region('roof_crane', 'roof', -21, -18, -29, -10, 17.4);
    this._region('roof_scaff3', 'roof', -25.5, -12.5, -14.5, -11.9, 12);
    this._region('roof_scaff4', 'roof', -25.5, -12.5, -14.5, -11.9, 16);
    this._region('roof_balc2', 'roof', 9.5, 28.5, 12.5, 25.5, 11);

    const P = (x, y, z) => ({ x: x, y: y, z: z });
    /* --- 三层之间的连接点（§3.3 要求 ≥6，这里 14 条，且每条标注允许的敌人类型） --- */
    /* 停车楼坡道：所有敌人都能走 */
    this._link('st_ne', 'mid_park1', 'stairs', P(26, 0.4, -10.5), P(26, 5, -27.5), { dur: 2.6 });
    this._link('mid_park1', 'roof_park', 'stairs', P(26, 5.2, -27.5), P(26, 15, -10.5), { dur: 2.6 });
    /* 医院消防梯 */
    this._link('st_se', 'mid_balc1', 'stairs', P(11.5, 0.4, 27.5), P(11.5, 6, 12.5), { dur: 2.4 });
    this._link('mid_balc1', 'roof_balc2', 'stairs', P(13.9, 6.2, 12.5), P(13.9, 11, 25.5), { dur: 2.4 });
    this._link('roof_balc2', 'roof_heli', 'climb', P(11.0, 11, 19), P(13.6, 18.3, 19),
      { allow: ['climber', 'leaper'], dur: 2.8 });
    /* 脚手架攀爬链：只有攀爬怪与跳跃怪能上 */
    this._link('st_nw', 'mid_scaff1', 'climb', P(-13.2, 0, -13.2), P(-14.5, 4, -13.2),
      { allow: ['climber', 'leaper'], dur: 1.9 });
    this._link('mid_scaff1', 'mid_scaff2', 'climb', P(-14.5, 4, -13.2), P(-14.5, 8, -13.2),
      { allow: ['climber'], dur: 1.8 });
    this._link('mid_scaff2', 'roof_scaff3', 'climb', P(-14.5, 8, -13.2), P(-14.5, 12, -13.2),
      { allow: ['climber'], dur: 1.8 });
    this._link('roof_scaff3', 'roof_scaff4', 'climb', P(-14.5, 12, -13.2), P(-14.5, 16, -13.2),
      { allow: ['climber'], dur: 1.8 });
    this._link('roof_scaff4', 'roof_crane', 'jump', P(-16, 16, -13.2), P(-19.5, 17.4, -14),
      { allow: ['climber', 'leaper'], dur: 1.0 });
    /* 商场：雨棚 → 屋顶 */
    this._link('st_sw', 'mid_awning', 'climb', P(-10.6, 0, 19), P(-10.6, 3.4, 19),
      { allow: ['climber', 'leaper', 'grunt'], dur: 1.5 });
    this._link('mid_awning', 'mid_mallroof', 'climb', P(-10.6, 3.4, 19), P(-11.5, 9.3, 19),
      { allow: ['climber', 'leaper'], dur: 2.0 });
    /* 中层环：集装箱与雨棚上环 */
    this._link('st_cross', 'mid_ring_n', 'climb', P(-9.2, 0, -9.2), P(-9.5, 6, -9.5),
      { allow: ['climber', 'leaper'], dur: 2.1 });
    this._link('st_e', 'mid_ring_e', 'climb', P(9.5, 0, 3.0), P(9.5, 6, 3.0),
      { allow: ['climber', 'leaper'], dur: 2.1 });
    /* 中层环内部与街区互通 */
    this._link('mid_ring_e', 'mid_park1', 'jump', P(9.5, 6, -10.5), P(11, 5, -10.5), { dur: 0.9 });
    this._link('mid_ring_e', 'mid_balc1', 'jump', P(9.5, 6, 10.5), P(11, 6, 12.6), { dur: 0.9 });
    this._link('mid_ring_w', 'mid_scaff1', 'jump', P(-9.5, 6, -10.5), P(-12.5, 4, -13.0), { dur: 1.1 });
    this._link('mid_ring_s', 'mid_mallroof', 'jump', P(-9.5, 6, 9.5), P(-11.5, 9.3, 12), { dur: 1.2 });
    /* 屋顶 → 街面的坠落边（所有敌人都能走，没有坠落伤害） */
    [['roof_park', 'st_ne', P(19, 15, -9.5), P(19, 0, -6.5)],
     ['roof_heli', 'st_se', P(19, 18.3, 13.6), P(19, 0, 8.0)],
     ['mid_mallroof', 'st_sw', P(-19, 9.3, 11.2), P(-19, 0, 7.5)],
     ['mid_ring_n', 'st_cross', P(0, 6, -9.5), P(0, 0, -6.0)],
     ['mid_ring_s', 'st_cross', P(0, 6, 9.5), P(0, 0, 6.0)],
     ['roof_crane', 'st_nw', P(-19.5, 17.4, -12), P(-19.5, 0, -8.0)]
    ].forEach(([a, b, pa, pb]) => this._link(a, b, 'drop', pa, pb, { dur: 1.1 }));
    /* 滑索：屋顶专用高速边 */
    this.devices.filter(d => d.kind === 'zip').forEach((d, i) => {
      const ra = this.regionAt(d.a.x, d.a.y, d.a.z), rb = this.regionAt(d.b.x, d.b.y, d.b.z);
      if (ra && rb) this._link(ra.id, rb.id, 'zip', d.a, d.b, { allow: ['leaper'], dur: 1.6, device: i });
    });

    this._autoAdjacency();
    this._mirrorLinks();

    const byId = {};
    this.regions.forEach(r => { byId[r.id] = r; });
    this.byId = byId;
    this.links.forEach(l => { const r = byId[l.from]; if (r) r.links.push(l); });
  },

  /* 同层相邻区域之间不需要任何特殊动作，直接走过去即可（§5.2：
     普通地面移动继续沿用二维逻辑）。但导航图必须把这件事表达出来，
     否则寻路会认为街道的四条臂互不连通，敌人会去找根本不需要的连接点。 */
  _autoAdjacency() {
    const R2 = this.regions;
    for (let i = 0; i < R2.length; i++) {
      for (let j = i + 1; j < R2.length; j++) {
        const a = R2[i], b = R2[j];
        if (a.layer !== b.layer) continue;
        if (Math.abs(a.y - b.y) > 1.6) continue;
        /* 矩形在 XZ 上接触或重叠（留 1.2m 容差表示“走得过去”） */
        const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        const gapZ = Math.max(a.z0, b.z0) - Math.min(a.z1, b.z1);
        if (gapX > 1.2 || gapZ > 1.2) continue;
        const mx = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2;
        const mz = (Math.max(a.z0, b.z0) + Math.min(a.z1, b.z1)) / 2;
        const pa = { x: clamp(mx, a.x0, a.x1), y: a.y, z: clamp(mz, a.z0, a.z1) };
        const pb = { x: clamp(mx, b.x0, b.x1), y: b.y, z: clamp(mz, b.z0, b.z1) };
        this._link(a.id, b.id, 'walk', pa, pb, { dur: 0.5, auto: true });
        this._link(b.id, a.id, 'walk', pb, pa, { dur: 0.5, auto: true });
      }
    }
  },

  /* 反向边。方向性是有意义的，不能一律双向：
       walk / stairs —— 真双向，来回都是走。
       climb        —— 反向是坠落（没有坠落伤害，所以谁都能下来）。
       jump         —— 高度差小的可以跳回去，否则同样退化成坠落。
       zip / drop   —— 单向。滑索是下行钢索，坠落不可逆。
     这一步同时保证了 §3.3「每个主要屋顶至少两个出口」不靠手工数边来维持。 */
  _mirrorLinks() {
    const src = this.links.slice();
    src.forEach(l => {
      if (l.auto || l.kind === 'zip' || l.kind === 'drop') return;
      const dy = l.b.y - l.a.y;
      let kind = null, allow = l.allow;
      if (l.kind === 'stairs') kind = 'stairs';
      else if (l.kind === 'climb') { kind = 'drop'; allow = ['climber', 'leaper', 'ranged', 'grunt']; }
      else if (l.kind === 'jump') {
        if (Math.abs(dy) <= 2.2) kind = 'jump';
        else { kind = 'drop'; allow = ['climber', 'leaper', 'ranged', 'grunt']; }
      }
      if (!kind) return;
      this._link(l.to, l.from, kind, l.b, l.a, { allow: allow, dur: l.dur, mirror: true });
    });
  },

  regionAt(x, y, z) {
    let best = null, bestDy = Infinity;
    for (let i = 0; i < this.regions.length; i++) {
      const r = this.regions[i];
      if (x < r.x0 - 1.5 || x > r.x1 + 1.5 || z < r.z0 - 1.5 || z > r.z1 + 1.5) continue;
      const dy = Math.abs(y - r.y);
      if (dy < bestDy && dy < 3.2) { bestDy = dy; best = r; }
    }
    return best;
  },

  /* 分层刷怪点：全部预先验证可站立与可达，避免生成在下不来的装饰屋顶（§5.3） */
  _buildSpawnPoints() {
    const add = (x, z, y, layer, cover) => {
      const sy = this.dropTo(x, z, y + 0.6, 0.5);
      if (!this.standable(x, z, sy + 0.2, 0.5)) return;
      this.spawnPoints.push({ x: x, y: sy, z: z, layer: layer, cover: cover || 'open' });
    };
    /* 街道：巷口、车辆与商铺遮挡后 */
    [[-13, -6], [13, 6], [-6, -22], [6, 22], [-22, 6], [22, -6], [-30, -2], [30, 2],
     [-2, -30], [2, 30], [-16, 16], [16, -16], [-25, -14], [25, 14], [-14, 25], [14, -25]]
      .forEach(([x, z]) => add(x, z, 1.0, 'street', 'alley'));
    /* 中层：窗口、脚手架、破墙与楼梯间 */
    [[-14.5, -13.2, 4], [-14.5, -13.2, 8], [11.5, -13, 5], [20, -13, 5], [11.5, 19, 6],
     [26, 19, 6], [-19, 19, 9.3], [-23, 15, 11.6], [-9.5, -3, 6], [9.5, 3, 6],
     [0, -9.5, 6], [0, 9.5, 6], [-13, 19, 3.4]]
      .forEach(([x, z, y]) => add(x, z, y + 0.5, 'mid', 'window'));
    /* 屋顶：屋顶门、通风口与相邻建筑边缘 */
    [[14, -13, 15], [24, -25, 15], [24.5, 14.5, 20.6], [15, 23, 18.3], [-19.5, -25, 17.4],
     [-14.5, -13.2, 12], [-14.5, -13.2, 16], [23, 22, 18.3]]
      .forEach(([x, z, y]) => add(x, z, y + 0.5, 'roof', 'vent'));
  },

  /* 附近的可用装置（§2.2 近距离自动吸附，全局统一） */
  nearestDevice(pos, kind, maxDist) {
    let best = null, bd = maxDist * maxDist;
    for (let i = 0; i < this.devices.length; i++) {
      const d = this.devices[i];
      if (d.kind !== kind) continue;
      const p = kind === 'zip' ? d.a : d;
      const dx = pos.x - p.x, dy = pos.y - p.y, dz = pos.z - p.z;
      const d2 = dx * dx + dy * dy * 0.5 + dz * dz;
      if (d2 < bd) { bd = d2; best = d; }
    }
    return best;
  }
};

/* 滑索钢索的可视化在材质就绪后补挂 —— 保持 _buildDevices 里只登记数据 */
CITY._mountZips = function () {
  if (!this._zipPend) return;
  this._zipPend.forEach(z => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1), this._mats.device);
    m.position.set((z.ax + z.bx) / 2, (z.ay + z.by) / 2, (z.az + z.bz) / 2);
    m.lookAt(z.bx, z.by, z.bz);
    m.scale.z = Math.hypot(z.bx - z.ax, z.by - z.ay, z.bz - z.az);
    CITY.group.add(m);
  });
  this._zipPend = null;
};
