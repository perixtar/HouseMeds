import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {healthwarehouse,costco,SourceClient,type Snapshot} from '../src/sources.js';
const fixture=JSON.parse(await readFile(new URL('./fixtures/healthwarehouse-lisinopril.json',import.meta.url),'utf8'));
test('captured HealthWarehouse purchase data yields exact independent expected offers',()=>{const result=healthwarehouse(fixture.snapshot);assert.equal(result.listing.source_product_key,fixture.expected.sku);assert.equal(result.listing.sold_as,fixture.expected.sold_as);assert.deepEqual(result.listing.identity_candidate,{name:'Lisinopril',strength:'20mg',form:'tablet',route:null,release_type:null,brand_name:null,species:[]});assert.deepEqual(result.offers.map(x=>x.quantity),fixture.expected.quantities);assert.deepEqual(result.offers.map(x=>x.price_cents),fixture.expected.prices);assert.ok(!result.offers.some(x=>x.quantity==='1'),'unit-price representation is not an accepted fill');});
test('a displayed default price conflict never publishes',()=>{const s=structuredClone(fixture.snapshot) as Snapshot;s.panel=s.panel.replaceAll('$8.96','$8.95');assert.throws(()=>healthwarehouse(s),/DEFAULT_PRICE_MISMATCH/);});
test('a combination strength is retained as source evidence but is not parsed as one medication component',()=>{const s=structuredClone(fixture.snapshot) as Snapshot,title='Metoprolol-HCTZ 100-25 mg Tablets';s.product!.name=title;const result=healthwarehouse(s);assert.equal(result.listing.source_name,title);assert.equal(result.listing.identity_candidate,undefined);});
test('wrong SKU and non-USD source quotes are rejected',()=>{const s=structuredClone(fixture.snapshot) as Snapshot;s.panel=s.panel.replace('*LISINOPRIL20','OTHER');assert.throws(()=>healthwarehouse(s),/SKU_MISMATCH/);const q=structuredClone(fixture.snapshot);q.product.offers[1].priceCurrency='EUR';assert.throws(()=>healthwarehouse(q),/CURRENCY_MISMATCH/);});
test('loading and non-HTML responses are not successful discovery',()=>{const c=new SourceClient('costplus');assert.throws(()=>c.fromHtml('','https://www.costplusdrugs.com/'),/EMPTY_OR_NON_HTML/);});
test('Costco public cash price rows parse into source observations',()=>{
 const snapshot:Snapshot={url:'https://www.costco.com/drug-results-details-price?drugId=350&drugName=Lisinopril&encodedDrugName=Lisinopril',title:'Search for a Drug | Costco',h1:['Lisinopril'],links:[],product:null,buttons:[],range:null,next:false,status:200,
  panel:`Lisinopril
The prices listed are the most recent cash prices.
Name
Mfr.
30 Tablets
50 Tablets
100 Tablets
Name
Generic Alternative:
Lisinopril 10 Mg Tab Solc
Mfr.
SOLCO HEAL
30 Tablets
$33.35
50 Tablets
$33.91
100 Tablets
$35.28
Name
Generic Alternative:
Lisinopril 20 Mg Tab Solc
Mfr.
SOLCO HEAL
30 Tablets
$41.10
50 Tablets
$42.07
100 Tablets
$46.25`};
 const result=costco(snapshot,{medication:{name:'lisinopril',strength:'20 mg',form:'tablet',route:'oral',release_type:'immediate'}});
 assert.equal(result.listing.source_product_key,'/drug-results-details-price:350:Lisinopril 20 Mg Tab Solc');
 assert.equal(result.listing.content_unit,'tablet');
 assert.equal(result.listing.metadata.manufacturer,'SOLCO HEAL');
 assert.deepEqual(result.offers.map(x=>[x.quantity,x.price_cents,x.seller_key,x.location_key,x.availability]),[
  ['30','4110','costco','mail-order-us','unknown'],
  ['50','4207','costco','mail-order-us','unknown'],
  ['100','4625','costco','mail-order-us','unknown'],
 ]);
});
test('Costco multi-strength pages require a matching review identity',()=>{
 const snapshot:Snapshot={url:'https://www.costco.com/drug-results-details-price?drugId=350&drugName=Lisinopril',title:'Search for a Drug | Costco',h1:['Lisinopril'],links:[],product:null,buttons:[],range:null,next:false,status:200,panel:`Generic Alternative:
Lisinopril 10 Mg Tab Solc
Mfr.
SOLCO HEAL
30 Tablets
$33.35
Generic Alternative:
Lisinopril 20 Mg Tab Solc
Mfr.
SOLCO HEAL
30 Tablets
$41.10`};
 assert.throws(()=>costco(snapshot),/COSTCO_REVIEW_REQUIRED/);
 assert.throws(()=>costco(snapshot,{medication:{name:'lisinopril',strength:'40 mg',form:'tablet',route:'oral',release_type:'immediate'}}),/COSTCO_AMBIGUOUS_REVIEW_MATCH/);
});
test('pagination waits for new product links after the range changes',async()=>{
 const {chromium}=await import('playwright');const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
 try{await page.setContent(`<title>Local pagination fixture</title><main><p id="range">1-24 of 48</p><a id="product" href="https://www.healthwarehouse.com/old-product">Old product</a><button aria-label="Go to next page" onclick="this.disabled=true;document.querySelector('#range').textContent='25-48 of 48';setTimeout(()=>{document.querySelector('#product').href='https://www.healthwarehouse.com/new-product';document.querySelector('#product').textContent='New product'},150)">Next</button></main>`);
 const client=new SourceClient('healthwarehouse');Object.assign(client,{page});
 const previous={url:'https://www.healthwarehouse.com/category',title:'Local pagination fixture',h1:[],links:[],dom_links:['https://www.healthwarehouse.com/old-product'],product:null,panel:'',buttons:[],range:'1-24 of 48',next:true,status:200};
 const result=await client.next(previous);assert.ok(result.links.includes('https://www.healthwarehouse.com/new-product'));assert.ok(!result.links.includes('https://www.healthwarehouse.com/old-product'));assert.equal(result.next,false);assert.equal(result.range,'25-48 of 48');
 }finally{await browser.close();}
});

test('Cost Plus API parses exact quoted totals and keeps live stock unknown',async()=>{
 const {costplus}=await import('../src/sources.js');const f=JSON.parse(await readFile(new URL('./fixtures/costplus-lisinopril-api.json',import.meta.url),'utf8'));
 const client=new SourceClient('costplus');client.json=async url=>structuredClone(f.responses.find((x:any)=>x.request_url===url).response);
 const captured:unknown[]=[];const r=await costplus(client,f.responses[0].response.results[0],f.url,['30','90'],undefined,undefined,x=>captured.push(x));
 assert.deepEqual(r.offers.map(x=>x.price_cents),['555','666']);assert.ok(r.offers.every(x=>x.availability==='unknown'&&x.terms.quote_kind==='estimate'));
 assert.equal(r.listing.content_quantity,'1');assert.equal(r.listing.content_unit,'tablet');assert.equal(r.listing.brand_name,null);assert.equal(captured.length,2);
 assert.deepEqual(r.listing.identity_candidate,{name:'Lisinopril',strength:'20mg',form:'Tablet',route:null,release_type:null,brand_name:null,ndc:'68180098103',species:[]});
});
test('Cost Plus rejects substituted identities, missing quantities, and API errors',async()=>{
 const {costplus}=await import('../src/sources.js');const f=JSON.parse(await readFile(new URL('./fixtures/costplus-lisinopril-api.json',import.meta.url),'utf8'));
 for(const kind of ['strength','brand','quantity','ndc','error','duplicate']){
  const client=new SourceClient('costplus');const data=structuredClone(f.responses[0].response);const row=data.results[0];
  if(kind==='strength')row.strength='10mg';if(kind==='brand')row.brand_name='Different reference product';if(kind==='quantity')row.requested_quote_units='60';if(kind==='ndc')row.ndc='00000000000';if(kind==='error')row.error_message='Estimate unavailable';if(kind==='duplicate')data.results.push(structuredClone(row));
  client.json=async()=>data;await assert.rejects(costplus(client,f.responses[0].response.results[0],f.url,['30']),/QUOTE_IDENTITY_MISMATCH|AMBIGUOUS_OR_MISSING_QUOTE/,kind);
 }
});
test('Cost Plus role-button links expose every directory page and wait for its new products',async()=>{
 const {chromium}=await import('playwright');const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
 const url='https://www.costplusdrugs.com/medications/categories/diabetes/';
 try{
  // Pagination element types and ARIA state were observed through independent browser control.
  await page.route('https://www.costplusdrugs.com/**',route=>route.fulfill({contentType:'text/html',body:`<title>Local Cost Plus pagination fixture</title><main><h1>Medications</h1><h2>All Medications Under Diabetes</h2><p>Fixture directory content for the rendered pagination regression test.</p><table><tr><td><a id="product" href="https://www.costplusdrugs.com/medications/old-product/">Old product</a></td></tr></table><a id="current" role="button" aria-label="Page 1 is your current page" aria-current="page">1</a><a role="button" aria-label="Next page" aria-disabled="false" onclick="this.setAttribute('aria-disabled','true');document.querySelector('#current').textContent='2';setTimeout(()=>{document.querySelector('#product').href='https://www.costplusdrugs.com/medications/new-product/';document.querySelector('#product').textContent='New product'},150)">Next</a></main>`}));
  const client=new SourceClient('costplus');Object.assign(client,{browser,page});client.pace=async()=>{};
  const first=await client.open(url);assert.equal(first.range,'page:1');assert.equal(first.next,true);
  const last=await client.next(first);assert.equal(last.range,'page:2');assert.equal(last.next,false);assert.ok(last.links.includes('https://www.costplusdrugs.com/medications/new-product/'));assert.ok(!last.links.includes('https://www.costplusdrugs.com/medications/old-product/'));
 }finally{await browser.close();}
});
