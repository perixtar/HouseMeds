import {callPrescriptionApi} from './api.js';
import {prototypeDeals, money} from './deals.js';
// PR #4 mobile UI: all persistence goes through the independent HTTP API.
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const state = {members: [], prescriptions: [], selected: '', draft: null, drafts: [], member: '', photo: null, busy: false, edits: {}, pendingAction: null};
const fields = {medication: 'medicineName', strength: 'strength', form: 'medicineType', directions: 'dosage', quantity: 'quantity', refills: 'refills', prescriber: 'prescriber', pharmacy: 'pharmacy'};
const draftKey = 'housemed_mobile_draft_id';
const contextKey = 'housemed_intake_context';
let lastRequest, manualRequestId, preview, progressTimer;
let deals = [], selectedDeal;
let memberRequest;
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
function renderDeals() {
  deals = prototypeDeals(state.prescriptions, state.members);
  $('#dealList').replaceChildren();
  $('#savingsTotal').textContent = money(deals.reduce((total, deal) => total + deal.annualSavingsCents, 0));
  $('#savingsCard').hidden = !deals.length;
  $('#dealsEmpty').hidden = Boolean(deals.length);
  for (const deal of deals) {
    const button = el('button', '', 'deal'); button.type = 'button';
    const detail = el('span'); detail.append(el('b', deal.name), el('small', `${deal.member} · example savings ${money(deal.annualSavingsCents)}/year`));
    const price = el('span', `From ${money(deal.best.priceCents)}`, 'price'); price.append(el('small', `/ ${deal.best.daysSupply} days`));
    button.append(el('span', '▰', 'deal-icon'), detail, price);
    button.onclick = () => showDeal(deal); $('#dealList').append(button);
  }
}
function showDeal(deal) {
  selectedDeal = deal;
  $('#detailPerson').textContent = deal.member.toUpperCase(); $('#detailName').textContent = deal.name;
  $('#detailIdentity').textContent = deal.identity; $('#detailIdentity').hidden = !deal.identity;
  $('#dealPharmacy').textContent = deal.best.pharmacy; $('#dealPrice').textContent = money(deal.best.priceCents);
  $('#dealSupply').textContent = `for ${deal.best.daysSupply} days`;
  $('#otherOffers').replaceChildren(...deal.offers.slice(1).map(offer => {
    const row = el('div', '', 'option'); row.append(el('span', offer.pharmacy), el('b', money(offer.priceCents))); return row;
  }));
  $('#selectDeal').textContent = 'Select this deal'; $('#dealSelection').textContent = '';
  go('detail');
}
function openDeals() { renderDeals(); go('deals'); }
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
  $$('#memberForm button, #memberForm input, #chatForm button, #chatForm input, #medicineForm input, #medicineForm textarea, #medicineForm select, #medicineForm button, #photoInput, #removePhoto, #chatActions button, #starterChoices button').forEach(n => n.disabled = value);
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
function persistContext() {
  if (state.draft) sessionStorage.setItem(contextKey, JSON.stringify({draft_id: state.draft.id, member: state.member, pendingAction: state.pendingAction, edits: state.edits}));
  else sessionStorage.removeItem(contextKey);
}
function reviewedFields() {
  return {...Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $('#' + id).value.trim()])), warnings: state.draft?.fields.warnings ?? []};
}
function captureEdits() {
  if (state.draft) { state.edits[state.draft.id] = reviewedFields(); persistContext(); }
}
function reviewedDrafts() {
  return state.drafts.filter(d => state.edits[d.id]).map(d => ({draft_id: d.id, fields: state.edits[d.id]}));
}
function renderBatchSave() {
  const count = state.drafts.length;
  $('#batchSave').hidden = count < 2;
  $('#batchTitle').textContent = `${count} medicines ready to save`;
  $('#batchMedicines').replaceChildren(...state.drafts.map(d => {
    const f = state.edits[d.id] ?? d.fields;
    return el('li', `${f.medication} ${f.strength}${f.warnings?.length ? ' · check flagged details' : ''}`.trim());
  }));
  $('#saveAllMedicines').textContent = `Save all ${count} medicines${state.member ? ` for ${memberName(state.member)}` : ''}`;
  $('#batchStatus').textContent = state.member ? '' : 'Choose who this list is for above.';
  $('#saveMedicine').textContent = count > 1 ? 'Save this medicine only' : 'Save prescription';
}
function showDraft(draft) {
  state.draft = draft; sessionStorage.setItem(draftKey, draft.id);
  for (const [key, id] of Object.entries(fields)) $('#' + id).value = (state.edits[draft.id] ?? draft.fields)[key] ?? '';
  renderMemberSelect(); $('#draftChoiceLabel').hidden = state.drafts.length < 2;
  $('#draftChoice').replaceChildren();
  for (const d of state.drafts) $('#draftChoice').add(new Option(`${d.fields.medication} ${d.fields.strength}`.trim(), d.id));
  $('#draftChoice').value = draft.id;
  const n = draft.normalization;
  $('#identity').textContent = n.status === 'verified' ? `RxNorm identity: ${n.name}` : 'Medication identity is unverified. The original label text is preserved.';
  $('#reviewWarnings').replaceChildren(...(draft.fields.warnings ?? []).map(w => el('li', w)));
  $('#reviewStatus').textContent = '';
  renderBatchSave(); persistContext();
}
function chatActions() {
  $('#chatActions').replaceChildren();
  if (!state.draft) return;
  if (!state.member) for (const m of state.members) {
    const button = el('button', m.nickname, 'starter'); button.type = 'button'; button.onclick = () => sendMessage(m.nickname); $('#chatActions').append(button);
  }
  const review = el('button', `Review prescription${state.drafts.length > 1 ? ` (${state.drafts.length} medicines)` : ''} →`, 'starter');
  review.type = 'button'; review.onclick = () => openModal('#medicineModal'); $('#chatActions').append(review);
  const save = el('button', `Save all ${state.drafts.length} medicines${state.member ? ` for ${memberName(state.member)}` : ''}`, 'starter');
  save.type = 'button'; save.onclick = () => saveBatch(false); $('#chatActions').append(save);
}
function apply(result, speak = true) {
  if (result.members) state.members = result.members;
  if (result.prescriptions) state.prescriptions = result.prescriptions;
  if (!state.members.some(m => m.id === state.selected)) state.selected = state.members[0]?.id ?? '';
  if (result.household_name) $('#householdName').textContent = result.household_name;
  if (result.status === 'needs_member') state.member = '';
  if ('selected_member_id' in result) state.member = result.selected_member_id ?? '';
  if ('pending_action' in result) state.pendingAction = result.pending_action;
  if (result.drafts) state.drafts = result.drafts;
  if (result.draft) showDraft(result.draft);
  if (result.status === 'saved_all') {
    state.selected = result.selected_member_id ?? state.selected;
    state.draft = null; state.drafts = []; state.edits = {}; state.pendingAction = null;
    sessionStorage.removeItem(draftKey); closeModals(); go('meds'); toast(result.message);
  } else if (result.status === 'saved' && result.saved_draft_id) {
    state.selected = result.selected_member_id ?? state.selected;
    delete state.edits[result.saved_draft_id];
    state.drafts = state.drafts.filter(d => d.id !== result.saved_draft_id);
    state.draft = null; sessionStorage.removeItem(draftKey);
    if (state.drafts.length) showDraft(state.drafts[0]);
  }
  persistContext();
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
  captureEdits();
  const body = {action: 'chat', request_id: crypto.randomUUID(), message: text, ...(state.member ? {member_id: state.member} : {}), ...(state.photo ? {image: state.photo} : state.draft ? {draft_id: state.draft.id, fields: reviewedFields(), pending_action: state.pendingAction, reviewed_drafts: reviewedDrafts()} : {})};
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
    if (photo) { state.edits = {}; state.pendingAction = null; }
    apply(result); $('#chatText').value = ''; removePhoto(); lastRequest = null; $('#starterChoices').replaceChildren();
    $('#chatStatus').textContent = state.pendingAction ? 'Choose a member to save the whole list.' : state.draft ? 'Review the details, or ask me to save all.' : '';
  } catch (e) {
    if (photoStatus) { photoStatus.textContent = 'Couldn’t finish · photo kept for retry'; $('#attachment').hidden = false; }
    $('#chatStatus').textContent = `${e.message} Try sending again.`;
  } finally { setBusy(false); }
}
$('#memberForm').onsubmit = async event => {
  event.preventDefault(); if (state.busy) return;
  const nickname = $('#memberName').value.trim();
  if (!nickname) { $('#memberStatus').textContent = 'Enter a name or nickname.'; $('#memberName').focus(); return; }
  if (memberRequest?.nickname !== nickname) memberRequest = {nickname, id: crypto.randomUUID()};
  setBusy(true, 'Adding household member…'); $('#memberForm').setAttribute('aria-busy', 'true');
  $('#addMember').textContent = '…'; $('#memberStatus').textContent = `Adding ${nickname}…`;
  try {
    const result = await request({action: 'create_member', request_id: memberRequest.id, nickname});
    apply(result, false); renderMemberSelect();
    $('#memberName').value = ''; memberRequest = null; $('#memberStatus').textContent = result.message;
    $('#houseStatus').textContent = 'Choose a household member.';
  } catch (e) { $('#memberStatus').textContent = `${e.message} Try adding this member again.`; }
  finally { setBusy(false); $('#memberForm').setAttribute('aria-busy', 'false'); $('#addMember').textContent = '+'; }
};
for (const id of ['#memberList', '#personChoices']) $(id).onclick = event => {
  const button = event.target.closest('[data-person]'); if (!button) return;
  state.selected = button.dataset.person; renderMeds(); go('meds');
};
$('#membersNext').onclick = () => { renderChoices(); go('choose'); };
for (const id of ['#chooseNext', '#getDeals']) $(id).onclick = openDeals;
$('[data-go="deals"]').onclick = () => go('deals');
$('#dealsAddMedicine').onclick = () => { renderChoices(); go('choose'); };
$('#selectDeal').onclick = () => {
  if (!selectedDeal) return;
  $('#selectDeal').textContent = '✓ Selected for this preview';
  $('#dealSelection').textContent = `${selectedDeal.best.pharmacy} selected for ${selectedDeal.name}. Demo selection only; no order or prescription transfer was sent.`;
};
for (const id of ['#openAssistant', '#helpButton', '#houseAssistant']) $(id).onclick = () => {
  if (id === '#openAssistant') { state.member = state.selected; renderMemberSelect(); renderBatchSave(); chatActions(); persistContext(); }
  openModal('#assistantModal');
};
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
$('#reviewMember').onchange = () => { state.member = $('#reviewMember').value; persistContext(); renderBatchSave(); chatActions(); };
for (const id of Object.values(fields)) $('#' + id).oninput = () => { captureEdits(); renderBatchSave(); };
$('#draftChoice').onchange = async () => {
  captureEdits();
  setBusy(true, 'Loading prescription…'); $('#reviewStatus').textContent = 'Loading prescription…';
  try { apply(await request({action: 'chat', request_id: crypto.randomUUID(), draft_id: $('#draftChoice').value, message: '', ...(state.member ? {member_id: state.member} : {}), pending_action: state.pendingAction}), false); }
  catch (e) { $('#reviewStatus').textContent = e.message; } finally { setBusy(false); }
};
$('#showMedicineForm').onclick = () => {
  if (state.busy) return;
  state.draft = null; state.drafts = []; state.edits = {}; state.pendingAction = null; state.member = state.selected; manualRequestId = crypto.randomUUID();
  sessionStorage.removeItem(draftKey); $('#medicineForm').reset(); renderMemberSelect(); $('#draftChoiceLabel').hidden = true;
  persistContext(); renderBatchSave(); $('#identity').textContent = ''; $('#reviewWarnings').replaceChildren(); $('#reviewStatus').textContent = ''; openModal('#medicineModal');
};
async function saveBatch(fromForm = true) {
  if (state.busy || !state.draft) return;
  if (fromForm && !$('#medicineForm').reportValidity()) return;
  captureEdits();
  setBusy(true, `Saving ${state.drafts.length} medicines…`, 'Saving the whole list together. You don’t need to send it again.');
  $('#reviewStatus').textContent = $('#batchStatus').textContent = 'Saving all medicines…';
  try {
    const result = await request({action: 'confirm_all', request_id: crypto.randomUUID(), draft_id: state.draft.id,
      ...(state.member ? {member_id: state.member} : {}), reviewed_drafts: reviewedDrafts()});
    apply(result); $('#reviewStatus').textContent = $('#batchStatus').textContent = result.message;
  } catch (e) { $('#reviewStatus').textContent = $('#batchStatus').textContent = $('#chatStatus').textContent = `${e.message} You can safely retry Save all.`; }
  finally { setBusy(false); }
}
$('#saveAllMedicines').onclick = () => saveBatch(true);
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
    if (state.drafts.length) { showDraft(state.drafts[0]); $('#reviewStatus').textContent = `Saved. ${state.drafts.length} medicine(s) left to review.`; }
    else { closeModals(); go('meds'); }
    render(); chatActions(); toast(`Saved for ${memberName(member)}.`);
  } catch (e) { $('#reviewStatus').textContent = e.message; } finally { setBusy(false); }
};
message('Add a prescription photo or type its details. Choose who it’s for, then review individual medicines or ask me to save the whole list.');
const starter = el('button', 'Add medicine from a picture →', 'starter'); starter.type = 'button'; starter.onclick = () => $('#photoInput').click(); $('#starterChoices').append(starter);
async function start() {
  const storedContext = sessionStorage.getItem(contextKey);
  setBusy(true);
  try {
    apply(await request(), false); $('#houseStatus').textContent = state.members.length ? 'Choose a household member.' : 'Add your first household member.';
    const id = sessionStorage.getItem(draftKey);
    if (id) {
      try {
        const context = JSON.parse(storedContext || '{}');
        if (context.draft_id === id) { state.member = context.member ?? ''; state.pendingAction = context.pendingAction ?? null; state.edits = context.edits ?? {}; }
      } catch { sessionStorage.removeItem(contextKey); }
      apply(await request({action: 'chat', request_id: crypto.randomUUID(), draft_id: id, message: '', ...(state.member ? {member_id: state.member} : {}), pending_action: state.pendingAction}), false);
    }
  } catch (e) { $('#houseStatus').textContent = e.message; $('#chatStatus').textContent = e.message; }
  finally { setBusy(false); }
}
start();
