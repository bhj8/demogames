# Void Protocol: Reference Load

A standalone WebGL FPS prototype created from the PlaySense review of the original VOID PROTOCOL demo.

**Playable build:** https://void-protocol-reference-load.bhj.chatgpt.site

## Core hypothesis

Shooting is not only damage. Hitting an enemy transfers its target from the Anchor to the player. Carrying more active references protects the Anchor and increases the HEAP reward multiplier, but concentrates danger on the player.

## What is implemented

- Six-pass 8–12 minute validation structure.
- Explicit red Anchor targets and cyan player references.
- Weighted Reference Load with ×1.00–×2.50 risk rewards.
- PLACEHOLDER, LOD0, MAGENTA and SLEEPER teaching beats.
- Three between-pass weapon patches.
- HIGH POLY final boss with visible render-budget recovery.
- Player death returns every reference to the Anchor without a hidden currency penalty.
- Local event telemetry in `localStorage["void-protocol-telemetry"]`.

## Controls

- WASD: move
- Mouse: aim
- Left click: fire
- R: reload
- Shift: sprint
- Escape: release mouse / pause

## Run locally

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

This directory is self-contained and does not depend on the other games in the repository.
