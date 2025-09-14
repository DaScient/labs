import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { EffectComposer } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/ShaderPass.js';

const canvas = document.getElementById('bg');
const yearEl = document.getElementById('year');
yearEl.textContent = new Date().getFullYear();

// Scene setup
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 100);
camera.position.set(0, 0, 4);

// Hyperspectral shader plane (full-screen)
const uniforms = {
  u_time: { value: 0 },
  u_res: { value: new THREE.Vector2(innerWidth, innerHeight) },
  u_audio: { value: 0.0 },
  u_paletteA: { value: new THREE.Color('#5ec6ff') },
  u_paletteB: { value: new THREE.Color('#6b3df6') },
  u_paletteC: { value: new THREE.Color('#a5ffcb') }
};

const frag = await (await fetch('./shaders/fragment.glsl')).text();
const vert = await (await fetch('./shaders/vertex.glsl')).text();
const material = new THREE.ShaderMaterial({
  uniforms, vertexShader: vert, fragmentShader: frag
});

const geo = new THREE.PlaneGeometry(2, 2);
const mesh = new THREE.Mesh(geo, material);
scene.add(mesh);

// Postprocessing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.8, 0.1);
composer.addPass(bloom);

// Gentle RGB split shader for extra spectral vibe
const rgbShift = {
  uniforms: {
    tDiffuse: { value: null },
    amount: { value: 0.0008 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main(){
      vec2 off = vec2(amount, 0.0);
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      gl_FragColor = vec4(r,g,b,1.0);
    }
  `
};
composer.addPass(new ShaderPass(new THREE.ShaderMaterial(rgbShift)));

// Resize
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  composer.setSize(innerWidth, innerHeight);
  uniforms.u_res.value.set(innerWidth, innerHeight);
});

// Optional audio reactivity (microphone)
let audioEnabled = false;
let analyser, dataArray;
async function enableAudio(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    src.connect(analyser);
    audioEnabled = true;
  }catch(e){ console.warn('Audio blocked', e); }
}

document.getElementById('toggleAudio').addEventListener('click', e=>{
  if(!audioEnabled){ enableAudio(); e.target.classList.add('on'); }
  else { audioEnabled = false; e.target.classList.remove('on'); }
});

// FX toggle
let fxOn = true;
document.getElementById('toggleFx').addEventListener('click', e=>{
  fxOn = !fxOn;
  e.target.classList.toggle('on', fxOn);
});

// Instagram grid
async function loadGallery(){
  try{
    const res = await fetch('./data/insta.json');
    const posts = await res.json();
    const grid = document.getElementById('ig-grid');
    grid.innerHTML = '';
    for(const post of posts){
      const card = document.createElement('article');
      card.className = 'card';
      const a = document.createElement('a');
      a.href = post.url; a.target = '_blank'; a.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'thumb';
      img.loading = 'lazy';
      img.alt = post.title || 'Instagram post';
      img.src = post.thumbnail || 'https://picsum.photos/600?blur=2'; // placeholder
      a.appendChild(img);
      const body = document.createElement('div');
      body.className = 'body';
      const h = document.createElement('h3');
      h.className = 'title'; h.textContent = post.title || '@dascient';
      const meta = document.createElement('div');
      meta.className = 'meta'; meta.textContent = post.meta || 'Instagram â¢ tap to open';
      body.appendChild(h); body.appendChild(meta);
      card.appendChild(a); card.appendChild(body);
      grid.appendChild(card);
    }
  }catch(err){ console.error('Gallery load failed', err); }
}
loadGallery();

// Animation loop
let t0 = performance.now();
function loop(now){
  const dt = (now - t0) * 0.001;
  t0 = now;
  if(audioEnabled && analyser){
    analyser.getByteFrequencyData(dataArray);
    // Emphasize lower bands
    let sum = 0; for(let i=0;i<32;i++) sum += dataArray[i];
    uniforms.u_audio.value = (sum/32)/255.0;
  }else{
    uniforms.u_audio.value *= 0.95; // smooth decay
  }
  uniforms.u_time.value += dt;
  if(fxOn) composer.render(); else renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Lazy-load Instagram embed script when any IG link is clicked (for future inline embeds)
document.addEventListener('click', (e)=>{
  const a = e.target.closest('a[href*="instagram.com/"]');
  if(a){
    const s = document.getElementById('ig-embed');
    if(s && s.dataset.loaded === 'false'){
      s.removeAttribute('data-defer'); s.dataset.loaded = 'true';
    }
  }
});
