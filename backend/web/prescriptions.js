const $=id=>document.getElementById(id);
const fieldNames=['medication','strength','form','directions','quantity','prescriber','pharmacy','refills'];
let photo,preview,draft,drafts=[],busy=false,lastRequest;
const notice=message=>$('notice').textContent=message;
function setBusy(value){busy=value;for(const id of ['send','save','refresh','photo','remove-photo','draft-choice'])$(id).disabled=value;}
function bubble(text,role){const p=document.createElement('p');p.className=`bubble ${role}`;p.textContent=text;$('conversation').append(p);p.scrollIntoView({block:'nearest'});}
function members(items,selected=''){$('member').replaceChildren(new Option('Choose a household member',''));for(const m of items)$('member').add(new Option(m.nickname,m.id));$('member').value=selected;}
function showDraft(value){draft=value;$('review-empty').hidden=true;$('review-form').hidden=false;for(const key of fieldNames)$(key).value=value.fields[key]??'';
 const n=value.normalization;$('normalization').textContent=n.status==='verified'?`RxNorm identity: ${n.name}`:'Medication identity has not been verified. The original label text is preserved.';
 $('warnings').replaceChildren();for(const warning of value.fields.warnings??[]){const li=document.createElement('li');li.textContent=warning;$('warnings').append(li);}
 sessionStorage.setItem('housemed_draft_id',value.id);
 $('medicine-choice').hidden=drafts.length<2;$('draft-choice').replaceChildren();for(const d of drafts)$('draft-choice').add(new Option(`${d.fields.medication} ${d.fields.strength}`,d.id));$('draft-choice').value=value.id;
}
function prescriptions(items){$('prescriptions').replaceChildren();if(!items.length){const p=document.createElement('p');p.className='empty';p.textContent='No saved prescriptions yet.';$('prescriptions').append(p);return;}
 for(const p of items){const row=document.createElement('article');row.className='prescription';row.dataset.prescriptionId=p.id;
  const owner=document.createElement('strong');owner.textContent=p.nickname;const detail=document.createElement('div');const title=document.createElement('strong');title.textContent=`${p.fields.medication} ${p.fields.strength}`;detail.append(title);
  for(const text of [p.normalization.status==='verified'?p.normalization.name:'',p.fields.directions,p.fields.quantity?`Quantity: ${p.fields.quantity}`:''])if(text){const line=document.createElement('p');line.textContent=text;detail.append(line);}
  const tag=document.createElement('span');tag.className='saved-tag';tag.textContent='Saved';row.append(owner,detail,tag);$('prescriptions').append(row);
 }
}
async function request(body){const response=await fetch('/v1/prescription-chat'+(body?'':'/state'),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok||result.status==='error')throw Error(result.message??'The prescription service could not respond.');return result;}
function apply(result){if(result.members)members(result.members,result.selected_member_id??(result.status==='needs_member'?'':$('member').value));if(result.drafts)drafts=result.drafts;if(result.draft)showDraft(result.draft);if(result.prescriptions)prescriptions(result.prescriptions);if(result.message)bubble(result.message,'assistant');
 if(result.household_name)$('household-name').textContent=result.household_name;
 // Minimal diagnostics are useful for the live acceptance check, with no credential exposure.
 document.body.dataset.provider=result.provider??'';document.body.dataset.awsRequestId=result.aws_request_id??'';
 document.body.dataset.mcpTools=JSON.stringify(result.trace??[]);document.body.dataset.modelRequestId=result.model_request_id??'';
 if(result.status==='saved'){drafts=drafts.filter(d=>d.id!==draft?.id);draft=null;sessionStorage.removeItem('housemed_draft_id');if(drafts.length){showDraft(drafts[0]);notice(`Prescription saved. ${drafts.length} medicine(s) left to review.`);}else{$('review-form').hidden=true;$('review-empty').hidden=false;$('review-empty').textContent=result.message;notice('Prescription saved.');}}
}
function removePhoto(){photo=undefined;$('photo').value='';$('attachment').hidden=true;if(preview)URL.revokeObjectURL(preview);preview=undefined;}
$('remove-photo').addEventListener('click',removePhoto);
$('photo').addEventListener('change',async()=>{const file=$('photo').files[0];if(!file)return;if(file.size>10_000_000){removePhoto();notice('Choose a photo under 10 MB.');return;}
 setBusy(true);notice('Preparing your photo…');
 try{
  let blob=file;if(/\.(heic|heif)$/i.test(file.name)||['image/heic','image/heif'].includes(file.type)){const {heicTo}=await import('/heic-to.js');blob=await heicTo({blob:file,type:'image/jpeg',quality:.93});}
  if(!['image/png','image/jpeg','image/webp'].includes(blob.type))throw Error('Choose a JPEG, PNG, WebP or HEIC photo.');
  const bitmap=await createImageBitmap(blob);const scale=Math.min(1,3600/Math.max(bitmap.width,bitmap.height));
  if(scale<1||blob.size>3_750_000){const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));}bitmap.close();
  if(!blob||blob.size>3_750_000)throw Error('This photo is too large after preparation. Choose a smaller photo.');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
  photo={format:blob.type.split('/')[1],data:data.split(',')[1]};if(preview)URL.revokeObjectURL(preview);preview=URL.createObjectURL(blob);$('photo-preview').src=preview;$('photo-name').textContent=file.name;$('attachment').hidden=false;if(!$('message').value)$('message').value='Add this prescription';notice('');
 }catch(e){removePhoto();notice(e?.message??'The photo could not be read. Try a JPEG or PNG copy.');}finally{setBusy(false);}
});
$('draft-choice').addEventListener('change',async()=>{if(busy)return;const id=$('draft-choice').value;setBusy(true);try{apply(await request({action:'chat',request_id:crypto.randomUUID(),draft_id:id,message:''}));}catch(e){notice(e.message);}finally{setBusy(false);}});
$('chat-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;const message=$('message').value.trim();if(!message&&!photo){notice('Add a photo or a message first.');return;}
 const body={action:'chat',request_id:crypto.randomUUID(),message,...(photo?{image:photo}:draft?{draft_id:draft.id}:{})};
 // Retain an identical request ID across network retries of this same user input.
 const signature=JSON.stringify({...body,request_id:''});if(lastRequest?.signature===signature)body.request_id=lastRequest.id;lastRequest={signature,id:body.request_id};
 setBusy(true);notice(photo?'Reading your prescription photo…':'Reading your message…');bubble(photo?`${message}\n[Prescription photo]`:message,'user');
 try{apply(await request(body));$('message').value='';removePhoto();lastRequest=undefined;notice('');}catch(e){notice(e.message);}finally{setBusy(false);}
});
$('review-form').addEventListener('submit',async event=>{event.preventDefault();if(busy||!draft)return;setBusy(true);notice('Saving your prescription…');
 const fields=Object.fromEntries(fieldNames.map(k=>[k,$(k).value.trim()]));fields.warnings=draft.fields.warnings??[];
 try{apply(await request({action:'confirm',request_id:crypto.randomUUID(),draft_id:draft.id,member_id:$('member').value,fields}));}catch(e){notice(e.message);}finally{setBusy(false);}
});
async function refresh(){if(busy)return;setBusy(true);notice('Loading your household…');try{apply(await request());notice('');}catch(e){notice(e.message);$('prescriptions').textContent='Unable to load saved prescriptions.';}finally{setBusy(false);}}
$('refresh').addEventListener('click',refresh);
async function start(){await refresh();const id=sessionStorage.getItem('housemed_draft_id');if(id){setBusy(true);try{apply(await request({action:'chat',request_id:crypto.randomUUID(),draft_id:id,message:''}));}catch(e){notice(e.message);}finally{setBusy(false);}}}
start();
