import {paintPhoto} from './week-card-paint-renderer.js';
const sources=new Map();
onmessage=async({data:{id,key,blob,strength}})=>{
  try{
    let bitmap=sources.get(key);
    if(!bitmap){bitmap=await createImageBitmap(blob);sources.set(key,bitmap);if(sources.size>6){const first=sources.keys().next().value;sources.get(first).close();sources.delete(first);}}
    const result=await paintPhoto(bitmap,strength,(w,h)=>new OffscreenCanvas(w,h));
    postMessage({id,...result});
  }catch(error){postMessage({id,error:error.message});}
};
