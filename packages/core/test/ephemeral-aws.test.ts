// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (c) 2026 Petter André Sjulstad
import { describe, expect, it } from "vitest";
import {
  ALLOWED_HOSTS,
  awsSign,
  ephemeralAdapter,
  parseAwsToken,
  parseXml,
  xmlChild,
  xmlChildren,
  xmlFind,
  type EphemeralMachine,
  type ExecFn,
  type ExecRequest,
} from "../src/index.js";

// --- parseAwsToken -----------------------------------------------------------

describe("parseAwsToken", () => {
  it("parses accessKeyId:secretAccessKey", () => {
    expect(parseAwsToken("AKIDEXAMPLE:secret123")).toEqual({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret123",
      sessionToken: undefined,
    });
  });

  it("parses an optional trailing session token, tolerating embedded colons", () => {
    expect(parseAwsToken("AKIDEXAMPLE:secret123:sess:ion:token")).toEqual({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret123",
      sessionToken: "sess:ion:token",
    });
  });

  it("rejects a missing secret", () => {
    expect(() => parseAwsToken("AKIDEXAMPLE")).toThrow(/accessKeyId:secretAccessKey/);
  });

  it("rejects an empty token", () => {
    expect(() => parseAwsToken("")).toThrow(/accessKeyId:secretAccessKey/);
  });
});

// --- awsSign — verified against AWS's own published SigV4 test vectors ------
// https://github.com/aws/aws-sig-v4-test-suite (get-vanilla / post-vanilla),
// using AWS's standard example credentials.

const SIGV4_CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

describe("awsSign (SigV4)", () => {
  it("matches AWS's get-vanilla test vector", async () => {
    const headers = await awsSign({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      region: "us-east-1",
      service: "service",
      headers: {},
      body: "",
      creds: SIGV4_CREDS,
      amzDate: "20150830T123600Z",
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(headers.host).toBe("example.amazonaws.com");
    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  it("matches AWS's post-vanilla test vector", async () => {
    const headers = await awsSign({
      method: "POST",
      host: "example.amazonaws.com",
      path: "/",
      region: "us-east-1",
      service: "service",
      headers: {},
      body: "",
      creds: SIGV4_CREDS,
      amzDate: "20150830T123600Z",
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  it("signs the security token header when a session token is present", async () => {
    const headers = await awsSign({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      region: "us-east-1",
      service: "service",
      headers: {},
      body: "",
      creds: { ...SIGV4_CREDS, sessionToken: "AQoDYXdz" },
      amzDate: "20150830T123600Z",
    });
    expect(headers["x-amz-security-token"]).toBe("AQoDYXdz");
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });

  it("produces the EC2-shaped SignedHeaders set for a content-typed POST", async () => {
    const headers = await awsSign({
      method: "POST",
      host: "ec2.us-east-1.amazonaws.com",
      path: "/",
      region: "us-east-1",
      service: "ec2",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "Action=DescribeInstances&Version=2016-11-15",
      creds: SIGV4_CREDS,
      amzDate: "20260101T000000Z",
    });
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/ec2\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });
});

// --- parseXml — just enough for EC2's response shape -------------------------

describe("parseXml", () => {
  it("parses nested elements, self-closing tags, and item lists", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
        <requestId>abc-123</requestId>
        <groupSet/>
        <instancesSet>
          <item>
            <instanceId>i-0123456789abcdef0</instanceId>
            <instanceState><code>0</code><name>pending</name></instanceState>
          </item>
          <item>
            <instanceId>i-0fedcba9876543210</instanceId>
            <instanceState><code>16</code><name>running</name></instanceState>
          </item>
        </instancesSet>
      </RunInstancesResponse>`;
    const root = parseXml(xml);
    expect(root.tag).toBe("RunInstancesResponse");
    expect(xmlChild(root, "requestId")?.text).toBe("abc-123");
    expect(xmlChild(root, "groupSet")?.children).toEqual([]);
    const items = xmlChildren(xmlChild(root, "instancesSet"), "item");
    expect(items).toHaveLength(2);
    expect(xmlChild(items[0], "instanceId")?.text).toBe("i-0123456789abcdef0");
    expect(xmlChild(xmlChild(items[1], "instanceState"), "name")?.text).toBe("running");
    // Depth-first find locates a tag anywhere below the root, regardless of nesting.
    expect(xmlFind(root, "name")?.text).toBe("pending");
  });

  it("decodes entities and trims whitespace-only text", () => {
    const root = parseXml("<Message>invalid &amp; unexpected &lt;value&gt; &quot;here&quot;</Message>");
    expect(root.text).toBe(`invalid & unexpected <value> "here"`);
  });

  it("ignores comments and attributes", () => {
    const root = parseXml(`<a x="1" y='2'><!-- comment --><b>ok</b></a>`);
    expect(xmlChild(root, "b")?.text).toBe("ok");
  });
});

// --- the `aws` ProviderAdapter, end to end against a fake exec ---------------

const AMI_ID = "ami-0abcdef1234567890";
const INSTANCE_ID = "i-0123456789abcdef0";

const RUN_INSTANCES_XML = `<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-1</requestId>
  <instancesSet>
    <item>
      <instanceId>${INSTANCE_ID}</instanceId>
      <imageId>${AMI_ID}</imageId>
      <instanceState><code>0</code><name>pending</name></instanceState>
      <ipAddress>203.0.113.5</ipAddress>
      <instanceType>t3.medium</instanceType>
    </item>
  </instancesSet>
</RunInstancesResponse>`;

const DESCRIBE_INSTANCES_RUNNING_XML = `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-2</requestId>
  <reservationSet>
    <item>
      <instancesSet>
        <item>
          <instanceId>${INSTANCE_ID}</instanceId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <ipAddress>203.0.113.5</ipAddress>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>`;

const DESCRIBE_INSTANCES_EMPTY_XML = `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-3</requestId>
  <reservationSet/>
</DescribeInstancesResponse>`;

const TERMINATE_INSTANCES_XML = `<TerminateInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-4</requestId>
  <instancesSet>
    <item>
      <instanceId>${INSTANCE_ID}</instanceId>
      <currentState><code>32</code><name>shutting-down</name></currentState>
      <previousState><code>16</code><name>running</name></previousState>
    </item>
  </instancesSet>
</TerminateInstancesResponse>`;

const NOT_FOUND_XML = `<Response>
  <Errors>
    <Error>
      <Code>InvalidInstanceID.NotFound</Code>
      <Message>The instance ID '${INSTANCE_ID}' does not exist</Message>
    </Error>
  </Errors>
  <RequestID>req-err</RequestID>
</Response>`;

const OTHER_ERROR_XML = `<Response>
  <Errors>
    <Error>
      <Code>UnauthorizedOperation</Code>
      <Message>You are not authorized to perform this operation.</Message>
    </Error>
  </Errors>
  <RequestID>req-err-2</RequestID>
</Response>`;

const DESCRIBE_INSTANCE_TYPES_XML = `<DescribeInstanceTypesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>req-5</requestId>
  <instanceTypeSet>
    <item>
      <instanceType>t3.micro</instanceType>
      <vCpuInfo><defaultVCpus>2</defaultVCpus></vCpuInfo>
      <memoryInfo><sizeInMiB>1024</sizeInMiB></memoryInfo>
    </item>
    <item>
      <instanceType>t3.medium</instanceType>
      <vCpuInfo><defaultVCpus>2</defaultVCpus></vCpuInfo>
      <memoryInfo><sizeInMiB>4096</sizeInMiB></memoryInfo>
    </item>
  </instanceTypeSet>
</DescribeInstanceTypesResponse>`;

function fakeAwsExec(opts: { describeInstances?: string; statusCode?: number } = {}): { exec: ExecFn; calls: ExecRequest[] } {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (request) => {
    calls.push(request);
    const host = new URL(request.url).host;
    if (host.startsWith("ssm.")) {
      return { status: 200, body: { Parameter: { Value: AMI_ID } } };
    }
    const body = String(request.body ?? "");
    if (body.includes("Action=RunInstances")) return { status: 200, body: RUN_INSTANCES_XML };
    if (body.includes("Action=DescribeInstances")) {
      return { status: opts.statusCode ?? 200, body: opts.describeInstances ?? DESCRIBE_INSTANCES_RUNNING_XML };
    }
    if (body.includes("Action=TerminateInstances")) {
      return { status: opts.statusCode ?? 200, body: opts.statusCode ? NOT_FOUND_XML : TERMINATE_INSTANCES_XML };
    }
    if (body.includes("Action=DescribeInstanceTypes")) return { status: 200, body: DESCRIBE_INSTANCE_TYPES_XML };
    return { status: 400, body: OTHER_ERROR_XML };
  };
  return { exec, calls };
}

const TOKEN = "AKIDEXAMPLE:wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

describe("aws ProviderAdapter", () => {
  it("is registered in the catalog and allowlists its EC2/SSM hosts", () => {
    const adapter = ephemeralAdapter("aws");
    expect(adapter).toBeTruthy();
    expect(adapter!.regions.map((r) => r.id)).toContain(adapter!.defaultRegion);
    for (const r of adapter!.regions) {
      expect(ALLOWED_HOSTS).toContain(`ec2.${r.id}.amazonaws.com`);
      expect(ALLOWED_HOSTS).toContain(`ssm.${r.id}.amazonaws.com`);
    }
  });

  it("provisions an instance: resolves the AMI via SSM, then calls RunInstances signed for EC2", async () => {
    const { exec, calls } = fakeAwsExec();
    const adapter = ephemeralAdapter("aws")!;
    const machine = await adapter.provision({
      exec,
      token: TOKEN,
      config: { slug: "abc123", region: "us-east-1", size: "t3.medium", ttlMinutes: 60 },
      userData: "#cloud-config\nruncmd: []\n",
    });

    expect(machine).toMatchObject({
      id: INSTANCE_ID,
      provider: "aws",
      name: "bivy-abc123",
      region: "us-east-1",
      status: "starting", // "pending" maps to "starting"
      ip: "203.0.113.5",
      ttlMinutes: 60,
    });

    const ssmCall = calls.find((c) => new URL(c.url).host === "ssm.us-east-1.amazonaws.com");
    expect(ssmCall).toBeTruthy();
    expect(ssmCall!.headers?.["x-amz-target"]).toBe("AmazonSSM.GetParameter");
    expect(JSON.parse(String(ssmCall!.body))).toEqual({
      Name: "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
    });
    expect(ssmCall!.headers?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ssm\/aws4_request/);

    const runCall = calls.find((c) => String(c.body ?? "").includes("Action=RunInstances"));
    expect(runCall).toBeTruthy();
    expect(runCall!.url).toBe("https://ec2.us-east-1.amazonaws.com/");
    const params = new URLSearchParams(String(runCall!.body));
    expect(params.get("ImageId")).toBe(AMI_ID);
    expect(params.get("InstanceType")).toBe("t3.medium");
    expect(params.get("InstanceInitiatedShutdownBehavior")).toBe("terminate");
    expect(params.get("TagSpecification.1.Tag.1.Key")).toBe("Name");
    expect(params.get("TagSpecification.1.Tag.2.Value")).toBe("ephemeral");
    // UserData must be base64-encoded, not sent as raw cloud-config text.
    const userData = params.get("UserData")!;
    expect(userData).not.toContain("#cloud-config");
    expect(Buffer.from(userData, "base64").toString("utf8")).toContain("#cloud-config");
    expect(runCall!.headers?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ec2\/aws4_request/);
  });

  it("reports status from DescribeInstances", async () => {
    const { exec } = fakeAwsExec();
    const adapter = ephemeralAdapter("aws")!;
    const machine: EphemeralMachine = {
      id: INSTANCE_ID,
      provider: "aws",
      name: "bivy-abc123",
      region: "us-east-1",
      status: "starting",
      ip: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const status = await adapter.status({ exec, token: TOKEN, machine });
    expect(status).toBe("running");
  });

  it("maps InvalidInstanceID.NotFound to 'gone' on status, and other errors throw", async () => {
    const adapter = ephemeralAdapter("aws")!;
    const machine: EphemeralMachine = {
      id: INSTANCE_ID,
      provider: "aws",
      name: "bivy-abc123",
      region: "us-east-1",
      status: "running",
      ip: "203.0.113.5",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const gone = fakeAwsExec({ describeInstances: NOT_FOUND_XML, statusCode: 400 });
    expect(await adapter.status({ exec: gone.exec, token: TOKEN, machine })).toBe("gone");

    const other = fakeAwsExec({ describeInstances: OTHER_ERROR_XML, statusCode: 400 });
    await expect(adapter.status({ exec: other.exec, token: TOKEN, machine })).rejects.toThrow(/UnauthorizedOperation/);
  });

  it("also treats an empty reservationSet (no matching instance) as 'gone'", async () => {
    const { exec } = fakeAwsExec({ describeInstances: DESCRIBE_INSTANCES_EMPTY_XML });
    const adapter = ephemeralAdapter("aws")!;
    const machine: EphemeralMachine = {
      id: INSTANCE_ID,
      provider: "aws",
      name: "bivy-abc123",
      region: "us-east-1",
      status: "running",
      ip: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await adapter.status({ exec, token: TOKEN, machine })).toBe("gone");
  });

  it("destroys via TerminateInstances, tolerating an already-gone instance", async () => {
    const adapter = ephemeralAdapter("aws")!;
    const machine: EphemeralMachine = {
      id: INSTANCE_ID,
      provider: "aws",
      name: "bivy-abc123",
      region: "us-east-1",
      status: "running",
      ip: "203.0.113.5",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const ok = fakeAwsExec();
    await expect(adapter.destroy({ exec: ok.exec, token: TOKEN, machine })).resolves.toBeUndefined();

    const alreadyGone = fakeAwsExec({ statusCode: 400 }); // maps TerminateInstances to NOT_FOUND_XML
    await expect(adapter.destroy({ exec: alreadyGone.exec, token: TOKEN, machine })).resolves.toBeUndefined();
  });

  it("lists live instance types via DescribeInstanceTypes, falling back to the static list on error", async () => {
    const adapter = ephemeralAdapter("aws")!;
    const { exec } = fakeAwsExec();
    const live = await adapter.listSizes!({ exec, token: TOKEN, region: "us-east-1" });
    expect(live.map((s) => s.id).sort()).toEqual(["t3.medium", "t3.micro"]);
    expect(live.find((s) => s.id === "t3.medium")?.label).toContain("4 GB");

    const failing: ExecFn = async () => {
      throw new Error("network down");
    };
    const fallback = await adapter.listSizes!({ exec: failing, token: TOKEN, region: "us-east-1" });
    expect(fallback).toEqual(adapter.sizes);
  });
});
