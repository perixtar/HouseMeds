import {callPrescriptionApi} from './api.js';
// PR #4 mobile UI: all persistence goes through the independent HTTP API.
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const state = {members: [], prescriptions: [], selected: '', draft: null, drafts: [], member: '', photo: null, busy: false};
const fields = {medication: 'medicineName', strength: 'strength', form: 'medicineType', directions: 'dosage', quantity: 'quantity', refills: 'refills', prescriber: 'prescriber', pharmacy: 'pharmacy'};
const draftKey = 'housemed_mobile_draft_id';
let lastRequest, manualRequestId, preview, progressTimer;
function el(tag, text, className) {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
}
function memberName(id) { return state.members.find(m => m.id === id)?.nickname ?? ''; }
function medicines(id) { return state.prescriptions.filter(p => p.member_id === id); }
function renderMembers() {
  $('#memberList').replaceChildren();
  for (const m of state.members) {
    const button = el('button', '', 'member'); button.dataset.person = m.id;
    button.append(el('span', m.nickname[0]), el('b', m.nickname), el('small', `${medicines(m.id).length} saved`, 'saved-badge'));
    $('#memberList').append(button);
  }
  $('#membersNext').disabled = state.busy || !state.members.length;
}
function renderChoices() {
  $('#personChoices').replaceChildren();
  for (const m of state.members) {
    const button = el('button', '', 'person-choice'); button.dataset.person = m.id;
    const title = el('span'); title.append(el('b', m.nickname), el('small', `${medicines(m.id).length} saved medicines`));
    button.append(el('span', m.nickname[0], 'avatar'), title, el('i', '›')); $('#personChoices').append(button);
  }
}
function renderMeds() {
  const name = memberName(state.selected);
  $('#medsTitle').textContent = name + '’s'; $('#medsEyebrow').textContent = name.toUpperCase() + ' · MEDICINES';
  $('#medicineList').replaceChildren();
  for (const p of medicines(state.selected)) {
    const row = el('article', '', 'medicine'); row.dataset.prescriptionId = p.id;
    const detail = el('span'); detail.append(el('b', `${p.fields.medication} ${p.fields.strength}`.trim()));
    if (p.normalization.status === 'verified') detail.append(el('small', p.normalization.name));
    if (p.fields.directions) detail.append(el('small', p.fields.directions));
    row.append(el('span', '▰', 'pill'), detail, el('span', 'Saved', 'saved-badge')); $('#medicineList').append(row);
  }
  if (!medicines(state.selected).length) $('#medicineList').append(el('p', 'No medicines added yet. Add one manually or scan a prescription.', 'lede'));
}
function render() { renderMembers(); renderChoices(); renderMeds(); }
function go(id) { $$('.screen').forEach(s => s.classList.toggle('active', s.id === id)); window.scrollTo(0, 0); }
function closeModals() { $$('.modal').forEach(m => { m.classList.remove('show'); m.setAttribute('aria-hidden', 'true'); }); }
function openModal(id) { closeModals(); $(id).classList.add('show'); $(id).setAttribute('aria-hidden', 'false'); }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 3000); }
function message(text, user = false) { const node = el('div', text, 'message' + (user ? ' user' : '')); $('#chatMessages').append(node); node.scrollIntoView({block: 'nearest'}); return node; }
function setBusy(value, title = 'Loading your medicines…', detail = 'Please wait a moment.') {
  state.busy = value;
  clearTimeout(progressTimer);
  $('#chatProgress').hidden = !value;
  $('#chatForm').setAttribute('aria-busy', String(value));
  $('#sendChat').classList.toggle('is-loading', value);
  $('#sendChat').setAttribute('aria-label', value ? 'Please wait, request in progress' : 'Send message');
  $('#chatActions').hidden = value || Boolean(state.photo);
  $('#starterChoices').hidden = value || Boolean(state.photo);
  if (value) {
    $('#progressTitle').textContent = title; $('#progressDetail').textContent = detail;
    progressTimer = setTimeout(() => { $('#progressDetail').textContent = 'Still working. You don’t need to send it again.'; }, 15000);
  }
  $$('#chatForm button, #chatForm input, #medicineForm input, #medicineForm textarea, #medicineForm select, #saveMedicine, #photoInput, #removePhoto, #chatActions button, #starterChoices button').forEach(n => n.disabled = value);
  $('#membersNext').disabled = value || !state.members.length;
}
async function request(body) {
  const result = await callPrescriptionApi(body);
  document.body.dataset.provider = result.provider ?? ''; document.body.dataset.awsRequestId = result.aws_request_id ?? '';
  document.body.dataset.mcpTools = JSON.stringify(result.trace ?? []); document.body.dataset.modelRequestId = result.model_request_id ?? '';
  return result;
}
function renderMemberSelect() {
  $('#reviewMember').replaceChildren(new Option('Choose a household member', ''));
  for (const m of state.members) $('#reviewMember').add(new Option(m.nickname, m.id));
  $('#reviewMember').value = state.member;
}
function showDraft(draft) {
  state.draft = draft; sessionStorage.setItem(draftKey, draft.id);
  for (const [key, id] of Object.entries(fields)) $('#' + id).value = draft.fields[key] ?? '';
  renderMemberSelect(); $('#draftChoiceLabel').hidden = state.drafts.length < 2;
  $('#draftChoice').replaceChildren();
  for (const d of state.drafts) $('#draftChoice').add(new Option(`${d.fields.medication} ${d.fields.strength}`.trim(), d.id));
  $('#draftChoice').value = draft.id;
  const n = draft.normalization;
  $('#identity').textContent = n.status === 'verified' ? `RxNorm identity: ${n.name}` : 'Medication identity is unverified. The original label text is preserved.';
  $('#reviewWarnings').replaceChildren(...(draft.fields.warnings ?? []).map(w => el('li', w)));
  $('#reviewStatus').textContent = '';
}
function chatActions() {
  $('#chatActions').replaceChildren();
  if (!state.draft) return;
  if (!state.member) for (const m of state.members) {
    const button = el('button', m.nickname, 'starter'); button.type = 'button'; button.onclick = () => sendMessage(m.nickname); $('#chatActions').append(button);
  }
  const review = el('button', `Review prescription${state.drafts.length > 1 ? ` (${state.drafts.length} medicines)` : ''} →`, 'starter');
  review.type = 'button'; review.onclick = () => openModal('#medicineModal'); $('#chatActions').append(review);
}
function apply(result, speak = true) {
  if (result.members) state.members = result.members;
  if (result.prescriptions) state.prescriptions = result.prescriptions;
  if (!state.members.some(m => m.id === state.selected)) state.selected = state.members[0]?.id ?? '';
  if (result.household_name) $('#householdName').textContent = result.household_name;
  if (result.status === 'needs_member') state.member = '';
  if (result.selected_member_id) state.member = result.selected_member_id;
  if (result.drafts) state.drafts = result.drafts;
  if (result.draft) showDraft(result.draft);
  if (speak && result.message) message(result.message);
  render(); chatActions();
}
function removePhoto() {
  state.photo = null; $('#photoInput').value = ''; $('#attachment').hidden = true;
  $('#photoPreview').removeAttribute('src');
  if (preview) URL.revokeObjectURL(preview); preview = null;
}
async function sendMessage(text) {
  if (state.busy || (!text && !state.photo)) return;
  const body = {action: 'chat', request_id: crypto.randomUUID(), message: text, ...(state.photo ? {image: state.photo} : state.draft ? {draft_id: state.draft.id} : {})};
  const signature = JSON.stringify({...body, request_id: ''});
  if (lastRequest?.signature === signature) body.request_id = lastRequest.id;
  lastRequest = {signature, id: body.request_id};
  const photo = state.photo;
  setBusy(true, photo ? 'Sending photo & reading prescription…' : 'HouseMeds is responding…', photo ? 'We’re checking the image for medicine details. This may take a moment.' : 'Checking your prescription details.');
  $('#chatStatus').textContent = '';
  const sent = message(text || 'Add this prescription', true);
  let photoStatus;
  if (photo) {
    const image = el('img', '', 'sent-photo'); image.alt = 'Your prescription photo';
    image.src = `data:image/${photo.format};base64,${photo.data}`;
    photoStatus = el('small', 'Sending photo…', 'photo-status');
    sent.append(image, el('small', $('#photoName').textContent, 'sent-photo-name'), photoStatus);
    $('#attachment').hidden = true;
    sent.scrollIntoView({block: 'nearest'});
  }
  try {
    const result = await request(body);
    if (photoStatus) photoStatus.textContent = '✓ Photo received';
    apply(result); $('#chatText').value = ''; removePhoto(); lastRequest = null; $('#starterChoices').replaceChildren();
    $('#chatStatus').textContent = state.draft ? 'Review the extracted details before saving.' : '';
  } catch (e) {
    if (photoStatus) { photoStatus.textContent = 'Couldn’t finish · photo kept for retry'; $('#attachment').hidden = false; }
    $('#chatStatus').textContent = `${e.message} Try sending again.`;
  } finally { setBusy(false); }
}
for (const id of ['#memberList', '#personChoices']) $(id).onclick = event => {
  const button = event.target.closest('[data-person]'); if (!button) return;
  state.selected = button.dataset.person; renderMeds(); go('meds');
};
$('#membersNext').onclick = () => { renderChoices(); go('choose'); };
for (const id of ['#chooseNext', '#getDeals']) $(id).onclick = () => { window.location.href = '/'; };
for (const id of ['#openAssistant', '#helpButton', '#houseAssistant']) $(id).onclick = () => openModal('#assistantModal');
$$('.modal-close').forEach(b => b.onclick = closeModals);
$$('.modal').forEach(m => m.onclick = e => { if (e.target === m) closeModals(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
$('.brand').onclick = e => { e.preventDefault(); closeModals(); go('house'); };
$('#chatForm').onsubmit = e => { e.preventDefault(); sendMessage($('#chatText').value.trim()); };
$('#attach').onclick = () => $('#photoInput').click();
$('#removePhoto').onclick = () => { removePhoto(); setBusy(false); $('#chatStatus').textContent = 'Photo removed. You can attach another.'; };
$('#photoInput').onchange = async () => {
  const file = $('#photoInput').files[0]; if (!file) return;
  removePhoto();
  setBusy(true, 'Preparing your photo…', 'Making the image ready to send.'); $('#chatStatus').textContent = '';
  try {
    const {preparePhoto} = await import('./photo.js'); const prepared = await preparePhoto(file);
    if (preview) URL.revokeObjectURL(preview); preview = prepared.preview; state.photo = prepared.image;
    $('#photoPreview').src = preview; $('#photoName').textContent = file.name; $('#attachment').hidden = false;
    if (!$('#chatText').value) $('#chatText').value = 'Add this prescription'; $('#chatStatus').textContent = 'Photo ready to send.';
  } catch (e) { removePhoto(); $('#chatStatus').textContent = e.message; } finally { setBusy(false); }
};
$('#reviewMember').onchange = () => { state.member = $('#reviewMember').value; chatActions(); };
$('#draftChoice').onchange = async () => {
  setBusy(true, 'Loading prescription…'); $('#reviewStatus').textContent = 'Loading prescription…';
  try { apply(await request({action: 'chat', request_id: crypto.randomUUID(), draft_id: $('#draftChoice').value, message: ''}), false); }
  catch (e) { $('#reviewStatus').textContent = e.message; } finally { setBusy(false); }
};
$('#showMedicineForm').onclick = () => {
  if (state.busy) return;
  state.draft = null; state.drafts = []; state.member = state.selected; manualRequestId = crypto.randomUUID();
  sessionStorage.removeItem(draftKey); $('#medicineForm').reset(); renderMemberSelect(); $('#draftChoiceLabel').hidden = true;
  $('#identity').textContent = ''; $('#reviewWarnings').replaceChildren(); $('#reviewStatus').textContent = ''; openModal('#medicineModal');
};
$('#medicineForm').onsubmit = async event => {
  event.preventDefault(); if (state.busy) return;
  const member = $('#reviewMember').value;
  const reviewed = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $('#' + id).value.trim()]));
  reviewed.warnings = state.draft?.fields.warnings ?? [];
  setBusy(true, 'Saving your prescription…'); $('#reviewStatus').textContent = 'Saving your prescription…';
  try {
    if (!state.draft) {
      const prepared = await request({action: 'prepare', request_id: manualRequestId ??= crypto.randomUUID(), fields: reviewed});
      state.draft = prepared.draft; state.drafts = prepared.drafts; sessionStorage.setItem(draftKey, state.draft.id);
    }
    const savedDraft = state.draft.id;
    const result = await request({action: 'confirm', request_id: crypto.randomUUID(), draft_id: savedDraft, member_id: member, fields: reviewed});
    apply(result); state.selected = member; state.member = member;
    state.drafts = state.drafts.filter(d => d.id !== savedDraft); state.draft = null; sessionStorage.removeItem(draftKey);
    if (state.drafts.length) { showDraft(state.drafts[0]); $('#reviewStatus').textContent = `Saved. ${state.drafts.length} medicine(s) left to review.`; }
    else { closeModals(); go('meds'); }
    render(); chatActions(); toast(`Saved for ${memberName(member)}.`);
  } catch (e) { $('#reviewStatus').textContent = e.message; } finally { setBusy(false); }
};
message('Add a prescription photo or type its details. I’ll ask who it’s for, then you can review and save.');
const starter = el('button', 'Add medicine from a picture →', 'starter'); starter.type = 'button'; starter.onclick = () => $('#photoInput').click(); $('#starterChoices').append(starter);
async function start() {
  setBusy(true);
  try {
    apply(await request(), false); $('#houseStatus').textContent = state.members.length ? 'Choose a household member.' : 'No household members are configured.';
    const id = sessionStorage.getItem(draftKey);
    if (id) apply(await request({action: 'chat', request_id: crypto.randomUUID(), draft_id: id, message: ''}), false);
  } catch (e) { $('#houseStatus').textContent = e.message; $('#chatStatus').textContent = e.message; }
  finally { setBusy(false); }
}
start();
