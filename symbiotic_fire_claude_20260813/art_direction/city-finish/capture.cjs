const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('fs'),path=require('path');
(async()=>{const b=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});try{
 const p=await b.newPage({viewport:{width:1440,height:900}});
 await p.goto('http://127.0.0.1:8765/?seed=12345');
 await p.evaluate(()=>{window.requestAnimationFrame=()=>0;G.phase='pause';for(const id of ['menu','pause','debug','cards'])document.getElementById(id).style.display='none';G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();WEAPON.update(.016,{vel:new THREE.Vector3(),yawDelta:0,pitchDelta:0,ammo:30,magazine:30,overclock:0,conductCharge:0,stableLevel:0});});
 const views=[['shops',[-56,1.65,-5],[-60,3,-25]],['garage',[12,1.65,-7],[45,7,-32]],['office',[-15,1.65,7],[-55,13,40]],['construction',[55,1.65,7],[55,8,39]]];
 for(const [name,pos,target]of views){await p.evaluate(({pos,target})=>{R.camera.position.fromArray(pos);R.camera.lookAt(new THREE.Vector3(...target));R.render();},{pos,target});await p.screenshot({path:path.join(__dirname,'runtime',name+'.png')});}
 await p.evaluate(()=>{G.player.pos.set(0,0,0);G.player.yaw=Math.PI/2;R.camera.position.set(0,1.65,0);R.camera.rotation.set(0,Math.PI/2,0,'YXZ');['grunt','heavy','spitter'].forEach((id,i)=>{const e=G.enemies.get();configureEnemy(e,ENEMIES[id],new THREE.Vector3(-6,0,(i-1)*2.7));e.grp.rotation.y=Math.PI/2;});});
 await p.waitForFunction(()=>Object.values(ENEMY_ART.textures).every(t=>t.image),null,{polling:100});await p.evaluate(()=>R.render());await p.screenshot({path:path.join(__dirname,'runtime/street.png')});
 await p.evaluate(()=>{G.enemies.live[0].state='melee';G.enemies.live[1].state='windup';G.enemies.live[2].state='spit';G.time+=.2;R.render();});await p.screenshot({path:path.join(__dirname,'runtime/anticipation.png')});
 if(process.argv.includes('--shots-only'))return;
 const q=await b.newPage();await q.goto('http://127.0.0.1:8765/_scalecheck.html');await q.waitForFunction(()=>document.title.includes('RESULT>>'),null,{polling:100});const scale=await q.title();
 if(process.argv.includes('--baseline')){
  const cp=require('child_process');
  for(const name of ['city-scale.js','citymap.js','enemy-art.js','tune.js']){
   const body=cp.execFileSync('git',['show','5a48fda:symbiotic_fire_claude_20260813/js/'+name],{encoding:'utf8'});
   await q.route('**/js/'+name,r=>r.fulfill({contentType:'application/javascript',body}));
  }
 }
 await q.goto('http://127.0.0.1:8765/_movecheck.html',{waitUntil:'commit'});
 await q.waitForFunction(()=>document.title.includes('RESULT>>'),null,{timeout:240000,polling:1000});
 const result={scale,movement:await q.title(),details:await q.locator('#out').innerText(),errors:await q.evaluate(()=>window.__err)};
 fs.writeFileSync(path.join(__dirname,process.argv.includes('--baseline')?'movement-baseline.json':'movement-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
