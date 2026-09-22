/* Directional sprites in a 3D world, not full 3D models. Shared geometry/atlases;
 * per-instance animation. Alpha-tested depth preserves building occlusion. */
'use strict';
const ENEMY_ART = {
  textures: {}, geometryCache: null,
  batching: true, batches: {}, batchMatrix: new THREE.Matrix4(),
  batchFrustum: new THREE.Frustum(), batchProjection: new THREE.Matrix4(), batchSphere: new THREE.Sphere(),
  geometry() {
    if (!this.geometryCache) {
      const g = new THREE.PlaneGeometry(1, 1, 8, 18);
      g.translate(0, .5, 0); g.computeBoundingSphere(); this.geometryCache = g;
    }
    return this.geometryCache;
  },
  texture(id) {
    if (!this.textures[id]) {
      const t = new THREE.Texture();
      t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
      // Chroma keys must not mix with silhouettes across mip levels.
      t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; this.textures[id] = t;
      let settled;
      t.userData.loading = new Promise(resolve => { settled = resolve; });
      const url = 'assets/enemies/' + id + '.png';
      const load = attempt => {
        t.userData.status = 'loading';
        new THREE.ImageLoader().load(url, img => {
          t.image = img; t.needsUpdate = true; t.userData.status = 'ready';
          settled();
        }, undefined, () => {
          t.userData.status = 'failed';
          if (attempt < 2) setTimeout(() => load(attempt + 1), 1000 * (attempt + 1));
          else { settled(); console.warn('Enemy artwork unavailable; using visible geometry:', url); }
        });
      };
      load(0);
    }
    return this.textures[id];
  },
  // Texture requests can fail or stay pending on slow connections. Enemies must
  // still have a visible body and the same height/collision/weak point.
  fallbackGeometry() {
    if (!this.fallbackCache) {
      const parts = [], g = R.geo;
      const part = (x,y,z,sx,sy,sz,color=0xadb7a8) => parts.push({geo:g.facet,mat:mat4(x,y,z,sx,sy,sz),color});
      part(0,.61,0,.44,.43,.28);part(0,.40,0,.25,.21,.21);
      part(0,.89,.01,.22,.24,.22,0xcfc6ac);
      for (const s of [-1,1]) {
        part(s*.2,.70,0,.19,.19,.20);part(s*.25,.52,.03,.13,.34,.14);
        part(s*.27,.31,.06,.11,.18,.12);part(s*.1,.26,0,.15,.27,.16);
        part(s*.11,.10,0,.1,.19,.12);part(s*.11,.035,.05,.13,.07,.20);
        part(s*.04,.90,.12,.03,.02,.02,0xffd47b);
      }
      this.fallbackCache = mergeGeom(parts);
    }
    return this.fallbackCache;
  },
  canBatch(renderer) {
    if (this.batchRenderer === renderer) return this.batchSupported;
    this.batchRenderer = renderer;
    const gl = renderer.getContext();
    // Matrix consumes four attribute slots; the sprite uses eight more.
    return this.batchSupported = gl.getParameter(gl.MAX_VERTEX_ATTRIBS) >= 12 &&
      (renderer.capabilities.isWebGL2 || !!renderer.extensions.get('ANGLE_instanced_arrays'));
  },
  prepare(scene, camera) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      // Let the menu paint, then prepare all designs before accepting input.
      // A stalled request must not prevent playing with the visible fallback.
      let timeout;
      await Promise.race([
        Promise.all(Object.keys(ENEMY_ATLAS).map(id => this.texture(id).userData.loading)),
        new Promise(resolve => { timeout = setTimeout(resolve, TUNE.ART.loadTimeoutMs); })
      ]);
      clearTimeout(timeout);
      await new Promise(resolve => setTimeout(resolve, 0));
      const renderer=R.renderer, warm=new THREE.Scene();
      warm.fog=scene.fog;
      scene.traverseVisible(o=>{if(o.isLight)warm.add(o.clone());});
      const cameraWarm=camera.clone();cameraWarm.position.set(0,.5,3);cameraWarm.lookAt(0,.5,0);cameraWarm.updateMatrixWorld();
      const meshes=[];
      if(this.canBatch(renderer))for(const id of Object.keys(ENEMY_ATLAS)){
        const b=this.batches[id]||this.makeBatch(id,scene);
        const mesh=new THREE.InstancedMesh(b.mesh.geometry,b.mesh.material,1);
        mesh.frustumCulled=false;mesh.userData.batch=b;warm.add(mesh);meshes.push(mesh);
      }
      // Warm the individual and missing-texture paths too. Keep these two
      // materials alive so disposing a probe cannot evict their shared program.
      const material=new THREE.MeshLambertMaterial();R.attachGait(material,0);
      this.configure({body:{},bodyMat:material,plates:3},'grunt');
      const fallback=new THREE.MeshLambertMaterial({vertexColors:true});
      this.warmMaterials=[material,fallback];
      warm.add(new THREE.Mesh(this.geometry(),material),new THREE.Mesh(this.fallbackGeometry(),fallback));
      renderer.compile(warm,cameraWarm);
      const gl=renderer.getContext();
      for(const b of Object.values(this.batches)){
        const programs=renderer.properties.get(b.mesh.material).programs;
        b.failed=!programs || [...programs.values()].some(p=>!gl.getProgramParameter(p.program,gl.LINK_STATUS));
        b.checked=true;
      }
      // Upload every loaded atlas and issue tiny draws to finish driver setup.
      // Neither scene traversal nor GPU link-status queries belong in combat.
      for(const t of Object.values(this.textures))if(t.userData.status==='ready')renderer.initTexture(t);
      for(const mesh of meshes)mesh.visible=!mesh.userData.batch.failed;
      const target=new THREE.WebGLRenderTarget(1,1),previous=renderer.getRenderTarget();
      target.texture.encoding=renderer.outputEncoding;
      try {renderer.setRenderTarget(target);renderer.clear();renderer.render(warm,cameraWarm);}
      finally {renderer.setRenderTarget(previous);target.dispose();for(const mesh of meshes)mesh.dispose();}
      this.prepared=true;
    })();
    return this.ready;
  },
  configure(e, id) {
    const m = e.bodyMat;
    e.artKind = id; e.artView = -1;
    e.body.geometry = this.geometry();
    e.body.material = m;
    m.map = this.texture(id); m.color.setHex(0xffffff); m.vertexColors = false;
    m.alphaTest = .45; m.side = THREE.DoubleSide;
    if (!m.userData.directional) {
      const art = m.userData.directional = { rect: { value: new THREE.Vector4(0, 0, 1/3, 1) },
        pixel: { value: new THREE.Vector2(1/1536,1/1024) },
        attack: { value: 0 }, side: { value: 0 },
        flip: { value: 0 }, plates: { value: 3 }, bone: { value: 0 }, theme: { value: new THREE.Color(0) }, themeOn: { value: 0 } };
      const gaitCompile = m.onBeforeCompile;
      m.onBeforeCompile = shader => {
        gaitCompile(shader);
        const motion = TUNE.ART.enemyMotion;
        shader.uniforms.enemyAttack = art.attack; shader.uniforms.enemySide = art.side;
        shader.vertexShader = 'uniform float enemyAttack; uniform float enemySide;\n'+shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
          float torso = smoothstep(.38,.82,position.y);
          transformed.x += sin(artTime*.5)*torso*artMotion*${motion.sway.toFixed(4)};
          transformed.x += sin(stepPhase)*leg*artMotion*enemySide*.16;
          transformed.y += sin(artTime*.45)*torso*${motion.breath.toFixed(4)};
          transformed.y -= torso*enemyAttack*${motion.attackLean.toFixed(4)};
          transformed.x *= 1.0+torso*enemyAttack*.045;
          #include <project_vertex>
        `);
        shader.uniforms.artRect = art.rect; shader.uniforms.artFlip = art.flip;
        shader.uniforms.artPixel = art.pixel;
        shader.uniforms.artPlates = art.plates; shader.uniforms.artBone = art.bone;
        shader.uniforms.artTheme = art.theme; shader.uniforms.artThemeOn = art.themeOn;
        shader.fragmentShader = 'uniform vec4 artRect; uniform vec2 artPixel; uniform float artFlip; uniform vec3 artTheme; uniform float artThemeOn;\nfloat clearKey(vec3 c){return step(.65,c.r)*step(.35,c.b)*(1.0-step(.12,c.g));}\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
          vec2 atlasUV = vec2(mix(vUv.x, 1.0-vUv.x, artFlip), vUv.y) * artRect.zw + artRect.xy;
          vec4 painted = texture2D(map, atlasUV);
          float key = clearKey(painted.rgb);
          float border=max(max(clearKey(texture2D(map,atlasUV+vec2(artPixel.x,0.0)).rgb),clearKey(texture2D(map,atlasUV-vec2(artPixel.x,0.0)).rgb)),max(clearKey(texture2D(map,atlasUV+vec2(0.0,artPixel.y)).rgb),clearKey(texture2D(map,atlasUV-vec2(0.0,artPixel.y)).rgb)));
          key=max(key,border*smoothstep(.002,.05,min(painted.r,painted.b)-painted.g));
          painted.a *= 1.0-key;
          painted.rb = mix(painted.rb,min(painted.rb,vec2(painted.g*1.25)),key);
          // Feather the mutation tint and retain the painted muscle/armor value.
          // A hard rectangular mask reads like a sticker on the character.
          float chest = 1.0-smoothstep(.15,1.0,length((vUv-vec2(.5,.71))/vec2(.23,.14)));
          float paintedValue = max(painted.r,max(painted.g,painted.b));
          painted.rgb += artTheme * artThemeOn * chest * paintedValue * .18;
          diffuseColor *= painted;
        `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', `
          outgoingLight = mix(diffuseColor.rgb, outgoingLight, ${TUNE.ART.enemyMotion.lighting.toFixed(3)}) + totalEmissiveRadiance * .55;
          #include <output_fragment>
        `);
      };
      m.customProgramCacheKey = () => 'directional-enemy-gait-v2';
    }
    const a = m.userData.directional;
    a.pixel.value.set(1/ENEMY_ATLAS[id].width,1/ENEMY_ATLAS[id].height);
    a.bone.value = id === 'ossify' ? 1 : 0; a.plates.value = e.plates || 0;
    a.themeOn.value = 0; a.flip.value = 0; m.needsUpdate = true;
    a.attack.value = 0;
  },
  setTheme(e, id) {
    const a = e.bodyMat.userData.directional;
    if (a) { a.theme.value.setHex(MUT[id].color); a.themeOn.value = 1; }
  },
  sync(e, camera) {
    const spec = ENEMY_ATLAS[e.artKind], a = e.bodyMat.userData.directional;
    if (!spec || !a) return;
    const toCamera = Math.atan2(camera.position.x-e.pos.x, camera.position.z-e.pos.z);
    const angle = Math.atan2(Math.sin(toCamera-e.grp.rotation.y), Math.cos(toCamera-e.grp.rotation.y));
    const absolute = Math.abs(angle), margin = .075;
    let view = absolute < Math.PI/4 ? 0 : absolute > Math.PI*3/4 ? 2 : 1;
    if (e.artView === 0 && absolute < Math.PI/4+margin) view=0;
    if (e.artView === 2 && absolute > Math.PI*3/4-margin) view=2;
    if (e.artView === 1 && absolute > Math.PI/4-margin && absolute < Math.PI*3/4+margin) view=1;
    this.view(e, view, angle < 0);
    e.body.rotation.y = toCamera-e.grp.rotation.y;
    const img = e.bodyMat.map.image;
    e.artReady = !!(img && img.complete && img.naturalWidth > 0);
    e.body.visible = true;
    if (e.artReady) {
      e.body.geometry = this.geometry(); e.body.material = e.bodyMat;
    } else {
      if (!e.artFallbackMaterial) e.artFallbackMaterial = new THREE.MeshLambertMaterial({vertexColors:true});
      e.artFallbackMaterial.color.setHex(e.variant ? MUT[e.variant].color : 0xb3b29d);
      e.body.geometry = this.fallbackGeometry(); e.body.material = e.artFallbackMaterial;
      e.body.scale.set(1,1,1); e.body.rotation.y = 0;
    }
    a.plates.value = e.plates;
    a.attack.value = ['windup','leapwind','spit','slam','melee'].includes(e.state) ? .65 : e.state === 'charge' ? 1 : 0;
    e.mark.visible = false;
    e.plateMeshes.forEach(p => { p.material.visible = false; });
  },
  view(e, view, flip) {
    const state = e.artKind === 'ossify' ? ['ossify-zero','ossify-bare','ossify-two','ossify'][e.plates] : e.artKind;
    const id = ENEMY_ATLAS[state] ? state : e.artKind;
    const spec = ENEMY_ATLAS[id], f = spec.frames[view], a=e.bodyMat.userData.directional;
    e.bodyMat.map = this.texture(id);
    a.pixel.value.set(1/spec.width,1/spec.height);
    a.rect.value.set(...f.uv); a.flip.value = view === 1 && flip ? 1 : 0;
    a.side.value = view === 1 ? 1 : 0;
    e.body.scale.set(f.aspect, 1, 1); e.artView = view;
    e.artTexture = id;
  },

  makeBatch(id, scene) {
    const capacity = Math.max(TUNE.SPAWN.aliveCap, TUNE.ART.shadow.capacity);
    const geometry = this.geometry().clone(), attributes = {};
    for (const [name,size] of Object.entries({instanceArtRect:4,instanceAnimation:4,instanceSide:1,instanceTheme:3,instanceGlow:3})) {
      const a=new THREE.InstancedBufferAttribute(new Float32Array(capacity*size),size);
      a.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute(name,a); attributes[name]=a;
    }
    const material=new THREE.MeshLambertMaterial();R.attachGait(material,0);
    const proxy={body:{geometry:null},bodyMat:material,plates:3};this.configure(proxy,id);
    const compile=material.onBeforeCompile;
    material.onBeforeCompile=shader=>{
      compile(shader);
      // Feed the existing shader with per-instance data; the atlas, lighting,
      // chroma key and gait math stay identical to the individual renderer.
      shader.vertexShader=shader.vertexShader
        .replace('uniform float artTime;','').replace('uniform float artMotion;','')
        .replace('uniform float enemyAttack;','').replace('uniform float enemySide;','')
        .replace(/\bartTime\b/g,'instanceAnimation.x').replace(/\bartMotion\b/g,'instanceAnimation.y')
        .replace(/\benemyAttack\b/g,'instanceAnimation.w').replace(/\benemySide\b/g,'instanceSide');
      const vary='varying vec4 batchRect; varying float batchFlip; varying vec3 batchTheme; varying vec3 batchGlow;\n';
      shader.vertexShader='attribute vec4 instanceArtRect; attribute vec4 instanceAnimation; attribute float instanceSide; attribute vec3 instanceTheme; attribute vec3 instanceGlow;\n'+vary+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        batchRect=instanceArtRect;batchFlip=instanceAnimation.z;batchTheme=instanceTheme;batchGlow=instanceGlow;
      `);
      shader.fragmentShader=shader.fragmentShader
        .replace('uniform vec4 artRect;','').replace('uniform float artFlip;','')
        .replace('uniform vec3 artTheme;','').replace('uniform float artThemeOn;','')
        .replace(/\bartRect\b/g,'batchRect').replace(/\bartFlip\b/g,'batchFlip')
        .replace(/\bartTheme\b/g,'batchTheme').replace(/\bartThemeOn\b/g,'1.0');
      shader.fragmentShader=vary+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance += batchGlow;');
    };
    material.customProgramCacheKey=()=> 'directional-enemy-instanced-v2';
    const mesh=new THREE.InstancedMesh(geometry,material,capacity);
    mesh.name='enemy-batch:'+id;mesh.count=0;mesh.frustumCulled=false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);scene.add(mesh);
    return this.batches[id]={mesh,attributes,capacity,used:0,failed:false,checked:false};
  },

  renderBatches(enemies, scene, camera) {
    for(const batch of Object.values(this.batches))batch.used=0;
    camera.updateMatrixWorld();
    this.batchProjection.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    this.batchFrustum.setFromProjectionMatrix(this.batchProjection);
    if(this.batching && this.canBatch(R.renderer))for(const e of enemies){
      if(e._dead||e.dead||!e.grp.visible||!e.body.visible||!e.artReady)continue;
      e.grp.updateMatrix();e.body.updateMatrix();
      this.batchMatrix.multiplyMatrices(e.grp.matrix,e.body.matrix);
      this.batchSphere.copy(e.body.geometry.boundingSphere);this.batchSphere.radius*=1.12;
      this.batchSphere.applyMatrix4(this.batchMatrix);
      if(e.body.frustumCulled&&!this.batchFrustum.intersectsSphere(this.batchSphere)){e.body.visible=false;continue;}
      const id=e.artTexture,b=this.batches[id];
      if(!b||!b.checked||b.failed)continue;
      if(b.mesh.parent!==scene)scene.add(b.mesh);
      if(b.used>=b.capacity)continue; // Keep individual rendering beyond capacity.
      const i=b.used++,a=e.bodyMat.userData.directional,g=e.bodyMat.userData.gait;
      b.mesh.setMatrixAt(i,this.batchMatrix);
      const rect=a.rect.value;b.attributes.instanceArtRect.setXYZW(i,rect.x,rect.y,rect.z,rect.w);
      b.attributes.instanceAnimation.setXYZW(i,g.time.value,g.motion.value,a.flip.value,a.attack.value);
      b.attributes.instanceSide.setX(i,a.side.value);
      const theme=a.theme.value,k=a.themeOn.value;b.attributes.instanceTheme.setXYZ(i,theme.r*k,theme.g*k,theme.b*k);
      const glow=e.bodyMat.emissive,intensity=e.bodyMat.emissiveIntensity;b.attributes.instanceGlow.setXYZ(i,glow.r*intensity,glow.g*intensity,glow.b*intensity);
      e.body.visible=false;
    }
    for(const b of Object.values(this.batches)){
      b.mesh.count=b.used;b.mesh.visible=b.used>0;
      if(!b.used)continue;
      b.mesh.instanceMatrix.updateRange.offset=0;b.mesh.instanceMatrix.updateRange.count=b.used*16;b.mesh.instanceMatrix.needsUpdate=true;
      for(const a of Object.values(b.attributes)){a.updateRange.offset=0;a.updateRange.count=b.used*a.itemSize;a.needsUpdate=true;}
    }
  }
};
