/* SpiralCam — статичний вебзастосунок без фреймворків та серверної частини. */
'use strict';
const $ = (id) => document.getElementById(id);
const RATIO_OPTIONS = ['4:5','1:1','3:4','9:16','16:9'];
const PHI = (1 + Math.sqrt(5)) / 2;
const SPIRAL_GROWTH = 2 * Math.log(PHI) / Math.PI; // радіус змінюється у φ разів за чверть оберту
const state = {
  screen: 'home', stream: null, facing: 'environment', torch: false, torchSupported: false,
  ratio: '4:5', rotation: 0, flipped: false, scale: 1, grid: false, smart: false,
  color: 'gold', lineWidth: 2.2, target: null, sensor: null, sensorAllowed: false,
  sensorStarted: false, sensorListenerAdded: false, sensorDenied: false, gallery: [],
  projectedTarget: null, lastOrientationDraw: 0, previewRecoveryId: 0,
  selectedPhoto: null, selectedVersion: 'guided', db: null, memoryPhotos: [],
  currentPreviewUrl: null, gridUrls: [], lastThumbnailUrl: null,
};
let toastTimer;
let drawQueued = false;
let cameraRequestId = 0;
const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
const video = $('cameraVideo');
const viewfinder = $('viewfinder');
const guideCanvas = $('guideCanvas');
const previewCanvas = $('previewCanvas');
const cameraWorkspace = document.querySelector('.camera-workspace');
let previewFrameId = 0;
let lastPreviewPaint = -Infinity;
const PREVIEW_FRAME_INTERVAL = 1000 / 28;

/* Відео залишаємо джерелом MediaStream, але показуємо Canvas.
 * У Safari після модального перегляду фото нативний шар <video> іноді
 * масштабується неправильно. Canvas малює кадр точно в межах рамки. */
function paintCameraPreview(timestamp, force=false) {
  if(state.screen!=='camera' || !state.stream || document.hidden) return;
  if(!force && timestamp-lastPreviewPaint < PREVIEW_FRAME_INTERVAL) return;
  if(video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
  const w=viewfinder.clientWidth, h=viewfinder.clientHeight;
  if(w<2||h<2) return;
  const dpr=Math.min(2,window.devicePixelRatio||1,Math.sqrt(1350000/(w*h)));
  const pw=Math.max(1,Math.round(w*dpr)),ph=Math.max(1,Math.round(h*dpr));
  if(previewCanvas.width!==pw||previewCanvas.height!==ph){previewCanvas.width=pw;previewCanvas.height=ph;}
  try {
    const ctx=previewCanvas.getContext('2d',{alpha:false});
    const source=cropSource(video.videoWidth,video.videoHeight,pw,ph);
    ctx.save();
    try {
      ctx.setTransform(1,0,0,1,0,0);
      if(state.facing==='user'){ctx.translate(pw,0);ctx.scale(-1,1);}
      ctx.drawImage(video,source.sx,source.sy,source.sw,source.sh,0,0,pw,ph);
    } finally { ctx.restore(); }
    previewCanvas.classList.add('has-frame');
    lastPreviewPaint=timestamp;
  }catch(e) {
    // Safari іноді тимчасово не дає кадр відразу після розблокування.
    previewCanvas.classList.remove('has-frame');
  }
}
function previewLoop(timestamp){
  previewFrameId=0;
  if(state.screen!=='camera'||!state.stream||document.hidden) return;
  paintCameraPreview(timestamp);
  previewFrameId=requestAnimationFrame(previewLoop);
}
function startPreviewLoop(){
  if(previewFrameId||state.screen!=='camera'||!state.stream||document.hidden)return;
  previewFrameId=requestAnimationFrame(previewLoop);
}
function stopPreviewLoop(){
  if(previewFrameId)cancelAnimationFrame(previewFrameId);
  previewFrameId=0;lastPreviewPaint=-Infinity;
  previewCanvas.classList.remove('has-frame');
}
function layoutViewfinder(){
  if(state.screen!=='camera'||!cameraWorkspace)return;
  const style=getComputedStyle(cameraWorkspace);
  const availableW=Math.max(0,cameraWorkspace.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
  const availableH=Math.max(0,cameraWorkspace.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom));
  if(availableW<10||availableH<10)return;
  const ratio=ratioFloat(state.ratio);
  const width=Math.max(1,Math.floor(Math.min(availableW,availableH*ratio)));
  const height=Math.max(1,Math.floor(Math.min(availableH,width/ratio)));
  viewfinder.style.width=width+'px';
  viewfinder.style.height=height+'px';
  viewfinder.style.aspectRatio='auto';
  paintCameraPreview(performance.now(),true);
  requestDraw();
}


function toast(message) {
  const el = $('toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
function setIcon(button, symbol) {
  button.querySelector('use')?.setAttribute('href', '#' + symbol);
}
function limit(n, low, high) { return Math.max(low, Math.min(high, n)); }
function wrapDegrees(value) { return (value + 540) % 360 - 180; }
function ratioFloat(ratio) { const [a,b] = ratio.split(':').map(Number); return a / b; }

function showScreen(screen) {
  if (state.screen === 'camera' && screen !== 'camera') stopCamera();
  state.screen = screen;
  for (const [name,id] of [['home','homeScreen'],['camera','cameraScreen'],['ideas','ideasScreen']]) {
    $(id).hidden = name !== screen;
  }
  if (screen === 'camera') {
    syncCameraLayout();
    requestAnimationFrame(() => { requestDraw(); startCamera(); });
  } else if (screen === 'home') requestAnimationFrame(drawHero);
  else if (screen === 'ideas') requestAnimationFrame(()=>{drawIdeas();drawIdeaExampleGuides();});
}

/* Золотий логарифмічний завиток + квадрати Фібоначчі. У навчальній фотографії
 * таку гладку криву зазвичай використовують як наближення спіралі Фібоначчі. */
function guideEye(w, h, rotation=state.rotation, flipped=state.flipped) {
  const p = [ [0.73, 0.68], [0.32, 0.72], [0.27, 0.33], [0.72, 0.29] ][((rotation % 4) + 4) % 4];
  return {x: (flipped ? 1 - p[0] : p[0]) * w, y: p[1] * h};
}
function fibonacciSquares(ctx, w, opts) {
  const unit = w * .72 / 55;
  let box = {left:0, top:0, right:2, bottom:1};
  let tiles = [{x:0,y:0,s:1},{x:1,y:0,s:1}];
  const fibonacci = [2,3,5,8,13,21,34,55];
  fibonacci.forEach((s, index) => {
    let x,y;
    switch (index % 4) {
      case 0: x=box.left;y=box.bottom;box.bottom+=s;break;
      case 1: x=box.left-s;y=box.top;box.left-=s;break;
      case 2: x=box.left;y=box.top-s;box.top-=s;break;
      default: x=box.right;y=box.top;box.right+=s;
    }
    tiles.push({x,y,s});
  });
  ctx.save();
  ctx.lineWidth = Math.max(.8,w/380*.9);
  ctx.strokeStyle=opts.ready?'rgba(105,236,174,.4)':opts.color==='white'?'rgba(255,255,255,.40)':'rgba(239,201,135,.42)';
  for (const tile of tiles) ctx.strokeRect((tile.x-1)*unit,(tile.y-1)*unit,tile.s*unit,tile.s*unit);
  ctx.restore();
}
function renderGuide(ctx, w, h, opts={}) {
  const settings = {
    rotation: opts.rotation ?? state.rotation, flipped: opts.flipped ?? state.flipped,
    scale: opts.scale ?? state.scale, grid: opts.grid ?? state.grid,
    color: opts.color ?? state.color, lineWidth: opts.lineWidth ?? state.lineWidth,
    ready: opts.ready ?? false,
  };
  const eye = opts.anchor ? {x: opts.anchor.x*w,y: opts.anchor.y*h} : guideEye(w,h,settings.rotation,settings.flipped);
  ctx.save();
  ctx.translate(eye.x,eye.y);
  ctx.rotate(settings.rotation*Math.PI/2);
  ctx.scale((settings.flipped?-1:1)*settings.scale,settings.scale);
  if (settings.grid) fibonacciSquares(ctx,w,settings);
  ctx.beginPath();
  // Від внутрішнього завитка до зовнішньої дуги. Поворот забезпечує 4 композиції.
  for (let i=0;i<=720;i++) {
    const theta = 5*Math.PI*i/720;
    const radius = w*.76*Math.exp(SPIRAL_GROWTH*(theta-5*Math.PI));
    const x=radius*Math.cos(-theta), y=radius*Math.sin(-theta);
    if(i===0)ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  const base = settings.ready?'#7ef0b0':settings.color==='white'?'#f3f3ed':'#f4d29a';
  ctx.strokeStyle=base;
  ctx.lineWidth=Math.max(1,w/320*settings.lineWidth);
  ctx.lineJoin='round';ctx.lineCap='round';
  ctx.shadowColor=base;ctx.shadowBlur=w*.014;
  ctx.stroke(); ctx.shadowBlur=0;
  ctx.beginPath();ctx.arc(0,0,Math.max(3,w*.011),0,Math.PI*2);
  ctx.fillStyle=base;ctx.fill();
  ctx.restore();
  return eye;
}
function canvasContext(canvas, cssWidth, cssHeight, dpr) {
  const scale = dpr || Math.min(2.4,window.devicePixelRatio||1);
  canvas.width=Math.max(1,Math.round(cssWidth*scale));
  canvas.height=Math.max(1,Math.round(cssHeight*scale));
  const ctx=canvas.getContext('2d');
  ctx.setTransform(scale,0,0,scale,0,0);
  ctx.clearRect(0,0,cssWidth,cssHeight);
  return ctx;
}
function drawHero() {
  const canvas = $('heroCanvas'); const r=canvas.getBoundingClientRect();
  if (!r.width||!r.height) return;
  const ctx=canvasContext(canvas,r.width,r.height);
  // Спіраль малюється поверх справжнього фото, як у фотокамері.
  // Завиток спрямовано на око лисиці в центральній композиції.
  ctx.globalAlpha=.86;
  renderGuide(ctx,r.width,r.height,{anchor:{x:.72,y:.38},grid:false,rotation:1,scale:.77,color:'white',lineWidth:1.45});
}
function drawIdeas() {
  const canvas=$('ideasCanvas'); const r=canvas.getBoundingClientRect();
  if(!r.width||!r.height) return;
  const ctx=canvasContext(canvas,r.width,r.height);
  renderGuide(ctx,r.width,r.height,{anchor:{x:.68,y:.34},grid:false,rotation:1,scale:.88,color:'white',lineWidth:1.65});
}
/* Просторова геометрія: відносний поворот кватерніона замість незалежних
 * alpha/beta/gamma. Кут 359°→0° проходить без стрибка, а нахили не плутаються
 * з курсом. Стабілізація приглушує шум сенсорів. */
function quatMultiply(a,b){
  const [x,y,z,w]=a,[X,Y,Z,W]=b;
  return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z];
}
function quatConjugate(q){return [-q[0],-q[1],-q[2],q[3]];}
function orientationQuaternion(alpha,beta,gamma){
  const a=alpha*Math.PI/360,b=beta*Math.PI/360,c=gamma*Math.PI/360;
  const qz=[0,0,Math.sin(a),Math.cos(a)];
  const qx=[Math.sin(b),0,0,Math.cos(b)];
  const qy=[0,Math.sin(c),0,Math.cos(c)];
  return quatMultiply(quatMultiply(qz,qx),qy);
}
function rotateVector(q,v){
  const r=quatMultiply(quatMultiply(q,[v[0],v[1],v[2],0]),quatConjugate(q));
  return [r[0],r[1],r[2]];
}
function targetPosition() {
  if(!state.target)return null;
  let raw={x:state.target.x,y:state.target.y};
  const origin=state.target.orientation;
  if(origin?.quaternion && state.sensor?.quaternion && state.sensorAllowed){
    // Перспективна проєкція променя на площину камери.
    // FOV телефона приблизний; тому це навчальна, не оптична AR-навігація.
    const w=Math.max(1,viewfinder.clientWidth),h=Math.max(1,viewfinder.clientHeight);
    const tanH=Math.tan(63*Math.PI/360),tanV=tanH*h/w;
    const ray=[(state.target.x-.5)*2*tanH,-(state.target.y-.5)*2*tanV,-1];
    const world=rotateVector(origin.quaternion,ray);
    const local=rotateVector(quatConjugate(state.sensor.quaternion),world);
    if(local[2]<-.08){
      raw={x: .5+(local[0]/(-local[2]))/(2*tanH), y:.5-(local[1]/(-local[2]))/(2*tanV)};
    } else raw={x:-8,y:-8};
  }
  // Легка експоненційна фільтрація + малий deadband проти вібрації точки.
  const prev=state.projectedTarget;
  if(!prev||Math.hypot(prev.x-raw.x,prev.y-raw.y)>2){state.projectedTarget={...raw};return raw;}
  const delta=Math.hypot(prev.x-raw.x,prev.y-raw.y);
  const deadband=2.2/Math.max(1,viewfinder.clientWidth);
  const smoothing=delta<deadband?0:(delta<.04?.22:.35);
  prev.x+=(raw.x-prev.x)*smoothing;
  prev.y+=(raw.y-prev.y)*smoothing;
  return prev;
}
function isReady(w,h,target=targetPosition()) {
  if (!target || !state.smart) return false;
  const eye=guideEye(w,h);
  const distance=Math.hypot(target.x*w-eye.x,target.y*h-eye.y);
  return distance < Math.min(w,h)*.075;
}
function drawCamera() {
  const r=viewfinder.getBoundingClientRect();
  if(!r.width||!r.height)return;
  const ctx=canvasContext(guideCanvas,r.width,r.height);
  const t=state.smart&&state.target?targetPosition():null;
  const ready=isReady(r.width,r.height,t);
  const eye=renderGuide(ctx,r.width,r.height,{ready});
  if(state.smart&&t){
    const x=t.x*r.width,y=t.y*r.height;
    ctx.beginPath();ctx.arc(x,y,r.width*.054,0,Math.PI*2);
    ctx.strokeStyle=ready?'#83f6b0':'#fff';ctx.lineWidth=2;
    ctx.setLineDash([8,4]);ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fillStyle=ready?'#83f6b0':'#fff';ctx.fill();
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(eye.x,eye.y);
    ctx.strokeStyle=ready?'#7ef0b070':'#f7d88a8c';ctx.lineWidth=1.5;ctx.setLineDash([4,7]);ctx.stroke();ctx.setLineDash([]);
  }
  viewfinder.classList.toggle('aligned',ready);
  $('shutterBtn').classList.toggle('aligned',ready);
  const status=$('smartState');status.classList.toggle('ready',ready);
  status.hidden=!state.smart||!state.target;
  if(state.smart&&state.target){
    if(ready)status.textContent='✓ Суміщено — можна знімати';
    else if(state.sensorAllowed&&state.sensorStarted)status.textContent='◎ Сумістіть два кола';
    else status.textContent='◎ Ціль обрана · увімкніть датчики';
  }
  $('frameLabel').textContent=state.smart?'ДАТЧИК · φ':'ЗОЛОТА СПІРАЛЬ · φ';
}
function requestDraw(){if(drawQueued)return;drawQueued=true;requestAnimationFrame(()=>{drawQueued=false;drawCamera();});}
function syncCameraLayout(){
  viewfinder.style.setProperty('--frame-ratio',state.ratio.replace(':',' / '));
  viewfinder.style.setProperty('--ratio-value',String(ratioFloat(state.ratio)));
  $('ratioBtn').textContent=state.ratio;
  buildRatioOptions();layoutViewfinder();requestAnimationFrame(layoutViewfinder);requestDraw();
}
function buildRatioOptions(){
  const holder=$('ratioOptions');holder.replaceChildren();
  for(const r of RATIO_OPTIONS){
    const btn=document.createElement('button');btn.textContent=r;
    btn.classList.toggle('selected',r===state.ratio);
    btn.addEventListener('click',()=>{state.ratio=r;syncCameraLayout();toast('Формат '+r);});holder.appendChild(btn);
  }
}

/* КАМЕРА */
async function startCamera(){
  if(state.screen!=='camera')return;
  stopCamera();
  const requestId=++cameraRequestId;
  const placeholder=$('emptyCamera');
  placeholder.hidden=false;placeholder.querySelector('span').textContent='Запитуємо доступ до камери…';
  $('retryCamera').hidden=true;$('shutterBtn').disabled=true;
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext){
    placeholder.querySelector('span').textContent='Для камери відкрийте сайт через HTTPS або localhost.';
    $('retryCamera').hidden=false;return;
  }
  try {
    const requestedFacing=state.facing;
    let stream;
    try {
      stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:requestedFacing},width:{ideal:1920},height:{ideal:1440}}});
    } catch(e) {
      if(e.name==='OverconstrainedError'||e.name==='NotFoundError')stream=await navigator.mediaDevices.getUserMedia({audio:false,video:true});
      else throw e;
    }
    if(requestId!==cameraRequestId||state.screen!=='camera'||requestedFacing!==state.facing){stream.getTracks().forEach(t=>t.stop());return;}
    state.stream=stream;video.srcObject=stream;
    video.classList.toggle('mirrored',state.facing==='user');
    await video.play();
    if(requestId!==cameraRequestId||state.stream!==stream)return;
    placeholder.hidden=true;$('shutterBtn').disabled=false;
    layoutViewfinder();startPreviewLoop();checkTorch();requestDraw();
  } catch(error){
    if(requestId!==cameraRequestId)return;
    console.warn('Камера:',error);
    const m={NotAllowedError:'Немає доступу до камери. Дозвольте камеру в налаштуваннях браузера.',NotFoundError:'Камеру не знайдено.',NotReadableError:'Камера зайнята іншим застосунком.'};
    placeholder.querySelector('span').textContent=m[error.name]||'Не вдалося запустити камеру.';
    $('retryCamera').hidden=false;
  }
}
function stopCamera(){
  stopPreviewLoop();cameraRequestId++;state.previewRecoveryId++;
  if(state.stream){state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}
  video.pause();video.srcObject=null;state.torch=false;state.torchSupported=false;
  updateTorchButton();
}
/* iOS Safari може зупинити малювання video після напівпрозорої галереї,
 * навіть коли stream живий. Повторно прив'язуємо stream до video, не запитуючи
 * доступ знову. Якщо track справді зупинився — створюємо новий потік. */
async function recoverCameraPreview(){
  if(state.screen!=='camera'||!$('sheetOverlay').hidden||document.hidden)return;
  layoutViewfinder();
  const stream=state.stream;
  if(!stream||stream.getVideoTracks().some(t=>t.readyState!=='live')){startCamera();return;}
  const id=++state.previewRecoveryId;
  try{
    // Не від'єднуємо живий потік без потреби: iOS після цього може
    // створити новий відеошар із неправильними фізичними розмірами.
    if(video.srcObject!==stream)video.srcObject=stream;
    if(video.paused||video.readyState<2)await video.play();
    if(id!==state.previewRecoveryId||state.stream!==stream)return;
    $('emptyCamera').hidden=true;
    $('shutterBtn').disabled=false;
    startPreviewLoop();layoutViewfinder();
    requestAnimationFrame(()=>{layoutViewfinder();requestDraw();});
  }catch(e){
    console.warn('Відновлення прев’ю:',e);
    if(id!==state.previewRecoveryId)return;
    // Якщо Safari таки зупинив відтворення — перепід'єднуємо один раз.
    try{
      video.pause();video.srcObject=null;
      await raf();
      if(id!==state.previewRecoveryId||state.stream!==stream)return;
      video.srcObject=stream;
      await video.play();
      startPreviewLoop();layoutViewfinder();
    }catch(error){console.warn('Повторне під’єднання:',error);if(id===state.previewRecoveryId)startCamera();}
  }
}

function checkTorch(){
  const track=state.stream?.getVideoTracks()[0];
  let capabilities={};try{capabilities=track?.getCapabilities?.()||{};}catch{}
  state.torchSupported=state.facing==='environment'&&capabilities.torch===true;
  state.torch=false;updateTorchButton();
}
function updateTorchButton(){
  $('flashBtn').disabled=!state.torchSupported;
  $('flashBtn').classList.toggle('active',state.torch);
  $('flashBtn').title=state.torchSupported?(state.torch?'Вимкнути ліхтарик':'Увімкнути ліхтарик'):'Ліхтарик не підтримується';
  setIcon($('flashBtn'),state.torch?'i-flash':'i-flash-off');
}
async function toggleTorch(){
  if(!state.torchSupported) return toast('Цей браузер не підтримує LED-ліхтарик');
  const track=state.stream?.getVideoTracks()[0]; if(!track)return;
  try{
    await track.applyConstraints({advanced:[{torch:!state.torch}]});
    state.torch=!state.torch;updateTorchButton();
  }catch {state.torchSupported=false;updateTorchButton();toast('Не вдалося керувати ліхтариком');}
}
function cropSource(vw,vh,outW,outH){
  const wanted=outW/outH; const actual=vw/vh;
  if(actual>wanted){const sw=vh*wanted;return {sx:(vw-sw)/2,sy:0,sw,sh:vh};}
  const sh=vw/wanted;return {sx:0,sy:(vh-sh)/2,sw:vw,sh};
}
function toBlob(canvas,type='image/jpeg',quality=.91){
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Немає Blob')),type,quality));
}
async function takePhoto(){
  if(!state.stream||!video.videoWidth){toast('Камера ще не готова');return;}
  const shutter=$('shutterBtn');shutter.disabled=true;
  try{
    const format=ratioFloat(state.ratio);
    const width=Math.min(1600,Math.max(800,video.videoWidth));
    const height=Math.round(width/format);
    const raw=document.createElement('canvas');raw.width=width;raw.height=height;
    const ctx=raw.getContext('2d');
    const source=cropSource(video.videoWidth,video.videoHeight,width,height);
    if(state.facing==='user'){ctx.translate(width,0);ctx.scale(-1,1);}
    ctx.drawImage(video,source.sx,source.sy,source.sw,source.sh,0,0,width,height);
    const rawBlob=await toBlob(raw);
    const guided=document.createElement('canvas');guided.width=width;guided.height=height;
    const guideCtx=guided.getContext('2d');guideCtx.drawImage(raw,0,0);
    // Позначки цілі, текст та елементи інтерфейсу у фото НЕ потрапляють.
    renderGuide(guideCtx,width,height,{ready:state.smart&&isReady(viewfinder.clientWidth,viewfinder.clientHeight)});
    const guidedBlob=await toBlob(guided);
    const photo={id:Date.now()+'-'+Math.random().toString(36).slice(2,7),date:new Date().toISOString(),ratio:state.ratio,raw:rawBlob,guided:guidedBlob};
    await savePhoto(photo);await refreshGallery();
    toast('Збережено 2 фото: з напрямною та без неї');
  }catch(e){console.error(e);toast('Помилка збереження фото. Перевірте вільне місце.');}
  finally{shutter.disabled=false;}
}

/* ДАТЧИКИ. Важливо: це приблизне інерціальне наведення, не SLAM / WebXR. */
function onOrientation(e){
  if(![e.alpha,e.beta,e.gamma].every(Number.isFinite))return;
  const now=performance.now();
  state.sensor={alpha:e.alpha,beta:e.beta,gamma:e.gamma,quaternion:orientationQuaternion(e.alpha,e.beta,e.gamma)};
  state.sensorStarted=true;
  if(state.target&&!state.target.orientation)state.target.orientation={...state.sensor};
  $('enableSensors').hidden=true;
  if(state.smart && now-state.lastOrientationDraw>30){state.lastOrientationDraw=now;requestDraw();}
}
async function enableSensors(){
  try{
    if(typeof DeviceOrientationEvent==='undefined')throw Error('Датчики недоступні');
    if(typeof DeviceOrientationEvent.requestPermission==='function'){
      const permission=await DeviceOrientationEvent.requestPermission();
      if(permission!=='granted')throw Error('Доступ відхилено');
    }
    if(!state.sensorListenerAdded){window.addEventListener('deviceorientation',onOrientation,true);state.sensorListenerAdded=true;}
    state.sensorAllowed=true;state.sensorDenied=false;
    $('enableSensors').hidden=true;
    toast('Датчики увімкнено. Оберіть точку на відео.');
  }catch(e){
    state.sensorAllowed=false;state.sensorDenied=true;
    $('enableSensors').hidden=false;
    toast('Немає датчиків. Можна обрати точку вручну.');
  }
  requestDraw();
}
function changeSmart(){
  state.smart=!state.smart;state.target=null;state.projectedTarget=null;
  $('smartBtn').classList.toggle('active',state.smart);
  $('smartBtn').setAttribute('aria-pressed',String(state.smart));
  $('smartHint').hidden=!state.smart;
  $('smartState').hidden=true;
  $('tapLayer').style.touchAction=state.smart?'none':'manipulation';
  $('enableSensors').hidden=!state.smart||state.sensorStarted;
  if(state.smart&&!state.sensorAllowed)toast('Натисніть «Увімкнути датчики» у вікні камери.');
  requestDraw();
}
function setTargetFromPointer(event){
  if(!state.smart)return;
  const r=viewfinder.getBoundingClientRect();
  const x=limit((event.clientX-r.left)/r.width,0,1),y=limit((event.clientY-r.top)/r.height,0,1);
  state.target={x,y,orientation:state.sensorAllowed&&state.sensor?{...state.sensor}:null};
  state.projectedTarget={x,y};
  requestDraw();
}

/* Фотоідеї: 5 тематичних добірок × 5 демонстрацій.
 * Лінія завжди малюється нашим Canvas — не є частиною чужого фото.
 * Тварини: локальні авторські AI-приклади, інше: Unsplash License. */
const ideaPhoto = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=640&h=800&q=78`;
const PHOTO_IDEAS = [
  {
    title:'Тварини',symbol:'🐾',description:'Погляд, рух, фактура шерсті й природні лінії.',
    examples:[
      ['Котячий погляд','Розмістіть око кота в завитку, залишивши повітря з боку погляду.','examples/animal-cat.webp',.56,.45,0],
      ['Собака у профіль','Нехай морда веде погляд до завитка, а плечі підхоплюють дугу.','examples/animal-dog.webp',.66,.44,1],
      ['Птах на гілці','Знайдіть маленьке око й ведіть вигин через пір’я і гілочку.','examples/animal-bird.webp',.57,.42,0],
      ['Метелик на квітці','Спробуйте закрутити лінію навколо крилець і центру квітки.','examples/animal-butterfly.webp',.51,.58,2],
      ['Лисиця в лісі','Перенесіть завиток на око, залиште простір перед носом.','examples/animal-fox.webp',.60,.40,3],
    ]
  },
  {
    title:'Портрети',symbol:'◉',description:'Обличчя, емоції та світло в кадрі.',
    examples:[
      ['Погляд у камеру','Найважливіше — очі. Розташуйте око ближче до золотого центру.',ideaPhoto('photo-1534528741775-53994a69daeb'),.68,.36,0],
      ['М’який бічний портрет','Поверніть спіраль до обличчя, а вільний простір залиште перед ним.',ideaPhoto('photo-1500648767791-00dcc994a43e'),.56,.42,2],
      ['Портрет на природі','Підтримайте лінією вигин волосся чи плечей, акцентуйте обличчя.',ideaPhoto('photo-1524504388940-b1c1722653e1'),.67,.35,1],
      ['Усмішка та емоції','Завиток може підкреслити усмішку, а не лише очі.',ideaPhoto('photo-1517841905240-472988babdf9'),.69,.43,3],
      ['Головний герой','Знайдіть один виразний акцент і не перевантажуйте фон.',ideaPhoto('photo-1531123897727-8f129e1688ce'),.32,.34,2],
    ]
  },
  {
    title:'Їжа',symbol:'✦',description:'Текстури, сервірування та головний інгредієнт.',
    examples:[
      ['Корисна тарілка','Спрямуйте дугу по краю тарілки до найяскравішого інгредієнта.',ideaPhoto('photo-1546069901-ba9599a7e63c'),.50,.50,0],
      ['Тарт із ягодами','Спробуйте вписати круглий пиріг в зовнішню частину спіралі.',ideaPhoto('photo-1565958011703-44f9829ba187'),.33,.65,1],
      ['Піца зверху','Покладіть вибраний шматочок у центр композиції.',ideaPhoto('photo-1565299624946-b28f40a0ae38'),.62,.57,2],
      ['Сніданок на столі','Створіть рух погляду від чашки до тосту чи фрукта.',ideaPhoto('photo-1509440159596-0249088772ff'),.33,.39,3],
      ['Кольоровий салат','Знайдіть контрастний акцент і перевірте баланс вільного місця.',ideaPhoto('photo-1512621776951-a57141f2eefd'),.67,.63,0],
    ]
  },
  {
    title:'Природа',symbol:'❀',description:'Квіти, горизонти, річки та вигини стежок.',
    examples:[
      ['Сонце над горизонтом','Підведіть завиток до сонця, залишаючи небо великим фоном.',ideaPhoto('photo-1470252649378-9c29740c9fa8'),.67,.31,0],
      ['Стежка крізь ліс','Проведіть зовнішню дугу вздовж стежки, щоб посилити глибину.',ideaPhoto('photo-1441974231531-c6227db76b6e'),.32,.66,1],
      ['Озеро і гори','Використовуйте віддзеркалення й лінію берега для плавного руху.',ideaPhoto('photo-1470770841072-f978cf4d019e'),.67,.64,2],
      ['Трави й пагорби','Зверніть увагу на хвилясті лінії, які ведуть у дальній план.',ideaPhoto('photo-1500534623283-312aade485b7'),.36,.33,3],
      ['Водоспад','Спробуйте поєднати вертикальний рух води з широким вигином спіралі.',ideaPhoto('photo-1433086966358-54859d0ed716'),.72,.35,0],
    ]
  },
  {
    title:'Архітектура',symbol:'⌂',description:'Сходи, коридори, вигини та геометрія міста.',
    examples:[
      ['Сучасні фасади','Нехай вигнутий силует будівлі повторює зовнішню дугу.',ideaPhoto('photo-1511818966892-d7d671e672a2'),.65,.35,0],
      ['Міські лінії','Ведіть погляд уздовж вертикалей до вибраної архітектурної деталі.',ideaPhoto('photo-1487958449943-2429e8be8625'),.33,.62,1],
      ['Коридор і перспектива','Сумістіть завиток із кінцем коридору — природною точкою уваги.',ideaPhoto('photo-1497366754035-f200968a6e72'),.66,.68,2],
      ['Деталі конструкцій','Виберіть характерний кут або арку і підкресліть його лінією.',ideaPhoto('photo-1524230572899-a752b3835840'),.36,.37,3],
      ['Хмарочоси','Пограйтеся з нахилом і ритмом вікон, направляючи погляд угору.',ideaPhoto('photo-1486406146926-c627a92ad1ab'),.64,.35,0],
    ]
  },
];
let ideaCanvases=[];
let activeIdea=null;
function buildIdeasCatalog(){
  const holder=$('ideasCatalog');holder.replaceChildren();ideaCanvases=[];
  PHOTO_IDEAS.forEach((category,index)=>{
    const section=document.createElement('section');section.className='idea-category';
    const heading=document.createElement('div');heading.className='idea-category-head';
    heading.innerHTML=`<span class="idea-category-index">0${index+1}</span><div><h4>${category.title}</h4><p>${category.description}</p></div><small>05 ФОТО</small>`;
    const track=document.createElement('div');track.className='idea-photo-track';
    category.examples.forEach((example,number)=>{
      const [title,description,src,x,y,rotation]=example;
      const button=document.createElement('button');button.type='button';button.className='idea-photo-card';
      button.setAttribute('aria-label',`${category.title}: ${title}. Відкрити приклад`);
      const shot=document.createElement('div');shot.className='idea-shot';
      const fallback=document.createElement('span');fallback.className='idea-image-fallback';fallback.textContent=category.symbol;
      const img=document.createElement('img');img.loading='lazy';img.alt=title;img.src=src;
      img.addEventListener('error',()=>{img.hidden=true;fallback.textContent='Фото доступне онлайн';fallback.classList.add('is-offline');});
      const canvas=document.createElement('canvas');canvas.setAttribute('aria-hidden','true');
      shot.append(fallback,img,canvas);
      const info=document.createElement('div');info.className='idea-photo-info';
      const titleEl=document.createElement('strong');titleEl.textContent=title;
      const descEl=document.createElement('p');descEl.textContent=description;
      info.append(titleEl,descEl);button.append(shot,info);
      track.append(button);
      const config={anchor:{x,y},rotation,scale:1.06,color:'gold',lineWidth:1.6};
      ideaCanvases.push({canvas,config});
      button.addEventListener('click',()=>openIdeaLightbox(category,{title,description,src,config}));
    });
    section.append(heading,track);holder.append(section);
  });
  requestAnimationFrame(drawIdeaExampleGuides);
}
function drawIdeaExampleGuides(){
  if(state.screen!=='ideas')return;
  for(const {canvas,config} of ideaCanvases){
    const r=canvas.getBoundingClientRect();if(!r.width||!r.height)continue;
    const ctx=canvasContext(canvas,r.width,r.height,Math.min(2,window.devicePixelRatio||1));
    renderGuide(ctx,r.width,r.height,config);
  }
}
function openIdeaLightbox(category,idea){
  activeIdea=idea;
  $('ideaLightboxCat').textContent=category.title+' · Золота спіраль';
  $('ideaLightboxTitle').textContent=idea.title;
  $('ideaLightboxDescription').textContent=idea.description;
  $('ideaLightboxImg').src=idea.src;
  $('ideaLightbox').hidden=false;
  requestAnimationFrame(drawIdeaLightbox);
}
function drawIdeaLightbox(){
  if(!activeIdea||$('ideaLightbox').hidden)return;
  const canvas=$('ideaLightboxCanvas'),r=canvas.getBoundingClientRect();
  if(!r.width||!r.height)return;
  const ctx=canvasContext(canvas,r.width,r.height);
  renderGuide(ctx,r.width,r.height,{...activeIdea.config,lineWidth:2.2});
}
function closeIdeaLightbox(){activeIdea=null;$('ideaLightbox').hidden=true;$('ideaLightboxImg').removeAttribute('src');}

/* Галерея: IndexedDB з резервним збереженням лише в оперативній пам'яті. */
function openDB(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in window))return reject(new Error('IndexedDB недоступний'));
    const r=indexedDB.open('SpiraCamPhotos',1);
    r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('photos'))r.result.createObjectStore('photos',{keyPath:'id'});};
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
async function dbOperation(mode, callback){
  if(!state.db)throw Error('IndexedDB недоступний');
  return new Promise((resolve,reject)=>{
    const tx=state.db.transaction('photos',mode);const store=tx.objectStore('photos');
    let result;let req;
    try{req=callback(store);}catch(e){reject(e);return;}
    req.onsuccess=()=>result=req.result;
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });
}
async function savePhoto(photo){
  if(state.db)await dbOperation('readwrite',s=>s.put(photo));
  else {state.memoryPhotos.push(photo);toast('Фото тимчасово збережено лише до закриття вкладки');}
}
async function loadPhotos(){
  let photos=[];
  if(state.db)photos=await dbOperation('readonly',s=>s.getAll());
  else photos=[...state.memoryPhotos];
  return photos.sort((a,b)=>b.date.localeCompare(a.date));
}
async function removePhoto(id){
  if(state.db)await dbOperation('readwrite',s=>s.delete(id));
  else state.memoryPhotos=state.memoryPhotos.filter(x=>x.id!==id);
}
async function refreshGallery(){
  try{state.gallery=await loadPhotos();}catch(e){console.error(e);state.gallery=[];toast('Не вдалося прочитати галерею');}
  if(state.lastThumbnailUrl){URL.revokeObjectURL(state.lastThumbnailUrl);state.lastThumbnailUrl=null;}
  const thumb=$('lastThumb');
  if(state.gallery.length){
    state.lastThumbnailUrl=URL.createObjectURL(state.gallery[0].guided);
    thumb.src=state.lastThumbnailUrl;thumb.hidden=false;
  }else{thumb.hidden=true;thumb.removeAttribute('src');}
  if(!$('gallerySheet').hidden)renderGallery();
}
function cleanupGalleryURLs(){for(const u of state.gridUrls)URL.revokeObjectURL(u);state.gridUrls=[];}
function renderGallery(){
  cleanupGalleryURLs();const grid=$('galleryGrid');grid.replaceChildren();
  grid.hidden=!!state.selectedPhoto;
  $('galleryEmpty').hidden=state.gallery.length>0||!!state.selectedPhoto;
  $('photoDetails').hidden=!state.selectedPhoto;
  if(state.selectedPhoto){showPhotoDetails();return;}
  for(const photo of state.gallery){
    const button=document.createElement('button');button.className='gallery-item';
    const img=document.createElement('img');img.alt='Знімок';img.loading='lazy';
    img.src=URL.createObjectURL(photo.guided);state.gridUrls.push(img.src);
    const caption=document.createElement('span');
    caption.textContent=new Date(photo.date).toLocaleString('uk-UA',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    button.append(img,caption);
    button.addEventListener('click',()=>{state.selectedPhoto=photo;state.selectedVersion='guided';renderGallery();});
    grid.append(button);
  }
}
function showPhotoDetails(){
  const photo=state.selectedPhoto;
  if(!photo)return;
  $('photoDetails').hidden=false;
  for(const b of document.querySelectorAll('[data-version]'))b.classList.toggle('selected',b.dataset.version===state.selectedVersion);
  if(state.currentPreviewUrl)URL.revokeObjectURL(state.currentPreviewUrl);
  state.currentPreviewUrl=URL.createObjectURL(photo[state.selectedVersion]);
  $('previewImage').src=state.currentPreviewUrl;
}
function openSheet(name){
  $('sheetOverlay').hidden=false;
  $('settingsSheet').hidden=name!=='settings';$('gallerySheet').hidden=name!=='gallery';
  if(name==='gallery'){state.selectedPhoto=null;refreshGallery();}
}
function closeSheet(){
  const wasGallery=!$('gallerySheet').hidden;
  $('sheetOverlay').hidden=true;$('settingsSheet').hidden=true;$('gallerySheet').hidden=true;
  state.selectedPhoto=null;cleanupGalleryURLs();
  if(wasGallery){layoutViewfinder();requestAnimationFrame(recoverCameraPreview);}
  if(state.currentPreviewUrl){URL.revokeObjectURL(state.currentPreviewUrl);state.currentPreviewUrl=null;}
}
function downloadBlob(blob,name){
  const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000);
}
function photoName(photo,version){
  const stamp=photo.date.replace(/[-:]/g,'').replace('T','_').slice(0,15);
  return `SpiralCam_${stamp}_${version}.jpg`;
}
// Вбудований ZIP-архіватор (режим store, без зовнішніх бібліотек).
const CRC_TABLE=new Uint32Array(256);
for(let n=0;n<256;n++){let c=n;for(let i=0;i<8;i++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;CRC_TABLE[n]=c>>>0;}
function crc32(bytes){let c=0xFFFFFFFF;for(let b of bytes)c=CRC_TABLE[(c^b)&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function makeZip(entries){
  const encoder=new TextEncoder();const pieces=[];const directory=[];let offset=0;
  for(const entry of entries){
    const bytes=entry.data;const name=encoder.encode(entry.name);const crc=crc32(bytes);
    const head=new Uint8Array(30);let d=new DataView(head.buffer);
    d.setUint32(0,0x04034b50,true);d.setUint16(4,20,true);d.setUint16(8,0,true);
    d.setUint32(14,crc,true);d.setUint32(18,bytes.byteLength,true);d.setUint32(22,bytes.byteLength,true);d.setUint16(26,name.length,true);
    pieces.push(head,name,bytes);
    const center=new Uint8Array(46);d=new DataView(center.buffer);
    d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);
    d.setUint32(16,crc,true);d.setUint32(20,bytes.byteLength,true);d.setUint32(24,bytes.byteLength,true);
    d.setUint16(28,name.length,true);d.setUint32(42,offset,true);
    directory.push(center,name);
    offset+=head.length+name.length+bytes.length;
  }
  const directoryLength=directory.reduce((n,x)=>n+x.length,0);
  const end=new Uint8Array(22);const d=new DataView(end.buffer);
  d.setUint32(0,0x06054b50,true);d.setUint16(8,entries.length,true);d.setUint16(10,entries.length,true);
  d.setUint32(12,directoryLength,true);d.setUint32(16,offset,true);
  return new Blob([...pieces,...directory,end],{type:'application/zip'});
}
async function downloadBoth(){
  const photo=state.selectedPhoto;if(!photo)return;
  try{
    const entries=await Promise.all(['raw','guided'].map(async v=>({name:photoName(photo,v),data:new Uint8Array(await photo[v].arrayBuffer())})));
    const zip=makeZip(entries);downloadBlob(zip,photoName(photo,'both').replace('.jpg','.zip'));
  }catch(e){console.error(e);toast('Не вдалося створити ZIP');}
}

/* Заборона небажаного збільшення сторінки на iOS Safari та Android.
 * CSS touch-action зберігає прокручування в «Ідеях» і галереї, але
 * вимикає pinch-zoom і double-tap zoom. Додаткова страховка для iOS Safari. */
function preventPageMagnification(event){event.preventDefault();}
for(const eventName of ['gesturestart','gesturechange','gestureend']) {
  document.addEventListener(eventName,preventPageMagnification,{passive:false});
}
document.addEventListener('touchstart',event=>{
  if(event.touches.length>1)event.preventDefault();
},{passive:false});
document.addEventListener('touchmove',event=>{
  if(event.touches.length>1)event.preventDefault();
},{passive:false});
document.addEventListener('dblclick',event=>event.preventDefault(),{passive:false});

/* ПІДПИСКИ НА ПОДІЇ */
$('openCamera').addEventListener('click',()=>showScreen('camera'));
$('openIdeas').addEventListener('click',()=>showScreen('ideas'));
$('ideasBack').addEventListener('click',()=>showScreen('home'));
$('ideasToCamera').addEventListener('click',()=>showScreen('camera'));
$('cameraBack').addEventListener('click',()=>showScreen('home'));
$('retryCamera').addEventListener('click',startCamera);
$('switchBtn').addEventListener('click',()=>{state.facing=state.facing==='environment'?'user':'environment';startCamera();});
$('flashBtn').addEventListener('click',toggleTorch);
$('ratioBtn').addEventListener('click',()=>{state.ratio=RATIO_OPTIONS[(RATIO_OPTIONS.indexOf(state.ratio)+1)%RATIO_OPTIONS.length];syncCameraLayout();});
$('settingsBtn').addEventListener('click',()=>openSheet('settings'));
$('rotateBtn').addEventListener('click',()=>{state.rotation=(state.rotation+1)%4;state.target=null;requestDraw();});
$('flipBtn').addEventListener('click',()=>{state.flipped=!state.flipped;state.target=null;requestDraw();});
$('gridBtn').addEventListener('click',()=>{state.grid=!state.grid;$('gridBtn').classList.toggle('active',state.grid);requestDraw();});
$('smartBtn').addEventListener('click',changeSmart);
$('enableSensors').addEventListener('click',enableSensors);
$('sheetSensors').addEventListener('click',enableSensors);
$('guideFromSettings').addEventListener('click',()=>{closeSheet();showScreen('ideas');});
$('tapLayer').addEventListener('pointerdown',setTargetFromPointer);
$('zoomIn').addEventListener('click',()=>{state.scale=limit(Math.round((state.scale+.1)*10)/10,.5,1.8);$('zoomText').textContent=state.scale.toFixed(1)+'×';requestDraw();});
$('zoomOut').addEventListener('click',()=>{state.scale=limit(Math.round((state.scale-.1)*10)/10,.5,1.8);$('zoomText').textContent=state.scale.toFixed(1)+'×';requestDraw();});
$('lineWidth').addEventListener('input',e=>{state.lineWidth=Number(e.target.value);requestDraw();});
$('colorBtn').addEventListener('click',()=>{state.color=state.color==='gold'?'white':'gold';$('colorBtn').textContent=state.color==='gold'?'Золотий':'Білий';requestDraw();});
$('shutterBtn').addEventListener('click',takePhoto);
$('galleryBtn').addEventListener('click',()=>openSheet('gallery'));
$('closeIdeaLightbox').addEventListener('click',closeIdeaLightbox);
$('ideaLightbox').addEventListener('click',e=>{if(e.target===$('ideaLightbox'))closeIdeaLightbox();});
$('ideaLightboxImg').addEventListener('load',drawIdeaLightbox);
$('sheetOverlay').addEventListener('click',e=>{if(e.target===$('sheetOverlay'))closeSheet();});
document.querySelectorAll('[data-close-sheet]').forEach(b=>b.addEventListener('click',closeSheet));
$('backToGallery').addEventListener('click',()=>{state.selectedPhoto=null;renderGallery();});
document.querySelectorAll('[data-version]').forEach(b=>b.addEventListener('click',()=>{state.selectedVersion=b.dataset.version;showPhotoDetails();}));
$('downloadSelected').addEventListener('click',()=>{const p=state.selectedPhoto;if(p)downloadBlob(p[state.selectedVersion],photoName(p,state.selectedVersion));});
$('downloadBoth').addEventListener('click',downloadBoth);
$('deletePhoto').addEventListener('click',async()=>{
  if(!state.selectedPhoto)return;
  if(!confirm('Видалити обидві версії цього знімка?'))return;
  await removePhoto(state.selectedPhoto.id);state.selectedPhoto=null;await refreshGallery();toast('Знімок видалено');
});
window.addEventListener('resize',()=>{if(state.screen==='camera')layoutViewfinder();if(state.screen==='home')drawHero();if(state.screen==='ideas'){drawIdeas();drawIdeaExampleGuides();drawIdeaLightbox();}});
window.addEventListener('keydown',e=>{
  if(e.key==='Escape'){if(!$('ideaLightbox').hidden)closeIdeaLightbox();else if(!$('sheetOverlay').hidden)closeSheet();else if(state.screen==='camera'||state.screen==='ideas')showScreen('home');}
  if((e.key===' '||e.key==='Enter')&&state.screen==='camera'&&$('sheetOverlay').hidden&&document.activeElement===document.body){e.preventDefault();takePhoto();}
});
window.addEventListener('beforeunload',stopCamera);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPreviewLoop();else requestAnimationFrame(recoverCameraPreview);});
window.addEventListener('pageshow',e=>{if(e.persisted)requestAnimationFrame(recoverCameraPreview);});
if('ResizeObserver' in window){
  new ResizeObserver(()=>{if(state.screen==='camera')layoutViewfinder();}).observe(cameraWorkspace);
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize',()=>{if(state.screen==='camera')requestAnimationFrame(layoutViewfinder);});
}


(async function init(){
  buildRatioOptions();buildIdeasCatalog();drawHero();
  try{state.db=await openDB();}catch{state.db=null;}
  await refreshGallery();
  if('serviceWorker' in navigator && window.isSecureContext){
    navigator.serviceWorker.register('./service-worker.js').catch(e=>console.warn('PWA unavailable:',e));
  }
})();
