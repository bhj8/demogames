/* ============================================================================
   SYMBIOTIC FIRE · 共同进化映射（todo3 §7.9）
   目的只有一个：让玩家看见自己改变了世界。
   绝不是把卡牌收益扣回去 —— 高品质卡必须保持显著净收益（§7.9 约束）。

   分层映射，不给每张玩家卡都发全体怪物加成：
     新基础变异 → 对应普通变体进入刷新池，只占部分权重
     普通单节点 → 只强化玩家
     稀有连接   → 通常只强化玩家，少数允许一个轻量可预警的精英动作
     史诗融合   → 对应融合精英进入后续波次
     传奇规则   → 普通尸潮不继承，只有终局 Boss 获得一个主题化终端能力
   ========================================================================== */
'use strict';

const HORDE = {
  state: null,

  init() {
    this.state = {
      activeBaseVariants: [],   // 进入刷新池的基础变体
      fusionElites: [],         // 融合精英（comboKey）
      bossTerminalRule: null,   // 传奇只映射终局 Boss
      eliteActions: []          // 少数稀有连接带来的轻量精英动作
    };
    return this;
  },

  /* 每类映射各自有刷新上限（§7.9 约束） */
  caps: { baseVariants: 3, fusionElites: 2, eliteActions: 2 },

  /* --- 新基础变异：对应主题的普通变体进入刷新池，但只占部分刷新权重 --- */
  onBaseMutation(id) {
    if (!this.state) return;
    if (this.state.activeBaseVariants.length >= this.caps.baseVariants) return;
    if (this.state.activeBaseVariants.indexOf(id) >= 0) return;
    this.state.activeBaseVariants.push(id);
    /* 复用既有的变种投放链路：延迟 → 教学生成 → 进入权重池（§13.3 / §26）。
       玩家先享受纯收益，十几秒后尸潮才适应。 */
    G.tutorialQueue.push({ t: TUNE.VARIANT.tutorialDelay, id: id });
  },

  /* ==========================================================================
     todo5 §9 尸群共同变异
     玩家与尸群继续共享主题，但不强求同一个公式，也【不】为了对称硬造低质量敌人：
       爆裂 → 爆裂尸（可利用也需规避的双向决策，已有实现）
       分裂 → 裂变尸（普通死亡生幼体，弱点击杀破坏裂变核）
       穿透 → 骨甲尸（正面骨板 + 侧后/弱点反制）
       超频 → 超频尸（加速过程可见，存在失速窗口）
       重型 → 巨尸（高价值高压目标，不是纯血量包）
     §9 明确：齐射 / 弹射 / 动势【不要求】一期各自新增怪物，所以这里映射为 null，
     复用既有变种而不是硬造第四、第五种敌人。
     ========================================================================== */
  MODULE_VARIANT: {
    blast: 'blast', split: 'fission', pierce: 'ossify',
    overclock: 'overclock', heavy: 'giant',
    volley: null, ricochet: null, momentum: null
  },

  onModule(id) {
    if (!this.state) return;
    const v = this.MODULE_VARIANT[id];
    if (!v) return;                     // §9 不为了对称硬造敌人
    this.onBaseMutation(v);
  },

  /* 史诗形态分支：对应主题的融合精英进入后续波次（沿用 §7.9 的投放链路） */
  onBranch(branchId) {
    if (!this.state) return;
    const br = BRANCH_MAP[branchId];
    if (!br) return;
    const v = this.MODULE_VARIANT[br.mod];
    if (!v) return;
    if (this.state.fusionElites.length >= this.caps.fusionElites) return;
    /* 复用既有融合精英模板：用同主题的变体色，不新建一套敌人系统 */
    const key = v + '+' + v;
    this.state.moduleElites = this.state.moduleElites || [];
    this.state.moduleElites.push({ variant: v, name: br.name });
    G.ui.toast('尸潮出现了同主题精英：' + br.name + '体', MUT[v].css, true);
  },

  /* 传奇规则：普通尸潮不继承，只有终局 Boss 拿到一个终端能力（§7.9 不变） */
  onRule(ruleId) {
    if (!this.state) return;
    this.state.bossTerminalRule = ruleId;
    G.ui.toast('远处传来回应 —— 尸王正在学习这条规则', TUNE.RARITY.css.legend, true);
  },

  /* --- 稀有连接：通常只强化玩家。少数允许一个轻量、可预警的精英动作 --- */
  eliteLinkWhitelist: ['blast+conduct', 'ossify+giant', 'overclock+giant'],
  onRareLink(key) {
    if (!this.state) return;
    if (this.eliteLinkWhitelist.indexOf(key) < 0) return;
    if (this.state.eliteActions.length >= this.caps.eliteActions) return;
    this.state.eliteActions.push(key);
    G.ui.hint('尸潮出现了新的动作：' + COMBO_MAP[key].linkName + '（有预警）', '#ff8a4a');
  },

  /* --- 史诗融合：对应融合精英进入后续波次，独立轮廓、声音与攻击预警 --- */
  onEpicFusion(key) {
    if (!this.state) return;
    if (this.state.fusionElites.length >= this.caps.fusionElites) return;
    this.state.fusionElites.push(key);
    const c = COMBO_MAP[key];
    G.ui.toast('尸潮融合体出现：' + c.fusionName, MUT[c.b].css, true);
  },

  /* --- 传奇：普通尸潮不继承，只有终局 Boss 拿到一个终端能力 --- */
  onLegendary(id) {
    if (!this.state) return;
    this.state.bossTerminalRule = id;
    /* §7.9 传奇 Boss 能力必须在出现前连续预告 */
    G.ui.toast('远处传来回应 —— 尸王正在学习这条规则', TUNE.RARITY.css.legend, true);
  },

  /* 融合精英模板：从冲撞精英派生，套用融合的主题色与轮廓 */
  fusionEliteTemplate(key) {
    const c = COMBO_MAP[key];
    if (!c) return null;
    const t = Object.assign({}, ENEMIES.charger);
    t.id = 'fus_' + key;
    t.name = c.fusionName + '体';
    t.variant = c.b;
    t.color = MUT[c.b].color;
    t.accent = MUT[c.a].color;
    t.hp = ENEMIES.charger.hp * 1.25;
    t.xp = ENEMIES.charger.xp * 1.4;
    t.navKind = 'grunt';
    t.fusionKey = key;
    return t;
  },

  /* 导演每隔一段时间投放一只融合精英；不与 Boss 入场抢注意力 */
  _cd: 0,
  update(dt) {
    if (!this.state || !this.state.fusionElites.length) return;
    this._cd -= dt;
    if (this._cd > 0) return;
    this._cd = 42;
    if (G.bossAlive || G.phase !== 'play') return;
    const key = RNG.spawn.pick(this.state.fusionElites);
    const tpl = this.fusionEliteTemplate(key);
    if (!tpl) return;
    const pos = spawnPosition(false);
    if (!pos) return;
    configureEnemy(G.enemies.get(), tpl, pos, { grace: 1.2, highlight: 0 });
    G.ui.toast('融合精英：' + tpl.name, MUT[COMBO_MAP[key].b].css);
    Audio2.telegraph(G.player.pos, 'charge');
  },

  /* 终局 Boss 的终端能力：只在尸王身上生效 */
  applyBossTerminal(e) {
    const id = this.state && this.state.bossTerminalRule;
    if (!id || !e.king) return;
    e.terminalRule = id;
    const card = (typeof MODPOOL !== 'undefined' && MODPOOL.byId[id]) || EVOPOOL.byId[id];
    G.ui.toast('尸王掌握了：' + (card ? card.name : id), TUNE.RARITY.css.legend, true);
  },

  describe() {
    if (!this.state) return '-';
    return '变体 ' + (this.state.activeBaseVariants.map(i => MUT[i].name).join('/') || '-') +
      ' · 融合精英 ' + (this.state.fusionElites.length) +
      ' · Boss终端 ' + (this.state.bossTerminalRule || '-');
  }
};
