// Offline import from the official cached OCM export. No browser API/key required.
const fs=require('node:fs'),path=require('node:path');
const cache=process.argv[2];
const refs=JSON.parse(fs.readFileSync(path.join(cache,'referencedata.json')));
const provider=refs.DataProviders.find(p=>p.ID===1);
if(!provider?.IsOpenDataLicensed||!provider.License?.includes('CC BY 4.0'))throw Error('Unverified license');
const candidates=JSON.parse(fs.readFileSync(path.join(cache,'lviv-candidates.json')));
const local=JSON.parse(fs.readFileSync('data/lviv-poi.geojson'));
const osm=local.features.filter(f=>f.properties.category==='charging');
if(!Array.isArray(local.metadata?.bbox)||!local.metadata.bbox.every(b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)))throw Error('Invalid local coverage');
const selected=[],excluded=[];
const distance=(a,b)=>Math.hypot((a[0]-b[0])*72000,(a[1]-b[1])*111000);
const seen=new Set();
for(const p of candidates){
 const a=p.AddressInfo??{},c=[a.Longitude,a.Latitude];
 const date=Date.parse(p.DateLastVerified);
 const validCoordinates=c.every(Number.isFinite)&&local.metadata.bbox.some(([w,s,e,n])=>c[0]>=w&&c[0]<=e&&c[1]>=s&&c[1]<=n);
 let reason=p.DataProviderID!==1?'License':!Number.isSafeInteger(p.ID)||p.ID<=0?'Invalid ID':seen.has(p.ID)?'Duplicate OCM ID':p.StatusTypeID!==50||p.SubmissionStatusTypeID!==200?'Not confirmed operational/published':!Number.isFinite(date)||date<Date.parse('2025-01-01')||date>Date.now()?'Invalid, old or future verification date':!validCoordinates?'Invalid/outside regional coordinates':null;
 const neighbor=[...osm,...selected].reduce((best,f)=>{const meters=distance(c,f.geometry.coordinates);return meters<best.meters?{feature:f,meters}:best},{meters:Infinity});
 const nearest=neighbor.meters;
 const needsReview=!reason&&nearest<250;
 if(needsReview)reason='Manual review: nearby charging point, not a proven duplicate';
 if(reason){excluded.push({id:p.ID,reason,nearestMeters:Number.isFinite(nearest)?Math.round(nearest):null,
   ...(needsReview?{needsReview:true,nearestID:neighbor.feature.id,nearestRef:neighbor.feature.properties.ref||null,nearestOperator:neighbor.feature.properties.operator||null,title:a.Title}: {})});continue;}
 seen.add(p.ID);
 const operator=refs.Operators.find(x=>x.ID===p.OperatorID)?.Title;
 const usage=refs.UsageTypes.find(x=>x.ID===p.UsageTypeID)?.Title;
 const connectors=(Array.isArray(p.Connections)?p.Connections:[]).map(x=>[refs.ConnectionTypes.find(t=>t.ID===x.ConnectionTypeID)?.Title,Number.isFinite(x.PowerKW)&&x.PowerKW>0?x.PowerKW+' кВт':null,Number.isSafeInteger(x.Quantity)&&x.Quantity>0?'×'+x.Quantity:null].filter(Boolean).join(' · ')).join('; ');
 selected.push({type:'Feature',id:'ocm/'+p.ID,geometry:{type:'Point',coordinates:c},properties:{category:'charging',sourceName:'Open Charge Map contributors',sourceId:String(p.ID),license:'CC BY 4.0',name:a.Title,operator:operator||'',phone:a.ContactTelephone1||'',website:a.RelatedURL||'','addr:street':a.AddressLine1||'',sourceVerified:p.DateLastVerified,sourceStatus:'Працювала за даними джерела; поточний стан не перевірено',usage:usage||'Невідомо',connectors,sourceUrl:'https://openchargemap.org/site/poi/details/'+p.ID}});
}
const result={type:'FeatureCollection',metadata:{source:'https://github.com/openchargemap/ocm-export',license:provider.License,attribution:'© Open Charge Map contributors — CC BY 4.0',retrievedAt:new Date().toISOString(),selection:'Provider 1; published/operational in source; DateLastVerified >= 2025-01-01; no charging POI within 250m',reviewed:candidates.length,excluded},features:selected};
const destination='data/lviv-charging-ocm.geojson',temporary=destination+'.'+process.pid+'.tmp';
try{fs.writeFileSync(temporary,JSON.stringify(result));fs.renameSync(temporary,destination);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
console.log(JSON.stringify({reviewed:candidates.length,added:selected.length,ids:selected.map(f=>f.id),excluded:excluded.length}));
