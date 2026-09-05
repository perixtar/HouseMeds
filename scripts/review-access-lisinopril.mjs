import {readFile,writeFile,mkdir} from 'node:fs/promises';import {makePool,transaction} from '../src/db.ts';
const reference=JSON.parse(await readFile('.cache/access-probes/lisinopril-rxnorm.json','utf8')).ndcStatus;
if(reference.status!=='ACTIVE'||reference.rxcui!=='314077'||reference.conceptName!=='lisinopril 20 MG Oral Tablet')throw Error('Reference does not support this identity');
const db=makePool();try{await transaction(db,async tx=>{
 const rows=(await tx.query("select l.id,l.source_name,l.source_product_key,s.slug from pricing.listings l join pricing.sources s on s.id=l.source_id where (s.slug='healthwarehouse' and l.source_product_key='*LISINOPRIL20') or (s.slug='costplus' and l.source_product_key='36100030000315-Generic')")).rows;
 if(rows.length!==2)throw Error('Expected two observed listings');
 const med=(await tx.query("insert into pricing.medications(name,strength,form,route,release_type) values('lisinopril','20 mg','tablet','oral','immediate') on conflict(name,strength,form,route,release_type) do update set name=excluded.name returning id")).rows[0].id;
 const proof={scope:'access_test',reviewed_at:new Date().toISOString(),rxcui:'314077',reference_url:'https://rxnav.nlm.nih.gov/REST/ndcstatus.json?ndc=68180098103',reference_concept:reference.conceptName,note:'Cost Plus NDC confirms the human drug identity. HealthWarehouse matched from its exact observed generic product label, form, strength, and loose-tablet packaging; no HealthWarehouse NDC is asserted.'};
 await tx.query("update pricing.listings set medication_id=$1,match_status='verified',metadata=metadata||$2::jsonb where id=any($3::bigint[]) and content_quantity=1 and content_unit='tablet'",[med,JSON.stringify({identity_review:proof}),rows.map(x=>x.id)]);
 await mkdir('data/audits/identity',{recursive:true});await writeFile('data/audits/identity/access-lisinopril.json',JSON.stringify({...proof,listings:rows,medication_id:med},null,2));console.log('One access-test medication identity linked to both sources. This is not the 200-listing acceptance audit.');
});}finally{await db.end();}
