# VOID PROTOCOL: Reference Load — Full Campaign

This is the complete original VOID PROTOCOL browser campaign, preserved as the playable foundation and extended with one focused systemic experiment: every shot can rewrite who an enemy references.

**Playable build:** https://void-protocol-reference-load.bhj.chatgpt.site

## Complete campaign retained

- 3 procedural blocks and 18 total passes
- 14 fault/enemy types, including the multi-part final UNREFERENCED encounter
- 7 weapons, upgrades, ammo economy, pickups, shop, anchor defense, death/revive, minimap, terrain traversal, ending, and debug controls
- Local Three.js runtime; no CDN dependency

## Reference Load system

- A hit transfers that enemy's target from the Anchor to the player.
- Red target links mean the enemy is attacking the Anchor; cyan links mean it references the player.
- Load is weighted: common 1, elite 2, boss 4.
- Carried load raises HEAP rewards: 2 → ×1.2, 4 → ×1.5, 7 → ×2.0, 10 → ×2.5.
- The multiplier applies only when the defeated enemy is actively targeting the player.
- Player death immediately sends all references back to the Anchor and carries no hidden currency penalty.
- Prep/shop screens predict the next pass composition; one-time diagnostic cards teach all 14 fault rules.

## Controls

- WASD — move
- Space — jump
- Mouse — aim; left click fire; right click aim
- Shift — sprint
- R — reload
- 1–7 / wheel — switch weapon
- E near Anchor — open BUILD
- Backtick — debug panel

## Run

Open `index.html` through a local static server. The runtime is vendored at `vendor/three.min.js`.

For example:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/void_protocol_reference_load_gpt_20260812/`.
