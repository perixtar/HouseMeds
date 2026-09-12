"""Invoke the deployed API with a synthetic message or an explicitly supplied photo.

Response bodies are private files, not terminal logs. No write happens without --confirm.
"""
import argparse
import base64
import json
from pathlib import Path
from uuid import uuid4
import boto3
from botocore.config import Config

ROOT=Path(__file__).resolve().parent


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--profile",default="sovyr-admin")
    parser.add_argument("--message",default="")
    parser.add_argument("--image",type=Path)
    parser.add_argument("--draft-id")
    parser.add_argument("--member-id")
    parser.add_argument("--confirm",action="store_true")
    parser.add_argument("--state",action="store_true")
    parser.add_argument("--request-id",default=str(uuid4()))
    parser.add_argument("--output",type=Path,default=ROOT/".cache/last-invocation.json")
    args=parser.parse_args()
    deployment=json.loads((ROOT/".cache/deployment.json").read_text())
    from dotenv import dotenv_values
    env=dotenv_values(ROOT.parent/"backend/.env.agentcore")
    payload={"action":"state" if args.state else "confirm" if args.confirm else "chat",
        "household_id":env["HOUSEMED_HOUSEHOLD_ID"],"request_id":args.request_id,"message":args.message}
    if args.draft_id:payload["draft_id"]=args.draft_id
    if args.member_id:payload["member_id"]=args.member_id
    if args.image:
        fmt={".jpg":"jpeg",".jpeg":"jpeg",".png":"png",".webp":"webp"}.get(args.image.suffix.lower())
        if not fmt:parser.error("Use JPEG, PNG or WebP for direct API tests; the web app converts HEIC in-browser.")
        payload["image"]={"format":fmt,"data":base64.b64encode(args.image.read_bytes()).decode()}
    client=boto3.Session(profile_name=args.profile,region_name=deployment["region"]).client("bedrock-agentcore",config=Config(read_timeout=150,retries={"max_attempts":1}))
    response=client.invoke_agent_runtime(agentRuntimeArn=deployment["agent_arn"],
        runtimeSessionId=str(uuid4()),qualifier="DEFAULT",contentType="application/json",accept="application/json",payload=json.dumps(payload).encode())
    result=json.loads(response["response"].read())
    result["aws_request_id"]=response["ResponseMetadata"]["RequestId"]
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2));args.output.chmod(0o600)
    print(json.dumps({"status":result["status"],"aws_request_id":result["aws_request_id"],"trace":result.get("trace"),"private_response":str(args.output)}))
    if result["status"]=="error":raise SystemExit(1)


if __name__=="__main__":main()
