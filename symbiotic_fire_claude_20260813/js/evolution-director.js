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
  draw: null,
  progress: 0, need: 0, overflow: 0,
  log: [],

  init() {
    this.draw = {
      evolutionIndex: 0,          // 已完成的进化次数
      lastChoiceTime: 0,          // 上一次选择【关闭】的时刻
      pending: null,              // {cards, since, reason}
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
    if (MOVE.st) {
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
    if (G.phase !== 'play') return;
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
  /* ------------------------------------------------- 候选生成（todo10 §6.2）
     品质档已经删掉：不再先抽品质、再凑三张同品质卡。
     一次三选一就是从同一个池里按权重取三张，每张自己写清楚给几级。 */
  _open() {
    const d = this.draw;
    const cards = BUILD.candidates();
    if (!cards.length) {                      // 理论上不会发生，兜底不卡在 choose 相
      d.pending = null; d.lastChoiceTime = G.time; this.progress = 0;
      return;
    }
    d.pending.open = true;
    d.pending.cards = cards;
    const info = { index: d.evolutionIndex, pity: BUILD.sinceBig === 0 && BUILD.draws > 1,
                   mapMark: MAPBUILD.markText ? MAPBUILD.markText() : '' };
    this.log.push({
      i: d.evolutionIndex + 1, t: Math.round(G.time),
      defer: d.deferReason, cards: cards.map(c => c.id)
    });
    G.phase = 'choose';
    Audio2.mutation();
    G.ui.showEvolution(cards, info, id => this.pick(id));
  },

  /* -------------------------------------------- §7.1 步骤 6～7：应用 */
  pick(cardId) {
    const d = this.draw;
    if (!BUILD.cardOf(cardId)) return;
    const others = (d.pending && d.pending.cards || []).filter(c => c.id !== cardId).map(c => c.id);
    BUILD.take(cardId);

    /* 地图修正用后清除，避免长期权重失控（§6.4） */
    MAPBUILD.consume();

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
    G.bus.emit('evolutionTaken', { card: BUILD.cardOf(cardId) });
  },


  /* HUD 进度（§6.1 进度条清楚显示溢出） */
  progressFrac() { return this.need > 0 ? Math.min(1, this.progress / this.need) : 0; },
  overflowFrac() { return this.need > 0 ? Math.max(0, (this.progress - this.need) / this.need) : 0; }
};


