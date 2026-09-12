"""RxNorm identity lookup, never a recommendation to substitute medicines."""
import re
from decimal import Decimal
import httpx


async def get_json(client, endpoint, **params):
    response = await client.get(endpoint, params=params)
    response.raise_for_status()
    return response.json()


async def exact_concept(client, name):
    result = await get_json(client, "rxcui.json", name=name, search="2")
    ids = result.get("idGroup", {}).get("rxnormId", []) or []
    if len(ids) != 1 or not re.fullmatch(r"\d+", ids[0]):
        return None
    return (await get_json(client, f"rxcui/{ids[0]}/properties.json")).get("properties")


async def related(client, rxcui, tty):
    result = await get_json(client, f"rxcui/{rxcui}/related.json", tty=tty)
    return [p for g in result.get("relatedGroup", {}).get("conceptGroup", []) or []
            for p in g.get("conceptProperties", []) or [] if p.get("tty") == tty]


MASS = r"(?P<amount>(?:\d+(?:\.\d+)?|\.\d+))\s*(?P<unit>mcg|mg|g)"


def milligrams(match):
    return Decimal(match["amount"]) * {"mcg": Decimal(".001"), "mg": 1, "g": 1000}[match["unit"].lower()]


async def exact_component(client, medication):
    # A missing form can resolve to an ingredient+strength concept, never an inferred product.
    # Restrict this fallback to a single named ingredient/brand and a single mass strength.
    query = re.fullmatch(r"(?P<name>[A-Za-z][A-Za-z -]*?)\s+" + MASS, medication.strip(), re.I)
    if not query:
        return None
    concept = await exact_concept(client, query["name"])
    if not concept or concept.get("tty") not in ("BN", "IN"):
        return None
    tty = "SBDC" if concept["tty"] == "BN" else "SCDC"
    matches = []
    for candidate in await related(client, concept["rxcui"], tty):
        strength = re.fullmatch(r"[^0-9/\[\]]+\s+" + MASS + r"(?:\s+\[[^\]]+\])?", candidate["name"], re.I)
        if strength and milligrams(strength) == milligrams(query):
            matches.append(candidate)
    return matches[0] if len(matches) == 1 else None


async def normalize_medication(medication: str) -> dict:
    if not 1 <= len(medication) <= 260:
        raise ValueError("invalid_medication")
    original = {"original": medication, "name": medication, "status": "unverified", "source": "RxNorm"}
    # search=2 is exact plus normalized spelling matching, not approximate matching.
    async with httpx.AsyncClient(base_url="https://rxnav.nlm.nih.gov/REST/", timeout=15) as client:
        try:
            product = await exact_concept(client, medication)
            if not product:
                product = await exact_component(client, medication)
            if not product or product.get("tty") not in ("SCD", "SBD", "SCDC", "SBDC"):
                return original
            rxcui = product["rxcui"]
            if product["tty"] in ("SBD", "SBDC"):
                generics = await related(client, rxcui, "SCD" if product["tty"] == "SBD" else "SCDC")
                if len(generics) != 1:
                    return original
                product = generics[0]
            return dict(original, name=product["name"], rxcui=product["rxcui"],
                        scope="ingredient_strength" if product["tty"] == "SCDC" else "product",
                        matched_rxcui=rxcui, status="verified", url=f"https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm={product['rxcui']}")
        except (httpx.HTTPError, KeyError, ValueError):
            return dict(original, status="unavailable")
