/* ============================================================================
   SYMBIOTIC FIRE · 渲染层
   场景 / 竞技场 / 程序化模型 / 特效池。零资源文件，全部运行时生成。
   ========================================================================== */
'use strict';

const T = THREE;

/* --- 手写几何合并：把一只丧尸压成 1 个 draw call --- */
function mergeGeom(parts) {
  let vcount = 0, icount = 0;
  parts.forEach(p => {
    const g = p.geo;
    vcount += g.attributes.position.count;
    icount += g.index ? g.index.count : g.attributes.position.count;
  });
  const pos = new Float32Array(vcount * 3);
  const nrm = new Float32Array(vcount * 3);
  const idx = new (vcount > 65535 ? Uint32Array : Uint16Array)(icount);
  let vo = 0, io = 0;
  const nm = new T.Matrix3();
  parts.forEach(p => {
    const g = p.geo, m = p.mat;
    nm.getNormalMatrix(m);
    const gp = g.attributes.position, gn = g.attributes.normal;
    const v = new T.Vector3(), n = new T.Vector3();
    for (let i = 0; i < gp.count; i++) {
      v.fromBufferAttribute(gp, i).applyMatrix4(m);
      pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      n.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      nrm[(vo + i) * 3] = n.x; nrm[(vo + i) * 3 + 1] = n.y; nrm[(vo + i) * 3 + 2] = n.z;
    }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; }
    else { for (let i = 0; i < gp.count; i++) idx[io + i] = i + vo; io += gp.count; }
    vo += gp.count;
  });
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  out.setIndex(new T.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
function mat4(x, y, z, sx, sy, sz, ry) {
  const m = new T.Matrix4();
  const q = new T.Quaternion();
  if (ry) q.setFromAxisAngle(new T.Vector3(0, 0, 1), ry);
  m.compose(new T.Vector3(x, y, z), q, new T.Vector3(sx, sy, sz));
  return m;
}

const R = {
  scene: null, camera: null, renderer: null, gunCam: null, gunScene: null,
  sun: null, hemi: null,
  arenaHalf: 28,   // 56×56m —— 再大就会出现"看不到怪"的空窗
  geo: {}, matlib: {},

  init(canvas) {
    /* r147 默认 legacyMode=true：颜色不转线性，但输出又做 sRGB 编码，
       结果是所有自定义颜色被整体提亮成灰白。关掉 legacy 才能所见即所得。 */
    if (T.ColorManagement) T.ColorManagement.legacyMode = false;
    this.renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputEncoding = T.sRGBEncoding;
    this.renderer.autoClear = false;

    this.scene = new T.Scene();
    this.scene.background = new T.Color(0x121722);
    /* 雾必须推得够远：尸潮的可读性优先于氛围（§7.4） */
    this.scene.fog = new T.Fog(0x121722, 48, 135);

    this.camera = new T.PerspectiveCamera(TUNE.PLAYER.fovBase, innerWidth / innerHeight, 0.05, 400);

    /* 武器单独一层相机，避免被场景 fog 吃掉、也不会插进墙里 */
    this.gunScene = new T.Scene();
    this.gunCam = new T.PerspectiveCamera(58, innerWidth / innerHeight, 0.01, 12);
    this.gunScene.add(new T.HemisphereLight(0xcfe0ff, 0x30323c, 0.62));
    const gl = new T.DirectionalLight(0xffffff, 0.42); gl.position.set(-1.4, 2.2, 2.4);
    this.gunScene.add(gl);

    this.hemi = new T.HemisphereLight(0x8497b5, 0x24282f, 0.85);
    this.scene.add(this.hemi);
    this.sun = new T.DirectionalLight(0xc6d6ee, 0.80);
    this.sun.position.set(24, 46, 14);
    this.scene.add(this.sun);
    /* 跟随玩家的补光：近处敌人必须能看清轮廓，这是威胁判读的第一层 */
    this.lamp = new T.PointLight(0xffe0be, 0.7, 26, 2.0);
    this.scene.add(this.lamp);

    this._buildGeo();
    this._buildArena();
    this._buildFxPools();
    this.buildPickups();

    addEventListener('resize', () => this.resize());
  },

  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.gunCam.aspect = innerWidth / innerHeight; this.gunCam.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  },

  _buildGeo() {
    const g = this.geo;
    g.box = new T.BoxGeometry(1, 1, 1);
    g.sph = new T.SphereGeometry(0.5, 10, 7);
    g.sphHi = new T.SphereGeometry(0.5, 16, 12);
    g.cyl = new T.CylinderGeometry(0.5, 0.5, 1, 10);
    g.cone = new T.ConeGeometry(0.5, 1, 8);
    g.ring = new T.RingGeometry(0.86, 1, 40);
    g.disc = new T.CircleGeometry(1, 32);
    g.plane = new T.PlaneGeometry(1, 1);
    g.oct = new T.OctahedronGeometry(0.5, 0);
  },

  /* ---------------------------------------------------------------- 竞技场 */
  _buildArena() {
    const H = this.arenaHalf;
    const floorMat = new T.MeshLambertMaterial({ color: 0x232a34 });
    const floor = new T.Mesh(new T.PlaneGeometry(H * 2, H * 2), floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    /* 低饱和地面网格，帮助判断距离与走位 §9 */
    const grid = new T.GridHelper(H * 2, 36, 0x2c3a4a, 0x222a34);
    grid.position.y = 0.012;
    grid.material.opacity = 0.55; grid.material.transparent = true;
    this.scene.add(grid);

    const wallMat = new T.MeshLambertMaterial({ color: 0x232a34 });
    const trimMat = new T.MeshBasicMaterial({ color: 0x3f5468 });
    const wh = 7;
    for (let i = 0; i < 4; i++) {
      const w = new T.Mesh(this.geo.box, wallMat);
      const a = i * Math.PI / 2;
      w.position.set(Math.sin(a) * H, wh / 2, Math.cos(a) * H);
      w.scale.set(i % 2 ? 1.2 : H * 2, wh, i % 2 ? H * 2 : 1.2);
      this.scene.add(w);
      const t = new T.Mesh(this.geo.box, trimMat);
      t.position.set(Math.sin(a) * (H - 0.7), 0.06, Math.cos(a) * (H - 0.7));
      t.scale.set(i % 2 ? 0.16 : H * 2 - 1.4, 0.12, i % 2 ? H * 2 - 1.4 : 0.16);
      this.scene.add(t);
    }

    /* 掩体：给走位一点拓扑，但不能挡住尸潮的可读性 —— 全部矮于视线。
       中心必须留空：玩家出生点在原点。 */
    this.obstacles = [];
    const pillarMat = new T.MeshLambertMaterial({ color: 0x2a323d });
    const layout = [
      [-10.5, -10.5, 2.5, 2.6], [10.5, -10.5, 2.5, 2.6],
      [-10.5, 10.5, 2.5, 2.6], [10.5, 10.5, 2.5, 2.6],
      [-19, 0, 1.9, 2.2], [19, 0, 1.9, 2.2], [0, -19, 1.9, 2.2], [0, 19, 1.9, 2.2]
    ];
    layout.forEach(([x, z, r, h]) => {
      const m = new T.Mesh(this.geo.cyl, pillarMat);
      m.position.set(x, h / 2, z); m.scale.set(r * 2, h, r * 2);
      this.scene.add(m);
      const cap = new T.Mesh(this.geo.cyl, trimMat);
      cap.position.set(x, h + 0.06, z); cap.scale.set(r * 2.06, 0.12, r * 2.06);
      this.scene.add(cap);
      this.obstacles.push({ x: x, z: z, r: r, h: h });
    });

    /* 远处轮廓，给"灾难现场"一点氛围但不产生可读性噪音 */
    const skyMat = new T.MeshLambertMaterial({ color: 0x151a22 });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2, d = 46 + (i % 5) * 9;
      const b = new T.Mesh(this.geo.box, skyMat);
      const h = 10 + (i * 7 % 26);
      b.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d);
      b.scale.set(7 + (i % 4) * 3, h, 7 + (i % 3) * 3);
      this.scene.add(b);
    }
  },

  /* 竞技场碰撞：把点推出墙和柱子 */
  collide(p, radius) {
    const H = this.arenaHalf - 1.0 - radius;
    p.x = clamp(p.x, -H, H); p.z = clamp(p.z, -H, H);
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      const dx = p.x - o.x, dz = p.z - o.z;
      const rr = o.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = o.x + dx / d * rr; p.z = o.z + dz / d * rr;
      }
    }
  },

  /* ------------------------------------------------------------ 敌人模型 */
  _zombieGeoCache: {},
  zombieGeo(kind) {
    if (this._zombieGeoCache[kind]) return this._zombieGeoCache[kind];
    const g = this.geo, parts = [];
    const push = (geo, x, y, z, sx, sy, sz, rz) => parts.push({ geo: geo, mat: mat4(x, y, z, sx, sy, sz, rz) });

    if (kind === 'heavy') {
      push(g.box, 0, 1.28, 0, 1.15, 1.35, 0.82);
      push(g.sph, 0, 2.05, 0.04, 0.62, 0.62, 0.62);
      push(g.box, -0.78, 1.28, 0.18, 0.34, 1.2, 0.34, 0.42);
      push(g.box, 0.78, 1.28, 0.18, 0.34, 1.2, 0.34, -0.42);
      push(g.box, -0.32, 0.32, 0, 0.4, 0.72, 0.4);
      push(g.box, 0.32, 0.32, 0, 0.4, 0.72, 0.4);
    } else if (kind === 'spitter') {
      push(g.box, 0, 1.08, 0, 0.62, 1.0, 0.5);
      push(g.sph, 0, 1.76, 0.16, 0.5, 0.44, 0.56);
      push(g.cyl, 0, 1.42, 0.42, 0.3, 0.5, 0.3, 1.2);  // 喉囊
      push(g.box, -0.48, 1.1, 0.1, 0.22, 0.95, 0.22, 0.5);
      push(g.box, 0.48, 1.1, 0.1, 0.22, 0.95, 0.22, -0.5);
      push(g.box, -0.2, 0.3, 0, 0.26, 0.62, 0.26);
      push(g.box, 0.2, 0.3, 0, 0.26, 0.62, 0.26);
    } else if (kind === 'charger') {
      push(g.box, 0, 1.35, 0, 1.05, 1.15, 0.95);
      push(g.sph, 0, 1.55, 0.62, 0.72, 0.6, 0.5);      // 前倾冲撞头
      push(g.cone, 0, 1.55, 1.0, 0.5, 0.7, 0.5);
      push(g.box, -0.72, 1.2, 0.3, 0.3, 1.1, 0.3, 0.6);
      push(g.box, 0.72, 1.2, 0.3, 0.3, 1.1, 0.3, -0.6);
      push(g.box, -0.3, 0.36, 0, 0.36, 0.76, 0.36);
      push(g.box, 0.3, 0.36, 0, 0.36, 0.76, 0.36);
    } else if (kind === 'boss') {
      push(g.box, 0, 1.9, 0, 1.9, 2.0, 1.4);
      push(g.sph, 0, 3.15, 0.1, 1.0, 0.95, 1.0);
      push(g.box, -1.35, 1.9, 0.2, 0.55, 1.9, 0.55, 0.35);
      push(g.box, 1.35, 1.9, 0.2, 0.55, 1.9, 0.55, -0.35);
      push(g.box, -0.5, 0.48, 0, 0.62, 1.05, 0.62);
      push(g.box, 0.5, 0.48, 0, 0.62, 1.05, 0.62);
      push(g.cone, -0.7, 3.3, 0, 0.34, 0.7, 0.34);
      push(g.cone, 0.7, 3.3, 0, 0.34, 0.7, 0.34);
    } else { /* grunt */
      push(g.box, 0, 1.12, 0, 0.66, 0.98, 0.42);
      push(g.sph, 0, 1.78, 0.02, 0.44, 0.48, 0.44);
      push(g.box, -0.5, 1.18, 0.22, 0.2, 0.9, 0.2, 0.55);
      push(g.box, 0.5, 1.18, 0.22, 0.2, 0.9, 0.2, -0.55);
      push(g.box, -0.19, 0.32, 0, 0.26, 0.66, 0.26);
      push(g.box, 0.19, 0.32, 0, 0.26, 0.66, 0.26);
    }
    /* 模型按 height=1 归一化，实例再乘 template.height */
    const geo = mergeGeom(parts);
    const norm = { grunt: 1.98, heavy: 2.4, spitter: 2.0, charger: 2.35, boss: 4.0 }[kind] || 1.98;
    geo.scale(1 / norm, 1 / norm, 1 / norm);
    this._zombieGeoCache[kind] = geo;
    return geo;
  },

  /* 变种标记 —— §30 唯一颜色 + 唯一轮廓，禁止只靠文本区分 */
  variantMarkGeo(mutId) {
    const key = 'vm_' + mutId;
    if (this._zombieGeoCache[key]) return this._zombieGeoCache[key];
    const g = this.geo, parts = [];
    const push = (geo, x, y, z, sx, sy, sz, rz) => parts.push({ geo: geo, mat: mat4(x, y, z, sx, sy, sz, rz) });
    if (mutId === 'blast') {          // 膨胀橙腹囊
      push(g.sphHi, 0, 1.02, 0.22, 0.78, 0.72, 0.66);
    } else if (mutId === 'fission') { // 紫色双核心 + 中缝
      push(g.sph, -0.22, 1.22, 0.24, 0.34, 0.34, 0.3);
      push(g.sph, 0.22, 1.22, 0.24, 0.34, 0.34, 0.3);
      push(g.box, 0, 1.15, 0.2, 0.05, 1.0, 0.3);
    } else if (mutId === 'overclock') { // 红色血管束（细长）
      push(g.box, 0, 1.35, 0.24, 0.1, 0.9, 0.1);
      push(g.box, -0.24, 1.3, 0.2, 0.07, 0.7, 0.07, 0.3);
      push(g.box, 0.24, 1.3, 0.2, 0.07, 0.7, 0.07, -0.3);
      push(g.sph, 0, 1.78, 0.14, 0.3, 0.3, 0.3);
    } else if (mutId === 'conduct') { // 青色神经节
      push(g.oct, 0, 1.9, 0, 0.5, 0.7, 0.5);
      push(g.box, -0.3, 1.4, 0.2, 0.07, 0.8, 0.07, 0.4);
      push(g.box, 0.3, 1.4, 0.2, 0.07, 0.8, 0.07, -0.4);
    } else if (mutId === 'giant') {   // 黄色核心
      push(g.oct, 0, 1.2, 0.28, 0.55, 0.7, 0.5);
    } else {                          // ossify 的骨板是独立可破坏部件，这里只放脊背
      push(g.box, 0, 1.2, -0.24, 0.5, 1.0, 0.12);
    }
    const geo = mergeGeom(parts);
    geo.scale(1 / 1.98, 1 / 1.98, 1 / 1.98);
    this._zombieGeoCache[key] = geo;
    return geo;
  },

  plateGeo() {
    if (this._zombieGeoCache.plate) return this._zombieGeoCache.plate;
    const geo = new T.BoxGeometry(0.62, 0.2, 0.14);
    geo.scale(1 / 1.98, 1 / 1.98, 1 / 1.98);
    this._zombieGeoCache.plate = geo;
    return geo;
  },

  /* 枪械模型已迁到 js/weapon.js（todo2 §1：表现层与伤害层解耦） */

  setGunOrgan(id, on) { WEAPON.setOrgan(id, on); },   // 保留旧接口，转发到表现层

  /* --------------------------------------------------------------- 特效池 */
  _buildFxPools() {
    const g = this.geo;
    /* 冲击环：爆炸/震荡 */
    this.ringMatProto = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending });
    this.rings = new Pool(() => {
      const m = new T.Mesh(g.ring, this.ringMatProto.clone());
      m.rotation.x = -Math.PI / 2; m.visible = false; this.scene.add(m);
      return { mesh: m, t: 0, dur: 0.4, r0: 0, r1: 1, color: 0xffffff, vertical: false };
    }, o => { o.mesh.visible = false; }, 24);

    /* 球状爆闪 */
    this.puffs = new Pool(() => {
      const m = new T.Mesh(g.sph, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
      m.visible = false; this.scene.add(m);
      return { mesh: m, t: 0, dur: 0.3, s0: 0.4, s1: 2 };
    }, o => { o.mesh.visible = false; }, 40);

    /* 闪电段 §20 */
    this.bolts = new Pool(() => {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(3 * 10), 3));
      const m = new T.Line(geo, new T.LineBasicMaterial({ color: MUT.conduct.color, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
      m.visible = false; m.frustumCulled = false; this.scene.add(m);
      return { mesh: m, t: 0, dur: 0.22 };
    }, o => { o.mesh.visible = false; }, 16);

    /* 地面危险区 / 预警圈 §31：必须压过玩家装饰性粒子 —— 用 polygonOffset 抬到最上 */
    this.zones = new Pool(() => {
      const m = new T.Mesh(g.disc, new T.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
      }));
      m.rotation.x = -Math.PI / 2; m.visible = false; this.scene.add(m);
      const rm = new T.Mesh(g.ring, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false }));
      rm.rotation.x = -Math.PI / 2; rm.visible = false; this.scene.add(rm);
      return { mesh: m, rim: rm };
    }, o => { o.mesh.visible = false; o.rim.visible = false; }, 32);

    /* 命中火花 */
    this.sparks = new Pool(() => {
      const m = new T.Mesh(g.oct, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
      m.visible = false; this.scene.add(m);
      return { mesh: m, t: 0, dur: 0.18, vel: new T.Vector3() };
    }, o => { o.mesh.visible = false; }, 60);

    /* 经验晶体：InstancedMesh，一个 draw call 撑住几百颗 */
    const xpGeo = new T.OctahedronGeometry(0.19, 0);
    this.xpMesh = new T.InstancedMesh(xpGeo, new T.MeshBasicMaterial({ color: 0x7ef0c8 }), 640);
    this.xpMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.xpMesh.count = 0; this.xpMesh.frustumCulled = false;
    this.scene.add(this.xpMesh);

    /* 子弹：也用 InstancedMesh，主弹与分裂弹用不同颜色 → 两个实例网格 */
    const bGeo = new T.SphereGeometry(0.075, 6, 5);
    this.bulletMesh = new T.InstancedMesh(bGeo, new T.MeshBasicMaterial({ color: 0xffe6a8 }), 320);
    this.bulletMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.bulletMesh.count = 0; this.bulletMesh.frustumCulled = false;
    this.scene.add(this.bulletMesh);
    this.splitMesh = new T.InstancedMesh(bGeo, new T.MeshBasicMaterial({ color: MUT.fission.color }), 192);
    this.splitMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.splitMesh.count = 0; this.splitMesh.frustumCulled = false;
    this.scene.add(this.splitMesh);

    /* 敌人投射物（酸液） */
    this.acidMesh = new T.InstancedMesh(new T.SphereGeometry(0.22, 7, 6), new T.MeshBasicMaterial({ color: 0xa8c24a }), 64);
    this.acidMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.acidMesh.count = 0; this.acidMesh.frustumCulled = false;
    this.scene.add(this.acidMesh);
  },

  /* ------------------------------------------------- 拾取物（医疗 / 空投） */
  buildPickups() {
    const g = this.geo;
    /* 医疗凝胶：绿色，明确区别于青绿色经验球 */
    this.medMat = new T.MeshLambertMaterial({ color: 0x2fe07a, emissive: 0x1c8c4a, emissiveIntensity: 0.9 });
    this.medMesh = new T.Group();
    const core = new T.Mesh(g.oct, this.medMat); core.scale.setScalar(0.8); core.position.y = 0.85;
    this.medMesh.add(core); this.medCore = core;
    const cross1 = new T.Mesh(g.box, new T.MeshBasicMaterial({ color: 0xeafff2 }));
    cross1.scale.set(0.42, 0.13, 0.13); cross1.position.y = 0.85; this.medMesh.add(cross1);
    const cross2 = new T.Mesh(g.box, cross1.material);
    cross2.scale.set(0.13, 0.42, 0.13); cross2.position.y = 0.85; this.medMesh.add(cross2);
    this.medMesh.add(this._beacon(0x2fe07a));
    this.medMesh.visible = false;
    this.scene.add(this.medMesh);

    /* 空投舱 */
    this.podMesh = new T.Group();
    const pod = new T.Mesh(g.box, new T.MeshLambertMaterial({ color: 0x3d4a58 }));
    pod.scale.set(1.5, 1.1, 1.5); pod.position.y = 0.55; this.podMesh.add(pod);
    const stripe = new T.Mesh(g.box, new T.MeshBasicMaterial({ color: 0x5fe0ff }));
    stripe.scale.set(1.56, 0.16, 1.56); stripe.position.y = 0.86; this.podMesh.add(stripe);
    this.podMesh.add(this._beacon(0x5fe0ff));
    this.podMesh.visible = false;
    this.scene.add(this.podMesh);

    /* 三个模块：颜色与图形都必须一眼可分 §todo 三选一 */
    this.moduleMeshes = [];
    const defs = [
      { id: 'ammo', color: 0xffb020, geo: g.box, scale: [0.5, 0.62, 0.5] },
      { id: 'adren', color: 0xff4d7a, geo: g.cone, scale: [0.62, 0.9, 0.62] },
      { id: 'shield', color: 0x4fa8ff, geo: g.oct, scale: [0.72, 0.9, 0.72] }
    ];
    defs.forEach(d => {
      const grp = new T.Group();
      const m = new T.Mesh(d.geo, new T.MeshLambertMaterial({
        color: d.color, emissive: d.color, emissiveIntensity: 0.75
      }));
      m.scale.set(d.scale[0], d.scale[1], d.scale[2]); m.position.y = 0.75;
      grp.add(m);
      grp.add(this._beacon(d.color, 0.55));
      grp.visible = false;
      grp.userData = { id: d.id, spin: m };
      this.scene.add(grp);
      this.moduleMeshes.push(grp);
    });

    /* 相位护盾不做世界空间球壳：第一人称下镜头在球里面，
       加色混合会把整个画面洗白。改用屏幕边缘蓝光（index.html 的 #shieldvig）。
       这里保留一个空壳对象，避免其它代码判空。 */
    this.shieldMesh = { visible: false, position: { set: function () { } }, material: { opacity: 0 } };
  },

  /* 落点光柱：屏幕外也能靠它定位 */
  _beacon(color, radius) {
    const m = new T.Mesh(this.geo.cyl, new T.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.20, depthWrite: false, blending: T.AdditiveBlending
    }));
    const r = radius || 0.75;
    m.scale.set(r, 14, r); m.position.y = 7;
    return m;
  },

  /* --- 特效发射接口 --- */
  ring(pos, r0, r1, color, dur, vertical) {
    if (this.rings.count > 40) return;
    const o = this.rings.get();
    o.mesh.position.copy(pos); o.mesh.position.y += 0.06;
    o.mesh.material.color.setHex(color);
    o.mesh.visible = true; o.t = 0; o.dur = dur || 0.4; o.r0 = r0; o.r1 = r1;
    o.mesh.rotation.x = vertical ? 0 : -Math.PI / 2;
    if (vertical) o.mesh.lookAt(this.camera.position);
    return o;
  },
  puff(pos, s0, s1, color, dur) {
    if (this.puffs.count > 56) return;
    const o = this.puffs.get();
    o.mesh.position.copy(pos);
    o.mesh.material.color.setHex(color);
    o.mesh.visible = true; o.t = 0; o.dur = dur || 0.3; o.s0 = s0; o.s1 = s1;
  },
  spark(pos, dir, color) {
    if (this.sparks.count > 90) return;
    for (let i = 0; i < 3; i++) {
      const o = this.sparks.get();
      o.mesh.position.copy(pos);
      o.mesh.material.color.setHex(color);
      o.mesh.visible = true; o.t = 0; o.dur = 0.14 + RNG.fx.next() * 0.1;
      o.vel.set(RNG.fx.range(-1, 1), RNG.fx.range(-0.2, 1.2), RNG.fx.range(-1, 1))
        .normalize().multiplyScalar(RNG.fx.range(3, 8));
      if (dir) o.vel.addScaledVector(dir, 3);
    }
  },
  bolt(points, color) {
    const o = this.bolts.get();
    const attr = o.mesh.geometry.attributes.position;
    const n = Math.min(points.length, 10);
    for (let i = 0; i < 10; i++) {
      const p = points[Math.min(i, n - 1)];
      attr.array[i * 3] = p.x; attr.array[i * 3 + 1] = p.y; attr.array[i * 3 + 2] = p.z;
    }
    attr.needsUpdate = true;
    o.mesh.material.color.setHex(color || MUT.conduct.color);
    o.mesh.visible = true; o.t = 0;
  },

  updateFx(dt) {
    this.rings.live.forEach(o => {
      if (o._dead) return;
      o.t += dt;
      const k = o.t / o.dur;
      if (k >= 1) { this.rings.release(o); return; }
      const s = lerp(o.r0, o.r1, 1 - Math.pow(1 - k, 2.4));
      o.mesh.scale.set(s, s, s);
      o.mesh.material.opacity = (1 - k) * 0.85;
    });
    this.rings.compact();

    this.puffs.live.forEach(o => {
      if (o._dead) return;
      o.t += dt;
      const k = o.t / o.dur;
      if (k >= 1) { this.puffs.release(o); return; }
      const s = lerp(o.s0, o.s1, 1 - Math.pow(1 - k, 3));
      o.mesh.scale.setScalar(s);
      o.mesh.material.opacity = (1 - k) * 0.7;
    });
    this.puffs.compact();

    this.bolts.live.forEach(o => {
      if (o._dead) return;
      o.t += dt;
      const k = o.t / o.dur;
      if (k >= 1) { this.bolts.release(o); return; }
      o.mesh.material.opacity = (1 - k) * 0.95;
    });
    this.bolts.compact();

    this.sparks.live.forEach(o => {
      if (o._dead) return;
      o.t += dt;
      const k = o.t / o.dur;
      if (k >= 1) { this.sparks.release(o); return; }
      o.vel.y -= 22 * dt;
      o.mesh.position.addScaledVector(o.vel, dt);
      o.mesh.scale.setScalar(lerp(0.28, 0.02, k));
      o.mesh.material.opacity = 1 - k;
    });
    this.sparks.compact();
  },

  render() {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.gunScene, this.gunCam);
  }
};
