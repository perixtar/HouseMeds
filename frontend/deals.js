// Example prices from the household prototype; never live pharmacy quotes.
const offers = [
  {pharmacy: 'Cost Plus Drugs', priceCents: 1240, daysSupply: 90},
  {pharmacy: 'Local Pharmacy', priceCents: 3899, daysSupply: 90},
  {pharmacy: 'GoodRx at CVS', priceCents: 2120, daysSupply: 90},
];
export const money = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
export function prototypeDeals(prescriptions, members) {
  return prescriptions.map(prescription => ({
    id: prescription.id,
    member: members.find(member => member.id === prescription.member_id)?.nickname ?? 'Household member',
    name: `${prescription.fields.medication} ${prescription.fields.strength}`.trim(),
    identity: prescription.normalization.status === 'verified' ? prescription.normalization.name : '',
    offers,
    best: offers[0],
    annualSavingsCents: Math.round((offers[1].priceCents - offers[0].priceCents) * 365 / 90),
  }));
}
