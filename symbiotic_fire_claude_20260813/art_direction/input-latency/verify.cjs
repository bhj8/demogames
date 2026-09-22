const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.argv[2]||'http://127.0.0.1:8765';
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true});
 try{
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
 await page.addInitScript(()=>{
  window.__rafRequests=0;const raf=requestAnimationFrame;window.requestAnimationFrame=fn=>{window.__rafRequests++;return raf(fn);};
 });
 await page.goto(base+'/?seed=12345&v=20260922-input-2',{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>ENEMY_ART.ready);
 const preparation=await page.evaluate(()=>({prepared:ENEMY_ART.prepared,batches:Object.keys(ENEMY_ART.batches).length,failed:Object.values(ENEMY_ART.batches).filter(b=>b.failed||!b.checked).length,enabled:!document.getElementById('start').disabled}));
 assert.deepEqual(preparation,{prepared:true,batches:18,failed:0,enabled:true});
 const result=await page.evaluate(()=>{
  window.requestAnimationFrame=()=>0;
  Object.defineProperty(document,'pointerLockElement',{configurable:true,get:()=>R.renderer.domElement});
  R.renderer.domElement.requestPointerLock=()=>{};
  let scheduled=0;window.requestAnimationFrame=()=>{scheduled++;return 0;};
  const start=document.getElementById('start');start.click();start.click();
  if(scheduled!==1)throw Error('Duplicate main loops: '+scheduled);
  G.enemies.live.slice().forEach(e=>G.enemies.release(e));G.enemies.compact();
  G.player.yaw=0;G.player.pitch=0;G.player.camRecoil={yaw:0,pitch:0,vp:0,vy:0};
  G.shakePitch=G.shakeRoll=G.shakeX=G.shakeZ=0;MOVE.pose.tilt=0;Director.update=()=>{};updateTimeline=()=>{};
  const samples=[];
  for(const [x,y] of [[20,10],[-40,-15],[0,0],[8,4]]){
   const yaw=G.player.yaw-x*TUNE.PLAYER.mouseSens,pitch=G.player.pitch-y*TUNE.PLAYER.mouseSens;
   dispatchEvent(new MouseEvent('mousemove',{movementX:x,movementY:y}));
   if(Math.abs(G.player.yaw-yaw)>1e-9||Math.abs(G.player.pitch-pitch)>1e-9)throw Error('Input delayed or sensitivity changed');
   frame(last+1000/60);
   const actual=R.camera.getWorldDirection(new THREE.Vector3()),expected=new THREE.Vector3(0,0,-1).applyEuler(new THREE.Euler(pitch,yaw,0,'YXZ'));
   if(actual.distanceTo(expected)>1e-6)throw Error('Camera trails input');
   samples.push({x,y,directionError:actual.distanceTo(expected)});
  }
  if(G._loopErr)throw G._loopErr;
  return {samples,singleStartLoop:true};
 });
 assert.deepEqual(errors,[]);
 const report={pass:true,preparation,...result,errors};
 fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
