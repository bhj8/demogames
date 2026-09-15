// Compare both render paths in the same frozen runtime. No project dependency added.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const sharp=require(process.env.SHARP_MODULE||'sharp');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
  await page.goto((process.argv[2]||'http://127.0.0.1:8765')+'/?seed=12345');
  await page.evaluate(()=>{
   window.requestAnimationFrame=()=>0;G.phase='pause';
   for(const id of ['menu','pause','debug','cards'])document.getElementById(id).style.display='none';
   G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
   G.player.pos.set(0,0,0);G.player.yaw=Math.PI/2;
   R.camera.position.set(0,1.65,0);R.camera.rotation.set(0,Math.PI/2,0,'YXZ');
   WEAPON.update(.016,{vel:new THREE.Vector3(),yawDelta:0,pitchDelta:0,ammo:30,magazine:30,overclock:0,conductCharge:0,stableLevel:0});
   // Preload armor atlases as well as all fifteen designs.
   Object.keys(ENEMY_ATLAS).forEach(id=>ENEMY_ART.texture(id));
  });
  await page.waitForFunction(()=>Object.values(ENEMY_ART.textures).every(t=>t.image&&t.image.complete),null,{polling:100});
  const comparisons=[];
  for(let group=0;group<6;group++){
   await page.evaluate(group=>{
    G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
    const templates=[...Object.values(ENEMIES),...MUTATIONS.map(m=>variantTemplate(m.id))];
    for(let i=0;i<3;i++){
     const index=group*3+i,tpl=index<15?templates[index]:variantTemplate('ossify');
     const e=G.enemies.get();configureEnemy(e,tpl,new THREE.Vector3(-5,0,(i-1)*2.6));
     if(index>=15)e.plates=index-15;
     e.grp.rotation.y=Math.PI/2+[0,Math.PI/2,Math.PI][i];e.body.frustumCulled=false;
     e.state=['charge','windup','idle'][i];e.grp.rotation.x=i===1?.09:0;
     e.bodyMat.userData.gait.motion.value=.7;
     if(i===0){e.bodyMat.emissive.setHex(0x8b2211);e.bodyMat.emissiveIntensity=.6;}
     if(i===1)ENEMY_ART.setTheme(e,'ossify');
    }
    G.time=12.345;R._artTime=G.time;
   },group);
   const buffers=[],counts=[];
   for(const batching of [false,true]){
    counts.push(await page.evaluate(batching=>{
     ENEMY_ART.batching=batching;R.renderer.info.autoReset=false;R.renderer.info.reset();R.render();
     return {calls:R.renderer.info.render.calls,triangles:R.renderer.info.render.triangles};
    },batching));
    const buffer=await page.screenshot({path:path.join(__dirname,`runtime/group-${group}-${batching?'batch':'individual'}.png`)});
    buffers.push(await sharp(buffer).removeAlpha().raw().toBuffer());
   }
   let changed=0,max=0,sum=0;
   for(let i=0;i<buffers[0].length;i+=3){let pixel=0;for(let c=0;c<3;c++){const d=Math.abs(buffers[0][i+c]-buffers[1][i+c]);max=Math.max(max,d);sum+=d;pixel=Math.max(pixel,d);}if(pixel>2)changed++;}
   const result={group,individual:counts[0],batch:counts[1],pixelsOverTwoLevels:changed,maxChannelDelta:max,meanChannelDelta:sum/buffers[0].length};
   comparisons.push(result);
   assert.ok(changed<1440*900*.001,JSON.stringify(result));
  }
  const behavior=await page.evaluate(()=>{
   const check=(v,s)=>{if(!v)throw Error(s);};
   const empty=()=>{G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();};
   const count=()=>Object.values(ENEMY_ART.batches).reduce((n,b)=>n+b.mesh.count,0);
   const spawn=(x)=>{const e=G.enemies.get();configureEnemy(e,ENEMIES.grunt,new THREE.Vector3(x,0,0));e.body.frustumCulled=true;return e;};
   empty();spawn(-6);spawn(6);R.render();check(count()===1,'cull behind camera');
   R.camera.rotation.y=-Math.PI/2;R.render();check(count()===1,'camera reversal');
   R.camera.rotation.y=Math.PI/2;
   empty();const a=spawn(-6),b=spawn(-8);R.render();
   const batch=ENEMY_ART.batches.grunt,capacity=batch.capacity;batch.capacity=1;R.render();
   check(batch.mesh.count===1&&[a,b].filter(e=>e.body.visible).length===1,'capacity fallback');batch.capacity=capacity;
   configureEnemy(a,variantTemplate('ossify'),a.pos.clone());a.plates=0;R.render();
   check(ENEMY_ART.batches['ossify-zero'].mesh.count===1&&batch.mesh.count===1,'pooled atlas migration');
   empty();R.render();check(count()===0,'released batches empty');
   const density=[];
   for(const mixed of [false,true]){
    empty();const templates=[...Object.values(ENEMIES),...MUTATIONS.map(m=>variantTemplate(m.id))];
    for(let i=0;i<900;i++){const e=G.enemies.get();configureEnemy(e,mixed?templates[i%templates.length]:ENEMIES.grunt,new THREE.Vector3(-5-Math.floor(i/12)*1.05,0,(i%12-5.5)*.7));e.body.frustumCulled=false;e.grp.rotation.y=Math.PI/2;}
    for(const batching of [false,true]){ENEMY_ART.batching=batching;R.renderer.info.reset();R.render();density.push({mixed,batching,calls:R.renderer.info.render.calls,triangles:R.renderer.info.render.triangles});}
   }
   return {checks:['frustum culling','camera reversal','capacity fallback','pooled atlas migration','released batches empty'],density};
  });
  await page.screenshot({path:path.join(__dirname,'runtime/mixed-900.png')});
  assert.deepEqual(errors,[]);
  const report={pass:true,viewport:[1440,900],comparisons,...behavior,errors};
  fs.writeFileSync(path.join(__dirname,'comparison.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
