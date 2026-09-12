"""Validated contracts shared by the runtime and MCP boundary."""
import base64
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator


class Fields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    medication: str = Field(min_length=1, max_length=160)
    strength: str = Field(default="", max_length=80)
    form: str = Field(default="", max_length=80)
    directions: str = Field(default="", max_length=500)
    quantity: str = Field(default="", max_length=60)
    prescriber: str = Field(default="", max_length=160)
    pharmacy: str = Field(default="", max_length=160)
    refills: str = Field(default="", max_length=60)
    warnings: list[str] = Field(default_factory=list, max_length=10)


class Photo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["jpeg", "png", "webp"]
    data: str = Field(max_length=5_000_000)

    @field_validator("data")
    @classmethod
    def valid_base64(cls, value):
        raw = base64.b64decode(value, validate=True)
        if not raw or len(raw) > 3_750_000:
            raise ValueError("Photo must be at most 3.75 MB")
        return value


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["chat", "state", "confirm", "prepare"] = "chat"
    household_id: UUID
    request_id: UUID
    message: str = Field(default="", max_length=4000)
    image: Photo | None = None
    draft_id: UUID | None = None
    member_id: UUID | None = None
    fields: Fields | None = None
