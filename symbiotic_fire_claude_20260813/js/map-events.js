/* ============================================================================
   SYMBIOTIC FIRE · 热点迁移（TODO.md M4，取代 todo3 的动态几何事件）

   todo4 §8 推翻了「开关楼板与连廊」那套做法：几何一直变，玩家刚建立的
   空间记忆每两分钟作废一次，路线学不会，也读不懂。
   替代方案是【压力迁移】—— 地图本身不动，动的是「哪里最危险、哪里最值钱」。

   一条纪律：迁移不得制造空窗。旧热点降温是渐进的，新热点先预告再升温，
   任何时刻场上都有地方可打；否则强机动只会换来「跑三十秒找怪」。
   ========================================================================== */
'use strict';

const MAPEV = {
  enabled: false,
  executing: false,        // 迁移预告期间，进化选择要让路（evolution-director 读它）
  hot: null,               // {zone, x, z, r, heat}
  next: null,              // 预告中的下一个热点
  t: 0, idx: 0, log: [],

  /* 热点 = 战斗单元。中心点由 city-scale 的 blocks 算出来，不另写一份坐标，
     否则地图一改这里就悄悄指向旧位置。 */
  zones() {
    const m = {};
    CITYSCALE.blocks.forEach(b => {
      if (!b.zone) return;
      const z = m[b.zone] || (m[b.zone] = { zone: b.zone, x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 });
      z.x0 = Math.min(z.x0, b.x0); z.x1 = Math.max(z.x1, b.x1);
      z.z0 = Math.min(z.z0, b.z0); z.z1 = Math.max(z.z1, b.z1);
    });
    return Object.keys(m).map(k => {
      const z = m[k];
      return { zone: k, x: (z.x0 + z.x1) / 2, z: (z.z0 + z.z1) / 2,
               r: Math.max(z.x1 - z.x0, z.z1 - z.z0) * 0.62 };
    });
  },

  init() {
    const H = TUNE.HOTSPOT;
    this.enabled = TUNE.FEATURES.hotspotMigration;
    this.executing = false;
    this.t = 0; this.idx = 0; this.log = [];
    this.next = null;
    const zs = this.zones();
    this.hot = zs.length ? Object.assign({ heat: 1 }, zs[RNG.event.int(zs.length)]) : null;
    this._order = zs.length ? RNG.event.sample(zs, zs.length) : [];
    this.period = H.firstAt;
    return this;
  },

  update(dt) {
    if (!this.enabled || !this.hot || G.phase !== 'play') return;
    const H = TUNE.HOTSPOT;
    this.t += dt;

    /* 预告：先让玩家知道下一个热点在哪，再真的迁过去（§M4「明确预告」） */
    if (!this.next && this.t >= this.period - H.telegraph) {
      const zs = this.zones().filter(z => z.zone !== this.hot.zone);
      if (zs.length) {
        this.next = Object.assign({ heat: 0 }, this._order[this.idx++ % this._order.length]);
        if (this.next.zone === this.hot.zone) this.next = Object.assign({ heat: 0 }, zs[0]);
        this.executing = true;
        G.ui.toast('压力正在转移到 ' + this.zoneName(this.next.zone), '#ff8a4a', true);
        Audio2.telegraph(G.player.pos, 'charge');
      }
    }

    /* 迁移：旧热点降温、新热点升温，两边都用渐变 ——
       硬切会让玩家在切换那一帧发现「这里突然没人了」。 */
    if (this.next) {
      this.hot.heat = Math.max(0, this.hot.heat - dt / H.fade);
      this.next.heat = Math.min(1, this.next.heat + dt / H.fade);
      if (this.next.heat >= 1) {
        this.log.push({ t: Math.round(G.time), zone: this.next.zone });
        this.hot = this.next; this.next = null;
        this.executing = false;
        this.t = 0;
        this.period = H.interval;
        G.ui.toast(this.zoneName(this.hot.zone) + ' 成为新的热点 —— 经验更高，压力也更高', '#ffd24a');
      }
    }
  },

  zoneName(z) {
    return { shops: '商街', garage: '停车楼', office: '办公区', site: '在建大楼' }[z] || z;
  },

  /* 刷怪权重：热点附近更容易被选中。返回 0~1 的加权系数。 */
  spawnBias(x, z) {
    if (!this.enabled || !this.hot) return 0;
    const H = TUNE.HOTSPOT;
    let w = 0;
    const add = h => {
      if (!h || h.heat <= 0) return;
      const d = Math.hypot(x - h.x, z - h.z);
      if (d < h.r) w = Math.max(w, h.heat * (1 - d / h.r));
    };
    add(this.hot); add(this.next);
    return w * H.spawnBias;
  },

  /* 热点内的经验加成：留在危险的地方要有回报，否则玩家只会绕开它 */
  xpBonus(x, z) {
    if (!this.enabled || !this.hot) return 1;
    const H = TUNE.HOTSPOT;
    const d = Math.hypot(x - this.hot.x, z - this.hot.z);
    if (d > this.hot.r) return 1;
    return 1 + (H.xpBonus - 1) * this.hot.heat * (1 - d / this.hot.r);
  },

  /* HUD / Debug */
  statusText() {
    if (!this.enabled) return 'off';
    if (!this.hot) return '-';
    return this.zoneName(this.hot.zone) + ' ' + Math.round(this.hot.heat * 100) + '%' +
      (this.next ? ' → ' + this.zoneName(this.next.zone) + ' ' + Math.round(this.next.heat * 100) + '%' : '') +
      ' (' + this.t.toFixed(0) + '/' + this.period + 's)';
  },
  /* Debug 面板：立刻迁移 */
  force() {
    if (!this.hot) return '没有热点';
    this.t = this.period - TUNE.HOTSPOT.telegraph;
    return '已排入下一次热点迁移';
  }
};
