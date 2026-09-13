export const familyMembers = ['Grandma', 'Grandpa', 'Dad'];
export const familyDemo = new URLSearchParams(window.location.search).get('demo') === 'family';
// The repeatable demo has its own persisted household and intake state.
export const storageKey = key => familyDemo ? `${key}_family_demo` : key;

const sampleMedicines = {
  Grandma: [['Synthroid', '75 mcg'], ['Amlodipine', '5 mg'], ['Lisinopril', '10 mg'], ['Metformin', '500 mg'], ['Atorvastatin', '20 mg'], ['Furosemide', '20 mg'], ['Apixaban', '5 mg'], ['Tamsulosin', '0.4 mg'], ['Acetaminophen', '500 mg']],
  Grandpa: [['Metoprolol ER', '25 mg'], ['Losartan', '50 mg'], ['Atorvastatin', '40 mg'], ['Apixaban', '5 mg'], ['Furosemide', '40 mg'], ['Pantoprazole', '40 mg'], ['Gabapentin', '100 mg'], ['Nitroglycerin', '0.4 mg'], ['Vitamin D3', '1000 IU']],
  Dad: [['Metformin ER', '500 mg'], ['Losartan', '100 mg'], ['Atorvastatin', '40 mg'], ['Empagliflozin', '10 mg'], ['Aspirin', '81 mg'], ['Sildenafil', '50 mg']],
};
export function familyDemoState() {
  const members = familyMembers.map(nickname => ({id: `demo-${nickname.toLowerCase()}`, nickname}));
  return {status: 'ready', household_name: 'Family demo', members,
    prescriptions: members.flatMap(member => sampleMedicines[member.nickname].map(([medication, strength], index) => ({
      id: `${member.id}-${index}`, member_id: member.id,
      fields: {medication, strength, form: '', directions: '', quantity: '', refills: '', prescriber: '', pharmacy: '', warnings: []},
      normalization: {status: 'unverified'},
    })))};
}
