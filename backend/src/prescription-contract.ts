import {z} from 'zod';
const field=z.string().trim();
const fields=z.object({medication:field.min(1).max(160),strength:field.max(80),form:field.max(80),directions:field.max(500),quantity:field.max(60),prescriber:field.max(160),pharmacy:field.max(160),refills:field.max(60),warnings:z.array(z.string().max(500)).max(10)}).strict();
const photo=z.object({format:z.enum(['png','jpeg','webp']),data:z.string().max(5_000_000)}).strict().refine(p=>{
 if(!/^[A-Za-z0-9+/]+={0,2}$/.test(p.data)||p.data.length%4!==0)return false;
 const b=Buffer.from(p.data,'base64'); if(b.length>3_750_000)return false;
 return p.format==='png'?b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):p.format==='jpeg'?b[0]===255&&b[1]===216&&b[2]===255:b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
},'Invalid image');
export const prescriptionInput=z.object({action:z.enum(['chat','confirm','prepare','create_member']),request_id:z.string().uuid(),message:z.string().max(4000).default(''),image:photo.optional(),draft_id:z.string().uuid().optional(),member_id:z.string().uuid().optional(),fields:fields.optional(),nickname:field.min(1).max(80).optional()}).strict().refine(value=>value.action!=='create_member'||Boolean(value.nickname),'Member nickname is required');
