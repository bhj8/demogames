/* ============================================================================
   SYMBIOTIC FIRE · 自然反应 Build V3（todo10）

   这个文件取代了 todo5 的 weapon-modules.js + module-pool.js。
   两者的区别不是重构，是设计换掉了：

     todo5：S/A 反应矩阵 + 28 对逐对实现 + 融合命名 + 品质专属规则。
            设计师先算完所有结果，玩家负责触发配方。
     todo10：六个分子 + 一套统一攻击规律。组合结果自己长出来，
            不命名、不评级、不为任何一对写专属代码。

   所以这里【找不到】reactionOf、pairInfo、PAIR_EFFECTS 这类东西 ——
   §11.2 的验收条件就是「删掉任意组合名称表后，战斗结果不发生变化」，
   而唯一能保证这件事的办法，是根本没有那张表。

   品质档也整个删掉了（§6.3 改版，Bao 2026-08-14）：
   大升级固定 +2 级，小升级固定 +1 级。玩家抽到的是确定的量，不是一次赌博。
   ========================================================================== */
'use strict';

/* ---------------------------------------------------------------- 卡牌定义 */
/* 一张卡只需要回答三件事（§7.1）：得到什么、付出什么、数值从多少变成多少。
   line(lv) 里的 now/next 必须是【当前 Build 下的真实数字】——
   多发 + 远射这种互斥组合，玩家自己就能从数字上看出来是坑，
   不需要我去替他平衡（Bao：「玩家自己想要这种结果，那他就受着」）。 */

const CARDS = [];
const CARD_BY_ID = {};

function card(c) {
  c.big = c.kind === 'mol' || c.kind === 'choice' || c.kind === 'demon';
  /* 恶魔卡不分级：它改写的是规则，不是数字。「再来一张 Lv2 自动瞄准」
     没有任何含义，所以它只有 1 级，而且拿过之后就退出牌池。 */
  c.levels = c.kind === 'demon' ? 1 : c.big ? TUNE.BUILD.bigLevels : TUNE.BUILD.smallLevels;
  CARDS.push(c); CARD_BY_ID[c.id] = c;
  return c;
}

const pct = v => Math.round(v * 100) + '%';
const mul = v => '×' + (Math.round(v * 100) / 100);
const one = v => (Math.round(v * 10) / 10).toString();

/* ================================================================ 六个分子 */
/* 分子改变枪【怎么发射、怎么传播、怎么结算】。首次获得是大升级，
   再次获得只提高同一张卡的等级，不产生新名称。 */

card({
  id: 'volley', kind: 'mol', css: TUNE.MOL.volley.css, name: '多发',
  gain: '每枪多打出几颗弹丸，只多消耗少量弹药',
  cost: '距离越远，每颗弹丸衰减越明显',
  stat(lv) {
    const M = TUNE.MOL.volley;
    if (lv <= 0) return { pellets: 1, ammo: 0 };
    return {
      pellets: M.pelletsAt1 + (lv - 1) * M.pelletPerLv,
      ammo: M.ammoAt1 - 1 + Math.floor((lv - 1) / M.ammoEveryLv)
    };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['每枪弹丸：' + a.pellets + ' → ' + b.pellets,
            '单次耗弹：' + (1 + a.ammo) + ' → ' + (1 + b.ammo) + ' 发'];
  }
});

card({
  id: 'corpse', kind: 'mol', css: TUNE.MOL.corpse.css, name: TUNE.MOL.corpse.name,
  gain: '敌人死亡时炸开，威力按【它自己的生命上限】算 —— 杀得越硬，炸得越狠',
  cost: '只有打死才炸；连锁最多 ' + TUNE.BUILD.corpseDepth + ' 层',
  stat(lv) {
    const M = TUNE.MOL.corpse;
    if (lv <= 0) return { pct: 0, radius: 0 };
    return { pct: M.pctAt1 + (lv - 1) * M.pctPerLv,
             radius: M.radiusAt1 + (lv - 1) * M.radiusPerLv };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    /* 卡面给两个真实数字：小怪炸多少、精英炸多少。
       「死者生命的 25%」对玩家是抽象的，「肉山炸 850」不是。 */
    const g = Math.round(ENEMIES.grunt.hp * b.pct * G.hpScale());
    const m = Math.round(ENEMIES.midboss.hp * b.pct * G.hpScale());
    return ['爆炸伤害：死者生命上限的 ' + pct(a.pct) + ' → ' + pct(b.pct) +
            '（现在：普通怪 ' + g + ' / 肉山 ' + m + '）',
            '爆炸半径：' + one(a.radius) + ' → ' + one(b.radius) + ' 米'];
  }
});

card({
  id: 'pierce', kind: 'mol', css: TUNE.MOL.pierce.css, name: '穿透',
  gain: '子弹穿过敌人继续飞，每次命中都完整结算',
  cost: '穿过之后伤害逐次降低',
  stat(lv) {
    const M = TUNE.MOL.pierce;
    if (lv <= 0) return { count: 0, keep: 1 };
    return { count: M.countAt1 + (lv - 1) * M.countPerLv,
             keep: Math.min(M.keepMax, M.keepAt1 + (lv - 1) * M.keepPerLv) };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['穿透目标：' + a.count + ' → ' + b.count + ' 个',
            '每次保留：' + pct(a.keep) + ' → ' + pct(b.keep) + ' 伤害'];
  }
});

card({
  id: 'ricochet', kind: 'mol', css: TUNE.MOL.ricochet.css, name: '弹射',
  gain: '每次命中都会向附近敌人弹射',
  cost: '每继续弹射一次，伤害都会降低',
  stat(lv) {
    const M = TUNE.MOL.ricochet;
    if (lv <= 0) return { count: 0, seq: [] };
    const count = M.countAt1 + (lv - 1) * M.countPerLv;
    const seq = [];
    for (let i = 0, k = M.firstKeep; i < count; i++, k *= M.hopDecay) seq.push(k);
    return { count: count, seq: seq };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['弹射次数：' + a.count + ' → ' + b.count,
            '伤害序列：' + b.seq.map(pct).join(' → ')];
  }
});

card({
  id: 'heavy', kind: 'mol', css: TUNE.MOL.heavy.css, name: '重弹',
  gain: '单发伤害大幅提高，直击、爆炸、弹射一起放大',
  cost: '射速降低，并且每枪多消耗 1 发',
  stat(lv) {
    const M = TUNE.MOL.heavy;
    if (lv <= 0) return { dmg: 1, rate: 1 };
    return { dmg: M.dmgAt1 + (lv - 1) * M.dmgPerLv,
             rate: Math.min(M.rateMax, M.rateAt1 + (lv - 1) * M.ratePerLv) };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['所有伤害：' + mul(a.dmg) + ' → ' + mul(b.dmg),
            '射速：' + pct(a.rate) + ' → ' + pct(b.rate) + '，每枪多耗 1 发'];
  }
});

card({
  id: 'overclock', kind: 'mol', css: TUNE.MOL.overclock.css, name: '超频',
  gain: '持续射击时射速不断提高',
  cost: '停火或换弹后重新开始升速',
  stat(lv) {
    const M = TUNE.MOL.overclock;
    if (lv <= 0) return { peak: 0, ramp: 0 };
    return { peak: M.peakAt1 + (lv - 1) * M.peakPerLv,
             ramp: Math.max(M.rampMin, M.rampAt1 + (lv - 1) * M.rampPerLv) };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['峰值射速：+' + pct(a.peak) + ' → +' + pct(b.peak),
            '升满耗时：' + one(b.ramp) + ' 秒持续射击'];
  }
});

card({
  id: 'overflow', kind: 'mol', css: TUNE.MOL_OVERFLOW.css, name: TUNE.MOL_OVERFLOW.name,
  gain: '打死敌人时，超出它剩余生命的那部分伤害转移给附近的敌人',
  cost: '每转移一次都会衰减，而且只有"打过头"才有东西可转',
  stat(lv) {
    const M = TUNE.MOL_OVERFLOW;
    if (lv <= 0) return { keep: 0, hops: 0 };
    return {
      keep: Math.min(M.keepMax, M.keepAt1 + (lv - 1) * M.keepPerLv),
      hops: Math.min(M.hopsMax, M.hopsAt1 + (lv - 1) * M.hopsPerLv)
    };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    /* 等比数列的和写在卡面上 —— 玩家该看得见"这张卡最多能放大多少" */
    const tot = k => k <= 0 ? 0 : k * (1 - Math.pow(k, b.hops)) / (1 - k);
    return ['每次转移保留：' + pct(a.keep) + ' → ' + pct(b.keep),
            '最多转移 ' + b.hops + ' 次，溢出伤害合计最高 ' + mul(tot(b.keep))];
  }
});

card({
  id: 'wallbounce', kind: 'mol', css: TUNE.MOL_WALL.css, name: TUNE.MOL_WALL.name,
  gain: '子弹撞墙不消失，反弹继续飞，而且【反弹之后伤害更高】',
  cost: '和穿透抢同一颗子弹：穿透与反弹哪个先用完，子弹就在那里消失',
  stat(lv) {
    const M = TUNE.MOL_WALL;
    if (lv <= 0) return { count: 0, gain: 1 };
    return { count: M.countAt1 + (lv - 1) * M.countPerLv,
             gain: M.gainAt1 + (lv - 1) * M.gainPerLv };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['反弹次数：' + a.count + ' → ' + b.count,
            '每次反弹后伤害：' + mul(a.gain) + ' → ' + mul(b.gain) +
            '（弹 ' + b.count + ' 次共 ' + mul(Math.pow(b.gain, b.count)) + '）'];
  }
});

/* ============================================================ 七个大玩法选择 */
/* §3：必须改变距离、站位、瞄准、生命风险、弹药风险或目标选择。
   正常游玩必然自动触发的条件，不允许作为大选择。 */

card({
  id: 'close', kind: 'choice', css: TUNE.CHOICE.close.css, name: '贴脸',
  gain: '近距离所有伤害大幅提高',
  cost: '远距离伤害降低',
  stat(lv) {
    const C = TUNE.CHOICE.close;
    if (lv <= 0) return { near: 1, far: 1 };
    return { near: 1 + C.gainPerLv * lv, far: Math.max(C.lossFloor, 1 - C.lossPerLv * lv) };
  },
  line(lv, nx) {
    const C = TUNE.CHOICE.close, a = this.stat(lv), b = this.stat(nx);
    return [C.near + ' 米内：' + mul(a.near) + ' → ' + mul(b.near),
            C.far + ' 米外：' + mul(a.far) + ' → ' + mul(b.far)];
  }
});

card({
  id: 'far', kind: 'choice', css: TUNE.CHOICE.far.css, name: '远射',
  gain: '远距离所有伤害大幅提高',
  cost: '近距离伤害降低',
  stat(lv) {
    const C = TUNE.CHOICE.far;
    if (lv <= 0) return { near: 1, far: 1 };
    return { far: 1 + C.gainPerLv * lv, near: Math.max(C.lossFloor, 1 - C.lossPerLv * lv) };
  },
  line(lv, nx) {
    const C = TUNE.CHOICE.far, a = this.stat(lv), b = this.stat(nx);
    return [C.far + ' 米外：' + mul(a.far) + ' → ' + mul(b.far),
            C.near + ' 米内：' + mul(a.near) + ' → ' + mul(b.near)];
  }
});

card({
  id: 'crit', kind: 'choice', css: TUNE.CHOICE.crit.css, name: '爆头',
  gain: '爆头会放大这次攻击的全部伤害',
  cost: '身体伤害降低',
  stat(lv) {
    const C = TUNE.CHOICE.crit;
    if (lv <= 0) return { head: 1, body: 1 };
    return { head: 1 + C.gainPerLv * lv, body: Math.max(C.lossFloor, 1 - C.lossPerLv * lv) };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['爆头：' + mul(a.head) + ' → ' + mul(b.head) + '（爆炸与弹射一起放大）',
            '身体：' + mul(a.body) + ' → ' + mul(b.body)];
  }
});

card({
  id: 'lowhp', kind: 'choice', css: TUNE.CHOICE.lowhp.css, name: '低血',
  gain: '生命低于阈值时，所有伤害大幅提高',
  cost: '需要主动维持在危险的生命线上',
  stat(lv) {
    if (lv <= 0) return { m: 1 };
    return { m: 1 + TUNE.CHOICE.lowhp.gainPerLv * lv };
  },
  line(lv, nx) {
    const C = TUNE.CHOICE.lowhp, a = this.stat(lv), b = this.stat(nx);
    return ['生命 <' + pct(C.threshold) + ' 时：' + mul(a.m) + ' → ' + mul(b.m),
            '高于阈值时没有收益，但也不额外削弱'];
  }
});

card({
  id: 'root', kind: 'choice', css: TUNE.CHOICE.root.css, name: '站桩',
  gain: '保持不动时伤害持续提高',
  cost: '一旦移动立即清空',
  stat(lv) {
    if (lv <= 0) return { m: 1 };
    return { m: 1 + TUNE.CHOICE.root.gainPerLv * lv };
  },
  line(lv, nx) {
    const C = TUNE.CHOICE.root, a = this.stat(lv), b = this.stat(nx);
    return ['站满时：' + mul(a.m) + ' → ' + mul(b.m) + '（' + one(C.rampTime) + ' 秒攒满）',
            '可以自由转身瞄准，但产生位移就清空'];
  }
});

card({
  id: 'overload', kind: 'choice', css: TUNE.CHOICE.overload.css, name: '双倍装药',
  gain: '这次攻击造成的所有伤害成倍提高',
  cost: '每枪总耗弹翻倍，弹匣打空得更快',
  stat(lv) {
    if (lv <= 0) return { m: 1 };
    return { m: 1 + TUNE.CHOICE.overload.gainPerLv * lv };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['所有伤害：' + mul(a.m) + ' → ' + mul(b.m),
            '每枪总耗弹 ×' + TUNE.CHOICE.overload.ammoMult + '（这部分不可被节弹返还）'];
  }
});

card({
  id: 'pristine', kind: 'choice', css: TUNE.CHOICE.pristine.css, name: TUNE.CHOICE.pristine.name,
  gain: '生命完全满格时，所有伤害提高',
  cost: '掉一点血就立刻失效，必须回满才能恢复',
  stat(lv) {
    if (lv <= 0) return { m: 1 };
    return { m: 1 + TUNE.CHOICE.pristine.gainPerLv * lv };
  },
  line(lv, nx) {
    const a = this.stat(lv), b = this.stat(nx);
    return ['生命 100% 时：' + mul(a.m) + ' → ' + mul(b.m),
            '护盾挡下的伤害不算掉血 —— 护盾流可以一直挂着它'];
  }
});

card({
  id: 'focus', kind: 'choice', css: TUNE.CHOICE.focus.css, name: '专注目标',
  gain: '持续瞄准同一个敌人时，对它的伤害越来越高',
  cost: '换目标就从零开始',
  stat(lv) {
    const C = TUNE.CHOICE.focus;
    if (lv <= 0) return { per: 0, max: 0 };
    return { per: C.perStackPerLv * lv, max: C.perStackPerLv * lv * C.maxStacks };
  },
  line(lv, nx) {
    const C = TUNE.CHOICE.focus, a = this.stat(lv), b = this.stat(nx);
    return ['每层：+' + pct(a.per) + ' → +' + pct(b.per) + '，最高 +' + pct(b.max),
            one(C.resetAfter) + ' 秒没有再命中它就重置'];
  }
});

/* ============================================================ 七个武器小升级 */
/* §4：允许是清楚的数值成长。它们不需要假装成新机制，也不创造奇怪名称。 */

const wup = (id, gain, cost, lineFn) => card({
  id: id, kind: 'wup', css: TUNE.WUP[id].css, name: TUNE.WUP[id].name,
  gain: gain, cost: cost, line: lineFn
});

wup('power', '所有伤害提高', '—', function (lv, nx) {
  const P = TUNE.WUP.power;
  return ['所有伤害：' + mul(Math.pow(1 + P.perLv, lv)) + ' → ' + mul(Math.pow(1 + P.perLv, nx)),
          '直击、爆炸、弹射同时提高'];
});
wup('rate', '基础射速提高', '耗弹与换弹频率自然变快', function (lv, nx) {
  const P = TUNE.WUP.rate;
  return ['基础射速：' + mul(Math.pow(1 + P.perLv, lv)) + ' → ' + mul(Math.pow(1 + P.perLv, nx)),
          '不额外补偿弹药'];
});
wup('mag', '弹匣容量大幅提高', '—', function (lv, nx) {
  const base = TUNE.GUN.magazine, P = TUNE.WUP.mag;
  return ['弹匣：' + Math.ceil(base * (1 + P.perLv * lv)) + ' → ' + Math.ceil(base * (1 + P.perLv * nx)) + ' 发',
          '每枪耗弹越高，这张卡越值钱'];
});
wup('reload', '换弹时间大幅缩短', '有最短换弹时间，不会趋近于零', function (lv, nx) {
  const base = TUNE.GUN.reloadTime, P = TUNE.WUP.reload;
  const at = n => Math.max(P.floor, base * Math.pow(1 - P.perLv, n));
  return ['换弹：' + one(at(lv)) + ' → ' + one(at(nx)) + ' 秒',
          '下限 ' + one(P.floor) + ' 秒'];
});
wup('weak', '爆头伤害提高', '—', function (lv, nx) {
  const base = TUNE.GUN.weakpointMult, P = TUNE.WUP.weak;
  return ['爆头倍率：' + mul(base + P.perLv * lv) + ' → ' + mul(base + P.perLv * nx),
          '与「爆头」大选择相乘'];
});
wup('thrift', '有概率返还这次攻击额外消耗的弹药', '基础必耗的 1 发不返还；双倍装药翻出来的部分也不返还',
  function (lv, nx) {
    const P = TUNE.WUP.thrift;
    const at = n => n <= 0 ? 0 : Math.min(P.cap, P.at1 + (n - 1) * P.perLv);
    return ['返还概率：' + pct(at(lv)) + ' → ' + pct(at(nx)),
            '只作用于多发与重弹产生的额外耗弹'];
  });
wup('opener', '对满血敌人伤害提高', '—', function (lv, nx) {
  const P = TUNE.WUP.opener;
  return ['满血目标：' + mul(1 + P.perLv * lv) + ' → ' + mul(1 + P.perLv * nx),
          '爆炸与弹射打到的满血目标一样算'];
});
wup('killload', '击杀敌人会把弹药装回当前弹匣', '同一枪的返还不超过这枪耗弹的一半',
  function (lv, nx) {
    const P = TUNE.WUP.killload;
    const m = (G.derived && G.derived.magazine) || TUNE.GUN.magazine;
    return ['每次击杀返还：当前弹匣的 ' + pct(P.pctPerLv * lv) + ' → ' + pct(P.pctPerLv * nx) +
            '（现在是 ' + one(P.pctPerLv * nx * m) + ' 发）',
            '爆炸与弹射的击杀一样算'];
  });

/* ==================================================== 九个机动、生存与资源 */
/* §5：与武器卡在同一个三选一池里，但属于小升级。
   它们【不得】成为地图基本路线的通行证 —— 没有它们也要能跑完所有路线。 */

const mup = (id, gain, cost, lineFn) => card({
  id: id, kind: 'mup', css: TUNE.MUP[id].css, name: TUNE.MUP[id].name,
  gain: gain, cost: cost, line: lineFn
});

mup('vigor', '最大生命提高，并立即回满生命', '—', function (lv, nx) {
  const P = TUNE.MUP.vigor, base = TUNE.PLAYER.maxHp;
  const at = n => Math.round(base * (1 + P.pctPerLv * n));
  return ['最大生命：' + at(lv) + ' → ' + at(nx) + '（每级 +' + pct(P.pctPerLv) + '）',
          '拿到的瞬间生命直接回满'];
});
mup('regenshield', '一段时间不受伤后恢复护盾', '受伤后重新计时', function (lv, nx) {
  const P = TUNE.MUP.regenshield;
  return ['护盾上限：' + (P.perLv * lv) + ' → ' + (P.perLv * nx),
          one(P.quiet) + ' 秒不受伤开始恢复'];
});
mup('lifesteal', '近距离击杀恢复生命', '每秒恢复有上限', function (lv, nx) {
  const P = TUNE.MUP.lifesteal;
  return ['每次近距离击杀：+' + (P.perLv * lv) + ' → +' + (P.perLv * nx) + ' 生命',
          P.range + ' 米内，每秒最多 ' + P.capPerSec];
});
mup('dash2', '增加一次冲刺储能', '—', function (lv, nx) {
  return ['冲刺储能：' + (1 + lv) + ' → ' + (1 + nx), '空中冲刺共享同一份储能'];
});
mup('chainmove', '有效跑墙后刷新一次空中冲刺', '每次滞空链最多触发一次', function (lv, nx) {
  return ['跑墙刷新空冲：' + (lv > 0 ? '已有' : '无') + ' → 有', '每次滞空只刷新一次'];
});
mup('slam', '高速落地产生范围伤害和击退', '强度读取真实落地速度', function (lv, nx) {
  const P = TUNE.MUP.slam;
  return ['落地冲击：' + Math.round(P.dmgPerSpeed * lv * 10) + ' → ' + Math.round(P.dmgPerSpeed * nx * 10) + ' 伤害（按落速）',
          '需要落速超过 ' + P.minSpeed + ' m/s，半径 ' + one(P.radius) + ' 米'];
});
mup('wallshield', '跑墙一段距离后获得临时护盾', '护盾有上限', function (lv, nx) {
  const P = TUNE.MUP.wallshield;
  return ['每 ' + P.distance + ' 米跑墙：+' + (P.perLv * lv) + ' → +' + (P.perLv * nx) + ' 护盾',
          '上限 ' + P.max];
});
mup('dashhit', '高速冲刺可以伤害并推开普通敌人', '同一敌人有触发冷却', function (lv, nx) {
  const P = TUNE.MUP.dashhit;
  return ['冲刺撞击：' + (P.perLv * lv) + ' → ' + (P.perLv * nx) + ' 伤害',
          '同一敌人 ' + one(P.cooldown) + ' 秒内只触发一次'];
});
mup('killshield', '击杀获得临时护盾，精英给得更多', '停止击杀后很快衰减', function (lv, nx) {
  const P = TUNE.MUP.killshield;
  return ['每次击杀：+' + (P.perKill * lv) + ' → +' + (P.perKill * nx) + ' 护盾（精英 ×' + P.eliteMult + '）',
          '这部分上限 ' + pct(P.capFrac) + ' 最大生命，且会持续衰减'];
});
mup('overheal', '满血之后的治疗转成护盾，不再浪费', '护盾有上限', function (lv, nx) {
  const P = TUNE.MUP.overheal, base = G.player ? G.player.maxHp : TUNE.PLAYER.maxHp;
  return ['溢出治疗 ×' + P.convert + ' 转为护盾',
          '这部分上限 ' + pct(P.capFrac) + ' 最大生命（现在是 ' + Math.round(base * P.capFrac * nx) + '）'];
});
mup('magnet', '扩大经验、医疗与空投的拾取范围', '—', function (lv, nx) {
  const P = TUNE.MUP.magnet;
  return ['拾取范围：' + mul(1 + P.perLv * lv) + ' → ' + mul(1 + P.perLv * nx), '不改变掉落本身'];
});

/* ================================================================ 五张恶魔卡 */
/* todo12 §2（Bao 设计，Claude 调数值）。
   和上面所有卡的区别只有一条：恶魔卡【必须拿掉一样东西】。
   不是「代价稍大的强卡」—— 是换一把枪，换一种打法。
   所以它们独占第三格，一局最多两张，并且不分级。 */

const demon = (id, name, gain, cost, lineFn) => card({
  id: id, kind: 'demon', css: TUNE.DEMON.css, name: name,
  gain: gain, cost: cost, line: lineFn
});

demon('autoaim', '自动瞄准', '子弹自动追踪准星最近的敌人', '不再能爆头',
  function () {
    return ['子弹自行修正方向，锁定准星最近的目标',
            '所有命中都按身体结算，弱点倍率完全失效'];
  });

demon('drum', '大弹鼓', '弹匣容量 +500%', '换弹时间 +500%',
  function () {
    const D = TUNE.DEMON.drum, d = G.derived || {};
    const m = d.magazine || TUNE.GUN.magazine, r = d.reloadTime || TUNE.GUN.reloadTime;
    return ['弹匣：' + Math.ceil(m) + ' → ' + Math.ceil(m * D.mag) + ' 发',
            '换弹：' + one(r) + ' → ' + one(r * D.reload) + ' 秒'];
  });

demon('glass', '玻璃大炮', '造成的所有伤害 ×3', '受到的所有伤害也 ×3，护盾同样按 ×3 扣',
  function () {
    const D = TUNE.DEMON.glass;
    return ['造成伤害：' + mul(D.out) + '（直击、爆炸、弹射一起）',
            '受到伤害：' + mul(D.in) + '（护盾不减免这个倍率）'];
  });

demon('slug', '独弹', '单发伤害 ×16', '弹匣永远只有 1 发',
  function () {
    const d = G.derived || {};
    const base = d.damage || TUNE.GUN.damage;
    return ['单发伤害：' + Math.round(base) + ' → ' + Math.round(base * TUNE.DEMON.slug.dmg),
            '弹匣固定 1 发 —— 换弹卡从这里开始决定你的 DPS'];
  });

demon('scope', '开镜达人', '开镜时伤害、射速、精度全面提升', '开镜时移速大幅降低；不开镜散布极大',
  function () {
    const D = TUNE.DEMON.scope;
    return ['开镜时：伤害 / 射速 / 精度各 +' + pct(D.gain) + '，移速 ' + mul(D.speed),
            '不开镜时：散布 ' + mul(D.hipSpread) + ' —— 腰射基本打不中'];
  });

demon('rebirth', '恶魔复生', '致死时复活一次并回满生命', '复活后最大生命永久减半，但所有伤害永久翻倍',
  function () {
    const D = TUNE.DEMON.rebirth;
    return ['一局一次：本该死掉的那一刻满血站起来',
            '之后最大生命 ' + mul(D.hpMult) + '、所有伤害 ' + mul(D.dmgMult) + ' —— 这是第二形态，不是保险'];
  });

demon('railgun', '轨道炮', '所有伤害 ×6，无限穿透 —— 一枪贯穿整条街',
  '射速降到 25%，每枪耗弹 ×3',
  function () {
    const D = TUNE.DEMON.railgun;
    return ['伤害 ' + mul(D.dmg) + '，穿透【无限】—— 一条直线上有几只就打几只',
            '射速 ' + pct(D.rate) + '，耗弹 ' + mul(D.ammo) + '：这把枪要你找角度，不要你泼子弹'];
  });

demon('collapse', '坍缩炮', '枪改为蓄力射击：松手打出引力核心，把沿途和落点附近的敌人吸成一堆再坍缩',
  '蓄得越久耗弹越多；不蓄力打不出去',
  function () {
    const D = TUNE.DEMON.collapse;
    return ['蓄力 ' + one(D.minCharge) + '～' + one(D.maxCharge) + ' 秒：' +
            '伤害 ' + mul(D.dmgAt0) + '→' + mul(D.dmgAt1) +
            '　半径 ' + D.radiusAt0 + '→' + D.radiusAt1 + 'm　耗弹 ' + D.ammoAt0 + '→' + D.ammoAt1 + ' 发',
            '射速与超频对这把枪完全失效 —— 它要你选时机，不要你按住不放'];
  });

demon('defer', '延迟清算', '所有伤害先记成紫色的待清算伤害，换弹开始时统一 ×1.5 结算',
  '结算之前敌人不会掉血、不会死、也不给经验',
  function () {
    const D = TUNE.DEMON.defer;
    return ['换弹瞬间把攒下的伤害 ' + mul(D.mult) + ' 一次性兑现',
            '弹匣越大攒得越多，但怪也活得越久；无限弹匣时每 ' +
            one(D.forceEvery) + ' 秒自动结算一次'];
  });

/* ========================================================================== */
/*                                  BUILD                                     */
/* ========================================================================== */

const BUILD = {
  lv: {},
  order: [],            // 获得顺序，HUD 按这个显示
  /* 运行时状态。全部是「读位置 / 读时间」的东西，不参与 derive 的折算。 */
  ctx: {
    ocRamp: 0,          // 超频档位 0~1
    sinceShot: 99,      // 距上一发多久 —— 「持续射击」看它，不看单帧开火
    rootT: 0,           // 站桩已站秒数
    focusId: -1, focusStack: 0, focusT: 0,
    quietT: 0, shield: 0, shieldMax: 0,
    loadFrac: 0,        // 击杀装填的不满一发的零头
    revived: false,     // 恶魔复生是否已经用掉（用掉之后进入第二形态）
    chargeT: 0,         // 坍缩炮已蓄力秒数
    deferT: 0,          // 距上次强制清算多久（无限弹匣时用）
    healSecT: 0, healSec: 0,
    wallDist: 0, chainUsed: false,
    lastPos: { x: 0, z: 0 }
  },
  /* 归因：结算页要能解释伤害来自哪里（§7.2） */
  stats: {},
  /* 保底计数 */
  draws: 0, sinceBig: 0,
  extraLevel: 0, forceBig: false, fourth: false,

  init() {
    this.lv = {}; this.order.length = 0;
    this.draws = 0; this.sinceBig = 0;
    this.extraLevel = 0; this.forceBig = false; this.fourth = false;
    const c = this.ctx;
    c.ocRamp = 0; c.sinceShot = 99; c.rootT = 0; c.focusId = -1; c.focusStack = 0; c.focusT = 0;
    c.quietT = 0; c.shield = 0; c.shieldMax = 0; c.healSecT = 0; c.healSec = 0;
    c.loadFrac = 0; c.revived = false; c.chargeT = 0; c.deferT = 0;
    c.wallDist = 0; c.chainUsed = false;
    this.stats = { direct: 0, corpse: 0, bounce: 0, pierce: 0, overflow: 0,
                   ammoSpent: 0, ammoSaved: 0, reloadT: 0, fireT: 0, kills: 0 };
    return this;
  },

  /* 最大生命只有这一个出口。强心按等级、恶魔复生按第二形态，两者都从
     基线整体重算 —— 谁先谁后都不影响结果，也不会互相把对方抹掉
     （以前强心是「+=」，复活半血之后再拿一次强心就把惩罚抹平了）。 */
  applyMaxHp() {
    const p = G.player;
    if (!p) return;
    const hp = TUNE.PLAYER.maxHp
      * (1 + TUNE.MUP.vigor.pctPerLv * this.level('vigor'))
      * (this.ctx.revived ? TUNE.DEMON.rebirth.hpMult : 1);
    p.maxHp = Math.round(hp);
    p.hp = Math.min(p.hp, p.maxHp);
  },

  /* 恶魔复生：致死那一刻顶回来。返回 true 表示这次死亡被吃掉了。 */
  tryRevive() {
    if (!this.has('rebirth') || this.ctx.revived) return false;
    this.ctx.revived = true;
    this.applyMaxHp();                  // 上限先减半
    G.player.hp = G.player.maxHp;       // 再回满
    G.player.iframe = Math.max(G.player.iframe, 1.6);
    this.ctx.shield = 0;
    recompute();                        // 伤害翻倍在 derive 里兑现
    return true;
  },

  level(id) { return this.lv[id] || 0; },
  has(id) { return (this.lv[id] || 0) > 0; },
  cardOf(id) { return CARD_BY_ID[id]; },
  molecules() { return CARDS.filter(c => c.kind === 'mol' && this.has(c.id)); },
  demons() { return CARDS.filter(c => c.kind === 'demon' && this.has(c.id)); },
  allIds(kind) { return CARDS.filter(c => !kind || c.kind === kind).map(c => c.id); },

  /* 拿到一张卡。大升级 +2 级、小升级 +1 级，没有品质随机（§6.3 改版）。 */
  take(id) {
    const c = CARD_BY_ID[id];
    if (!c) return 0;
    const n = c.levels + this.extraLevel;
    this.extraLevel = 0;
    if (!this.lv[id]) this.order.push(id);
    this.lv[id] = (this.lv[id] || 0) + n;
    this.sinceBig = c.big ? 0 : this.sinceBig + 1;
    if (id === 'vigor') {
      this.applyMaxHp();
      G.player.hp = G.player.maxHp;      // todo12 §3：立即回满，不是只补差额
    }
    G.bus.emit('buildChanged', { id: id, levels: n });
    return n;
  },

  /* ---------------------------------------------------------------- 折算 */
  /* 唯一的一次查表。热路径只读 G.derived（和 todo5 的纪律一致）。
     注意这里【只放不随位置和时间变化的东西】——
     距离、爆头、低血、站桩、专注全部在命中时按受害者重算（§8.2 分类）。 */
  derive(d) {
    const B = TUNE.BUILD;
    const vol = CARD_BY_ID.volley.stat(this.level('volley'));
    const cor = CARD_BY_ID.corpse.stat(this.level('corpse'));
    const wal = CARD_BY_ID.wallbounce.stat(this.level('wallbounce'));
    const pie = CARD_BY_ID.pierce.stat(this.level('pierce'));
    const ric = CARD_BY_ID.ricochet.stat(this.level('ricochet'));
    const hea = CARD_BY_ID.heavy.stat(this.level('heavy'));
    const ovc = CARD_BY_ID.overclock.stat(this.level('overclock'));

    /* 弹丸与耗弹 */
    d.pellets = vol.pellets;
    d.volleyFan = TUNE.MOL.volley.fanDeg;
    let cost = 1 + vol.ammo + (this.has('heavy') ? TUNE.MOL.heavy.ammoExtra : 0);
    if (this.has('railgun')) cost *= TUNE.DEMON.railgun.ammo;
    d.extraAmmo = cost - 1;                    // 节弹只能返还这部分
    if (this.has('overload')) cost *= TUNE.CHOICE.overload.ammoMult;
    d.ammoPerShot = Math.max(1, Math.round(cost));

    /* 伤害：这里只有【武器状态】倍率，位置类的不在这 */
    d.damage = TUNE.GUN.damage
      * hea.dmg
      * Math.pow(1 + TUNE.WUP.power.perLv, this.level('power'))
      * (this.has('overload') ? CARD_BY_ID.overload.stat(this.level('overload')).m : 1)
      * (this.has('glass') ? TUNE.DEMON.glass.out : 1)
      * (this.has('slug') ? TUNE.DEMON.slug.dmg : 1)
      * (this.ctx.revived ? TUNE.DEMON.rebirth.dmgMult : 1)
      * (this.has('railgun') ? TUNE.DEMON.railgun.dmg : 1);
    /* 玻璃大炮的另一半在 hurtPlayer 的第一行 —— 在护盾之前乘，
       所以护盾也按 ×3 被扣掉（Bao 指定）。 */
    d.hurtMult = this.has('glass') ? TUNE.DEMON.glass.in : 1;

    /* 射速：重弹压低、射速卡和超频抬高。超频档位每帧变，所以只给上限，
       实际间隔由 fireInterval + ocRamp 在开火时算。 */
    d.fireInterval = TUNE.GUN.fireInterval
      / Math.pow(1 + TUNE.WUP.rate.perLv, this.level('rate'))
      / hea.rate
      / (this.has('railgun') ? TUNE.DEMON.railgun.rate : 1);
    d.ocPeak = ovc.peak;
    d.ocRampTime = ovc.ramp;

    d.magazine = Math.ceil(TUNE.GUN.magazine * (1 + TUNE.WUP.mag.perLv * this.level('mag'))
      * (this.has('drum') ? TUNE.DEMON.drum.mag : 1));
    d.reloadTime = Math.max(TUNE.WUP.reload.floor,
      TUNE.GUN.reloadTime * Math.pow(1 - TUNE.WUP.reload.perLv, this.level('reload')))
      * (this.has('drum') ? TUNE.DEMON.drum.reload : 1);
    /* 独弹放在最后：弹匣「永远只有 1 发」，大弹鼓也翻不动它。
       两张一起拿就是纯亏 —— 那是玩家自己的选择，不替他挡。 */
    if (this.has('slug')) d.magazine = 1;

    /* 传播 */
    const ovf = CARD_BY_ID.overflow.stat(this.level('overflow'));
    d.overflowKeep = ovf.keep;
    d.overflowHops = ovf.hops;
    /* 轨道炮：无限穿透。用一个够大的数而不是 Infinity ——
       它会进 NaN 守门的 isFinite 检查，Infinity 会被当成坏值换掉。 */
    d.pierce = this.has('railgun') ? 999 : pie.count;
    d.pierceKeep = this.has('railgun') ? Math.max(pie.keep, 1) : pie.keep;
    d.bounce = ric.count;
    d.bounceSeq = ric.seq;

    /* 坍缩炮 / 延迟清算：热路径只读这两个布尔 */
    d.chargeGun = this.has('collapse');
    d.deferOn = this.has('defer');

    /* 尸爆：打死才炸，威力按死者自己的生命算 */
    d.corpsePct = cor.pct;
    d.corpseRadius = cor.radius;

    /* 墙面反弹 */
    d.wallBounce = wal.count;
    d.wallGain = wal.gain;

    /* 弹药循环 */
    d.thrift = this.has('thrift')
      ? Math.min(TUNE.WUP.thrift.cap, TUNE.WUP.thrift.at1 + (this.level('thrift') - 1) * TUNE.WUP.thrift.perLv)
      : 0;
    /* 按【当前弹匣】的百分比返还。放在 d.magazine 之后算，
       所以大弹鼓、弹匣卡堆出来的容量会直接把这张卡变强。 */
    d.killload = TUNE.WUP.killload.pctPerLv * this.level('killload') * d.magazine;

    /* 弱点：小升级加在基础倍率上，「爆头」大选择在命中时再乘 */
    d.weakpointMult = TUNE.GUN.weakpointMult + TUNE.WUP.weak.perLv * this.level('weak');
    /* 自动瞄准的代价：所有命中一律按身体结算。
       和「爆头」大选择【不做互斥】（Bao 决定）—— 两张一起拿只剩身体 ×0.7
       的惩罚，那也是玩家自己选的。 */
    d.noWeak = this.has('autoaim');
    d.homing = this.has('autoaim');

    /* 表现与手感 */
    d.heavyOn = this.has('heavy');
    d.weaponHeavy = this.has('heavy') ? TUNE.MOL.heavy.knock : 1;
    d.bulletScale = this.has('heavy') ? TUNE.MOL.heavy.scale : 1;
    d.knockback = TUNE.GUN.knockback * (this.has('heavy') ? TUNE.MOL.heavy.knock : 1);
    d.spreadBase = TUNE.GUN.spreadBase;
    d.spreadBloom = TUNE.GUN.spreadBloom;
    d.recoil = TUNE.GUN.recoil;

    /* 机动与生存 */
    d.maxHp = G.player ? G.player.maxHp : TUNE.PLAYER.maxHp;
    d.moveSpeed = TUNE.PLAYER.moveSpeed;
    d.dashCooldown = TUNE.PLAYER.dashCooldown;
    d.dashCharges = 1 + TUNE.MUP.dash2.perLv * this.level('dash2');
    d.chainMove = this.has('chainmove');
    d.magnetRadius = TUNE.XP.magnetRadius * (1 + TUNE.MUP.magnet.perLv * this.level('magnet'));
    d.pickupMult = 1 + TUNE.MUP.magnet.perLv * this.level('magnet');

    /* 上限（§8.3：对象与事件，不是伤害预算） */
    d.maxDepth = 2;
    d.eventsPerRoot = B.eventsPerRoot;
    d.hitsPerTarget = B.hitsPerTargetPerRoot;

    /* 老系统留下的开关：V3 不再产出它们，但战斗代码仍会读到 */
    d.infiniteMag = false; d.feedback = 0;
    d.executeBonus = 0; d.traumaHeal = 0; d.hunter = 0; d.searchMult = 1;
    d.momActive = 0; d.aftershock = 0; d.mutDamage = 1; d.mutRadius = 1;

    /* NaN 守门：一个 undefined 乘进来会让整条弹道静默失效（todo5 踩过一次） */
    NUMERIC.forEach(k => {
      if (typeof d[k] === 'number' && !isFinite(d[k])) {
        if (!this._nanWarned) {
          this._nanWarned = true;
          const msg = '派生数值 ' + k + ' 变成了 ' + d[k];
          if (typeof DebugPanel !== 'undefined' && DebugPanel.log) DebugPanel.log('⚠ ' + msg);
          if (G.ui && G.ui.toast) G.ui.toast('内部错误：' + msg, '#ff6a7a', true);
        }
        d[k] = NUMERIC_FALLBACK[k] !== undefined ? NUMERIC_FALLBACK[k] : 0;
      }
    });
    return d;
  },

  /* ------------------------------------------------------------ 护盾池 */
  /* 总上限 = 各来源贡献之和，再被「最大生命 × capFrac」压住。 */
  shieldCap() {
    const M = TUNE.MUP, hp = G.player ? G.player.maxHp : TUNE.PLAYER.maxHp;
    let cap = M.regenshield.perLv * this.level('regenshield');
    if (this.has('wallshield')) cap += M.wallshield.max;
    if (this.has('killshield')) cap += hp * M.killshield.capFrac;
    if (this.has('overheal')) cap += hp * M.overheal.capFrac;
    return Math.min(hp * TUNE.SHIELD.capFrac, cap);
  },
  /* 不会自然衰减的那部分上限。池子高过它才开始掉。 */
  shieldFloor() {
    const M = TUNE.MUP, hp = G.player ? G.player.maxHp : TUNE.PLAYER.maxHp;
    let f = M.regenshield.perLv * this.level('regenshield');
    if (this.has('wallshield')) f += M.wallshield.max;
    if (this.has('overheal')) f += hp * M.overheal.capFrac;
    return Math.min(this.shieldCap(), f);
  },
  addShield(v) {
    if (v <= 0) return 0;
    const c = this.ctx, cap = this.shieldCap();
    const before = c.shield;
    c.shield = Math.min(cap, c.shield + v);
    return c.shield - before;
  },

  /* 开镜程度 0~1。开镜达人的四项收益与两项代价全部按它插值 ——
     不做「开镜=开关」，否则每次抬镜都会看到数值瞬跳。 */
  adsK() {
    return this.has('scope') && typeof WEAPON !== 'undefined' ? WEAPON.pose.ads : 0;
  },

  /* -------------------------------------------------------------- 运行时 */
  tick(dt, p) {
    const c = this.ctx, C = TUNE.CHOICE;

    /* 开镜达人：移速与散布【每帧】变，折进 derive 就是错的（那只在
       recompute 时算一次）。所以在这里覆写 G.derived 的这三个数 ——
       仍然只有 build.js 知道有卡这回事，movement 和 fire 照旧只读 derived。 */
    if (this.has('scope')) {
      const D = TUNE.DEMON.scope, k = this.adsK(), d = G.derived;
      d.moveSpeed = TUNE.PLAYER.moveSpeed * lerp(1, D.speed, k);
      const sp = lerp(D.hipSpread, 1 / (1 + D.gain), k);
      d.spreadBase = TUNE.GUN.spreadBase * sp;
      d.spreadBloom = TUNE.GUN.spreadBloom * sp;
    }

    /* 超频：只改发射频率，不加散布、不加耗弹（Bao：持续按住本身就是代价）。
       「持续射击」不能写成「这一帧开了枪」—— 9 发/秒等于 7 帧才开一次火，
       那样六帧衰减一帧上升，档位永远停在 0。要看的是【距上一发多久】：
       还没到下一发的正常间隔就仍算持续射击。 */
    c.sinceShot += dt;
    if (this.has('overclock')) {
      const gap = Math.max(0.25, this.fireInterval() * 2.2);
      if (c.sinceShot < gap) c.ocRamp = Math.min(1, c.ocRamp + dt / G.derived.ocRampTime);
      else c.ocRamp = Math.max(0, c.ocRamp - dt * TUNE.MOL.overclock.decay / G.derived.ocRampTime);
    } else c.ocRamp = 0;

    /* 站桩：读真实位移，不读输入 —— 被推开、被击退一样算移动 */
    if (this.has('root') && p) {
      const moved = Math.hypot(p.pos.x - c.lastPos.x, p.pos.z - c.lastPos.z) / Math.max(1e-4, dt);
      if (moved > C.root.moveEps) c.rootT = 0;
      else c.rootT += dt;
      c.lastPos.x = p.pos.x; c.lastPos.z = p.pos.z;
    }

    /* 专注：一段时间没再命中就重置 */
    if (c.focusId >= 0) {
      c.focusT += dt;
      if (c.focusT > C.focus.resetAfter) { c.focusId = -1; c.focusStack = 0; }
    }

    /* ---------------------------------------------------- 护盾池（todo13）
       一个池、一个总上限。四个来源只回答两件事：
       往池里加多少【上限】、以什么速度往池里【加值】。
       超出「不衰减来源」的那部分算临时护盾，会掉 —— 目前只有击杀护盾。 */
    c.shieldMax = this.shieldCap();
    const floor = this.shieldFloor();
    const rs = this.level('regenshield');
    if (rs > 0) {
      c.quietT += dt;
      if (c.quietT > TUNE.MUP.regenshield.quiet) c.shield = Math.min(c.shieldMax, c.shield + dt * 12);
    }
    if (c.shield > floor) c.shield = Math.max(floor, c.shield - TUNE.SHIELD.tempDecay * dt);
    if (c.shield > c.shieldMax) c.shield = c.shieldMax;
    /* 近杀回血的每秒上限 */
    c.healSecT += dt;
    if (c.healSecT >= 1) { c.healSecT = 0; c.healSec = 0; }

    /* 跑墙距离：跑墙护盾与地图奖励都读它。
       在这里累计而不是塞进 movement.js —— 机动系统不该知道有卡这回事。 */
    if (p && typeof MOVE !== 'undefined' && MOVE.pose && MOVE.pose.state === 'wallrun') {
      const step = Math.hypot(p.vel.x, p.vel.z) * dt;
      c.wallDist += step;
      c.wallRunSpan = (c.wallRunSpan || 0) + step;
      const W = TUNE.MUP.wallshield, lv = this.level('wallshield');
      if (lv > 0 && c.wallDist >= W.distance) {
        c.wallDist -= W.distance;
        this.addShield(W.perLv * lv);
      }
      if (c.wallRunSpan >= 8) { c.wallRunSpan = 0; G.bus.emit('wallrunDistance', { d: 8 }); }
    }
  },

  /* 机动与生存卡的战斗侧效果。全部挂在事件总线上 ——
     movement.js 不该知道有卡这回事，它只负责发出「落地了」「冲刺了」。 */
  installHooks() {
    G.bus.on('land', e => {
      const lv = this.level('slam');
      if (!lv || !e) return;
      const P = TUNE.MUP.slam;
      const spd = e.fall || 0;
      if (spd < P.minSpeed) return;
      /* 强度读【真实落地速度】，不是固定值 —— 从多高摔下来是玩家的决定 */
      const dmg = P.dmgPerSpeed * lv * spd;
      areaDamage(G.player.pos, P.radius, dmg, makeAttack('slam'), 'slam');
      R.ring(G.player.pos, 1, P.radius, 0xff9a3c, 0.5);
      Audio2.blast(G.player.pos, true);
    });

    G.bus.on('dash', () => {
      const lv = this.level('dashhit');
      if (!lv) return;
      const P = TUNE.MUP.dashhit, c = this.ctx, p = G.player;
      c.dashHitT = c.dashHitT || {};
      const list = enemiesInRadius(p.pos.x, p.pos.z, 2.4, _dashBuf);
      list.forEach(e => {
        if (e.dead || e.boss) return;
        if ((c.dashHitT[e.uid] || 0) > G.time) return;   // 同一敌人有触发冷却
        c.dashHitT[e.uid] = G.time + P.cooldown;
        damageEnemy(e, P.perLv * lv, makeAttack('dashhit'), { point: e.pos });
        const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
        const d2 = Math.max(0.01, Math.hypot(dx, dz));
        e.knock.x += dx / d2 * P.push; e.knock.z += dz / d2 * P.push;
      });
    });
  },

  /* 实际开火间隔：超频在这里兑现（§8.1 第 9 步） */
  fireInterval() {
    const d = G.derived;
    return d.fireInterval / (1 + (d.ocPeak || 0) * this.ctx.ocRamp)
                          / (1 + TUNE.DEMON.scope.gain * this.adsK());
  },

  onFire(cost) {
    this.ctx.sinceShot = 0;
    this.stats.ammoSpent += cost;
  },
  onReloadStart() {
    this.ctx.ocRamp = 0; this.ctx.sinceShot = 99;
    /* 延迟清算就在这一刻兑现（todo13 G08）。挂在这里而不是挂在
       「换弹结束」上：玩家按下 R 的那一下就该看到紫色伤害一起炸出来，
       等 1.5 秒换完再结算，因果关系就断了。 */
    if (G.derived.deferOn) settleDeferred();
  },
  onHurt() { this.ctx.quietT = 0; },

  /* ------------------------------------------------- §8.2 两类伤害倍率 */
  /* 读【武器状态】的，整根攻击共享：威力、重弹、双倍装药 —— 已经折进 d.damage。
     读【位置与目标】的，每个受害者各自重算：距离、爆头、低血、站桩、专注。
     这条分界线是一句话规则，卡面也解释得通，不需要玩家理解攻击图。 */
  victimMul(e, weak) {
    let m = 1;
    const c = this.ctx, C = TUNE.CHOICE, p = G.player;

    /* 距离：贴脸与远射各自一条曲线，互斥就互斥（Bao 已确认不折中） */
    if (this.has('close') || this.has('far')) {
      const dist = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      if (this.has('close')) {
        const s = CARD_BY_ID.close.stat(this.level('close'));
        m *= dist <= C.close.near ? s.near
           : dist >= C.close.far ? s.far
           : lerp(s.near, s.far, (dist - C.close.near) / (C.close.far - C.close.near));
      }
      if (this.has('far')) {
        const s = CARD_BY_ID.far.stat(this.level('far'));
        m *= dist >= C.far.far ? s.far
           : dist <= C.far.near ? s.near
           : lerp(s.near, s.far, (dist - C.far.near) / (C.far.far - C.far.near));
      }
    }

    /* 爆头：整次攻击家族一起放大 —— 爆炸和弹射继承这一份 */
    if (this.has('crit')) {
      const s = CARD_BY_ID.crit.stat(this.level('crit'));
      m *= weak ? s.head : s.body;
    }

    /* 低血：只读当前生命比例，护盾和治疗不偷偷改判定 */
    if (this.has('lowhp') && p.hp / p.maxHp < C.lowhp.threshold) {
      m *= CARD_BY_ID.lowhp.stat(this.level('lowhp')).m;
    }

    /* 站桩：持续提升、有上限的状态，不是「静止一下强化下一发」 */
    if (this.has('root')) {
      const t = Math.max(0, c.rootT - C.root.delay);
      const k = Math.min(1, t / C.root.rampTime);
      m *= 1 + (CARD_BY_ID.root.stat(this.level('root')).m - 1) * k;
    }

    /* 开门枪：只看目标是不是满血。没有代价那一面 ——
       在 ×10 怪量下「对受伤敌人打折」根本触发不到，等于假代价。 */
    if (this.has('opener') && e.hp >= e.maxHp) {
      m *= 1 + TUNE.WUP.opener.perLv * this.level('opener');
    }

    /* 无伤压制：生命满格才有。护盾扛住的伤害不算掉血，
       所以「护盾流永远满血」是这条链成立的地方，不是漏洞。 */
    if (this.has('pristine') && p.hp >= p.maxHp) {
      m *= CARD_BY_ID.pristine.stat(this.level('pristine')).m;
    }

    /* 开镜达人：伤害那一项和站桩同类 —— 读【此刻的玩家状态】，
       所以放在这里按受害者重算，不折进 derive（§8.2 的分界线）。 */
    if (this.has('scope')) m *= 1 + TUNE.DEMON.scope.gain * this.adsK();

    /* 专注：只对当前专注目标生效 */
    if (this.has('focus') && e.id === c.focusId) {
      m *= 1 + CARD_BY_ID.focus.stat(this.level('focus')).per * c.focusStack;
    }
    return m;
  },

  /* 专注目标由【准星指向】决定，不是「子弹碰到谁」。
     多发一开一枪 21 次命中，用「碰到谁」目标会每帧乱跳，层数永远攒不起来。 */
  aimAt(e) {
    if (!this.has('focus') || !e) return;
    const c = this.ctx, C = TUNE.CHOICE.focus;
    if (e.id === c.focusId) {
      c.focusStack = Math.min(C.maxStacks, c.focusStack + 1);
    } else {
      c.focusId = e.id; c.focusStack = 1;
    }
    c.focusT = 0;
  },

  /* 击杀装填：返还上限跟着本枪耗弹缩放，永远填不满弹匣。 */
  onKill(e, closeKill) {
    this.stats.kills++;
    const g = G.player.gun;
    if (this.has('killload') && g) {
      const root = G.curRoot;
      /* 上限是【这一枪耗弹的一半】，可以是小数 —— 取整到 1 发的话，
         耗弹 1 发的枪每杀一个就回半个弹匣，这张卡会直接变成无限弹药。 */
      const cap = G.derived.ammoPerShot * 0.5;
      if (root && (root.refunded || 0) < cap) {
        const back = Math.min(G.derived.killload, cap - (root.refunded || 0));
        root.refunded = (root.refunded || 0) + back;
        /* 浮点累加：一次击杀可能只值 0.9 发，攒够整发才进弹匣，
           零头留在 loadFrac 里，不做四舍五入吞掉。 */
        const c = this.ctx;
        c.loadFrac += back;
        const whole = Math.floor(c.loadFrac);
        if (whole > 0) {
          c.loadFrac -= whole;
          g.ammo = Math.min(G.derived.magazine, g.ammo + whole);
        }
        this.stats.ammoSaved += back;
      }
    }
    /* 击杀护盾：精英给得多。「精英」= Boss / 变种 / 高经验模板，
       和结算页对「精英」的口径一致，不另立标准。 */
    if (this.has('killshield')) {
      const P = TUNE.MUP.killshield;
      const elite = e.boss || e.variant || (e.tpl && e.tpl.xp >= 20);
      this.addShield(P.perKill * this.level('killshield') * (elite ? P.eliteMult : 1));
    }

    if (this.has('lifesteal') && closeKill) {
      const P = TUNE.MUP.lifesteal, c = this.ctx;
      const heal = Math.min(P.perLv * this.level('lifesteal'), P.capPerSec - c.healSec);
      if (heal > 0) {
        c.healSec += heal;
        healPlayer(heal);
      }
    }
  },

  /* 节弹：只返还多发与重弹产生的额外耗弹。
     双倍装药翻出来的那一半不可返还 —— 否则它的代价就被退掉一大半。 */
  thriftBack(cost) {
    const d = G.derived;
    if (!d.thrift || !d.extraAmmo) return 0;
    let back = 0;
    for (let i = 0; i < d.extraAmmo; i++) if (RNG.fx.next() < d.thrift) back++;
    if (back) this.stats.ammoSaved += back;
    return back;
  },

  /* ------------------------------------------------------------ 三选一 */
  /* §6.2 玩家永远只看到同一种三选一。没有「大升级 / 小升级 / 地图升级」三个界面。 */
  candidates() {
    const B = TUNE.BUILD;
    this.draws++;
    const n = this.fourth ? 4 : 3;
    this.fourth = false;

    /* 第 1 次固定三张不同分子 —— 一上来就得先决定这局是什么枪 */
    if (this.draws === 1 && B.firstDrawAllMolecules) {
      return RNG.evo.sample(CARDS.filter(c => c.kind === 'mol'), n).map(c => this._offer(c));
    }

    const molCount = this.molecules().length;
    const pool = [];
    CARDS.forEach(c => {
      if (c.kind === 'demon') return;        // 恶魔卡只走下面那条独立通道
      let w = c.kind === 'mol' ? 3.2 : c.kind === 'choice' ? 2.4 : c.kind === 'wup' ? 2.0 : 1.5;
      /* 已有 4 个分子后新分子权重下降，但不锁死 —— 幸运局可以继续扩展 */
      if (c.kind === 'mol' && !this.has(c.id) && molCount >= B.moleculeSoftCap) w *= B.moleculeSoftWeight;
      /* 高耗弹时抬高弹药循环卡：提供，但不强制玩家选 */
      if (G.derived && G.derived.ammoPerShot >= B.ammoBiasAtCost &&
          (c.id === 'mag' || c.id === 'reload' || c.id === 'thrift' || c.id === 'killload')) {
        w *= B.ammoBiasMult;
      }
      pool.push({ c: c, w: w });
    });

    /* 保底：只托底，不封顶。
       武器侧的下限是【每一次都至少有一张】，不是「连续 N 次没有才补」——
       实测 400 局里有 21 局出现过「三张全是机动生存卡」的发牌，
       那一次玩家的武器成长直接归零，而他自己都说不清为什么后面打不动。 */
    const forceBig = this.forceBig || this.sinceBig >= B.bigEveryDraws ||
      (molCount < 2 && this.draws >= B.secondMoleculeByDraw);
    this.forceBig = false;

    const out = [];
    const pick = filter => {
      const sub = pool.filter(x => filter(x.c) && !out.some(o => o.card.id === x.c.id));
      if (!sub.length) return false;
      let t = 0; sub.forEach(x => t += x.w);
      let r = RNG.evo.next() * t;
      for (const x of sub) { r -= x.w; if (r <= 0) { out.push(this._offer(x.c)); return true; } }
      out.push(this._offer(sub[sub.length - 1].c));
      return true;
    };
    if (molCount < 2 && this.draws >= B.secondMoleculeByDraw) pick(c => c.kind === 'mol' && !this.has(c.id));
    else if (forceBig) pick(c => c.big);
    if (!out.some(o => o.kind !== 'mup')) pick(c => c.kind !== 'mup');
    while (out.length < n) if (!pick(() => true)) break;

    /* todo12 §2：恶魔卡独占【第三格】，前两格照常走保底。
       换掉最后一格而不是多给一格 —— 三选一永远是三选一，
       而且拿恶魔卡的代价里必须包含「放弃这一格本来会出的东西」。 */
    const dm = this._demon();
    if (dm && out.length >= 3) out[2] = dm;
    return out;
  },

  /* 已拿到的恶魔卡数量 */
  demonCount() { return this.demons().length; },

  /* 这一次发牌要不要塞一张恶魔卡。拿过的不再出现（它们不分级）。 */
  _demon() {
    const D = TUNE.DEMON;
    /* Debug 的「恶魔卡必出」只解开投放条件，不改卡的效果（todo13） */
    const cheat = typeof DebugPanel !== 'undefined' && DebugPanel.demonAll;
    if (!cheat) {
      if (G.time < D.fromTime || this.demonCount() >= D.maxPerRun) return null;
      if (!RNG.evo.chance(D.chance)) return null;
    }
    const left = CARDS.filter(c => c.kind === 'demon' && !this.has(c.id));
    if (!left.length) return null;
    return this._offer(left[Math.floor(RNG.evo.next() * left.length)]);
  },

  _offer(c) {
    const lv = this.level(c.id);
    const nx = lv + c.levels + this.extraLevel;
    return {
      id: c.id, card: c, name: c.name, css: c.css, kind: c.kind, big: c.big,
      gain: c.gain, cost: c.cost, lines: c.line(lv, nx),
      levelText: c.kind === 'demon' ? '恶魔 · 改写规则'
        : lv > 0 ? ('Lv' + lv + ' → Lv' + nx) : ('新增 · Lv' + nx)
    };
  },

  /* HUD：只显示分子名与等级，不显示任何组合名（§7.2） */
  hudText() {
    return this.order.filter(id => CARD_BY_ID[id].kind === 'mol' || CARD_BY_ID[id].kind === 'demon')
      .map(id => CARD_BY_ID[id].kind === 'demon' ? CARD_BY_ID[id].name
                                                 : CARD_BY_ID[id].name + ' Lv' + this.lv[id]).join('  ');
  },
  /* 大玩法选择的实时状态：距离、低血、站桩层数、专注层数、超频档位 */
  stateText() {
    const c = this.ctx, out = [];
    if (this.has('overclock')) out.push('超频 ' + Math.round(c.ocRamp * 100) + '%');
    if (this.has('root')) {
      const C = TUNE.CHOICE.root;
      out.push('站桩 ' + Math.round(Math.min(1, Math.max(0, c.rootT - C.delay) / C.rampTime) * 100) + '%');
    }
    if (this.has('focus') && c.focusStack) out.push('专注 ×' + c.focusStack);
    if (this.has('lowhp')) {
      out.push('低血 ' + (G.player.hp / G.player.maxHp < TUNE.CHOICE.lowhp.threshold ? '激活' : '未激活'));
    }
    return out.join('  ');
  }
};

const _dashBuf = [];
const NUMERIC = ['damage', 'fireInterval', 'magazine', 'reloadTime', 'ammoPerShot', 'pellets',
  'pierce', 'bounce', 'corpseRadius', 'corpsePct', 'wallBounce', 'wallGain', 'bulletScale', 'knockback',
  'weakpointMult', 'volleyFan', 'ocPeak', 'ocRampTime', 'pierceKeep',
  'hurtMult', 'killload', 'overflowKeep', 'overflowHops'];
const NUMERIC_FALLBACK = {
  damage: TUNE.GUN.damage, fireInterval: TUNE.GUN.fireInterval, magazine: TUNE.GUN.magazine,
  reloadTime: TUNE.GUN.reloadTime, ammoPerShot: 1, pellets: 1, pierce: 0, bounce: 0,
  corpseRadius: 0, corpsePct: 0, wallBounce: 0, wallGain: 1, bulletScale: 1, knockback: TUNE.GUN.knockback,
  weakpointMult: TUNE.GUN.weakpointMult, volleyFan: 0, ocPeak: 0, ocRampTime: 1, pierceKeep: 1,
  hurtMult: 1, killload: 0, overflowKeep: 0, overflowHops: 0
};
