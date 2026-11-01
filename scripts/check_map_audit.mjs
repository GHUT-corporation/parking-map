import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const base = () => [
  {id:'background',type:'background'},
  {id:'Main road',type:'line',source:'maptiler_planet_v4','source-layer':'road',paint:{'line-width':['interpolate',['linear'],['zoom'],4,1,16,5]}},
  {id:'POI',type:'symbol',source:'maptiler_planet_v4','source-layer':'poi_food'},
];
class FakeMap extends EventEmitter {
  constructor(){super();FakeMap.instance=this;this.reset();}
  reset(){this.layers=base();this.sources={maptiler_planet_v4:{}};}
  getStyle(){return {layers:this.layers};}
  getLayer(id){return this.layers.find(l=>l.id===id);}
  getSource(id){return this.sources[id];}
  isSourceLoaded(){return false;}
  addSource(id,s){assert.ok(!this.sources[id]);this.sources[id]={...s,setData(data){this.data=data;}};}
  addLayer(l,before){assert.ok(!this.getLayer(l.id));const index=this.layers.findIndex(x=>x.id===before);if(index>=0)this.layers.splice(index,0,l);else this.layers.push(l);}
  setPaintProperty(id,p,v){const l=this.getLayer(id);assert.ok(l);(l.paint??={})[p]=v;}
  getPaintProperty(id,p){return this.getLayer(id)?.paint?.[p];}
  setLayoutProperty(id,p,v){const l=this.getLayer(id);assert.ok(l);(l.layout??={})[p]=v;}
  setMissingStyleImageResolver(resolver){this.imageResolver=resolver;}
  hasImage(id){return this.images?.has(id);}
  addImage(id,data,options){this.images??=new Map();this.images.set(id,{data,options});}
  addControl(){} resize(){} getBearing(){return 0;}
}
const elements=new Map();
const element=selector=>{if(!elements.has(selector))elements.set(selector,{style:{setProperty(){}},addEventListener(){},removeEventListener(){}});return elements.get(selector);};
const media={matches:false,listeners:new Set(),addEventListener(_n,f){this.listeners.add(f)},removeEventListener(_n,f){this.listeners.delete(f)}};
const counts={navigation:0,poi:0,restoreNavigation:0,restorePoi:0};
const logs=[];
const sandbox={MapLibreMap:FakeMap,NavigationControl:class {},Marker:class {},Popup:class {},LngLatBounds:class {},
 AbortController,setTimeout,clearTimeout,
 document:{querySelector:element,createElement:()=>({getContext:()=>({getExtension:()=>({loseContext(){}})})})},
 window:{PARKING_MAP_CONFIG:{mapTilerKey:'fixture-key'},WebGL2RenderingContext:class {},matchMedia:()=>media},
 ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
 console:{error:(...args)=>logs.push(args.join(' '))},
 fetch:async()=>({ok:true,json:async()=>({features:[{geometry:{type:'Polygon',coordinates:[[[23,48],[24,48],[24,49],[23,49],[23,48]]]},properties:{shapeISO:'UKR'}}]})}),
 setupNavigation:()=>{counts.navigation++;return{setDestination(){},restoreStyle(){counts.restoreNavigation++}}},
 setupPoi:()=>{counts.poi++;return{restoreStyle(){counts.restorePoi++}}},
};
let source=fs.readFileSync(new URL('../script.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\s*/gm,'').replace(/startMap\(\);\s*$/,'');
vm.createContext(sandbox);vm.runInContext(source,sandbox);
const api=vm.runInContext('({startMap,readUkraineBoundary,normalizeBoundary,makeWorldMask,safeMapError,orientRing})',sandbox);
assert.throws(()=>api.orientRing([[23,48],[NaN,49],[24,50]],true));
assert.throws(()=>api.orientRing([[23,48],[24,49],[25,50]],true));
assert.throws(()=>api.normalizeBoundary({features:[{geometry:{type:'Polygon',coordinates:[]}}]}));
assert.ok(!api.safeMapError('https://example.com/?key=fixture-secret&apiKey=another-secret').includes('fixture-secret'));
await api.startMap();const map=FakeMap.instance;
map.imageResolver('transportation:road_'); assert.equal(map.images.get('transportation:road_').options.sdf,true);
map.imageResolver('unknown-icon'); assert.equal(map.hasImage('unknown-icon'),false);
map.emit('style.load');assert.equal(counts.navigation,1);assert.equal(media.listeners.size,1);
for(let i=0;i<3;i++){map.reset();map.emit('style.load');assert.equal(media.listeners.size,1);assert.equal(map.getLayer('POI').layout.visibility,'none');}
assert.deepEqual(counts,{navigation:1,poi:1,restoreNavigation:3,restorePoi:3});
assert.equal(map.listeners('sourcedata').length,1);assert.equal(map.listeners('idle').length,1);
map.emit('error',{error:{status:401,message:'https://example.com/?key=fixture-secret'}});
assert.ok(!logs.join().includes('fixture-secret'));
map.emit('remove');assert.equal(media.listeners.size,0);
assert.equal(logs.length,1);
let boundaryTimeout;
sandbox.setTimeout=fn=>{boundaryTimeout=fn;return 1;};sandbox.clearTimeout=()=>{};
sandbox.fetch=(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
const pending=api.readUkraineBoundary();boundaryTimeout();await assert.rejects(pending,/Час очікування/);
console.log('Map audit: PASS (style restoration, listener bounds, geometry validation, key redaction)');
