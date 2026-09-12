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
        db.execute((ROOT / "backend/supabase/migrations/20260912223000_member_creation.sql").read_text())
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


def test_member_creation_is_idempotent_and_case_insensitive(database):
    repo,h1,h2,_,_,_=database
    request_id=uuid4()
    with ThreadPoolExecutor(max_workers=2) as pool:
        rows=list(pool.map(lambda _: repo.create_member(h1,request_id,"  Mom  "),range(2)))
    assert rows[0]["id"]==rows[1]["id"]
    assert sorted(row["replayed"] for row in rows)==[False,True]
    assert repo.create_member(h1,uuid4(),"mom")["id"]==rows[0]["id"]
    assert repo.create_member(h2,request_id,"Mom")["id"]!=rows[0]["id"]
    with pytest.raises(ValueError,match="already_used"):
        repo.create_member(h1,request_id,"Dad")
    for nickname in ["   ","x"*81]:
        with pytest.raises(ValueError,match="invalid_member"):
            repo.create_member(h1,uuid4(),nickname)


def test_member_insert_cannot_escape_household_scope(database):
    repo,h1,h2,_,_,_=database
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with repo.transaction(h1) as (db,_):
            db.execute("insert into housemed.members(household_id,nickname) values(%s,'Cross tenant')",(h2,))


def test_new_browser_household_starts_empty_and_survives_repeat_initialization(database):
    repo,_,_,_,_,_=database
    household=str(uuid4())
    repo.ensure_household(household)
    assert repo.list_members(household)==[]
    member=repo.create_member(household,uuid4(),"Demo member")
    repo.ensure_household(household)
    assert repo.list_members(household)==[{"id":member["id"],"nickname":"Demo member"}]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with repo.transaction(household) as (db,_):
            db.execute("insert into housemed.households(id,name) values(%s,'Other household')",(uuid4(),))


def batch(repo, household):
    drafts = repo.save_drafts(household, uuid4(), [Fields(medication="A").model_dump(), Fields(medication="B").model_dump()], {})
    return drafts, [{"draft_id": d["id"], "fields": d["fields"], "normalization": {}} for d in drafts]


def test_batch_saves_are_atomic_and_concurrent_retries_do_not_duplicate(database):
    repo,h1,_,m1,_,_ = database
    drafts, entries = batch(repo, h1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: repo.create_prescriptions(h1, drafts[0]["id"], m1, entries), range(2)))
    assert {r["id"] for r in responses[0]} == {r["id"] for r in responses[1]}
    assert sum(not r["replayed"] for response in responses for r in response) == 2
    assert repo.get_draft(h1, drafts[0]["id"])["batch"] == []
    assert repo.create_prescriptions(h1, drafts[0]["id"], m1, []) == []


def test_batch_rolls_back_earlier_insert_if_later_draft_conflicts(database):
    repo,h1,_,m1,_,_ = database
    drafts, entries = batch(repo, h1)
    different = Fields(medication="Edited B").model_dump()
    repo.create_prescription(h1, drafts[1]["id"], m1, different, {})
    with pytest.raises(ValueError, match="different_values"):
        repo.create_prescriptions(h1, drafts[0]["id"], m1, entries)
    # The first insert was rolled back, even though its fields were valid.
    assert [d["id"] for d in repo.get_draft(h1, drafts[0]["id"])["batch"]] == [drafts[0]["id"]]


def test_batch_rejects_foreign_members_unrelated_drafts_and_missing_items(database):
    repo,h1,h2,m1,m2,_ = database
    drafts, entries = batch(repo, h1)
    foreign, _ = batch(repo, h2)
    with pytest.raises(ValueError, match="member_not_found"):
        repo.create_prescriptions(h1, drafts[0]["id"], m2, entries)
    with pytest.raises(ValueError, match="draft_not_found"):
        repo.create_prescriptions(h2, drafts[0]["id"], m2, entries)
    with pytest.raises(ValueError, match="draft_not_in_batch"):
        repo.create_prescriptions(h1, drafts[0]["id"], m1, [*entries, {**entries[0], "draft_id": foreign[0]["id"]}])
    with pytest.raises(ValueError, match="incomplete_batch"):
        repo.create_prescriptions(h1, drafts[0]["id"], m1, entries[:1])
    assert len(repo.get_draft(h1, drafts[0]["id"])["batch"]) == 2


def test_batch_preserves_reviewed_edits(database):
    repo,h1,_,m1,_,_ = database
    drafts, entries = batch(repo, h1)
    entries[0]["fields"]["strength"] = "75 mcg"
    rows = repo.create_prescriptions(h1, drafts[0]["id"], m1, entries)
    assert rows[0]["fields"]["strength"] == "75 mcg"
