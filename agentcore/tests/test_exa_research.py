import asyncio
import exa_research
from exa_research import _first_party, _listing_from_search, _price_from_first_party


def test_search_candidates_are_first_party_and_match_requested_strength():
    content = """Title: Lisinopril 20 MG Tablet
URL: https://pharmacy.amazon.com/wrong

Title: Lisinopril 10 MG Tablet
URL: https://evil.example/offer

Title: Lisinopril 10 MG Tablet
URL: https://pharmacy.amazon.com/right
"""
    result = _listing_from_search(content, "pharmacy.amazon.com", "Lisinopril", "10 mg")
    assert result == {"listing_name": "Lisinopril 10 MG Tablet", "listing_url": "https://pharmacy.amazon.com/right"}
    assert not _first_party("https://pharmacy.amazon.com.evil.example/offer", "pharmacy.amazon.com")
    assert not _first_party("http://pharmacy.amazon.com/offer", "pharmacy.amazon.com")


def test_cash_price_requires_explicit_physical_quantity():
    assert _price_from_first_party("Cash price: $12.40 for 90 tablets") == {
        "price_cents": "1240", "physical_quantity": "90", "content_unit": "tablet"}
    assert _price_from_first_party("From $12.40. Select a quantity to see the price") is None
    assert _price_from_first_party("$12.40 for 90 tablets") is None


def test_research_sends_only_deduplicated_medicine_identity(monkeypatch):
    calls = []

    async def fake_research(medicine, strength, form, key):
        calls.append((medicine, strength, form, key))
        return {"status": "complete", "candidates": []}

    monkeypatch.setattr(exa_research, "exa_key", lambda: "test-key")
    monkeypatch.setattr(exa_research, "_research_one", fake_research)
    prescriptions = [{"member_id": "private-member", "fields": {
        "medication": "Lisinopril", "strength": "10 mg", "form": "tablet",
        "directions": "private directions", "prescriber": "private prescriber"}}] * 2
    result = asyncio.run(exa_research.research_medicines(prescriptions))
    assert calls == [("Lisinopril", "10 mg", "tablet", "test-key")]
    assert result[("lisinopril", "10 mg", "tablet")]["status"] == "complete"
