// Uses the existing local Playwright installation; no project dependency added.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.argv[2]||'http://127.0.0.1:8765';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
  await page.goto(base+'/?seed=12345');
  await page.evaluate(()=>{
   window.requestAnimationFrame=()=>0;G.phase='pause';
   for(const id of ['menu','pause','debug','cards'])document.getElementById(id).style.display='none';
   G.player.pos.set(0,0,0);G.player.yaw=Math.PI/2;
   R.camera.position.set(0,1.65,0);R.camera.rotation.set(0,Math.PI/2,0,'YXZ');
   G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
   const templates=[...Object.values(ENEMIES),...MUTATIONS.map(m=>variantTemplate(m.id))];
   templates.forEach((tpl,i)=>{const e=G.enemies.get();configureEnemy(e,tpl,new THREE.Vector3(-6-Math.floor(i/3)*6,0,(i%3-1)*2.7));e.grp.rotation.y=Math.PI/2;});
  });
  await page.waitForFunction(()=>Object.values(ENEMY_ART.textures).every(t=>t.image&&t.image.complete),null,{polling:100});
  const report=await page.evaluate(()=>{
   const check=(v,s)=>{if(!v)throw Error(s);};
   const kinds=new Set(G.enemies.live.map(e=>e.artKind));check(kinds.size===15,'15 distinct enemy designs');
   for(const e of G.enemies.live){
    check(Array.from(e.body.geometry.attributes.position.array).every(Number.isFinite),'finite geometry');
    for(const [angle,view,flip] of [[0,0,0],[Math.PI/2,1,0],[Math.PI,2,0],[-Math.PI/2,1,1]]){
     const camera={position:new THREE.Vector3(e.pos.x+Math.sin(angle)*3,2,e.pos.z+Math.cos(angle)*3)};
     e.grp.rotation.y=0;e.artView=-1;ENEMY_ART.sync(e,camera);
     check(e.artView===view,'view '+e.artKind);check(e.bodyMat.userData.directional.flip.value===flip,'mirror '+e.artKind);
    }
    e.grp.rotation.y=Math.PI/2;
   }
   const e=G.enemies.live.find(e=>e.artKind==='ossify'),hp=e.hp,plateStates=[];
   for(let p=2;p>=0;p--){damageEnemy(e,10,null,{fromFront:true,weakpoint:false});ENEMY_ART.sync(e,R.camera);plateStates.push(e.bodyMat.userData.directional.plates.value);check(e.plates===p&&e.hp===hp,'armor break '+p);check(e.bodyMat.map===ENEMY_ART.textures[['ossify-zero','ossify-bare','ossify-two'][p]],'armor texture '+p);}
   configureEnemy(e,ENEMIES.grunt,e.pos.clone());ENEMY_ART.sync(e,R.camera);
   check(e.bodyMat.userData.directional.bone.value===0&&e.bodyMat.map===ENEMY_ART.textures.grunt,'pool material reset');
   check(e.bodyMat.userData.directional.themeOn.value===0,'pool theme reset');
   const solids=CITY.solids.length;
   MUTATIONS.forEach(m=>WEAPON.setOrgan(m.id,true));
   G.phase='play';G.paused=false;DebugPanel.god=true;
   const shots=WEAPON.stats.shots;fire();check(WEAPON.stats.shots>shots,'fire');
   G.player.gun.ammo=1;tryReload();check(WEAPON.reload.active,'reload start');
   let magOut=false,handOut=false;
   for(let i=0;i<150;i++){frame(last+1000/60);magOut ||= !WEAPON.parts.magazine.visible;handOut ||= !WEAPON.parts.supportHand.visible;}
   check(!G._loopErr,'loop: '+G._loopErr);
   check(G.player.gun.ammo===G.derived.magazine&&!WEAPON.reload.active,'reload end');
   check(magOut&&handOut&&WEAPON.parts.supportHand.visible,'weapon animation');
   check(G.enemies.live.some(e=>e.bodyMat.userData.gait.motion.value>0),'moving gait');
   G.phase='pause';
   const empty=()=>{G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();};
   empty();R.render();check(R.contactShadows.count===0,'released shadows');
   const density=[];R.renderer.info.autoReset=false;
   for(const count of [120,900]){
    empty();for(let i=0;i<count;i++){const e=G.enemies.get();configureEnemy(e,ENEMIES.grunt,new THREE.Vector3(-5-Math.floor(i/12)*1.05,0,(i%12-5.5)*.7));e.grp.rotation.y=Math.PI/2;e.body.frustumCulled=false;}
    R.renderer.info.reset();R.render();check(R.contactShadows.count===count,'shadow instances');
    density.push({enemies:count,calls:R.renderer.info.render.calls,triangles:R.renderer.info.render.triangles});
   }
   check(CITY.solids.length===solids,'unchanged collision world');
   const gl=R.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
   return {pass:true,kinds:[...kinds],plateStates,solids,density,geometryTriangles:ENEMY_ART.geometry().index.count/3,
    textures:Object.keys(ENEMY_ART.textures).length,renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown',
    checks:['15 assets loaded','front/right/back/left directions','3 armor hits preserve HP and remove plates','pooled material reset','fire/reload/weapon animation','moving gait','shadow pooling','120/900 render stress','unchanged collision world']};
  });
  await page.screenshot({path:path.join(__dirname,'runtime/stress-900.png')});
  const regression=await browser.newPage();await regression.goto(base+'/_todo13check.html');
  await regression.waitForFunction(()=>/ALLPASS|FAILED \d/.test(document.body.innerText),null,{timeout:30000});
  report.regression=(await regression.locator('body').innerText()).includes('ALLPASS');assert.equal(report.regression,true);
  assert.deepEqual(await regression.evaluate(()=>window.__err),[]);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
