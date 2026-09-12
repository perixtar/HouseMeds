"""Idempotent AWS provisioning. Uses the selected local AWS profile; never prints secrets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import zipfile
import boto3
from botocore.exceptions import ClientError
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
DEFAULT_MODEL = "us.amazon.nova-2-lite-v1:0"


def package():
    target = CACHE / "package"
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(["uv", "pip", "install", "--python-version", "3.13", "--python-platform", "aarch64-manylinux_2_28",
        "--only-binary", ":all:", "--target", str(target), "-r", str(ROOT / "requirements.txt")], check=True)
    archive = CACHE / "runtime.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for file in target.rglob("*"):
            if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc":
                z.write(file, file.relative_to(target))
        for name in ["agent.py", "models.py", "mcp_client.py", "mcp_server.py", "exa_research.py", "normalization.py", "repository.py", "supabase-ca.crt"]:
            z.write(ROOT / name, name)
    return archive


def deploy(profile, region, archive, model_id=DEFAULT_MODEL):
    session = boto3.Session(profile_name=profile, region_name=region)
    account = session.client("sts").get_caller_identity()["Account"]
    s3, iam, runtime = session.client("s3"), session.client("iam"), session.client("bedrock-agentcore-control")
    exa_secret_name = "housemed/exa-api-key"
    exa_key = dotenv_values(ROOT.parent / "backend/.env.agent").get("EXA_API_KEY")
    if exa_key:
        secretsmanager = session.client("secretsmanager")
        try:
            secretsmanager.create_secret(Name=exa_secret_name,
                SecretString=json.dumps({"EXA_API_KEY": exa_key}),
                Description="HouseMeds AgentCore Exa MCP research key")
        except secretsmanager.exceptions.ResourceExistsException:
            secretsmanager.put_secret_value(SecretId=exa_secret_name,
                SecretString=json.dumps({"EXA_API_KEY": exa_key}))
    bucket = f"housemed-agentcore-{account}-{region}"
    try:
        s3.head_bucket(Bucket=bucket, ExpectedBucketOwner=account)
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchBucket"):
            raise
        s3.create_bucket(Bucket=bucket, **({"CreateBucketConfiguration": {"LocationConstraint": region}} if region != "us-east-1" else {}))
    s3.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration={
        "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
    s3.put_bucket_encryption(Bucket=bucket, ServerSideEncryptionConfiguration={
        "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]})
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()[:16]
    key = f"housemed/{digest}.zip"
    s3.upload_file(str(archive), bucket, key, ExtraArgs={"ExpectedBucketOwner": account})
    existing = {}
    token = None
    while True:
        page = runtime.list_agent_runtimes(**({"nextToken": token} if token else {}))
        existing.update({x["agentRuntimeName"]: x for x in page["agentRuntimes"]})
        token = page.get("nextToken")
        if not token:
            break
    if model_id.startswith(("us.", "eu.", "apac.", "global.")):
        inference = session.client("bedrock").get_inference_profile(inferenceProfileIdentifier=model_id)
        model_resources = [inference["inferenceProfileArn"], *[m["modelArn"] for m in inference["models"]]]
    else:
        model_resources = [f"arn:aws:bedrock:{region}::foundation-model/{model_id}"]
    output = {"region": region, "bucket": bucket, "package_sha256": digest, "model_id": model_id}
    for kind in ["mcp", "agent"]:
        name, role_name = f"housemed_{kind}", f"HouseMedsAgentCore-{kind}"
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
            "Principal": {"Service": "bedrock-agentcore.amazonaws.com"}, "Action": "sts:AssumeRole",
            "Condition": {"StringEquals": {"aws:SourceAccount": account},
                "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{region}:{account}:*"}}}]}
        created = False
        try:
            role = iam.get_role(RoleName=role_name)["Role"]
        except iam.exceptions.NoSuchEntityException:
            role = iam.create_role(RoleName=role_name, AssumeRolePolicyDocument=json.dumps(trust),
                                   Description=f"HouseMeds {kind} runtime only")["Role"]
            created = True
        statements = [
            {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": f"arn:aws:s3:::{bucket}/housemed/*"},
            {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
             "Resource": f"arn:aws:logs:{region}:{account}:log-group:/aws/bedrock-agentcore/runtimes/housemed_*"}]
        env = {"AWS_REGION": region}
        if kind == "mcp":
            statements.append({"Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
                "Resource": f"arn:aws:secretsmanager:{region}:{account}:secret:housemed/mcp-database-*"})
            env["HOUSEMED_DATABASE_SECRET_ARN"] = "housemed/mcp-database"
        else:
            env.update(HOUSEMED_MCP_RUNTIME_ARN=output["mcp_arn"], HOUSEMED_MODEL_ID=model_id,
                       HOUSEMED_EXA_SECRET_ARN=exa_secret_name)
            statements.extend([
                {"Effect": "Allow", "Action": ["bedrock:InvokeModel"], "Resource": model_resources},
                {"Effect": "Allow", "Action": ["bedrock-agentcore:InvokeAgentRuntime"],
                 "Resource": [output["mcp_arn"], output["mcp_arn"] + "/runtime-endpoint/DEFAULT"]},
                {"Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
                 "Resource": f"arn:aws:secretsmanager:{region}:{account}:secret:{exa_secret_name}-*"}])
        iam.put_role_policy(RoleName=role_name, PolicyName="HouseMedsRuntime", PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": statements}))
        if created:
            time.sleep(10)
        config = {"agentRuntimeArtifact": {"codeConfiguration": {"code": {"s3": {"bucket": bucket, "prefix": key}},
            "runtime": "PYTHON_3_13", "entryPoint": ["mcp_server.py" if kind == "mcp" else "agent.py"]}},
            "roleArn": role["Arn"], "networkConfiguration": {"networkMode": "PUBLIC"},
            "protocolConfiguration": {"serverProtocol": "MCP" if kind == "mcp" else "HTTP"},
            "environmentVariables": env,
            "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 300, "maxLifetime": 1800}}
        if name in existing:
            response = runtime.update_agent_runtime(agentRuntimeId=existing[name]["agentRuntimeId"], **config)
        else:
            response = runtime.create_agent_runtime(agentRuntimeName=name, **config)
        output[kind + "_arn"] = response["agentRuntimeArn"]
        output[kind + "_id"] = response["agentRuntimeId"]
        print(json.dumps({"runtime": name, "status": response["status"], "arn": response["agentRuntimeArn"]}), flush=True)
        # Status is needed before the agent can be wired to its MCP target.
        for _ in range(60):
            status = runtime.get_agent_runtime(agentRuntimeId=response["agentRuntimeId"])
            if status["status"] in ("READY", "CREATE_FAILED", "UPDATE_FAILED"):
                break
            time.sleep(5)
        if status["status"] != "READY":
            raise RuntimeError(f"{name}: {status['status']}")
    CACHE.mkdir(exist_ok=True)
    (CACHE / "deployment.json").write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE", "sovyr-admin"))
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--reuse-package", action="store_true")
    parser.add_argument("--model-id", default=DEFAULT_MODEL)
    args = parser.parse_args()
    deploy(args.profile, args.region, CACHE / "runtime.zip" if args.reuse_package else package(), args.model_id)
