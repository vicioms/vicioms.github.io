'use strict';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

// ---- three-mesh-bvh (massive raycast speedups) ----
import {
  MeshBVH,
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree
} from 'https://unpkg.com/three-mesh-bvh@0.7.7/build/index.module.js';
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

// ---------- Globals ----------
let scene, camera, renderer, controls;
let points = null;       // point layer (always used for annotation)
let mesh = null;         // optional triangle mesh layer (context)
let geom = null;         // current THREE.BufferGeometry

let positions, colors, labels, baseColors;

const statusEl = document.getElementById('status');
const rectEl = document.getElementById('rect');
const selectEl = document.getElementById('cloud-select');
const brushCursor = document.getElementById('brushCursor');

const DEFAULT_LABEL = -1;
const DEFAULT_COLOR = [0.70, 0.75, 0.82];
let palette = [
  [1.0,0.0,0.0], [0.0,1.0,0.0], [0.0,0.4,1.0], [1.0,1.0,0.0], [0.0,1.0,1.0],
  [1.0,0.0,1.0], [1.0,0.5,0.0], [0.6,0.0,1.0], [0.5,0.5,0.5], [1.0,1.0,1.0]
];
let selection = new Set();

// Point size & brush
let pointSize = 8; // px
let brushEnabled = false;
let brushing = false;
let brushRadius = 40; // px

// Selection box state
let isDrag = false, sx = 0, sy = 0, selMode = 'add';

// Files map
// fileMap[key] = { geometry, kind: 'mesh'|'points', labels: Int32Array }
const fileMap = {};
let currentFile = null;

// Mesh visibility
let meshVisible = true;

// ---- Occlusion (visible-only) ----
let visibleOnly = false;                  // default ON when mesh exists
const raycaster = new THREE.Raycaster();
const EPS = 1e-3;

// ---- Screen projection + grid binning ----
let projDirty = true;
let sxArr = null;   // Float32Array screen X per point
let syArr = null;   // Float32Array screen Y per point
let grid = null;    // Array< number[] >
let gridCols = 0, gridRows = 0;
const CELL = 16;    // px per grid cell (raise to 24/32 for more speed)

// ---------- Init ----------
init();
animate();

function init(){
  const container = document.getElementById('viewport');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  const toolbar = document.querySelector('.toolbar');
  const H = window.innerHeight - (toolbar ? toolbar.offsetHeight : 0);
  renderer.setSize(window.innerWidth, H);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth/H, 0.01, 2000);
  camera.position.set(1,1,1);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // mark projections dirty when camera moves/resizes
  controls.addEventListener('change', () => { projDirty = true; });
  window.addEventListener('resize', () => { projDirty = true; });

  // Lights & axes
  const ambient = new THREE.AmbientLight(0xffffff, 0.6); scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6); dir.position.set(1,1,1); scene.add(dir);
  const axes = new THREE.AxesHelper(0.2); axes.material.depthTest = false; axes.renderOrder = 999; scene.add(axes);

  // UI events
  window.addEventListener('resize', onResize);
  document.getElementById('folder-input').addEventListener('change', handleFolder);
  document.getElementById('btn-save-progress').onclick = saveProgress;
  document.getElementById('btn-load-progress').onclick = loadProgress;
  document.getElementById('btn-export-autosave').onclick = exportAutosave;
  document.getElementById('btn-reset-ann').onclick = resetAnnotations;
  document.getElementById('btn-fit').onclick = fitToGeometry;
  document.getElementById('btn-clear').onclick = ()=>{ selection.clear(); updateSelHighlight(); };
  selectEl.addEventListener('change', e => switchCloud(e.target.value));

  // Toggle Mesh button
  const toggleMeshBtn = document.getElementById('btn-toggle-mesh');
  if (toggleMeshBtn) {
    toggleMeshBtn.onclick = () => {
      meshVisible = !meshVisible;
      if (mesh) mesh.visible = meshVisible;
      statusEl.textContent = meshVisible ? 'Mesh: visible' : 'Mesh: hidden';
    };
  }

  // Labels
  populateLabelDropdown();
  document.getElementById('btn-add-label').onclick = () => { addLabel(); };
  document.getElementById('btn-apply-label').onclick = () => {
    const v = parseInt(document.getElementById('label-select').value, 10);
    assignLabel(v);
  };

  // Point size slider
  const sizeSlider = document.getElementById('size-slider');
  const sizeVal = document.getElementById('size-val');
  pointSize = parseFloat(sizeSlider.value);
  sizeVal.textContent = String(pointSize);
  sizeSlider.addEventListener('input', ()=>{
    pointSize = parseFloat(sizeSlider.value);
    sizeVal.textContent = String(pointSize);
    applyPointSize();
  });

  // Brush UI
  const brushToggle = document.getElementById('brush-enable');
  const brushR = document.getElementById('brush-radius');
  const brushRVal = document.getElementById('brush-radius-val');
  brushRVal.textContent = String(brushRadius);
  brushR.addEventListener('input', ()=>{
    brushRadius = parseInt(brushR.value,10);
    brushRVal.textContent = String(brushRadius);
    updateBrushCursorSize();
  });
  brushToggle.addEventListener('change', ()=>{
    brushEnabled = brushToggle.checked;
    updateBrushCursorVisibility();
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key==='b'||e.key==='B'){
      brushToggle.checked = !brushToggle.checked;
      brushEnabled = brushToggle.checked;
      updateBrushCursorVisibility();
    }
  });

  // Selection & brush events
  renderer.domElement.addEventListener('mousedown', onCanvasMouseDown);
  window.addEventListener('mousemove', onCanvasMouseMove);
  window.addEventListener('mouseup', onCanvasMouseUp);
  window.addEventListener('keydown', onKeyDown);
  renderer.domElement.addEventListener('mousemove', onBrushHover, {passive:false});

  // Visible-only checkbox in sidebar
  const sidebar = document.getElementById('sidebar');
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '8px';
  const label = document.createElement('label');
  label.className = 'soft';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'cb-visible-only';
  cb.checked = visibleOnly;
  cb.onchange = () => {
    visibleOnly = cb.checked;
    statusEl.textContent = `Annotate ${visibleOnly ? 'visible' : 'all'} points${mesh ? ' (mesh loaded)':''}`;
  };
  label.appendChild(cb);
  label.appendChild(document.createTextNode(' Annotate only visible points'));
  row.appendChild(label);
  sidebar.appendChild(row);

  updateBrushCursorSize();
}

function onResize(){
  const toolbar = document.querySelector('.toolbar');
  const H = window.innerHeight - (toolbar ? toolbar.offsetHeight : 0);
  camera.aspect = window.innerWidth/H; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, H);
}

function animate(){
  requestAnimationFrame(animate);
  if (projDirty) rebuildProjectionGrid();
  controls.update();
  renderer.render(scene, camera);
}

// ---------- Folder loading ----------
function handleFolder(e){
  const all = Array.from(e.target.files || []);
  const files = all.filter(f => /\.(ply)$/i.test(f.name));
  files.sort((a,b) => a.name.localeCompare(b.name));
  selectEl.innerHTML = '';
  if (all.length === 0){ statusEl.textContent = 'No files returned by folder picker.'; return; }
  if (files.length === 0){ statusEl.textContent = `Found ${all.length} files, but no *.ply.`; alert('No PLY files found.'); return; }
  files.forEach(f => {
    const key = f.webkitRelativePath || f.name;
    const opt = document.createElement('option');
    opt.value = key; opt.textContent = key;
    selectEl.appendChild(opt);
    loadPLY(f, key);
  });
  const firstKey = files[0].webkitRelativePath || files[0].name;
  currentFile = firstKey;
  statusEl.textContent = `Loaded file list: ${files.length} PLYs`;
}

function loadPLY(file, key){
  const reader = new FileReader();
  const loader = new PLYLoader();
  reader.onload = e => {
    try {
      const g = loader.parse(e.target.result);
      const idx = g.getIndex();
      const isMesh = !!(idx && idx.count > 0);

      if (isMesh) {
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        const N = g.getAttribute('position').count;
        const L = new Int32Array(N).fill(DEFAULT_LABEL);
        fileMap[key] = { geometry: g, kind: 'mesh', labels: L };
      } else {
        const N = g.getAttribute('position').count;
        const L = new Int32Array(N).fill(DEFAULT_LABEL);
        fileMap[key] = { geometry: g, kind: 'points', labels: L };
      }

      if ((!points && !mesh) || currentFile===key) switchCloud(key);
    } catch(err){
      console.error('Failed to parse', key, err);
      statusEl.textContent = `Failed to parse ${key}`;
    }
  };
  reader.readAsArrayBuffer(file);
}

// ---------- Switch / Dispose ----------
function disposeCurrent(){
  if (points){
    scene.remove(points);
    points.geometry.dispose();
    points.material.dispose();
    points = null;
  }
  if (mesh){
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh = null;
  }
  if (geom && geom.disposeBoundsTree) { try{ geom.disposeBoundsTree(); }catch{} }
  geom = null;
  positions = colors = labels = baseColors = null;
  selection.clear();
  projDirty = true; grid = null; sxArr = syArr = null;
}

function switchCloud(key){
  const entry = fileMap[key];
  if(!entry){ statusEl.textContent = `Waiting for ${key} to parse…`; return; }
  currentFile = key;

  disposeCurrent();

  geom = entry.geometry;

  // Mesh layer (if present)
  if (entry.kind === 'mesh') {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x86a1b3,
      vertexColors: false,
      metalness: 0.0,
      roughness: 1.0,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      transparent: true,
      opacity: 0.9
    });
    mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = true;
    mesh.visible = meshVisible;
    // Build BVH for fast visibility raycasts
    geom.computeBoundsTree();
    scene.add(mesh);
  }

  // Points overlay
  positions = geom.getAttribute('position').array;
  labels    = entry.labels;
  colors     = new Float32Array(positions.length);
  baseColors = new Float32Array(positions.length);

  for(let i=0;i<labels.length;i++){
    const lab = labels[i];
    const c = (lab>=0 ? palette[lab % palette.length] : DEFAULT_COLOR);
    const j=i*3;
    colors[j]=c[0]; colors[j+1]=c[1]; colors[j+2]=c[2];
    baseColors[j]=colors[j]; baseColors[j+1]=colors[j+1]; baseColors[j+2]=colors[j+2];
  }

  geom.setAttribute('color', new THREE.BufferAttribute(colors,3));

  points = new THREE.Points(geom, new THREE.PointsMaterial({
    size: pointSize,
    sizeAttenuation: false,
    vertexColors: true
  }));
  points.frustumCulled = false;
  scene.add(points);

  // visible-only default: ON if mesh exists
  visibleOnly = !!mesh;
  const cb = document.getElementById('cb-visible-only');
  if (cb) cb.checked = visibleOnly;

  applyPointSize();
  fitToGeometry();
  resumeAutosave();

  // init projection buffers
  setupProjectionBuffers();
  projDirty = true;

  statusEl.textContent = entry.kind === 'mesh'
    ? `Loaded mesh + points overlay: ${key}`
    : `Loaded point cloud: ${key}`;
}

function applyPointSize(){
  if(points){
    points.material.size = pointSize;
    points.material.sizeAttenuation = false;
    points.material.needsUpdate = true;
  }
}

function fitToGeometry(){
  if(!geom) return;
  geom.computeBoundingSphere();
  const bs = geom.boundingSphere;
  const d = Math.max(0.5, bs.radius) * 3.2;
  camera.position.set(bs.center.x + d, bs.center.y + d, bs.center.z + d);
  controls.target.copy(bs.center);
  controls.update();
}

// ---------- Projection grid helpers ----------
function setupProjectionBuffers(){
  if (!geom) return;
  const N = geom.getAttribute('position').count;
  sxArr = new Float32Array(N);
  syArr = new Float32Array(N);
  grid = []; gridCols = gridRows = 0;
}

function rebuildProjectionGrid(){
  if (!points || !geom) return;

  const pos = positions;
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;

  gridCols = Math.ceil(w / CELL);
  gridRows = Math.ceil(h / CELL);
  grid = new Array(gridCols * gridRows);
  for (let i=0;i<grid.length;i++) grid[i] = [];

  const view = camera.matrixWorldInverse;
  const proj = camera.projectionMatrix;
  const v = new THREE.Vector3();

  for (let i=0, j=0; i<pos.length; i+=3, j++){
    v.set(pos[i], pos[i+1], pos[i+2]);
    v.applyMatrix4(points.matrixWorld);
    v.applyMatrix4(view).applyMatrix4(proj);

    const sx = (v.x * 0.5 + 0.5) * w;
    const sy = (-v.y * 0.5 + 0.5) * h;
    sxArr[j] = sx;
    syArr[j] = sy;

    const cx = (sx / CELL) | 0;
    const cy = (sy / CELL) | 0;
    if (cx>=0 && cy>=0 && cx<gridCols && cy<gridRows){
      grid[cy*gridCols + cx].push(j);
    }
  }
  projDirty = false;
}

function forEachPointInCircle(cx, cy, r, cb){
  if (!grid) return;

  const minx = Math.max(0, ((cx - r) / CELL) | 0);
  const maxx = Math.min(gridCols-1, ((cx + r) / CELL) | 0);
  const miny = Math.max(0, ((cy - r) / CELL) | 0);
  const maxy = Math.min(gridRows-1, ((cy + r) / CELL) | 0);

  const r2 = r*r;
  for (let gy=miny; gy<=maxy; gy++){
    for (let gx=minx; gx<=maxx; gx++){
      const cell = grid[gy*gridCols + gx];
      for (let k=0; k<cell.length; k++){
        const idx = cell[k];
        const dx = sxArr[idx] - cx;
        const dy = syArr[idx] - cy;
        if (dx*dx + dy*dy <= r2) cb(idx);
      }
    }
  }
}

// ---------- Visibility helper ----------
function isWorldPointVisible(worldPos){
  if (!mesh || !visibleOnly) return true;
  const dir = new THREE.Vector3().subVectors(worldPos, camera.position).normalize();
  raycaster.set(camera.position, dir);
  const hits = raycaster.intersectObject(mesh, false);
  if (hits.length === 0) return true;
  const hitDist = hits[0].distance;
  const ptDist  = camera.position.distanceTo(worldPos);
  return ptDist <= hitDist + EPS;
}

// ---------- Selection & labeling ----------
function onCanvasMouseDown(e){
  if(!points) return;

  // Brush painting
  if(brushEnabled && !e.shiftKey){
    if(controls) controls.enabled = false;
    e.preventDefault(); e.stopPropagation();
    brushing = true;
    brushAt(e.clientX, e.clientY, e);
    return;
  }

  // Rectangle with Shift/Alt
  if(!(e.shiftKey || e.altKey)) return;
  if(controls) controls.enabled = false;
  if(e.stopImmediatePropagation) e.stopImmediatePropagation();
  e.stopPropagation(); e.preventDefault();

  isDrag = true;
  selMode = e.altKey ? 'sub' : 'add';
  sx = e.clientX; sy = e.clientY;
  rectEl.style.left = sx+'px';
  rectEl.style.top = sy+'px';
  rectEl.style.width = '0px';
  rectEl.style.height = '0px';
  rectEl.style.display = 'block';
}

function onCanvasMouseMove(e){
  if(!points) return;

  if(brushing){
    e.preventDefault(); e.stopPropagation();
    brushAt(e.clientX, e.clientY, e);
    return;
  }
  if(!isDrag) return;
  e.preventDefault(); e.stopPropagation();
  const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
  const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
  rectEl.style.left = x+'px'; rectEl.style.top = y+'px';
  rectEl.style.width = w+'px'; rectEl.style.height = h+'px';
}

function onCanvasMouseUp(e){
  if(!points) return;

  if(brushing){
    brushing = false;
    if(controls) controls.enabled = true;
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if(!isDrag) return;
  if(controls) controls.enabled = true;
  e.preventDefault(); e.stopPropagation();
  isDrag = false; rectEl.style.display = 'none';
  const x0 = Math.min(sx, e.clientX), y0 = Math.min(sy, e.clientY);
  const x1 = Math.max(sx, e.clientX), y1 = Math.max(sy, e.clientY);
  if(Math.abs(x1-x0) < 2 || Math.abs(y1-y0) < 2) return;
  boxSelect(x0,y0,x1,y1, selMode);
}

function boxSelect(x0,y0,x1,y1, mode){
  if(!positions || !points) return;

  if (projDirty) rebuildProjectionGrid();

  const X0 = Math.min(x0,x1), X1 = Math.max(x0,x1);
  const Y0 = Math.min(y0,y1), Y1 = Math.max(y0,y1);

  const minx = Math.max(0, (X0 / CELL) | 0);
  const maxx = Math.min(gridCols-1, (X1 / CELL) | 0);
  const miny = Math.max(0, (Y0 / CELL) | 0);
  const maxy = Math.min(gridRows-1, (Y1 / CELL) | 0);

  const v = new THREE.Vector3();
  let hit = 0;

  for (let gy=miny; gy<=maxy; gy++){
    for (let gx=minx; gx<=maxx; gx++){
      const cell = grid[gy*gridCols + gx];
      for (let k=0;k<cell.length;k++){
        const j = cell[k];
        const sxp = sxArr[j], syp = syArr[j];
        if (sxp >= X0 && sxp <= X1 && syp >= Y0 && syp <= Y1){
          v.set(positions[j*3], positions[j*3+1], positions[j*3+2]).applyMatrix4(points.matrixWorld);
          if (!isWorldPointVisible(v)) continue;
          if(mode==='add') selection.add(j); else selection.delete(j);
          hit++;
        }
      }
    }
  }
  updateSelHighlight();
  statusEl.textContent = `${mode==='add'?'Added':'Removed'} — selected now: ${selection.size} (Δ ${hit})`;
}

function updateSelHighlight(){
  if(!colors || !baseColors || !geom) return;
  colors.set(baseColors);
  const SEL1=[1.0,1.0,0.0], SEL2=[1.0,0.0,1.0];
  let t=0;
  selection.forEach(idx=>{
    const j=idx*3; const s=(t++%2===0)?SEL1:SEL2;
    colors[j]=s[0]; colors[j+1]=s[1]; colors[j+2]=s[2];
  });
  geom.getAttribute('color').needsUpdate = true;
}

function onKeyDown(e){
  if(!labels) return;
  if(e.key==='b'||e.key==='B') return;
  if(e.key>='0'&&e.key<='9'){
    const idx=parseInt(e.key,10);
    ensureLabelIndex(idx);
    assignLabel(idx);
  } else if(e.key==='c'||e.key==='C'){
    selection.clear(); updateSelHighlight();
  } else if(e.key==='f'||e.key==='F'){
    fitToGeometry();
  } else if(e.key==='x'||e.key==='X'){
    assignLabel(-1);
  }
}

function assignLabel(L){
  if(selection.size===0 && !brushing){ statusEl.textContent = 'No selection'; return; }
  selection.forEach(idx=>{
    labels[idx]=L;
    const c=(L>=0? palette[L%palette.length] : DEFAULT_COLOR);
    const j=idx*3;
    baseColors[j]=c[0]; baseColors[j+1]=c[1]; baseColors[j+2]=c[2];
  });
  selection.clear();
  updateSelHighlight();
  autosaveLabels();
}

// ---------- Label helpers ----------
function populateLabelDropdown(){
  const sel = document.getElementById('label-select');
  sel.innerHTML='';
  const optE=document.createElement('option');
  optE.value='-1'; optE.textContent='Erase (-1)'; sel.appendChild(optE);
  for(let i=0;i<palette.length;i++){
    const opt=document.createElement('option');
    opt.value=String(i); opt.textContent=`Label ${i}`;
    sel.appendChild(opt);
  }
  sel.value='0';
}
function addLabel(){
  const i=palette.length;
  const c=generateVividColor(i);
  palette.push(c);
  populateLabelDropdown();
  statusEl.textContent=`Added label ${i}`;
}
function ensureLabelIndex(i){ while(i>=palette.length){ addLabel(); } }
function generateVividColor(i){
  const hue=(i*137.508)%360; const s=0.9,l=0.55;
  return hslToRgb01(hue,s,l);
}
function hslToRgb01(h,s,l){
  const c=(1-Math.abs(2*l-1))*s;
  const x=c*(1-Math.abs((h/60)%2-1));
  const m=l-c/2; let r=0,g=0,b=0;
  if(0<=h&&h<60){r=c;g=x;b=0;}
  else if(60<=h&&h<120){r=x;g=c;b=0;}
  else if(120<=h&&h<180){r=0;g=c;b=x;}
  else if(180<=h&&h<240){r=0;g=x;b=c;}
  else if(240<=h&&h<300){r=x;g=0;b=c;}
  else {r=c;g=0;b=x;}
  return [r+m,g+m,b+m];
}

// ---------- Autosave / Resume ----------
function storageKey(){
  if(!currentFile || !positions) return null;
  const N = positions.length/3;
  return `anno:${currentFile}:N=${N}`;
}
function autosaveLabels(){
  const key=storageKey(); if(!key||!labels) return;
  try{ localStorage.setItem(key, JSON.stringify(Array.from(labels))); }
  catch(e){ console.warn('Autosave failed', e); }
}
function resumeAutosave(){
  const key=storageKey(); if(!key||!labels) return;
  try{
    const raw=localStorage.getItem(key);
    if(!raw) return;
    const arr=JSON.parse(raw);
    if(Array.isArray(arr)&&arr.length===labels.length){
      labels.set(arr);
      for(let i=0,j=0;i<labels.length;i++,j+=3){
        const L=labels[i];
        const c=(L>=0? palette[L%palette.length] : DEFAULT_COLOR);
        baseColors[j]=c[0]; baseColors[j+1]=c[1]; baseColors[j+2]=c[2];
        colors[j]=baseColors[j]; colors[j+1]=baseColors[j+1]; colors[j+2]=baseColors[j+2];
      }
      geom.getAttribute('color').needsUpdate=true;
      statusEl.textContent=`Resumed autosave for ${currentFile}`;
    }
  }catch(e){ console.warn('Resume failed', e); }
}

// ---------- Save/Load + Export + Reset ----------
function saveProgress(){
  const data={};
  for(const k in fileMap){
    const entry = fileMap[k];
    if(entry.labels) data[k]=Array.from(entry.labels);
  }
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='annotations.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),0);
}

function loadProgress(){
  const input=document.createElement('input');
  input.type='file'; input.accept='application/json';
  input.onchange=e=>{
    const f=e.target.files[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{
      try{
        const obj=JSON.parse(r.result);
        for(const k in obj){
          const entry = fileMap[k];
          if(entry && Array.isArray(obj[k]) && obj[k].length===entry.labels.length){
            entry.labels.set(obj[k]);
          }
        }
        if(currentFile) switchCloud(currentFile);
        autosaveLabels();
        statusEl.textContent='Progress loaded';
      }catch(err){
        alert('Invalid JSON'); console.error(err);
      }
    };
    r.readAsText(f);
  };
  input.click();
}

function exportAutosave(){
  const data={};
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(k && k.startsWith('anno:')){
      try{ data[k]=JSON.parse(localStorage.getItem(k)); }
      catch(e){ console.warn('skip',k); }
    }
  }
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='autosave_annotations.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),0);
  statusEl.textContent='Exported autosave_annotations.json';
}

function resetAnnotations(){
  if(!labels || !geom){ alert('No geometry loaded.'); return; }
  const ok=confirm('Reset annotations for current geometry? This cannot be undone.');
  if(!ok) return;
  for(let i=0;i<labels.length;i++) labels[i]=DEFAULT_LABEL;
  for(let i=0,j=0;i<labels.length;i++,j+=3){
    baseColors[j]=DEFAULT_COLOR[0];
    baseColors[j+1]=DEFAULT_COLOR[1];
    baseColors[j+2]=DEFAULT_COLOR[2];
    colors[j]=baseColors[j]; colors[j+1]=baseColors[j+1]; colors[j+2]=baseColors[j+2];
  }
  if(geom.getAttribute('color')) geom.getAttribute('color').needsUpdate = true;
  selection.clear();
  autosaveLabels();
  statusEl.textContent='Annotations reset for current file';
}

// ---------- Brush cursor ----------
function updateBrushCursorVisibility(){
  brushCursor.style.display = brushEnabled ? 'block' : 'none';
}
function updateBrushCursorSize(){
  brushCursor.style.width=(brushRadius*2)+'px';
  brushCursor.style.height=(brushRadius*2)+'px';
  brushCursor.style.marginLeft=(-brushRadius)+'px';
  brushCursor.style.marginTop=(-brushRadius)+'px';
}
function onBrushHover(e){
  if(!brushEnabled){ brushCursor.style.display='none'; return; }
  updateBrushCursorVisibility();
  brushCursor.style.left=e.clientX+'px';
  brushCursor.style.top=e.clientY+'px';
}
function brushAt(screenX, screenY, e){
  if(!positions || !points) return;
  if (projDirty) rebuildProjectionGrid();

  const rect = renderer.domElement.getBoundingClientRect();
  const x = screenX - rect.left;
  const y = screenY - rect.top;

  const erase = e.altKey || (parseInt(document.getElementById('label-select').value,10) === -1);
  const L = erase ? -1 : parseInt(document.getElementById('label-select').value,10);
  if(!erase) ensureLabelIndex(L);
  const col = erase ? DEFAULT_COLOR : palette[L % palette.length];

  const v = new THREE.Vector3();

  forEachPointInCircle(x, y, brushRadius, (j)=>{
    v.set(positions[j*3], positions[j*3+1], positions[j*3+2]).applyMatrix4(points.matrixWorld);
    if (!isWorldPointVisible(v)) return;
    labels[j]=L;
    const base=j*3;
    baseColors[base]=col[0]; baseColors[base+1]=col[1]; baseColors[base+2]=col[2];
    colors[base]=col[0];     colors[base+1]=col[1];     colors[base+2]=col[2];
  });

  geom.getAttribute('color').needsUpdate = true;
  autosaveLabels();
}