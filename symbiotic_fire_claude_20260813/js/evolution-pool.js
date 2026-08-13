/* ============================================================================
   SYMBIOTIC FIRE · 统一进化卡池（todo3 §7.2 / §7.5）
   职责只有两件：定义卡牌数据，以及在【已经抽定的品质】内生成三张有效候选。
   品质抽取不在这里 —— §9 要求两步分开、可分别单测。
   ========================================================================== */
'use strict';

const EVOPOOL = {
  cards: [],
  byId: {},

  init() {
    this.cards = [];
    this.byId = {};
    this._buildOrigins();
    this._buildCommons();
    this._buildLinks();
    this._buildFusions();
    this._buildLegendaries();
    this._buildMapAbilities();
    this._buildFillers();
    this.cards.forEach(c => { this.byId[c.id] = c; });
    return this;
  },

  _add(c) {
    c.tags = c.tags || [];
    c.maxStacks = c.maxStacks === undefined ? 1 : c.maxStacks;
    this.cards.push(c);
    return c;
  },

  /* ------------------------------------------------------------ 起源卡 §7.5 */
  /* 每个基础变异 × 每个品质各一张。稀有 / 史诗起源必须“基础变异 + 该品质对应的强化”，
     不能只换卡框颜色（§7.5），所以高品质起源直接附带一个可见的离散强化。 */
  _buildOrigins() {
    const bonus = {
      common: { text: '', apply: () => {} },
      rare: { text: '，并立刻获得 +1 穿透', apply: () => SYN.grantNode('node_pierce') },
      epic: { text: '，并立刻获得 +1 穿透与 +10% 伤害', apply: () => { SYN.grantNode('node_pierce'); SYN.grantNode('node_dmg'); } },
      legend: { text: '，并立刻获得 +1 穿透、+10% 伤害与 +1 分裂', apply: () => { SYN.grantNode('node_pierce'); SYN.grantNode('node_dmg'); SYN.grantNode('node_split'); } }
    };
    BASE_IDS.forEach(id => {
      TUNE.RARITY.order.forEach(q => {
        const m = MUT[id], bo = bonus[q];
        this._add({
          id: 'origin_' + id + '_' + q, quality: q, kind: 'origin', base: id,
          name: m.name, text: m.you + bo.text, horde: m.horde,
          relation: '起源：' + m.name, css: m.css, tags: [id, 'origin'],
          requires: b => b.baseMutations.indexOf(id) < 0 && b.baseMutations.length < TUNE.EVOLUTION.maxBaseMutations,
          apply: () => { SYN.grantBase(id); bo.apply(); }
        });
      });
    });
  },

  /* ------------------------------------------------------------ 普通卡 §7.2 */
  /* “多一个、少一次、多穿一个”这类离散变化优先；
     既有的 19 个改装作为已经调好的一部分保留，但打上 numeric 标记，
     §7.5 限制同一组不得出现三个纯数值档位。 */
  _buildCommons() {
    const disc = [
      { id: 'node_split', name: '增殖节点', text: '分裂弹数量 +1', tags: ['fission', 'split'], max: 2,
        req: b => b.baseMutations.indexOf('fission') >= 0 },
      { id: 'node_conduct', name: '导通阈值', text: '传导所需命中 -1', tags: ['conduct', 'shock'], max: 3,
        req: b => b.baseMutations.indexOf('conduct') >= 0 },
      { id: 'node_pierce', name: '骨刺', text: '子弹穿透 +1', tags: ['ossify', 'pierce'], max: 3 },
      { id: 'node_blastr', name: '装药', text: '爆炸半径 +15%', tags: ['blast', 'aoe'], max: 2,
        req: b => b.baseMutations.indexOf('blast') >= 0 },
      { id: 'node_ocramp', name: '进气', text: '过载充满所需时间 -20%', tags: ['overclock', 'charge'], max: 2,
        req: b => b.baseMutations.indexOf('overclock') >= 0 },
      { id: 'node_size', name: '膨胀', text: '弹体体积 +25%', tags: ['giant', 'size'], max: 2,
        req: b => b.baseMutations.indexOf('giant') >= 0 },
      { id: 'node_dmg', name: '增压弹头', text: '伤害 +10%', tags: ['damage'], max: 3, numeric: true }
    ];
    disc.forEach(d => this._add({
      id: d.id, quality: 'common', kind: 'node',
      name: d.name, text: d.text, horde: null, relation: null,
      tags: d.tags, maxStacks: d.max, numeric: !!d.numeric,
      requires: b => (!d.req || d.req(b)) && SYN.node(d.id) < d.max,
      apply: () => { SYN.grantNode(d.id); recompute(); }
    }));

    /* 既有改装：数值已调过，直接进普通池，避免重造一套平行系统（§9） */
    MODS.forEach(m => this._add({
      id: 'mod_' + m.id, quality: 'common', kind: 'mod', modId: m.id,
      name: m.name, text: m.text, horde: null, relation: null,
      tags: [m.kind === 'fire' ? 'damage' : m.kind === 'chain' ? 'chain' : 'survival'],
      maxStacks: m.max, numeric: true,
      requires: () => modAvailable(m),
      apply: () => { G.mods[m.id] = (G.mods[m.id] || 0) + 1; recompute(); emitBuildChanged(); }
    }));
  },

  /* --------------------------------------------------------- 稀有连接 §7.7 */
  /* 只有相关节点存在时才能出现 —— 两个基础变异都得有。 */
  _buildLinks() {
    COMBOS.forEach(c => this._add({
      id: 'link_' + c.key, quality: 'rare', kind: 'link', combo: c.key,
      name: c.linkName, text: c.linkText, horde: null,
      relation: '连接：' + MUT[c.a].name + ' → ' + MUT[c.b].name,
      css: MUT[c.a].css, tags: c.tags.concat([c.a, c.b, 'link']),
      requires: b => b.baseMutations.indexOf(c.a) >= 0 && b.baseMutations.indexOf(c.b) >= 0
        && b.rareLinks.indexOf(c.key) < 0,
      apply: () => SYN.grantLink(c.key)
    }));
  },

  /* --------------------------------------------------------- 史诗融合 §7.7 */
  _buildFusions() {
    COMBOS.forEach(c => this._add({
      id: 'fusion_' + c.key, quality: 'epic', kind: 'fusion', combo: c.key,
      name: c.fusionName, text: c.fusionText,
      horde: '对应融合精英进入后续波次',
      relation: '融合：' + MUT[c.a].name + ' + ' + MUT[c.b].name,
      css: MUT[c.b].css, tags: c.tags.concat([c.a, c.b, 'fusion']),
      requires: b => b.baseMutations.indexOf(c.a) >= 0 && b.baseMutations.indexOf(c.b) >= 0
        && b.epicFusions.indexOf(c.key) < 0,
      apply: () => SYN.grantFusion(c.key)
    }));
  },

  /* --------------------------------------------------------- 传奇规则 §7.2 */
  /* 必须改变规则，但仍有生成深度、目标次数或时间预算 —— 不能造成无限递归。
     四张覆盖不同构筑方向：连锁 / 弹匣 / 地图 / 空间。 */
  _buildLegendaries() {
    const rules = [
      { id: 'legend_chain', name: '自繁殖连锁', text: '连锁效果可以再自繁殖一次',
        horde: '终局尸王获得同主题的终端能力', tags: ['chain', 'shock', 'split'],
        req: b => b.rareLinks.length + b.epicFusions.length >= 1 },
      { id: 'legend_mag', name: '弹匣规则改写', text: '不再消耗弹匣，改为过热节奏',
        horde: '终局尸王获得同主题的终端能力', tags: ['reload', 'charge'] },
      { id: 'legend_city', name: '城市成为武器', text: '地图路线元素会参与你的输出',
        horde: '终局尸王获得同主题的终端能力', tags: ['map', 'aoe'],
        req: () => CITY.enabled },
      { id: 'legend_air', name: '滞空规则改写', text: '滞空期间连锁不消耗预算深度',
        horde: '终局尸王获得同主题的终端能力', tags: ['movement', 'chain'],
        req: () => CITY.enabled }
    ];
    rules.forEach(r => this._add({
      id: r.id, quality: 'legend', kind: 'legend',
      name: r.name, text: r.text, horde: r.horde, relation: '规则改写',
      css: TUNE.RARITY.css.legend, tags: r.tags.concat(['legend']),
      requires: b => (!r.req || r.req(b)) && b.legendaryRules.indexOf(r.id) < 0,
      apply: () => SYN.grantRule(r.id)
    }));
  },

  /* ------------------------------------------------------ 地图能力卡 §7.8 */
  /* 地图能力不是额外选择类型，它们就是统一进化池里的卡。 */
  _buildMapAbilities() {
    const abil = [
      { id: 'ab_facade', q: 'epic', name: '高压立面', text: '墙跑经过发光立面时为传导充能；闪电会点亮墙面电网',
        tags: ['map', 'shock', 'movement'], req: b => b.baseMutations.indexOf('conduct') >= 0 && CITY.enabled },
      { id: 'ab_block', q: 'epic', name: '尸爆街区', text: '被爆裂摧毁的车辆成为二次爆炸源',
        tags: ['map', 'blast', 'aoe'], req: b => b.baseMutations.indexOf('blast') >= 0 && CITY.enabled },
      { id: 'ab_roofhunt', q: 'rare', name: '捕食天台', text: '滞空弱点击杀刷新一次空中冲刺；每次滞空最多一次',
        tags: ['map', 'movement', 'kill'], req: () => CITY.enabled },
      { id: 'ab_rail', q: 'rare', name: '动能滑轨', text: '滑索、滑铲与高速路线积累动量，下一轮射击获得重击',
        tags: ['map', 'movement', 'size', 'charge'],
        req: b => CITY.enabled && (b.baseMutations.indexOf('giant') >= 0 || b.baseMutations.indexOf('overclock') >= 0) },
      { id: 'ab_momload', q: 'rare', name: '动量装填', text: '完成翻越、滑铲或墙跑时补充部分弹匣',
        tags: ['map', 'movement', 'reload'], req: () => CITY.enabled },
      { id: 'ab_slam', q: 'rare', name: '坠落震荡', text: '从足够高度落地时产生击退波',
        tags: ['map', 'movement', 'knock'], req: () => CITY.enabled },
      { id: 'ab_wallarmor', q: 'rare', name: '壁行装甲', text: '墙跑期间获得短暂护盾，离墙后迅速衰减',
        tags: ['map', 'movement', 'survival'], req: () => CITY.enabled },
      { id: 'ab_slidefire', q: 'epic', name: '滑铲火线', text: '滑铲路径留下短时伤害区',
        tags: ['map', 'movement', 'blast', 'aoe'],
        req: b => CITY.enabled && (b.baseMutations.indexOf('blast') >= 0 || b.baseMutations.indexOf('overclock') >= 0) }
    ];
    abil.forEach(a => this._add({
      id: a.id, quality: a.q, kind: 'ability',
      name: a.name, text: a.text, horde: null, relation: '地图能力',
      css: '#ff8a1e', tags: a.tags,
      requires: b => (!a.req || a.req(b)) && b.mapAbilities.indexOf(a.id) < 0,
      apply: () => { SYN.grantAbility(a.id); if (typeof MAPBUILD !== 'undefined') MAPBUILD.onAbility(a.id); }
    }));
  },

  /* ------------------------------------------------------ 同品质通用卡 §7.5 */
  /* 有效池不足 3 张时用它补足；禁止偷偷混入低品质卡。 */
  _buildFillers() {
    const f = [
      { q: 'common', id: 'fill_c1', name: '备份弹链', text: '弹匣容量 +15%', tags: ['reload'] },
      { q: 'common', id: 'fill_c2', name: '轻量枪托', text: '散布 -12%', tags: ['damage'] },
      { q: 'common', id: 'fill_c3', name: '应急肾上腺', text: '冲刺冷却 -10%', tags: ['survival', 'movement'] },
      { q: 'rare', id: 'fill_r1', name: '击杀回收', text: '击杀返还 1 发弹药', tags: ['kill', 'reload'] },
      { q: 'rare', id: 'fill_r2', name: '命中充能', text: '连续命中提高下一次变异伤害', tags: ['charge', 'chain'] },
      { q: 'rare', id: 'fill_r3', name: '移动装填', text: '移动中换弹速度 +30%', tags: ['movement', 'reload'] },
      { q: 'rare', id: 'fill_r4', name: '回路稳压', text: '变异伤害 +20%', tags: ['chain'] },
      { q: 'epic', id: 'fill_e1', name: '共振腔', text: '所有变异效果范围 +30%，并改变命中音色', tags: ['aoe', 'chain'] },
      { q: 'epic', id: 'fill_e2', name: '过载熔芯', text: '过载达到上限时每发附带一次小型冲击', tags: ['charge', 'aoe'] },
      { q: 'epic', id: 'fill_e3', name: '相位弹芯', text: '子弹穿过敌人后重新聚焦，命中改变弹道颜色', tags: ['pierce', 'line'] },
      { q: 'epic', id: 'fill_e4', name: '尸潮引力', text: '击杀在原地留下短暂吸引场', tags: ['kill', 'aoe'] },
      { q: 'legend', id: 'fill_l1', name: '预算重写', text: '连锁的单目标次数上限 +1', tags: ['chain', 'legend'] },
      { q: 'legend', id: 'fill_l2', name: '时间预算改写', text: '所有变异的冷却与阈值再降一档', tags: ['charge', 'legend'] }
    ];
    f.forEach(c => this._add({
      id: c.id, quality: c.q, kind: 'filler',
      name: c.name, text: c.text, horde: null, relation: null,
      css: TUNE.RARITY.css[c.q], tags: c.tags, maxStacks: 4, filler: true,
      /* §7.5 禁止偷偷混入低品质卡 —— 所以同品质通用卡的叠数必须足够，
         否则后期史诗池被抽干时只能凑出两张。 */
      requires: b => (b.taken[c.id] || 0) < 4,
      apply: () => {
        SYN.build.taken[c.id] = (SYN.build.taken[c.id] || 0) + 1;
        if (c.id === 'fill_c1') { G.mods.mag = (G.mods.mag || 0); SYN.grantNode('fill_mag'); }
        recompute();
      }
    }));
  },

  /* ====================================================================== */
  /* §7.1 第 3～5 步：在已抽定的品质内建有效池 → 加权 → 生成三张不重复候选。 */
  candidates(quality, drawState) {
    const b = SYN.build;
    const idx = drawState.evolutionIndex;

    /* §7.5 第一次固定为起源候选集；
       §7.4 第 4 次仍不足两个基础变异时，本次也必须全部是同品质起源卡。 */
    const forceOrigin = (idx === 0) ||
      (idx + 1 >= TUNE.EVOLUTION.originByDraw && b.baseMutations.length < TUNE.EVOLUTION.minBaseMutations);

    let pool = this.cards.filter(c => c.quality === quality && c.requires(b));
    if (forceOrigin) {
      const org = pool.filter(c => c.kind === 'origin');
      if (org.length >= 3) return this._pickDistinctBase(org, 3);
      /* 起源不足（已有 3 个基础变异不该走到这里）时退回普通流程 */
    }
    pool = pool.filter(c => !forceOrigin || c.kind !== 'origin' || true);

    if (!pool.length) return [];

    /* 相关度与地图标签倾向只影响同品质池内的权重，不影响已抽好的品质（§7.5） */
    const bias = (TUNE.FEATURES.mapBuildInfluence && typeof MAPBUILD !== 'undefined')
      ? MAPBUILD.tagBias() : null;
    const scored = pool.map(c => ({ c: c, w: this._weight(c, b, bias), rel: this._relevant(c, b) }));

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
      /* §7.5 同一组不得出现同一机制的三个纯数值档位：纯数值卡最多 1 张 */
      if (x.c.numeric && out.filter(o => o.numeric).length >= 1) return false;
      return true;
    });

    /* §7.5 至少 2 张必须与当前构筑直接相关 */
    for (let i = 0; i < TUNE.EVOLUTION.relevantMin; i++) {
      const pick = takeFrom(avail().filter(x => x.rel));
      if (pick) out.push(pick.c);
    }
    while (out.length < 3) {
      const pick = takeFrom(avail());
      if (!pick) break;
      out.push(pick.c);
    }

    /* §7.5 有效池不足 3 张时用同品质通用卡补足，禁止混入低品质 */
    if (out.length < 3) {
      const fill = this.cards.filter(c => c.quality === quality && c.filler
        && out.indexOf(c) < 0 && c.requires(b));
      for (let i = 0; i < fill.length && out.length < 3; i++) out.push(fill[i]);
    }
    return out;
  },

  /* 起源候选：三张必须是不同的基础变异（§7.5） */
  _pickDistinctBase(list, n) {
    const pool = list.slice();
    const out = [], used = {};
    while (out.length < n && pool.length) {
      const i = RNG.mods.int(pool.length);
      const c = pool.splice(i, 1)[0];
      if (used[c.base]) continue;
      used[c.base] = 1; out.push(c);
    }
    return out;
  },

  _relevant(c, b) {
    if (c.kind === 'link' || c.kind === 'fusion') return true;      // 前置已保证相关
    if (c.kind === 'origin') return b.baseMutations.length < TUNE.EVOLUTION.minBaseMutations;
    for (let i = 0; i < b.baseMutations.length; i++)
      if (c.tags.indexOf(b.baseMutations[i]) >= 0) return true;
    if (c.kind === 'node' && SYN.node(c.id) > 0) return true;
    return false;
  },

  _weight(c, b, bias) {
    let w = 1;
    if (this._relevant(c, b)) w *= 2.4;                              // 构筑相关度
    if (c.kind === 'link') {
      w *= 1.6;
      /* §7.4 已有两个基础变异却长期没有连接时，抬高连接卡权重 */
      if (b.baseMutations.length >= TUNE.PITY.linkBiasAfter && b.rareLinks.length === 0) w *= 2.2;
    }
    if (c.kind === 'fusion') w *= 1.5;
    if (c.numeric) w *= 0.55;                                        // 不让纯数值卡填满池子
    if (bias) for (let i = 0; i < c.tags.length; i++) if (bias[c.tags[i]]) w *= bias[c.tags[i]];
    return w;
  }
};
