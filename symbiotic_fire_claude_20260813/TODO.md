# SYMBIOTIC FIRE · Active TODO

> Scope: `symbiotic_fire_claude_20260813`.
> Last organized: 2026-09-15.
> Historical completed plans live in `todo_archive/`.

This is the only active TODO for the 2026-08-13 FPS survivor demo. Old `todo*.md`
files are design history, implementation records, or superseded plans; do not use
them as live work queues.

## Current State

- The demo is a Three.js browser prototype, not a Godot project.
- The latest committed gameplay branch has completed the main implementation
  chain through `todo13`: supply loop, threat warnings, gun feel, city movement,
  Build V3, demon cards, corpse explosion, overflow fixes, magnet drops, and
  ricochet-on-ground.
- The open work is no longer broad feature implementation. It is consolidation,
  verification, playtest judgment, tuning, and visual-production handoff.
- Art optimization is being handled separately; do not mix its code changes into
  this TODO cleanup branch.

## P0 · Make Project State Trustworthy

- [ ] Update `README.md` so file lists and rerun commands match the current code.
      It still references removed files such as `js/weapon-modules.js`,
      `js/attack-graph.js`, and `js/module-pool.js`; the current equivalents are
      `js/build.js` and `js/attack.js`.
- [ ] Either repair or retire `testsim_evo.js`. It currently loads removed
      todo5-era files, so `node testsim_evo.js` fails before doing useful work.
- [ ] Fix `_stability.js` dependency discovery for Windows. It currently assumes
      Playwright at `/opt/node22/lib/node_modules/playwright`, which does not
      exist on this machine.
- [ ] Document one current verification path that works on Bao's Windows machine:
      browser check pages, `_stability.js`, or a replacement script. The command
      must not depend on stale Linux paths.
- [ ] Re-run the automatic checks after the above fixes and record the fresh
      results in `README.md`.

## P0 · Bao Playtest Checklist

These are intentionally not checked by automation. They need human eyes, ears,
and hands.

- [ ] City readability: does it feel like a city, do the large buildings read as
      large, are main routes visible, and does going high change combat instead
      of just pausing combat?
- [ ] Movement feel: basic movement, dash, slide, wall run, climb, zipline, and
      chained movement should feel clearly smoother than the old small-map scale.
- [ ] Combat readability: within three seconds, can a player tell what their gun
      changed into after upgrades?
- [ ] Build readability: after one run, can the player describe the weapon in
      ordinary language without opening implementation notes?
- [ ] Enemy readability: can the player distinguish normal, weakpoint, armor,
      elite, variant, and boss threats under high density?
- [ ] Audio mix: gunshots, hit confirmation, weakpoint, kill confirmation, and
      derived effects should all remain audible without becoming noise.
- [ ] Ten-run feel test: different builds should feel meaningfully different,
      not just numerically different.

## P1 · Gameplay Tuning After Playtest

- [ ] Decide whether evolution pacing should convert stronger play into more
      builds. Current self-calibrating XP pricing can cancel extra XP; this
      especially affects `精英世界` because XP x2.5 may not create more upgrades.
- [ ] Tune `EVOLUTION.rateWeight` or the XP anchor only after Bao decides the
      intended pacing: stable build count versus reward for higher kill output.
- [ ] Tune middle boss and final boss HP. Existing values were implementation
      guesses and need real 12-minute playtest judgment.
- [ ] Revisit late-game density only after the above pacing decision. Do not hide
      pacing problems by changing spawn numbers first.
- [ ] Check whether demon cards are tempting enough as rule rewrites, especially
      `开镜达人`, `轨道炮`, `坍缩炮`, `延迟清算`, `捕食代谢`, and `精英世界`.

## P1 · Debug And Test UX

- [ ] Make debug panel entry and useful test buttons obvious in the README:
      `F1`, `?debug=1`, force demon card, pure build, instant death, spawn tests,
      gun feel checks, and any current playtest route.
- [ ] Add or document a focused manual test route for gun feel: static targets,
      no-spread gun, slow motion if available, reload phase checks, and weakpoint
      feedback checks.
- [ ] Record what automation can prove versus what Bao must judge. The old TODOs
      repeatedly mix those two, which makes "done" look less done than it is.

## P2 · Visual Production Handoff

Do not work this section while the separate art-optimization task owns visual
code. Use it only after that branch/worktree is ready to merge or review.

- [ ] Pick the visual direction Bao wants to continue.
- [ ] Build one playable vertical slice before replacing everything: base gun,
      one normal enemy, one variant enemy, one street segment, one route marker,
      and one card treatment.
- [ ] Validate the slice in fixed before/after screenshots, grayscale enemy
      silhouette checks, high-density readability, and frame cost.
- [ ] Confirm weakpoint and armor visuals still align with actual hit logic after
      enemy shape changes.

## Archived

- Completed and superseded TODO documents are in `todo_archive/`.
- `todo_archive/COMPLETED.md` summarizes what is considered done.
- If a new issue is found while reading an archived file, copy it into this file
  as a new active item instead of editing the archive.
