import {readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {runMedicationResearch} from './agent-research.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),json=args.includes('--json');
function option(name:string){const index=args.indexOf(name);return index>=0?args[index+1]:undefined;}
const optionValues=new Set(['--medicine','--pharmacy','--location','--quantities']);
const consumed=new Set<number>();for(let i=0;i<args.length;i++)if(optionValues.has(args[i]!)){consumed.add(i);consumed.add(i+1);}
const positional=args.filter((value,index)=>!consumed.has(index)&&value!=='--json'&&!value.startsWith('--'));
const medicine=(option('--medicine')??positional.join(' ')).trim();
const pharmacy=(option('--pharmacy')??'Amazon Pharmacy').trim();
const location=(option('--location')??'no location/public national price').trim();
const targetQuantities=(option('--quantities')??'every quantity explicitly offered').split(',').map(x=>x.trim()).filter(Boolean);

try{
 if(!medicine)throw Error('Usage: npm run research:medicine -- --medicine "Atorvastatin" [--pharmacy "Amazon Pharmacy"] [--location "ZIP or public"] [--quantities "30,90"] [--json]');
 const env=parseEnv(await readFile(join(root,'.env.agent'),'utf8'));
 const result=await runMedicationResearch({medicine,targetPharmacies:[pharmacy],location,targetQuantities,apiKey:env.OPENAI_API_KEY??'',exaApiKey:env.EXA_API_KEY??'',model:env.HOUSEMED_AGENT_MODEL});
 console.log(json?JSON.stringify(result,null,2):result.status==='completed'?result.text+'\nFull result: '+join(result.run_directory,'result.json'):'HouseMed Exa research failed: '+result.error+'\nDiagnostics: '+join(result.run_directory,'diagnostics.log'));
 if(result.status==='failed')process.exitCode=1;
}catch(error){
 console.error((error as NodeJS.ErrnoException).code==='ENOENT'?'Configure OPENAI_API_KEY and EXA_API_KEY in .env.agent before running medication research.':error instanceof Error?error.message:'Research setup failed');
 process.exitCode=1;
}
