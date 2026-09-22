const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});
 try{
 const results=[];
 for(const count of [5,150,900]){
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  await page.goto('http://127.0.0.1:8765/?seed=12345');
  await page.waitForFunction(()=>Object.values(ENEMY_ART.textures).every(t=>t.image?.complete));
  await page.evaluate(()=>ENEMY_ART.ready);
  results.push(await page.evaluate(async count=>{
   const timings={},wrap=(obj,key)=>{const fn=obj[key];obj[key]=function(...args){const start=performance.now();try{return fn.apply(this,args);}finally{(timings[key]??=[]).push(performance.now()-start);}};};
   for(const [obj,key] of [[R,'render'],[ENEMY_ART,'renderBatches'],[ENEMY_ART,'makeBatch'],[R.renderer,'compile'],[UI,'update']])wrap(obj,key);
   const oldEnemies=updateEnemies;updateEnemies=function(dt){const start=performance.now();oldEnemies(dt);(timings.enemies??=[]).push(performance.now()-start);};
   G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
   const templates=[...Object.values(ENEMIES),...MUTATIONS.map(m=>variantTemplate(m.id))];
   for(let i=0;i<count;i++){const e=G.enemies.get();configureEnemy(e,templates[i%templates.length],new THREE.Vector3(-8-Math.floor(i/12)*1.05,0,(i%12-5.5)*.7));}
   G.player.pos.set(0,0,0);G.player.yaw=Math.PI/2;G.phase='play';G.paused=false;DebugPanel.god=true;DebugPanel.freezeEvents=true;Director.update=()=>{};updateTimeline=()=>{};
   const gl=R.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
   const env={attributes:gl.getParameter(gl.MAX_VERTEX_ATTRIBS),varyings:gl.getParameter(gl.MAX_VARYING_VECTORS),batch:ENEMY_ART.canBatch(R.renderer),gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown'};
   const intervals=[];let prev=0,steps=0;
   await new Promise(resolve=>{
    // frame normally schedules itself; use just this one benchmark loop.
    const raf=requestAnimationFrame;window.requestAnimationFrame=()=>0;
    function loop(now){if(prev)intervals.push(now-prev);prev=now;G.player.yaw=Math.PI/2+Math.sin(steps*.025)*.3;frame(now);if(++steps>=180){window.requestAnimationFrame=raf;resolve();}else raf(loop);}
    raf(loop);
   });
   const stats=a=>{const sorted=a.slice().sort((a,b)=>a-b);return {n:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,p95:sorted[Math.floor(a.length*.95)],max:sorted.at(-1)};};
   return {count,env,frames:stats(intervals),timings:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,stats(v)])),live:G.enemies.live.length,error:String(G._loopErr||'')};
  },count));
  await page.close();
 }
 fs.writeFileSync(path.join(__dirname,(process.argv[2]||'before')+'.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
