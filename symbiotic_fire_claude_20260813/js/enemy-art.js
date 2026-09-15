/* Directional sprites in a 3D world, not full 3D models. Shared geometry/atlases;
 * per-enemy uniforms. Alpha-tested depth preserves building occlusion. */
'use strict';
const ENEMY_ART = {
  textures: {}, geometryCache: null,
  geometry() {
    if (!this.geometryCache) {
      const g = new THREE.PlaneGeometry(1, 1, 8, 18);
      g.translate(0, .5, 0); g.computeBoundingSphere(); this.geometryCache = g;
    }
    return this.geometryCache;
  },
  texture(id) {
    if (!this.textures[id]) {
      const t = new THREE.TextureLoader().load('assets/enemies/' + id + '.png');
      t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
      // Chroma keys must not mix with silhouettes across mip levels.
      t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; this.textures[id] = t;
    }
    return this.textures[id];
  },
  configure(e, id) {
    const m = e.bodyMat;
    e.artKind = id; e.artView = -1;
    e.body.geometry = this.geometry();
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
          float chest = step(.59,vUv.y)*step(vUv.y,.83)*step(abs(vUv.x-.5),.23);
          painted.rgb += artTheme * artThemeOn * chest * .26;
          diffuseColor *= painted;
        `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', `
          outgoingLight = mix(diffuseColor.rgb, outgoingLight, ${TUNE.ART.enemyMotion.lighting.toFixed(3)}) + totalEmissiveRadiance * .55;
          #include <output_fragment>
        `);
      };
      m.customProgramCacheKey = () => 'directional-enemy-gait-v1';
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
    e.body.visible = !!e.bodyMat.map.image;
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
  }
};
