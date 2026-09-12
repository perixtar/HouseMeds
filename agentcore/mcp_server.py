"""IAM-protected HouseMeds MCP server, deployed as a separate AgentCore runtime."""
import asyncio
from uuid import UUID
from mcp.server.fastmcp import FastMCP
from repository import Repository
from normalization import normalize_medication as normalize

mcp = FastMCP("HouseMeds", host="0.0.0.0", port=8000, stateless_http=True, json_response=True)
repo = Repository()


@mcp.tool()
def ensure_household(household_id: UUID) -> dict:
    """Initialize an empty household using the identity assigned by the trusted API."""
    return repo.ensure_household(household_id)


@mcp.tool()
def list_members(household_id: UUID) -> dict:
    """List member IDs and nicknames in the authenticated backend's household."""
    return {"members": repo.list_members(household_id)}


@mcp.tool()
def create_member(household_id: UUID, request_id: UUID, nickname: str) -> dict:
    """Add an explicitly named household member; retries and duplicate nicknames reuse the member."""
    return repo.create_member(household_id, request_id, nickname)


@mcp.tool()
async def normalize_medication(medication: str) -> dict:
    """Resolve an exact medication and strength to an RxNorm generic identity."""
    return await normalize(medication)


@mcp.tool()
def list_prescriptions(household_id: UUID) -> dict:
    """Read saved prescriptions for one authorized household."""
    return {"prescriptions": repo.list_prescriptions(household_id)}


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


@mcp.tool()
async def create_prescriptions(household_id: UUID, draft_id: UUID, member_id: UUID, reviewed_drafts: list[dict]) -> dict:
    """Save all remaining medicines from one photo for the user's selected member, atomically."""
    from models import ReviewedDraft
    edits = [ReviewedDraft.model_validate(d) for d in reviewed_drafts]
    if len(edits) > 40 or len({d.draft_id for d in edits}) != len(edits):
        raise ValueError("invalid_reviewed_drafts")
    root = repo.get_draft(household_id, draft_id)
    drafts = root.get("batch", [root])
    overrides = {str(d.draft_id): d.fields.model_dump() for d in edits}
    # A completed retry may have no remaining drafts. Never write an unrelated draft.
    if any(key not in {d["id"] for d in drafts} for key in overrides):
        if drafts:
            raise ValueError("draft_not_in_batch")
        return {"saved": repo.create_prescriptions(household_id, draft_id, member_id, [])}
    semaphore = asyncio.Semaphore(4)

    async def prepare(draft):
        fields = overrides.get(draft["id"], draft["fields"])
        async with semaphore:
            identity = await normalize(" ".join(fields[k] for k in ("medication", "strength", "form") if fields[k]))
        return {"draft_id": draft["id"], "fields": fields, "normalization": identity}

    entries = await asyncio.gather(*(prepare(draft) for draft in drafts))
    return {"saved": repo.create_prescriptions(household_id, draft_id, member_id, entries)}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
