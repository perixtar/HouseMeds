import test from 'node:test';import assert from 'node:assert/strict';
import {buildWeb} from '../src/web.js';
import {lookupComparison,searchMedications,catalog,SUPPLIERS,DAYS_SUPPLY} from '../src/pricing-catalog.js';

test('every catalogued strength quotes all four suppliers at all three day supplies',()=>{
 for(const medication of catalog().medications)for(const strength of medication.strengths){
  const result=lookupComparison({medication:medication.name,strength:strength.strength});
  assert.ok(result,`${medication.name} ${strength.strength} has no comparison`);
  assert.deepEqual(result.suppliers.map(s=>s.source),[...SUPPLIERS]);
  for(const supplier of result.suppliers){
   assert.deepEqual(supplier.quotes.map(q=>q.days_supply),[...DAYS_SUPPLY]);
   for(const quote of supplier.quotes){
    assert.ok(Number.isInteger(quote.price_cents)&&quote.price_cents>0,'price is a positive whole number of cents');
    assert.equal(quote.quantity,medication.doses_per_day*quote.days_supply);
    assert.match(quote.purchase_url,/^https:\/\//);
   }
   // A larger day supply must never cost less per day than a smaller one.
   const perDay=supplier.quotes.map(q=>q.price_per_day_cents);
   assert.ok(perDay[0]>=perDay[1]&&perDay[1]>=perDay[2],`${supplier.source} per-day price should not rise with a longer supply`);
  }
 }
});

test('each supplier links to the destination verified against its live site',()=>{
 const result=lookupComparison({medication:'Carvedilol',strength:'12.5mg'})!;
 const by=(slug:string)=>result.suppliers.find(s=>s.source===slug)!;
 // Cost Plus publishes a product page per strength; Costco names the drug on its Member Prescription
 // Program page and Amazon takes it in a pharmacy search. Walmart publishes no per-drug cash price
 // page, so a program drug links to the $4/$10 program page that documents the quoted price.
 assert.equal(by('costplus').product_url,'https://www.costplusdrugs.com/medications/carvedilol-12_5mg-tablet/');
 assert.equal(by('costco').product_url,'https://www.costco.com/cmpps?drugNameParam=Carvedilol');
 assert.equal(by('amazon').product_url,'https://pharmacy.amazon.com/s?k=carvedilol');
 assert.equal(by('walmart').product_url,'https://www.walmart.com/cp/4-prescriptions/1078664');
 assert.equal(by('walmart').link_target,'Walmart $4/$10 program page');
 // Every quote carries a link, and it is the supplier's own destination.
 for(const supplier of result.suppliers)for(const quote of supplier.quotes)assert.equal(quote.purchase_url,supplier.product_url);
 // A drug that is not on Walmart's list goes to the pharmacy page instead.
 const offList=lookupComparison({medication:'Rosuvastatin',strength:'10mg'})!.suppliers.find(s=>s.source==='walmart')!;
 assert.equal(offList.product_url,'https://www.walmart.com/cp/pharmacy/5431');
});

test('best_by_days_supply and best_value name the actual cheapest quotes',()=>{
 const result=lookupComparison({medication:'Levothyroxine',strength:'100mcg'})!;
 for(const days of DAYS_SUPPLY){
  const quotes=result.suppliers.map(s=>({source:s.source,quote:s.quotes.find(q=>q.days_supply===days)!}));
  const cheapest=Math.min(...quotes.map(x=>x.quote.price_cents));
  const winner=result.best_by_days_supply[String(days)];
  assert.equal(winner.price_cents,cheapest);
  assert.equal(quotes.find(x=>x.source===winner.source)!.quote.price_cents,cheapest);
 }
 const everyPerDay=result.suppliers.flatMap(s=>s.quotes.map(q=>q.price_per_day_cents));
 assert.equal(result.best_value!.price_per_day_cents,Math.min(...everyPerDay));
});

test('the Walmart generic program is only applied when it beats the modelled cash price',()=>{
 // Carvedilol is on the $4/$10 list; levothyroxine is not.
 const onList=lookupComparison({medication:'Carvedilol',strength:'12.5mg'})!.suppliers.find(s=>s.source==='walmart')!;
 assert.deepEqual(onList.quotes.map(q=>q.price_cents),[400,1000,4000]);
 const offList=lookupComparison({medication:'Levothyroxine',strength:'100mcg'})!.suppliers.find(s=>s.source==='walmart')!;
 assert.ok(offList.quotes.every(q=>![400,1000,4000].includes(q.price_cents)),'off-list drugs keep the modelled cash price');
});

test('search matches on generic and brand name and tolerates spacing and case',()=>{
 assert.equal(searchMedications('carvedilol')[0]?.name,'Carvedilol');
 assert.equal(searchMedications('  CARV ')[0]?.name,'Carvedilol');
 assert.equal(searchMedications('coreg')[0]?.name,'Carvedilol');
 assert.equal(searchMedications('metoprolol tartrate')[0]?.name,'Metoprolol Tartrate');
 assert.deepEqual(searchMedications('nothing-here-at-all'),[]);
});

test('the API answers the comparison, suggestion and asset routes',async()=>{
 const app=buildWeb();
 try{
  const comparison=await app.inject({method:'GET',url:'/v1/price-comparison?medication=Carvedilol&strength=12.5mg'});
  assert.equal(comparison.statusCode,200);
  const body=comparison.json();
  assert.equal(body.data_source,'mock');
  assert.equal(body.medication.strength,'12.5mg');
  assert.deepEqual(body.days_supply_options,[30,90,365]);
  assert.equal(body.suppliers.length,4);

  const missing=await app.inject({method:'GET',url:'/v1/price-comparison?medication=notadrug'});
  assert.equal(missing.statusCode,404);
  assert.equal(missing.json().error,'medication_not_found');

  const invalid=await app.inject({method:'GET',url:'/v1/price-comparison'});
  assert.equal(invalid.statusCode,400);

  const suggestions=await app.inject({method:'GET',url:'/v1/medications?q=carv'});
  assert.equal(suggestions.statusCode,200);
  assert.equal(suggestions.json().items[0].name,'Carvedilol');

  const page=await app.inject({method:'GET',url:'/'});
  assert.equal(page.statusCode,200);
  assert.match(page.headers['content-type'] as string,/text\/html/);
  assert.match(page.body,/HouseMeds/);
  for(const asset of ['/styles.css','/app.js'])assert.equal((await app.inject({method:'GET',url:asset})).statusCode,200);
 }finally{await app.close();}
});
