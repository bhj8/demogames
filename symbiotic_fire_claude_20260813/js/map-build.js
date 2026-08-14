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
  /* 品质档删掉之后，「下一抽史诗 +8%」这类修正没有兑现口了。
     todo10 §6 的口径：直接给确定的东西，玩家一眼看懂 ——
       屋顶开空投   → 下一次三选一必含 1 张大升级
       连续墙跑     → 下一张卡多给 1 级
       猎杀跨层精英 → 下一次多一个选项（四选一）
     Bao 2026-08-14：地图本身是下一轮要大改的东西，这一版先按最直白的方式给。 */
  mark: '', markT: 0,
  wallDist: 0, eliteId: -1,

  init() {
    this.mark = ''; this.markT = 0; this.wallDist = 0; this.eliteId = -1;
    G.bus.on('zipline', () => {});
    G.bus.on('airdropPicked', e => { if (e && e.high) this.grant('forceBig', '屋顶空投'); });
    G.bus.on('wallrunDistance', e => {
      this.wallDist += (e && e.d) || 0;
      if (this.wallDist >= 24) { this.wallDist = 0; this.grant('extraLevel', '连续墙跑'); }
    });
    G.bus.on('kill', e => {
      const en = e && e.enemy;
      if (en && en.tpl && en.tpl.elite && CITY.layerOf(en.pos.y) !== 'street') {
        this.grant('fourth', '跨层精英');
      }
    });
    return this;
  },

  grant(kind, src) {
    if (kind === 'forceBig') BUILD.forceBig = true;
    else if (kind === 'extraLevel') BUILD.extraLevel = Math.min(2, BUILD.extraLevel + 1);
    else if (kind === 'fourth') BUILD.fourth = true;
    this.mark = src + '：' + { forceBig: '下一次必出大升级', extraLevel: '下一张多给 1 级',
                              fourth: '下一次四选一' }[kind];
    this.markT = TUNE.MAP_BUILD.bannerTime;
    if (G.ui && G.ui.toast) G.ui.toast(this.mark, '#ff8a1e');
  },

  update(dt) { if (this.markT > 0) this.markT -= dt; },
  consume() { this.mark = ''; this.markT = 0; },
  markText() { return this.markT > 0 ? this.mark : ''; },
  statusText() { return this.mark || '-'; }
};
