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
  const colors = parts.some(p => p.color !== undefined) ? new Float32Array(vcount * 3) : null;
  const idx = new (vcount > 65535 ? Uint32Array : Uint16Array)(icount);
  let vo = 0, io = 0;
  const nm = new T.Matrix3();
  parts.forEach(p => {
    const g = p.geo, m = p.mat;
    nm.getNormalMatrix(m);
    const gp = g.attributes.position, gn = g.attributes.normal;
    const v = new T.Vector3(), n = new T.Vector3();
    const color = colors ? new T.Color(p.color === undefined ? 0xffffff : p.color) : null;
    for (let i = 0; i < gp.count; i++) {
      v.fromBufferAttribute(gp, i).applyMatrix4(m);
      pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
      n.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      nrm[(vo + i) * 3] = n.x; nrm[(vo + i) * 3 + 1] = n.y; nrm[(vo + i) * 3 + 2] = n.z;
      if (colors) {
        colors[(vo + i) * 3] = color.r;
        colors[(vo + i) * 3 + 1] = color.g;
        colors[(vo + i) * 3 + 2] = color.b;
      }
    }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; }
    else { for (let i = 0; i < gp.count; i++) idx[io + i] = i + vo; io += gp.count; }
    vo += gp.count;
  });
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nrm, 3));
  if (colors) out.setAttribute('color', new T.BufferAttribute(colors, 3));
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
    // Shared faceted solids; enemy parts still merge into one body draw.
    g.facet = new T.IcosahedronGeometry(0.5, 0);
    g.taper = new T.CylinderGeometry(0.32, 0.5, 1, 5, 1, true).toNonIndexed();
    g.taper.computeVertexNormals();
    const outline = new T.Shape();
    outline.moveTo(-0.5, -0.3);
    [[-0.3, -0.5], [0.3, -0.5], [0.5, -0.3], [0.5, 0.3],
      [0.3, 0.5], [-0.3, 0.5], [-0.5, 0.3]].forEach(p => outline.lineTo(p[0], p[1]));
    outline.closePath();
    g.chamfer = new T.ExtrudeGeometry(outline, { depth: 1, bevelEnabled: false, steps: 1 });
    g.chamfer.translate(0, 0, -0.5);
  },

  /* ---------------------------------------------------------------- 城市 */
  _buildArena() {
    /* 只有一张地图：城市尺度。旧的 56m 平面竞技场与 todo3 的 70m 立体地图
       都已删除 —— 保留它们只会让每次改动都要同时维护三套光照、雾和碰撞。 */
    this.obstacles = [];
    this.arenaHalf = TUNE.VERTICAL_MAP.half;
    /* 城市尺度要看到远景天际线，雾推远；同时补光 ——
       原亮度是按 56m 竞技场调的，放进 220m 城市后大体块会糊成一片黑（todo4 §2.2）。 */
    const A = TUNE.ART;
    this.scene.fog = new T.Fog(A.fog, A.fogNear, A.fogFar);
    // A tiny generated gradient replaces the flat sky; no external texture.
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 2; skyCanvas.height = 128;
    const skyContext = skyCanvas.getContext('2d');
    const gradient = skyContext.createLinearGradient(0, 0, 0, 128);
    gradient.addColorStop(0, A.skyTop); gradient.addColorStop(0.62, A.skyHorizon);
    gradient.addColorStop(1, A.skyHorizon);
    skyContext.fillStyle = gradient; skyContext.fillRect(0, 0, 2, 128);
    this.scene.background = new T.CanvasTexture(skyCanvas);
    this.scene.background.encoding = T.sRGBEncoding;
    this.camera.far = 1000; this.camera.updateProjectionMatrix();
    this.hemi.intensity = A.ambient;
    this.hemi.color.setHex(A.skyLight); this.hemi.groundColor.setHex(A.groundLight);
    this.sun.color.setHex(A.sunColor);
    this.sun.intensity = A.sunIntensity;
    this.sun.position.fromArray(A.sunPosition);
    this.lamp.distance = 34; this.lamp.intensity = 0.55;
    CITY.build(this.scene);
    this._buildGroundShadows();
    this.arenaHalf = CITY.half;
  },

  /* Static ground projection + one instanced contact-shadow batch.
     Stencil prevents intersecting shadow polygons from darkening repeatedly. */
  _buildGroundShadows() {
    const S = TUNE.ART.shadow;
    const material = new T.MeshBasicMaterial({ color: S.color, opacity: S.opacity,
      transparent: true, depthWrite: false, side: T.DoubleSide,
      stencilWrite: true, stencilRef: 1, stencilFunc: T.NotEqualStencilFunc,
      stencilZPass: T.ReplaceStencilOp });
    const vertices = [];
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const hull = points => {
      points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const lo = [], hi = [];
      for (const p of points) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (let i = points.length - 1; i >= 0; i--) { const p = points[i]; while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
      lo.pop(); hi.pop(); return lo.concat(hi);
    };
    const dx = -this.sun.position.x / this.sun.position.y;
    const dz = -this.sun.position.z / this.sun.position.y;
    // Grounded solids only: suspended slabs must not become solid shadow towers.
    CITY.solids.filter(s => s.y0 <= S.groundY && s.y1 > 3 && !s.ramp).forEach(s => {
      const points = [];
      for (const x of [s.x0, s.x1]) for (const z of [s.z0, s.z1]) {
        points.push([x, z], [x + dx * s.y1, z + dz * s.y1]);
      }
      const polygon = hull(points);
      for (let i = 1; i < polygon.length - 1; i++) {
        for (const p of [polygon[0], polygon[i], polygon[i + 1]]) vertices.push(p[0], S.groundY, p[1]);
      }
    });
    const geometry = new T.BufferGeometry();
    geometry.setAttribute('position', new T.Float32BufferAttribute(vertices, 3));
    const shadows = new T.Mesh(geometry, material);
    shadows.renderOrder = 1; shadows.frustumCulled = false;
    this.scene.add(shadows);
    this.contactShadows = new T.InstancedMesh(new T.CircleGeometry(1, 12), material, S.capacity);
    this.contactShadows.count = 0; this.contactShadows.frustumCulled = false;
    this.contactShadows.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.contactShadows.renderOrder = 2; this.scene.add(this.contactShadows);
    this._shadowMatrix = new T.Matrix4();
    this._shadowQuaternion = new T.Quaternion().setFromEuler(new T.Euler(-Math.PI / 2, 0, 0));
    this._shadowPosition = new T.Vector3(); this._shadowScale = new T.Vector3();
    this._artTime = 0;
  },

  attachGait(material, phase) {
    const A = TUNE.ART.gait;
    material.userData.gait = { time: { value: phase }, motion: { value: 0 } };
    material.onBeforeCompile = shader => {
      shader.uniforms.artTime = material.userData.gait.time;
      shader.uniforms.artMotion = material.userData.gait.motion;
      shader.vertexShader = 'uniform float artTime; uniform float artMotion;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        float stepPhase = artTime + (position.x < 0.0 ? 3.14159265 : 0.0);
        float leg = max(0.0, 0.43 - position.y);
        transformed.z += sin(stepPhase) * leg * artMotion * ${A.stride.toFixed(4)};
        transformed.y += max(0.0, cos(stepPhase)) * leg * artMotion * ${A.lift.toFixed(4)};
        float arm = smoothstep(0.15, 0.24, abs(position.x)) * (1.0 - smoothstep(0.64, 0.76, position.y));
        transformed.z -= sin(stepPhase) * arm * artMotion * ${A.armSwing.toFixed(4)};
      `);
    };
    material.customProgramCacheKey = () => 'faceted-gait-v1';
  },

  _syncArt() {
    if (!this.contactShadows || typeof G === 'undefined' || !G.enemies) return;
    const S = TUNE.ART.shadow;
    const dt = G.time - this._artTime;
    let count = 0;
    for (const e of G.enemies.live) {
      if (e._dead || e.dead || !e.grp.visible) continue;
      const gait = e.bodyMat.userData.gait;
      if (gait) {
        if (dt > 0 && e._artPosition) {
          const speed = Math.hypot(e.pos.x - e._artPosition.x, e.pos.z - e._artPosition.z) / dt;
          gait.motion.value = Math.min(1, speed / Math.max(1, e.speed));
        }
        gait.time.value = G.time * TUNE.ART.gait.frequency + e.uid * 2.4;
      }
      if (!e._artPosition) e._artPosition = new T.Vector3();
      e._artPosition.copy(e.pos);
      if (count >= S.capacity) continue;
      // On a floor or roof; do not paint an ellipse in midair while jumping.
      if (e.nav && e.nav.grounded === false) continue;
      this._shadowPosition.set(e.pos.x, e.pos.y + S.groundY, e.pos.z);
      this._shadowScale.set(e.radius * 1.35, e.radius * 0.90, 1);
      this._shadowMatrix.compose(this._shadowPosition, this._shadowQuaternion, this._shadowScale);
      this.contactShadows.setMatrixAt(count++, this._shadowMatrix);
    }
    this.contactShadows.count = count;
    this.contactShadows.instanceMatrix.needsUpdate = true;
    this._artTime = G.time;
  },

  /* 碰撞：转交 citymap.js 做圆柱 vs AABB 的水平推出（垂直由调用方处理）。 */
  collide(p, radius, yBot, yTop) {
    p.x = clamp(p.x, -(CITY.halfX - 1.2 - radius), CITY.halfX - 1.2 - radius);
    p.z = clamp(p.z, -(CITY.halfZ - 1.2 - radius), CITY.halfZ - 1.2 - radius);
    const b = yBot === undefined ? p.y + 0.12 : yBot;
    const t = yTop === undefined ? p.y + 1.7 : yTop;
    CITY.depenetrate(p, radius, b, t, null);
  },

  /* ------------------------------------------------------------ 敌人模型 */
  _zombieGeoCache: {},
  zombieGeo(kind) {
    if (this._zombieGeoCache[kind]) return this._zombieGeoCache[kind];
    const g = this.geo, parts = [];
    const push = (geo, x, y, z, sx, sy, sz, rz) => parts.push({ geo: geo,
      mat: mat4(x, y, z, sx, sy, sz, rz), color: y < 0.75 ? 0xadb7a8 : 0xffffff });

    if (kind === 'heavy') {
      push(g.facet, 0, 1.28, 0, 1.40, 1.45, 0.95);
      push(g.facet, 0, 2.05, 0.04, 0.62, 0.62, 0.62);
      [-1, 1].forEach(s => {
        push(g.facet, s * 0.63, 1.58, 0, 0.62, 0.66, 0.72);
        push(g.taper, s * 0.78, 1.08, 0.18, 0.46, 0.98, 0.48, -s * 0.16);
        push(g.facet, s * 0.86, 0.58, 0.20, 0.48, 0.46, 0.52);
        push(g.taper, s * 0.32, 0.38, 0, 0.46, 0.72, 0.46);
        push(g.facet, s * 0.32, 0.08, 0.12, 0.45, 0.19, 0.60);
      });
      parts.push({ geo: g.oct, mat: mat4(0, 2.01, 0.31, 0.40, 0.24, 0.10), color: 0x26343c });
    } else if (kind === 'spitter') {
      push(g.facet, 0, 1.08, -0.02, 0.70, 1.1, 0.64);
      push(g.facet, 0, 1.76, 0.16, 0.5, 0.44, 0.56);
      push(g.facet, 0, 1.42, 0.34, 0.40, 0.50, 0.44);
      parts.push({ geo: g.oct, mat: mat4(0, 1.65, 0.41, 0.28, 0.17, 0.17), color: 0x26343c });
      [-1, 1].forEach(s => {
        push(g.taper, s * 0.40, 1.1, 0.1, 0.20, 0.95, 0.22, s * 0.28);
        push(g.facet, s * 0.52, 0.65, 0.14, 0.22, 0.28, 0.24);
        push(g.taper, s * 0.2, 0.35, 0, 0.26, 0.62, 0.26);
        push(g.facet, s * 0.2, 0.07, 0.10, 0.26, 0.15, 0.40);
      });
    } else if (kind === 'charger') {
      push(g.facet, 0, 1.35, 0, 1.30, 1.30, 1.05);
      push(g.facet, 0, 1.55, 0.62, 0.72, 0.6, 0.5);      // 前倾冲撞头
      push(g.cone, 0, 1.55, 1.0, 0.5, 0.7, 0.5);
      [-1, 1].forEach(s => {
        push(g.facet, s * 0.60, 1.55, 0.05, 0.62, 0.72, 0.68);
        push(g.taper, s * 0.72, 1.0, 0.3, 0.38, 0.96, 0.42, -s * 0.22);
        push(g.facet, s * 0.82, 0.55, 0.3, 0.40, 0.34, 0.46);
        push(g.taper, s * 0.3, 0.38, 0, 0.36, 0.76, 0.36);
        push(g.facet, s * 0.3, 0.08, 0.12, 0.36, 0.18, 0.52);
      });
    } else if (kind === 'boss') {
      push(g.facet, 0, 1.9, 0, 2.3, 2.2, 1.6);
      push(g.facet, 0, 3.15, 0.1, 1.0, 0.95, 1.0);
      [-1, 1].forEach(s => {
        push(g.facet, s * 1.0, 2.40, 0, 1.10, 1.05, 1.20);
        push(g.taper, s * 1.35, 1.70, 0.2, 0.76, 1.50, 0.76, -s * 0.20);
        push(g.facet, s * 1.50, 0.98, 0.24, 0.80, 0.68, 0.90);
        push(g.taper, s * 0.50, 0.52, 0, 0.65, 1.05, 0.65);
        push(g.facet, s * 0.50, 0.10, 0.18, 0.65, 0.22, 0.90);
      });
      parts.push({ geo: g.oct, mat: mat4(0, 3.1, 0.55, 0.65, 0.40, 0.16), color: 0x26343c });
      push(g.cone, -0.7, 3.3, 0, 0.34, 0.7, 0.34);
      push(g.cone, 0.7, 3.3, 0, 0.34, 0.7, 0.34);
    } else { /* grunt: broad shoulders, narrow waist, hanging angular arms.
                Head centre/extent retained for the existing weak-point sphere. */
      const width = kind === 'blast' ? 1.15 : kind === 'conduct' ? 0.76 : kind === 'overclock' ? 0.83 : 1;
      push(g.facet, 0, 1.22, -0.02, 0.88 * width, 0.87, 0.56);
      push(g.facet, 0, 0.80, -0.02, 0.48, 0.42, 0.40);
      push(g.facet, 0, 1.78, 0.02, 0.44, 0.48, 0.44);
      parts.push({ geo: g.oct, mat: mat4(0, 1.75, 0.205, 0.30, 0.22, 0.08), color: 0x26343c });
      [-1, 1].forEach(s => {
        parts.push({ geo: g.oct, mat: mat4(s * 0.070, 1.79, 0.238, 0.070, 0.033, 0.025, -s * 0.2), color: 0xf5e5aa });
        push(g.facet, s * 0.39 * width, 1.39, 0, 0.38, 0.38, 0.40);
        push(g.taper, s * 0.48 * width, 1.13, 0.04, 0.27 * width, 0.51, 0.29, s * 0.24);
        push(g.taper, s * 0.54 * width, 0.76, 0.13, 0.21, 0.41, 0.23, -s * 0.12);
        push(g.facet, s * 0.54 * width, 0.53, 0.15, 0.21, 0.27, 0.22);
        push(g.taper, s * 0.19, 0.50, -0.01, 0.29, 0.51, 0.32, -s * 0.10);
        push(g.taper, s * 0.21, 0.20, 0.01, 0.19, 0.37, 0.22);
        push(g.facet, s * 0.21, 0.07, 0.09, 0.26, 0.15, 0.40);
      });
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
      push(g.facet, 0, 1.16, 0.22, 0.78, 0.78, 0.66);
    } else if (mutId === 'fission') { // 紫色双核心 + 中缝
      push(g.facet, -0.22, 1.22, 0.24, 0.34, 0.34, 0.3);
      push(g.facet, 0.22, 1.22, 0.24, 0.34, 0.34, 0.3);
      push(g.box, 0, 1.15, 0.2, 0.05, 1.0, 0.3);
    } else if (mutId === 'overclock') { // 红色血管束（细长）
      push(g.box, 0, 1.35, 0.24, 0.1, 0.9, 0.1);
      push(g.box, -0.24, 1.3, 0.2, 0.07, 0.7, 0.07, 0.3);
      push(g.box, 0.24, 1.3, 0.2, 0.07, 0.7, 0.07, -0.3);
      push(g.sph, 0, 1.78, 0.14, 0.3, 0.3, 0.3);
    } else if (mutId === 'conduct') { // 青色神经节
      push(g.oct, 0, 1.65, 0.20, 0.23, 0.36, 0.22);
      [-1, 1].forEach(s => {
        push(g.taper, s * 0.24, 1.95, 0, 0.12, 0.40, 0.12, -s * 0.5);
        push(g.oct, s * 0.34, 2.18, 0, 0.12, 0.30, 0.12);
      });
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

    /* 子弹 = 曳光。以前这里是一颗 0.075 的小球，另外由 weapon.js 在枪口
       画一条 9m 的线段当曳光 —— 于是同一发子弹在画面上有【两个】东西：
       一条又长又快的光线，和一颗慢慢飞的球。Bao 的原话是
       「这两个本来应该是同一个东西……那种又长又快的特效，做子弹是最合适的」。
       所以球删掉，曳光线删掉，子弹本身就是那条又长又快的光带。

       用 InstancedMesh 而不是 LineSegments：WebGL 的线宽恒为 1px，
       而「重弹更粗」是 §11 要求能一眼分辨的信息，必须有真实粗细。
       圆柱建成 Z 轴朝向，实例矩阵直接按飞行方向拉伸。 */
    /* 头粗尾细：光带才有方向感，看得出是"射出去"而不是一根横着的棍。
       rotateX(+90°) 之后 +Y 端指向 +Z，也就是飞行方向的【头部】。
       锥度 1:0.10 不是审美挑的：半径按【头端】到镜头的距离算，
       而尾端在挂枪口那一段离镜头近得多（1m 对 10m），
       不把尾端收细的话，它在屏幕上会比头还粗。 */
    const bGeo = new T.CylinderGeometry(1, 0.10, 1, 6, 1, true);
    bGeo.rotateX(Math.PI / 2);                       // Y 轴 → Z 轴（飞行方向）
    this.bulletMesh = new T.InstancedMesh(bGeo, new T.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
      depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide
    }), 320);
    this.bulletMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.bulletMesh.count = 0; this.bulletMesh.frustumCulled = false;
    this.scene.add(this.bulletMesh);

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

    /* 磁铁：紫色，和绿色医疗、青绿经验球都区分得开。
       形状用两根短柱做成 U 形，远远看去就是一块磁铁。 */
    this.magMesh = new T.Group();
    const magMat = new T.MeshLambertMaterial({ color: 0xc58aff, emissive: 0x6a2fb0, emissiveIntensity: 0.9 });
    const tipMat = new T.MeshBasicMaterial({ color: 0xffe6a8 });
    const leg = (x, mat) => {
      const m = new T.Mesh(g.box, mat);
      m.scale.set(0.18, 0.55, 0.18); m.position.set(x, 0.85, 0);
      this.magMesh.add(m); return m;
    };
    leg(-0.22, magMat); leg(0.22, magMat);
    const yoke = new T.Mesh(g.box, magMat);
    yoke.scale.set(0.62, 0.18, 0.18); yoke.position.y = 1.18;
    this.magMesh.add(yoke);
    const t1 = new T.Mesh(g.box, tipMat); t1.scale.set(0.2, 0.12, 0.2); t1.position.set(-0.22, 0.56, 0);
    const t2 = new T.Mesh(g.box, tipMat); t2.scale.set(0.2, 0.12, 0.2); t2.position.set(0.22, 0.56, 0);
    this.magMesh.add(t1); this.magMesh.add(t2);
    this.magCore = yoke;
    this.magMesh.add(this._beacon(0xc58aff));
    this.magMesh.visible = false;
    this.scene.add(this.magMesh);

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
    this._syncArt();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.gunScene, this.gunCam);
  }
};
