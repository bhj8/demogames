/* Sample-backed sound layer. core.js remains the offline/load-failure fallback. */
'use strict';
const SOUND = {
  bank: null, buffers: {}, voices: new Set(), last: {}, picks: {}, initialized: false,
  limits: {weapon:8, confirm:8, world:14, danger:6, ui:4, ambience:2},
  levels: {master:.8, weapon:.85, world:.7, confirm:.85, ambience:.28},
  stats: {played:0, dropped:0, stolen:0, maxVoices:0, loads:0, failed:[]},
  // Volumes are relative to the measured short-window loudness in bank.json.
  cues: {
    rifle:['weapon',.95,.025], heavy_shot:['weapon',1,.09], dry:['weapon',.45,.08],
    mag_out:['weapon',.65,.08], mag_in:['weapon',.75,.08], bolt:['weapon',.7,.08],
    shell:['world',.19,.065], last_round:['confirm',.45,.08],
    flesh:['confirm',.55,.035], armor:['confirm',.72,.04], kill:['confirm',.48,.05],
    weak:['confirm',.65,.045], weak_kill:['confirm',.8,.055],
    explosion:['world',.9,.075], zap:['world',.48,.075], derived:['world',.22,.045],
    charge:['danger',.85,.16], spit:['danger',.75,.16], blast_warn:['danger',.8,.16],
    climb:['danger',.65,.18], melee:['danger',.65,.12], incoming:['danger',.7,.35],
    hurt:['confirm',.75,.12], shield:['confirm',.65,.08], shield_break:['confirm',.9,.2],
    dash:['weapon',.52,.12], step:['world',.3,.19], land:['world',.52,.15],
    enemy_idle:['world',.35,1.8], city_air:['ambience',.55,1],
    pickup_med:['ui',.65,.16], pickup_buff:['ui',.6,.16], levelup:['ui',.7,.3],
    mutation:['ui',.7,.5], victory:['ui',.85,1], defeat:['ui',.75,1],
    boss:['danger',.85,1], airdrop:['ui',.7,.7]
  },
  async preload() {
    try {
      const response=await fetch('assets/audio/bank.json');
      if(!response.ok)throw Error('bank HTTP '+response.status);
      this.bank=await response.json();
      // Download ahead of the first user gesture, decode only in its AudioContext.
      const jobs=Object.values(this.bank.sounds).flat();let cursor=0;
      await Promise.all(Array.from({length:4},async()=>{
        while(cursor<jobs.length){const clip=jobs[cursor++];
          try{const r=await fetch('assets/audio/'+clip.file);if(!r.ok)throw Error('HTTP '+r.status);clip.bytes=await r.arrayBuffer();if(this.initialized)await this.decode(clip);}
          catch(e){this.stats.failed.push(clip.file+': '+e.message);}
        }
      }));
    }catch(e){this.stats.failed.push(e.message);}
  },
  async decode(clip) {
    if(clip.decoding||this.buffers[clip.file]||!clip.bytes)return;
    clip.decoding=true;
    try {
      const buffer=await Audio2.ctx.decodeAudioData(clip.bytes);delete clip.bytes;
      // Spatial sounds are mono before the panner; their location comes from the world.
      const mono=Audio2.ctx.createBuffer(1,buffer.length,buffer.sampleRate),out=mono.getChannelData(0);
      for(let ch=0;ch<buffer.numberOfChannels;ch++){const a=buffer.getChannelData(ch);for(let i=0;i<a.length;i++)out[i]+=a[i]/buffer.numberOfChannels;}
      // small-sfx produces centered effects. Keep one mono buffer for them;
      // only the environmental bed retains its original stereo buffer.
      this.buffers[clip.file]={stereo:clip.file.startsWith('city_air_')?buffer:mono,mono};this.stats.loads++;
    }catch(e){this.stats.failed.push(clip.file+': decode '+e.message);}
  },
  init() {
    if(this.initialized||!Audio2.ready)return;
    this.initialized=true;const c=Audio2.ctx;
    try{const saved=JSON.parse(localStorage.getItem('symbiotic.audio.v1')||'{}');for(const k of Object.keys(this.levels))if(Number.isFinite(saved[k]))this.levels[k]=Math.max(0,Math.min(1,saved[k]));}catch(_){}
    // One final compressor covers weapon and confirmation buses too.
    this.limiter=c.createDynamicsCompressor();this.limiter.threshold.value=-5;
    this.limiter.knee.value=3;this.limiter.ratio.value=20;this.limiter.attack.value=.002;this.limiter.release.value=.12;
    this.ceiling=c.createWaveShaper();const curve=new Float32Array(4097);
    for(let i=0;i<curve.length;i++){const x=i*2/(curve.length-1)-1,a=Math.abs(x);curve[i]=a<.85?x:Math.sign(x)*(.85+.13*Math.tanh((a-.85)/.13));}
    this.ceiling.curve=curve;
    Audio2.master.disconnect();Audio2.master.connect(this.limiter);this.limiter.connect(this.ceiling);this.ceiling.connect(c.destination);
    this.buses={weapon:Audio2.weaponBus,confirm:Audio2.confirmBus};
    for(const id of ['world','danger','ui','ambience']){const b=c.createGain();b.connect(id==='world'||id==='ambience'?Audio2.comp:Audio2.master);this.buses[id]=b;}
    this.applyLevels();
    if(this.bank)Object.values(this.bank.sounds).flat().forEach(clip=>this.decode(clip));
  },
  applyLevels() {
    if(!this.initialized)return;
    const t=Audio2.t,ramp=(param,value)=>{const current=param.value;param.cancelScheduledValues(t);param.setValueAtTime(current,t);param.linearRampToValueAtTime(value,t+.03);};
    ramp(Audio2.master.gain,this.levels.master*.7);
    for(const [id,b] of Object.entries(this.buses)){
      const k=id==='danger'?'world':id==='ui'?'confirm':id;
      ramp(b.gain,this.levels[k]);
    }
    document.querySelectorAll('[data-sound-level]').forEach(input=>{input.value=Math.round(this.levels[input.dataset.soundLevel]*100);});
  },
  setLevel(key,value) {
    if(!(key in this.levels))return;
    this.levels[key]=Math.max(0,Math.min(1,Number(value)||0));this.applyLevels();
    try{localStorage.setItem('symbiotic.audio.v1',JSON.stringify(this.levels));}catch(_){}
  },
  stop(v,fade=.015) {
    if(v.stopped)return;v.stopped=true;this.voices.delete(v);
    const t=Audio2.t;v.gain.gain.cancelScheduledValues(t);v.gain.gain.setTargetAtTime(0,t,Math.max(.001,fade/4));
    v.source.stop(t+fade);
  },
  play(id,options={}) {
    if(!this.initialized||!this.bank)return false;
    const list=(this.bank.sounds[id]||[]).filter(clip=>this.buffers[clip.file]);
    if(!list.length)return false;
    const cfg=this.cues[id],bus=cfg[0],t=Audio2.t;
    if(document.hidden||((t-(this.last[id]??-Infinity))<cfg[2])){this.stats.dropped++;return true;}
    this.last[id]=t;
    if(options.pos&&typeof G!=='undefined'&&G.player){const p=G.player.pos,d=Math.hypot(p.x-options.pos.x,p.y-options.pos.y,p.z-options.pos.z);if(d>75){this.stats.dropped++;return true;}}
    const peers=[...this.voices].filter(v=>v.bus===bus);
    if(peers.length>=this.limits[bus]){this.stop(peers[0]);this.stats.stolen++;}
    let index=Math.floor(Math.random()*list.length);
    if(list.length>1&&index===this.picks[id])index=(index+1)%list.length;
    if(Number.isInteger(options.variant))index=Math.max(0,Math.min(list.length-1,options.variant));
    this.picks[id]=index;const clip=list[index],c=Audio2.ctx,source=c.createBufferSource(),gain=c.createGain();
    source.buffer=this.buffers[clip.file][options.pos?'mono':'stereo'];
    source.playbackRate.value=Math.max(.65,Math.min(1.5,(options.pitch||1)*(bus==='ui'||bus==='ambience'?1:.97+Math.random()*.06)));
    let pan=null;
    source.connect(gain);
    if(options.pos){pan=c.createPanner();pan.panningModel='equalpower';pan.distanceModel='inverse';pan.refDistance=5;pan.maxDistance=75;pan.rolloffFactor=1.2;
      pan.positionX.value=options.pos.x;pan.positionY.value=options.pos.y;pan.positionZ.value=options.pos.z;gain.connect(pan);pan.connect(this.buses[bus]);
    }else gain.connect(this.buses[bus]);
    const offset=bus==='ambience'?0:clip.onset;
    const end=bus==='ambience'?source.buffer.duration:clip.end;
    const duration=Math.min((end-offset)/source.playbackRate.value,options.duration||Infinity);
    const peak=cfg[1]*clip.gain*(options.volume??1),fade=bus==='ambience'?Math.min(1.5,duration/3):Math.min(.025,duration/4);
    gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(peak,t+(bus==='ambience'?fade:.002));
    gain.gain.setValueAtTime(peak,t+Math.max(.003,duration-fade));gain.gain.linearRampToValueAtTime(0,t+duration);
    const v={id,bus,source,gain,pan,started:t,ends:t+duration,stopped:false};this.voices.add(v);
    source.onended=()=>{this.voices.delete(v);source.disconnect();gain.disconnect();if(pan)pan.disconnect();};
    source.start(t,offset);source.stop(t+duration+.005);
    this.stats.played++;this.stats.maxVoices=Math.max(this.stats.maxVoices,this.voices.size);
    return true;
  },
  update(dt,active) {
    if(!this.initialized)return;
    const playing=active&&!document.hidden;
    if(!playing){
      if(this.active){for(const v of this.voices)if(v.bus!=='ui')this.stop(v,.06);}
      this.active=false;this.airAt=0;this.stepDistance=0;this.grounded=null;return;
    }
    this.active=true;const t=Audio2.t,p=G.player,grounded=!!MOVE.pose.grounded;
    if(t>=(this.airAt||0)&&this.play('city_air')) {
      for(const v of this.voices)if(v.id==='city_air')this.airAt=v.ends-1.5;
    }
    const speed=Math.hypot(p.vel.x,p.vel.z);
    if(grounded&&speed>1.5&&p.dashT<=0){this.stepDistance=(this.stepDistance||0)+speed*dt;if(this.stepDistance>2.25){this.stepDistance=0;this.play('step',{volume:Math.min(1.2,.55+speed/12)});}}
    else this.stepDistance=0;
    if(grounded&&this.grounded===false)this.play('land',{volume:.65});
    this.grounded=grounded;
    if(t>(this.growlAt||0)){
      this.growlAt=t+2.4;let nearest=null,distance=22;
      for(const e of G.enemies.live){if(e.dead||e._dead)continue;const d=Math.hypot(e.pos.x-p.pos.x,e.pos.z-p.pos.z);if(d<distance){distance=d;nearest=e;}}
      if(nearest)this.play('enemy_idle',{pos:nearest.pos,pitch:nearest.boss?.75:1});
    }
  }
};

// Keep existing event call sites and exact weapon animation timing.
(() => {
  const init=Audio2.init;
  Audio2.init=function(){init.call(this);SOUND.init();};
  const routes={
    shot:(pitch,heavy,interval)=>[heavy>1.5?'heavy_shot':'rifle',{pitch:Math.max(.85,Math.min(1.2,pitch||1)),duration:Math.max(.075,Math.min(.38,(interval||.11)*1.25))}],
    armorHit:()=>['armor'],dryClick:()=>['dry'],lastRound:()=>['last_round'],
    magOut:()=>['mag_out'],magIn:()=>['mag_in'],boltPull:()=>['bolt'],
    shellDrop:pos=>['shell',{pos}],hit:(pos,weak)=>[weak?'weak':'flesh'],kill:()=>['kill'],
    weakConfirm:killed=>[killed?'weak_kill':'weak'],derived:(pos,kind)=>['derived',{pos,pitch:kind==='bounce'?1.12:.9}],
    blast:(pos,big)=>['explosion',{pos,volume:big?1:.7,pitch:big?.85:1.05}],zap:pos=>['zap',{pos}],
    telegraph:(pos,kind)=>[{charge:'charge',blast:'blast_warn',field:'zap',spit:'spit',climb:'climb'}[kind]||'incoming',{pos}],
    meleeWindup:pos=>['melee',{pos}],incoming:pos=>['incoming',{pos}],hurt:()=>['hurt'],
    shieldHit:broken=>[broken?'shield_break':'shield'],pickup:kind=>[kind==='med'?'pickup_med':'pickup_buff'],
    reload:stage=>[stage?'mag_in':'mag_out'],dash:()=>['dash'],levelup:()=>['levelup'],
    mutation:()=>['mutation'],victory:()=>['victory'],defeat:()=>['defeat'],boss:()=>['boss'],airdropIncoming:()=>['airdrop']
  };
  for(const [method,route] of Object.entries(routes)){
    const fallback=Audio2[method];Audio2[method]=function(...args){const [id,options]=route(...args);if(!SOUND.play(id,options))fallback.apply(this,args);};
  }
  SOUND.loading=SOUND.preload();
  document.addEventListener('visibilitychange',()=>{if(document.hidden){for(const v of SOUND.voices)SOUND.stop(v,.03);}});
  document.querySelectorAll('[data-sound-level]').forEach(input=>{
    input.addEventListener('input',()=>{const value=Number(input.value)/100;Audio2.init();Audio2.resume();SOUND.setLevel(input.dataset.soundLevel,value);});
    input.addEventListener('pointerdown',()=>{Audio2.init();Audio2.resume();});
  });
  const resume=document.getElementById('resume');if(resume)resume.addEventListener('click',()=>Audio2.resume());
})();
