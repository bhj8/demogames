/* ============================================================================
   SYMBIOTIC FIRE · 地图事件导演（todo3 §4.5 / §4.7）
   事件必须改变真实路线与风险收益，不能只播放动画；
   变化在本局持续存在，让后半局的空间记忆真正改变。
   ========================================================================== */
'use strict';

const MAPEV = {
  enabled: false,
  executing: false,
  fired: [],           // {id, t, region, layer}
  queue: null,
  _winIdx: 0, _retry: 0,

  /* 事件池。每条声明它影响哪一层、开哪些动态几何、关哪些，
     以及封路时必须保留的逃生路线数量检查。 */
  POOL: [
    { id: 'crane', name: '吊车旋转', layer: 'roof', on: ['craneB'], off: ['craneA'],
      text: '吊臂正在转向 —— 楼间出现新的桥',
      hint: '金属摩擦声与警示灯' },
    { id: 'billboard', name: '广告牌倒塌', layer: 'mid', on: ['billboard'],
      text: '广告牌塌了 —— 出现一条新的登楼斜坡',
      hint: '结构断裂声' },
    { id: 'bus', name: '巴士爆炸', layer: 'street', on: ['wreck'], block: true,
      text: '巴士爆炸 —— 北面街道被残骸封死',
      hint: '燃油味与火光' },
    { id: 'gas', name: '感染气体', layer: 'street', hazard: true,
      text: '感染气体正在淹没低地',
      hint: '地面泛起绿雾' },
    { id: 'facade', name: '外墙坍塌', layer: 'mid', on: ['facade'],
      text: '医院外墙塌了 —— 打开一条新的攀爬路线',
      hint: '碎石落地声' },
    { id: 'power', name: '电力恢复', layer: 'mid', on: ['power'],
      text: '电力恢复 —— 升降平台与滑索重新启动',
      hint: '电流嗡鸣与灯光亮起' }
  ],

  init() {
    this.enabled = TUNE.FEATURES.dynamicMapEvents;
    this.executing = false;
    this.fired = [];
    this.queue = null;
    this._winIdx = 0; this._retry = 0;
    /* §4.7 每局从事件池选择不同组合：先按种子定好这一局的候选顺序 */
    this._order = RNG.event.sample(this.POOL, this.POOL.length);
    this._plan = [];
    const W = TUNE.MAP_EVENT;
    const n = W.perRun + (RNG.event.chance(0.35) ? 1 : 0);
    for (let i = 0; i < Math.min(n, W.windows.length); i++) {
      /* §4.7 使用时间窗口而不是唯一固定秒数 */
      const w = W.windows[i];
      this._plan.push({ at: RNG.event.range(w[0], w[1]), done: false });
    }
    return this;
  },

  update(dt) {
    if (!this.enabled || G.phase !== 'play') return;
    if (this.queue) { this._advance(dt); return; }
    for (let i = 0; i < this._plan.length; i++) {
      const s = this._plan[i];
      if (s.done || G.time < s.at) continue;
      const ev = this._choose();
      if (!ev) { s.done = true; continue; }
      /* §4.7 不能在进化三选一、Boss 入场或玩家正在攀爬关键边缘时突然执行 */
      const why = EVO.safeWindow ? EVO.safeWindow() : null;
      if (why) { s.at = G.time + TUNE.MAP_EVENT.safeWindowRetry; this._retry++; continue; }
      s.done = true;
      this._begin(ev);
      return;
    }
  },

  /* §4.7 结合玩家所在区域、最近使用最多的路线与当前高度选择事件；
     同一局避免连续两次只影响同一层。 */
  _choose() {
    const last = this.fired.length ? this.fired[this.fired.length - 1].layer : null;
    const playerLayer = CITY.layerOf(G.player.pos.y);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < this._order.length; i++) {
      const ev = this._order[i];
      if (this.fired.some(f => f.id === ev.id)) continue;
      if (ev.layer === last && TUNE.MAP_EVENT.minGapSameLayer) continue;
      /* 封路事件必须保留至少两条可用逃生路线 */
      if (ev.block && !this._escapeOk(ev)) continue;
      let score = RNG.event.range(0, 1);
      if (ev.layer === playerLayer) score += 1.2;      // 优先改变玩家正在用的空间
      if (best === null || score > bestScore) { best = ev; bestScore = score; }
    }
    return best;
  },

  /* 封路前先证明玩家仍有 ≥2 条离开当前区域的路线 */
  _escapeOk(ev) {
    const r = CITY.regionAt(G.player.pos.x, G.player.pos.y, G.player.pos.z);
    if (!r) return true;
    const outs = CITY.links.filter(l => l.from === r.id).length;
    return outs >= 3;                                   // 砍掉一条后仍剩两条
  },

  _begin(ev) {
    this.queue = { ev: ev, t: 0, phase: 'telegraph' };
    this.executing = true;
    /* §4.5 事件发生前有环境声音、灯光和地面提示 */
    G.ui.toast(ev.name + ' —— ' + ev.hint, '#ffc14d', true);
    Audio2.telegraph(G.player.pos, 'charge');
    if (ev.layer === 'street') R.ring(TV.copy(G.player.pos).setY(G.player.pos.y), 1, 14, 0xffc14d, 0.9);
  },

  _advance(dt) {
    const q = this.queue;
    q.t += dt;
    if (q.phase === 'telegraph' && q.t >= TUNE.MAP_EVENT.telegraph) {
      this._execute(q.ev);
      q.phase = 'done';
      this.executing = false;
      this.queue = null;
    }
  },

  _execute(ev) {
    (ev.off || []).forEach(id => CITY.setDynamic(id, false));
    (ev.on || []).forEach(id => CITY.setDynamic(id, true));
    /* §9 所有动态几何改变后同步更新碰撞、导航与落点验证 */
    NAV.invalidate();
    CITY.spawnPoints.length = 0; CITYSCALE.buildSpawnPoints(CITY);

    if (ev.hazard) this._gas();

    this.fired.push({ id: ev.id, t: Math.round(G.time), layer: ev.layer,
      region: (CITY.regionAt(G.player.pos.x, G.player.pos.y, G.player.pos.z) || {}).id || '-' });
    G.ui.toast(ev.text, '#ffc14d', true);
    G.shakeAdd(0.22);
    Audio2.blast(G.player.pos, true);
    G.bus.emit('mapEvent', { id: ev.id, layer: ev.layer });
  },

  /* 感染气体：暂时淹没部分低地，逼玩家上楼；不是永久封死 */
  _gas() {
    const spots = [[-6, -16], [6, 16], [-16, 6], [16, -6]];
    spots.forEach(([x, z]) => {
      const z2 = R.zones.get();
      z2.mesh.position.set(x, 0.05, z);
      z2.mesh.scale.setScalar(7.5);
      z2.mesh.material.color.setHex(0x7fd07a); z2.mesh.material.opacity = 0.22; z2.mesh.visible = true;
      z2.rim.position.copy(z2.mesh.position); z2.rim.scale.setScalar(7.5);
      z2.rim.material.color.setHex(0x7fd07a); z2.rim.material.opacity = 0.7; z2.rim.visible = true;
      G.hazards.push({ zone: z2, t: 0, dur: 95, kind: 'acid', radius: 7.5,
        dmg: 5 * G.dmgScale(), tick: 0.8, tickT: 0 });
    });
  },

  /* Debug：强制触发并显示理由（§11.1） */
  force(id) {
    const ev = this.POOL.find(e => e.id === id);
    if (!ev) return '无此事件';
    this._begin(ev);
    return '强制触发 ' + ev.name + '（Debug）';
  },

  statusText() {
    return this.fired.map(f => f.id + '@' + fmtTime(f.t) + '/' + f.layer).join(' ') || '尚未触发';
  }
};
