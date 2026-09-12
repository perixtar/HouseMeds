"""Deploy a shared HTTPS API. Tokens stay in ignored local env files and Lambda env.

Run npm run prescriptions:bundle in backend first. This API role may only invoke
the existing AgentCore agent; it cannot read the MCP database secret.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import time
import zipfile
import boto3
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
FUNCTION = "housemed-prescription-api"
ROLE = "HouseMedsPrescriptionApi"


def private_env(file, values):
    previous = dict(dotenv_values(file)) if file.exists() else {}
    previous.update(values)
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(file, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write("\n".join(f"{key}={json.dumps(value)}" for key, value in previous.items() if value is not None) + "\n")


def deploy(profile, region, configure_frontend):
    env = {**dotenv_values(ROOT / "backend/.env.agentcore"), **dotenv_values(ROOT / "backend/.env.prescriptions")}
    arn, household = env["HOUSEMED_AGENT_RUNTIME_ARN"], env["HOUSEMED_HOUSEHOLD_ID"]
    token = env.get("HOUSEMED_PRESCRIPTION_API_TOKEN") or secrets.token_urlsafe(48)
    if len(token) < 32:
        raise ValueError("API token must have at least 32 characters")
    local_env = {"AWS_REGION": region, "AWS_PROFILE": profile, "HOUSEMED_AGENT_RUNTIME_ARN": arn,
                 "HOUSEMED_HOUSEHOLD_ID": household, "HOUSEMED_HOUSEHOLD_NAME": env.get("HOUSEMED_HOUSEHOLD_NAME", "Your household"),
                 "HOUSEMED_PRESCRIPTION_API_TOKEN": token}
    # Persist before provisioning so interrupted/retried deployments reuse the same token.
    private_env(ROOT / "backend/.env.prescriptions", local_env)
    session = boto3.Session(profile_name=profile, region_name=region)
    account = session.client("sts").get_caller_identity()["Account"]
    iam, api, logs = session.client("iam"), session.client("lambda"), session.client("logs")
    try:
        role = iam.get_role(RoleName=ROLE)["Role"]
    except iam.exceptions.NoSuchEntityException:
        role = iam.create_role(RoleName=ROLE, AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]}))["Role"]
        time.sleep(10)
    group = f"/aws/lambda/{FUNCTION}"
    try:
        logs.create_log_group(logGroupName=group)
    except logs.exceptions.ResourceAlreadyExistsException:
        pass
    logs.put_retention_policy(logGroupName=group, retentionInDays=7)
    iam.put_role_policy(RoleName=ROLE, PolicyName="InvokeHouseMedsOnly", PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["bedrock-agentcore:InvokeAgentRuntime"], "Resource": [arn, arn + "/runtime-endpoint/DEFAULT"]},
        {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"], "Resource": f"arn:aws:logs:{region}:{account}:log-group:{group}:*"}]}))
    bundle = ROOT / "backend/.cache/prescription-lambda/index.cjs"
    archive = bundle.with_suffix(".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        package.write(bundle, "index.cjs")
    runtime_env = {key: value for key, value in local_env.items() if key not in ("AWS_REGION", "AWS_PROFILE")}
    configuration = {"Role": role["Arn"], "Runtime": "nodejs24.x", "Handler": "index.handler",
                     "Timeout": 150, "MemorySize": 512, "Environment": {"Variables": runtime_env}}
    try:
        api.get_function(FunctionName=FUNCTION)
    except api.exceptions.ResourceNotFoundException:
        api.create_function(FunctionName=FUNCTION, Code={"ZipFile": archive.read_bytes()}, Architectures=["arm64"], **configuration)
        api.get_waiter("function_active_v2").wait(FunctionName=FUNCTION)
    else:
        api.update_function_code(FunctionName=FUNCTION, ZipFile=archive.read_bytes())
        api.get_waiter("function_updated_v2").wait(FunctionName=FUNCTION)
        api.update_function_configuration(FunctionName=FUNCTION, **configuration)
        api.get_waiter("function_updated_v2").wait(FunctionName=FUNCTION)
    try:
        url = api.get_function_url_config(FunctionName=FUNCTION)["FunctionUrl"]
    except api.exceptions.ResourceNotFoundException:
        # Authentication is the API's bearer token. Fastify supplies CORS headers,
        # avoiding duplicate CORS headers from Lambda's optional CORS layer.
        url = api.create_function_url_config(FunctionName=FUNCTION, AuthType="NONE")["FunctionUrl"]
    for statement in [
        {"StatementId": "HouseMedsPublicUrl", "Action": "lambda:InvokeFunctionUrl", "FunctionUrlAuthType": "NONE"},
        {"StatementId": "HouseMedsPublicUrlInvokeOnly", "Action": "lambda:InvokeFunction", "InvokedViaFunctionUrl": True},
    ]:
        try:
            api.add_permission(FunctionName=FUNCTION, Principal="*", **statement)
        except api.exceptions.ResourceConflictException:
            pass
    result = {"api_url": url.rstrip('/'), "region": region, "function_name": FUNCTION, "agent_runtime_arn": arn,
              "authentication": "Bearer token", "cors_allowed_origins": "*"}
    (ROOT / "backend/config/prescription-api.json").write_text(json.dumps(result, indent=2) + "\n")
    (ROOT / "frontend/shared-api.js").write_text("// Shared AWS API; no credentials are stored here.\nexport const sharedApiUrl = " + json.dumps(result["api_url"]) + ";\n")
    if configure_frontend:
        private_env(ROOT / "frontend/.env", {"VITE_API_BASE_URL": result["api_url"], "VITE_API_TOKEN": token})
    print(json.dumps(result, indent=2))
    print("API token saved only in backend/.env.prescriptions. Share it privately with authorized teammates.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=os.environ.get("AWS_PROFILE", "sovyr-admin"))
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--configure-local-frontend", action="store_true")
    args = parser.parse_args()
    deploy(args.profile, args.region, args.configure_local_frontend)
