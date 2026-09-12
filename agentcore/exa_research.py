"""Bounded, read-only Exa MCP discovery for additional pharmacy listings.

This is staging evidence for the deals UI, not a pharmacy quote or an order.
Only medicine identity fields are sent to Exa; household and patient data stay in
the private MCP database flow.
"""
import asyncio
import json
import os
import re
import time
from decimal import Decimal
from functools import lru_cache
from urllib.parse import urlsplit

import boto3
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa"
PHARMACIES = {
    "Amazon Pharmacy": "pharmacy.amazon.com",
    "Walmart Pharmacy": "walmart.com",
    "CVS Pharmacy": "cvs.com",
    "Walgreens": "walgreens.com",
}
MAX_MEDICINES = 4
_cache = {}
_CACHE_SECONDS = 3600
_RESULT = re.compile(r"Title:\s*(?P<title>[^\n]+)\s*\nURL:\s*(?P<url>https://[^\s]+)", re.I)
# Accept a cash price only when the fetched first-party text puts a physical
# quantity beside it. Most pharmacy pages do not, so null is expected.
_CASH_PRICE = re.compile(
    r"cash price\s*[:\-]?\s*\$([0-9,]+\.[0-9]{2})\s*(?:for|/)\s*"
    r"([0-9]+(?:\.[0-9]+)?)\s*(tablets?|capsules?|milliliters?|ml)\b", re.I)


@lru_cache(maxsize=1)
def exa_key():
    if os.environ.get("EXA_API_KEY"):
        return os.environ["EXA_API_KEY"]
    name = os.environ.get("HOUSEMED_EXA_SECRET_ARN")
    if not name:
        return None
    value = boto3.client("secretsmanager").get_secret_value(SecretId=name)["SecretString"]
    return json.loads(value)["EXA_API_KEY"]


def _first_party(url, domain):
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        return parts.scheme == "https" and not parts.username and not parts.password and not parts.port and (
            host == domain or host == "www." + domain)
    except ValueError:
        return False


def _content(result):
    if result.isError:
        raise RuntimeError("exa_tool_failed")
    return "\n".join(block.text for block in result.content if block.type == "text")


def _listing_from_search(content, domain, medicine, strength):
    compact = lambda value: re.sub(r"[^a-z0-9]", "", value.casefold())
    if not compact(medicine):
        return None
    for match in _RESULT.finditer(content):
        url = match.group("url").rstrip(".,)")
        title = match.group("title")
        if (_first_party(url, domain) and compact(medicine) in compact(title)
                and (not strength or compact(strength) in compact(title))):
            return {"listing_name": title[:300], "listing_url": url}
    return None


def _price_from_first_party(content):
    match = _CASH_PRICE.search(content)
    if not match:
        return None
    cents = int(Decimal(match.group(1).replace(",", "")) * 100)
    return {"price_cents": str(cents), "physical_quantity": match.group(2),
            "content_unit": match.group(3).lower().rstrip("s")}


async def _research_one(medicine, strength, form, key):
    candidates = []
    async with streamablehttp_client(EXA_MCP_URL, headers={"x-api-key": key}, timeout=20,
                                     terminate_on_close=False) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for pharmacy, domain in PHARMACIES.items():
                identity = re.sub(r"[^A-Za-z0-9 +/().-]", " ",
                                  " ".join(value for value in (medicine, strength, form) if value))[:240]
                result = await session.call_tool("web_search_exa", {
                    "query": f"site:{domain} {identity} prescription pharmacy product page cash price",
                    "objective": f"Find a first-party {pharmacy} listing for {identity}. Return its URL. "
                                 "Only cite a total cash price when the page explicitly shows its physical quantity. "
                                 "Exclude unrelated strengths, ads, and discount aggregators.",
                    "numResults": 2,
                })
                listing = _listing_from_search(_content(result), domain, medicine, strength)
                if listing:
                    candidates.append({"pharmacy": pharmacy, **listing})
            if candidates:
                fetched = await session.call_tool("web_fetch_exa", {
                    "urls": [item["listing_url"] for item in candidates], "maxCharacters": 5000})
                pages = [block.text for block in fetched.content if block.type == "text"] if not fetched.isError else []
            else:
                pages = []
    response = []
    for item in candidates:
        page = next((content for content in pages if content.count("URL:") == 1 and
                     re.search(r"^URL:\s*" + re.escape(item["listing_url"]) + r"\s*$", content, re.M)), "")
        price = _price_from_first_party(page) if page else None
        response.append({**item, "price_cents": price["price_cents"] if price else None,
                         "physical_quantity": price["physical_quantity"] if price else None,
                         "content_unit": price["content_unit"] if price else None,
                         "currency": "USD", "availability": "unknown",
                         "verification_status": "research_only", "observed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    return {"status": "complete", "candidates": response}


async def research_medicines(prescriptions):
    """Research at most four unique medicine identities; never send member data."""
    identities = {}
    for prescription in prescriptions:
        fields = prescription.get("fields") or {}
        medicine = str(fields.get("medication") or "").strip()[:160]
        strength = str(fields.get("strength") or "").strip()[:80]
        form = str(fields.get("form") or "").strip()[:80]
        if medicine:
            identities.setdefault((medicine.casefold(), strength.casefold(), form.casefold()),
                                  (medicine, strength, form))
    try:
        key = exa_key()
    except Exception:
        key = None
    results = {}
    semaphore = asyncio.Semaphore(2)

    async def run(identity, values):
        if not key:
            results[identity] = {"status": "not_configured", "candidates": []}
            return
        cached = _cache.get(identity)
        if cached and cached[0] > time.monotonic():
            results[identity] = cached[1]
            return
        async with semaphore:
            try:
                results[identity] = await asyncio.wait_for(_research_one(*values, key), timeout=45)
                _cache[identity] = (time.monotonic() + _CACHE_SECONDS, results[identity])
            except Exception:
                results[identity] = {"status": "unavailable", "candidates": []}
                _cache[identity] = (time.monotonic() + 300, results[identity])

    selected = list(identities.items())[:MAX_MEDICINES]
    await asyncio.gather(*(run(identity, values) for identity, values in selected))
    for identity in list(identities)[MAX_MEDICINES:]:
        results[identity] = {"status": "skipped_limit", "candidates": []}
    return results
