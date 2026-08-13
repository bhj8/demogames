/* ============================================================================
   SYMBIOTIC FIRE · 统一进化导演（todo3 §4.2 / §7.1 / §7.3 / §7.4）
   全局只有一种会暂停战斗的正式选择界面，这里是它唯一的时钟。

   §7.1 的顺序是硬要求，代码结构照抄这个顺序，Debug 也按这个顺序记录：
     1 检查硬间隔 / 安全窗口 / pending
     2 抽本次品质（时间段 → 地图修正 → 保底）
     3 建有效池   4 同品质内加权   5 生成三张
     6 应用选择   7 消耗地图修正、更新保底与共同进化
   ========================================================================== */
'use strict';

const EVO = {
  enabled: false,
  draw: null,
  progress: 0, need: 0, overflow: 0,
  log: [],

  init() {
    this.enabled = TUNE.FEATURES.unifiedEvolution;
    this.draw = {
      evolutionIndex: 0,          // 已完成的进化次数
      lastChoiceTime: 0,          // 上一次选择【关闭】的时刻
      pending: null,              // {quality, cards, since, reason}
      commonStreak: 0,
      hasEpic: false,
      mapQualityMod: 0,           // 只影响下一抽，用后清除
      mapTagBias: null,
      deferT: 0, deferReason: '-'
    };
    this.progress = 0; this.overflow = 0;
    this.need = TUNE.EVOLUTION.firstAt * this._rate();
    this.log = [];
    return this;
  },

  _rate() { return G.xpRate > 0.02 ? G.xpRate : TUNE.PACING.bootstrapXp / TUNE.PACING.firstLevelAt; },

  /* 期望进化序号：第一次在 firstAt，之后均匀铺到 cutoff */
  expectedIndex(t) {
    const E = TUNE.EVOLUTION;
    const span = (E.cutoff - E.firstAt) / Math.max(1, E.targetCount - 1);
    return 1 + (t - E.firstAt) / span;
  },

  /* 下一次进化需要多少进度。
     沿用 todo/todo2 已验证的两层控制：内层按最近收入自校准定价，
     外层按“期望次数 vs 实际次数”做带死区的漂移纠正。
     区别在于目标从“24~26 次升级”改成“14~16 次进化”（§4.2）。 */
  computeNeed() {
    const E = TUNE.EVOLUTION;
    /* 第一次进化没有任何收入样本可用 —— EMA 此刻还停在 bootstrap 值上，
       自校准定价在这里必然失灵（实测会把首次推到 44s）。
       和 todo 的 PACING.bootstrapXp 一样，用一个固定需求，
       再由 firstWindow 的时间下限兜住强 build 提前爆条的情况。 */
    if (this.draw.evolutionIndex === 0) return E.firstNeed;
    const base = this._rate() * E.progressBase;
    const delta = this.expectedIndex(G.time) - (this.draw.evolutionIndex + 1);
    const mag = Math.abs(delta);
    let mult = 1;
    if (mag > E.driftDeadband) {
      const k = Math.min(1, (mag - E.driftDeadband) / (E.driftFullAt - E.driftDeadband));
      mult = delta > 0 ? 1 - k * (1 - E.driftMin) : 1 + k * (E.driftMax - 1);
    }
    this.driftMult = mult;
    return Math.max(4, base * mult);
  },

  /* 经验入口：等级与“弹一次选择”彻底解耦（§4.2）。
     溢出不会连弹多张界面，只会进入下一段进化进度。 */
  addProgress(v) {
    if (!this.enabled) return false;
    this.progress += v;
    return true;
  },

  /* ------------------------------------------------------- 安全窗口 §4.7 */
  /* 统一事件队列里谁延迟谁：Boss 入场、空投争夺、地图结构变化、
     玩家正在攀爬关键边缘、以及高优先级承诺攻击期间，选择可以延后。 */
  safeWindow() {
    if (G.bossAlive && G.time - (G.bossSpawnAt || -999) < TUNE.AIRDROP.bossGrace) return 'boss入场';
    if (G.airdrop && G.airdrop.state === 'falling') return '空投坠落';
    if (typeof MAPEV !== 'undefined' && MAPEV.executing) return '地图事件';
    if (MODE.vertMove && MOVE.st) {
      const s = MOVE.pose.state;
      if (s === 'mantle' || s === 'vault' || s === 'wallclimb' || s === 'wallrun' || s === 'zip') return '攀爬中';
      if (!MOVE.pose.grounded) return '滞空中';
    }
    /* 已经抬手的近战 / 扑击：让玩家先处理掉这一下 */
    const list = G.enemies.live;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e._dead || e.dead) continue;
      if (e.state !== 'melee' && e.state !== 'leapwind' && e.state !== 'windup') continue;
      if (Math.hypot(e.pos.x - G.player.pos.x, e.pos.z - G.player.pos.z) < 6) return '承诺攻击';
    }
    return null;
  },

  /* ------------------------------------------------------------ 主循环 */
  update(dt) {
    if (!this.enabled || G.phase !== 'play') return;
    const E = TUNE.EVOLUTION, d = this.draw;

    this.need = this.computeNeed();

    /* §4.2 10:30 后不再生成新选择，经验继续计入分数 */
    const past = G.time >= E.cutoff;

    /* 导演主动安排最后一次：10:30 前必须把它排出来 */
    const wantFinal = !past && G.time >= E.lastWindow[0]
      && d.evolutionIndex < E.targetCount - 1 && !d.pending;

    if (!d.pending && !past) {
      const sinceClose = G.time - d.lastChoiceTime;
      /* 第一次不得早于 firstWindow 的下限，否则强 build 会在十几秒就弹出来 */
      const firstOk = d.evolutionIndex > 0 || G.time >= E.firstWindow[0];
      const ready = this.progress >= this.need && firstOk;
      if ((ready || wantFinal) && sinceClose >= E.hardFloor) {
        this._queue(wantFinal && !ready ? 'final' : 'progress');
      }
    }

    /* 排队中的进化：等一个安全窗口，但延迟不吞掉已经赚到的进化 */
    if (d.pending && !d.pending.open) {
      const why = this.safeWindow();
      if (!why || d.deferT >= E.safeDelayMax) {
        d.deferReason = why ? why + '(超时强出)' : '-';
        this._open();
      } else {
        d.deferT += dt; d.deferReason = why;
      }
    }
  },

  _queue(reason) {
    const d = this.draw;
    d.pending = { reason: reason, open: false };
    d.deferT = 0;
  },

  /* --------------------------------------------------- §7.1 步骤 2：品质 */
  /* 必须先抽品质，再生成三张同品质卡。禁止先抽三张再按颜色比较。 */
  drawQuality(t) {
    const RA = TUNE.RARITY, P = TUNE.PITY, d = this.draw;
    const band = RA.bands.find(b => t >= b.from && t < b.to) || RA.bands[RA.bands.length - 1];
    const raw = Object.assign({}, band.w);
    const w = Object.assign({}, raw);

    /* §7.8 地图修正：只从普通概率转移到史诗，不降低既有好运 */
    let mapMod = 0;
    if (d.mapQualityMod > 0) {
      mapMod = Math.min(d.mapQualityMod, TUNE.MAP_BUILD.qualityBonusCap);
      const move = Math.min(mapMod, w.common);
      w.common -= move; w.epic += move;
    }

    /* §7.4 保底一：连续 3 次普通后，下一次至少稀有。
       在当前时间段的稀有 / 史诗 / 传奇之间重新归一化。 */
    let pityRare = false;
    if (d.commonStreak >= P.commonStreak) {
      pityRare = true;
      const rest = w.rare + w.epic + w.legend;
      if (rest > 0) {
        w.common = 0;
        w.rare /= rest; w.epic /= rest; w.legend /= rest;
      } else { w.common = 0; w.rare = 1; }
    }

    let q = this._roll(w);

    /* §7.8 精英路线猎杀：下一次品质至少稀有。
       同样写成“抽完再抬”，不改权重表 —— 抬底线不等于给高品质额外权重。 */
    let mapMin = false;
    if (d.mapMinQuality) {
      const need = RA.order.indexOf(d.mapMinQuality);
      if (RA.order.indexOf(q) < need) { q = d.mapMinQuality; mapMin = true; }
    }

    /* §7.4 保底二：7:30 仍未出现史诗或传奇。
       先正常抽，结果低于史诗才提升为史诗；自然抽中传奇保留传奇。
       —— 传奇不因本条获得额外归一化权重，所以必须写成“抽完再抬”，不能改权重表。 */
    let pityEpic = false;
    if (t >= P.epicByTime && !d.hasEpic) {
      const ord = RA.order.indexOf(q);
      if (ord < RA.order.indexOf('epic')) { q = 'epic'; pityEpic = true; }
    }

    this._lastDraw = { t: t, raw: raw, final: w, q: q, pityRare: pityRare, pityEpic: pityEpic, mapMod: mapMod, mapMin: mapMin };
    return q;
  },

  _roll(w) {
    const order = TUNE.RARITY.order;
    let total = 0;
    for (let i = 0; i < order.length; i++) total += w[order[i]] || 0;
    let r = RNG.mutation.next() * total;
    for (let i = 0; i < order.length; i++) {
      r -= (w[order[i]] || 0);
      if (r <= 0) return order[i];
    }
    return 'common';
  },

  /* ------------------------------------------- §7.1 步骤 3～5：候选生成 */
  _open() {
    const d = this.draw;
    const q = this.drawQuality(G.time);
    const cards = EVOPOOL.candidates(q, d);
    if (!cards.length) {                      // 理论上不会发生，兜底不卡在 choose 相
      d.pending = null; d.lastChoiceTime = G.time; this.progress = 0;
      return;
    }
    d.pending.open = true;
    d.pending.quality = q;
    d.pending.cards = cards;
    this.log.push({
      i: d.evolutionIndex + 1, t: Math.round(G.time), q: q,
      pityRare: this._lastDraw.pityRare, pityEpic: this._lastDraw.pityEpic,
      mapMod: this._lastDraw.mapMod, defer: d.deferReason,
      cards: cards.map(c => c.id)
    });
    G.phase = 'choose';
    Audio2.mutation();
    G.ui.showEvolution(q, cards, this._lastDraw, id => this.pick(id));
  },

  /* -------------------------------------------- §7.1 步骤 6～7：应用 */
  pick(cardId) {
    const d = this.draw;
    const card = EVOPOOL.byId[cardId];
    if (!card) return;
    const others = d.pending.cards.filter(c => c.id !== cardId).map(c => c.id);

    card.apply();
    SYN.build.taken[cardId] = (SYN.build.taken[cardId] || 0) + 1;

    /* 保底计数：只统计品质，不做任何反向压制（§7.4） */
    const q = d.pending.quality;
    d.commonStreak = (q === 'common') ? d.commonStreak + 1 : 0;
    if (q === 'epic' || q === 'legend') d.hasEpic = true;

    /* 地图修正用后清除，避免长期权重失控（§6.4） */
    if (TUNE.FEATURES.mapBuildInfluence && typeof MAPBUILD !== 'undefined') MAPBUILD.consume();
    d.mapQualityMod = 0; d.mapTagBias = null;

    d.evolutionIndex++;
    d.lastChoiceTime = G.time;
    d.pending = null;
    d.deferT = 0; d.deferReason = '-';

    /* 溢出进入下一段进化进度，不连弹第二张界面（§4.2 / §6.1） */
    this.overflow = Math.max(0, this.progress - this.need);
    this.progress = this.overflow;
    this.need = this.computeNeed();

    const li = this.log[this.log.length - 1];
    if (li) { li.picked = cardId; li.unpicked = others; }

    G.player.level = d.evolutionIndex + 1;
    recompute();
    emitBuildChanged();
    G.ui.hideCards();
    G.ui.mutationSlots();
    G.phase = 'play';
    G.bus.emit('evolutionTaken', { card: card, quality: q });
  },

  /* Debug：强制下一次品质（§11.2） */
  forceQuality(q) { this._force = q; },

  /* HUD 进度（§6.1 进度条清楚显示溢出） */
  progressFrac() { return this.need > 0 ? Math.min(1, this.progress / this.need) : 0; },
  overflowFrac() { return this.need > 0 ? Math.max(0, (this.progress - this.need) / this.need) : 0; }
};

/* Debug 强制品质：包在 drawQuality 外层，保持 §7.1 的顺序记录不变 */
EVO._drawQualityRaw = EVO.drawQuality;
EVO.drawQuality = function (t) {
  const q = this._drawQualityRaw(t);
  if (this._force) {
    this._lastDraw.forced = this._force;
    const f = this._force; this._force = null;
    this._lastDraw.q = f;
    return f;
  }
  return q;
};
