"""Real PostgreSQL boundary tests, using the repo's isolated test cluster."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4
import psycopg
from psycopg import sql
import pytest
from repository import Repository
from models import Fields

ROOT = Path(__file__).resolve().parents[2]
SOCKET = ROOT / "backend/.cache/pgsock"
ADMIN = f"host={SOCKET} port=65431 dbname=postgres"


@pytest.fixture(scope="module")
def database():
    name = "housemed_intake_" + uuid4().hex[:10]
    with psycopg.connect(ADMIN, autocommit=True) as db:
        for role in ["anon", "authenticated"]:
            if not db.execute("select 1 from pg_roles where rolname=%s", (role,)).fetchone():
                db.execute(sql.SQL("create role {}").format(sql.Identifier(role)))
        db.execute(sql.SQL("create database {}").format(sql.Identifier(name)))
    admin = f"host={SOCKET} port=65431 dbname={name}"
    with psycopg.connect(admin) as db:
        db.execute((ROOT / "backend/supabase/migrations/20260912210000_prescription_intake.sql").read_text())
        db.execute((ROOT / "backend/supabase/migrations/20260912214500_prescription_photo_batches.sql").read_text())
        h1, h2, m1, m2 = [str(uuid4()) for _ in range(4)]
        db.execute("insert into housemed.households(id,name) values(%s,'Household one'),(%s,'Household two')", (h1,h2))
        db.execute("insert into housemed.members(id,household_id,nickname) values(%s,%s,'Grandma'),(%s,%s,'Someone else')", (m1,h1,m2,h2))
    yield Repository(admin + " user=housemed_mcp", ssl={}), h1, h2, m1, m2, admin
    with psycopg.connect(ADMIN, autocommit=True) as db:
        db.execute(sql.SQL("drop database {} with (force)").format(sql.Identifier(name)))


def test_tenant_scope_and_private_schema(database):
    repo,h1,h2,m1,m2,admin = database
    assert repo.list_members(h1) == [{"id":m1,"nickname":"Grandma"}]
    with psycopg.connect(admin + " user=housemed_mcp") as db:
        assert db.execute("select count(*) from housemed.members").fetchone()[0] == 0
        assert db.execute("select has_schema_privilege(current_user,'public','CREATE')").fetchone()[0] is False
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            db.execute("insert into housemed.households(name) values('not allowed')")


def test_cross_tenant_draft_and_member_are_rejected(database):
    repo,h1,h2,m1,m2,_ = database
    f = Fields(medication="Zoloft").model_dump()
    draft = repo.save_draft(h1,uuid4(),f,{})
    with pytest.raises(ValueError, match="draft_not_found"):
        repo.get_draft(h2,draft["id"])
    with pytest.raises(ValueError, match="member_not_found"):
        repo.create_prescription(h1,draft["id"],m2,f,{})
    assert repo.list_prescriptions(h1) == []


def test_duplicate_concurrent_saves_create_one_prescription(database):
    repo,h1,_,m1,_,_ = database
    f = Fields(medication="Zoloft",strength="100mg").model_dump()
    request_id = uuid4()
    d = repo.save_draft(h1,request_id,f,{})
    assert repo.save_draft(h1,request_id,f,{})["id"] == d["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        rows = list(pool.map(lambda _: repo.create_prescription(h1,d["id"],m1,f,{}),range(2)))
    assert rows[0]["id"] == rows[1]["id"]
    assert sorted(x["replayed"] for x in rows) == [False,True]
    with pytest.raises(ValueError, match="different_values"):
        repo.create_prescription(h1,d["id"],m1,Fields(medication="Other").model_dump(),{})


def test_photo_retry_keeps_original_batch_even_if_model_returns_different_fields(database):
    repo,h1,_,_,_,_=database
    request_id=uuid4()
    first=repo.save_drafts(h1,request_id,[Fields(medication="A").model_dump(),Fields(medication="B").model_dump()],{})
    retry=repo.save_drafts(h1,request_id,[Fields(medication="C").model_dump()],{})
    assert first==retry
