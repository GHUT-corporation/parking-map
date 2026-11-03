// Regression scenarios for GPS and routing races; no network, secrets or real GPS.
import assert from 'node:assert/strict';
import { setupNavigation, routingFailure, maneuverSymbol } from '../navigation.js';

class Element {
  constructor() { this.hidden=false; this.disabled=false; this.textContent=''; this.dataset={}; this.events=new Map(); this.attrs={}; this.values=new Map(); this.style={setProperty:(k,v)=>this.values.set(k,v)}; this.classes=new Set(); this.classList={toggle:(k,v)=>{const on=v??!this.classes.has(k);if(on)this.classes.add(k);else this.classes.delete(k);return on;},remove:k=>this.classes.delete(k)}; }
  addEventListener(k, fn) { if(!this.events.has(k))this.events.set(k,new Set());this.events.get(k).add(fn); }
  removeEventListener(k, fn) { this.events.get(k)?.delete(fn); }
  setAttribute(k,v) {this.attrs[k]=v;}
  getBoundingClientRect() {return {height:100};}
  click() {return Promise.all([...(this.events.get('click')??[])].map(fn=>fn()));}
}
class MapMock {
  constructor() {this.sources=new Map();this.layers=new Map([['outside-ukraine',{id:'outside-ukraine'}]]);this.events=new Map();this.camera=[];this.before=[];}
  getSource(id){return this.sources.get(id);}
  getLayer(id){return this.layers.get(id);}
  addSource(id,{data}){assert.ok(!this.sources.has(id),'Duplicate source');this.sources.set(id,{data, setData(value){this.data=structuredClone(value);}});}
  addLayer(layer,before){assert.ok(!this.layers.has(layer.id),'Duplicate layer');this.layers.set(layer.id,structuredClone(layer));this.before.push([layer.id,before]);}
  setPaintProperty(id,key,value){assert.ok(this.layers.has(id),id);this.layers.get(id).paint[key]=value;}
  on(key,fn){if(!this.events.has(key))this.events.set(key,new Set());this.events.get(key).add(fn);}
  off(key,fn){this.events.get(key)?.delete(fn);}
  fire(key,event){for(const fn of [...(this.events.get(key)??[])])fn(event);}
  getBearing(){return 0;}
  getZoom(){return 14;}
  easeTo(options){this.camera.push(options);}
  fitBounds(){this.camera.push('fit');}
}
class Marker {
  constructor({element}){this.element=element;this.removed=false;}
  setLngLat(point){this.point=point;return this;}
  addTo(map){this.map=map;return this;}
  getElement(){return this.element;}
  remove(){this.removed=true;}
}
class Bounds {extend(){return this;}}
const originalNow=Date.now;
let now=1_000_000;
Date.now=()=>now;
const origin=[24.0297,49.8397], destination=[24.05,49.85];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const fix=(overrides={})=>({coords:{longitude:origin[0],latitude:origin[1],accuracy:12,speed:0,heading:null,...overrides}});
const route=(extra={})=>({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'MultiLineString',coordinates:[[origin,[24.04,49.84],destination]]},properties:{distance:1500,time:300,legs:[{steps:[{from_index:1,name:'вулиця',instruction:{text:'Поверніть праворуч',type:'Right'}}]}],...extra}}]});
function fixture({ignoreAbort=false}={}) {
  const nodes=new Map(), created=[];
  globalThis.document={querySelector:k=>{if(!nodes.has(k))nodes.set(k,new Element());return nodes.get(k);},createElement:()=>{const e=new Element();created.push(e);return e;}};
  const orientationEvents=new Map();
  globalThis.window={PARKING_MAP_CONFIG:{geoapifyKey:'test-only'},matchMedia:()=>({matches:true}),addEventListener:(k,fn)=>orientationEvents.set(k,fn),removeEventListener:(k)=>orientationEvents.delete(k)};
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  globalThis.isSecureContext=true;
  const current=[],watches=[],cleared=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{geolocation:{getCurrentPosition:(ok,fail)=>current.push({ok,fail}),watchPosition:(ok,fail)=>{watches.push({ok,fail});return watches.length;},clearWatch:id=>cleared.push(id)}}});
  const requests=[];
  globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{
    const entry={url:new URL(url),options,resolve,reject};requests.push(entry);
    options.signal.addEventListener('abort',()=>{if(!ignoreAbort)reject(new DOMException('aborted','AbortError'));});
  });
  const map=new MapMock(), boundary={geometry:{type:'Polygon',coordinates:[[[22,44],[40,44],[40,53],[22,53],[22,44]]]}};
  const nav=setupNavigation(map,{Marker,LngLatBounds:Bounds,boundary});
  const ui=name=>nodes.get('#nav-'+name);
  const reply=async(index,status=200,body=route())=>{requests[index].resolve({ok:status===200,status,headers:{get:()=>null},json:async()=>body});await tick();};
  const locate=async(value=fix())=>{await ui('location').click();current.at(-1).ok(value);await tick();};
  const ready=async()=>{await locate();nav.setDestination(destination);await reply(requests.length-1);};
  return {nodes,created,map,nav,ui,current,watches,cleared,requests,reply,locate,ready,orientationEvents,destroy:async()=>{nav.dispose();await tick();}};
}
let scenarios=0;
async function test(name,fn){await fn();scenarios++;console.log('PASS:',name);}
try {
  await test('Demo route ownership cancels only its own destination, including pending GPS',async()=>{
    const f=fixture({ignoreAbort:true}),first={},second={};
    f.nav.setDestination(destination,'Демо',{owner:first});assert.equal(f.current.length,1);
    assert.equal(f.nav.clearDestinationFor(second),false);assert.equal(f.nav.clearDestinationFor(first),true);
    f.current[0].ok(fix());await tick();assert.equal(f.requests.length,0,'Cancelled selection cannot route after late GPS');
    f.nav.setDestination(destination,'Демо',{owner:first});f.current.at(-1).fail({code:1});
    assert.equal(f.requests.length,0);assert.match(f.ui('status').textContent,/Дозвольте.*налаштуваннях браузера/);
    await f.ui('location').click();f.current.at(-1).ok(fix());await tick();await f.reply(0);
    assert.equal(f.map.getSource('navigation-route').data.features.length,1,'GPS retry can route to the selected demo parking');
    assert.equal(f.nav.clearDestinationFor(first),true);
    await f.locate();f.nav.setDestination(destination,'Демо',{owner:first});await f.reply(1);
    f.nav.setDestination(destination,'Звичайний маршрут');await f.reply(2);
    assert.equal(f.nav.clearDestinationFor(first),false,'An ordinary route to even the same coordinates is independent');
    assert.equal(f.map.getSource('navigation-route').data.features.length,1);
    f.nav.setDestination([24.06,49.86],'Інший демо-вибір',{owner:second});
    assert.equal(f.nav.clearDestinationFor(first),false);assert.equal(f.nav.clearDestinationFor(second),true);
    await f.reply(3);assert.equal(f.map.getSource('navigation-route').data.features.length,0,'Late success cannot restore a cancelled demo route');
    await f.destroy();
  });
  await test('Invalid accuracy and heading cannot create fabricated GPS data',async()=>{
    const f=fixture();assert.equal(f.current.length,0);
    for(const accuracy of [NaN,undefined,Infinity,0,-1,1001]){await f.locate(fix({accuracy}));assert.equal(f.map.getSource('navigation-accuracy').data.features.length,0);}
    await f.locate(fix({speed:5,heading:400}));assert.equal(f.created[0].classes.has('directed'),false);
    await f.locate(fix({accuracy:900}));
    const ring=f.map.getSource('navigation-accuracy').data.features[0].geometry.coordinates[0];
    assert.ok(Math.abs((ring[0][0]-origin[0])*111320*Math.cos(origin[1]*Math.PI/180)-900)<.01,'Accuracy radius is not capped to an incorrect smaller value');
    assert.ok(JSON.stringify(f.map.getSource('navigation-accuracy').data).includes('coordinates'));
    await f.destroy();
  });
  await test('Invalid fix must not recalculate with the previous position',async()=>{
    const f=fixture();await f.ready();const count=f.requests.length;
    await f.locate(fix({accuracy:NaN}));assert.equal(f.requests.length,count);await f.destroy();
  });
  await test('Late one-shot callbacks after clear/dispose are inert',async()=>{
    const f=fixture();f.nav.setDestination(destination);await f.ui('clear').click();const cameras=f.map.camera.length;
    f.current[0].ok(fix());f.current[0].fail({code:1});await tick();assert.equal(f.requests.length,0);assert.equal(f.map.camera.length,cameras);assert.equal(f.ui('status').hidden,true);
    await f.ui('location').click();await f.destroy();f.current.at(-1).ok(fix());assert.equal(f.map.camera.length,cameras);
  });
  await test('Stale route success and 429 cannot replace destination or poison backoff',async()=>{
    const f=fixture({ignoreAbort:true});await f.locate();f.nav.setDestination(destination);f.nav.setDestination([24.06,49.86]);
    assert.equal(f.requests[0].options.signal.aborted,true);await f.reply(0,429);await f.reply(1);
    f.nav.setDestination([24.07,49.87]);assert.equal(f.requests.length,3);await f.reply(2);await f.destroy();
  });
  await test('GPS watch, restart, stale watch callbacks and removal cleanup',async()=>{
    const f=fixture();await f.ready();await f.ui('start').click();await f.ui('start').click();assert.equal(f.watches.length,1);
    f.watches[0].ok(fix({speed:5,heading:90}));assert.equal(f.created[0].classes.has('directed'),true);
    await f.ui('stop').click();const cameraCount=f.map.camera.length;f.watches[0].ok(fix());f.watches[0].fail({code:1});assert.equal(f.map.camera.length,cameraCount);
    await f.ui('start').click();assert.equal(f.watches.length,2);f.map.fire('remove');assert.deepEqual(f.cleared,[1,2]);assert.equal(f.orientationEvents.size,0);assert.equal(f.ui('location').events.get('click').size,0);
  });
  await test('Pending recalculation cannot start the previous preview; GPS errors stay explicit',async()=>{
    const f=fixture();await f.ready();await f.locate(fix({longitude:24.03}));
    assert.equal(f.ui('start').disabled,true);await f.ui('start').click();assert.equal(f.watches.length,0);
    await f.reply(f.requests.length-1);assert.equal(f.ui('start').disabled,false);
    await f.ui('location').click();f.current.at(-1).fail({code:3});assert.ok(f.ui('status').textContent.includes('GPS вичерпано'));
    delete navigator.geolocation;await f.ui('location').click();assert.ok(f.ui('status').textContent.includes('HTTPS'));
    await f.destroy();
  });
  await test('Invalid MultiLineString/negative metrics are rejected; HTTP errors recover',async()=>{
    const f=fixture();await f.locate();
    for(const payload of [route({time:-1}),route({distance:-1}),{features:[{geometry:{type:'MultiLineString',coordinates:[[],destination]},properties:{time:1,distance:1}}]}]){
      f.nav.setDestination(destination);await f.reply(f.requests.length-1,200,payload);assert.equal(f.map.getSource('navigation-route').data.features.length,0);assert.equal(f.ui('start').disabled,true);
    }
    for(const status of [401,403,500,429]){f.nav.setDestination(destination);await f.reply(f.requests.length-1,status);assert.ok(f.ui('status').textContent.includes(String(status)));}
    const count=f.requests.length;f.nav.setDestination(destination);assert.equal(f.requests.length,count);now+=61000;
    // A fresh fix is required after sixty seconds; no old location is silently reused.
    f.current.at(-1).ok(fix());await tick();assert.equal(f.requests.length,count+1);await f.reply(count);await f.destroy();
  });
  await test('Controlled routing timeout does not leave a pending UI',async()=>{
    const f=fixture();await f.locate();f.nav.setDestination(destination);
    f.requests[0].reject(new DOMException('timeout','AbortError'));await tick();
    assert.ok(f.ui('status').textContent.includes('Час очікування Geoapify'));
    assert.equal(f.ui('start').disabled,true);await f.destroy();
  });
  await test('Reroute failure retains last usable route; style restoration is idempotent',async()=>{
    const f=fixture();await f.ready();await f.ui('start').click();f.watches[0].ok(fix({longitude:24.1,latitude:49.9}));now+=16000;f.watches[0].ok(fix({longitude:24.1,latitude:49.9}));
    assert.equal(f.requests.length,2);await f.reply(1,500);assert.equal(f.map.getSource('navigation-route').data.features.length,1);
    f.map.sources.clear();f.map.layers=new Map([['outside-ukraine',{id:'outside-ukraine'}]]);f.nav.restoreStyle();f.nav.restoreStyle();
    assert.equal(f.map.sources.size,2);assert.equal(f.map.layers.size,6);assert.equal(f.map.getSource('navigation-route').data.features.length,1);assert.equal(f.watches.length,1);
    assert.ok(f.map.before.every(([,before])=>before==='outside-ukraine'));await f.destroy();
  });
  await test('Coordinate order, locale, multi-leg indexes and API failure mapping',async()=>{
    const f=fixture();await f.locate();f.nav.setDestination(destination);const p=f.requests[0].url.searchParams;
    assert.equal(p.get('waypoints'),'49.8397,24.0297|49.85,24.05');assert.equal(p.get('lang'),'uk');assert.equal(p.get('mode'),'drive');
    const body=route();body.features[0].geometry.coordinates=[[origin,[24.04,49.84]],[[24.04,49.84],destination]];body.features[0].properties.legs=[{steps:[]},{steps:[{from_index:1,instruction:{type:'DestinationReached',text:'Ви прибули'},name:'Пункт'}]}];
    await f.reply(0,200,body);assert.equal(f.ui('next').textContent,'Ви прибули');assert.equal(f.ui('maneuver').textContent,'⚑');
    assert.equal(routingFailure(429,'120').backoffMs,120000);assert.equal(maneuverSymbol('Unknown'),'•');assert.equal(maneuverSymbol(42),'•');await f.destroy();
  });
  console.log(JSON.stringify({result:'PASS',scenarios,network:'mocked',gps:'mocked'}));
} finally { Date.now=originalNow; }
