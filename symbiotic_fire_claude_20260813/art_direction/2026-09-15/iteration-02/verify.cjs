// Uses an existing Playwright installation; does not install project dependencies.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.argv[2] || 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
    await page.goto(url + '/?seed=12345');
    const report = await page.evaluate(() => {
      const check = (v, message) => { if (!v) throw new Error(message); };
      window.requestAnimationFrame = () => 0;
      G.phase = 'pause';
      for (const id of ['menu', 'pause', 'debug', 'cards']) document.getElementById(id).style.display = 'none';
      G.player.pos.set(0, 0, 0); G.player.yaw = Math.PI / 2;
      R.camera.position.set(0, 1.65, 0); R.camera.rotation.set(0, Math.PI / 2, 0, 'YXZ');
      const solids = CITY.solids.length;
      const empty = () => { G.enemies.live.slice().forEach(e => G.enemies.release(e)); G.enemies.compact(); };
      empty();
      const templates = [ENEMIES.grunt, ENEMIES.heavy, ENEMIES.spitter, ENEMIES.charger,
        ENEMIES.midboss, ENEMIES.king, ...MUTATIONS.map(m => variantTemplate(m.id))];
      templates.forEach((tpl, i) => {
        const e = G.enemies.get();
        configureEnemy(e, tpl, new THREE.Vector3(-9 - Math.floor(i / 3) * 6, 0, (i % 3 - 1) * 3));
        e.grp.rotation.y = Math.PI / 2; e.body.frustumCulled = false;
        check(Array.from(e.body.geometry.attributes.position.array).every(Number.isFinite), tpl.id + ' geometry');
      });
      MUTATIONS.forEach(m => WEAPON.setOrgan(m.id, true));
      R.render();
      check(Object.values(WEAPON.organs).filter(o => o.visible).length === 6, 'six organs');
      G.phase = 'play'; G.paused = false; DebugPanel.god = true;
      const shots = WEAPON.stats.shots; fire(); check(WEAPON.stats.shots > shots, 'shot');
      G.player.gun.ammo = 1; tryReload(); check(WEAPON.reload.active, 'reload start');
      let sawMagOut = false, sawSupportHidden = false;
      for (let i = 0; i < 150; i++) {
        frame(last + 1000 / 60);
        sawMagOut ||= !WEAPON.parts.magazine.visible;
        sawSupportHidden ||= !WEAPON.parts.supportHand.visible;
      }
      check(!G._loopErr, 'loop error: ' + G._loopErr);
      check(G.player.gun.ammo === G.derived.magazine && !WEAPON.reload.active, 'reload end');
      check(sawMagOut && sawSupportHidden && WEAPON.parts.supportHand.visible, 'animated weapon parts');
      check(G.enemies.live.some(e => e.bodyMat.userData.gait.motion.value > 0), 'walking animation');
      const shaderPrograms = R.renderer.info.programs.length;
      G.phase = 'pause';
      empty(); R.render(); check(R.contactShadows.count === 0, 'pooled shadow removal');
      const stress = count => {
        empty();
        for (let i = 0; i < count; i++) {
          const e = G.enemies.get();
          configureEnemy(e, ENEMIES.grunt, new THREE.Vector3(-5 - Math.floor(i / 12) * 1.05, 0, (i % 12 - 5.5) * 0.7));
          e.grp.rotation.y = Math.PI / 2; e.body.frustumCulled = false;
        }
        R.renderer.info.autoReset = false; R.renderer.info.reset(); R.render();
        check(R.contactShadows.count === count, 'shadow instances');
        return { enemies: count, calls: R.renderer.info.render.calls, triangles: R.renderer.info.render.triangles };
      };
      const density = [stress(120), stress(900)];
      check(CITY.solids.length === solids, 'collision count');
      const gl = R.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { pass: true, solids, shaderPrograms, density,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
        checks: ['all enemy meshes compile', 'six organs', 'fire', 'reload', 'support hand', 'gait', 'shadow pooling', '120 / 900 enemies'] };
    });
    await page.screenshot({ path: path.join(__dirname, 'stress-900.png') });
    const regression = await browser.newPage();
    await regression.goto(url + '/_todo13check.html');
    await regression.waitForFunction(() => /ALLPASS|FAILED \d/.test(document.body.innerText), null, { timeout: 30000 });
    report.regression = (await regression.locator('body').innerText()).includes('ALLPASS');
    assert.equal(report.regression, true);
    assert.deepEqual(await regression.evaluate(() => window.__err), []);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(__dirname, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
