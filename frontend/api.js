// One client boundary for the household API. Keep UI code independent of storage.
window.HouseholdApi = {
  async request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    if (response.status === 204) return null;
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'request_failed');
    return body;
  },
  getHousehold() { return this.request('/v1/me/household'); },
  createMember(houseId, name) { return this.request(`/v1/houses/${houseId}/members`, { method: 'POST', body: JSON.stringify({ name }) }); },
  deleteMember(memberId) { return this.request(`/v1/members/${memberId}`, { method: 'DELETE' }); },
  createPrescription(memberId, prescription) { return this.request(`/v1/members/${memberId}/prescriptions`, { method: 'POST', body: JSON.stringify(prescription) }); },
  getDeals(houseId) { return this.request(`/v1/deals?house_id=${encodeURIComponent(houseId)}`); },
};
