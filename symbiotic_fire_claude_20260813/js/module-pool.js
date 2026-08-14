/* ============================================================================
   SYMBIOTIC FIRE · 可组合模块卡池（todo5 §7 / §8 / §10）

   与 evolution-pool.js 的接口完全一致（init / candidates / byId），
   所以 evolution-director.js 只需要在 v2 打开时换一个池子，不动抽取流程。

   §10 的硬要求在 audit() 里落地：
     card → apply → combat consumer → feedback → result attribution
   任一环节缺失，卡牌不进入正式随机池；开发模式下报警而不是静默吞掉。
   ========================================================================== */
'use strict';

/* 每个基础模块在战斗侧的主消费者 —— 审计要拿它去 AG.consumers 里核对，
   所以必须逐个写清楚，不能用字符串拼出一个可能不存在的键。 */
const MODULE_CONSUMER = {
  volley: 'volley.pellets', blast: 'blast.radius', pierce: 'pierce.count',
  split: 'split.count', heavy: 'heavy.body', overclock: 'overclock.cadence',
  ricochet: 'ricochet.count', momentum: 'momentum.round'
};

const MODPOOL = {
  cards: [],
  byId: {},
  rejected: [],          // 审计未通过的卡（不进池）
  auditReport: null,

  init() {
    this.cards = [];
    this.byId = {};
    this.rejected = [];
    this._buildModuleOrigins();
    this._buildNodes();
    this._buildStrongNodes();
    this._buildConditionals();
    this._buildBranches();
    this._buildPairEpics();
    this._buildRules();
    this._buildGeneralMods();
    /* §10：先审计，再决定谁能进池 */
    this.auditReport = this.audit();
    const bad = {};
    this.auditReport.fail.forEach(f => { bad[f.id] = f; });
    const keep = [];
    this.cards.forEach(c => {
      if (bad[c.id]) { this.rejected.push(bad[c.id]); return; }
      keep.push(c);
    });
    this.cards = keep;
    this.cards.forEach(c => { this.byId[c.id] = c; });
    if (this.rejected.length && typeof DebugPanel !== 'undefined' && DebugPanel.log)
      DebugPanel.log('⚠ 卡牌审计拒绝 ' + this.rejected.length + ' 张：' +
        this.rejected.map(r => r.id + '(' + r.missing.join(',') + ')').join(' '));
    return this;
  },

  _add(c) {
    c.tags = c.tags || [];
    c.maxStacks = c.maxStacks === undefined ? 1 : c.maxStacks;
    /* 卡面统一四行以内（§7.2）：名称 / 主效果 / 代价 / 动态预览 */
    this.cards.push(c);
    return c;
  },

  /* ==========================================================================
     §7.3 基础模块卡：一个模块 × 四个品质
       普通 = 完整模块（不存在残废版）
       稀有 = 模块 + 一项原生离散强化
       史诗 = 模块 + 一项改变形态的原生分支
       传奇 = 模块 + 打破一条规则（带上限）
     ========================================================================== */
  _buildModuleOrigins() {
    const nodeOf = mod => MODULE_NODES.filter(n => n.mod === mod)[0];
    const ruleFor = { volley: 'r_derive', blast: 'r_blast', pierce: 'r_hit', split: 'r_depth',
      heavy: 'r_hit', overclock: 'r_mag', ricochet: 'r_depth', momentum: 'r_derive' };

    MODULE_IDS.forEach(id => {
      const M = TUNE.MODULES[id];
      const nd = nodeOf(id), br = BRANCH_BY_MOD[id], ru = RULE_MAP[ruleFor[id]];
      const variants = {
        common: { extra: '', apply: () => {}, consumer: null },
        rare: { extra: '，并立刻获得「' + nd.name + '」', apply: () => WMOD.grantNode(nd.id), consumer: nd.consumer },
        epic: { extra: '，并立刻获得形态分支「' + br.name + '」', apply: () => WMOD.grantBranch(br.id), consumer: br.consumer },
        legend: { extra: '，并改写规则：' + ru.text, apply: () => WMOD.grantRule(ru.id), consumer: ru.consumer }
      };
      TUNE.RARITY.order.forEach(q => {
        const v = variants[q];
        this._add({
          id: 'mod_' + id + '_' + q, quality: q, kind: 'module', module: id,
          name: M.name, en: M.en, css: M.css,
          effect: M.effect + v.extra,
          cost: q === 'legend' ? ru.cost : (q === 'epic' ? br.cost : M.cost),
          detail: this._moduleDetail(id, q),
          tags: [id, 'module'],
          consumer: MODULE_CONSUMER[id],
          consumer2: v.consumer,
          feedback: 'fx.' + id,
          attribution: id,
          requires: b => !WMOD.has(id) && !WMOD.full(),
          apply: () => { WMOD.grant(id); v.apply(); }
        });
      });
    });
  },

  _moduleDetail(id, q) {
    const M = TUNE.MODULES[id], m = {
      volley: '弹丸 +' + M.pellets + '，单次耗弹 +' + M.ammo + '，单弹伤害 ×' + M.dmgPerPellet,
      blast: '命中产生半径 ' + M.radius + 'm 的爆炸，基准伤害 ×' + M.dmgRatio + '，单次耗弹 +' + M.ammo,
      pierce: '贯穿 ' + M.count + ' 次，后排伤害继承 ' + Math.round(M.dmgDecay * 100) + '%，载荷继承 ' + Math.round(M.payloadDecay * 100) + '%',
      split: '命中生成 ' + M.count + ' 枚次级弹，继承伤害 ' + Math.round(M.dmgCoef * 100) + '%、载荷 ' + Math.round(M.payloadCoef * 100) + '%',
      heavy: '伤害 ×' + M.dmg + '，弹体 ×' + M.scale + '，击退 ×' + M.knock + '，射速间隔 ×' + M.rate,
      overclock: '弹匣 ×' + M.mag + '，射速间隔 ×' + M.rate + '，持续射击最高再 +' + Math.round(M.rampMax * 100) + '%',
      ricochet: '弹射 ' + M.count + ' 次，每次伤害继承 ' + Math.round(M.dmgDecay * 100) + '%、载荷 ' + Math.round(M.payloadDecay * 100) + '%',
      momentum: '动势 ≥' + M.releaseAt + ' 时下一轮射击伤害最高 ×' + M.dmg + '、弹体 +' + Math.round(M.scale * 100) + '%'
    }[id];
    const tail = { common: '', rare: '（稀有：附带一项原生强化）',
      epic: '（史诗：附带一项改变形态的分支）', legend: '（传奇：改写一条规则，带明确上限）' }[q];
    return m + tail;
  },

  /* -------------------------------------------------- §8 普通节点：深化行为 */
  _buildNodes() {
    MODULE_NODES.filter(n => n.mod).forEach(n => this._add({
      id: n.id, quality: 'common', kind: 'node', module: n.mod,
      name: n.name, css: TUNE.MODULES[n.mod].css,
      effect: n.text, cost: n.cost,
      detail: '深化「' + TUNE.MODULES[n.mod].name + '」的既有行为，最多 ' + n.max + ' 层。',
      tags: [n.mod, 'node'], maxStacks: n.max,
      consumer: n.consumer, feedback: 'fx.' + n.mod, attribution: n.mod,
      requires: b => WMOD.has(n.mod) && WMOD.node(n.id) < n.max,
      apply: () => WMOD.grantNode(n.id)
    }));
  },

  /* 稀有档的「一次两层」：仍然是同一个节点，不是新机制，所以只抬叠数不抬品质错觉 */
  _buildStrongNodes() {
    MODULE_NODES.filter(n => n.mod && n.max >= 2).forEach(n => this._add({
      id: 'sx_' + n.id, quality: 'rare', kind: 'node', module: n.mod,
      name: n.name + '·双档', css: TUNE.MODULES[n.mod].css,
      effect: n.text + '（一次获得两层）', cost: n.cost,
      detail: '一次获得两层「' + n.name + '」，仍受该节点的 ' + n.max + ' 层上限约束。',
      tags: [n.mod, 'node'], maxStacks: 2,
      consumer: n.consumer, feedback: 'fx.' + n.mod, attribution: n.mod,
      requires: b => WMOD.has(n.mod) && WMOD.node(n.id) <= n.max - 2,
      apply: () => { WMOD.grantNode(n.id); WMOD.grantNode(n.id); }
    }));
  },

  /* --------------------------------------- §8 条件分支：弱点 / 换弹 / 击杀 */
  _buildConditionals() {
    MODULE_NODES.filter(n => !n.mod).forEach(n => this._add({
      id: n.id, quality: n.q || 'rare', kind: 'cond',
      name: n.name, css: '#9fe4ff',
      effect: n.text, cost: n.cost,
      detail: '条件分支：只在满足条件时改变本次攻击的谱系参数，不新增平行伤害系统。',
      tags: ['cond'], maxStacks: n.max,
      consumer: n.consumer, feedback: 'fx.cond', attribution: 'procs',
      requires: b => WMOD.own.length >= 1 && WMOD.node(n.id) < n.max,
      apply: () => WMOD.grantNode(n.id)
    }));
  },

  /* ------------------------------------------ §7.3 史诗：改变形态的分支 */
  _buildBranches() {
    MODULE_BRANCHES.forEach(br => this._add({
      id: br.id, quality: 'epic', kind: 'branch', module: br.mod,
      name: br.name, css: TUNE.MODULES[br.mod].css,
      effect: br.text, cost: br.cost,
      detail: '把「' + TUNE.MODULES[br.mod].name + '」的形态改掉，而不是给它加百分比。',
      tags: [br.mod, 'branch'],
      consumer: br.consumer, feedback: 'fx.' + br.mod, attribution: br.mod,
      requires: b => WMOD.has(br.mod) && !WMOD.hasBranch(br.id),
      apply: () => WMOD.grantBranch(br.id)
    }));
  },

  /* 史诗档的组合深化：只对【已经成立的 S 级组合】开放，卡面直接写出那个组合的名字。
     §7.3 禁止「史诗爆裂额外赠送不相关的穿透」—— 所以这里只加强这一对已有的反应。 */
  _buildPairEpics() {
    const defs = [
      { key: 'blast+volley', name: '分点装药', effect: '统一爆炸预算提高，齐射的每个爆点都更大',
        cost: '仍然是一份预算，不是每颗一份', consumer: 'blast.radius',
        apply: () => { WMOD.grantNode('n_blast_radius'); WMOD.grantNode('n_volley_pellet'); } },
      { key: 'blast+split', name: '集束引信', effect: '次级弹的爆裂载荷继承大幅提高',
        cost: '深度与派生数量上限不变', consumer: 'split.coef',
        apply: () => { WMOD.grantNode('n_split_inherit'); WMOD.grantNode('n_split_inherit'); } },
      { key: 'blast+pierce', name: '终点装药', effect: '终点爆破的半径与贯穿深度同时提高',
        cost: '中途仍然不会爆炸', consumer: 'blast.terminal',
        apply: () => { WMOD.grantNode('n_blast_radius'); WMOD.grantNode('n_pierce_count'); } },
      { key: 'pierce+ricochet', name: '折线导轨', effect: '折向后保留更多贯穿次数与伤害',
        cost: '折向次数上限不变', consumer: 'ricochet.decay',
        apply: () => { WMOD.grantNode('n_ric_keep'); WMOD.grantNode('n_pierce_keep'); } },
      { key: 'heavy+overclock', name: '重型机关炮组', effect: '升速更快，峰值射速进一步夺回',
        cost: '峰值仍保留重型的单发冲击', consumer: 'overclock.ramp',
        apply: () => { WMOD.grantNode('n_oc_ramp'); WMOD.grantNode('n_heavy_rate'); } },
      { key: 'heavy+momentum', name: '动能炮闩', effect: '动势释放规模提高，强化轮更长',
        cost: '仍然需要先跑起来', consumer: 'momentum.gain',
        apply: () => { WMOD.grantNode('n_mom_scale'); WMOD.grantNode('n_mom_store'); } }
    ];
    /* §4 的六组关键反应有手写版本；其余每一对已命名的组合自动生成一张，
       否则玩家满 3 模块、三条形态分支也拿完之后，史诗池会凑不出三张。
       自动生成的一样必须「只加强这一对」——各取双方一个节点，不送不相关的东西。 */
    const firstNode = mod => MODULE_NODES.filter(n => n.mod === mod)[0];
    Object.keys(PAIR_NAME).forEach(key => {
      if (defs.some(d => d.key === key)) return;
      const parts = key.split('+');
      const na = firstNode(parts[0]), nb = firstNode(parts[1]);
      if (!na || !nb) return;
      defs.push({
        key: key, name: PAIR_NAME[key].name + '组',
        effect: '同时深化「' + na.name + '」与「' + nb.name + '」',
        cost: '两侧的节点上限都不变', consumer: na.consumer,
        apply: () => { WMOD.grantNode(na.id); WMOD.grantNode(nb.id); }
      });
    });

    defs.forEach(dd => {
      const parts = dd.key.split('+');
      const info = PAIR_NAME[dd.key];
      this._add({
        id: 'pe_' + dd.key.replace('+', '_'), quality: 'epic', kind: 'pair', pair: dd.key,
        name: dd.name, css: TUNE.MODULES[parts[1]].css,
        effect: dd.effect, cost: dd.cost,
        detail: '深化已经成立的 S 级组合「' + info.name + '」：' + info.desc,
        tags: parts.concat(['pair']),
        consumer: dd.consumer, feedback: 'fx.' + parts[0], attribution: parts[0],
        pairName: info.name,
        requires: b => WMOD.has(parts[0]) && WMOD.has(parts[1]) && !WMOD.taken['pe_' + dd.key.replace('+', '_')],
        apply: () => { dd.apply(); WMOD.taken['pe_' + dd.key.replace('+', '_')] = 1; }
      });
    });
  },

  /* -------------------------------------------------- §7.3 传奇：规则改写 */
  _buildRules() {
    MODULE_RULES.forEach(r => this._add({
      id: r.id, quality: 'legend', kind: 'rule',
      name: r.name, css: TUNE.RARITY.css.legend,
      effect: r.text, cost: r.cost,
      detail: '只打破这一条规则，其余上限全部保持不变 —— 这是 todo5 §6.3 的底线。',
      tags: ['rule', 'legend'],
      consumer: r.consumer, feedback: 'fx.rule', attribution: 'procs',
      requires: b => WMOD.own.length >= 1 && !WMOD.hasRule(r.id),
      apply: () => WMOD.grantRule(r.id)
    }));
  },

  /* --------------------------------------------------------------------------
     通用改装：只保留【不属于 §1/§8 禁用原子】且已有战斗消费者的那几项。
     被剔除的：大口径(伤害%)、轻量枪机(射速%)、稳定框架(散布%)、双联枪管(并发弹丸
     —— 那是齐射的职责)、处决弹头(条件伤害%)、催化增幅(伤害%)、扩散培养
     (范围% —— 已改写成爆裂的 n_blast_radius 节点)。
     -------------------------------------------------------------------------- */
  _buildGeneralMods() {
    const keep = [
      { id: 'mag', q: 'common', consumer: 'gun.mag', attribution: 'shots' },
      { id: 'reload', q: 'common', consumer: 'gun.reload', attribution: 'shots' },
      { id: 'stim', q: 'common', consumer: 'life.speed', attribution: 'kills' },
      { id: 'dashcd', q: 'common', consumer: 'life.dashcd', attribution: 'kills' },
      { id: 'magnet', q: 'common', consumer: 'life.magnet', attribution: 'kills' },
      { id: 'armor', q: 'common', consumer: 'life.hp', attribution: 'dmgTaken' },
      { id: 'trauma', q: 'rare', consumer: 'life.heal', attribution: 'dmgTaken' },
      { id: 'optic', q: 'rare', consumer: 'gun.optic', attribution: 'hits' },
      { id: 'feedback', q: 'rare', consumer: 'gun.feedback', attribution: 'procs' },
      { id: 'hunter', q: 'rare', consumer: 'gun.hunter', attribution: 'procs' },
      { id: 'aftershock', q: 'rare', consumer: 'gun.aftershock', attribution: 'procs' }
    ];
    keep.forEach(k => {
      const m = MODMAP[k.id];
      this._add({
        id: 'gm_' + m.id, quality: k.q, kind: 'mod', modId: m.id,
        name: m.name, css: '#c8d4e0',
        effect: m.text, cost: '—',
        detail: m.detail,
        tags: ['general'], maxStacks: m.max,
        consumer: k.consumer, feedback: 'fx.general', attribution: k.attribution,
        requires: b => (G.mods[m.id] || 0) < m.max,
        apply: () => { G.mods[m.id] = (G.mods[m.id] || 0) + 1; recompute(); emitBuildChanged(); }
      });
    });
  },

  /* ==========================================================================
     §10 自动核对：card → apply → combat consumer → feedback → attribution
     ========================================================================== */
  audit() {
    const fb = this._feedbackRegistry();
    const pass = [], fail = [];
    this.cards.forEach(c => {
      const missing = [];
      if (typeof c.apply !== 'function') missing.push('apply');
      if (typeof c.requires !== 'function') missing.push('requires');
      if (!c.effect) missing.push('face');
      if (!c.consumer || !AG.hasConsumer(c.consumer)) missing.push('consumer');
      if (c.consumer2 && !AG.hasConsumer(c.consumer2)) missing.push('consumer2');
      if (!c.feedback || !fb[c.feedback]) missing.push('feedback');
      /* 归因必须落在真实统计字段上：模块归因或 G.stats 字段 */
      const att = c.attribution;
      const attOk = att && (MODULE_IDS.indexOf(att) >= 0 || Object.prototype.hasOwnProperty.call(G.stats, att));
      if (!attOk) missing.push('attribution');
      (missing.length ? fail : pass).push({ id: c.id, missing: missing });
    });
    return { pass: pass, fail: fail, total: this.cards.length };
  },

  /* 反馈通道登记表：只承认真的有代码在画 / 在响的通道。
     weapon.js 负责枪械侧，attack-graph.js 负责世界侧。 */
  _feedbackRegistry() {
    const r = {};
    MODULE_IDS.forEach(id => { r['fx.' + id] = false; });
    if (typeof WEAPON !== 'undefined' && WEAPON.moduleFx)
      Object.keys(WEAPON.moduleFx).forEach(k => { r['fx.' + k] = true; });
    ['fx.cond', 'fx.rule', 'fx.general'].forEach(k => { r[k] = true; });
    return r;
  },

  /* ==========================================================================
     §7.1 步骤 3～5：在已抽定的品质内建有效池 → 加权 → 生成三张
     ========================================================================== */
  candidates(quality, drawState) {
    const B = TUNE.MODULE_BUILD;
    const idx = drawState.evolutionIndex;

    /* §7.1 第一次固定提供 3 张不同基础模块；
       第 4 次选择结束前仍不足 2 个模块时，本次也全部给基础模块。 */
    const forceModule = (B.originFirst && idx === 0) ||
      (idx + 1 >= B.minByDraw && WMOD.own.length < B.minModules);

    let pool = this.cards.filter(c => c.quality === quality && c.requires(SYN.build));
    if (forceModule) {
      const mods = pool.filter(c => c.kind === 'module');
      if (mods.length >= 3) return this._pickDistinctModule(mods, 3);
    }
    if (!pool.length) return [];

    const scored = pool.map(c => ({ c: c, w: this._weight(c), rel: this._relevant(c) }));
    const out = [];
    const takeFrom = list => {
      if (!list.length) return null;
      const total = list.reduce((s, x) => s + x.w, 0);
      let r = RNG.mods.next() * total;
      for (let i = 0; i < list.length; i++) { r -= list[i].w; if (r <= 0) return list[i]; }
      return list[list.length - 1];
    };
    const avail = () => scored.filter(x => {
      if (out.indexOf(x.c) >= 0) return false;
      /* 同一个模块在一次三选一里最多出现一张，否则三张会读起来是同一个方向 */
      if (x.c.module && out.some(o => o.module === x.c.module)) return false;
      return true;
    });

    /* 至少 2 张与当前构筑直接相关（沿用 §7.5 已验证的规则） */
    for (let i = 0; i < 2; i++) {
      const pick = takeFrom(avail().filter(x => x.rel));
      if (pick) out.push(pick.c);
    }
    while (out.length < 3) {
      const pick = takeFrom(avail());
      if (!pick) break;
      out.push(pick.c);
    }
    /* 还不够三张：放开「同模块只出一张」的限制，但绝不混入其他品质 */
    if (out.length < 3) {
      const rest = pool.filter(c => out.indexOf(c) < 0);
      for (let i = 0; i < rest.length && out.length < 3; i++) out.push(rest[i]);
    }
    return out;
  },

  _pickDistinctModule(list, n) {
    const pool = list.slice(), out = [], used = {};
    while (out.length < n && pool.length) {
      const i = RNG.mods.int(pool.length);
      const c = pool.splice(i, 1)[0];
      if (used[c.module]) continue;
      used[c.module] = 1; out.push(c);
    }
    return out;
  },

  _relevant(c) {
    if (c.kind === 'pair') return true;
    if (c.kind === 'module') {
      /* 还没满 3 个模块时，能与已有模块形成 S 的模块卡才算「相关」 */
      if (!WMOD.own.length) return true;
      return WMOD.previewS(c.module).length > 0;
    }
    if (c.module) return WMOD.has(c.module);
    return WMOD.own.length > 0;
  },

  _weight(c) {
    let w = 1;
    if (this._relevant(c)) w *= 2.4;
    if (c.kind === 'module' && WMOD.own.length < TUNE.MODULE_BUILD.minModules) w *= 2.2;
    if (c.kind === 'pair') w *= 1.7;
    if (c.kind === 'branch') w *= 1.4;
    if (c.kind === 'mod') w *= 0.6;         // 通用改装不许填满池子
    return w;
  },

  /* --------------------------------------------------------------------------
     §12.2 的实现侧审计：28 对组合各自「实现上到底发生了什么变化」。
     人工试玩负责判断好不好玩；这里只负责证明不是「两个效果各打各的」。
     -------------------------------------------------------------------------- */
  pairMatrix() {
    const rows = [];
    for (let i = 0; i < MODULE_IDS.length; i++)
      for (let j = i + 1; j < MODULE_IDS.length; j++) {
        const a = MODULE_IDS[i], b = MODULE_IDS[j];
        const key = pairKey(a, b);
        const info = PAIR_NAME[key];
        rows.push({
          key: key, a: a, b: b, tier: reactionOf(a, b),
          name: info ? info.name : null,
          keyPair: !!(info && info.key),
          effects: PAIR_EFFECTS[key] || []
        });
      }
    return rows;
  }
};

/* ============================================================================
   §5 / §12.2：每一对组合在实现上产生的可观察变化。
   这不是文案 —— 每一条后面都跟着一个真实的代码位置，
   审计脚本用它来证明「不是两个效果各打各的」。
   ========================================================================== */
/* 键必须是 pairKey() 的字典序形式（blast < heavy < momentum < overclock <
   pierce < ricochet < split < volley），否则查表恒空，审计会误报「没有实现」。 */
const PAIR_EFFECTS = {
  'blast+heavy':        ['爆炸半径 ×heavy.blastScale (WMOD.applyDerived)', '弹体与击退同时放大 → 更大更强但更慢'],
  'blast+momentum':     ['强化轮 blastRadius ×(1+momentum.blastR·s) (WMOD.applyDerived)'],
  'blast+overclock':    ['爆炸音在 blastSoundWindow 内合并 (AG._blastFx)', '射速提高 → 密集小爆破枪流'],
  'blast+pierce':       ['中途不爆，终点兑现 (AG.onHit 第6步 blastTerminal)', '射程终点也兑现 (AG.onBulletEnd)'],
  'blast+ricochet':     ['弹射后 payloadCoefficient ×bouncePayload → 落点衰减爆破 (AG._bounce)'],
  'blast+split':        ['次级弹继承 payloadCoefficient → 小爆点 (AG._spawnSplit)', '共享同一份爆炸预算 (root.blast)'],
  'blast+volley':       ['统一爆炸预算按根弹数分摊 → 多个缩小爆点 (AG.blast)', '预算随齐射数上调 (WMOD.applyDerived)'],

  'heavy+momentum':     ['强化轮额外 dmg ×1.60、弹体 ×1.10 (MODULE_PAIRS heavy+momentum)'],
  'heavy+overclock':    ['rampMax ×1.85、rampTime 拉长 → 逐步升成连续重炮 (MODULE_PAIRS)'],
  'heavy+pierce':       ['弹体 ×heavy.scale 抬高命中半径 → 大弹体长线贯穿 (updateBullets segCylinder)'],
  'heavy+ricochet':     ['大弹体折向并保留 knock ×heavy.knock (AG._bounce)'],
  'heavy+split':        ['次级弹数量 -1、伤害 ×1.55、弹体 ×1.35 (WMOD.applyDerived)'],
  'heavy+volley':       ['耗弹叠加 heavy.ammo + volley.ammo', '每颗根弹都吃重型属性 → 少量高耗弹重型齐射'],

  'momentum+overclock': ['强化轮期间 holdGrace ×2.4，超频不衰减 (WMOD.tick)', '强化轮按时间计 roundStreamT'],
  'momentum+pierce':    ['强化轮 pierce +1 (WMOD.applyDerived pierceAt)'],
  'momentum+ricochet':  ['强化轮 bounce +1 (WMOD.applyDerived bounceAt)'],
  'momentum+split':     ['强化轮 splitCount +1 (WMOD.applyDerived splitAt)'],
  'momentum+volley':    ['强化轮覆盖整次齐射 roundVolley (WMOD.startRound)'],

  'overclock+pierce':   ['持续枪流叠加贯穿 → 钻穿前排（节奏侧，不新建伤害系统）'],
  'overclock+ricochet': ['ramp ≥bounceRampAt 时 bounce +1 (WMOD.applyDerived)'],
  'overclock+split':    ['分裂攒成周期性合并波，禁止逐弹生成对象 (AG._split waveHits)'],
  'overclock+volley':   ['射速与弹匣提高 → 齐射节奏加快，弹匣压力更明显（节奏侧）'],

  'pierce+ricochet':    ['贯穿耗尽才允许折向 (AG.onHit 第3→4步顺序)', '折向后 remainingPierce 降为 50% (AG._bounce)'],
  'pierce+split':       ['次级弹继承 floor(pierce×0.35) (AG._spawnSplit)'],
  'pierce+volley':      ['每颗根弹各自继承 remainingPierce → 多条贯穿枪线 (AG.rootBullet)'],

  'ricochet+split':     ['次级弹继承 1 次弹射，共享同一份派生预算 (AG._spawnSplit)'],
  'ricochet+volley':    ['每颗根弹各自寻找后续目标，共享事件预算 (AG._bounce)'],

  'split+volley':       ['每颗根弹各自分裂，但共享 derivedPerRoot → 受限弹幕 (AG.allowDerived)']
};
