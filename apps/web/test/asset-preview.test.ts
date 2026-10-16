import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { boundPhoto, fitPhoto, photoPreviewSession, zoomPhoto } from "../src/asset-preview-model.ts";
import type { Asset } from "@lifeos/core";
import type { RecordView } from "../src/api.ts";

const assets = ["a","b","c"].map(id => ({ id, kind:"photo",storageRefs:[{sourceId:"local",sourceRef:id+".jpg"}] })) as Asset[];
const record = (id:string, ids:string[], kind="journal") => ({ id,kind,assetRefs:ids.map(assetId=>({assetId,role:"photo"})) }) as RecordView;
test("photo navigation preserves diary order, duplicate owners, selected photo and entry scope",()=>{
  const first=record("first",["a","b"]),second=record("second",["a","c"]),task=record("task",["a"],"task"),empty=record("empty",[]);
  const session=photoPreviewSession(["a","b"],1,assets,[first,task,empty,second],first);
  deepEqual(session.assetIds,["a","b","a","c"]);equal(session.index,1);
  deepEqual(session.owners?.map(r=>r.id),["first","first","second","second"]);
  deepEqual(photoPreviewSession(["a"],0,assets,[second],second).assetIds,["a","c"]);
  deepEqual(photoPreviewSession(["a"],0,assets,[first,second],task).assetIds,["a"]);
  deepEqual(photoPreviewSession(["a"],0,assets,[],first).owners?.map(r=>r.id),["first","first"]);
  deepEqual(photoPreviewSession(["pending:1"],0,[],[]),{assetIds:["pending:1"],index:0});
});
test("zoom pins the content under the pointer and bounds pan after rotation or resize",()=>{
  const previous={zoom:2,x:30,y:-40},point={x:110,y:70};
  const next=zoomPhoto(previous,4,point);
  equal((point.x-previous.x)/previous.zoom,(point.x-next.x)/next.zoom);
  equal((point.y-previous.y)/previous.zoom,(point.y-next.y)/next.zoom);
  equal(zoomPhoto(previous,100,point).zoom,16);equal(zoomPhoto(previous,0,point).zoom,1);
  equal(fitPhoto(1000,2000,800,600,0),.3);equal(fitPhoto(1000,2000,800,600,90),.4);
  deepEqual(boundPhoto({zoom:1,x:999,y:-999},1000,2000,800,600,0),{zoom:1,x:0,y:0});
  const bounded=boundPhoto({zoom:4,x:99999,y:-99999},1000,2000,800,600,90);
  ok(Math.abs(bounded.x)<=1200 && Math.abs(bounded.y)<=500);
});
