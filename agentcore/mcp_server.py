"""IAM-protected HouseMeds MCP server, deployed as a separate AgentCore runtime."""
from uuid import UUID
from mcp.server.fastmcp import FastMCP
from repository import Repository
from normalization import normalize_medication as normalize

mcp = FastMCP("HouseMeds", host="0.0.0.0", port=8000, stateless_http=True, json_response=True)
repo = Repository()


@mcp.tool()
def list_members(household_id: UUID) -> dict:
    """List member IDs and nicknames in the authenticated backend's household."""
    return {"members": repo.list_members(household_id)}


@mcp.tool()
async def normalize_medication(medication: str) -> dict:
    """Resolve an exact medication and strength to an RxNorm generic identity."""
    return await normalize(medication)


@mcp.tool()
def list_prescriptions(household_id: UUID) -> dict:
    """Read saved prescriptions for one authorized household."""
    return {"prescriptions": repo.list_prescriptions(household_id)}


@mcp.tool()
def list_price_offers(household_id: UUID) -> dict:
    """Read fresh verified pricing offers for saved prescriptions in one household."""
    return {"offers": repo.list_price_offers(household_id)}


@mcp.tool()
def save_draft(household_id: UUID, request_id: UUID, fields: dict, normalization: dict) -> dict:
    """Persist extracted fields for review. This does not create a prescription."""
    return repo.save_draft(household_id, request_id, fields, normalization)


@mcp.tool()
def save_drafts(household_id: UUID, request_id: UUID, prescriptions: list[dict], normalization: dict) -> dict:
    """Atomically save all medicines from one photo as review drafts; retries reuse the original extraction."""
    return {"drafts":repo.save_drafts(household_id,request_id,prescriptions,normalization)}


@mcp.tool()
def get_draft(household_id: UUID, draft_id: UUID) -> dict:
    """Restore a draft for a later review turn, including after runtime expiry."""
    return repo.get_draft(household_id, draft_id)


@mcp.tool()
async def create_prescription(household_id: UUID, draft_id: UUID, member_id: UUID, fields: dict) -> dict:
    """Save explicitly reviewed fields for an explicitly selected household member, once per draft."""
    from models import Fields
    reviewed = Fields.model_validate(fields)
    normalization = await normalize(f"{reviewed.medication} {reviewed.strength} {reviewed.form}".strip())
    return repo.create_prescription(household_id, draft_id, member_id, reviewed.model_dump(), normalization)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
