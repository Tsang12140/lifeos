/** Demo-only, bounded CPU painter. No frame loop, model or original-file edits. */
export async function paintPhoto(source, strength, makeCanvas, yieldLayer = async () => {}) {
  const width=640,height=230,start=performance.now(),amount=Math.max(0,Math.min(2.5,strength/100)),extra=Math.max(0,amount-1);
  const original=makeCanvas(width,height),sample=original.getContext('2d',{willReadFrequently:true});
  const scale=Math.max(width/source.width,height/source.height),w=source.width*scale,h=source.height*scale;
  sample.drawImage(source,(width-w)/2,(height-h)/2,w,h);
  const pixels=sample.getImageData(0,0,width,height).data;
  const canvas=makeCanvas(width,height),ctx=canvas.getContext('2d');
  // A softly reduced base keeps recognisable composition under the paint marks.
  const baseWidth=Math.round(80/(1+extra*1.2)),baseHeight=Math.max(8,Math.round(baseWidth*height/width));
  const base=makeCanvas(baseWidth,baseHeight),bc=base.getContext('2d');bc.drawImage(original,0,0,baseWidth,baseHeight);
  ctx.drawImage(base,0,0,width,height);
  let seed=0x6d2b79f5;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
  const at=(x,y)=>4*(Math.min(height-1,Math.max(0,y|0))*width+Math.min(width-1,Math.max(0,x|0)));
  const luma=(i)=>pixels[i]*.299+pixels[i+1]*.587+pixels[i+2]*.114;
  let strokes=0;
  for(const layer of[0,1,2]){
    const step=[18+amount*9,9+amount*7,5+amount*5][layer];
    for(let y=-step,row=0;y<height+step;y+=step,row++){
      for(let x=-step;x<width+step;x+=step){
      const px=x+(random()-.5)*step,py=y+(random()-.5)*step,i=at(px,py);
      const gx=luma(at(px+3,py))-luma(at(px-3,py)),gy=luma(at(px,py+3))-luma(at(px,py-3));
      const angle=Math.atan2(gy,gx)+Math.PI/2+(random()-.5)*1.1;
      const length=step*(1.3+random())*(1+extra*.7),thick=step*(.42+random()*.32)*(1+extra*.25),c=Math.cos(angle),s=Math.sin(angle);
      const shift=(random()-.5)*16*(1+extra*.8),sampleColor=[pixels[i],pixels[i+1],pixels[i+2]];
      if(extra){sampleColor.fill(0);const radius=3+extra*7;for(const ox of[-1,0,1])for(const oy of[-1,0,1]){const q=at(px+ox*radius,py+oy*radius);for(let k=0;k<3;k++)sampleColor[k]+=pixels[q+k]/9;}}
      const mean=(sampleColor[0]+sampleColor[1]+sampleColor[2])/3,quantize=extra?6+extra*14:1;
      const color=sampleColor.map(v=>Math.round(Math.max(0,Math.min(255,Math.round((v*.9+mean*.1+shift)/quantize)*quantize))));
      ctx.setTransform(c,s,-s,c,px,py);ctx.globalAlpha=[.82,.76,.62][layer];ctx.fillStyle=`rgb(${color.join(' ')})`;
      // Uneven flat brush: broken edges, differently sized bristles, visible direction.
      ctx.beginPath();ctx.moveTo(-length*.5,-thick*.25);ctx.lineTo(-length*.31,-thick*.52);ctx.lineTo(length*.22,-thick*.42);ctx.lineTo(length*.48,-thick*.15);ctx.lineTo(length*.37,thick*.43);ctx.lineTo(-length*.38,thick*.51);ctx.closePath();ctx.fill();
      if(random()>.36){ctx.globalAlpha=.12+amount*.1;ctx.strokeStyle=`rgb(${color.map(v=>Math.min(255,v+38)).join(' ')})`;ctx.lineWidth=.45+random()*.65;ctx.beginPath();ctx.moveTo(-length*.4,thick*.1);ctx.lineTo(length*.24,thick*.04);ctx.stroke();}
        strokes++;
      }
      // The fallback yields between small batches; normal worker drawing stays off-thread.
      if(row%8===7)await yieldLayer();
    }
    ctx.resetTransform();await yieldLayer();
  }
  // Blend a little original structure back at the light end. Strong deliberately loses detail.
  ctx.globalAlpha=Math.max(0,1-amount)*.62;ctx.drawImage(original,0,0);ctx.globalAlpha=1;
  const grain=ctx.getImageData(0,0,width,height),d=grain.data;
  for(let p=0;p<d.length;p+=4){const n=(random()-.5)*(4+amount*7);d[p]+=n;d[p+1]+=n;d[p+2]+=n;}
  ctx.putImageData(grain,0,0);
  const blob=canvas.convertToBlob?await canvas.convertToBlob({type:'image/webp',quality:.83}):await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.83));
  if(!blob)throw Error('Cannot encode painted photo');
  return{blob,ms:performance.now()-start,strokes,width,height};
}
