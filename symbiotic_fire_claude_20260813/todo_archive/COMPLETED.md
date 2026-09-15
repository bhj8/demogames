# Completed And Superseded Work

This is a compact index of work that should not remain in the active TODO.

## Completed Gameplay Systems

- Rear-threat warning chain: approach warning, attack windup warning, and damage
  direction feedback.
- Adaptive medical drops and semi-dynamic tactical airdrops.
- Weakpoint/headshot collision rewrite and readable hit feedback.
- Weapon presentation layer: viewmodel rig, recoil split, reload phases, shells,
  bullet streaks, hit markers, and module-driven gun feedback.
- City-scale movement: dash, air dash, slide, wall run, climb, zipline, route
  grammar, and continuous momentum.
- City-scale combat layout: large readable blocks, combat cells, layered spawn
  pressure, anti-camp pressure, transfer pressure, and hotspot migration.
- Build V3: six core molecules plus unified attack rules, replacing the earlier
  recipe-table build system.
- Demon cards and follow-up gameplay cards through `todo13`.
- Corpse explosion replacing old hit-triggered explosion.
- Overflow/corpse-explosion self-sustaining reaction fix.
- Magnet drops for pulling scattered XP back to the player.
- Ricochet support for walls and the world ground plane.
- Debug panel improvements through the latest committed state.

## Superseded Directions

- The old 70x70 vertical city from `todo3` was replaced by the larger city-scale
  map direction.
- The old separate mutation popup flow was folded into the later unified
  evolution/build flow.
- The todo5 S/A recipe matrix and named pair-combo system were replaced by
  Build V3's molecule-plus-rule model.
- Runtime rollback switches and old-system compatibility paths were deliberately
  removed; git history is the rollback path.

## Still Active Elsewhere

Anything that still needs action has been moved into `../TODO.md`. In particular:

- current README/test command cleanup;
- Windows verification path repair;
- Bao's manual playtest checklist;
- evolution pacing and boss/demon-card tuning after playtest;
- visual-production handoff after the separate art branch is ready.
