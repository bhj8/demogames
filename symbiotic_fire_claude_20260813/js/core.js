/* ============================================================================
   SYMBIOTIC FIRE · 引擎核心
   固定种子 RNG / 对象池 / 空间分区 / 合成音频 / 事件总线
   ========================================================================== */
'use strict';

/* --- 启动参数 §36 --- */
const QS = new URLSearchParams(location.search);
const BOOT = {
  seed: QS.has('seed') ? (parseInt(QS.get('seed'), 10) | 0) : ((Math.random() * 0x7fffffff) | 0),
  debug: QS.get('debug') === '1',
  timescale: QS.has('timescale') ? Math.max(0.1, Math.min(8, parseFloat(QS.get('timescale')) || 1)) : 1
};

/* ============================================================================
   RNG —— mulberry32。所有影响可复现性的抽样都必须走这里，不许用 Math.random。
   分流成独立通道，这样"多打了几发子弹"不会错开升级卡序列。
   ========================================================================== */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RngChannel {
  constructor(seed) { this.seed = seed | 0; this.f = mulberry32(this.seed); this.calls = 0; }
  next() { this.calls++; return this.f(); }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  pick(arr) { return arr[this.int(arr.length)]; }
  chance(p) { return this.next() < p; }
  /* 权重抽样，weights 与 arr 等长 */
  weighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (total <= 0) return arr[0];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }
  /* 不放回抽 n 个 */
  sample(arr, n) {
    const pool = arr.slice(), out = [];
    while (out.length < n && pool.length) out.push(pool.splice(this.int(pool.length), 1)[0]);
    return out;
  }
  reset() { this.f = mulberry32(this.seed); this.calls = 0; }
}

const RNG = {
  master: 0,
  mods: null,      // 普通升级抽卡
  mutation: null,  // 共同变异抽卡
  spawn: null,     // 变种与刷怪
  event: null,     // 精英时间点与位置
  fx: null,        // 纯表现，不影响判定
  init(seed) {
    this.master = seed | 0;
    this.mods     = new RngChannel(seed ^ 0x1a2b3c);
    this.mutation = new RngChannel(seed ^ 0x5e6f70);
    this.spawn    = new RngChannel(seed ^ 0x9c0ffe);
    this.event    = new RngChannel(seed ^ 0xdeadb1);
    this.fx       = new RngChannel(seed ^ 0x0badf0);
  },
  resetAll() { ['mods', 'mutation', 'spawn', 'event', 'fx'].forEach(k => this[k].reset()); }
};

/* ============================================================================
   事件总线 §33 —— 共同变异全部通过订阅实现，不硬编码进枪械或敌人主循环
   ========================================================================== */
class Bus {
  constructor() { this.map = new Map(); this.procThisFrame = 0; }
  on(evt, fn, prio) {
    if (!this.map.has(evt)) this.map.set(evt, []);
    const list = this.map.get(evt);
    list.push({ fn, prio: prio || 0 });
    list.sort((a, b) => a.prio - b.prio);
    return fn;
  }
  off(evt, fn) {
    const list = this.map.get(evt); if (!list) return;
    const i = list.findIndex(h => h.fn === fn); if (i >= 0) list.splice(i, 1);
  }
  emit(evt, payload) {
    const list = this.map.get(evt); if (!list) return payload;
    for (let i = 0; i < list.length; i++) list[i].fn(payload);
    return payload;
  }
  clear() { this.map.clear(); }
}

/* ============================================================================
   AttackContext §33 —— 每次根攻击一个 ID，触发链靠它防递归
   ========================================================================== */
let _attackId = 0;
function makeAttack(source, opts) {
  return Object.assign({
    rootAttackId: ++_attackId,
    source: source || 'primary',
    procDepth: 0,
    splitUsed: false,
    blastGeneration: 0,
    canBuildConduction: true,
    canTriggerOnKill: true,
    /* 同一根攻击对同一目标只结算一次同类效果 §34。
       必须在根部创建：派生上下文共享同一个 Set，兄弟分支才不会各算各的。 */
    hitSet: new Set()
  }, opts || {});
}
function deriveAttack(parent, source, patch) {
  const c = Object.assign({}, parent, {
    source: source,
    procDepth: parent.procDepth + 1,
    hitSet: parent.hitSet
  }, patch || {});
  return c;
}
/* §34 全局深度上限：到顶后只结算伤害，不再生成新效果 */
function canProc(ctx) { return ctx.procDepth < TUNE.PROC.maxDepth; }

/* ============================================================================
   对象池 §35 —— 敌人 / 子弹 / 经验 / 常用特效必须池化
   ========================================================================== */
class Pool {
  constructor(factory, reset, initial) {
    this.factory = factory; this.resetFn = reset;
    this.free = []; this.live = [];
    for (let i = 0; i < (initial || 0); i++) this.free.push(this.factory());
  }
  get() {
    const o = this.free.length ? this.free.pop() : this.factory();
    o._dead = false;
    this.live.push(o);
    return o;
  }
  release(o) {
    if (o._dead) return;
    o._dead = true;
    if (this.resetFn) this.resetFn(o);
    /* 关键：这里【不能】立刻放回 free。
       对象此刻仍留在 live 里（要等 compact 才移除），若在这个空档被 get()
       取走，就会第二次进入 live —— 同一个实体出现两份：
         · count 被虚高 → 刷怪逻辑以为场上够了，就不刷了
         · 该实体每帧被更新两次 → 移动速度翻倍
       触发路径：裂变尸生幼体 / Boss 召唤 / 分裂弹，都在遍历过程中 get()。
       所以回收推迟到 compact() 里做。 */
  }
  /* 每帧末尾压实 live 数组，顺便把死掉的对象真正还给 free */
  compact() {
    let w = 0;
    for (let i = 0; i < this.live.length; i++) {
      const o = this.live[i];
      if (!o._dead) this.live[w++] = o;
      else this.free.push(o);
    }
    this.live.length = w;
  }
  get count() { return this.live.length; }
}

/* ============================================================================
   空间哈希 §35 —— 范围伤害不许遍历所有实体
   ========================================================================== */
class SpatialHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  _key(x, z) { return ((Math.floor(x / this.cell) & 1023) << 10) | (Math.floor(z / this.cell) & 1023); }
  clear() { this.map.clear(); }
  insert(obj, x, z) {
    const k = this._key(x, z);
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    b.push(obj);
  }
  /* 返回半径内候选（粗筛，调用方自己做精确距离判定） */
  query(x, z, r, out) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const b = this.map.get(((ix & 1023) << 10) | (iz & 1023));
        if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out;
  }
}

/* ============================================================================
   合成音频 —— 零资源文件。§31 要求方向音效与同帧合并
   ========================================================================== */
const Audio2 = {
  ctx: null, master: null, comp: null, ready: false,
  _lastBlast: 0, _voices: 0,

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.ratio.value = 9; this.comp.attack.value = 0.003;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.comp.connect(this.master); this.master.connect(this.ctx.destination);
    this.ready = true;
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  get t() { return this.ctx ? this.ctx.currentTime : 0; },

  /* 3D 定位节点；pos 为世界坐标，listener 由 game 每帧更新 */
  _panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = 6; p.maxDistance = 90; p.rolloffFactor = 1.1;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.comp);
    return p;
  },

  _env(dest, t, a, d, peak) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    g.connect(dest);
    return g;
  },

  noiseBuf: null,
  _noise() {
    if (!this.noiseBuf) {
      const n = this.ctx.sampleRate * 1.2;
      const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
      this.noiseBuf = b;
    }
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    return s;
  },

  /* 开火 —— pitch 随超频升高 §18 */
  shot(pitch) {
    if (!this.ready || this._voices > 26) return;
    const t = this.t, dest = this.comp;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(240 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(58 * pitch, t + 0.07);
    const g = this._env(dest, t, 0.002, 0.075, 0.20);
    o.connect(g); o.start(t); o.stop(t + 0.1);

    const n = this._noise();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800 * pitch; f.Q.value = 0.7;
    const ng = this._env(dest, t, 0.001, 0.055, 0.16);
    n.connect(f); f.connect(ng); n.start(t); n.stop(t + 0.09);
  },

  hit(pos, weak) {
    if (!this.ready || this._voices > 30) return;
    const t = this.t, dest = pos ? this._panner(pos) : this.comp;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(weak ? 900 : 420, t);
    o.frequency.exponentialRampToValueAtTime(weak ? 300 : 150, t + 0.05);
    const g = this._env(dest, t, 0.001, 0.05, weak ? 0.22 : 0.13);
    o.connect(g); o.start(t); o.stop(t + 0.07);
  },

  kill(pos) {
    if (!this.ready) return;
    const t = this.t, dest = this._panner(pos);
    const n = this._noise();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(220, t + 0.16);
    const g = this._env(dest, t, 0.003, 0.16, 0.20);
    n.connect(f); f.connect(g); n.start(t); n.stop(t + 0.2);
  },

  /* §31 同帧多次爆炸合并 */
  blast(pos, big) {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this._lastBlast < TUNE.FX.blastSoundMergeWindow * 1000) return;
    this._lastBlast = now;
    const t = this.t, dest = this._panner(pos);
    const n = this._noise();
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.setValueAtTime(big ? 2200 : 1500, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.3);
    const g = this._env(dest, t, 0.004, big ? 0.5 : 0.3, big ? 0.5 : 0.34);
    n.connect(f); f.connect(g); n.start(t); n.stop(t + 0.55);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.28);
    const og = this._env(dest, t, 0.005, 0.3, 0.4);
    o.connect(og); o.start(t); o.stop(t + 0.35);
  },

  zap(pos) {
    if (!this.ready) return;
    const t = this.t, dest = this._panner(pos);
    const n = this._noise();
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 2400;
    const g = this._env(dest, t, 0.002, 0.15, 0.26);
    n.connect(f); f.connect(g); n.start(t); n.stop(t + 0.18);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(420, t + 0.13);
    const og = this._env(dest, t, 0.002, 0.13, 0.10);
    o.connect(og); o.start(t); o.stop(t + 0.16);
  },

  /* 敌人预警 —— §31 高威胁必须可提前辨认 */
  telegraph(pos, kind) {
    if (!this.ready) return;
    const t = this.t, dest = this._panner(pos);
    const o = this.ctx.createOscillator();
    o.type = kind === 'charge' ? 'sawtooth' : 'square';
    const base = kind === 'charge' ? 150 : kind === 'blast' ? 640 : 300;
    o.frequency.setValueAtTime(base, t);
    o.frequency.linearRampToValueAtTime(base * 2.2, t + 0.5);
    const g = this._env(dest, t, 0.02, 0.5, 0.22);
    o.connect(g); o.start(t); o.stop(t + 0.55);
  },

  hurt(dirColorKind) {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.22);
    const g = this._env(dest, t, 0.004, 0.24, 0.30);
    o.connect(g); o.start(t); o.stop(t + 0.3);
  },

  shieldHit(broken) {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(broken ? 260 : 880, t);
    o.frequency.exponentialRampToValueAtTime(broken ? 90 : 480, t + 0.18);
    const g = this._env(dest, t, 0.003, 0.18, 0.22);
    o.connect(g); o.start(t); o.stop(t + 0.22);
  },

  pickup(kind) {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    const freqs = kind === 'med' ? [523, 784, 1047] : [392, 587, 880];
    freqs.forEach((fr, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = fr;
      const g = this._env(dest, t + i * 0.05, 0.005, 0.22, 0.2);
      o.connect(g); o.start(t + i * 0.05); o.stop(t + i * 0.05 + 0.3);
    });
  },

  /* 近战前摇：必须有空间方向，且只在前摇开始时响一次，禁止持续蜂鸣 */
  meleeWindup(pos) {
    if (!this.ready || this._voices > 24) return;
    const t = this.t, dest = this._panner(pos);
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(430, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.3);
    const g = this._env(dest, t, 0.008, 0.3, 0.17);
    o.connect(g); o.start(t); o.stop(t + 0.34);
  },

  /* 威胁升级：某个扇区从黄升红时响一次 */
  incoming(pos) {
    if (!this.ready) return;
    const t = this.t, dest = this._panner(pos);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(190, t); o.frequency.linearRampToValueAtTime(310, t + 0.32);
    const g = this._env(dest, t, 0.02, 0.32, 0.13);
    o.connect(g); o.start(t); o.stop(t + 0.38);
  },

  airdropIncoming() { this._chord([330, 440, 550], 0.7, 'sine', 0.14); },

  reload(stage) {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(stage ? 200 : 380, t);
    o.frequency.exponentialRampToValueAtTime(stage ? 90 : 150, t + 0.06);
    const g = this._env(dest, t, 0.002, 0.06, 0.14);
    o.connect(g); o.start(t); o.stop(t + 0.09);
  },

  dash() {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    const n = this._noise();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.setValueAtTime(600, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.16); f.Q.value = 1.2;
    const g = this._env(dest, t, 0.005, 0.17, 0.22);
    n.connect(f); f.connect(g); n.start(t); n.stop(t + 0.2);
  },

  levelup() { this._chord([523, 659, 784], 0.34, 'triangle', 0.16); },
  mutation(colorSeed) { this._chord([196, 262, 311, 415], 0.9, 'sawtooth', 0.13); },
  victory() { this._chord([392, 494, 587, 784], 1.4, 'triangle', 0.18); },
  defeat() { this._chord([196, 233, 147], 1.6, 'sine', 0.2); },

  _chord(freqs, dur, type, vol) {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    freqs.forEach((fr, i) => {
      const o = this.ctx.createOscillator();
      o.type = type; o.frequency.value = fr;
      const g = this._env(dest, t + i * 0.055, 0.02, dur, vol);
      o.connect(g); o.start(t + i * 0.055); o.stop(t + i * 0.055 + dur + 0.1);
    });
  },

  boss() {
    if (!this.ready) return;
    const t = this.t, dest = this.comp;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t); o.frequency.linearRampToValueAtTime(46, t + 1.6);
    const g = this._env(dest, t, 0.15, 1.6, 0.42);
    o.connect(g); o.start(t); o.stop(t + 1.8);
  },

  setListener(pos, fwd, up) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }
};

/* --- 小工具 --- */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, t, dt) => a + (b - a) * (1 - Math.exp(-t * dt));
function fmtTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return m + ':' + (r < 10 ? '0' : '') + r;
}
