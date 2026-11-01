// Deterministic POI integration tests; never contact a public API.
import assert from 'node:assert/strict';
import { setupPoi, toFeatures } from '../poi.js';

const geometry = {type:'Polygon',coordinates:[[[20,44],[42,44],[42,54],[20,54],[20,44]]]};
const osm = (id, key='fuel', p=[24,49.8], extra={}) => ({type:'Feature',id:'node/'+id,geometry:{type:'Point',coordinates:p},properties:{osmId:'node/'+id,category:key,amenity:key==='fuel'?'fuel':key==='charging'?'charging_station':'parking',...extra}});
const local = features => ({type:'FeatureCollection',metadata:{bbox:[[23.75,49.65,24.35,50.05]],osmIdAliases:{}},features});
const response = (json,status=200) => ({ok:status>=200&&status<300,status,json:async()=>json});
const flush = async () => {for(let i=0;i<30;i++)await Promise.resolve();};
const deferred = () => {let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const original = Object.fromEntries(['document','fetch','setTimeout','clearTimeout','localStorage'].map(k=>[k,globalThis[k]]));
const originalNow=Date.now;
class Element {
  constructor(){this.children=[];this.listeners=new Map();this.attrs={};this.style={};const values=new Set();this.classList={toggle:(s,on)=>on?values.add(s):values.delete(s)};this.textContent='';}
  append(el){this.children.push(el);}
  addEventListener(type,fn){this.listeners.set(type,fn);}
  removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type);}
  setAttribute(k,v){this.attrs[k]=v;}
  querySelector(){return this.icon??=new Element();}
  click(){this.listeners.get('click')?.();}
}
async function fixture(network,{outside=false}={}){
  let now=0,serial=0;const timers=new Map();
  globalThis.setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms});return id;};
  globalThis.clearTimeout=id=>timers.delete(id);Date.now=()=>now;
  const advance=async ms=>{const end=now+ms;for(let count=0;count<100;count++){const next=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);now=next[1].at;next[1].fn();await flush();if(count===99)throw Error('Unbounded timer loop');}now=end;await flush();};
  const status=new Element(), buttons=Object.fromEntries(['parking','paid','charging','fuel','repair'].map(key=>{const el=new Element();el.dataset={poi:key};return[key,el];}));
  globalThis.document={querySelector:()=>status,querySelectorAll:()=>Object.values(buttons),createElement:()=>new Element()};
  const saved=new Map();globalThis.localStorage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
  const calls=[];globalThis.fetch=(url,options={})=>{calls.push({url,options});return network(url,options);};
  const sources=new Map(),layers=new Map([['outside-ukraine',{}]]),handlers=[];
  let bounds=outside?[30,49.7,30.1,49.9]:[23.9,49.7,24.1,49.9];
  const map={zoom:13,getZoom(){return this.zoom;},getBounds(){const [w,s,e,n]=bounds;return{getWest:()=>w,getEast:()=>e,getSouth:()=>s,getNorth:()=>n,contains:([x,y])=>x>=w&&x<=e&&y>=s&&y<=n};},getSource:id=>sources.get(id),addSource:(id,s)=>sources.set(id,{data:s.data,setData(data){this.data=data;}}),getLayer:id=>layers.get(id),addLayer:l=>{assert.ok(!layers.has(l.id),'No duplicate layer');layers.set(l.id,l);},setLayoutProperty:(id,p,v)=>layers.get(id).layout[p]=v,getCanvas:()=>({style:{}}),on:(...args)=>handlers.push(args),off:(...args)=>{const i=handlers.findIndex(h=>h.length===args.length&&h.every((v,j)=>v===args[j]));if(i>=0)handlers.splice(i,1);}};
  const fire=(event,layer,payload={})=>{for(const h of [...handlers])if(h[0]===event&&(typeof h[1]==='function'||h[1]===layer))h.at(-1)(payload);};
  let popup;class Popup {setLngLat(){return this;}setDOMContent(content){this.content=content;return this;}addTo(){popup=this;return this;}remove(){this.removed=true;}}
  const instance=setupPoi(map,{geometry},Popup,()=>{});
  const data=key=>sources.get('parking-map-poi-'+key).data.features;
  return {map,status,buttons,advance,calls,data,instance,sources,layers,handlers,fire,getPopup:()=>popup,move(box){fire('movestart');bounds=box;fire('moveend');},timers};
}
try{
  assert.equal(toFeatures([null,{}, {type:'thing',id:1,tags:{amenity:'fuel'},lat:49,lon:24},{type:'node',id:1,tags:{amenity:'fuel'},lat:49,lon:24}], 'fuel',geometry).features.length,1);
  {
    const late=deferred();
    const f=await fixture(url=>url.includes('ocm')?late.promise:Promise.resolve(response(local([osm(1,'charging')]))));
    f.buttons.charging.click();await f.advance(700);
    assert.equal(f.data('charging').length,1,'Slow OCM cannot hide loaded OSM');
    late.resolve(response({type:'FeatureCollection',features:[null,{id:42}, {type:'Feature',id:'ocm/1',properties:{category:'charging'},geometry:{type:'Point',coordinates:[24,49.8]}}]}));await flush();
    assert.equal(f.data('charging').length,2,'Malformed external records do not drop valid records');
    const count=f.calls.length,handlerCount=f.handlers.length;
    f.sources.clear();f.layers.clear();f.layers.set('outside-ukraine',{});f.instance.restoreStyle();f.instance.restoreStyle();
    assert.equal(f.calls.length,count,'Restore uses cached data without fetch');assert.equal(f.handlers.length,handlerCount);assert.equal(f.data('charging').length,2);assert.equal(f.layers.get('parking-map-poi-charging').layout.visibility,'visible');
    f.instance.dispose();assert.equal(f.handlers.length,0);assert.equal(f.timers.size,0);
  }
  {
    const f=await fixture((url,{signal})=>url.includes('ocm')?new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('timeout'),{name:'AbortError'})))):Promise.resolve(response(local([osm(1,'charging'),osm(2,'fuel')]))));
    f.buttons.charging.click();await f.advance(700);assert.equal(f.data('charging').length,1);
    await f.advance(15000);assert.match(f.status.textContent,/OCM недоступні/);assert.equal(f.data('charging').length,1);
    f.buttons.charging.click();f.buttons.fuel.click();await f.advance(700);assert.doesNotMatch(f.status.textContent,/OCM недоступні/,'Inactive category must not leave stale error notice');f.instance.dispose();
  }
  {
    const late=deferred();const f=await fixture(()=>late.promise);
    f.buttons.charging.click();await f.advance(700);f.buttons.charging.click();
    late.resolve(response(local([osm(1,'charging')])));await flush();
    assert.equal(f.calls.length,1,'Toggle off while main file loads must not start OCM');f.instance.dispose();
  }
  {
    const late=deferred();const f=await fixture(()=>late.promise);
    f.buttons.charging.click();await f.advance(700);f.instance.dispose();late.resolve(response(local([osm(1,'charging')])));await flush();
    assert.equal(f.calls.length,1,'Dispose must not start another request');assert.equal(f.handlers.length,0);
  }
  {
    const d=local([osm(2,'fuel',[24.1,49.8])]);d.metadata.osmIdAliases={'node/1':'node/2'};
    const f=await fixture(url=>Promise.resolve(url.includes('interpreter')?response({elements:[1,2].map(id=>({type:'node',id,lon:24.1,lat:49.8,tags:{amenity:'fuel'}}))}):response(d)));
    f.move([24,49.7,24.4,49.9]);f.buttons.fuel.click();await f.advance(700);assert.equal(f.data('fuel').length,1,'Aliases and local/live duplicate ID normalize to one feature');f.instance.dispose();
  }
  for(const code of [406,429,502]){
    let n=0;const f=await fixture(()=>Promise.resolve(response(n++===0?{elements:[{type:'node',id:3,lon:30.05,lat:49.8,tags:{amenity:'fuel'}}]}:{},n===1?200:code)),{outside:true});
    f.buttons.fuel.click();await f.advance(700);assert.equal(f.data('fuel').length,1);
    f.move([30.01,49.7,30.11,49.9]);await f.advance(5000);assert.equal(f.calls.length,2);assert.equal(f.data('fuel').length,1,`HTTP ${code} retains points`);
    if(code===502){await f.advance(30000);assert.equal(f.calls.length,3);assert.match(f.status.textContent,/повторно/);for(let i=0;i<4;i++){f.move([30.01+i*.001,49.7,30.11,49.9]);await f.advance(100000);}assert.equal(f.calls.length,3,'502 retry bounded despite repeated movement');}
    else{await f.advance(100000);assert.equal(f.calls.length,2,'No unconditional 406/429 retry');}
    f.instance.dispose();
  }
  {
    let timedOut=false;const f=await fixture((url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{timedOut=true;reject(Object.assign(Error('timeout'),{name:'AbortError'}));})),{outside:true});
    f.buttons.fuel.click();await f.advance(700);await f.advance(30000);assert.ok(timedOut);assert.match(f.status.textContent,/не відповів/);f.instance.dispose();
  }
  {
    const bad=osm(1,'fuel',[24,49.8],{name:'<img src=x onerror=alert(1)>',access:'private'});
    const f=await fixture(()=>Promise.resolve(response(local([null,{properties:{category:'fuel'}},bad,bad]))));
    f.buttons.fuel.click();await f.advance(700);assert.equal(f.data('fuel').length,1);
    f.fire('click','parking-map-poi-fuel',{features:[bad]});
    assert.equal(f.getPopup().content.children[0].textContent,bad.properties.name,'Source markup remains textContent');
    assert.equal(f.getPopup().content.children.some(c=>c.textContent.includes('Приватний')),true);
    f.instance.dispose();
  }
  console.log('PASS: POI validation, slow OCM, stale requests, style lifecycle, bounded 406/429/502/timeout, retained data, text-only popup, cleanup');
}finally{Object.assign(globalThis,original);Date.now=originalNow;}
