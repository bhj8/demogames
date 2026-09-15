// Existing local Playwright; exercises the real browser mixer and game hooks.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=process.argv[2]||'http://127.0.0.1:8765',out=__dirname;
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_EXE,headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('404'))errors.push(m.text());});
  page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(r.status()+' '+r.url());});
  await page.goto(base+'/_audio-art.html');
  await page.evaluate(()=>SOUND.loading);
  const rendered=await page.evaluate(async()=>{
   window.AudioContext=function(){return new OfflineAudioContext(2,44100*10,44100);};
   Audio2.init();
   while(SOUND.stats.loads<76)await new Promise(r=>setTimeout(r,20));
   Audio2.setListener({x:0,y:0,z:0},{x:0,y:0,z:-1},{x:0,y:1,z:0});
   const c=Audio2.ctx;
   const events=[{time:.05,fn:()=>SOUND.play('city_air')},
    {time:2,fn:()=>Audio2.magOut()},{time:2.55,fn:()=>Audio2.magIn()},{time:2.9,fn:()=>Audio2.boltPull()},
    {time:3.4,fn:()=>Audio2.telegraph({x:-5,y:0,z:-4},'charge')},
    {time:4,fn:()=>Audio2.blast({x:5,y:0,z:-4},true)},
    {time:4.6,fn:()=>Audio2.weakConfirm(true)},{time:5.1,fn:()=>Audio2.pickup('med')},
    {time:5.8,fn:()=>Audio2.mutation()}];
   for(let i=0;i<12;i++)events.push({time:.3+i*.11,fn:()=>{Audio2.shot(1,1,.11);if(i%3===0)Audio2.hit();}});
   // Saturate all channels at maximum user volume: bound voices and output peak.
   for(let i=0;i<10;i++)events.push({time:7+i*.12,fn:()=>{
    for(const k of Object.keys(SOUND.levels))SOUND.setLevel(k,1);
    for(let j=0;j<25;j++)for(const id of Object.keys(SOUND.cues))SOUND.play(id);
   }});
   for(const e of events)c.suspend(e.time).then(()=>{e.fn();c.resume();});
   const b=await c.startRendering();let peak=0,energy=0;
   const wav=new ArrayBuffer(44+b.length*4),v=new DataView(wav);
   const s=(offset,text)=>{for(let i=0;i<text.length;i++)v.setUint8(offset+i,text.charCodeAt(i));};
   s(0,'RIFF');v.setUint32(4,36+b.length*4,true);s(8,'WAVE');s(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,2,true);v.setUint32(24,44100,true);v.setUint32(28,176400,true);v.setUint16(32,4,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,b.length*4,true);
   for(let i=0;i<b.length;i++)for(let ch=0;ch<2;ch++){const x=b.getChannelData(ch)[i];peak=Math.max(peak,Math.abs(x));energy+=x*x;v.setInt16(44+(i*2+ch)*2,Math.round(Math.max(-1,Math.min(1,x))*32767),true);}
   let binary='';const bytes=new Uint8Array(wav);for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   return {wav:btoa(binary),peak,rms:Math.sqrt(energy/(b.length*2)),stats:SOUND.stats,remaining:SOUND.voices.size};
  });
  fs.writeFileSync(path.join(out,'mix-review.wav'),Buffer.from(rendered.wav,'base64'));delete rendered.wav;
  assert.ok(rendered.peak<.99);assert.ok(rendered.rms>.005);assert.ok(rendered.stats.maxVoices<=42);assert.deepEqual(rendered.stats.failed,[]);
  // Direction is checked with the actual spatial branch, independently of the mix.
  const direction=[];
  for(const x of [-6,6]){
   await page.reload();await page.evaluate(()=>SOUND.loading);
   direction.push(await page.evaluate(async x=>{
    window.AudioContext=function(){return new OfflineAudioContext(2,44100*2,44100);};Audio2.init();
    while(SOUND.stats.loads<76)await new Promise(r=>setTimeout(r,20));
    Audio2.setListener({x:0,y:0,z:0},{x:0,y:0,z:-1},{x:0,y:1,z:0});SOUND.play('incoming',{pos:{x,y:0,z:-4},variant:0});
    const b=await Audio2.ctx.startRendering(),energy=[];for(let ch=0;ch<2;ch++){let s=0;for(const x of b.getChannelData(ch))s+=x*x;energy.push(s);}return {x,left:energy[0],right:energy[1]};
   },x));
  }
  assert.ok(direction[0].left>direction[0].right*2);assert.ok(direction[1].right>direction[1].left*2);
  await page.goto(base+'/?seed=12345');await page.evaluate(()=>{window.requestAnimationFrame=()=>0;Audio2.init();Audio2.resume();});
  await page.waitForFunction(()=>SOUND.stats.loads===76,null,{polling:50});
  const runtime=await page.evaluate(async()=>{
   const check=(v,s)=>{if(!v)throw Error(s);};
   // Every cue must have two decoded variants and load without errors.
   check(Object.keys(SOUND.bank.sounds).length===38,'38 cue families');
   for(const id of Object.keys(SOUND.cues)){check(SOUND.bank.sounds[id].length===2,'variants '+id);SOUND.last[id]=-Infinity;check(SOUND.play(id),'sample '+id);}
   for(const v of SOUND.voices)SOUND.stop(v);await new Promise(r=>setTimeout(r,50));check(SOUND.voices.size===0,'stop cleanup');
   SOUND.last={};SOUND.update(.016,true);check([...SOUND.voices].some(v=>v.id==='city_air'),'ambient starts');
   const velocity=G.player.vel.clone(),grounded=MOVE.pose.grounded;MOVE.pose.grounded=true;G.player.vel.set(6,0,0);SOUND.stepDistance=2.2;SOUND.update(.03,true);
   check([...SOUND.voices].some(v=>v.id==='step'),'movement footstep');SOUND.grounded=false;SOUND.update(.016,true);check([...SOUND.voices].some(v=>v.id==='land'),'landing transition');
   G.player.vel.copy(velocity);MOVE.pose.grounded=grounded;SOUND.update(.016,false);check(SOUND.voices.size===0,'pause cleanup');
   G.phase='play';G.paused=false;DebugPanel.god=true;const before=SOUND.stats.played;
   fire();G.player.gun.ammo=1;tryReload();for(let i=0;i<160;i++)frame(last+1000/60);
   check(!G._loopErr,'runtime loop');check(!WEAPON.reload.active,'reload complete');check(SOUND.stats.played>before,'real game sample hooks');
   G.paused=true;SOUND.update(.016,false);
   let osc=0;const original=Audio2.ctx.createOscillator.bind(Audio2.ctx);Audio2.ctx.createOscillator=()=>{osc++;return original();};
   const bank=SOUND.bank;SOUND.bank=null;Audio2.dryClick();SOUND.bank=bank;check(osc>0,'missing-bank fallback');Audio2.ctx.createOscillator=original;
   SOUND.setLevel('master',.34);check(JSON.parse(localStorage.getItem('symbiotic.audio.v1')).master===.34,'persist volume');
   SOUND.setLevel('master',0);await new Promise(r=>setTimeout(r,150));check(Audio2.master.gain.value<.002,'mute all buses');
   return {pass:true,loads:SOUND.stats.loads,failed:SOUND.stats.failed,checks:['all cue variants decode','voice cleanup','movement footsteps and landing','pause stops environment','real firing and reload','missing-bank synthesis fallback','persistent volume','master mute']};
  });
  assert.deepEqual(runtime.failed,[]);assert.deepEqual(errors,[]);
  // A fresh load restores both gain settings and the slider position.
  await page.reload();await page.evaluate(()=>Audio2.init());
  assert.equal(await page.evaluate(()=>SOUND.levels.master),0);
  assert.equal(await page.locator('[data-sound-level="master"]').inputValue(),'0');
  const report={pass:true,rendered,direction,runtime,errors};fs.writeFileSync(path.join(out,'runtime-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
