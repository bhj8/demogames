const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const fs=require('node:fs'),path=require('node:path');
const out=process.argv[2]||__dirname,label=process.argv[3]||'production-current';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[],resources=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text().slice(0,1500));});
 page.on('requestfailed',r=>errors.push(r.url()+': '+r.failure()?.errorText));
 page.on('response',r=>{if(r.url().includes('/assets/enemies/'))resources.push({url:r.url(),status:r.status(),type:r.headers()['content-type']});if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(r.status()+' '+r.url());});
 await page.goto('https://baohongjiang.com/demogames/symbiotic_fire_claude_20260813/?v=20260922-input-2',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>typeof G!=='undefined'&&G.player,null,{timeout:60000});
 try{await page.waitForFunction(()=>Object.values(ENEMY_ART.textures).every(t=>t.image?.complete&&t.image.naturalWidth>0),null,{timeout:30000});}catch(_){}
 await page.evaluate(()=>ENEMY_ART.ready);
 const state=await page.evaluate(()=>{
  window.requestAnimationFrame=()=>0;G.phase='pause';
  for(const id of ['menu','pause','debug','cards'])document.getElementById(id).style.display='none';
  G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
  G.player.pos.set(0,0,0);G.player.yaw=Math.PI/2;
  R.camera.position.set(0,1.65,0);R.camera.rotation.set(0,Math.PI/2,0,'YXZ');
  WEAPON.update(.016,{vel:new THREE.Vector3(),yawDelta:0,pitchDelta:0,ammo:30,magazine:30,overclock:0,conductCharge:0,stableLevel:0});
  for(let i=0;i<3;i++){const e=G.enemies.get();configureEnemy(e,ENEMIES.grunt,new THREE.Vector3(-5,0,(i-1)*2.3));e.grp.rotation.y=Math.PI/2;}
  R.render();const gl=R.renderer.getContext();
  return {hasVisibilityFix:typeof ENEMY_ART.fallbackGeometry==='function',sounds:Object.values(SOUND.bank?.sounds||{}).flat().length,textures:Object.entries(ENEMY_ART.textures).map(([id,t])=>({id,width:t.image?.naturalWidth,complete:t.image?.complete})),batches:Object.entries(ENEMY_ART.batches).map(([id,b])=>({id,count:b.mesh.count})),attributes:gl.getParameter(gl.MAX_VERTEX_ATTRIBS)};
 });
 await page.screenshot({path:path.join(out,label+'.png')});
 const report={state,resources,errors};fs.writeFileSync(path.join(out,label+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
