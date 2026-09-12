import {networkFetch} from './network.js';
import {chromium,type Browser,type Page} from 'playwright';
import {createRequire} from 'node:module';
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url:string,text:string)=>{isAllowed:(url:string,agent:string)=>boolean|undefined;getCrawlDelay:(agent:string)=>number|undefined};
import {load} from 'cheerio';
import {setTimeout as delay} from 'node:timers/promises';
import {sources,CP_API,normalizeUrl,flattenJsonLd,isProduct,stock,cents,quantity,hash,type Json,type SourceSlug,type Listing,type Quote,type MedicationIdentityCandidate} from './core.js';
import {normalizeForm} from './normalization.js';
export interface Snapshot {url:string;title:string;h1:string[];links:string[];product:Json|null;panel:string;buttons:{text:string;label:string;pressed:string|null}[];range:string|null;next:boolean;status:number;dom_links?:string[];}
export class SourceAccessError extends Error {constructor(public code:string,public retryAfter:number|null=null){super(code);}}
export class SourceClient {
 private browser?:Browser;private page?:Page;private rules?:ReturnType<typeof robotsParser>;private nextRequest=0;
 constructor(public source:SourceSlug){}
 async pace(){const wait=Math.max(0,this.nextRequest-Date.now());if(wait)await delay(wait);this.nextRequest=Date.now()+Math.max(5000,Number(process.env.CRAWL_DELAY_MS??5000),((this.rules?.getCrawlDelay('HouseMed')??0)*1000));}
 async init(){
  const url=sources[this.source].origin+'/robots.txt';const r=await networkFetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!r.ok)throw new SourceAccessError('ROBOTS_UNAVAILABLE_'+r.status);this.rules=robotsParser(url,await r.text());
 }
 allowed(url:string){return this.rules?.isAllowed(url,'HouseMed')!==false;}
 async json(url:string):Promise<Json>{
  if(!url.startsWith(CP_API)||new URL(url).pathname!==new URL(CP_API).pathname)throw Error('UNAPPROVED_API_URL');
  return JSON.parse(await this.get(url,false)) as Json;
 }
 async get(url:string,checkScope=true,redirects=0):Promise<string>{
  if(redirects>5)throw new SourceAccessError('REDIRECT_LOOP');
  if(checkScope&&(!normalizeUrl(url,url,this.source)||normalizeUrl(url,url,this.source)?.reason||!this.allowed(url)))throw new SourceAccessError('URL_EXCLUDED');
  for(let attempt=0;attempt<3;attempt++){
   await this.pace();let r:Response;
   try{r=await networkFetch(url,{signal:AbortSignal.timeout(30000),redirect:'manual'});}catch(e){if(attempt<2){await delay(1000*2**attempt);continue;}throw new SourceAccessError('FETCH_TIMEOUT');}
   if([301,302,303,307,308].includes(r.status)){const target=new URL(r.headers.get('location')??'',url);if(!checkScope||!normalizeUrl(target.href,url,this.source)||normalizeUrl(target.href,url,this.source)?.reason)throw new SourceAccessError('UNAPPROVED_REDIRECT');return this.get(target.href,checkScope,redirects+1);}
   if(r.status===403)throw new SourceAccessError('SOURCE_BLOCKED');
   if(r.status===429){const h=r.headers.get('retry-after'),seconds=h&&/^\d+$/.test(h)?Number(h):h?Math.max(0,(Date.parse(h)-Date.now())/1000):60;throw new SourceAccessError('SOURCE_RATE_LIMITED',seconds);}
   if(r.status>=500&&attempt<2){await delay(1000*2**attempt);continue;}
   if(!r.ok)throw new SourceAccessError('HTTP_'+r.status);
   return r.text();
  }throw new SourceAccessError('FETCH_FAILED');
 }
 async open(url:string,referrer?:string,depth=0):Promise<Snapshot>{
  const normalized=normalizeUrl(url,url,this.source);if(!normalized||normalized.reason||!this.allowed(normalized.url))throw new SourceAccessError('URL_EXCLUDED');
  if(!this.browser){this.browser=await chromium.launch({channel:'chrome',headless:false});const context=await this.browser.newContext();
   await context.route('**/*',route=>{const u=normalizeUrl(route.request().url(),sources[this.source].origin,this.source);if(u?.reason==='private_or_transactional')return route.abort();return route.continue();});
   this.page=await context.newPage();}
  const target=new URL(normalized.url),relative=target.pathname+target.search;
  const link=this.page!.locator(`a[href=${JSON.stringify(relative)}]:visible, a[href=${JSON.stringify(normalized.url)}]:visible`).first();
  if(this.source==='costplus'&&referrer&&referrer!==normalized.url&&referrer!==this.page!.url()&&depth<3&&!(await link.count()))await this.open(referrer,undefined,depth+1);
  await this.pace();let r:import('playwright').Response|null=null;const current=this.page!.url();
  if(this.source==='costplus'&&current.startsWith(sources[this.source].origin)&&await link.count()){
   const oldPage=await this.page!.evaluate(()=>({title:document.title,text:(document.querySelector('main') as HTMLElement)?.innerText?.slice(0,1500)??''}));await link.click({timeout:10000});
   await this.page!.waitForURL(normalized.url,{timeout:20000});
   if(current!==normalized.url)await this.page!.waitForFunction(old=>document.title!==old.title||((document.querySelector('main') as HTMLElement)?.innerText?.slice(0,1500)??'')!==old.text,oldPage,{timeout:20000});
  }else r=await this.page!.goto(normalized.url,{waitUntil:'domcontentloaded',timeout:45000});
  if(r?.status()===403)throw new SourceAccessError('SOURCE_BLOCKED');if(r?.status()===429)throw new SourceAccessError('SOURCE_RATE_LIMITED',60);if((r?.status()??200)>=400)throw new SourceAccessError('HTTP_'+r?.status());
  const final=normalizeUrl(this.page!.url(),normalized.url,this.source);if(!final||final.reason)throw new SourceAccessError('UNAPPROVED_REDIRECT');
  await this.page!.locator('main').first().waitFor({timeout:20000});
  // Wait for the source's hydrated product/category content, not just its heading.
  await this.page!.waitForFunction(()=>{const m=document.querySelector('main');if(!m)return false;const t=(m as HTMLElement).innerText;const loading=[...m.querySelectorAll('.MuiSkeleton-root,[role="progressbar"]')].some(x=>x.getBoundingClientRect().height>0);const catalog=/View:/.test(t)&&/Products/.test(t);return t.length>80&&!loading&&(!catalog||/\d+\s*[-–]\s*\d+\s+of\s+[\d,]+|no products|no results/i.test(t))&&!/^(?:Loading|Please wait)[.\s]*$/i.test(t.trim());},{},{timeout:20000});
  if(this.source==='costplus'&&target.pathname.startsWith('/medications/categories/'))await this.page!.waitForFunction(()=>[...document.querySelectorAll('main table a[href]')].some(x=>{const p=new URL((x as HTMLAnchorElement).href).pathname;return /^\/medications\/[^/]+\/?$/.test(p)&&!p.includes('/categories/');})||/no medications|no results/i.test((document.querySelector('main table') as HTMLElement)?.innerText??''),{},{timeout:30000});
  await this.page!.waitForTimeout(1500);
  await this.dismissCookies();
  return this.browserSnapshot(r?.status()??200);
 }
 async next(previous:Snapshot):Promise<Snapshot>{
  if(!this.page||!previous.next)throw Error('NO_NEXT_PAGE');
  await this.pace();await this.dismissCookies();const range=previous.range;
  if(this.source==='costplus'){
   await this.page.getByRole('button',{name:'Next page',exact:true}).click();
   await this.page.waitForFunction(old=>{
    const current='page:'+(document.querySelector('main [aria-current="page"]')?.textContent?.trim()??'');
    const links=[...new Set([...document.querySelectorAll('main a[href]')].map(x=>(x as HTMLAnchorElement).href))].sort();
    const products=links.filter(x=>{try{const p=new URL(x).pathname;return /^\/medications\/[^/]+\/?$/.test(p)&&!p.includes('/categories/');}catch{return false;}});
    return current!==old.range&&JSON.stringify(links)!==old.links&&(products.length>0||/no medications|no results/i.test((document.querySelector('main table') as HTMLElement)?.innerText??''));
   },{range,links:JSON.stringify([...(previous.dom_links??[])].sort())},{timeout:30000});
   return this.browserSnapshot(200);
  }
  await this.page.getByRole('button',{name:'Go to next page',exact:true}).first().click();
  await this.page.waitForFunction(old=>{
   const t=document.body.innerText;const match=t.match(/(\d+)\s*[-–]\s*(\d+)\s+of\s+([\d,]+)/);if(!match||match[0]===old.range)return false;
   const links=JSON.stringify([...new Set([...document.querySelectorAll('main a[href]')].map(x=>(x as HTMLAnchorElement).href))].sort());
   const next=[...document.querySelectorAll('button[aria-label="Go to next page"]')].some(x=>!(x as HTMLButtonElement).disabled);
   const last=Number(match[2])>=Number(match[3].replaceAll(',',''));
   const loading=[...document.querySelectorAll('main .MuiSkeleton-root,main [role="progressbar"]')].some(x=>x.getBoundingClientRect().height>0);
   return links!==old.links&&!loading&&(last||next);
  },{range,links:JSON.stringify([...(previous.dom_links??[])].sort())},{timeout:30000});
  return this.browserSnapshot(200);
 }
 private async dismissCookies(){
  if(!this.page)return;
  const button=this.source==='healthwarehouse'?this.page.getByRole('button',{name:'Reject All',exact:true}):this.page.getByRole('button',{name:'Reject Non-Essential Cookies',exact:true});
  if(await button.isVisible())await button.click({timeout:5000});
 }
 private async browserSnapshot(status:number):Promise<Snapshot>{
  const p=this.page!;const d=await p.evaluate(()=>{
   const main=document.querySelector('main') as HTMLElement|null;const text=main?.innerText??'';
   const scripts=[...document.querySelectorAll('script[type="application/ld+json"]')].map(x=>x.textContent??'');
   return {url:location.href,title:document.title,h1:[...document.querySelectorAll('h1')].map(x=>x.textContent??''),links:[...document.querySelectorAll('a[href]')].map(x=>(x as HTMLAnchorElement).href),scripts,
    dom_links:[...new Set([...document.querySelectorAll('main a[href]')].map(x=>(x as HTMLAnchorElement).href))],panel:text.split(/\nABOUT\s|\nPRODUCT INFORMATION|\nProduct Information/)[0].slice(0,12000),buttons:[...document.querySelectorAll('button')].map(x=>({text:x.textContent?.trim()??'',label:x.getAttribute('aria-label')??'',pressed:x.getAttribute('aria-checked')??x.getAttribute('aria-pressed')})),range:text.match(/\d+\s*[-–]\s*\d+\s+of\s+[\d,]+/)?.[0]??(document.querySelector('main [aria-current="page"]')?'page:'+document.querySelector('main [aria-current="page"]')?.textContent?.trim():null),
    next:[...document.querySelectorAll('button[aria-label="Go to next page"],button[aria-label="Next page"],[role="button"][aria-label="Next page"]')].some(x=>!(x as HTMLButtonElement).disabled&&x.getAttribute('aria-disabled')!=='true')};
  });
  if(/just a moment|access denied|verify you are human/i.test(d.title+' '+d.panel.slice(0,300)))throw new SourceAccessError('SOURCE_CHALLENGE');
  const products=d.scripts.flatMap(s=>{try{return flattenJsonLd(JSON.parse(s)).filter(isProduct);}catch{return [];}});
  const product=this.source==='costplus'&&products.length===1?products[0]:products.find(x=>d.h1.some(h=>h.trim().toLowerCase()===String(x.name).trim().toLowerCase()))??null;
  if(products.length&&!product)throw new SourceAccessError('PRODUCT_IDENTITY_CONFLICT');
  // Structured directory links are discovery inputs; source-specific item paths are relative to the root.
  for(const script of d.scripts){try{const walk=(x:unknown)=>{if(Array.isArray(x))x.forEach(walk);else if(x&&typeof x==='object'){for(const [k,v] of Object.entries(x)){if(k==='item'&&typeof v==='string'&&/^(?:https?:|\/?(?:pharmacy|pets|products|diabetic-supplies)\/)/.test(v))d.links.push(new URL(v.startsWith('http')?v:'/'+v.replace(/^\//,''),sources[this.source].origin).href);else walk(v);}}};walk(JSON.parse(script));}catch{}}
  const parts=d.range?.match(/(\d+)\s*[-–]\s*(\d+)\s+of\s+([\d,]+)/);const next=parts?Number(parts[2])<Number(parts[3].replaceAll(',','')):d.next;
  return {url:d.url,title:d.title,h1:d.h1,links:[...new Set(d.links)],product:product?this.trimProduct(product):null,panel:d.panel,buttons:d.buttons,range:d.range,next,status,dom_links:d.dom_links};
 }
 private trimProduct(p:Json):Json{const {name,sku,brand,offers,productID}=p;return {name,sku,brand,offers,productID};}
 fromHtml(html:string,url:string):Snapshot{
  const $=load(html);if(!$('title').text()&&!$('main').text())throw new SourceAccessError('EMPTY_OR_NON_HTML_PAGE');const products=$('script[type="application/ld+json"]').toArray().flatMap(el=>{try{return flattenJsonLd(JSON.parse($(el).text())).filter(isProduct);}catch{return [];}});
  const allH1=$('h1').toArray().map(x=>$(x).text().trim());const product=products.length===1?products[0]:null;
  const buttons=$('button').toArray().map(x=>({text:$(x).text().trim(),label:$(x).attr('aria-label')??'',pressed:$(x).attr('aria-pressed')??null}));
  return {url,title:$('title').text(),h1:allH1,links:[...new Set($('a[href]').toArray().map(x=>{try{return new URL($(x).attr('href')!,url).href;}catch{return '';}}).filter(Boolean))],product:product?this.trimProduct(product):null,panel:$('main').text().replace(/\s+/g,' ').slice(0,12000),buttons,range:null,next:false,status:200};
 }
 async close(){await this.browser?.close();this.browser=undefined;this.page=undefined;}
}
function applyReview(base:Listing,review?:Partial<Listing>):Listing {
 if(!review)return base;
 return {...base,medication:review.medication??base.medication,
  identity_candidate:review.identity_candidate??base.identity_candidate,
  sold_as:review.sold_as??base.sold_as,
  content_quantity:'content_quantity' in review?review.content_quantity!:base.content_quantity,
  content_unit:'content_unit' in review?review.content_unit!:base.content_unit,
  metadata:{...base.metadata,...review.metadata}};
}
function identityFromTitle(title:string,brandName:string|null):MedicationIdentityCandidate|undefined {
 if(/\b\d+(?:\.\d+)?\s*[-–/]\s*\d+(?:\.\d+)?\s*(?:mcg|µg|μg|ug|mg|g|u|units?|iu|meq|%)/i.test(title)||/\b\d+(?:\.\d+)?\s*(?:mcg|µg|μg|ug|mg|g|u|units?|iu|meq|%)\s*\/\s*\d+(?:\.\d+)?\s*(?:mcg|µg|μg|ug|mg|u|units?|iu|meq|%)/i.test(title))return undefined;
 const strength=title.match(/\b\d+(?:\.\d+)?\s*(?:mcg|µg|μg|ug|mg|g|u|units?|iu|meq|%)(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:ml|l|g|tablet|capsule|dose))?/i)?.[0];
 const form=normalizeForm(title);if(!strength||!form)return undefined;
 const offset=title.toLowerCase().indexOf(strength.toLowerCase());
 const name=title.slice(0,offset).replace(/\([^)]*\)/g,' ').replace(/\b(?:extended release|delayed release|immediate release|ER|XR|XL|SR|DR|EC)\b/ig,' ').replace(/\s+/g,' ').trim();if(!name)return undefined;
 const route=title.match(/\b(oral|topical|ophthalmic|otic|nasal|inhalation|rectal|vaginal|subcutaneous|intramuscular|intravenous|transdermal)\b/i)?.[1]??null;
 const release=title.match(/\b(extended release|delayed release|immediate release|ER|XR|XL|SR|DR|EC)\b/i)?.[1]??null;
 const species=/\b(?:dogs?|canine)\b/i.test(title)?['dog']:/\b(?:cats?|feline)\b/i.test(title)?['cat']:[];
 return {name,strength,form,route,release_type:release,brand_name:brandName,species};
}
export function healthwarehouse(snapshot:Snapshot,review?:Partial<Listing>):{listing:Listing;offers:Quote[]}{
 const p=snapshot.product;if(!p||!p.sku||!p.name)throw Error('NO_PRODUCT');
 const sku=snapshot.panel.match(/SKU:\s*([^\n]+)/)?.[1]?.trim();if(!sku||sku!==p.sku)throw Error('SKU_MISMATCH');
 const radioQuantities=snapshot.buttons.map(x=>x.label.match(/^Select quantity ([\d.]+)/)?.[1]).filter((x):x is string=>Boolean(x));
 const selected=snapshot.panel.match(/Selected quantity:\s*(\d+(?:\.\d+)?)/)?.[1];const total=snapshot.panel.match(/Total price updated to \$([\d,.]+)/)?.[1];
 const unit=snapshot.panel.match(/Count\s*•\s*([^\n/$]+)\s*\//)?.[1]?.trim().toLowerCase()??'unknown';
 const title=String(p.name);const packed=title.match(/(?:\b|,\s*)(\d+)\s*(?:Count|ct)\b/i);
 let sold_as=unit,content_quantity:string|null=null,content_unit:string|null=null;
 if(['tablet','capsule'].includes(unit)&&!packed){content_quantity='1';content_unit=unit;}
 if(packed&&/tablets?|capsules?/i.test(title)){content_quantity=quantity(packed[1]);content_unit=/capsules?/i.test(title)?'capsule':'tablet';sold_as='pack';}
 const volume=title.match(/(?:^|[\s-])(\d+(?:\.\d+)?)\s*(ml|g)\s*(?:bottle|vial|tube|$)/i);if(volume){content_quantity=quantity(volume[1]);content_unit=volume[2].toLowerCase()==='g'?'g':'ml';sold_as=/vial/i.test(title)?'vial':/tube/i.test(title)?'tube':'bottle';}
 const brandName=(p.brand as Json)?.name==='Generic'?null:String((p.brand as Json)?.name??'')||null;
 const listing:Listing=applyReview({source_product_key:String(p.sku),source_name:title,url:snapshot.url,brand_name:brandName,sold_as,content_quantity,content_unit,identity_candidate:identityFromTitle(title,brandName),metadata:{source_unit_label:unit,source_product_name:title,...(/for dogs?/i.test(title)?{species_labels:['dog']}:/for cats?/i.test(title)?{species_labels:['cat']}:{}),...(title.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*lbs?/i)?{source_weight_label:title.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*lbs?/i)![0]}:{})}},review);
 const raw=Array.isArray(p.offers)?p.offers:[p.offers];
 const offers=raw.map(v=>v as Json).filter(o=>radioQuantities.includes(String((o.eligibleQuantity as Json)?.value))).map(o=>({quantity:quantity((o.eligibleQuantity as Json).value),price_cents:cents(o.price),currency:'USD' as const,availability:stock(o.availability),seller_key:'healthwarehouse',location_key:'online-us',program_key:'cash',terms:{quote_kind:'source_product_total',shipping:null,source_currency:o.priceCurrency},active:true,valid_until:null}));
 if(!offers.length)throw Error('NO_VALIDATED_ORDERING_QUANTITIES');if(offers.some(x=>x.terms.source_currency!=='USD'))throw Error('CURRENCY_MISMATCH');
 if(!selected||!total||!offers.some(o=>o.quantity===quantity(selected)&&o.price_cents===cents(total)))throw Error('DEFAULT_PRICE_MISMATCH');
 return {listing,offers};
}
function normalizeCostcoForm(value:string):string {
 const v=value.trim().toLowerCase();
 if(['tab','tabs','tablet','tablets'].includes(v))return 'tablet';
 if(['cap','caps','capsule','capsules'].includes(v))return 'capsule';
 if(['sol','soln','solution'].includes(v))return 'solution';
 if(['susp','suspension'].includes(v))return 'suspension';
 if(['cream','crm'].includes(v))return 'cream';
 if(['ointment','oint'].includes(v))return 'ointment';
 if(['gel'].includes(v))return 'gel';
 return v.replace(/s$/,'');
}
function parseCostcoName(value:string){
 const compact=value.replace(/\s+/g,' ').trim();
 const match=compact.match(/^(.+?)\s+(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?\s*(?:mg|mcg|g|gm|ml|%)(?:\/\d+(?:\.\d+)?\s*(?:mg|mcg|g|gm|ml))?)\s+([A-Za-z]+)(?:\s+(.+))?$/i);
 if(!match)return null;
 return {name:match[1].trim(),strength:match[2].replace(/\bgm\b/i,'g').replace(/\s+/g,' ').trim(),form:normalizeCostcoForm(match[3]),suffix:match[4]?.trim()??null};
}
function sameMedication(a:{name:string;strength:string;form:string},b:{name:string;strength:string;form:string}){
 const clean=(x:string)=>x.toLowerCase().replace(/\s+/g,' ').trim();
 return clean(a.name)===clean(b.name)&&clean(a.strength).replace(/\s/g,'')===clean(b.strength).replace(/\s/g,'')&&clean(a.form)===clean(b.form);
}
export function costco(snapshot:Snapshot,review?:Partial<Listing>):{listing:Listing;offers:Quote[]}{
 const url=new URL(snapshot.url);
 if(!['/drug-results-details-price','/cmpps'].includes(url.pathname))throw Error('COSTCO_UNSUPPORTED_PAGE');
 const lines=snapshot.panel.replace(/\u00a0/g,' ').split(/\n+/).map(x=>x.trim()).filter(Boolean);
 const rows:{label:'Generic Alternative'|'Brand Name';sourceName:string;manufacturer:string|null;parsed:ReturnType<typeof parseCostcoName>;offers:Quote[]}[]=[];
 for(let i=0;i<lines.length;i++){
  const labelMatch=lines[i].match(/^(Generic Alternative|Brand Name):$/i);
  if(!labelMatch)continue;
  const sourceName=lines[++i];if(!sourceName)throw Error('COSTCO_MISSING_PRODUCT_NAME');
  const parsed=parseCostcoName(sourceName);
  let manufacturer:string|null=null;const offers:Quote[]=[];
  for(;i<lines.length;i++){
   if(/^Mfr\.$/i.test(lines[i])){manufacturer=lines[i+1]??null;i++;continue;}
   if(/^(Generic Alternative|Brand Name):$/i.test(lines[i])){i--;break;}
   const quantityMatch=lines[i].match(/^(\d+(?:\.\d+)?)\s+([A-Za-z]+)$/);
   if(quantityMatch&&/^\$?[\d,]+(?:\.\d{2})?$/.test(lines[i+1]??'')){
    offers.push({quantity:quantity(quantityMatch[1]),price_cents:cents(lines[++i]),currency:'USD',availability:'unknown',
     seller_key:'costco',location_key:'mail-order-us',program_key:'cash',
     terms:{quote_kind:'source_product_total',shipping:null,taxes:null,availability_basis:'not_provided_by_source',source_quantity_unit:normalizeCostcoForm(quantityMatch[2]),manufacturer},
     valid_until:null,active:true});
   }
  }
  rows.push({label:labelMatch[1].toLowerCase().startsWith('brand')?'Brand Name':'Generic Alternative',sourceName,manufacturer,parsed,offers});
 }
 if(!rows.length)throw Error('COSTCO_NO_PRICE_ROWS');
 const reviewMed=review?.medication;
 const candidates=reviewMed?rows.filter(x=>x.parsed&&sameMedication(x.parsed,reviewMed)):rows;
 if(candidates.length!==1)throw Error(reviewMed?'COSTCO_AMBIGUOUS_REVIEW_MATCH':'COSTCO_REVIEW_REQUIRED');
 const row=candidates[0];if(!row.parsed)throw Error('COSTCO_UNPARSED_PRODUCT_NAME');if(!row.offers.length)throw Error('COSTCO_NO_OFFERS');
 const contentUnit=row.offers[0].terms.source_quantity_unit;
 if(typeof contentUnit!=='string'||row.offers.some(x=>x.terms.source_quantity_unit!==contentUnit))throw Error('COSTCO_MIXED_QUANTITY_UNITS');
 const key=[url.pathname,url.searchParams.get('drugId')??url.searchParams.get('drugIdentifierParam')??url.searchParams.get('drugName')??url.searchParams.get('drugNameParam')??row.sourceName,row.sourceName].join(':');
 const listing=applyReview({source_product_key:key,source_name:row.sourceName,url:snapshot.url,
  brand_name:row.label==='Brand Name'?row.parsed.name:null,sold_as:contentUnit,content_quantity:'1',content_unit:contentUnit,
  medication:{name:row.parsed.name.toLowerCase(),strength:row.parsed.strength.replace(/([0-9])([a-z%])/ig,'$1 $2').toLowerCase(),form:row.parsed.form,route:'oral',release_type:'immediate'},
  metadata:{collection_method:'costco_public_price_page',manufacturer:row.manufacturer,source_label:row.label,source_suffix:row.parsed.suffix}},review);
 return {listing,offers:row.offers};
}
export async function costplus(client:SourceClient,row:Json,url:string,quantities:string[],review?:Partial<Listing>,sourceProductKey?:string,onResponse?:(record:Json)=>void):Promise<{listing:Listing;offers:Quote[]}>{
 const normalized=normalizeUrl(String(row.url),sources.costplus.origin,'costplus');
 if(!normalized||normalized.reason||normalized.url!==url)throw Error('CATALOG_URL_MISMATCH');
 if(!/^[0-9]{10,11}$/.test(String(row.ndc))||!row.medication_name||!row.strength||!row.form||!['Generic','Brand'].includes(String(row.brand_generic)))throw Error('INVALID_CATALOG_IDENTITY');
 const qs=quantities.map(quantity);if(!qs.length||new Set(qs).size!==qs.length)throw Error('EXPLICIT_UNIQUE_QUANTITIES_REQUIRED');
 const isLoose=row.pill_nonpill==='Pill'&&['Tablet','Capsule'].includes(String(row.form));
 const title=[row.medication_name,row.strength,row.form].join(' ');
 const listing:Listing=applyReview({source_product_key:sourceProductKey??'url:'+new URL(url).pathname,source_name:title,url,
  brand_name:row.brand_generic==='Brand'?String(row.brand_name):null,sold_as:isLoose?String(row.form).toLowerCase():'unresolved_api_unit',
  content_quantity:isLoose?'1':null,content_unit:isLoose?String(row.form).toLowerCase():null,
  identity_candidate:{name:String(row.medication_name),strength:String(row.strength),form:String(row.form),route:null,release_type:null,brand_name:row.brand_generic==='Brand'?String(row.brand_name):null,ndc:String(row.ndc),species:[]},
  metadata:{ndc:String(row.ndc),catalog_name:row.medication_name,catalog_strength:row.strength,catalog_form:row.form,brand_generic:row.brand_generic,
   medispan_pack_size:row.medispan_pack_size,medispan_pack_size_units:row.medispan_pack_size_units,medispan_quantity:row.medispan_quantity,
   collection_method:'documented_public_api',catalog_listed:true}},review);
 const offers:Quote[]=[];
 const identityFields=['medication_name','strength','form','brand_generic','brand_name','pill_nonpill','medispan_pack_size','medispan_pack_size_units','medispan_quantity'];
 for(const q of qs){
  const request=new URL(CP_API);request.searchParams.set('ndc',String(row.ndc));request.searchParams.set('quantity_units',q);
  const result=await client.json(request.href);
  onResponse?.({request_url:request.href,received_at:new Date().toISOString(),response:result});
  if(!Array.isArray(result.results))throw Error('INVALID_QUOTE_RESPONSE');
  const candidates=(result.results as Json[]).filter(x=>String(x.ndc)===String(row.ndc)&&String(x.requested_quote_units)===q);
  if(candidates.length!==1||candidates[0].error_message||candidates[0].requested_quote===undefined)throw Error('AMBIGUOUS_OR_MISSING_QUOTE');
  const returned=candidates[0];
  if(normalizeUrl(String(returned.url),sources.costplus.origin,'costplus')?.url!==url||identityFields.some(field=>String(row[field]??'')!==String(returned[field]??'')))throw Error('QUOTE_IDENTITY_MISMATCH');
  offers.push({quantity:q,price_cents:cents(returned.requested_quote),currency:'USD',availability:'unknown',seller_key:'costplus',location_key:'online-us',program_key:'cash',
   terms:{quote_kind:'estimate',shipping:null,taxes:null,source_ndc:String(row.ndc),availability_basis:'not_provided_by_api',catalog_listed:true},valid_until:null,active:true});
 }
 return {listing,offers};
}
