"""Real MCP over HTTPS, signed with the agent runtime's IAM role."""
import json
import os
import time
from contextlib import asynccontextmanager
from urllib.parse import quote
from uuid import uuid4
import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


class SigV4(httpx.Auth):
    requires_request_body = True

    def auth_flow(self, request):
        credentials = boto3.Session().get_credentials().get_frozen_credentials()
        aws = AWSRequest(method=request.method, url=str(request.url),
                         data=request.content, headers=dict(request.headers))
        SigV4Auth(credentials, "bedrock-agentcore", os.environ.get("AWS_REGION", "us-east-1")).add_auth(aws)
        request.headers.update(dict(aws.headers))
        yield request


@asynccontextmanager
async def connect_mcp():
    arn = os.environ["HOUSEMED_MCP_RUNTIME_ARN"]
    region = os.environ.get("AWS_REGION", "us-east-1")
    url = f"https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{quote(arn, safe='')}/invocations?qualifier=DEFAULT"
    async with streamablehttp_client(url, auth=SigV4(), timeout=60,
        headers={"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": str(uuid4())},
        terminate_on_close=False) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


class ToolCaller:
    def __init__(self, session):
        self.session = session
        self.trace = []

    async def call(self, name, **arguments):
        started = time.monotonic()
        result = await self.session.call_tool(name, arguments)
        self.trace.append({"tool": name, "status": "error" if result.isError else "ok",
                           "elapsed_ms": round((time.monotonic() - started) * 1000)})
        if result.isError:
            # Do not leak SQL, connection diagnostics, or exception bodies to callers.
            raise RuntimeError(f"mcp_{name}_failed")
        if result.structuredContent is not None:
            return result.structuredContent
        return json.loads(next(x.text for x in result.content if x.type == "text"))
