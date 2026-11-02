/* Flooded-forest explorer (ALOS-2 PALSAR-2, 2015–2025): Central Africa and South America.
   Overview: coarse summary cube per region (data/<region>/*.bin, gzip).
   Detail: original 100 m GeoTIFF tiles read straight out of the Zenodo zips with HTTP range requests.
   Data: Rosenqvist et al. (2026) doi:10.5281/zenodo.22981938, CC-BY 4.0. ALOS-2 data (c) JAXA/EORC. */
(async function(){
"use strict";
const $=id=>document.getElementById(id);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const KM=111.32;

// ============ load overview data ============
let loaded=0;const TOTAL_LOAD=7;
const tick=()=>{loaded++;$('pbar').style.width=(100*loaded/TOTAL_LOAD)+'%';};
async function getJSON(u){const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);tick();return r.json();}
async function getGz(u){const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);
  const buf=new Uint8Array(await r.arrayBuffer());tick();
  if(buf[0]!==0x1f||buf[1]!==0x8b)return buf; // already decoded by the server
  const out=await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();return new Uint8Array(out);}
let META,VEC,IV,GF,DOMB,BG,TI,IDX,REGIONS,REGION;
try{
  REGIONS=await (await fetch('data/regions.json')).json();
  const want=new URLSearchParams(location.search).get('region');REGION=REGIONS.some(r=>r.id===want)?want:REGIONS[0].id;
  const BASE='data/'+REGION+'/';
  $('loadmsg').textContent=`Loading the ${REGIONS.find(r=>r.id===REGION).name} overview…`;
  [META,VEC,TI]=await Promise.all([getJSON(BASE+'cube_meta.json'),getJSON(BASE+'context.json'),getJSON(BASE+'tile_index.json')]);
  if(TI.format==='counts'){ // gzip uint32 tile byte counts; offsets rebuilt from each file's first tile + fixed inter-tile gap
    const cnt=new Uint32Array((await getGz(BASE+'tile_index.bin')).buffer),n=TI.first.length*TI.ntiles;IDX=new Uint32Array(2*n);
    for(let t=0;t<TI.first.length;t++){let o=TI.first[t];for(let k=0;k<TI.ntiles;k++){const i=t*TI.ntiles+k;IDX[i]=o;IDX[n+i]=cnt[i];o+=cnt[i]+TI.gap;}}
  }else{const ir=await fetch(BASE+'tile_index.bin');IDX=new Uint32Array(await ir.arrayBuffer());tick();}
  [IV,GF,DOMB,BG]=await Promise.all([getGz(BASE+'cube.bin'),getGz(BASE+'gapfill.bin'),getGz(BASE+'domain.bin'),getGz(BASE+'duration.bin')]);
}catch(e){$('loadmsg').textContent='Could not load the data files ('+e.message+'). If you opened index.html straight from disk, serve the folder instead, for example with “python -m http.server”.';return;}

const T=META.cycles.length,W=META.w,H=META.h,DX=META.dx,LON0=META.lon0,LAT0=META.lat0;
const CF=META.cubeF,CKM=META.cellKm+' km',GKM=META.gfKm+' km',BGM=META.bgM+' m',BOUNDS=META.bounds;
const W4=META.w4,H4=META.h4,DX4=META.dx4,BGW=META.bgw,BGH=META.bgh,BG_EXT=META.bgext;
const inDomain=(x,y)=>{const i=y*W+x;return (DOMB[i>>3]>>(7-(i&7)))&1;};
const cellArea=new Float64Array(H),cellArea4=new Float64Array(H4);
for(let y=0;y<H;y++)cellArea[y]=(DX*KM)**2*Math.cos((LAT0-(y+.5)*DX)*Math.PI/180);
for(let y=0;y<H4;y++)cellArea4[y]=(DX4*KM)**2*Math.cos((LAT0-(y+.5)*DX4)*Math.PI/180);

// 100 m grid
const PX=TI.px,NT=TI.ntiles,TA=TI.tilesAcross,TD=TI.tilesDown,TS=TI.tile,PW=TI.width,PH=TI.height;
const OFF=IDX.subarray(0,T*NT),CNT=IDX.subarray(T*NT,2*T*NT);
const pxArea=row=>(PX*KM)**2*Math.cos((LAT0-(row+.5)*PX)*Math.PI/180);
const zipUrl=y=>TI.zipUrl.replace('{year}',y);

const cyc=META.cycles.map((c,i)=>{const p=s=>new Date(Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8)));
  const sd=p(c.start),ed=p(c.end),mid=new Date((sd.getTime()+ed.getTime())/2);
  return {i,cycle:c.cycle,cycle2:c.cycle2||c.cycle,year:2015+Math.floor(i/9),k:i%9,sd,ed,mid,dec:mid.getUTCFullYear()+(mid.getUTCMonth()+mid.getUTCDate()/31)/12};});
const fmtD=d=>d.getUTCDate()+' '+MONTHS[d.getUTCMonth()]+' '+d.getUTCFullYear();
const fmtRange=c=>{const a=c.sd,b=c.ed;return (a.getUTCMonth()===b.getUTCMonth()&&a.getUTCFullYear()===b.getUTCFullYear())?a.getUTCDate()+'–'+b.getUTCDate()+' '+MONTHS[b.getUTCMonth()]+' '+b.getUTCFullYear():fmtD(a)+' – '+fmtD(b);};
const fmtLat=v=>`${Math.abs(v).toFixed(3)}°${v>=0?'N':'S'}`;
const fmtLon=(v,d=3)=>`${Math.abs(v).toFixed(d)}°${v>=0?'E':'W'}`;

// ============ Zenodo range-request engine ============
const rate={remaining:null,limit:133,reset:0,bytes:0,requests:0,active:0};
function netStatus(){const r=rate;
  $('netRate').textContent=r.requests?`Zenodo: ${r.remaining??'?'} of ${r.limit} requests left this minute, ${(r.bytes/1e6).toFixed(1)} MB streamed${r.active?`, ${r.active} in flight`:''}`:'Zenodo requests: none yet';}
let slots=4;const waiters=[];
async function acquire(){while(slots<=0)await new Promise(r=>waiters.push(r));slots--;}
function release(){slots++;const w=waiters.shift();if(w)w();}
async function waitBudget(){
  while(rate.remaining!==null&&rate.remaining<=4&&Date.now()/1000<rate.reset){
    $('netRate').textContent=`Paused for Zenodo’s request limit, resuming in ${Math.ceil(rate.reset-Date.now()/1000)} s`;await sleep(1000);}
  if(rate.remaining!==null&&Date.now()/1000>=rate.reset)rate.remaining=null;}
function parseMultipart(buf,ranges){
  const out=new Map();let i=0;while(i<buf.length&&(buf[i]===10||buf[i]===13))i++;
  if(!(buf[i]===45&&buf[i+1]===45)){ // single (or coalesced) range
    const s0=Math.min(...ranges.map(r=>r[0]));for(const [a,b] of ranges)out.set(a,buf.subarray(a-s0,b-s0+1));return out;}
  const dec=new TextDecoder('latin1');
  for(;;){let j=i,he=-1;
    while(j<buf.length-1){if(buf[j]===10){if(buf[j+1]===10){he=j+2;break;}if(buf[j+1]===13&&buf[j+2]===10){he=j+3;break;}}j++;}
    if(he<0)break;const m=/Content-Range:\s*bytes\s+(\d+)-(\d+)/i.exec(dec.decode(buf.subarray(i,he)));if(!m)break;
    const a=+m[1],n=+m[2]-a+1;out.set(a,buf.subarray(he,he+n));i=he+n;}
  return out;}
async function fetchRanges(year,ranges){
  for(let attempt=0;attempt<4;attempt++){
    await waitBudget();await acquire();rate.active++;netStatus();
    try{
      const res=await fetch(zipUrl(year),{headers:{Range:'bytes='+ranges.map(r=>r[0]+'-'+r[1]).join(',')}});
      rate.requests++;const rl=res.headers.get('X-RateLimit-Remaining'),rs=res.headers.get('X-RateLimit-Reset'),lim=res.headers.get('X-RateLimit-Limit');
      if(rl!==null){rate.remaining=+rl;rate.reset=+rs;if(lim)rate.limit=+lim;}
      if(res.status===429){rate.remaining=0;rate.reset=(+rs)||Date.now()/1000+60;continue;}
      if(res.status!==206&&res.status!==200)throw new Error('Zenodo answered '+res.status);
      const buf=new Uint8Array(await res.arrayBuffer());rate.bytes+=buf.length;
      if(res.status===200){const m=new Map();for(const [a,b] of ranges)m.set(a,buf.subarray(a,b+1));return m;}
      return parseMultipart(buf,ranges);
    }catch(e){if(attempt===3)throw e;await sleep(800*(attempt+1));}
    finally{rate.active--;release();netStatus();}}
  throw new Error('Zenodo kept refusing requests');}
// compressed-tile LRU cache
const ccache=new Map();let cbytes=0;const CMAX=80e6;
const cget=k=>{const v=ccache.get(k);if(v){ccache.delete(k);ccache.set(k,v);}return v;};
function cput(k,v){if(ccache.has(k))return;ccache.set(k,v);cbytes+=v.byteLength;while(cbytes>CMAX){const [kk,vv]=ccache.entries().next().value;ccache.delete(kk);cbytes-=vv.byteLength;}}
/* fetchTiles(list of [t,k]) → calls onYear(map "t:k"→compressed bytes) as each year's zip answers.
   Consecutive tile numbers in one file are contiguous on disk, so each run is one byte range,
   and every run from the 9 files in one yearly zip goes into the same multi-range request. */
async function fetchTiles(list,onYear,{cache=true}={}){
  const byYear=new Map();
  for(const [t,k] of list){const key=t+':'+k,hit=cget(key);if(hit){(byYear.get(-1)||byYear.set(-1,new Map()).get(-1)).set(key,hit);continue;}
    const y=cyc[t].year;if(!byYear.has(y))byYear.set(y,[]);byYear.get(y).push([t,k]);}
  const jobs=[];
  if(byYear.has(-1)){jobs.push(Promise.resolve(onYear(byYear.get(-1))));byYear.delete(-1);}
  for(const [y,items] of byYear){
    items.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const runs=[];
    for(const [t,k] of items){const r=runs[runs.length-1];if(r&&r.t===t&&r.k1===k-1)r.k1=k;else runs.push({t,k0:k,k1:k});}
    const ranges=runs.map(r=>[OFF[r.t*NT+r.k0],OFF[r.t*NT+r.k1]+CNT[r.t*NT+r.k1]-1]);
    for(let i=0;i<ranges.length;i+=150){const rs=ranges.slice(i,i+150),rr=runs.slice(i,i+150);
      jobs.push(fetchRanges(y,rs).then(parts=>{const out=new Map();
        rr.forEach((r,j)=>{const a=rs[j][0],blob=parts.get(a);if(!blob)throw new Error('missing part');
          for(let k=r.k0;k<=r.k1;k++){const o=OFF[r.t*NT+k]-a,n=CNT[r.t*NT+k];const b=blob.slice(o,o+n);out.set(r.t+':'+k,b);if(cache)cput(r.t+':'+k,b);}});
        return onYear(out);}));}}
  await Promise.all(jobs);}
async function decodeTile(bytes){const ab=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();return new Uint8Array(ab);} // 512×512×2, pixel-interleaved
const tileOf=(px,py)=>Math.floor(py/TS)*TA+Math.floor(px/TS);

// ============ colours ============
function ramp(stops,n){const out=new Uint8ClampedArray(n*3);for(let i=0;i<n;i++){const t=i/(n-1);let j=0;while(j<stops.length-2&&t>stops[j+1][0])j++;
  const [t0,c0]=stops[j],[t1,c1]=stops[j+1],f=(t-t0)/(t1-t0||1);for(let k=0;k<3;k++)out[i*3+k]=c0[k]+(c1[k]-c0[k])*f;}return out;}
const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
const STOPS=[[0,hex('#1d4f57')],[.25,hex('#1f8a8a')],[.5,hex('#45c0a8')],[.75,hex('#a6e6b8')],[1,hex('#fbf8cf')]];
const RAMP=ramp(STOPS,256),cssGrad='linear-gradient(90deg,'+STOPS.map(s=>`rgb(${s[1].join(',')}) ${s[0]*100}%`).join(',')+')';
const LAND=hex('#24312c'),OUT=hex('#141c19');
const CLASS=[null,{n:'Flooded forest',c:'#a6e6b8'},{n:'Open water',c:'#3f8fd8'},{n:'Submerged vegetation',c:'#b39bff'},{n:'Dry forest / other land',c:'#24312c'},
  {n:'Masked: not forest',c:'#3a403d'},{n:'Masked: slope ≥10°',c:'#3d3630'},{n:'Exposed river bank',c:'#d9b77a'},{n:'No data this pass',c:'#7a3434'}];
const CLASS_RGB=CLASS.map(c=>c?hex(c.c):null);
const PROV={obs:{n:'Seen directly by the radar',c:'#a6e6b8'},tmp:{n:'Filled from the passes before and after',c:'#ffb054'},hyd:{n:'Filled from a hydrological proxy',c:'#ff6f6f'}};
const provKind=p=>p>=31?'hyd':p>=21?'tmp':'obs';
const PROV_RGB={obs:hex(PROV.obs.c),tmp:hex(PROV.tmp.c),hyd:hex(PROV.hyd.c)};

// ============ overview canvases ============
const frame=document.createElement('canvas');frame.width=W;frame.height=H;const fctx=frame.getContext('2d'),fimg=fctx.createImageData(W,H);
function renderFrame(t){const d=fimg.data;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const c=y*W+x,v=IV[c*T+t],o=c*4;
    if(v>0){const r=Math.round(Math.min(1,v/40)*255)*3;d[o]=RAMP[r];d[o+1]=RAMP[r+1];d[o+2]=RAMP[r+2];d[o+3]=255;}
    else if(inDomain(x,y)){d[o]=LAND[0];d[o+1]=LAND[1];d[o+2]=LAND[2];d[o+3]=255;}else d[o+3]=0;}
  fctx.putImageData(fimg,0,0);}
const durC=document.createElement('canvas');durC.width=BGW;durC.height=BGH;
(function(){const c=durC.getContext('2d'),im=c.createImageData(BGW,BGH),d=im.data,sx=(BG_EXT[1]-BG_EXT[0])/BGW,sy=(BG_EXT[3]-BG_EXT[2])/BGH;
  for(let y=0;y<BGH;y++){const gy=Math.floor((LAT0-(BG_EXT[3]-(y+.5)*sy))/DX);
    for(let x=0;x<BGW;x++){const i=y*BGW+x,v=BG[i],o=i*4;
      if(v>0){const r=Math.round(Math.min(1,(v-4)/95)*255)*3;d[o]=RAMP[r];d[o+1]=RAMP[r+1];d[o+2]=RAMP[r+2];d[o+3]=255;}
      else{const gx=Math.floor((BG_EXT[0]+(x+.5)*sx-LON0)/DX);if(gx>=0&&gx<W&&gy>=0&&gy<H&&inDomain(gx,gy)){d[o]=LAND[0];d[o+1]=LAND[1];d[o+2]=LAND[2];d[o+3]=255;}else d[o+3]=0;}}}
  c.putImageData(im,0,0);})();

// ============ map ============
const cv=$('map'),ctx=cv.getContext('2d'),wrap=$('mapwrap');
let view={k:40,cx:(BOUNDS[0]+BOUNDS[1])/2,cy:(BOUNDS[2]+BOUNDS[3])/2},layer='cycle',tool='cell',cur=0,showBorders=true,showRivers=false,mode='class',playing=false;
let dpr=1,cw=0,ch=0;
const HIRES_K=560; // px per degree where a 100 m pixel is ~0.5 screen px
function fitView(){view.k=Math.min(wrap.clientWidth/((BOUNDS[1]-BOUNDS[0])*1.01),wrap.clientHeight/((BOUNDS[3]-BOUNDS[2])*1.01));view.cx=(BOUNDS[0]+BOUNDS[1])/2;view.cy=(BOUNDS[2]+BOUNDS[3])/2;}
function resize(){dpr=window.devicePixelRatio||1;cw=wrap.clientWidth;ch=wrap.clientHeight;cv.width=Math.round(cw*dpr);cv.height=Math.round(ch*dpr);draw();}
const toScr=(lon,lat)=>[(lon-view.cx)*view.k+cw/2,(view.cy-lat)*view.k+ch/2];
const toGeo=(sx,sy)=>[(sx-cw/2)/view.k+view.cx,view.cy-(sy-ch/2)/view.k];
const CITIES=META.cities||[];
const hiresOn=()=>layer==='cycle'&&view.k>=HIRES_K;
function visibleTiles(){const [lo0,la1]=toGeo(0,0),[lo1,la0]=toGeo(cw,ch);
  const tx0=Math.max(0,Math.floor((lo0-LON0)/PX/TS)),tx1=Math.min(TA-1,Math.floor((lo1-LON0)/PX/TS)),ty0=Math.max(0,Math.floor((LAT0-la1)/PX/TS)),ty1=Math.min(TD-1,Math.floor((LAT0-la0)/PX/TS));
  const out=[];for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++)out.push(ty*TA+tx);return out;}
// decoded tiles + rendered canvases for the map
const dcache=new Map();const DMAX=48;
function dput(key,v){dcache.set(key,v);while(dcache.size>DMAX)dcache.delete(dcache.keys().next().value);}
const tcanv=new Map();const TCMAX=48;
function tileCanvas(t,k){const key=t+':'+k+':'+mode;let c=tcanv.get(key);if(c){tcanv.delete(key);tcanv.set(key,c);return c;}
  const dat=dcache.get(t+':'+k);if(!dat)return null;
  c=document.createElement('canvas');c.width=TS;c.height=TS;const g=c.getContext('2d'),im=g.createImageData(TS,TS),d=im.data;
  for(let i=0,n=TS*TS;i<n;i++){const cl=dat[i*2],o=i*4;if(!cl){d[o+3]=0;continue;}
    let rgb=CLASS_RGB[cl]||LAND;if(cl===1&&mode==='prov')rgb=PROV_RGB[provKind(dat[i*2+1])];
    d[o]=rgb[0];d[o+1]=rgb[1];d[o+2]=rgb[2];d[o+3]=255;}
  g.putImageData(im,0,0);tcanv.set(key,c);while(tcanv.size>TCMAX)tcanv.delete(tcanv.keys().next().value);return c;}
let hiresTimer=null,hiresGen=0;
function requestHires(){clearTimeout(hiresTimer);hiresTimer=setTimeout(loadHires,playing?600:160);}
async function loadHires(){if(!hiresOn()){updateNetMode();return;}const vis=visibleTiles();
  if(vis.length>40){$('netMode').textContent='Zoom in a little more to load 100 m pixels';return;}
  const t=cur,need=vis.filter(k=>!dcache.has(t+':'+k));updateNetMode(need.length);if(!need.length){draw();return;}
  const gen=++hiresGen;
  try{await fetchTiles(need.map(k=>[t,k]),async m=>{for(const [key,b] of m){const d=await decodeTile(b);dput(key,d);}if(gen===hiresGen||t===cur)draw();});}
  catch(e){$('netMode').textContent='Could not stream 100 m tiles: '+e.message;return;}
  updateNetMode(0);}
function updateNetMode(pending){if(!hiresOn()){$('netMode').textContent=layer==='cycle'?`Overview from ${CKM} summary. Zoom in to stream 100 m pixels.`:`Duration layer (${BGM}). Switch to “Selected date” and zoom in for 100 m pixels.`;return;}
  $('netMode').textContent=pending?`Streaming ${pending} 100 m tile${pending>1?'s':''} for this date from Zenodo…`:'Showing original 100 m pixels for this date';}
let rafPending=false;
function draw(){if(rafPending)return;rafPending=true;requestAnimationFrame(()=>{rafPending=false;drawNow();});}
function drawNow(){
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=`rgb(${OUT.join(',')})`;ctx.fillRect(0,0,cw,ch);
  ctx.imageSmoothingEnabled=view.k*DX<6;
  if(layer==='cycle'){const [x0,y0]=toScr(LON0,LAT0);ctx.drawImage(frame,x0,y0,W*DX*view.k,H*DX*view.k);
    if(hiresOn()){ctx.imageSmoothingEnabled=false;
      for(const k of visibleTiles()){const c=tileCanvas(cur,k);if(!c)continue;const tx=k%TA,ty=Math.floor(k/TA);
        const [sx,sy]=toScr(LON0+tx*TS*PX,LAT0-ty*TS*PX);const sz=TS*PX*view.k;ctx.drawImage(c,sx,sy,sz+.5,sz+.5);}}}
  else{const [x0,y0]=toScr(BG_EXT[0],BG_EXT[3]);ctx.drawImage(durC,x0,y0,(BG_EXT[1]-BG_EXT[0])*view.k,(BG_EXT[3]-BG_EXT[2])*view.k);}
  const path=(lines,stroke,wd)=>{ctx.beginPath();for(const l of lines)l.forEach((p,j)=>{const [x,y]=toScr(p[0],p[1]);j?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle=stroke;ctx.lineWidth=wd;ctx.stroke();};
  if(showRivers)path(VEC.rivers,'rgba(120,190,255,.55)',1);
  if(showBorders)path(VEC.borders,'rgba(235,240,236,.45)',1);
  ctx.font='500 11px "Public Sans",system-ui,sans-serif';ctx.textBaseline='middle';
  for(const [n,lo,la,minK] of CITIES){const [x,y]=toScr(lo,la);if(x<-50||y<-20||x>cw+50||y>ch+20)continue;if(view.k<(minK||0))continue;
    ctx.fillStyle='rgba(240,244,241,.9)';ctx.beginPath();ctx.arc(x,y,2.4,0,7);ctx.fill();ctx.lineWidth=3;ctx.strokeStyle='rgba(10,16,14,.75)';ctx.strokeText(n,x+5,y);ctx.fillText(n,x+5,y);}
  sels.forEach(s=>{const col=MAPCOL[s.pal];const [x0,y0]=toScr(LON0+s.px0*PX,LAT0-s.py0*PX),[x1,y1]=toScr(LON0+(s.px1+1)*PX,LAT0-(s.py1+1)*PX);
    const ww=Math.max(x1-x0,8),hh=Math.max(y1-y0,8),cx=(x0+x1)/2,cy=(y0+y1)/2;ctx.strokeStyle=col;ctx.lineWidth=2;ctx.strokeRect(cx-ww/2,cy-hh/2,ww,hh);
    if(s.type==='cell'&&s.pix){const [a,b]=toScr(LON0+s.pix[0]*PX,LAT0-s.pix[1]*PX),z=Math.max(PX*view.k,3);ctx.fillStyle=col;ctx.fillRect(a+(PX*view.k-z)/2,b+(PX*view.k-z)/2,z,z);}
    if(s.type==='rect'){ctx.fillStyle=col;ctx.globalAlpha=.12;ctx.fillRect(x0,y0,x1-x0,y1-y0);ctx.globalAlpha=1;}
    ctx.font='700 12px "Public Sans",system-ui,sans-serif';ctx.lineWidth=3;ctx.strokeStyle='rgba(10,16,14,.8)';ctx.fillStyle=col;
    ctx.strokeText(s.label,cx-ww/2,cy-hh/2-9);ctx.fillText(s.label,cx-ww/2,cy-hh/2-9);});
  if(drag&&drag.mode==='rect'){ctx.setLineDash([5,4]);ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.strokeRect(drag.x0,drag.y0,drag.x-drag.x0,drag.y-drag.y0);ctx.setLineDash([]);}}
function viewChanged(){draw();legend();if(hiresOn())requestHires();else updateNetMode();}
function zoomAt(f,sx,sy){const [lo,la]=toGeo(sx,sy);view.k=Math.max(15,Math.min(12000,view.k*f));const [lo2,la2]=toGeo(sx,sy);view.cx+=lo-lo2;view.cy+=la-la2;viewChanged();}
cv.addEventListener('wheel',e=>{e.preventDefault();const r=cv.getBoundingClientRect();zoomAt(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top);},{passive:false});
$('zin').onclick=()=>zoomAt(1.6,cw/2,ch/2);$('zout').onclick=()=>zoomAt(1/1.6,cw/2,ch/2);$('zhome').onclick=()=>{fitView();viewChanged();};
const ptrs=new Map();let drag=null,pinch=null;
cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);const r=cv.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;ptrs.set(e.pointerId,{x,y});
  if(ptrs.size===2){drag=null;const [a,b]=[...ptrs.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y),mx:(a.x+b.x)/2,my:(a.y+b.y)/2};return;}
  drag={mode:(tool==='rect'&&!e.shiftKey)?'rect':'pan',x0:x,y0:y,x,y,moved:false,cx:view.cx,cy:view.cy};});
cv.addEventListener('pointermove',e=>{const r=cv.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(ptrs.has(e.pointerId))ptrs.set(e.pointerId,{x,y});
  if(pinch&&ptrs.size===2){const [a,b]=[...ptrs.values()],d=Math.hypot(a.x-b.x,a.y-b.y),mx=(a.x+b.x)/2,my=(a.y+b.y)/2;zoomAt(d/pinch.d,mx,my);view.cx-=(mx-pinch.mx)/view.k;view.cy+=(my-pinch.my)/view.k;pinch={d,mx,my};draw();return;}
  hover(x,y);if(!drag)return;drag.x=x;drag.y=y;if(Math.hypot(x-drag.x0,y-drag.y0)>4)drag.moved=true;
  if(drag.mode==='pan'){view.cx=drag.cx-(x-drag.x0)/view.k;view.cy=drag.cy+(y-drag.y0)/view.k;}draw();});
const endPtr=e=>{ptrs.delete(e.pointerId);if(ptrs.size<2)pinch=null;
  if(drag){const d=drag;drag=null;
    if(d.mode==='rect'&&d.moved){const [a,b]=toGeo(d.x0,d.y0),[c,dd]=toGeo(d.x,d.y);addRect(Math.min(a,c),Math.max(a,c),Math.min(b,dd),Math.max(b,dd));}
    else if(d.mode==='pan'&&d.moved){viewChanged();}
    else if(!d.moved&&e.type==='pointerup'){const [lo,la]=toGeo(d.x0,d.y0);if(tool==='cell')addCell(lo,la);}
    draw();}};
cv.addEventListener('pointerup',endPtr);cv.addEventListener('pointercancel',endPtr);
cv.addEventListener('pointerleave',()=>{$('readout').textContent='Scroll or pinch to zoom, drag to pan';});
function hover(sx,sy){const [lo,la]=toGeo(sx,sy);let s=`${fmtLat(la)}, ${fmtLon(lo)}`;
  const gx=Math.floor((lo-LON0)/DX),gy=Math.floor((LAT0-la)/DX),px=Math.floor((lo-LON0)/PX),py=Math.floor((LAT0-la)/PX);
  if(layer==='cycle'){
    const dat=(px>=0&&px<PW&&py>=0&&py<PH)?dcache.get(cur+':'+tileOf(px,py)):null;
    if(hiresOn()&&dat){const i=((py%TS)*TS+(px%TS))*2,cl=dat[i];if(cl){s+=' — 100 m pixel: '+CLASS[cl].n.toLowerCase();if(cl===1)s+=' ('+PROV[provKind(dat[i+1])].n.toLowerCase()+')';}}
    else if(gx>=0&&gx<W&&gy>=0&&gy<H)s+=inDomain(gx,gy)?` — ${IV[(gy*W+gx)*T+cur]*2}% of ${CKM} cell flooded`:' — outside mapped forest';}
  else{const bx=Math.floor((lo-BG_EXT[0])/((BG_EXT[1]-BG_EXT[0])/BGW)),by=Math.floor((BG_EXT[3]-la)/((BG_EXT[3]-BG_EXT[2])/BGH));
    if(bx>=0&&bx<BGW&&by>=0&&by<BGH&&gx>=0&&gx<W&&gy>=0&&gy<H&&inDomain(gx,gy)){const v=BG[by*BGW+bx];s+=v>0?` — flooded in ${v} of 99 passes`:' — not flooded in any pass';}}
  $('readout').textContent=s;}

// ============ legend & time ============
function legend(){const el=$('legend');
  if(hiresOn()){const items=mode==='class'?[1,2,3,7,4,5,8].map(c=>[CLASS[c].c,CLASS[c].n]):[['obs'],['tmp'],['hyd']].map(([k])=>[PROV[k].c,PROV[k].n]).concat([[CLASS[2].c,'Open water'],[CLASS[4].c,'Not flooded']]);
    el.innerHTML='<div>100 m pixels from Zenodo</div>'+items.map(([c,n])=>`<div style="display:flex;gap:6px;align-items:center;margin-top:3px"><i style="width:10px;height:10px;border-radius:2px;background:${c};outline:1px solid rgba(255,255,255,.25)"></i>${n}</div>`).join('');return;}
  el.innerHTML=layer==='cycle'?`<div>Share of ${CKM} cell flooded</div><div class="bar" style="background:${cssGrad}"></div><div class="ticks"><span>2%</span><span>40%</span><span>80%+</span></div>`
   :`<div>Passes flooded, of 99 (${BGM})</div><div class="bar" style="background:${cssGrad}"></div><div class="ticks"><span>4</span><span>50</span><span>99</span></div>`;}
const slider=$('slider');const domSeries=new Float64Array(T);
function setCycle(t){cur=Math.max(0,Math.min(T-1,t));slider.value=cur;const c=cyc[cur];
  $('tLabel').textContent=fmtRange(c);$('tSub').textContent=`ALOS-2 ${c.cycle2!==c.cycle?`cycles ${c.cycle}–${c.cycle2}`:`cycle ${c.cycle}`}, pass ${c.k+1} of 9 in ${c.year} — ${Math.round(domSeries[cur]).toLocaleString()} km² flooded across the map`;
  if(layer==='cycle'){renderFrame(cur);draw();if(hiresOn())requestHires();}if(sels.length)drawChart();}
slider.oninput=()=>{stop();setCycle(+slider.value);};
$('step').onclick=()=>{stop();setCycle((cur+1)%T);};
let timer=null;
function stop(){if(timer){clearInterval(timer);timer=null;playing=false;$('play').textContent='▶';$('play').setAttribute('aria-label','Play');if(hiresOn())requestHires();}}
$('play').onclick=()=>{if(timer){stop();return;}if(layer!=='cycle')setLayer('cycle');playing=true;$('play').textContent='❚❚';$('play').setAttribute('aria-label','Pause');
  const slow=hiresOn()?1400:420;timer=setInterval(()=>setCycle((cur+1)%T),window.matchMedia('(prefers-reduced-motion: reduce)').matches?Math.max(1200,slow):slow);};
document.addEventListener('keydown',e=>{if(e.target===slider||(e.target.tagName==='INPUT'&&e.target.type!=='range'))return;if(e.key==='ArrowRight'){stop();setCycle(cur+1);}if(e.key==='ArrowLeft'){stop();setCycle(cur-1);}});
$('years').innerHTML=Array.from({length:11},(_,i)=>`<span>${i%2===0?2015+i:''}</span>`).join('');
function seg(id,fn){const el=$(id);el.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;el.querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b));fn(b.dataset.v);});}
function setLayer(v){layer=v;$('layerSeg').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x.dataset.v===v));if(v==='cycle')renderFrame(cur);else stop();viewChanged();}
seg('layerSeg',setLayer);
seg('toolSeg',v=>{tool=v;$('hint').hidden=v!=='rect';cv.style.cursor=v==='rect'?'cell':'crosshair';});
seg('modeSeg',v=>{mode=v;legend();draw();});
$('chkBorders').onchange=e=>{showBorders=e.target.checked;draw();};$('chkRivers').onchange=e=>{showRivers=e.target.checked;draw();};
let chartView='ts',unit='km';seg('viewSeg',v=>{chartView=v;drawChart();});seg('unitSeg',v=>{unit=v;drawChart();});

// ============ selections ============
let sels=[],selCounter=0;const PAL=['--s1','--s2','--s3','--s4'],MAPCOL=['#ff6fa3','#ffb054','#b39bff','#5fd6c2'];
const selColor=s=>getComputedStyle(document.documentElement).getPropertyValue(PAL[s.pal]).trim();
const MAX_TILES=40;
function boxArea(py0,py1,px0,px1){let a=0;for(let r=py0;r<=py1;r++)a+=pxArea(r);return a*(px1-px0+1);}
function cubeSeries(px0,px1,py0,py1){ // coarse-cube estimate for a 100 m pixel box (cells whose centres fall inside, or the containing cell for small boxes)
  let x0=Math.round(px0/CF),x1=Math.round((px1+1)/CF)-1,y0=Math.round(py0/CF),y1=Math.round((py1+1)/CF)-1,scale=1;
  if(x1<x0||y1<y0){x0=x1=Math.floor((px0+px1)/(2*CF));y0=y1=Math.floor((py0+py1)/(2*CF));scale=boxArea(py0,py1,px0,px1)/cellArea[y0];}
  x0=Math.max(0,x0);y0=Math.max(0,y0);x1=Math.min(W-1,x1);y1=Math.min(H-1,y1);
  const iv=new Float64Array(T),gf=new Float64Array(T),iv4=new Float64Array(T);
  for(let y=y0;y<=y1;y++){const ca=cellArea[y]*.02*scale;for(let x=x0;x<=x1;x++){const b=(y*W+x)*T;for(let t=0;t<T;t++){const v=IV[b+t];if(v)iv[t]+=v*ca;}}}
  for(let y=y0>>1;y<=(y1>>1)&&y<H4;y++)for(let x=x0>>1;x<=(x1>>1)&&x<W4;x++){const b=(y*W4+x)*T,ca=cellArea4[y]*.02;for(let t=0;t<T;t++)gf[t]+=GF[b+t]*ca;
    for(let yy=y*2;yy<y*2+2&&yy<H;yy++)for(let xx=x*2;xx<x*2+2&&xx<W;xx++){const bb=(yy*W+xx)*T,c2=cellArea[yy]*.02;for(let t=0;t<T;t++)iv4[t]+=IV[bb+t]*c2;}}
  const gshare=new Float64Array(T);for(let t=0;t<T;t++)gshare[t]=iv4[t]>0?Math.min(1,gf[t]/iv4[t]):0;return {iv,gshare};}
function tilesFor(s){const out=[];for(let ty=Math.floor(s.py0/TS);ty<=Math.floor(s.py1/TS);ty++)for(let tx=Math.floor(s.px0/TS);tx<=Math.floor(s.px1/TS);tx++)out.push(ty*TA+tx);return out;}
async function refine(s){ // exact 100 m counts streamed from Zenodo
  const tiles=tilesFor(s);s.tiles=tiles.length;
  if(tiles.length>MAX_TILES){s.status=`Too big to stream at 100 m (${tiles.length} tiles, limit ${MAX_TILES}); using ${CKM} summary`;refreshSels();return;}
  const iv=new Float64Array(T),gf=new Float64Array(T),cls=s.type==='cell'?new Uint8Array(T):null,prov=s.type==='cell'?new Uint8Array(T):null;
  const doneYears=new Set();let doneTiles=0;const totalTiles=tiles.length*T;s.status='Streaming 100 m tiles from Zenodo…';s.progress=0;refreshSels();
  const list=[];for(let t=0;t<T;t++)for(const k of tiles)list.push([t,k]);
  try{
    await fetchTiles(list,async m=>{
      for(const [key,bytes] of m){if(!sels.includes(s))return;const [t,k]=key.split(':').map(Number);const dat=await decodeTile(bytes);
        const tx=k%TA,ty=Math.floor(k/TA),ox=tx*TS,oy=ty*TS;
        const r0=Math.max(s.py0,oy),r1=Math.min(s.py1,oy+TS-1),c0=Math.max(s.px0,ox),c1=Math.min(s.px1,ox+TS-1);
        let a=0,g=0;for(let r=r0;r<=r1;r++){const pa=pxArea(r);let n=0,ng=0;const base=(r-oy)*TS;
          for(let c=c0;c<=c1;c++){const i=(base+c-ox)*2;if(dat[i]===1){n++;if(dat[i+1]>=21)ng++;}}a+=n*pa;g+=ng*pa;}
        iv[t]+=a;gf[t]+=g;
        if(cls&&k===tileOf(s.pix[0],s.pix[1])){const i=((s.pix[1]-oy)*TS+(s.pix[0]-ox))*2;cls[t]=dat[i];prov[t]=dat[i+1];}
        doneTiles++;}
      s.progress=doneTiles/totalTiles;refreshSelProgress(s);},{cache:tiles.length<=4});
  }catch(e){s.status='Streaming failed ('+e.message+'); showing '+CKM+' summary';refreshSels();return;}
  if(!sels.includes(s))return;
  s.iv=iv;s.gshare=iv.map((v,t)=>v>0?gf[t]/v:0);s.res='100 m';s.status='';s.cls=cls;s.prov=prov;s.progress=1;refreshSels();}
function freeSlot(){const used=new Set(sels.map(s=>s.pal));for(let i=0;i<4;i++)if(!used.has(i))return i;return null;}
function pushSel(s){let p=freeSlot();if(p===null){sels.shift();p=freeSlot();}s.pal=p;s.label=String.fromCharCode(65+(selCounter++%26));
  s.area=boxArea(s.py0,s.py1,s.px0,s.px1);Object.assign(s,cubeSeries(s.px0,s.px1,s.py0,s.py1));s.res=CKM;sels.push(s);refreshSels();refine(s);}
function addCell(lo,la){const px=Math.floor((lo-LON0)/PX),py=Math.floor((LAT0-la)/PX);if(px<0||px>=PW||py<0||py>=PH)return;
  const gx=Math.floor(px/CF),gy=Math.floor(py/CF);if(!inDomain(gx,gy)){$('readout').textContent='That spot is outside the mapped forest — try one along a river or swamp.';return;}
  const bx=Math.floor(px/10)*10,by=Math.floor(py/10)*10;
  pushSel({type:'cell',pix:[px,py],px0:bx,px1:Math.min(PW-1,bx+9),py0:by,py1:Math.min(PH-1,by+9),
    name:`Spot at ${fmtLat(LAT0-(py+.5)*PX)}, ${fmtLon(LON0+(px+.5)*PX)} (1 km block)`});}
function addRect(lo0,lo1,la0,la1){let px0=Math.max(0,Math.floor((lo0-LON0)/PX)),px1=Math.min(PW-1,Math.floor((lo1-LON0)/PX)),py0=Math.max(0,Math.floor((LAT0-la1)/PX)),py1=Math.min(PH-1,Math.floor((LAT0-la0)/PX));
  if(px1-px0<2||py1-py0<2)return;const fl=v=>`${Math.abs(v).toFixed(2)}°${v>=0?'N':'S'}`;
  pushSel({type:'rect',px0,px1,py0,py1,name:`Region ${fmtLon(LON0+px0*PX,2)} to ${fmtLon(LON0+(px1+1)*PX,2)}, ${fl(LAT0-(py1+1)*PX)} to ${fl(LAT0-py0*PX)}`});}
function refreshSelProgress(s){const el=document.querySelector(`[data-sel="${s.label}"] .prog i`);if(el)el.style.width=(100*s.progress)+'%';}
function refreshSels(){const box=$('sels');box.innerHTML='';
  sels.forEach((s,i)=>{const d=document.createElement('div');d.className='sel';d.dataset.sel=s.label;
    const sw=document.createElement('span');sw.className='sw';sw.style.background=selColor(s);
    const tx=document.createElement('div');const t1=document.createElement('div');t1.className='t';t1.textContent=`${s.label}. ${s.name}`;
    const badge=document.createElement('span');badge.className='res';badge.textContent=s.res;t1.append(badge);
    const t2=document.createElement('div');t2.className='m';t2.textContent=s.status||`${s.area<10?s.area.toFixed(2):Math.round(s.area).toLocaleString()} km² box`;tx.append(t1,t2);
    if(s.res===CKM&&s.progress!==undefined&&s.progress<1&&!/failed|Too big/.test(s.status||'')){const p=document.createElement('div');p.className='prog';p.style.color=selColor(s);p.innerHTML='<i></i>';p.firstChild.style.width=(100*s.progress)+'%';tx.append(p);}
    const b=document.createElement('button');b.setAttribute('aria-label','Remove selection '+s.label);b.textContent='×';b.onclick=()=>{sels.splice(i,1);refreshSels();draw();};
    d.append(sw,tx,b);box.append(d);});
  $('empty').hidden=sels.length>0;$('results').hidden=sels.length===0;$('csvBox').hidden=true;drawChart();drawCal();draw();}
$('clearAll').onclick=()=>{sels=[];refreshSels();};

// ============ stats & chart ============
const median=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;};
function sen(y){const s=[];for(let i=0;i<y.length;i++)for(let j=i+1;j<y.length;j++)s.push((y[j]-y[i])/(j-i));const m=median(s);return {m,b:median(y.map((v,i)=>v-m*i))};}
function erf(x){const t=1/(1+.3275911*Math.abs(x)),y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;}
function mk(y){const n=y.length;let S=0;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)S+=Math.sign(y[j]-y[i]);const v=n*(n-1)*(2*n+5)/18,z=S>0?(S-1)/Math.sqrt(v):S<0?(S+1)/Math.sqrt(v):0;return {S,p:1-erf(Math.abs(z)/Math.SQRT2)};}
const yearly=a=>Array.from({length:11},(_,y)=>{let s=0;for(let k=0;k<9;k++)s+=a[y*9+k];return s/9;});
const seasonal=a=>Array.from({length:9},(_,k)=>{const v=Array.from({length:11},(_,y)=>a[y*9+k]);return {mean:v.reduce((p,c)=>p+c,0)/11,min:Math.min(...v),max:Math.max(...v)};});
const scaled=s=>unit==='km'?Array.from(s.iv):Array.from(s.iv,v=>100*v/s.area);
const chartEl=$('chart');
function niceTicks(lo,hi,n){const span=hi-lo||1,st0=span/n,mag=10**Math.floor(Math.log10(st0)),st=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=st0);const out=[];for(let v=Math.ceil(lo/st)*st;v<=hi+1e-9;v+=st)out.push(v);return out;}
const fmtV=v=>unit==='km'?(Math.abs(v)>=100?Math.round(v).toLocaleString():v.toFixed(Math.abs(v)>=10?1:2)):v.toFixed(Math.abs(v)>=10?1:2)+'%';
function drawChart(){if(!sels.length){chartEl.innerHTML='';return;}
  const Wd=Math.max(300,chartEl.clientWidth||400),Hd=Math.round(Math.min(280,Math.max(200,Wd*.62))),m={l:52,r:10,t:12,b:28},pw=Wd-m.l-m.r,ph=Hd-m.t-m.b;
  let xs,ds;
  if(chartView==='ts'){xs=cyc.map(c=>c.dec);ds=sels.map(s=>({s,y:scaled(s)}));}
  else if(chartView==='yr'){xs=Array.from({length:11},(_,i)=>2015+i);ds=sels.map(s=>({s,y:yearly(scaled(s))}));}
  else{xs=Array.from({length:9},(_,k)=>k);ds=sels.map(s=>({s,se:seasonal(scaled(s))}));}
  let hi=0;ds.forEach(d=>{hi=Math.max(hi,...(d.y||d.se.flatMap(o=>[o.min,o.max])));});hi=hi*1.08||1;
  const xmin=Math.min(...xs),xmax=Math.max(...xs),X=v=>m.l+(v-xmin)/(xmax-xmin)*pw,Y=v=>m.t+ph-v/hi*ph;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${Wd} ${Hd}`);svg.setAttribute('width','100%');
  const el=(n,a)=>{const e=document.createElementNS(ns,n);for(const k in a)e.setAttribute(k,a[k]);svg.append(e);return e;};
  const lc=getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
  niceTicks(0,hi,4).forEach(v=>{el('line',{x1:m.l,x2:Wd-m.r,y1:Y(v),y2:Y(v),stroke:lc});el('text',{x:m.l-6,y:Y(v)+3.5,'text-anchor':'end'}).textContent=fmtV(v);});
  if(chartView!=='se'){for(let y=2015;y<=2025;y++){el('text',{x:chartView==='ts'?X(y+.5):X(y),y:Hd-8,'text-anchor':'middle'}).textContent=(chartView==='ts'&&Wd<420)?"'"+String(y).slice(2):y;
    if(chartView==='ts')el('line',{x1:X(y),x2:X(y),y1:m.t,y2:m.t+ph,stroke:lc,'stroke-dasharray':'2 3'});}}
  else for(let k=0;k<9;k++)el('text',{x:X(k),y:Hd-8,'text-anchor':'middle'}).textContent=MONTHS[cyc[k+45].mid.getUTCMonth()];
  if(chartView==='ts')el('line',{x1:X(cyc[cur].dec),x2:X(cyc[cur].dec),y1:m.t,y2:m.t+ph,stroke:'currentColor',opacity:.5});
  ds.forEach(d=>{const col=selColor(d.s),dash=d.s.res===CKM&&d.s.progress<1?'3 2':null;
    if(chartView==='se'){el('polygon',{points:d.se.map((o,k)=>`${X(k)},${Y(o.max)}`).concat(d.se.map((o,k)=>`${X(k)},${Y(o.min)}`).reverse()).join(' '),fill:col,opacity:.15});
      el('polyline',{points:d.se.map((o,k)=>`${X(k)},${Y(o.mean)}`).join(' '),fill:'none',stroke:col,'stroke-width':2});d.se.forEach((o,k)=>el('circle',{cx:X(k),cy:Y(o.mean),r:2.5,fill:col}));return;}
    const pl=el('polyline',{points:d.y.map((v,i)=>`${X(xs[i])},${Y(v)}`).join(' '),fill:'none',stroke:col,'stroke-width':chartView==='ts'?1.5:2,'stroke-linejoin':'round'});if(dash)pl.setAttribute('stroke-dasharray',dash);
    if(chartView==='yr')d.y.forEach((v,i)=>el('circle',{cx:X(xs[i]),cy:Y(v),r:3,fill:col}));
    const tr=sen(yearly(scaled(d.s))),xa=chartView==='ts'?2015.5:2015,xb=chartView==='ts'?2025.5:2025;
    el('line',{x1:X(xa),x2:X(xb),y1:Y(tr.b),y2:Y(tr.b+tr.m*10),stroke:col,'stroke-width':1.5,'stroke-dasharray':'6 4',opacity:.9});});
  const hit=el('rect',{x:m.l,y:m.t,width:pw,height:ph,fill:'transparent',style:'cursor:pointer'}),guide=el('line',{y1:m.t,y2:m.t+ph,stroke:'currentColor',opacity:0});
  chartEl.innerHTML='';chartEl.append(svg);const tip=document.createElement('div');tip.className='tip';tip.hidden=true;chartEl.append(tip);
  const idxAt=ev=>{const r=svg.getBoundingClientRect(),sx=(ev.clientX-r.left)*Wd/r.width;let b=0,bd=1e9;xs.forEach((v,i)=>{const d=Math.abs(X(v)-sx);if(d<bd){bd=d;b=i;}});return b;};
  hit.addEventListener('pointermove',ev=>{const i=idxAt(ev),r=svg.getBoundingClientRect();guide.setAttribute('x1',X(xs[i]));guide.setAttribute('x2',X(xs[i]));guide.setAttribute('opacity',.35);
    tip.textContent='';const h=document.createElement('div');h.style.fontWeight='600';h.textContent=chartView==='ts'?fmtRange(cyc[i]):chartView==='yr'?`${xs[i]} mean`:`Pass ${i+1} (${MONTHS[cyc[i+45].mid.getUTCMonth()]}), 11-year mean`;tip.append(h);
    ds.forEach(d=>{const q=document.createElement('div');q.textContent=`${d.s.label}: ${fmtV(d.y?d.y[i]:d.se[i].mean)}${chartView==='ts'?` (${Math.round(d.s.gshare[i]*100)}% gap-filled)`:''}`;tip.append(q);});
    tip.hidden=false;tip.style.left=Math.max(90,Math.min(r.width-90,X(xs[i])*r.width/Wd))+'px';tip.style.top=(m.t*r.height/Hd+8)+'px';});
  hit.addEventListener('pointerleave',()=>{tip.hidden=true;guide.setAttribute('opacity',0);});
  hit.addEventListener('click',ev=>{const i=idxAt(ev);stop();if(chartView==='ts'){if(layer!=='cycle')setLayer('cycle');setCycle(i);}else if(chartView==='yr'){setLayer('cycle');setCycle(i*9);}});
  drawStats();}
function drawStats(){const u=unit==='km'?'km²':'%';
  let h=`<thead><tr><th></th><th>Mean (${u})</th><th>Lowest</th><th>Highest</th><th>Trend /yr</th><th>p</th><th>Gap-filled</th></tr></thead><tbody>`;
  sels.forEach(s=>{const y=scaled(s),ym=yearly(y),tr=sen(ym),k=mk(ym),mean=y.reduce((a,b)=>a+b,0)/T,rel=mean>0?100*tr.m/mean:0,gs=s.gshare.reduce((a,b)=>a+b,0)/T;
    h+=`<tr><td><span style="color:${selColor(s)};font-weight:700">${s.label}</span></td><td>${fmtV(mean)}</td><td>${fmtV(Math.min(...y))}</td><td>${fmtV(Math.max(...y))}</td><td>${tr.m>=0?'+':''}${fmtV(tr.m)} (${rel>=0?'+':''}${rel.toFixed(1)}%)</td><td>${k.p<.001?'<0.001':k.p.toFixed(2)}</td><td>${Math.round(gs*100)}%</td></tr>`;});
  $('stats').innerHTML=h+'</tbody>';}
// calendar of the clicked 100 m pixel (latest spot with exact data)
function drawCal(){const box=$('cal');const s=[...sels].reverse().find(x=>x.type==='cell'&&x.cls);if(!s){box.hidden=true;return;}box.hidden=false;
  const cs=18,gap=3,l=40,tp=16,Wd=l+9*(cs+gap),Hd=tp+11*(cs+gap);
  let svg=`<svg viewBox="0 0 ${Wd} ${Hd}" role="img" aria-label="Class of pixel ${s.label} on each of 99 passes"><defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="4" fill="rgba(0,0,0,.45)"/></pattern></defs>`;
  for(let k=0;k<9;k++)svg+=`<text x="${l+k*(cs+gap)+cs/2}" y="10" text-anchor="middle">${k+1}</text>`;
  for(let y=0;y<11;y++){svg+=`<text x="${l-6}" y="${tp+y*(cs+gap)+cs/2+3.5}" text-anchor="end">${2015+y}</text>`;
    for(let k=0;k<9;k++){const t=y*9+k,cl=s.cls[t],c=cl?CLASS[cl].c:'transparent',x=l+k*(cs+gap),yy=tp+y*(cs+gap);
      const title=`${fmtRange(cyc[t])}: ${cl?CLASS[cl].n:'outside map'}${cl===1?' ('+PROV[provKind(s.prov[t])].n.toLowerCase()+')':''}`;
      svg+=`<g><title>${title}</title><rect x="${x}" y="${yy}" width="${cs}" height="${cs}" rx="3" fill="${c}" stroke="var(--line)"/>${cl===1&&s.prov[t]>=21?`<rect x="${x}" y="${yy}" width="${cs}" height="${cs}" rx="3" fill="url(#hatch)"/>`:''}</g>`;}}
  svg+='</svg>';
  const used=[...new Set(s.cls)].filter(Boolean).sort();
  box.innerHTML=`<h3>${s.label}: the clicked 100 m pixel on every pass</h3>${svg}<div class="callegend">${used.map(c=>`<span><i style="background:${CLASS[c].c};outline:1px solid var(--line)"></i>${CLASS[c].n}</span>`).join('')}<span><i style="background:${CLASS[1].c};background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.45) 0 2px,transparent 2px 4px)"></i>Flooded, gap-filled</span></div>`;}
$('copyCsv').onclick=async()=>{const hdr=['pass','cycle','start','end',...sels.flatMap(s=>[`${s.label}_flooded_km2`,`${s.label}_pct_of_box`,`${s.label}_gapfilled_share`].concat(s.cls?[`${s.label}_pixel_class`,`${s.label}_pixel_provenance`]:[]))];
  const rows=[hdr.join(',')];cyc.forEach((c,i)=>rows.push([i+1,c.cycle,META.cycles[i].start,META.cycles[i].end,...sels.flatMap(s=>[s.iv[i].toFixed(3),(100*s.iv[i]/s.area).toFixed(3),s.gshare[i].toFixed(3)].concat(s.cls?[s.cls[i],s.prov[i]]:[]))].join(',')));
  const txt=sels.map(s=>`# ${s.label}: ${s.name}; resolution ${s.res}; box ${s.area.toFixed(3)} km2; 100 m pixel cols ${s.px0}-${s.px1}, rows ${s.py0}-${s.py1}`).join('\n')+'\n# Source: Rosenqvist et al. (2026) doi:10.5281/zenodo.22981938 CC-BY 4.0\n'+rows.join('\n');
  try{await navigator.clipboard.writeText(txt);$('copyCsv').textContent='Copied';setTimeout(()=>$('copyCsv').textContent='Copy series as CSV',1600);}
  catch(e){const b=$('csvBox');b.hidden=false;b.value=txt;b.focus();b.select();$('copyCsv').textContent='Select the text below and copy';}};

// ============ region switcher & text ============
(function(){const h=document.querySelector('header');const row=document.createElement('div');row.className='regionrow';
  const lab=document.createElement('span');lab.className='lbl';lab.textContent='Region';const sg=document.createElement('span');sg.className='seg';
  REGIONS.forEach(r=>{const b=document.createElement('button');b.textContent=r.name;b.setAttribute('aria-pressed',r.id===REGION);
    b.onclick=()=>{if(r.id!==REGION)location.search='?region='+r.id;};sg.append(b);});row.append(lab,sg);h.prepend(row);
  h.querySelector('h1').textContent=META.title;document.title=META.title.replace(', 2015–2025','')+' explorer, 2015–2025';
  document.querySelectorAll('.ckm').forEach(e=>e.textContent=CKM);document.querySelectorAll('.gkm').forEach(e=>e.textContent=GKM);})();

// ============ init ============
for(let y=0;y<H;y++){const ca=cellArea[y]*.02;for(let x=0;x<W;x++){const b=(y*W+x)*T;for(let t=0;t<T;t++){const v=IV[b+t];if(v)domSeries[t]+=v*ca;}}}
new ResizeObserver(()=>{resize();if(sels.length)drawChart();}).observe(wrap);
fitView();legend();setCycle(0);resize();updateNetMode();netStatus();
$('loading').remove();
window.__explorer={get sels(){return sels;},view,setCycle,zoomTo:(lon,lat,k)=>{view.cx=lon;view.cy=lat;view.k=k;viewChanged();},addRect,addCell,rate};
})();
