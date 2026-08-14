/* ============================================================================
   SYMBIOTIC FIRE · 玩家机动（todo3 §2）
   Y 轴 / 重力 / 跳跃 / 翻越 / 抓边 / 登墙 / 墙跑 / 冲刺 / 滑铲 / 滑索的状态机。

   两条纪律：
   1. 模拟与表现分离（§9）—— 这里只解算位置与状态，
      枪械表现由 weapon.js 消费 MOVE.pose，绝不在这里重写枪口/后坐/换弹。
   2. 所有关键路线必须由基础能力完成（§2）—— 没有任何动作依赖升级卡。
   ========================================================================== */
'use strict';

const MOVE = {
  enabled: false,
  st: null,
  /* 供 weapon.js / 相机 / Debug 读取的只读姿态 */
  pose: { state: 'ground', grounded: true, speed: 0, vy: 0, tilt: 0, crouch: 0, layer: 'street', airborne: false },
  stats: null,

  init(p) {
    this.st = {
      state: 'ground', grounded: true, wasGrounded: true,
      coyote: 0, jumpBuf: 0, grace: 0,
      dashCharge: 1, dashT: 0, dashDir: new THREE.Vector3(),
      wallRunT: 0, wallN: new THREE.Vector3(), wallSide: 0, wallCd: 0,
      climbT: 0, climbCd: 0,
      slideT: 0, slideDir: new THREE.Vector3(),
      scripted: null,               // {kind, t, dur, from, to}
      zip: null, zipCd: 0, padCd: 0, wallLost: 0, dashWant: false,
      landT: 0, landImpact: 0,
      tilt: 0, crouch: 0,
      lastGroundY: 0, airT: 0,
      /* todo6 §4 连续动量：mom = 最近达到过的水平速度，空中按 momentumDecay 衰减。
         chain = 本次离地后串起来的动作数，用于 Debug 与「连续机动」判据。 */
      mom: 0, chain: 0, chainT: 0, chainDist: 0, chainFrom: new THREE.Vector3()
    };
    this.stats = {
      vault: 0, mantle: 0, wallRun: 0, wallClimb: 0, airDash: 0, slide: 0, zip: 0, pad: 0,
      layerTime: { street: 0, mid: 0, roof: 0 }, linkUse: {},
      shotsMoving: 0, killsMoving: 0, killsAirborne: 0, maxFall: 0
    };
    p.pos.y = 0;
    p.vel.set(0, 0, 0);
    this.enabled = true;
    return this;
  },

  /* --- 外部输入边沿：由 game.js 的按键回调调用 --- */
  onJump() { if (this.st) this.st.jumpBuf = TUNE.MOVEMENT.jumpBuffer; },
  onDash() { if (this.st) this.st.dashWant = true; },

  /* 水平输入方向（世界空间），沿用旧的 WASD 映射 */
  _wish(p, out) {
    let x = 0, z = 0;
    if (KEY.KeyW) z -= 1;
    if (KEY.KeyS) z += 1;
    if (KEY.KeyA) x -= 1;
    if (KEY.KeyD) x += 1;
    out.set(x, 0, z);
    if (out.lengthSq() > 0) out.normalize().applyAxisAngle(UP, p.yaw);
    return out;
  },

  /* ====================================================================== */
  update(dt, p) {
    const M = TUNE.MOVEMENT, st = this.st, d = G.derived;
    const r = p.radius, h = TUNE.PLAYER.height;

    st.coyote -= dt; st.jumpBuf -= dt; st.grace -= dt;
    st.wallCd -= dt; st.climbCd -= dt; st.landT -= dt; st.zipCd -= dt; st.padCd -= dt;
    st.wasGrounded = st.grounded;

    /* --- 脚本化动作（翻越 / 抓边）：短、可射击、不长时间锁枪（§2.4） --- */
    if (st.scripted) {
      const s = st.scripted;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const e = k * k * (3 - 2 * k);
      p.pos.set(lerp(s.from.x, s.to.x, e), lerp(s.from.y, s.to.y, e), lerp(s.from.z, s.to.z, e));
      p.vel.set(0, 0, 0);
      if (k >= 1) {
        st.scripted = null;
        st.state = 'ground'; st.grounded = true; st.coyote = M.coyoteTime;
        st.dashCharge = M.airDashCharges;
        p.vel.copy(s.exit || TV.set(0, 0, 0));
      }
      this._momentum(p, dt); this._publish(p);
      return;
    }

    /* --- 滑索：固定速度沿钢索，允许射击（§2.4） --- */
    if (st.zip) {
      const z = st.zip;
      /* 挂索期间绝不能保留 grounded：否则下索瞬间还能吃到一次土狼跳，
         Debug 面板也会把“空中”读成“在地面”。 */
      st.grounded = false; st.coyote = 0;
      const len = Math.hypot(z.b.x - z.a.x, z.b.y - z.a.y, z.b.z - z.a.z);
      z.k += (M.zipSpeed / Math.max(0.1, len)) * dt;
      const k = Math.min(1, z.k);
      p.pos.set(lerp(z.a.x, z.b.x, k), lerp(z.a.y, z.b.y, k) - h * 0.35, lerp(z.a.z, z.b.z, k));
      const spd = M.zipSpeed;
      p.vel.set((z.b.x - z.a.x) / len * spd, 0, (z.b.z - z.a.z) / len * spd);
      st.state = 'zip';
      /* 中途按跳可以主动脱离，屋顶因此不会变成单向轨道 */
      if (k >= 1 || st.jumpBuf > 0) {
        if (st.jumpBuf > 0) { p.vel.y = M.jumpSpeed * 0.7; st.jumpBuf = 0; }
        st.zip = null; st.state = 'air'; st.grace = M.wallRunGrace;
        st.zipCd = 1.2;                            // 防止落点靠近起点时立刻二次吸附
      }
      this._momentum(p, dt); this._publish(p);
      return;
    }

    const wish = this._wish(p, TV2);
    const wantSpeed = d.moveSpeed;

    /* --- 冲刺：地面与空中共用同一充能（§2.4，防止重复恢复形成永久无敌） --- */
    if (st.dashWant) {
      st.dashWant = false;
      if (st.dashCharge > 0 && st.dashT <= 0 && p.dashCd <= 0) {
        const dir = wish.lengthSq() > 0.01 ? TV.copy(wish)
          : TV.set(0, 0, -1).applyAxisAngle(UP, p.yaw);
        st.dashDir.copy(dir).normalize();
        st.dashT = st.grounded ? TUNE.PLAYER.dashTime : M.airDashTime;
        st.dashCharge--;
        if (!st.grounded) this.stats.airDash++;
        p.dashIFrame = TUNE.PLAYER.dashIFrame;
        p.dashCd = d.dashCooldown;
        p.dashT = st.dashT;                       // 兼容既有 HUD 与枪械 sprint 姿态
        Audio2.dash();
        st.chain++; G.bus.emit('dash', { airborne: !st.grounded });
      }
    }

    /* --- 滑铲：奔跑中按蹲伏 --- */
    if (KEY.ControlLeft || KEY.KeyC) {
      const spd = Math.hypot(p.vel.x, p.vel.z);
      if (st.grounded && st.slideT <= 0 && st.state !== 'slide' && spd >= M.slideMinSpeed) {
        st.slideT = M.slideTime;
        st.slideEntry = Math.min(M.momentumCap, Math.max(spd, st.mom) * M.slideKeep);
        st.slideDir.set(p.vel.x, 0, p.vel.z).normalize();
        this.stats.slide++;
        st.chain++; G.bus.emit('slide', {});
      }
    }

    /* --- 速度积分 --- */
    if (st.dashT > 0) {
      st.dashT -= dt; p.dashT = st.dashT;
      /* todo6 §4：空中冲刺是在已有动量上「追加/修正方向」，不是把速度覆盖成孤立值。
         覆盖式写法会让「滑铲→跳→跑墙→空冲」这一串在最后一步掉速。 */
      const base = st.grounded ? TUNE.PLAYER.dashSpeed : M.airDashSpeed;
      const sp = st.grounded ? base : Math.min(M.momentumCap, Math.max(base, st.mom * M.dashKeep));
      p.vel.x = st.dashDir.x * sp; p.vel.z = st.dashDir.z * sp;
      p.vel.y = Math.max(p.vel.y, -2);            // 空中冲刺短暂抵消下坠，但不产生滞空
      st.state = 'dash';
    } else if (st.slideT > 0) {
      st.slideT -= dt;
      /* 高速落地接滑铲要保留明显速度（todo6 §4）：起速取「基准」与「继承动量」的大者 */
      const top = Math.min(M.momentumCap, Math.max(M.slideSpeed, st.slideEntry || 0));
      const sp = lerp(top * 0.55, top, st.slideT / M.slideTime);
      p.vel.x = st.slideDir.x * sp; p.vel.z = st.slideDir.z * sp;
      p.vel.y -= M.gravity * dt;
      st.state = 'slide';
      if (!st.grounded) st.slideT = 0;
    } else if (st.state === 'wallclimb') {
      st.climbT -= dt;
      p.vel.y = M.wallClimbSpeed;
      p.vel.x *= 0.6; p.vel.z *= 0.6;
      if (st.climbT <= 0 || !KEY.Space) { st.state = 'air'; st.climbCd = M.wallClimbCooldown; st.grace = M.wallRunGrace; }
    } else if (st.state === 'wallrun') {
      st.wallRunT -= dt;
      p.vel.y = Math.max(p.vel.y - M.wallRunGravity * dt, -3.5);
      /* 沿墙面切线推进，方向由进入时的运动决定 */
      const tx = -st.wallN.z * st.wallSide, tz = st.wallN.x * st.wallSide;
      /* todo6 §4：进入跑墙不得把已有速度硬重置为固定低速 ——
         带着 15m/s 冲上墙却被压回 8.6，是「五个独立技能」的典型症状。 */
      const wrSp = Math.min(M.momentumCap, Math.max(M.wallRunSpeed, (st.wallEntry || 0)));
      p.vel.x = tx * wrSp; p.vel.z = tz * wrSp;
      if (st.wallRunT <= 0) {
        /* 出口保留大部分动量，并给一点推力让「出口」这一下读得出来 */
        st.mom = Math.min(M.momentumCap, wrSp * M.wallExitBoost);
        st.state = 'air'; st.wallCd = 0.35; st.grace = M.wallRunGrace;
      }
    } else {
      /* 常规地面 / 空中 */
      const accel = st.grounded ? TUNE.PLAYER.accel * 0.14 : TUNE.PLAYER.accel * 0.14 * M.airControl;
      let tx = wish.x * wantSpeed, tz = wish.z * wantSpeed;
      /* todo6 §4：空中的方向盘是输入，油门是动量。
         原来这里把目标速度写死成 wantSpeed（走路速度），于是任何一次跳跃
         都会在半空把连招攒起来的速度磨掉，动作链根本连不起来。 */
      if (!st.grounded && st.mom > wantSpeed) {
        const wl = Math.hypot(wish.x, wish.z);
        if (wl > 0.01) { tx = wish.x / wl * st.mom; tz = wish.z / wl * st.mom; }
        else {
          const cs = Math.hypot(p.vel.x, p.vel.z) || 1;
          tx = p.vel.x / cs * st.mom; tz = p.vel.z / cs * st.mom;
        }
      }
      p.vel.x = smooth(p.vel.x, tx, accel, dt);
      p.vel.z = smooth(p.vel.z, tz, accel, dt);
      if (st.grounded) {
        /* 摩擦只在【松开方向键】时生效。
           原来是无条件每帧乘 exp(-1.2dt)，于是按住 W 的稳态速度只有 5.4 —— 
           配置写 6.2 却跑不出 6.2，而滑铲的门槛是 6.0，
           结果「跑起来再滑铲」这个最基本的起手永远触发不了。 */
        if (wish.lengthSq() < 0.01) {
          p.vel.x *= Math.exp(-TUNE.PLAYER.friction * 0.1 * dt);
          p.vel.z *= Math.exp(-TUNE.PLAYER.friction * 0.1 * dt);
        } else if (st.mom > wantSpeed) {
          /* 落地后动量高于走路速度时，让它平滑回落，而不是一帧掉回去 */
          const cs = Math.hypot(p.vel.x, p.vel.z);
          if (cs > wantSpeed) {
            const k = Math.max(wantSpeed, cs - M.momentumDecay * dt) / cs;
            p.vel.x *= k; p.vel.z *= k;
          }
        }
        p.vel.y = Math.min(p.vel.y, 0);
      } else {
        p.vel.y -= M.gravity * dt;
        p.vel.x *= Math.exp(-M.airDrag * 0.1 * dt); p.vel.z *= Math.exp(-M.airDrag * 0.1 * dt);
      }
      st.state = st.grounded ? 'ground' : 'air';
    }

    /* --- 跳跃（含土狼时间与输入缓存） --- */
    if (st.jumpBuf > 0) {
      if (st.grounded || st.coyote > 0) {
        p.vel.y = M.jumpSpeed;
        st.jumpBuf = 0; st.coyote = 0; st.grounded = false; st.slideT = 0;
        st.state = 'air';
        G.bus.emit('jump', {});
      } else if (st.state === 'wallrun') {
        /* 蹬墙跳：离墙方向 + 上抬，是墙跑的正式出口 */
        p.vel.y = M.jumpSpeed * 0.95;
        p.vel.x += st.wallN.x * M.wallJumpOut; p.vel.z += st.wallN.z * M.wallJumpOut;
        st.state = 'air'; st.wallRunT = 0; st.wallCd = 0.3; st.jumpBuf = 0;
        st.chain++; G.bus.emit('jump', { wall: true });
      }
    }

    /* --- 位移与碰撞：分子步 + 圆柱推出，避免高速冲刺穿墙穿楼板（§2.5） --- */
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    const steps = Math.max(1, Math.min(8, Math.ceil(speed * dt / 0.22)));
    const sdt = dt / steps;
    const hit = this._hit;
    let blocked = false, wallTouch = null;

    for (let i = 0; i < steps; i++) {
      const bodyH = st.slideT > 0 ? M.slideHeight : h;

      /* 水平 */
      const px = p.pos.x, pz = p.pos.z;
      p.pos.x += p.vel.x * sdt; p.pos.z += p.vel.z * sdt;
      hit.any = false; hit.wallrun = false; hit.topY = -Infinity; hit.solid = null;
      CITY.depenetrate(p.pos, r, p.pos.y + 0.12, p.pos.y + bodyH, hit);
      if (hit.any) {
        blocked = true;
        if (hit.wallrun) wallTouch = { nx: hit.wnx, nz: hit.wnz };
        /* §2.5 被边缘或小装饰卡住时优先自动越过，而不是完全停下 */
        const rise = this._tryStep(p, r, bodyH, px, pz);
        if (rise > 0) { blocked = false; }
        else {
          /* 撞墙后把速度投影到墙面切线，保持流动感 */
          const dot = p.vel.x * hit.nx + p.vel.z * hit.nz;
          if (dot < 0) { p.vel.x -= hit.nx * dot; p.vel.z -= hit.nz * dot; }
        }
      }

      /* 垂直 */
      const y0 = p.pos.y;
      p.pos.y += p.vel.y * sdt;
      if (p.vel.y <= 0) {
        const sup = CITY.supportY(p.pos.x, p.pos.z, r, y0 + 0.02, Math.max(0.06, y0 - p.pos.y + 0.06), 0.02);
        if (sup > -Infinity && p.pos.y <= sup + 1e-3) {
          p.pos.y = sup;
          if (!st.grounded) this._land(p, -p.vel.y);
          p.vel.y = 0; st.grounded = true; st.coyote = M.coyoteTime;
          st.dashCharge = M.airDashCharges;              // 只有接触稳定地面才恢复
          st.lastGroundY = sup; st.airT = 0;
        } else {
          st.grounded = false;
        }
      } else {
        const ceil = CITY.ceilingY(p.pos.x, p.pos.z, r, p.pos.y + h - 0.05);
        if (ceil < p.pos.y + h) { p.pos.y = ceil - h - 0.01; p.vel.y = 0; }
        st.grounded = false;
      }
      if (p.pos.y < -4) { p.pos.y = 0; p.vel.y = 0; }    // 兜底，绝不掉出地图
    }

    if (!st.grounded) st.airT += dt; else st.airT = 0;

    /* --- 抓边攀爬：前向探测 + 顶部空间 + 可站立面（§2.5） --- */
    if (!st.grounded && st.state !== 'wallclimb' && !st.scripted && p.vel.y < 2.4) {
      this._tryMantle(p, r, h, wish);
    }

    /* --- 登墙与墙跑：只允许标记为可墙跑的近垂直表面 --- */
    if (!st.grounded && !st.scripted && wallTouch) {
      const look = TV.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
      const facing = -(look.x * wallTouch.nx + look.z * wallTouch.nz);
      if (KEY.Space && st.climbCd <= 0 && facing > 0.35 && st.state !== 'wallclimb') {
        st.state = 'wallclimb'; st.climbT = M.wallClimbTime;
        this.stats.wallClimb++;
        st.chain++; G.bus.emit('wallclimb', {});
      } else if (st.state !== 'wallclimb' && st.state !== 'wallrun' && st.wallCd <= 0) {
        const hs = Math.hypot(p.vel.x, p.vel.z);
        const along = Math.abs(p.vel.x * -wallTouch.nz + p.vel.z * wallTouch.nx);
        if (hs >= M.wallRunMinSpeed && along > hs * 0.45 && wish.lengthSq() > 0.01) {
          st.state = 'wallrun'; st.wallRunT = M.wallRunTime;
          /* 进入跑墙时把当时的动量记下来，跑墙段按它推进（todo6 §4） */
          st.wallEntry = Math.min(M.momentumCap, Math.max(hs, st.mom) * M.wallRunKeep);
          st.wallN.set(wallTouch.nx, 0, wallTouch.nz);
          st.wallSide = (p.vel.x * -wallTouch.nz + p.vel.z * wallTouch.nx) > 0 ? 1 : -1;
          p.vel.y = Math.max(p.vel.y, M.wallRunRise);
          this.stats.wallRun++;
          st.chain++; G.bus.emit('wallrun', {});
        }
      }
    }
    /* 离开墙面：给一点输入宽限，减少动作无故中断（§2.5） */
    if (st.state === 'wallrun') {
      if (wallTouch) st.wallLost = 0;
      else {
        st.wallLost += dt;
        if (st.wallLost > M.wallRunGrace) { st.state = 'air'; st.wallCd = 0.25; }
      }
    } else st.wallLost = 0;

    /* --- 装置吸附：滑索与跳板全局统一为近距离自动触发（§2.2） --- */
    this._devices(p);

    /* 相机倾斜：只在墙跑时，轻微且方向确定（§8.4） */
    const wantTilt = st.state === 'wallrun'
      ? -st.wallSide * M.wallRunCameraTilt * (TUNE.MOVEMENT.stableCam ? 0.35 : 1) : 0;
    st.tilt = smooth(st.tilt, wantTilt, 9, dt);
    st.crouch = smooth(st.crouch, st.slideT > 0 ? 1 : 0, 14, dt);

    /* 层停留计时（§11 数据记录） */
    const layer = CITY.layerOf(p.pos.y);
    this.stats.layerTime[layer] += dt;

    this._momentum(p, dt);
    this._publish(p);
  },

  _hit: { any: false, nx: 0, nz: 0, wallrun: false, wnx: 0, wnz: 0, topY: -Infinity, solid: null, wsolid: null },

  /* 台阶 / 自动翻越：抬脚就能过的直接抬，够不到的走短翻越动画 */
  _tryStep(p, r, bodyH, px, pz) {
    const M = TUNE.MOVEMENT;
    const top = this._hit.topY;
    if (top === -Infinity) return 0;
    const rise = top - p.pos.y;
    if (rise <= 0.01 || rise > M.vaultMaxHeight) return 0;
    /* 头顶必须够高，否则不允许爬进模型 */
    if (CITY.ceilingY(p.pos.x, p.pos.z, r, top + 0.05) < top + M.headroom) return 0;
    if (rise <= M.stepHeight) { p.pos.y = top; return rise; }
    /* 翻越：短脚本，落在障碍另一侧的顶面上 */
    const st = this.st;
    const dirx = p.pos.x - px, dirz = p.pos.z - pz;
    const dl = Math.hypot(dirx, dirz) || 1;
    st.scripted = {
      kind: 'vault', t: 0, dur: M.vaultTime,
      from: { x: px, y: p.pos.y, z: pz },
      to: { x: p.pos.x + dirx / dl * (r + 0.35), y: top, z: p.pos.z + dirz / dl * (r + 0.35) },
      exit: new THREE.Vector3(p.vel.x * 0.8, 0, p.vel.z * 0.8)
    };
    st.state = 'vault';
    this.stats.vault++;
    G.bus.emit('vault', {});
    return rise;
  },

  /* 抓边：向朝向前方探测一个可站立的顶面 */
  _tryMantle(p, r, h, wish) {
    const M = TUNE.MOVEMENT, st = this.st;
    const dx = wish.lengthSq() > 0.01 ? wish.x : -Math.sin(p.yaw);
    const dz = wish.lengthSq() > 0.01 ? wish.z : -Math.cos(p.yaw);
    const dl = Math.hypot(dx, dz) || 1;
    const fx = p.pos.x + dx / dl * (r + M.mantleProbe);
    const fz = p.pos.z + dz / dl * (r + M.mantleProbe);
    const top = CITY.supportY(fx, fz, r * 0.8, p.pos.y, -0.25, M.mantleMaxHeight);
    if (top === -Infinity) return false;
    const rise = top - p.pos.y;
    if (rise < 0.35 || rise > M.mantleMaxHeight) return false;
    if (CITY.ceilingY(fx, fz, r * 0.8, top + 0.05) < top + M.headroom) return false;
    st.scripted = {
      kind: 'mantle', t: 0, dur: M.mantleTime,
      from: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
      to: { x: fx, y: top, z: fz },
      exit: new THREE.Vector3(p.vel.x * 0.5, 0, p.vel.z * 0.5)
    };
    st.state = 'mantle';
    this.stats.mantle++;
    G.bus.emit('mantle', {});
    return true;
  },

  _devices(p) {
    const M = TUNE.MOVEMENT, st = this.st;
    if (st.zip || st.scripted) return;
    /* 跳板：踩上即弹，不需要按键。
       必须有再装填时间 —— 否则站在跳板上会被无限弹起，玩家完全失去控制权。 */
    if (st.padCd <= 0) {
      const pad = CITY.nearestDevice(p.pos, 'pad', 1.9);
      if (pad && st.grounded && Math.abs(p.pos.y - pad.y) < 0.9) {
        p.vel.y = M.padImpulse;
        st.grounded = false; st.state = 'air'; st.dashCharge = M.airDashCharges;
        st.padCd = M.padRearm;
        this.stats.pad++;
        Audio2.dash();
        G.bus.emit('jumppad', {});
        return;
      }
    }
    /* 滑索：靠近起点自动吸附 */
    if (st.zipCd > 0) return;
    const zip = CITY.nearestDevice(p.pos, 'zip', M.zipSnapDist);
    if (zip) {
      st.zip = { a: zip.a, b: zip.b, k: 0 };
      st.state = 'zip'; st.grounded = false;
      this.stats.zip++;
      G.bus.emit('zipline', {});
    }
  },

  _land(p, fallSpeed) {
    const M = TUNE.MOVEMENT, st = this.st;
    st.landT = M.landRecover;
    st.landImpact = clamp(fallSpeed / M.landHardVel, 0, 1.6);
    this.stats.maxFall = Math.max(this.stats.maxFall, fallSpeed);
    if (fallSpeed > 4) {
      /* 落地冲击只作用于枪模与短暂镜头压缩，不改变玩家朝向（§8.4） */
      WEAPON.on('land', { impact: st.landImpact });
      Audio2.shellDrop(p.pos);
      R.puff(TV.copy(p.pos).setY(p.pos.y + 0.1), 0.2, 1.1 + st.landImpact, 0x8a8f98, 0.22);
    }
    G.bus.emit('land', { impact: st.landImpact, fall: fallSpeed });
  },

  /* ------------------------------------------------------------------
     动量记账（todo6 §4）。放在每帧最后统一做，而不是散在各个状态分支里 ——
     散着写就会出现「这个状态记得继承、那个状态忘了」的不一致，
     那正是原来五个技能互相清零的根源。
     ------------------------------------------------------------------ */
  _momentum(p, dt) {
    const M = TUNE.MOVEMENT, st = this.st;
    const sp = Math.hypot(p.vel.x, p.vel.z);
    /* 规则只有一条：动量向【当前速度】衰减，快起来立刻记住，慢下来慢慢忘。
       之前写成「只在空中衰减」，于是一落地动量就被永久冻结在峰值上 ——
       跑一次墙之后，接下来整局的空中速度都是那个峰值。 */
    if (sp > st.mom) st.mom = sp;
    else st.mom = Math.max(sp, st.mom - M.momentumDecay * dt);
    st.mom = Math.min(st.mom, M.momentumCap);
    /* 硬速度上限：动作叠加不得无限加速（todo6 §4 最后一条） */
    if (sp > M.momentumCap) {
      const k = M.momentumCap / sp;
      p.vel.x *= k; p.vel.z *= k;
    }
    /* 连招统计：离地即开始，落地且慢下来才结束。供 Debug 与 _movecheck 使用。 */
    if (!st.grounded) {
      if (st.chainT <= 0) { st.chain = 0; st.chainFrom.copy(p.pos); }
      st.chainT += dt;
      st.chainDist = Math.hypot(p.pos.x - st.chainFrom.x, p.pos.z - st.chainFrom.z);
    } else if (sp < TUNE.PLAYER.moveSpeed * 1.05 && st.slideT <= 0) {
      st.chainT = 0;
    }
  },

  _publish(p) {
    const st = this.st, ps = this.pose;
    ps.state = st.state;
    ps.mom = st.mom;
    ps.chain = st.chain;
    ps.chainT = st.chainT;
    ps.chainDist = st.chainDist;
    ps.grounded = st.grounded;
    ps.airborne = !st.grounded;
    ps.speed = Math.hypot(p.vel.x, p.vel.z);
    ps.vy = p.vel.y;
    ps.tilt = st.tilt;
    ps.crouch = st.crouch;
    ps.landImpact = st.landT > 0 ? st.landImpact * (st.landT / TUNE.MOVEMENT.landRecover) : 0;
    ps.layer = CITY.layerOf(p.pos.y);
    ps.dashCharge = st.dashCharge;
  },

  /* Debug 传送：四个地标与三个高度层 */
  teleport(p, x, y, z) {
    p.pos.set(x, y, z); p.vel.set(0, 0, 0);
    this.st.scripted = null; this.st.zip = null; this.st.state = 'air';
    this.st.grounded = false; this.st.dashCharge = TUNE.MOVEMENT.airDashCharges;
  }
};
