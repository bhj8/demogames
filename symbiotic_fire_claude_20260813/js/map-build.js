/* ============================================================================
   SYMBIOTIC FIRE · 地图进入构筑（todo3 §6.4 / §7.8）
   地图不弹第四种选择。玩家用行动表达偏好：去哪里、走什么路线、打什么风险事件；
   结果只生成一个【可见的】“下一次进化修正”，用后即清。

   两条硬约束：
     §7.8 品质加成只从普通概率转移，不降低稀有以上的既有好运。
     §6.4 同时最多保留一个品质修正和一个标签修正，新修正覆盖时明确提示。
   ========================================================================== */
'use strict';

const MAPBUILD = {
  qualityMod: 0, qualitySrc: '',
  tagMod: null, tagSrc: '',
  bannerT: 0,
  routes: null,

  init() {
    this.qualityMod = 0; this.qualitySrc = '';
    this.tagMod = null; this.tagSrc = '';
    this.bannerT = 0;
    this.routes = { wallRunChain: 0, wallRunT: 0, eliteMarked: null, streetEventT: 0 };
    this._hook();
    return this;
  },

  /* --- 修正写入：始终只保留最近一个，并且必须在 HUD 上明确显示一次（§6.4） --- */
  addQuality(amount, src) {
    const cap = TUNE.MAP_BUILD.qualityBonusCap;
    const before = this.qualityMod;
    this.qualityMod = Math.min(cap, this.qualityMod + amount);
    this.qualitySrc = src;
    this._sync();
    this._banner('下一次进化：史诗 +' + Math.round(this.qualityMod * 100) + '%',
      before > 0 ? '（覆盖上一个：' + src + '）' : '（' + src + '）', TUNE.RARITY.css.epic);
  },
  addTagBias(tags, src) {
    const m = {};
    tags.forEach(t => { m[t] = TUNE.MAP_BUILD.tagBiasMult; });
    const had = !!this.tagMod;
    this.tagMod = m; this.tagSrc = src;
    this._sync();
    this._banner('下一次更偏向：' + tags.join(' / '), had ? '（覆盖上一个）' : '（' + src + '）', '#ff8a1e');
  },
  /* 精英路线猎杀：下一次品质至少稀有 */
  setMinQuality(q, src) {
    this.minQuality = q; this.minSrc = src;
    this._sync();
    this._banner('下一次进化：至少稀有', '（' + src + '）', TUNE.RARITY.css.rare);
  },

  _sync() {
    if (!EVO.draw) return;
    EVO.draw.mapQualityMod = this.qualityMod;
    EVO.draw.mapTagBias = this.tagMod;
    EVO.draw.mapMinQuality = this.minQuality || null;
  },

  tagBias() { return this.tagMod; },

  /* 用后清除，避免长期权重失控（§6.4 / §7.1 步骤 7） */
  consume() {
    this.qualityMod = 0; this.qualitySrc = '';
    this.tagMod = null; this.tagSrc = '';
    this.minQuality = null; this.minSrc = '';
    this._sync();
  },

  _banner(main, sub, css) {
    this.banner = { main: main, sub: sub, css: css };
    this.bannerT = TUNE.MAP_BUILD.bannerTime;
    G.ui.toast(main + ' ' + sub, css);
  },

  /* ------------------------------------------------ 四种风险行为 §7.8 */
  _hook() {
    if (this._hooked) return;
    this._hooked = true;

    /* 1. 屋顶空投：在高处开箱，下一次史诗概率 +8 个百分点 */
    G.bus.on('airdropOpened', d => {
      if (!CITY.enabled) return;
      if (CITY.layerOf(d.y || 0) === 'street') return;
      this.addQuality(TUNE.MAP_BUILD.roofDropEpicBonus, '屋顶空投');
    });

    /* 2. 街面高压击杀事件：完成后爆裂/击杀/击退标签权重 ×1.8，不改变品质 */
    G.bus.on('streetPurge', () => this.addTagBias(['blast', 'kill', 'knock'], '街面高压击杀'));

    /* 3. 连续墙跑路线：完成指定立面路线后，机动/装填/充能标签 ×1.8 */
    G.bus.on('wallrun', () => {
      const r = this.routes;
      if (G.time - r.wallRunT < 4.0) r.wallRunChain++; else r.wallRunChain = 1;
      r.wallRunT = G.time;
      if (r.wallRunChain >= 3) {
        r.wallRunChain = 0;
        this.addTagBias(['movement', 'reload', 'charge'], '连续墙跑路线');
      }
    });

    /* 4. 精英路线猎杀：击杀被标记的跨层精英后，下一次品质至少稀有 */
    G.bus.on('enemyDeath', d => {
      if (this.routes && this.routes.eliteMarked === d.enemy) {
        this.routes.eliteMarked = null;
        this.setMinQuality('rare', '精英路线猎杀');
      }
    });
  },

  /* 定期标记一只跨层精英，作为可忽略的支线优势（§7.8 最后一条） */
  _markCd: 90,
  update(dt) {
    if (this.bannerT > 0) this.bannerT -= dt;
    if (!CITY.enabled) return;
    this._markCd -= dt;
    if (this._markCd > 0 || this.routes.eliteMarked) return;
    this._markCd = 75;
    const list = G.enemies.live;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e._dead || e.dead || e.boss) continue;
      if (CITY.layerOf(e.pos.y) === 'street') continue;
      this.routes.eliteMarked = e;
      e.highlight = 12;
      e.markedElite = true;
      G.ui.hint('标记：跨层精英 —— 击杀可让下一次进化至少稀有', '#ffc14d');
      break;
    }
  },

  /* 地图能力卡被选中后的世界侧接入（§7.8） */
  onAbility(id) {
    G.bus.emit('mapAbility', { id: id });
    if (id === 'ab_facade') G.ui.hint('高压立面已通电：墙跑经过发光立面会为传导充能', '#35e0ff');
    if (id === 'ab_block') G.ui.hint('尸爆街区：被爆裂摧毁的车辆会成为二次爆炸源', MUT.blast.css);
  },

  statusText() {
    const a = [];
    if (this.qualityMod > 0) a.push('史诗+' + Math.round(this.qualityMod * 100) + '%(' + this.qualitySrc + ')');
    if (this.tagMod) a.push('偏向' + Object.keys(this.tagMod).join('/') + '(' + this.tagSrc + ')');
    if (this.minQuality) a.push('至少' + TUNE.RARITY.name[this.minQuality]);
    return a.join(' · ') || '-';
  }
};
