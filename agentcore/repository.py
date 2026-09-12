"""The only runtime component with database credentials. All SQL is parameterized."""
import json
import os
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from uuid import UUID, uuid5
import boto3
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from models import Fields


@lru_cache(maxsize=1)
def database_url():
    if os.environ.get("HOUSEMED_DATABASE_SECRET_ARN"):
        value = boto3.client("secretsmanager").get_secret_value(
            SecretId=os.environ["HOUSEMED_DATABASE_SECRET_ARN"])["SecretString"]
        return json.loads(value)["DATABASE_URL"]
    return os.environ["DATABASE_URL"]


class Repository:
    def __init__(self, connection_string=None, ssl=None):
        self.connection_string = connection_string
        self.ssl = ssl

    @contextmanager
    def transaction(self, household_id):
        household = str(UUID(str(household_id)))
        ssl = self.ssl if self.ssl is not None else {
            "sslmode": "verify-full", "sslrootcert": str(Path(__file__).with_name("supabase-ca.crt"))}
        with psycopg.connect(self.connection_string or database_url(), row_factory=dict_row,
                            connect_timeout=15, **ssl) as db:
            db.execute("select set_config('app.household_id', %s, true)", (household,))
            db.execute("set local statement_timeout = '15s'")
            yield db, household

    def list_members(self, household_id):
        with self.transaction(household_id) as (db, household):
            return db.execute("select id::text, nickname from housemed.members where household_id=%s order by nickname", (household,)).fetchall()

    def list_prescriptions(self, household_id):
        with self.transaction(household_id) as (db, household):
            return db.execute("""select p.id::text, p.member_id::text, m.nickname, p.fields,
                p.normalization, p.confirmed_at::text from housemed.prescriptions p
                join housemed.members m on m.id=p.member_id and m.household_id=p.household_id
                where p.household_id=%s order by p.confirmed_at desc limit 100""", (household,)).fetchall()

    def list_price_offers(self, household_id):
        """Only fresh, verified, exact-strength cash observations for saved prescriptions.

        A missing/ambiguous identity is omitted rather than guessed. The UI can
        still show the prescription with an empty offer list.
        """
        with self.transaction(household_id) as (db, household):
            return db.execute("""select p.id::text as prescription_id, s.name as pharmacy,
                s.slug as source, l.url as listing_url, l.source_name as listing_name,
                o.price_cents::text, (o.quantity*l.content_quantity)::text as physical_quantity,
                l.content_unit, o.currency, o.program_key, o.location_key,
                o.last_checked_at::text as observed_at, o.availability
                from housemed.prescriptions p
                join pricing.medications m
                  on lower(btrim(m.name))=lower(btrim(p.fields->>'medication'))
                 and regexp_replace(lower(m.strength),'[[:space:]]','','g')=
                     regexp_replace(lower(p.fields->>'strength'),'[[:space:]]','','g')
                 and lower(btrim(m.form))=lower(btrim(p.fields->>'form'))
                 and not exists (select 1 from pricing.medications m2
                   where m2.id<>m.id and lower(btrim(m2.name))=lower(btrim(m.name))
                     and regexp_replace(lower(m2.strength),'[[:space:]]','','g')=
                         regexp_replace(lower(m.strength),'[[:space:]]','','g')
                     and lower(btrim(m2.form))=lower(btrim(m.form)))
                join pricing.listings l on l.medication_id=m.id and l.match_status='verified'
                 and l.content_quantity is not null and l.content_unit is not null
                join pricing.sources s on s.id=l.source_id and s.enabled
                join pricing.offers o on o.listing_id=l.id and o.active
                 and o.availability='in_stock' and o.price_cents is not null
                 and o.last_checked_at>=now()-interval '24 hours'
                 and (o.valid_until is null or o.valid_until>now())
                where p.household_id=%s and coalesce(p.fields->>'strength','')<>''
                 and coalesce(p.fields->>'form','')<>''
                order by p.confirmed_at desc, o.price_cents, o.id limit 500""",
                (household,)).fetchall()

    def save_draft(self, household_id, request_id, fields, normalization):
        fields = Fields.model_validate(fields).model_dump()
        with self.transaction(household_id) as (db, household):
            db.execute("""insert into housemed.drafts(household_id,request_id,fields,normalization)
                values(%s,%s,%s,%s) on conflict(household_id,request_id) do nothing""",
                (household, str(UUID(str(request_id))), Jsonb(fields), Jsonb(normalization)))
            return db.execute("select id::text,fields,normalization from housemed.drafts where household_id=%s and request_id=%s",
                              (household, str(request_id))).fetchone()

    def get_draft(self, household_id, draft_id):
        with self.transaction(household_id) as (db, household):
            row = db.execute("select id::text,fields,normalization,intake_id::text from housemed.drafts where household_id=%s and id=%s",
                             (household, str(UUID(str(draft_id))))).fetchone()
            if not row:
                raise ValueError("draft_not_found")
            intake_id=row.pop("intake_id")
            if intake_id:
                row["batch"]=db.execute("""select d.id::text,d.fields,d.normalization from housemed.drafts d
                    where d.household_id=%s and d.intake_id=%s and not exists(
                      select 1 from housemed.prescriptions p where p.household_id=d.household_id and p.draft_id=d.id)
                    order by d.intake_index""",(household,intake_id)).fetchall()
            return row

    def save_drafts(self, household_id, request_id, prescriptions, normalization):
        if not 1 <= len(prescriptions) <= 40:
            raise ValueError("invalid_prescription_count")
        fields = [Fields.model_validate(p).model_dump() for p in prescriptions]
        intake_id = UUID(str(request_id))
        with self.transaction(household_id) as (db, household):
            # One upload commits atomically, and concurrent/retried model responses reuse its first result.
            db.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))",(household+str(intake_id),))
            previous=db.execute("select id::text,fields,normalization from housemed.drafts where household_id=%s and intake_id=%s order by intake_index",
                                (household,intake_id)).fetchall()
            if previous:
                return previous
            drafts=[]
            for i,value in enumerate(fields):
                identity=normalization if i==0 else {"name":" ".join(value[k] for k in ("medication","strength","form") if value[k]),"status":"pending","source":"RxNorm"}
                drafts.append(db.execute("""insert into housemed.drafts(household_id,request_id,fields,normalization,intake_id,intake_index)
                    values(%s,%s,%s,%s,%s,%s) returning id::text,fields,normalization""",
                    (household,uuid5(intake_id,str(i)),Jsonb(value),Jsonb(identity),intake_id,i)).fetchone())
            return drafts

    def create_prescription(self, household_id, draft_id, member_id, fields, normalization):
        fields = Fields.model_validate(fields).model_dump()
        with self.transaction(household_id) as (db, household):
            draft = db.execute("select id from housemed.drafts where household_id=%s and id=%s for update",
                               (household, str(UUID(str(draft_id))))).fetchone()
            if not draft:
                raise ValueError("draft_not_found")
            member = db.execute("select id::text,nickname from housemed.members where household_id=%s and id=%s",
                                (household, str(UUID(str(member_id))))).fetchone()
            if not member:
                raise ValueError("member_not_found")
            previous = db.execute("select id::text,member_id::text,fields,normalization from housemed.prescriptions where household_id=%s and draft_id=%s",
                                  (household, str(draft_id))).fetchone()
            if previous:
                if previous["member_id"] != str(member_id) or previous["fields"] != fields:
                    raise ValueError("draft_already_saved_with_different_values")
                return dict(previous, nickname=member["nickname"], replayed=True)
            row = db.execute("""insert into housemed.prescriptions(household_id,member_id,draft_id,fields,normalization)
                values(%s,%s,%s,%s,%s) returning id::text,member_id::text,fields,normalization""",
                (household, str(member_id), str(draft_id), Jsonb(fields), Jsonb(normalization))).fetchone()
            return dict(row, nickname=member["nickname"], replayed=False)
