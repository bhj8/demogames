/* ============================================================================
   SYMBIOTIC FIRE · 枪械表现层（todo2.md）

   纪律：这一层【只消费事件】。它不拥有伤害、敌人生命、升级抽取规则。
   game.js / combat.js 在确定事件已经发生之后，向这里发送结构化事件。
   所有手感参数在 tune.js 的 WEAPON_FX 里，这个文件不写魔法数字。
   ========================================================================== */
'use strict';

/* 二阶弹簧：回位必须带速度，单调 smooth 到 0 会有塑料插值感（todo2 §3.1） */
function Spring(stiffness, damping) {
  this.k = stiffness; this.d = damping; this.v = 0; this.x = 0;
}
Spring.prototype.push = function (impulse) { this.v += impulse; };
Spring.prototype.step = function (dt, target) {
  const t = target || 0;
  /* 半隐式欧拉，dt 大时也不炸 */
  this.v += (-(this.x - t) * this.k - this.v * this.d) * dt;
  this.x += this.v * dt;
};
Spring.prototype.reset = function () { this.v = 0; this.x = 0; };

const WEAPON = {
  rig: null, parts: {}, organs: {},
  ready: false,

  /* --- 动力学通道（§3.1 拆成两条）--- */
  kickZ: null, kickPitch: null, kickRoll: null,   // 每枪冲击
  climb: 0,                                       // 持续射击的慢累积
  boltSpring: null,
  sway: { x: 0, y: 0, vx: 0, vy: 0 },
  bobT: 0, breathT: 0,
  pose: { sprint: 0, reload: 0, ads: 0 },
  adsWant: false,

  /* --- 弹匣与换弹状态机（§6.3）--- */
  reload: { active: false, t: 0, total: 1, phase: -1, magHidden: false },
  boltLocked: false,
  lastAmmoShown: -1,

  /* --- 事件计数，供调试面板观察 --- */
  stats: { shots: 0, shells: 0, tracers: 0 },

  /* ==========================================================================
     todo5 §11：每个模块必须拥有独立、可合并的反馈层。
     这张表是【登记表，不是文案】—— 每个分子必须有看得见的枪械反馈
     「这张卡有没有反馈路径」，所以每一项后面都注明由谁真的画/响出来。
     缺一项，对应卡牌不进随机池。
     ========================================================================== */
  moduleFx: {
    volley: 'muzzle+多条枪线（_onShot flashOuter2 / game.js fire 多曳光）',
    blast: '爆点+冲击波+合并音效（ATK._blastFx）',
    pierce: '连续命中音阶+纵向尾迹（_onShot boltSpeed / addTracer 长枪线）',
    heavy: '枪模后坐+巨响+粗枪线（_onShot heavy 通道）',
    overclock: '升速音层+枪口密度+血管发光（update veinMat / boltSpeed）',
    ricochet: '折线曳光（ATK._bounceFx）',
    momentum: '移动蓄能与释放提示（update coilMat + game.js fire momentum 分支）'
  },

  /* ==========================================================================
     构建骨架 §2 —— 每个部件都要能被事件单独驱动，
     不能再靠"移动整把枪"假装完成所有机械动作。
     ========================================================================== */
  build(scene, geo) {
    const T = THREE, W = TUNE.WEAPON_FX;
    const root = new T.Group();
    const body = new T.Group();
    root.add(body);

    const steel = new T.MeshLambertMaterial({ color: 0x40474f });
    const dark = new T.MeshLambertMaterial({ color: 0x22262b });
    const darker = new T.MeshLambertMaterial({ color: 0x191c21 });

    const box = (parent, mat, x, y, z, sx, sy, sz, rx) => {
      const m = new T.Mesh(geo.box, mat);
      m.position.set(x, y, z); m.scale.set(sx, sy, sz);
      if (rx) m.rotation.x = rx;
      parent.add(m); return m;
    };
    const cyl = (parent, mat, x, y, z, r, len) => {
      const m = new T.Mesh(geo.cyl, mat);
      m.position.set(x, y, z); m.scale.set(r, len, r);
      m.rotation.x = Math.PI / 2;
      parent.add(m); return m;
    };

    /* 机匣与固定件 */
    box(body, dark, 0, 0, 0, 0.085, 0.10, 0.46);
    box(body, darker, 0, 0.005, 0.26, 0.06, 0.07, 0.13);        // 枪托
    box(body, dark, 0, -0.10, 0.19, 0.05, 0.13, 0.06);          // 握把
    box(body, steel, 0, 0.062, -0.06, 0.03, 0.03, 0.20);        // 导轨

    /* 枪管与主枪口节点 */
    cyl(body, steel, 0, 0.012, -0.42, 0.032, 0.42);
    const muzzlePrimary = new T.Object3D();
    muzzlePrimary.position.set(0, 0.012, -0.645);
    body.add(muzzlePrimary);

    /* 双联枪管：升级后才启用（§11） */
    const secondaryGrp = new T.Group();
    secondaryGrp.visible = false;
    cyl(secondaryGrp, steel, 0.052, -0.028, -0.40, 0.026, 0.38);
    const muzzleSecondary = new T.Object3D();
    muzzleSecondary.position.set(0.052, -0.028, -0.60);
    secondaryGrp.add(muzzleSecondary);
    body.add(secondaryGrp);

    /* 枪机：比枪身更快地后退与复位，空仓时锁在后方 */
    const bolt = new T.Group();
    box(bolt, steel, 0, 0.075, -0.02, 0.055, 0.045, 0.24);
    box(bolt, darker, 0.062, 0.070, 0.02, 0.03, 0.028, 0.10);   // 拉机柄
    body.add(bolt);

    /* 弹匣：独立部件，退匣/插匣/扩容都要真的动 */
    const magazine = new T.Group();
    box(magazine, darker, 0, -0.075, 0.10, 0.055, 0.16, 0.10);
    body.add(magazine);

    /* 换弹时跟随弹匣的手 */
    const hand = new T.Group();
    box(hand, new T.MeshLambertMaterial({ color: 0x6a5548 }), 0, -0.16, 0.12, 0.075, 0.085, 0.09);
    hand.visible = false;
    body.add(hand);

    /* 枪口焰：外焰 + 核心焰，从真实枪口节点发出（§5.1） */
    const flashMat = (c, op) => new T.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending
    });
    const flashOuter = new T.Mesh(geo.cone, flashMat(0xffb347));
    flashOuter.rotation.x = -Math.PI / 2;
    muzzlePrimary.add(flashOuter);
    const flashCore = new T.Mesh(geo.sph, flashMat(0xfff3d0));
    muzzlePrimary.add(flashCore);

    const flashOuter2 = new T.Mesh(geo.cone, flashMat(0xffb347));
    flashOuter2.rotation.x = -Math.PI / 2;
    muzzleSecondary.add(flashOuter2);
    const flashCore2 = new T.Mesh(geo.sph, flashMat(0xfff3d0));
    muzzleSecondary.add(flashCore2);

    /* 枪口灯：复用同一盏，绝不每枪 new（§12） */
    const muzzleLight = new T.PointLight(0xffca80, 0, W.muzzleLightRange, 2);
    muzzleLight.position.set(0, 0.05, -0.5);
    body.add(muzzleLight);

    /* 枪上弹量读数 */
    const cvs = document.createElement('canvas');
    cvs.width = 128; cvs.height = 64;
    const ctx2d = cvs.getContext('2d');
    const tex = new T.CanvasTexture(cvs);
    const screen = new T.Mesh(geo.plane, new T.MeshBasicMaterial({ map: tex, transparent: true }));
    screen.position.set(-0.088, 0.02, 0.06);
    screen.rotation.y = -Math.PI / 2;
    screen.scale.set(0.16, 0.08, 1);
    body.add(screen);

    /* 六种共同变异的器官 —— 重构后必须继续挂在 body 下（§2 硬约束） */
    const om = c => new T.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.45 });
    const organ = (id, buildFn) => {
      const o = new T.Group(); o.visible = false; body.add(o); buildFn(o); this.organs[id] = o;
    };
    organ('blast', o => {
      const m = om(MUT.blast.color);
      [[-0.075, -0.02, -0.16], [0.075, -0.02, -0.16], [0, -0.05, -0.30]].forEach(([x, y, z]) => {
        const s = new T.Mesh(geo.sphHi, m); s.position.set(x, y, z); s.scale.setScalar(0.085); o.add(s);
      });
    });
    organ('fission', o => {
      const m = om(MUT.fission.color);
      [-1, 1].forEach(s => {
        const b = new T.Mesh(geo.cyl, m);
        b.position.set(0.045 * s, 0.012, -0.55); b.scale.set(0.022, 0.20, 0.022);
        b.rotation.x = Math.PI / 2; b.rotation.z = 0.14 * s; o.add(b);
      });
      const core = new T.Mesh(geo.oct, m); core.position.set(0, 0.012, -0.42); core.scale.setScalar(0.07); o.add(core);
    });
    organ('overclock', o => {
      const m = om(MUT.overclock.color);
      this.veinMat = m;
      [[-0.09, 0.02, -0.05], [0.09, 0.02, -0.05], [0, 0.06, 0.06]].forEach(([x, y, z]) => {
        const v = new T.Mesh(geo.box, m); v.position.set(x, y, z); v.scale.set(0.014, 0.014, 0.36); o.add(v);
      });
    });
    organ('ossify', o => {
      const m = om(0xcfc6b2); m.emissiveIntensity = 0.06;
      [[-0.10, 0, -0.10, 0.02, 0.11, 0.34], [0.10, 0, -0.10, 0.02, 0.11, 0.34], [0, 0.075, -0.20, 0.09, 0.02, 0.22]]
        .forEach(([x, y, z, sx, sy, sz]) => {
          const p = new T.Mesh(geo.box, m); p.position.set(x, y, z); p.scale.set(sx, sy, sz); o.add(p);
        });
    });
    organ('conduct', o => {
      const m = om(MUT.conduct.color);
      this.coilMat = m;
      for (let i = 0; i < 5; i++) {
        const n = new T.Mesh(geo.box, m);
        n.position.set((i % 2 ? 1 : -1) * 0.075, 0.03 - i * 0.012, -0.02 - i * 0.09);
        n.scale.set(0.012, 0.012, 0.11); n.rotation.z = (i % 2 ? 0.5 : -0.5); o.add(n);
      }
      const coil = new T.Mesh(geo.cyl, m); coil.position.set(0, 0.07, -0.32);
      coil.scale.set(0.05, 0.03, 0.05); o.add(coil);
    });
    organ('giant', o => {
      const m = om(MUT.giant.color);
      const mz = new T.Mesh(geo.cyl, m); mz.position.set(0, 0.012, -0.60);
      mz.scale.set(0.075, 0.14, 0.075); mz.rotation.x = Math.PI / 2; o.add(mz);
      const br = new T.Mesh(geo.box, m); br.position.set(0, -0.06, -0.20); br.scale.set(0.13, 0.03, 0.16); o.add(br);
    });

    root.scale.setScalar(W.rigScale);
    scene.add(root);

    this.rig = root;
    this.parts = {
      body: body, bolt: bolt, magazine: magazine, hand: hand,
      muzzlePrimary: muzzlePrimary, muzzleSecondary: muzzleSecondary, secondaryGrp: secondaryGrp,
      flashOuter: flashOuter, flashCore: flashCore, flashOuter2: flashOuter2, flashCore2: flashCore2,
      muzzleLight: muzzleLight, screen: screen, screenCtx: ctx2d, screenTex: tex
    };

    this.kickZ = new Spring(W.kickStiffness, W.kickDamping);
    this.kickPitch = new Spring(W.kickStiffness, W.kickDamping);
    this.kickRoll = new Spring(W.kickStiffness * 0.8, W.kickDamping * 1.1);
    this.boltSpring = new Spring(W.boltStiffness, W.boltDamping);

    this._buildWorldFx();
    this.ready = true;
    return root;
  },

  /* 世界里的表现：曳光、弹壳、掉落弹匣、枪口世界闪光 —— 全部池化（§12） */
  _buildWorldFx() {
    const T = THREE, W = TUNE.WEAPON_FX;

    /* 曳光：一整个 LineSegments，一次 draw call 撑住所有轨迹 */
    const cap = W.tracerCap;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(cap * 6), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(cap * 6), 3));
    const mat = new T.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, blending: T.AdditiveBlending
    });
    this.tracerMesh = new T.LineSegments(g, mat);
    this.tracerMesh.frustumCulled = false;
    R.scene.add(this.tracerMesh);
    this.tracers = [];
    for (let i = 0; i < cap; i++) {
      this.tracers.push({ live: false, t: 0, dur: 0.06, from: new T.Vector3(), to: new T.Vector3(), c: [1, 1, 1] });
    }

    /* 弹壳：InstancedMesh */
    const shellGeo = new T.CylinderGeometry(0.016, 0.014, 0.05, 6);
    this.shellMesh = new T.InstancedMesh(shellGeo, new T.MeshLambertMaterial({ color: 0xc9a227 }), W.shellCap);
    this.shellMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.shellMesh.count = 0; this.shellMesh.frustumCulled = false;
    R.scene.add(this.shellMesh);
    this.shells = [];
    for (let i = 0; i < W.shellCap; i++) {
      this.shells.push({
        live: false, t: 0, pos: new T.Vector3(), vel: new T.Vector3(),
        rot: new T.Euler(), spin: new T.Vector3(), bounced: false, scale: 1
      });
    }

    /* 掉落的弹匣 */
    this.mags = [];
    const magGeo = new T.BoxGeometry(0.09, 0.26, 0.16);
    const magMat = new T.MeshLambertMaterial({ color: 0x191c21 });
    for (let i = 0; i < 4; i++) {
      const m = new T.Mesh(magGeo, magMat);
      m.visible = false; R.scene.add(m);
      this.mags.push({ live: false, t: 0, mesh: m, vel: new T.Vector3(), spin: new T.Vector3() });
    }

    /* 枪口的世界闪光：一盏灯复用 */
    this.worldFlash = new T.PointLight(0xffca80, 0, W.muzzleLightRange * 1.8, 2);
    R.scene.add(this.worldFlash);

    this._m4 = new T.Matrix4(); this._q = new T.Quaternion(); this._s = new T.Vector3(1, 1, 1);
    this._muzzleWorld = new T.Vector3();
  },

  /* 取主枪口的世界位置：曳光必须从真实枪口出发（§5.2） */
  muzzleWorldPos(out) {
    const p = this.parts.muzzlePrimary;
    p.updateWorldMatrix(true, false);
    /* gunCam 恒在原点且不旋转，所以 gunScene 坐标就是相机局部坐标，
       直接乘主相机的世界矩阵即可得到世界位置。 */
    out.setFromMatrixPosition(p.matrixWorld);
    R.camera.updateWorldMatrix(true, false);
    out.applyMatrix4(R.camera.matrixWorld);
    return out;
  },

  /* ==========================================================================
     事件入口 §1
     ========================================================================== */
  on(evt, data) {
    if (!this.ready) return;
    const W = TUNE.WEAPON_FX;
    data = data || {};
    switch (evt) {
      case 'shot': this._onShot(data); break;
      case 'empty': this._onEmpty(data); break;
      case 'reloadStart': this._onReloadStart(data); break;
      case 'reloadEnd': this._onReloadEnd(data); break;
      case 'buildChanged': this._onBuildChanged(data); break;
      case 'dash': this.kickPitch.push(-W.dashKick); break;
    }
  },

  _onShot(d) {
    const W = TUNE.WEAPON_FX;
    /* todo5 §4.6：动势释放必须有区别于普通重型弹的视听轮廓 ——
       所以它直接加进「单发多重」这条通道，而不是另开一个特效。 */
    const heavy = (d.heavy || 1) * (1 + (d.momentum || 0) * 0.55);

    /* 两条通道：快速冲击 + 慢累积 */
    this.kickZ.push(W.shotKickZ * heavy);
    this.kickPitch.push(W.shotKickPitch * heavy);
    this.kickRoll.push((Math.random() < 0.5 ? -1 : 1) * W.shotKickRoll * heavy);
    this.climb = Math.min(W.climbMax, this.climb + W.climbPerShot * heavy);

    /* 枪机比枪身更快地往复 */
    this.boltSpring.push(W.boltKick * (d.boltSpeed || 1));

    /* 枪口焰：外焰随机旋转缩放，核心焰更短更亮 */
    const P = this.parts;
    const s = W.flashScale * heavy * (0.85 + Math.random() * 0.3);
    P.flashOuter.material.opacity = W.flashOuterOpacity;
    P.flashOuter.scale.set(s, s * 1.5, s);
    P.flashOuter.rotation.z = Math.random() * Math.PI * 2;
    P.flashCore.material.opacity = W.flashCoreOpacity;
    P.flashCore.scale.setScalar(s * 0.55);
    if (d.pellets > 1) {
      P.flashOuter2.material.opacity = W.flashOuterOpacity;
      P.flashOuter2.scale.set(s * 0.9, s * 1.35, s * 0.9);
      P.flashOuter2.rotation.z = Math.random() * Math.PI * 2;
      P.flashCore2.material.opacity = W.flashCoreOpacity;
      P.flashCore2.scale.setScalar(s * 0.5);
    }
    P.muzzleLight.intensity = W.muzzleLightPeak * heavy;
    this.worldFlash.intensity = W.worldFlashPeak * heavy;
    this.muzzleWorldPos(this._muzzleWorld);
    this.worldFlash.position.copy(this._muzzleWorld);

    this.spawnShell(d);
    this.stats.shots++;

    /* 空仓：枪机停在后方 */
    if (d.isLastRound) this.boltLocked = true;
  },

  _onEmpty() {
    Audio2.dryClick();
    this.kickPitch.push(TUNE.WEAPON_FX.dryKick);
  },

  /* 分阶段换弹 §6.3：单一 reloadT 换成可读的事件序列 */
  _onReloadStart(d) {
    this.reload.active = true;
    this.reload.t = 0;
    this.reload.total = d.total || 1;
    this.reload.phase = -1;
    this.boltLocked = false;
  },

  _onReloadEnd() {
    this.reload.active = false;
    this.reload.phase = -1;
    this.parts.magazine.visible = true;
    this.parts.hand.visible = false;
    this.boltLocked = false;
  },

  _onBuildChanged(d) {
    /* 外观必须跟着机制一起变（§11） */
    this.parts.secondaryGrp.visible = !!d.twin;
    const magScale = 1 + (d.magLevel || 0) * 0.22;
    this.parts.magazine.scale.set(1, magScale, 1);
    this.heavy = d.heavy || 1;
    this.updateScreen(true);
  },

  /* --- 抛壳 §7 --- */
  spawnShell(d) {
    const W = TUNE.WEAPON_FX;
    let sh = null;
    for (let i = 0; i < this.shells.length; i++) if (!this.shells[i].live) { sh = this.shells[i]; break; }
    if (!sh) { sh = this.shells[this._shellRR = (this._shellRR + 1 || 0) % this.shells.length]; }  // 满了就回收最旧
    this.muzzleWorldPos(this._muzzleWorld);
    sh.live = true; sh.t = 0; sh.bounced = false;
    sh.scale = (d.heavy || 1) * W.shellScale;
    sh.pos.copy(this._muzzleWorld);
    /* 从抛壳口向右上方飞出 */
    const right = TV.set(1, 0, 0).applyQuaternion(R.camera.quaternion);
    const up = TV2.set(0, 1, 0);
    sh.pos.addScaledVector(right, 0.12).addScaledVector(up, -0.05);
    sh.vel.copy(right).multiplyScalar(W.shellVelX * (0.8 + Math.random() * 0.4));
    sh.vel.y += W.shellVelY * (0.8 + Math.random() * 0.4);
    sh.spin.set(Math.random() * 24 - 12, Math.random() * 24 - 12, Math.random() * 24 - 12);
    this.stats.shells++;
  },

  dropMagazine() {
    for (let i = 0; i < this.mags.length; i++) {
      const m = this.mags[i];
      if (m.live) continue;
      this.muzzleWorldPos(this._muzzleWorld);
      m.live = true; m.t = 0;
      m.mesh.position.copy(this._muzzleWorld);
      m.mesh.position.y -= 0.35;
      m.mesh.position.addScaledVector(R.camera.getWorldDirection(TV), 0.35);
      m.vel.set((Math.random() - 0.5) * 0.6, -0.4, (Math.random() - 0.5) * 0.6);
      m.spin.set(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3);
      m.mesh.visible = true;
      return;
    }
  },

  /* --- 曳光 §5.2 --- */
  addTracer(fromWorld, dir, color, len) {
    const W = TUNE.WEAPON_FX;
    let tr = null;
    for (let i = 0; i < this.tracers.length; i++) if (!this.tracers[i].live) { tr = this.tracers[i]; break; }
    if (!tr) return;
    tr.live = true; tr.t = 0; tr.dur = W.tracerLife;
    tr.from.copy(fromWorld);
    tr.to.copy(fromWorld).addScaledVector(dir, len || W.tracerLength);
    tr.c[0] = ((color >> 16) & 255) / 255;
    tr.c[1] = ((color >> 8) & 255) / 255;
    tr.c[2] = (color & 255) / 255;
    this.stats.tracers++;
  },

  /* ==========================================================================
     每帧更新
     ========================================================================== */
  update(dt, ctx) {
    if (!this.ready) return;
    const W = TUNE.WEAPON_FX, P = this.parts;

    /* --- 姿态权重混合，不互相覆盖坐标（§3.2）--- */
    const want = {
      sprint: ctx.sprinting ? 1 : 0,
      reload: this.reload.active ? 1 : 0,
      ads: (this.adsWant && !this.reload.active && !ctx.sprinting) ? 1 : 0
    };
    const bl = 1 - Math.exp(-W.poseBlend * dt);
    this.pose.sprint += (want.sprint - this.pose.sprint) * bl;
    this.pose.reload += (want.reload - this.pose.reload) * bl;
    this.pose.ads += (want.ads - this.pose.ads) * bl;

    /* --- 弹簧推进 --- */
    this.kickZ.step(dt); this.kickPitch.step(dt); this.kickRoll.step(dt);
    this.boltSpring.step(dt);
    this.climb = Math.max(0, this.climb - W.climbDecay * dt);

    /* --- 本地速度：必须投影到相机的 right / forward（§3.2）
           之前直接用 p.vel.x 是世界坐标，玩家转身后同样的移动会给出不同的枪摆 --- */
    const fwd = R.camera.getWorldDirection(TV).setY(0).normalize();
    const right = TV2.set(fwd.z, 0, -fwd.x);
    const vx = ctx.vel.x * right.x + ctx.vel.z * right.z;
    const vz = ctx.vel.x * fwd.x + ctx.vel.z * fwd.z;
    const speed = Math.hypot(vx, vz);

    /* --- 步态：横纵都要闭环，不只做垂直正弦 --- */
    this.bobT += dt * speed * W.bobRate;
    const bobX = Math.sin(this.bobT) * W.bobAmpX * Math.min(1, speed / 6);
    const bobY = Math.abs(Math.cos(this.bobT)) * W.bobAmpY * Math.min(1, speed / 6);

    /* --- 静止呼吸 --- */
    this.breathT += dt;
    const idle = Math.max(0, 1 - speed / 1.5);
    const brX = Math.sin(this.breathT * 0.9) * W.breathAmp * idle;
    const brY = Math.sin(this.breathT * 1.7) * W.breathAmp * 0.7 * idle;

    /* --- 鼠标惯性摆动：转身时反向甩，停下自然回位 --- */
    this.sway.vx += (-ctx.yawDelta * W.swayGain - this.sway.x * W.swayK - this.sway.vx * W.swayD) * dt * 60;
    this.sway.vy += (-ctx.pitchDelta * W.swayGain - this.sway.y * W.swayK - this.sway.vy * W.swayD) * dt * 60;
    this.sway.x += this.sway.vx * dt;
    this.sway.y += this.sway.vy * dt;
    this.sway.x = clamp(this.sway.x, -W.swayMax, W.swayMax);
    this.sway.y = clamp(this.sway.y, -W.swayMax, W.swayMax);

    /* --- 组装最终姿态 --- */
    const adsK = this.pose.ads;
    const baseX = lerp(W.hipX, W.adsX, adsK);
    const baseY = lerp(W.hipY, W.adsY, adsK);
    const baseZ = lerp(W.hipZ, W.adsZ, adsK);
    const swayScale = lerp(1, W.adsSwayScale, adsK) * (ctx.stableLevel ? Math.pow(0.82, ctx.stableLevel) : 1);

    let px = baseX + (this.sway.x + bobX + brX) * swayScale - vx * W.strafeLean * 0.01;
    let py = baseY + (this.sway.y + bobY + brY) * swayScale;
    let pz = baseZ + this.kickZ.x * W.viewmodelRecoilScale + vz * W.forwardLag * 0.01;

    /* 冲刺：枪械下沉并偏转 */
    px += this.pose.sprint * W.sprintX;
    py += this.pose.sprint * W.sprintY;
    /* 换弹：枪械下沉 */
    py += this.pose.reload * W.reloadDrop;

    P.body.parent.position.set(px, py, pz);
    P.body.parent.rotation.set(
      this.kickPitch.x * W.viewmodelRecoilScale + this.pose.sprint * W.sprintPitch + this.pose.reload * W.reloadPitch,
      this.sway.x * W.swayYaw + this.pose.sprint * W.sprintYaw,
      this.kickRoll.x * W.viewmodelRecoilScale + this.sway.x * W.swayRoll + this.pose.sprint * W.sprintRoll
    );

    /* --- 枪机位置：空仓锁在后方 --- */
    const boltZ = this.boltLocked ? W.boltTravel : clamp(this.boltSpring.x, 0, W.boltTravel);
    P.bolt.position.z = boltZ;

    /* --- 枪口焰衰减：限制累计亮度，不能持续遮挡准星（§5.1）--- */
    const fade = Math.exp(-W.flashDecay * dt);
    P.flashOuter.material.opacity *= fade;
    P.flashCore.material.opacity *= fade * 0.75;
    P.flashOuter2.material.opacity *= fade;
    P.flashCore2.material.opacity *= fade * 0.75;
    P.muzzleLight.intensity *= fade;
    this.worldFlash.intensity *= fade * 0.9;

    /* --- 超频：血管发光与枪机节奏同步（§11）--- */
    if (this.veinMat) this.veinMat.emissiveIntensity = 0.3 + (ctx.overclock || 0) * 1.4;
    if (this.coilMat) this.coilMat.emissiveIntensity = 0.35 + (ctx.conductCharge || 0) * 1.2;

    this.updateReload(dt, ctx);
    this.updateWorldFx(dt);
    this.updateScreen(false, ctx);
  },

  /* 分阶段换弹推进 §6.3 —— 快速装填按同一比例加速整套动作，不允许动作与计时错位 */
  updateReload(dt, ctx) {
    const r = this.reload, P = this.parts, W = TUNE.WEAPON_FX;
    if (!r.active) return;
    r.t += dt;
    const k = clamp(r.t / r.total, 0, 1);

    const phases = W.reloadPhases;   // {magOut, magFall, magIn, bolt}
    let phase = 0;
    if (k >= phases.bolt) phase = 4;
    else if (k >= phases.magIn) phase = 3;
    else if (k >= phases.magFall) phase = 2;
    else if (k >= phases.magOut) phase = 1;

    if (phase !== r.phase) {
      r.phase = phase;
      if (phase === 1) { P.magazine.visible = false; P.hand.visible = true; Audio2.magOut(); this.dropMagazine(); }
      if (phase === 3) { P.magazine.visible = true; Audio2.magIn(); if (ctx && ctx.onMagIn) ctx.onMagIn(); }
      if (phase === 4) { P.hand.visible = false; Audio2.boltPull(); this.boltSpring.push(W.boltKick * 1.6); }
    }

    /* 手与弹匣在退匣/插匣之间的位移 */
    const magT = phase === 1 ? 1 : phase === 2 ? 1 : phase === 3 ? Math.max(0, 1 - (k - phases.magIn) / 0.14) : 0;
    P.magazine.position.y = -magT * 0.14;
    P.hand.position.y = -magT * 0.10;
  },

  updateWorldFx(dt) {
    const W = TUNE.WEAPON_FX;

    /* 曳光 */
    const attr = this.tracerMesh.geometry.attributes;
    let n = 0;
    for (let i = 0; i < this.tracers.length; i++) {
      const tr = this.tracers[i];
      if (!tr.live) continue;
      tr.t += dt;
      if (tr.t >= tr.dur) { tr.live = false; continue; }
      const a = 1 - tr.t / tr.dur;
      const o = n * 6;
      attr.position.array[o] = tr.from.x; attr.position.array[o + 1] = tr.from.y; attr.position.array[o + 2] = tr.from.z;
      attr.position.array[o + 3] = tr.to.x; attr.position.array[o + 4] = tr.to.y; attr.position.array[o + 5] = tr.to.z;
      attr.color.array[o] = tr.c[0] * a; attr.color.array[o + 1] = tr.c[1] * a; attr.color.array[o + 2] = tr.c[2] * a;
      attr.color.array[o + 3] = tr.c[0] * a * 0.15; attr.color.array[o + 4] = tr.c[1] * a * 0.15; attr.color.array[o + 5] = tr.c[2] * a * 0.15;
      n++;
    }
    attr.position.needsUpdate = true; attr.color.needsUpdate = true;
    this.tracerMesh.geometry.setDrawRange(0, n * 2);

    /* 弹壳 */
    let sc = 0;
    for (let i = 0; i < this.shells.length; i++) {
      const sh = this.shells[i];
      if (!sh.live) continue;
      sh.t += dt;
      if (sh.t > W.shellLife) { sh.live = false; continue; }
      sh.vel.y -= 22 * dt;
      sh.pos.addScaledVector(sh.vel, dt);
      if (sh.pos.y < 0.02) {
        sh.pos.y = 0.02;
        if (!sh.bounced) {
          sh.bounced = true;
          sh.vel.y = -sh.vel.y * 0.42;
          sh.vel.x *= 0.6; sh.vel.z *= 0.6;
          Audio2.shellDrop(sh.pos);
        } else { sh.vel.set(0, 0, 0); }
      }
      sh.rot.x += sh.spin.x * dt; sh.rot.y += sh.spin.y * dt; sh.rot.z += sh.spin.z * dt;
      this._q.setFromEuler(sh.rot);
      this._s.setScalar(sh.scale);
      this._m4.compose(sh.pos, this._q, this._s);
      if (sc < this.shellMesh.count + 1 || sc < W.shellCap) this.shellMesh.setMatrixAt(sc++, this._m4);
    }
    this.shellMesh.count = sc;
    this.shellMesh.instanceMatrix.needsUpdate = true;

    /* 掉落弹匣 */
    for (let i = 0; i < this.mags.length; i++) {
      const m = this.mags[i];
      if (!m.live) continue;
      m.t += dt;
      if (m.t > W.magLife) { m.live = false; m.mesh.visible = false; continue; }
      m.vel.y -= 20 * dt;
      m.mesh.position.addScaledVector(m.vel, dt);
      if (m.mesh.position.y < 0.08) { m.mesh.position.y = 0.08; m.vel.set(0, 0, 0); m.spin.set(0, 0, 0); }
      m.mesh.rotation.x += m.spin.x * dt; m.mesh.rotation.y += m.spin.y * dt; m.mesh.rotation.z += m.spin.z * dt;
      if (m.t > W.magLife - 1) m.mesh.visible = Math.sin(m.t * 30) > 0;
    }
  },

  /* 枪上读数与 HUD 保持一致（§6.1） */
  updateScreen(force, ctx) {
    const P = this.parts;
    const ammo = ctx ? ctx.ammo : this.lastAmmoShown;
    const cap = ctx ? ctx.magazine : 0;
    if (!force && ammo === this.lastAmmoShown) return;
    this.lastAmmoShown = ammo;
    const c = P.screenCtx;
    c.clearRect(0, 0, 128, 64);
    c.fillStyle = 'rgba(6,10,16,0.85)'; c.fillRect(0, 0, 128, 64);
    const low = cap > 0 && ammo / cap < 0.25;
    c.fillStyle = ctx && ctx.infiniteMag ? '#7ef0a8' : (low ? '#ff8a4a' : '#9fe4ff');
    c.font = 'bold 40px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(ctx && ctx.infiniteMag ? '∞' : String(ammo), 64, 34);
    P.screenTex.needsUpdate = true;
  },

  setOrgan(id, on) { if (this.organs[id]) this.organs[id].visible = on; },

  reset() {
    this.kickZ.reset(); this.kickPitch.reset(); this.kickRoll.reset(); this.boltSpring.reset();
    this.climb = 0; this.boltLocked = false;
    this.reload.active = false; this.reload.phase = -1;
    this.parts.magazine.visible = true; this.parts.hand.visible = false;
  }
};
