import {SourceClient} from '../src/sources.ts';
const client=new SourceClient('costplus');try{await client.init();const s=await client.open('https://www.costplusdrugs.com/medications/categories/acid-reflux/','https://www.costplusdrugs.com/medications/');console.log(JSON.stringify({range:s.range,next:s.next,links:s.links.filter(x=>/\/medications\//.test(x))}));}finally{await client.close();}
