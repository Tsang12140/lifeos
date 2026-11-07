import{paintPhoto}from'./week-card-paint-renderer.js';
const idle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function normalizeSource(blob,url){
  if(!blob.type.includes('svg')&&!url.startsWith('blob:'))return blob;
  // ImageBitmap cannot decode every SVG. Rasterise demo SVG/local files once,
  // also keeping a large local camera photo out of the worker's source cache.
  const temporary=URL.createObjectURL(blob),image=new Image();
  try{image.src=temporary;await image.decode();const c=Object.assign(document.createElement('canvas'),{width:640,height:230}),ctx=c.getContext('2d');const scale=Math.max(640/image.naturalWidth,230/image.naturalHeight),w=image.naturalWidth*scale,h=image.naturalHeight*scale;ctx.drawImage(image,(640-w)/2,(230-h)/2,w,h);const result=await new Promise(resolve=>c.toBlob(resolve,'image/webp',.9));if(!result)throw Error('Image conversion failed');return result;}
  finally{URL.revokeObjectURL(temporary);}
}
export function createPaintCache(){
  const cache=new Map(),sources=new Map(),pending=new Map();let serial=Promise.resolve(),id=0,worker;
  const stats={renders:0,hits:0,joins:0,worker:false,renderMs:[],bytes:[],strokes:[],failures:0,lastError:''};
  if(typeof Worker!=='undefined'&&typeof OffscreenCanvas!=='undefined'){try{worker=new Worker(new URL('./week-card-paint-worker.js',import.meta.url),{type:'module'});stats.worker=true;}catch{}}
  const source=async url=>{if(!sources.has(url))sources.set(url,fetch(url,{credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error(`Photo ${r.status}`);return r.blob();}).then(blob=>normalizeSource(blob,url)).catch(e=>{sources.delete(url);throw e;}));if(sources.size>6)sources.delete(sources.keys().next().value);return sources.get(url);};
  async function render(url,strength){
    const blob=await source(url);let result;
    if(worker){result=await new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{worker.terminate();worker=null;stats.worker=false;reject(Error('笔触生成超时'));},20000);worker.onmessage=({data})=>{if(data.id!==n)return;clearTimeout(timer);data.error?reject(Error(data.error)):resolve(data);};worker.onerror=()=>{clearTimeout(timer);worker.terminate();worker=null;stats.worker=false;reject(Error('笔触线程未能启动'));};worker.postMessage({id:n,key:url,blob,strength});});}
    else{const image=await createImageBitmap(blob);try{result=await paintPhoto(image,strength,(w,h)=>Object.assign(document.createElement('canvas'),{width:w,height:h}),idle);}finally{image.close();}}
    stats.renders++;stats.renderMs.push(result.ms);stats.bytes.push(result.blob.size);stats.strokes.push(result.strokes);
    const value={url:URL.createObjectURL(result.blob),...result};cache.set(url+'|'+strength,value);return value;
  }
  return{stats,async get(url,strength){if(!strength)return{url,ms:0,strokes:0};const key=url+'|'+strength;if(cache.has(key)){stats.hits++;const value=cache.get(key);cache.delete(key);cache.set(key,value);return value;}if(pending.has(key)){stats.joins++;return pending.get(key);}const job=serial.catch(()=>{}).then(()=>render(url,strength)).catch(e=>{stats.failures++;stats.lastError=e.message;throw e;}).finally(()=>pending.delete(key));serial=job;pending.set(key,job);return job;},
    // Release only after a whole display update so displayed URLs are never evicted mid-paint.
    prune(keep=new Set()){for(const[key,value]of cache){if(cache.size<=24)break;if(!keep.has(value.url)){URL.revokeObjectURL(value.url);cache.delete(key);}}},
    close(){worker?.terminate();cache.forEach(v=>URL.revokeObjectURL(v.url));cache.clear();sources.clear();},
    clearSource(url){sources.delete(url);}
  };
}
