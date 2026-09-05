import {chromium} from 'playwright';import {writeFile} from 'node:fs/promises';
const b=await chromium.launch({channel:'chrome',headless:false});const network=[];
try{const p=await b.newPage();p.on('response',r=>{if(['fetch','xhr'].includes(r.request().resourceType()))network.push({url:r.url().split('?')[0],status:r.status(),type:r.headers()['content-type']});});p.on('pageerror',e=>console.log('pageerror',e.message));
await p.goto('https://www.costplusdrugs.com/medications/lisinopril-20mg-tablet/',{waitUntil:'domcontentloaded'});
try{await p.getByRole('heading',{level:3,name:/^\$[0-9,.]+$/}).first().waitFor({timeout:60000});console.log('Price panel loaded before cookie interaction:',await p.getByRole('heading',{level:3,name:/^\$[0-9,.]+$/}).first().innerText());}catch{console.log('Price panel remained incomplete before any cookie interaction.');}
await writeFile('data/evidence/access/costplus/readiness-network.json',JSON.stringify(network,null,2));console.log(JSON.stringify(network.slice(-30),null,2));
}finally{await b.close();}
