const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const state = { house: null, members: [], selectedMemberId: null, deals: [] };

const selectedMember = () => state.members.find(member => member.id === state.selectedMemberId);
const displayMedication = prescription => `${prescription.medication.name}${prescription.medication.strength ? ` ${prescription.medication.strength.amount} ${prescription.medication.strength.unit}` : ''}`;
const displayDose = prescription => `${prescription.dose.amount} ${prescription.dose.unit}, ${prescription.frequency.replaceAll('_', ' ')}`;
const medicineCount = member => member.prescriptions.length ? `${member.prescriptions.length} medicine${member.prescriptions.length === 1 ? '' : 's'}` : 'No medicines yet';

async function refreshHousehold() {
  const result = await HouseholdApi.getHousehold();
  state.house = result.house;
  state.members = result.members;
  if (!state.selectedMemberId && state.members.length) state.selectedMemberId = state.members[0].id;
}

function renderMembers() {
  $('#memberList').innerHTML = state.members.map(member => `<div class="member"><span>${member.name[0]}</span>${member.name}<button data-remove-id="${member.id}" aria-label="Remove ${member.name}">×</button></div>`).join('');
  $('#membersNext').disabled = !state.members.length;
}

function renderChoices() {
  $('#personChoices').innerHTML = state.members.map(member => `<button class="person-choice" data-person-id="${member.id}"><span class="avatar">${member.name[0]}</span><span><b>${member.name}</b><small>${medicineCount(member)}</small></span><i>›</i></button>`).join('');
}

function renderMeds() {
  const member = selectedMember();
  if (!member) return;
  $('#medsTitle').textContent = `${member.name}’s`;
  $('#medsEyebrow').textContent = `${member.name.toUpperCase()} · MEDICINES`;
  $('#medicineList').innerHTML = member.prescriptions.length
    ? member.prescriptions.map(prescription => `<div class="medicine"><span class="pill">▰</span><span><b>${displayMedication(prescription)}</b><small>${displayDose(prescription)}</small></span><span style="margin-left:auto">›</span></div>`).join('')
    : '<p class="lede" style="margin:22px 0">No medicines added yet. Add one manually or let the assistant scan a prescription.</p>';
}

async function renderDeals() {
  const result = await HouseholdApi.getDeals(state.house.id);
  state.deals = result.items;
  $('#dealList').innerHTML = result.items.map((deal, index) => `<button class="deal" data-deal="${index}"><span class="deal-icon">▰</span><span><b>${deal.medication_name}${deal.strength ? ` ${deal.strength.amount}${deal.strength.unit}` : ''}</b><small>${deal.member_name} · save $${(deal.annual_savings_cents / 100).toFixed(0)}/year</small></span><span class="price">From $${(deal.best_offer.price_cents / 100).toFixed(2)}<br><small>/ ${deal.best_offer.days_supply} days</small></span></button>`).join('');
  $('#deals .savings-card strong').textContent = `$${(result.estimated_annual_savings_cents / 100).toFixed(0)}`;
}

function go(id) { $$('.screen').forEach(screen => screen.classList.toggle('active', screen.id === id)); window.scrollTo(0, 0); }
function openModal(id) { $(id).classList.add('show'); $(id).setAttribute('aria-hidden', 'false'); }
function closeModals() { $$('.modal').forEach(modal => { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); }); }
function toast(text) { const el = $('#toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function showError(error) { toast(error.message === 'Failed to fetch' ? 'The HouseMeds service is not running.' : 'Something went wrong. Please try again.'); }

$('#memberForm').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('#memberName'); const name = input.value.trim(); if (!name) return;
  try { await HouseholdApi.createMember(state.house.id, name); await refreshHousehold(); renderMembers(); input.value = ''; }
  catch (error) { showError(error); }
});
$('#memberList').addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-id]'); if (!button) return;
  try { await HouseholdApi.deleteMember(button.dataset.removeId); await refreshHousehold(); renderMembers(); }
  catch (error) { showError(error); }
});
$('#membersNext').onclick = () => { renderChoices(); go('choose'); };
$('#personChoices').addEventListener('click', event => { const choice = event.target.closest('[data-person-id]'); if (!choice) return; state.selectedMemberId = choice.dataset.personId; renderMeds(); go('meds'); });
$('#chooseNext').onclick = async () => { try { await renderDeals(); go('deals'); } catch (error) { showError(error); } };

$('#showMedicineForm').onclick = () => openModal('#medicineModal');
$('#openAssistant').onclick = () => openModal('#assistantModal');
$('#helpButton').onclick = () => openModal('#assistantModal');
$$('.modal-close').forEach(button => button.onclick = closeModals);
$$('.modal').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) closeModals(); }));
$('#medicineForm').addEventListener('submit', async event => {
  event.preventDefault(); const name = $('#medicineName').value.trim(); if (!name) return;
  const payload = { medication: { name, strength: null, form: 'tablet' }, dose: { amount: 1, unit: 'tablet' }, frequency: 'once_daily', fulfillment: { pharmacy: $('#pharmacy').value.trim() || null, quantity: { amount: Number.parseInt($('#quantity').value, 10) || 30, unit: 'days' }, refills: Number.parseInt($('#refills').value, 10) || 1 } };
  try { await HouseholdApi.createPrescription(state.selectedMemberId, payload); await refreshHousehold(); renderMeds(); closeModals(); event.target.reset(); toast(`Medicine added to ${selectedMember().name}’s list.`); }
  catch (error) { showError(error); }
});
$('#getDeals').onclick = async () => { try { await renderDeals(); go('deals'); } catch (error) { showError(error); } };
$('#dealList').addEventListener('click', event => { const button = event.target.closest('[data-deal]'); if (!button) return; const deal = state.deals[button.dataset.deal]; $('#detailName').textContent = `${deal.medication_name}${deal.strength ? ` ${deal.strength.amount}${deal.strength.unit}` : ''}`; $('#detailPerson').textContent = deal.member_name.toUpperCase(); go('detail'); });
$('#selectDeal').onclick = () => toast('Deal selected — we’ll help with the next steps.');
$('[data-go="deals"]').onclick = () => go('deals');

const starter = [['Add members to my house', 'Who would you like to add? You can type names, nicknames, or a simple list.'], ['Add medicine from a picture', 'Attach a prescription photo or medication list. I’ll pull out the details and ask who it belongs to.'], ['Question about medicine', 'I can use the medicines in your house as context. What would you like to know?']];
function message(text, user = false) { const item = document.createElement('div'); item.className = `message${user ? ' user' : ''}`; item.textContent = text; $('#chatMessages').append(item); item.scrollIntoView({ block: 'nearest' }); }
function resetChat() { message('Hi! I can help you set up your house, add prescriptions from a photo, or answer a medicine question.'); $('#starterChoices').innerHTML = starter.map(([label]) => `<button class="starter" data-starter="${label}">${label} <span style="float:right">›</span></button>`).join(''); }
resetChat();
$('#starterChoices').onclick = event => { const button = event.target.closest('[data-starter]'); if (!button) return; const item = starter.find(([label]) => label === button.dataset.starter); message(item[0], true); message(item[1]); $('#starterChoices').innerHTML = ''; };
$('#chatForm').addEventListener('submit', event => { event.preventDefault(); const input = $('#chatText'); if (!input.value.trim()) return; message(input.value, true); setTimeout(() => message('I can help with that. For this prototype, try “Add medicine from a picture” to see the guided flow.'), 350); input.value = ''; });
$('#attach').onclick = () => { message('I attached a prescription image.', true); setTimeout(() => message('I found Sertraline 100mg, 1 tablet once daily. Which household member should I assign it to?'), 350); };

refreshHousehold().then(renderMembers).catch(showError);
