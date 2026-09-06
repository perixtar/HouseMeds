import {readFile,writeFile,mkdir} from 'node:fs/promises';import {makePool} from '../src/db.ts';
const names=[['lisinopril','20mg'],['metformin','500mg'],['fluoxetine','20mg'],['atorvastatin','40mg'],['amlodipine','10mg'],['losartan','100mg'],['sertraline','50mg'],['simvastatin','20mg'],['hydrochlorothiazide','25mg'],['amoxicillin','500mg']];
const catalog=JSON.parse(await readFile('.cache/access-probes/costplus-catalog.json','utf8')).results;
const db=makePool();const listings=[];try{
for(const source of ['healthwarehouse','costplus'])for(const [name,strength] of names){
 let row;const known={fluoxetine:'https://www.healthwarehouse.com/fluoxetine-20mg-capsules',amlodipine:'https://www.healthwarehouse.com/amlodipine-besylate-10mg-tablets-generic-norvasc',amoxicillin:'https://www.healthwarehouse.com/amoxicillin-500mg-capsules'};
 if(source==='costplus'){
  const product=catalog.find(x=>String(x.medication_name).toLowerCase().startsWith(name)&&x.strength.toLowerCase()===strength&&['Tablet','Capsule'].includes(x.form)&&x.brand_generic==='Generic');if(!product)throw Error('No catalog match: '+name);
  row=(await db.query('select p.id,p.url from pricing.crawl_pages p join pricing.sources s on s.id=p.source_id where s.slug=$1 and p.url=$2',[source,product.url])).rows[0];
 }else{
  const candidates=(await db.query(`select p.id,p.url from pricing.crawl_pages p join pricing.sources s on s.id=p.source_id where s.slug=$1 and p.url ilike $2 and p.url ilike $3 and p.page_type<>'ignored' order by length(p.url),p.url`,[source,'%/'+name+'%','%-'+strength+'-%'])).rows;
  row=known[name]?candidates.find(x=>x.url===known[name]):candidates.find(x=>/tablets|capsules/.test(x.url)&&!/-er-|-xr-|extended/.test(x.url)&&(!/-hctz-/.test(x.url)||name==='hydrochlorothiazide'));
 }
 if(!row)throw Error('No discovered page: '+source+' '+name+' '+strength);
 listings.push({source,page_id:row.id,url:row.url,review:{metadata:{collection_scope:'access_test'}}});
}
await mkdir('data/manifests',{recursive:true});await writeFile('data/manifests/access-test.json',JSON.stringify({purpose:'Initial 10-product access tests; not the acceptance cohort',inventory_audit_passed:false,created_at:new Date().toISOString(),listings},null,2));console.log(JSON.stringify({file:'data/manifests/access-test.json',count:listings.length,by_source:{healthwarehouse:10,costplus:10}},null,2));
}finally{await db.end();}
