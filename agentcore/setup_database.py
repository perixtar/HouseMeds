"""Prepare a reviewed SQL setup and store the MCP credential in AWS after it is applied.

No administrator password is changed. The MCP login receives only intake-table privileges.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit, urlunsplit, quote
from uuid import uuid4
import boto3
import psycopg
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"


def prepare():
    CACHE.mkdir(exist_ok=True)
    path = CACHE / "database-setup.json"
    if path.exists():
        print("Database setup already prepared; use the existing private SQL file.")
        return
    config = dotenv_values(ROOT.parent / "backend/.env")
    original = urlsplit(config["READ_DATABASE_URL"])
    project = original.username.split(".", 1)[1]
    password = secrets.token_urlsafe(36)
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    server = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda x: base64.b64encode(x).decode()
    verifier = f"SCRAM-SHA-256$4096:{b64(salt)}${b64(hashlib.sha256(client).digest())}:{b64(server)}"
    url = urlunsplit((original.scheme, f"housemed_mcp.{project}:{quote(password)}@{original.hostname}:{original.port or 5432}", original.path, "", ""))
    household_id = str(uuid4())
    state = {"DATABASE_URL": url, "household_id": household_id, "project_ref": project}
    path.write_text(json.dumps(state)); path.chmod(0o600)
    migration = (ROOT.parent / "backend/supabase/migrations/20260912210000_prescription_intake.sql").read_text()
    migration += (ROOT.parent / "backend/supabase/migrations/20260912214500_prescription_photo_batches.sql").read_text()
    migration += (ROOT.parent / "backend/supabase/migrations/20260912220000_mcp_pricing_read.sql").read_text()
    sql = migration + f"""\n-- Dedicated service account and explicitly synthetic acceptance household.
alter role housemed_mcp password '{verifier}';
insert into housemed.households(id,name) values('{household_id}','HouseMeds test household');
insert into housemed.members(household_id,nickname) values('{household_id}','Grandma'),('{household_id}','Self');
insert into supabase_migrations.schema_migrations(version,name,statements)
 values('20260912210000','prescription_intake',array['Private HouseMeds intake schema; see repository migration'])
on conflict(version) do nothing;
insert into supabase_migrations.schema_migrations(version,name,statements)
 values('20260912214500','prescription_photo_batches',array['See repository migration']) on conflict(version) do nothing;
insert into supabase_migrations.schema_migrations(version,name,statements)
 values('20260912220000','mcp_pricing_read',array['Read-only pricing access for HouseMeds deals; see repository migration']) on conflict(version) do nothing;
select 'HouseMeds prescription schema ready' as status;
"""
    (CACHE / "database-setup.sql").write_text(sql)
    (CACHE / "database-setup.sql").chmod(0o600)
    print("Prepared private database-setup.sql. Password remains local; SQL contains only a SCRAM verifier.")


def finish(profile, region):
    config = json.loads((CACHE / "database-setup.json").read_text())
    with psycopg.connect(config["DATABASE_URL"], sslmode="verify-full", sslrootcert=str(ROOT / "supabase-ca.crt"), connect_timeout=20) as db:
        db.execute("select set_config('app.household_id', %s, true)", (config["household_id"],))
        count = db.execute("select count(*) from housemed.members").fetchone()[0]
        assert count == 2, "Expected the two synthetic household members"
    sm = boto3.Session(profile_name=profile, region_name=region).client("secretsmanager")
    secret = json.dumps({"DATABASE_URL": config["DATABASE_URL"]})
    try:
        sm.create_secret(Name="housemed/mcp-database", SecretString=secret, Description="Least-privilege HouseMeds prescription MCP database login")
    except sm.exceptions.ResourceExistsException:
        sm.put_secret_value(SecretId="housemed/mcp-database", SecretString=secret)
    deployment = json.loads((CACHE / "deployment.json").read_text())
    env = ROOT.parent / "backend/.env.agentcore"
    env.write_text(f"AWS_PROFILE={profile}\nAWS_REGION={region}\nHOUSEMED_AGENT_RUNTIME_ARN={deployment['agent_arn']}\nHOUSEMED_HOUSEHOLD_ID={config['household_id']}\nWEB_HOST=127.0.0.1\nWEB_PORT=63814\n")
    env.chmod(0o600)
    with env.open('a') as f:
        f.write('HOUSEMED_HOUSEHOLD_NAME="HouseMeds test household"\n')
    print("Verified Supabase role, saved its credential in AWS Secrets Manager, and configured the web adapter.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "finish"])
    parser.add_argument("--profile", default="sovyr-admin")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()
    prepare() if args.action == "prepare" else finish(args.profile, args.region)
