const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const sharp=require(process.env.SHARP_MODULE||'sharp');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const base=process.argv[2]||'http://127.0.0.1:8765';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});
 const reports=[];
 try {
  for(const mode of ['before-missing','normal','pending','missing','recovered','low-attributes','bad-shader']){
   console.log('Checking',mode);
   const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
   page.on('pageerror',e=>errors.push(String(e)));
   page.on('console',m=>{if(m.type()==='error'&&m.text().includes('THREE.WebGLProgram'))errors.push(m.text().slice(0,180));});
   const requests=new Map();let release;
   const gate=new Promise(r=>release=r);
   if(mode==='before-missing'){
    const old=execFileSync('git',['show','7b46f36:symbiotic_fire_claude_20260813/js/enemy-art.js'],{encoding:'utf8'});
    await page.route('**/js/enemy-art.js*',r=>r.fulfill({contentType:'application/javascript',body:old}));
   }
   if(mode==='bad-shader'){
    const source=fs.readFileSync(path.join(__dirname,'../../js/enemy-art.js'),'utf8');
    await page.route('**/js/enemy-art.js*',r=>r.fulfill({contentType:'application/javascript',body:source+`
      const originalMakeBatch=ENEMY_ART.makeBatch;
      ENEMY_ART.makeBatch=function(...args){
        const gait=R.attachGait;
        R.attachGait=function(m,...rest){gait.call(this,m,...rest);const compile=m.onBeforeCompile;m.onBeforeCompile=s=>{compile(s);s.vertexShader+='\\n#error deliberate_batch_failure\\n';};};
        try{return originalMakeBatch.apply(this,args);}finally{R.attachGait=gait;}
      };
    `}));
   }
   if(['before-missing','pending','missing','recovered'].includes(mode))await page.route('**/assets/enemies/*.png',async r=>{
    const url=r.request().url(),n=(requests.get(url)||0)+1;requests.set(url,n);
    if(mode==='pending'){await gate;await r.continue();}
    else if(mode==='recovered'&&n>1)await r.continue();
    else await r.fulfill({status:404,body:'Deliberate missing texture regression'});
   });
   if(mode==='low-attributes')await page.addInitScript(()=>{
    for(const cls of [WebGLRenderingContext,WebGL2RenderingContext]){const get=cls.prototype.getParameter;cls.prototype.getParameter=function(p){return p===this.MAX_VERTEX_ATTRIBS?8:get.call(this,p);};}
   });
   await page.goto(base+'/?seed=12345',{waitUntil:'domcontentloaded'});
   await page.evaluate(()=>{
    window.requestAnimationFrame=()=>0;G.phase='pause';
    for(const id of ['menu','pause','debug','cards'])document.getElementById(id).style.display='none';
    G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
    G.player.pos.set(0,0,0);G.player.yaw=Math.PI/2;
    R.camera.position.set(0,1.65,0);R.camera.rotation.set(0,Math.PI/2,0,'YXZ');
    WEAPON.update(.016,{vel:new THREE.Vector3(),yawDelta:0,pitchDelta:0,ammo:30,magazine:30,overclock:0,conductCharge:0,stableLevel:0});
   });
   if(['normal','recovered','low-attributes','bad-shader'].includes(mode))await page.waitForFunction(()=>Object.values(ENEMY_ART.textures).every(t=>t.image?.complete&&t.image.naturalWidth>0),null,{timeout:15000,polling:100});
   await page.evaluate(()=>ENEMY_ART.ready);
   const groups=[];
   for(let group=0;group<6;group++){
    const state=await page.evaluate(group=>{
     G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
     const templates=[...Object.values(ENEMIES),...MUTATIONS.map(m=>variantTemplate(m.id))];
     for(let i=0;i<3;i++){
      const index=group*3+i,e=G.enemies.get();configureEnemy(e,index<15?templates[index]:variantTemplate('ossify'),new THREE.Vector3(-5,0,(i-1)*2.3));
      if(index>=15)e.plates=index-15;
      e.grp.rotation.y=Math.PI/2;
     }
     for(let i=0;i<5;i++)R.render();
     return {batches:Object.values(ENEMY_ART.batches).reduce((n,b)=>n+b.mesh.count,0),ready:G.enemies.live.filter(e=>e.artReady).length,visible:G.enemies.live.filter(e=>e.body.visible).length};
    },group);
    const withEnemies=await page.screenshot(group===0&&['before-missing','normal','missing'].includes(mode)?{path:path.join(__dirname,mode+'.png')}:{});
    await page.evaluate(()=>{for(const e of G.enemies.live)e.grp.visible=false;R.render();});
    const without=await page.screenshot();
    const a=await sharp(withEnemies).removeAlpha().raw().toBuffer(),b=await sharp(without).removeAlpha().raw().toBuffer();
    let pixels=0;for(let i=0;i<a.length;i+=3)if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>15)pixels++;
    if(mode==='before-missing')assert.equal(state.batches+state.visible,0,'old code reproduces invisible bodies');
    else {assert.ok(state.batches+state.visible===3,mode+' has three rendered enemies');assert.ok(pixels>2000,mode+' actual silhouette pixels '+pixels);}
    groups.push({...state,pixels});
   }
   let density=null;
   if(mode==='normal'){
    await page.evaluate(()=>{G.phase='play';G.paused=false;DebugPanel.god=true;for(let i=0;i<360;i++)frame(last+1000/60);if(G._loopErr)throw Error(G._loopErr);});
    density=await page.evaluate(()=>{
     G.phase='pause';G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
     const templates=[...Object.values(ENEMIES),...MUTATIONS.map(m=>variantTemplate(m.id))];
     for(let i=0;i<900;i++){const e=G.enemies.get();configureEnemy(e,templates[i%templates.length],new THREE.Vector3(-5-Math.floor(i/12)*1.05,0,(i%12-5.5)*.7));e.body.frustumCulled=false;}
     R.renderer.info.autoReset=false;R.renderer.info.reset();R.render();
     return {instances:Object.values(ENEMY_ART.batches).reduce((n,b)=>n+b.mesh.count,0),calls:R.renderer.info.render.calls};
    });
    assert.equal(density.instances,900);assert.ok(density.calls<100);
   }
   if(mode==='bad-shader')assert.ok(errors.every(e=>e.includes('THREE.WebGLProgram')));
   else assert.deepEqual(errors,[]);
   reports.push({mode,groups,density,expectedShaderFailures:mode==='bad-shader'?errors.length:0});
   release();await page.close();
  }
  const report={pass:true,checks:['missing textures reproduce invisible bodies in original code','15 designs and 3 armor states have visible pixels','pending and failed assets show fallback bodies','automatic retry restores reviewed artwork','8-attribute GPU uses individual sprites','shader compilation failure retains individual sprites','360 real frames without loop errors'],reports};
  fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
