import {costPlusProduct, costPlusBrowseUrl} from './costplus-links.js';
// Example prices from the household prototype; never live pharmacy quotes.
const offers = [
  {pharmacy: 'Cost Plus Drugs', priceCents: 1240, daysSupply: 90},
  {pharmacy: 'Local Pharmacy', priceCents: 3899, daysSupply: 90},
  {pharmacy: 'GoodRx at CVS', priceCents: 2120, daysSupply: 90},
];
export const money = cents => new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD'}).format(cents / 100);
export function prototypeDeals(prescriptions, members, memberId = null) {
  const memberById = new Map(members.map(member => [member.id, member]));
  return prescriptions.filter(prescription => memberById.has(prescription.member_id)
    && (memberId === null || prescription.member_id === memberId)).map(prescription => {
    const product = costPlusProduct(prescription.fields);
    const best = {...offers[0], productUrl: product?.url ?? costPlusBrowseUrl, product};
    return {
    id: prescription.id,
    member: memberById.get(prescription.member_id).nickname,
    name: `${prescription.fields.medication} ${prescription.fields.strength}`.trim(),
    identity: prescription.normalization.status === 'verified' ? prescription.normalization.name : '',
    offers: [best, ...offers.slice(1)],
    best,
    annualSavingsCents: Math.round((offers[1].priceCents - offers[0].priceCents) * 365 / 90),
  }; });
}
