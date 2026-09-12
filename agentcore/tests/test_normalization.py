"""RxNorm boundary tests: resolve exact identities without inventing a missing form."""
import asyncio
import httpx
import pytest
import normalization


def lookup(monkeypatch, routes, name):
    client_type = httpx.AsyncClient
    requests = []

    def respond(request):
        key = (request.url.path.removeprefix("/REST/"), tuple(sorted(request.url.params.items())))
        requests.append(key)
        assert key in routes, f"Unexpected RxNorm request: {key}"
        return httpx.Response(200, json=routes[key])

    monkeypatch.setattr(normalization.httpx, "AsyncClient", lambda **kwargs: client_type(
        **kwargs, transport=httpx.MockTransport(respond)))
    return asyncio.run(normalization.normalize_medication(name)), requests


def key(endpoint, **params):
    return endpoint, tuple(sorted(params.items()))


def group(tty, values):
    return {"relatedGroup": {"conceptGroup": [{"tty": tty, "conceptProperties": values}]}}


BRAND = {"rxcui": "82728", "name": "Zoloft", "tty": "BN"}
COMPONENT = {"rxcui": "568875", "name": "sertraline 100 MG [Zoloft]", "tty": "SBDC"}
GENERIC = {"rxcui": "328670", "name": "sertraline 100 MG", "tty": "SCDC"}


def component_routes(candidates=None):
    return {
        key("rxcui.json", name="Zoloft 100mg", search="2"): {"idGroup": {}},
        key("rxcui.json", name="Zoloft", search="2"): {"idGroup": {"rxnormId": ["82728"]}},
        key("rxcui/82728/properties.json"): {"properties": BRAND},
        key("rxcui/82728/related.json", tty="SBDC"): group("SBDC", candidates if candidates is not None else [
            COMPONENT, {"rxcui": "other", "name": "sertraline 100 MG/ML [Zoloft]", "tty": "SBDC"}]),
        key("rxcui/568875/related.json", tty="SCDC"): group("SCDC", [GENERIC]),
    }


def test_brand_and_strength_resolves_without_inventing_a_form(monkeypatch):
    result, _ = lookup(monkeypatch, component_routes(), "Zoloft 100mg")
    assert result["status"] == "verified"
    assert result["name"] == "sertraline 100 MG"
    assert result["scope"] == "ingredient_strength"
    assert result["original"] == "Zoloft 100mg"


def test_ambiguous_same_strength_components_remain_unverified(monkeypatch):
    candidates = [COMPONENT, dict(COMPONENT, rxcui="999")]
    result, calls = lookup(monkeypatch, component_routes(candidates), "Zoloft 100mg")
    assert result["status"] == "unverified"
    assert not any(endpoint == "rxcui/568875/related.json" for endpoint, _ in calls)


@pytest.mark.parametrize("name", ["Zoloft", "Zoloff 100mg", "Zoloft 100mg extended release", "Zoloft 100mg/ml"])
def test_missing_strength_unknown_name_or_unresolved_form_is_not_guessed(monkeypatch, name):
    routes = {key("rxcui.json", name=name, search="2"): {"idGroup": {}}}
    if name == "Zoloff 100mg":
        routes[key("rxcui.json", name="Zoloff", search="2")] = {"idGroup": {}}
    result, _ = lookup(monkeypatch, routes, name)
    assert result["status"] == "unverified"
    assert result["name"] == name


def test_exact_product_retains_its_dosage_form(monkeypatch):
    routes = {
        key("rxcui.json", name="Zoloft 100 mg tablets", search="2"): {"idGroup": {"rxnormId": ["208149"]}},
        key("rxcui/208149/properties.json"): {"properties": {"rxcui": "208149", "tty": "SBD"}},
        key("rxcui/208149/related.json", tty="SCD"): group("SCD", [{"rxcui": "312938", "tty": "SCD", "name": "sertraline 100 MG Oral Tablet"}]),
    }
    result, _ = lookup(monkeypatch, routes, "Zoloft 100 mg tablets")
    assert result["name"] == "sertraline 100 MG Oral Tablet"
    assert result["scope"] == "product"


def test_rxnorm_outage_preserves_original_text(monkeypatch):
    client_type = httpx.AsyncClient

    def fail(request):
        raise httpx.ConnectError("Unavailable", request=request)

    monkeypatch.setattr(normalization.httpx, "AsyncClient", lambda **kwargs: client_type(
        **kwargs, transport=httpx.MockTransport(fail)))
    result = asyncio.run(normalization.normalize_medication("Zoloft 100mg"))
    assert result["status"] == "unavailable"
    assert result["name"] == "Zoloft 100mg"


def test_micrograms_match_equivalent_component_without_changing_original(monkeypatch):
    routes = component_routes([dict(COMPONENT, name="sertraline 0.1 MG [Zoloft]")])
    routes[key("rxcui.json", name="Zoloft 100mcg", search="2")] = routes.pop(key("rxcui.json", name="Zoloft 100mg", search="2"))
    routes[key("rxcui/568875/related.json", tty="SCDC")] = group("SCDC", [dict(GENERIC, name="sertraline 0.1 MG")])
    result, _ = lookup(monkeypatch, routes, "Zoloft 100mcg")
    assert result["status"] == "verified"
    assert result["original"] == "Zoloft 100mcg"
    assert result["name"] == "sertraline 0.1 MG"


def test_milligrams_never_match_the_same_number_in_micrograms(monkeypatch):
    routes = component_routes([dict(COMPONENT, name="sertraline 100 MCG [Zoloft]")])
    result, _ = lookup(monkeypatch, routes, "Zoloft 100mg")
    assert result["status"] == "unverified"
