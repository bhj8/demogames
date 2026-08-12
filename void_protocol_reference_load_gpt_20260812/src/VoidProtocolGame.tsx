"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

type EnemyKind = "PLACEHOLDER" | "LOD0" | "MAGENTA" | "SLEEPER" | "HIGH_POLY";
type RuntimeState = "idle" | "running" | "paused" | "shop" | "victory" | "defeat";
type UpgradeKind = "resolver" | "multicast" | "buffer";
type HudState = { anchor: number; health: number; heap: number; ammo: number; reserve: number; load: number; multiplier: number; enemies: number; phase: number; phaseName: string; shopCost: number; bossBudget: number };
type Enemy = {
  id: number; kind: EnemyKind; root: THREE.Group; body: THREE.Mesh; marker: THREE.Mesh; tether: THREE.Line;
  hp: number; speed: number; reward: number; weight: number; target: "anchor" | "player";
  nextAttack: number; nextSpecial: number; lastProvoked: number; dead: boolean;
};

const PHASES = ["CALIBRATION", "PASS 01 · PROVOKE", "PASS 02 · PRIORITY", "PASS 03 · CARRY LOAD", "PASS 04 · KEEP DISTANCE", "FINAL · OPTIMIZE"];
const EMPTY_HUD: HudState = { anchor: 100, health: 100, heap: 0, ammo: 24, reserve: 120, load: 0, multiplier: 1, enemies: 0, phase: 0, phaseName: PHASES[0], shopCost: 30, bossBudget: 0 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

class ProtocolRuntime {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(72, 1, 0.05, 120);
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private frame = 0;
  private state: RuntimeState = "idle";
  private enemies: Enemy[] = [];
  private enemyMeshes: THREE.Object3D[] = [];
  private keys = new Set<string>();
  private player = new THREE.Vector3(0, 1.7, 11);
  private yaw = 0; private pitch = 0; private health = 100; private anchorHealth = 100; private heap = 0;
  private ammo = 24; private reserve = 144; private magSize = 24; private damageScale = 1; private fireInterval = .14; private firing = false; private nextShot = 0; private reloadUntil = 0;
  private startedAt = 0; private nextEnemyId = 1; private hudTimer = 0; private respawnUntil = 0;
  private audio: AudioContext | null = null; private anchorCore!: THREE.Mesh;
  private spawnQueue: Array<{ at: number; kind: EnemyKind; position: THREE.Vector3 }> = [];
  private flash = 0; private disposed = false; private phase = 0; private phaseCleared = false; private bossBudget = 0;

  constructor(
    private host: HTMLDivElement,
    private onHud: (hud: HudState) => void,
    private onState: (state: RuntimeState) => void,
    private onToast: (title: string, body: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = "game-canvas";
    this.host.appendChild(this.renderer.domElement);
    this.buildWorld(); this.bindEvents(); this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  private buildWorld() {
    this.scene.background = new THREE.Color(0x05070a);
    this.scene.fog = new THREE.FogExp2(0x05070a, 0.018);
    this.scene.add(new THREE.HemisphereLight(0x8fc8c8, 0x101012, 1.25));
    const key = new THREE.DirectionalLight(0xb6f5ef, 2.2);
    key.position.set(-9, 18, 12); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); this.scene.add(key);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), new THREE.MeshStandardMaterial({ color: 0x0b1115, roughness: 0.92, metalness: 0.08 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);
    const grid = new THREE.GridHelper(64, 32, 0x24595b, 0x12292d); grid.position.y = 0.012; this.scene.add(grid);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x11191d, emissive: 0x06171b, roughness: 0.65 });
    [[0,-31,62,1],[0,31,62,1],[-31,0,1,62],[31,0,1,62]].forEach(([x,z,w,d]) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 2.4, d), wallMat); wall.position.set(x,1.2,z); wall.castShadow = true; this.scene.add(wall);
    });
    this.buildAnchor(); this.buildZones(); this.camera.position.copy(this.player); this.scene.add(this.camera);
  }

  private buildAnchor() {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.1, 0.9, 8), new THREE.MeshStandardMaterial({ color: 0x20231f, metalness: 0.75, roughness: 0.35 }));
    base.position.y = 0.45; base.castShadow = true; group.add(base);
    this.anchorCore = new THREE.Mesh(new THREE.OctahedronGeometry(1.45, 1), new THREE.MeshStandardMaterial({ color: 0xffb42e, emissive: 0x9a3d00, emissiveIntensity: 1.8, metalness: 0.2, roughness: 0.22 }));
    this.anchorCore.position.y = 2.45; this.anchorCore.castShadow = true; group.add(this.anchorCore);
    [2.2,3.1].forEach((radius,i) => { const ring = new THREE.Mesh(new THREE.TorusGeometry(radius,0.055,8,64), new THREE.MeshBasicMaterial({ color:i ? 0x50615d : 0xffb42e, transparent:true, opacity:.78 })); ring.position.y=.9+i*.42; ring.rotation.x=Math.PI/2; group.add(ring); });
    this.scene.add(group);
  }

  private buildZones() {
    const coverMat = new THREE.MeshStandardMaterial({ color: 0x182126, metalness: .35, roughness: .7 });
    [[-9,-5],[-12,-1],[10,4],[13,8],[8,-10]].forEach(([x,z],i) => { const h=i%2?2.8:1.7; const box=new THREE.Mesh(new THREE.BoxGeometry(2.8,h,2.8),coverMat); box.position.set(x,h/2,z); box.castShadow=true; box.receiveShadow=true; this.scene.add(box); });
    const portalMat = new THREE.MeshStandardMaterial({ color:0x173136, emissive:0x0a4b54, emissiveIntensity:.75 });
    [[0,-25,0],[24,9,1],[-23,8,1]].forEach(([x,z,side]) => { const portal=new THREE.Mesh(new THREE.TorusGeometry(2.1,.14,8,32),portalMat.clone()); portal.position.set(x,2.25,z); portal.rotation.y=side?Math.PI/2:0; this.scene.add(portal); });
  }

  private bindEvents() {
    window.addEventListener("resize",this.resize); window.addEventListener("keydown",this.keyDown); window.addEventListener("keyup",this.keyUp);
    document.addEventListener("mousemove",this.mouseMove); document.addEventListener("mousedown",this.mouseDown); document.addEventListener("mouseup",this.mouseUp); document.addEventListener("pointerlockchange",this.pointerLockChange);
  }
  private unbindEvents() {
    window.removeEventListener("resize",this.resize); window.removeEventListener("keydown",this.keyDown); window.removeEventListener("keyup",this.keyUp);
    document.removeEventListener("mousemove",this.mouseMove); document.removeEventListener("mousedown",this.mouseDown); document.removeEventListener("mouseup",this.mouseUp); document.removeEventListener("pointerlockchange",this.pointerLockChange);
  }

  start() {
    this.reset(); this.state="running"; this.onState(this.state); this.startedAt=performance.now()/1000; this.queuePhase(0);
    this.host.requestPointerLock(); this.ensureAudio();
    this.onToast("REFERENCE ROUTING ONLINE", "Shoot an enemy attacking the Anchor. It will reference you instead."); this.log("run_start",{});
  }
  resume() { if(this.state!=="paused")return; this.state="running"; this.onState(this.state); this.host.requestPointerLock(); }
  private reset() {
    this.enemies.forEach(enemy=>this.scene.remove(enemy.root,enemy.tether)); this.enemies=[]; this.enemyMeshes=[]; this.spawnQueue=[];
    this.health=100; this.anchorHealth=100; this.heap=0; this.magSize=24; this.ammo=24; this.reserve=144; this.damageScale=1; this.fireInterval=.14; this.phase=0; this.phaseCleared=false; this.bossBudget=0; this.player.set(0,1.7,11); this.yaw=0; this.pitch=0; this.respawnUntil=0; this.pushHud();
  }
  private queuePhase(index:number) {
    this.phase=index; this.phaseCleared=false; this.health=Math.min(100,this.health+30); this.ammo=this.magSize; this.reserve=Math.min(180,this.reserve+30);
    const now=performance.now()/1000;
    const waves:Array<Array<[number,EnemyKind,number,number]>>=[
      [[.6,"PLACEHOLDER",0,-25],[1.8,"PLACEHOLDER",24,9],[3,"PLACEHOLDER",-23,8]],
      [[.5,"PLACEHOLDER",0,-25],[1.2,"LOD0",24,9],[1.8,"LOD0",-23,8],[3,"PLACEHOLDER",-2,-25],[3.5,"LOD0",24,11]],
      [[.5,"MAGENTA",0,-25],[4,"PLACEHOLDER",24,9],[4.7,"PLACEHOLDER",-23,8],[5.4,"MAGENTA",2,-25]],
      [[.5,"LOD0",0,-25],[.9,"LOD0",24,9],[1.3,"PLACEHOLDER",-23,8],[2,"MAGENTA",2,-25],[2.5,"PLACEHOLDER",24,11],[3,"LOD0",-23,6],[4,"MAGENTA",-2,-25]],
      [[.5,"SLEEPER",0,-25],[4,"SLEEPER",24,9],[4.5,"LOD0",-23,8],[5,"PLACEHOLDER",2,-25],[6,"MAGENTA",24,11]],
      [[1,"HIGH_POLY",0,-25]],
    ];
    const spawns=waves[index];
    this.spawnQueue=spawns.map(([delay,kind,x,z])=>({at:now+delay,kind,position:new THREE.Vector3(x,0,z)}));
    const instruction=["Shoot one target. Watch its red reference turn cyan.","Tag threats before they reach the Anchor.","MAGENTA charges a ranged fault. Interrupt its priority.","Carry four or more load to earn the orange multiplier.","SLEEPER crashes on deletion. Finish it at a safe distance.","Delete excess geometry. Each damage threshold restores the frame budget."][index];
    this.onToast(PHASES[index],instruction); this.log("phase_start",{phase:index,name:PHASES[index]}); this.pushHud();
  }

  chooseUpgrade(kind:UpgradeKind|"skip") {
    if(this.state!=="shop")return; const cost=30+this.phase*15;
    if(kind!=="skip"&&this.heap<cost){this.onToast("INSUFFICIENT HEAP",`Need ${cost}. Carry more load for a higher multiplier.`);return;}
    if(kind!=="skip")this.heap-=cost;
    if(kind==="resolver")this.damageScale*=1.18;
    if(kind==="multicast")this.fireInterval=Math.max(.075,this.fireInterval*.82);
    if(kind==="buffer"){this.magSize+=8;this.ammo=this.magSize;}
    this.log("upgrade",{phase:this.phase,kind,cost:kind==="skip"?0:cost});
    this.queuePhase(this.phase+1); this.state="running"; this.onState(this.state); this.host.requestPointerLock();
  }

  private spawnEnemy(kind:EnemyKind,position:THREE.Vector3) {
    const stats:Record<EnemyKind,{hp:number;speed:number;reward:number;weight:number;color:number;emissive:number}>={
      PLACEHOLDER:{hp:90,speed:1.75,reward:20,weight:2,color:0xc7d0c8,emissive:0x26302c},
      LOD0:{hp:42,speed:4.2,reward:14,weight:1,color:0xff7448,emissive:0x661406},
      MAGENTA:{hp:135,speed:1.15,reward:38,weight:3,color:0xff27d4,emissive:0x7a005f},
      SLEEPER:{hp:105,speed:1.45,reward:34,weight:2,color:0x7f8cff,emissive:0x202878},
      HIGH_POLY:{hp:1250,speed:.72,reward:260,weight:7,color:0xffd07a,emissive:0x853d0d},
    }; const spec=stats[kind]; const root=new THREE.Group(); root.position.copy(position);
    const geometry=kind==="LOD0"?new THREE.TetrahedronGeometry(.9,0):kind==="MAGENTA"?new THREE.SphereGeometry(1.05,8,6):kind==="SLEEPER"?new THREE.ConeGeometry(1.05,2.4,6):kind==="HIGH_POLY"?new THREE.IcosahedronGeometry(2.35,3):new THREE.BoxGeometry(1.35,2.2,1.35);
    const body=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:spec.color,emissive:spec.emissive,emissiveIntensity:.7,flatShading:true,roughness:.55,wireframe:kind==="HIGH_POLY"}));
    body.position.y=kind==="HIGH_POLY"?2.4:kind==="LOD0"?.9:1.2; body.castShadow=true; root.add(body);
    if(kind==="HIGH_POLY"){for(let i=0;i<4;i++){const shard=new THREE.Mesh(new THREE.IcosahedronGeometry(.62,1),new THREE.MeshStandardMaterial({color:0xffa542,emissive:0x7d2100,emissiveIntensity:1,wireframe:true}));const a=i*Math.PI/2;shard.position.set(Math.cos(a)*3,2.3,Math.sin(a)*3);root.add(shard);}}
    const marker=new THREE.Mesh(new THREE.RingGeometry(.22,.37,4),new THREE.MeshBasicMaterial({color:0xff4b3e,side:THREE.DoubleSide})); marker.position.y=kind==="HIGH_POLY"?5.4:kind==="LOD0"?2.15:2.8; marker.rotation.x=-Math.PI/2; root.add(marker);
    const tether=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineBasicMaterial({color:0xff4b3e,transparent:true,opacity:.4})); this.scene.add(root,tether);
    const enemy:Enemy={id:this.nextEnemyId++,kind,root,body,marker,tether,hp:spec.hp,speed:spec.speed,reward:spec.reward,weight:spec.weight,target:"anchor",nextAttack:0,nextSpecial:performance.now()/1000+2.2,lastProvoked:0,dead:false};
    if(kind==="HIGH_POLY")this.bossBudget=100;
    body.userData.enemyId=enemy.id; this.enemies.push(enemy); this.enemyMeshes.push(body); this.log("enemy_spawn",{id:enemy.id,kind});
  }

  private updateEnemy(enemy:Enemy,dt:number,now:number) {
    if(enemy.dead)return; const target=enemy.target==="player"?this.player:new THREE.Vector3(0,1.2,0); const planar=target.clone().sub(enemy.root.position); planar.y=0; const distance=planar.length();
    if(enemy.target==="player"&&now-enemy.lastProvoked>5&&distance>18){enemy.target="anchor";this.styleTarget(enemy);this.onToast("REFERENCE DROPPED",`${enemy.kind} returned to the Anchor.`);this.log("reference_drop",{id:enemy.id,kind:enemy.kind});}
    if(enemy.kind==="MAGENTA"&&now>=enemy.nextSpecial&&distance<18){enemy.nextSpecial=now+2.7;this.onToast("MAGENTA FAULT",enemy.target==="player"?"Ranged corruption hit your process.":"Ranged corruption hit the Anchor.");if(enemy.target==="player")this.damagePlayer(14,"MAGENTA");else this.damageAnchor(10,"MAGENTA");this.tone(150,.18,"sawtooth",.045);}
    if(enemy.kind==="MAGENTA"){const charge=clamp(1-(enemy.nextSpecial-now)/2.7,0,1);enemy.body.scale.setScalar(1+charge*.28);(enemy.body.material as THREE.MeshStandardMaterial).emissiveIntensity=.7+charge*2.4;}
    if(enemy.kind==="HIGH_POLY"){enemy.root.rotation.y+=dt*.2;enemy.root.children.slice(1,5).forEach((child,i)=>{child.position.y=2.3+Math.sin(now*2+i)*.35;child.rotation.x+=dt;child.rotation.z-=dt*.7;});}
    const attackRange=enemy.kind==="MAGENTA"?10:enemy.kind==="HIGH_POLY"?3.5:enemy.kind==="LOD0"?1.25:1.65;
    if(distance>attackRange){planar.normalize();enemy.root.position.addScaledVector(planar,enemy.speed*dt);enemy.root.lookAt(target.x,enemy.root.position.y,target.z);}
    else if(enemy.kind!=="MAGENTA"&&now>=enemy.nextAttack){enemy.nextAttack=now+(enemy.kind==="LOD0"?.72:enemy.kind==="HIGH_POLY"?1.25:1.05);const amount=enemy.kind==="LOD0"?7:enemy.kind==="HIGH_POLY"?22:11;if(enemy.target==="player")this.damagePlayer(amount,enemy.kind);else this.damageAnchor(amount*.65,enemy.kind);}
    enemy.marker.rotation.z+=dt*1.4; const from=enemy.root.position.clone().add(new THREE.Vector3(0,.16,0)); const to=enemy.target==="player"?this.player.clone().add(new THREE.Vector3(0,-.55,0)):new THREE.Vector3(0,1.7,0); enemy.tether.geometry.setFromPoints([from,to]);
  }
  private styleTarget(enemy:Enemy){const color=enemy.target==="player"?0x57f7ec:0xff4b3e;(enemy.marker.material as THREE.MeshBasicMaterial).color.setHex(color);(enemy.tether.material as THREE.LineBasicMaterial).color.setHex(color);}
  private provoke(enemy:Enemy,now:number){const wasAnchor=enemy.target==="anchor";enemy.target="player";enemy.lastProvoked=now;this.styleTarget(enemy);if(wasAnchor){this.onToast("REFERENCE ACQUIRED",`${enemy.kind} is targeting YOU. Load increased.`);this.log("enemy_provoked",{id:enemy.id,kind:enemy.kind});this.tone(520,.045,"square",.035);}}

  private shoot(now:number) {
    if(now<this.nextShot||now<this.reloadUntil||this.health<=0)return;if(this.ammo<=0){this.reload(now);return;}
    this.nextShot=now+this.fireInterval;this.ammo-=1;this.camera.rotation.z=(Math.random()-.5)*.012;this.pitch=clamp(this.pitch+.008,-1.32,1.25);this.tone(96,.055,"sawtooth",.05);
    this.raycaster.setFromCamera(new THREE.Vector2(0,0),this.camera);const hit=this.raycaster.intersectObjects(this.enemyMeshes,false)[0];if(!hit)return;
    const enemy=this.enemies.find(candidate=>candidate.id===hit.object.userData.enemyId);if(!enemy||enemy.dead)return;
    const localY=hit.point.y-enemy.root.position.y;const weak=localY>(enemy.kind==="HIGH_POLY"?3.05:enemy.kind==="LOD0"?1.25:1.65);const damage=Math.round((weak?52:34)*this.damageScale);enemy.hp-=damage;this.provoke(enemy,now);
    if(enemy.kind==="HIGH_POLY"){const previous=this.bossBudget;this.bossBudget=Math.max(0,Math.ceil(enemy.hp/1250*100));const oldBand=Math.ceil(previous/25),newBand=Math.ceil(this.bossBudget/25);if(newBand<oldBand){const shard=enemy.root.children[oldBand];if(shard)shard.visible=false;enemy.speed*=.82;this.scene.fog=new THREE.FogExp2(0x05070a,.018+newBand*.003);this.onToast("POLY BUDGET RESTORED",`${this.bossBudget}% excess geometry remains. Movement stabilized.`);this.tone(1040,.16,"square",.055);}}
    const material=enemy.body.material as THREE.MeshStandardMaterial;const original=material.emissive.clone();material.emissive.setHex(weak?0xffffff:0x4de7df);material.emissiveIntensity=2.6;
    window.setTimeout(()=>{if(!enemy.dead){material.emissive.copy(original);material.emissiveIntensity=.7;}},70);this.tone(weak?880:660,.035,"sine",.035);this.log("enemy_hit",{id:enemy.id,kind:enemy.kind,weak,damage});if(enemy.hp<=0)this.killEnemy(enemy);
  }
  private killEnemy(enemy:Enemy){enemy.dead=true;const multiplier=this.currentMultiplier();const referenced=enemy.target==="player";const reward=Math.round(enemy.reward*(referenced?multiplier:1));this.heap+=reward;
    if(enemy.kind==="SLEEPER"){const playerDistance=enemy.root.position.distanceTo(this.player),anchorDistance=enemy.root.position.length();this.onToast("SLEEPER CRASH",playerDistance<5.5?"Unsafe deletion damaged your process.":"Crash radius avoided.");if(playerDistance<5.5)this.damagePlayer(24,"SLEEPER CRASH");if(anchorDistance<5.5)this.damageAnchor(18,"SLEEPER CRASH");this.tone(72,.32,"sawtooth",.065);}
    this.scene.remove(enemy.root,enemy.tether);this.enemyMeshes=this.enemyMeshes.filter(mesh=>mesh!==enemy.body);this.tone(230,.1,"triangle",.05);this.log("enemy_kill",{id:enemy.id,kind:enemy.kind,referenced,reward,multiplier});if(referenced&&multiplier>=1.5)this.onToast(`HEAP +${reward}`,`Risk bonus ×${multiplier.toFixed(2)} recovered.`);}
  private reload(now=performance.now()/1000){if(this.reloadUntil>now||this.ammo===this.magSize||this.reserve<=0)return;this.reloadUntil=now+1.4;this.onToast("RELOADING","Keep moving. References remain attached.");window.setTimeout(()=>{if(this.disposed)return;const need=this.magSize-this.ammo;const loaded=Math.min(need,this.reserve);this.ammo+=loaded;this.reserve-=loaded;this.tone(320,.06,"square",.025);},1400);}

  private damagePlayer(amount:number,source:string){if(this.health<=0)return;this.health=Math.max(0,this.health-amount);this.flash=Math.max(this.flash,.7);this.tone(58,.09,"sawtooth",.06);if(this.health<=0){const deathLoad=this.currentLoad();this.respawnUntil=performance.now()/1000+2.25;this.firing=false;this.enemies.forEach(enemy=>{if(!enemy.dead){enemy.target="anchor";this.styleTarget(enemy);}});this.onToast("PROCESS LOST","All references returned to the Anchor. Recompiling…");this.log("player_death",{source,load:deathLoad,anchor:this.anchorHealth});}}
  private damageAnchor(amount:number,source:string){this.anchorHealth=Math.max(0,this.anchorHealth-amount);const material=this.anchorCore.material as THREE.MeshStandardMaterial;material.emissiveIntensity=3.8;window.setTimeout(()=>material.emissiveIntensity=1.8,100);if(this.anchorHealth<=0){this.state="defeat";document.exitPointerLock();this.onState(this.state);this.log("run_end",{result:"defeat",source,heap:this.heap});}}
  private currentLoad(){return this.enemies.reduce((sum,enemy)=>sum+(!enemy.dead&&enemy.target==="player"?enemy.weight:0),0);}
  private currentMultiplier(){const load=this.currentLoad();if(load>=7)return 2.5;if(load>=4)return 1.75;if(load>=2)return 1.35;return 1;}

  private updatePlayer(dt:number,now:number){if(this.health<=0){if(this.respawnUntil&&now>=this.respawnUntil){this.health=100;this.player.set(0,1.7,11);this.respawnUntil=0;this.onToast("PROCESS RESTORED","No HEAP penalty. The Anchor paid the real cost.");}return;}
    const forward=Number(this.keys.has("KeyW"))-Number(this.keys.has("KeyS"));const strafe=Number(this.keys.has("KeyD"))-Number(this.keys.has("KeyA"));const input=new THREE.Vector3(strafe,0,-forward);
    if(input.lengthSq()>0){input.normalize().applyAxisAngle(new THREE.Vector3(0,1,0),this.yaw);const sprint=this.keys.has("ShiftLeft")||this.keys.has("ShiftRight");this.player.addScaledVector(input,(sprint?8.4:5.5)*dt);this.player.x=clamp(this.player.x,-28.5,28.5);this.player.z=clamp(this.player.z,-28.5,28.5);}
    this.camera.position.copy(this.player);this.camera.rotation.order="YXZ";this.camera.rotation.y=this.yaw;this.camera.rotation.x=this.pitch;this.camera.rotation.z*=Math.pow(.04,dt);if(this.firing)this.shoot(now);
  }
  private pushHud(){this.onHud({anchor:this.anchorHealth,health:this.health,heap:this.heap,ammo:this.ammo,reserve:this.reserve,load:this.currentLoad(),multiplier:this.currentMultiplier(),enemies:this.enemies.filter(enemy=>!enemy.dead).length+this.spawnQueue.length,phase:this.phase,phaseName:PHASES[this.phase],shopCost:30+this.phase*15,bossBudget:this.bossBudget});}

  private tick=()=>{if(this.disposed)return;const dt=Math.min(this.clock.getDelta(),.05);const now=performance.now()/1000;if(this.state==="running"){
      while(this.spawnQueue.length&&this.spawnQueue[0].at<=now){const spawn=this.spawnQueue.shift()!;this.spawnEnemy(spawn.kind,spawn.position);}
      this.updatePlayer(dt,now);this.enemies.forEach(enemy=>this.updateEnemy(enemy,dt,now));this.anchorCore.rotation.y+=dt*.85;this.anchorCore.position.y=2.45+Math.sin(now*1.7)*.08;
      if(!this.phaseCleared&&!this.spawnQueue.length&&this.enemies.length>0&&this.enemies.every(enemy=>enemy.dead)){this.phaseCleared=true;document.exitPointerLock();if(this.phase===PHASES.length-1){this.state="victory";this.onState(this.state);this.onToast("PROOF COMPILED","You converted danger into HEAP and optimized the corruption.");this.log("run_end",{result:"victory",heap:this.heap,anchor:this.anchorHealth});}else{this.state="shop";this.onState(this.state);this.log("phase_clear",{phase:this.phase,heap:this.heap,anchor:this.anchorHealth});}}
      this.hudTimer+=dt;if(this.hudTimer>=.05){this.hudTimer=0;this.pushHud();}}
    this.flash=Math.max(0,this.flash-dt*2.5);this.renderer.domElement.style.filter=this.flash>0?`sepia(${this.flash}) saturate(${1+this.flash})`:"";this.renderer.render(this.scene,this.camera);this.frame=requestAnimationFrame(this.tick);
  };
  private resize=()=>{const width=Math.max(1,this.host.clientWidth),height=Math.max(1,this.host.clientHeight);this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.renderer.setSize(width,height,false);};
  private keyDown=(event:KeyboardEvent)=>{this.keys.add(event.code);if(event.code==="KeyR")this.reload();}; private keyUp=(event:KeyboardEvent)=>this.keys.delete(event.code);
  private mouseMove=(event:MouseEvent)=>{if(document.pointerLockElement!==this.host||this.state!=="running")return;this.yaw-=event.movementX*.0022;this.pitch=clamp(this.pitch-event.movementY*.002,-1.32,1.25);};
  private mouseDown=(event:MouseEvent)=>{if(event.button!==0||document.pointerLockElement!==this.host)return;this.firing=true;this.shoot(performance.now()/1000);}; private mouseUp=(event:MouseEvent)=>{if(event.button===0)this.firing=false;};
  private pointerLockChange=()=>{if(document.pointerLockElement!==this.host&&this.state==="running"){this.state="paused";this.firing=false;this.onState(this.state);}};
  private ensureAudio(){if(!this.audio)this.audio=new AudioContext();if(this.audio.state==="suspended")void this.audio.resume();}
  private tone(frequency:number,duration:number,type:OscillatorType,volume:number){if(!this.audio)return;const oscillator=this.audio.createOscillator(),gain=this.audio.createGain();oscillator.type=type;oscillator.frequency.setValueAtTime(frequency,this.audio.currentTime);gain.gain.setValueAtTime(volume,this.audio.currentTime);gain.gain.exponentialRampToValueAtTime(.0001,this.audio.currentTime+duration);oscillator.connect(gain).connect(this.audio.destination);oscillator.start();oscillator.stop(this.audio.currentTime+duration);}
  private log(type:string,data:Record<string,unknown>){try{const key="void-protocol-telemetry",events=JSON.parse(localStorage.getItem(key)||"[]") as unknown[];events.push({type,at:Date.now(),runTime:this.startedAt?performance.now()/1000-this.startedAt:0,...data});localStorage.setItem(key,JSON.stringify(events.slice(-800)));}catch{/* Non-blocking. */}}
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);this.unbindEvents();this.renderer.dispose();this.host.removeChild(this.renderer.domElement);void this.audio?.close();}
}

export default function VoidProtocolGame(){
  const hostRef=useRef<HTMLDivElement>(null),runtimeRef=useRef<ProtocolRuntime|null>(null);const[state,setState]=useState<RuntimeState>("idle");const[hud,setHud]=useState<HudState>(EMPTY_HUD);const[toast,setToast]=useState({title:"",body:"",id:0});const[webglUnavailable,setWebglUnavailable]=useState(false);
  const showToast=useCallback((title:string,body:string)=>setToast({title,body,id:Date.now()}),[]);
  useEffect(()=>{if(!hostRef.current)return;try{const runtime=new ProtocolRuntime(hostRef.current,setHud,setState,showToast);runtimeRef.current=runtime;return()=>runtime.dispose();}catch{const timer=window.setTimeout(()=>setWebglUnavailable(true),0);return()=>window.clearTimeout(timer);}},[showToast]);
  return <main className="protocol-shell"><div className="game-stage" ref={hostRef} aria-label="Void Protocol first-person game canvas"><div className="scanlines" />
    {state!=="idle"&&<div className="hud" aria-live="polite">
      <section className="hud-block anchor-panel"><span className="eyebrow">LAST SAVE POINT</span><div className="metric-line"><strong>ANCHOR</strong><span>{Math.ceil(hud.anchor)}%</span></div><div className="bar"><i style={{width:`${hud.anchor}%`}}/></div></section>
      <section className="pass-panel"><span className="eyebrow">{hud.phaseName}</span><strong>{hud.phase===5?"BREAK PARTS → RESTORE BUDGET":"SHOOT → PROVOKE → CARRY RISK"}</strong><span>{hud.enemies} unresolved assets</span></section>
      <section className={`load-panel ${hud.load>=4?"is-hot":""}`}><div className="load-heading"><span>REFERENCE LOAD</span><strong>{hud.load}</strong></div><div className="load-pips">{Array.from({length:8},(_,i)=><i key={i} className={i<hud.load?"active":""}/>)}</div><div className="load-bonus">HEAP MULTIPLIER <strong>×{hud.multiplier.toFixed(2)}</strong></div></section>
      <section className="player-panel"><div className="health-readout"><span>PROCESS</span><strong>{Math.ceil(hud.health)}</strong></div><div className="heap-readout"><span>HEAP</span><strong>{hud.heap}</strong></div></section>
      <section className="ammo-panel"><span className="eyebrow">BURST RIFLE</span><strong>{hud.ammo}</strong><span>/ {hud.reserve}</span></section>
      <div className="crosshair"><i/><i/><span/></div><div className="target-key"><span><i className="target-anchor"/> attacks Anchor</span><span><i className="target-player"/> references you</span></div>
      {hud.phase===5&&hud.enemies>0&&<div className="boss-budget"><span>POLY BUDGET OVERLOAD</span><div><i style={{width:`${hud.bossBudget}%`}}/></div><strong>{hud.bossBudget}% EXCESS</strong></div>}
    </div>}
    {toast.title&&state!=="idle"&&<div className="toast" key={toast.id}><strong>{toast.title}</strong><span>{toast.body}</span></div>}
    {state==="idle"&&<section className="boot-screen overlay-screen"><div className="boot-copy"><p className="kicker">A PLAYABLE DESIGN HYPOTHESIS · GPT · 2026.08.12</p><h1>VOID<br/><span>PROTOCOL</span></h1><p className="subtitle">REFERENCE LOAD</p><p className="premise">The game is being deleted. Every shot can pull a broken asset away from the last save point—and onto you.</p><button disabled={webglUnavailable} onClick={()=>runtimeRef.current?.start()}>{webglUnavailable?"WEBGL REQUIRED":"ENTER THE BUILD"} <span>↗</span></button><div className="controls"><span><kbd>WASD</kbd> MOVE</span><span><kbd>MOUSE</kbd> AIM</span><span><kbd>LMB</kbd> FIRE</span><span><kbd>R</kbd> RELOAD</span><span><kbd>SHIFT</kbd> SPRINT</span></div></div><aside className="boot-diagnostic"><span>BUILD STATUS</span><strong>{webglUnavailable?"RENDERER OFFLINE":"UNREFERENCED"}</strong><dl><div><dt>SELF MESH</dt><dd>NOT FOUND</dd></div><div><dt>ANCHOR</dt><dd>ONLINE</dd></div><div><dt>RISK ROUTING</dt><dd>MANUAL</dd></div></dl></aside></section>}
    {state==="paused"&&<section className="pause-screen overlay-screen compact-screen"><p className="kicker">SIMULATION SUSPENDED</p><h2>References remain live.</h2><p>Return before the Anchor becomes the only valid target.</p><button onClick={()=>runtimeRef.current?.resume()}>RESUME PROCESS</button></section>}
    {state==="shop"&&<section className="shop-screen overlay-screen"><div className="shop-wrap"><p className="kicker">PASS {String(hud.phase+1).padStart(2,"0")} COMPLETE · {hud.heap} HEAP AVAILABLE</p><h2>Commit one patch.</h2><p className="shop-intro">The next failure is already visible. Spend recovered risk now, or preserve it for the final optimization.</p><div className="upgrade-grid"><button disabled={hud.heap<hud.shopCost} onClick={()=>runtimeRef.current?.chooseUpgrade("resolver")}><span>0{hud.phase+1} · {hud.shopCost}H</span><strong>WEAK RESOLVER</strong><em>+18% damage</em><small>Cleaner reads reward deliberate weak-point shots.</small></button><button disabled={hud.heap<hud.shopCost} onClick={()=>runtimeRef.current?.chooseUpgrade("multicast")}><span>0{hud.phase+1} · {hud.shopCost}H</span><strong>MULTI-CAST</strong><em>+22% fire rate</em><small>Tag more targets before they touch the Anchor.</small></button><button disabled={hud.heap<hud.shopCost} onClick={()=>runtimeRef.current?.chooseUpgrade("buffer")}><span>0{hud.phase+1} · {hud.shopCost}H</span><strong>HEAP BUFFER</strong><em>+8 magazine</em><small>Carry a heavier reference load between reloads.</small></button></div><button className="skip-patch" onClick={()=>runtimeRef.current?.chooseUpgrade("skip")}>SKIP PATCH → NEXT PASS</button></div></section>}
    {(state==="victory"||state==="defeat")&&<section className="result-screen overlay-screen compact-screen"><p className="kicker">{state==="victory"?"HYPOTHESIS COMPILED":"ANCHOR DEREFERENCED"}</p><h2>{state==="victory"?"Risk became currency.":"The last save point is gone."}</h2><p>{state==="victory"?`You recovered ${hud.heap} HEAP with ${Math.ceil(hud.anchor)}% Anchor integrity.`:"Pull threats off the Anchor earlier—and carry more of the fight yourself."}</p><button onClick={()=>runtimeRef.current?.start()}>RUN AGAIN</button></section>}
    <div className="corner corner-tl"/><div className="corner corner-tr"/><div className="corner corner-bl"/><div className="corner corner-br"/>
  </div><p className="desktop-note">Desktop prototype · headphones recommended · click the game to capture the mouse</p></main>;
}
