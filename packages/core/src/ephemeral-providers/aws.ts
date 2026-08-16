// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Petter André Sjulstad
// AWS EC2 provider interpreter, including SigV4 and Query XML values.
import { b64 } from "../base64.js";
import type { EphemeralMachine } from "../ephemeral-machine.js";
import type { ExecFn, ProviderAdapter, ProviderSize } from "../ephemeral-provider-ports.js";
import { call, extractProviderMessage, memoizeByKey, nowIso, utf8 } from "../ephemeral-provider-utils.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- AWS: SigV4 signing + a minimal EC2 Query/XML client -------------------
//
// AWS has no bearer-token API: every request is authenticated by deriving an
// HMAC-SHA256 signature from the caller's access key + secret key (SigV4).
// Unlike Fly/Hetzner, that means the *adapter itself* signs each request
// before handing it to the allowlisted ExecFn — the exec proxy stays a dumb
// forwarder either way; it just now receives a fully pre-signed request, so
// no other call site needs to know AWS auth even exists. Implemented with
// only Web Crypto (crypto.subtle) so @bivy/core keeps zero runtime
// dependencies, and verified against AWS's own published SigV4 test vectors
// (see test/ephemeral-aws.test.ts).
//
// EC2 itself only speaks the legacy "Query" protocol — form-encoded request,
// XML response — there is no JSON protocol for EC2 (that exists for some
// newer AWS APIs, but not this one), so a tiny dependency-free XML reader is
// included below. Systems Manager (used only to resolve the current Ubuntu
// AMI id) speaks AWS's JSON protocol instead, which is why `awsSsmGetParameter`
// looks different from `awsEc2Call`.

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** AWS needs two secrets, not one (plus an optional session token for STS
 *  credentials) — pasted as `accessKeyId:secretAccessKey[:sessionToken]`.
 *  The token field itself stays an opaque string as far as the shared
 *  store/UI are concerned (see `EphemeralKeyStore`), so this parsing lives
 *  entirely inside the adapter and no call site needs to change to support a
 *  multi-part credential. */
export function parseAwsToken(token: string): AwsCreds {
  const parts = String(token || "").split(":");
  const accessKeyId = (parts[0] || "").trim();
  const secretAccessKey = (parts[1] || "").trim();
  const sessionToken = parts.length > 2 ? parts.slice(2).join(":").trim() || undefined : undefined;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS token must be `accessKeyId:secretAccessKey` (optionally `:sessionToken`)");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}


function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? utf8.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8.encode(data)));
}

/** AWS's URI-encoding rule is RFC 3986 unreserved characters left bare and
 *  everything else percent-encoded with UPPERCASE hex. `encodeURIComponent`
 *  gets almost all of it right but leaves `! * ' ( )` unencoded, which SigV4
 *  requires encoded — AWS explicitly warns platform URI-encoders aren't safe
 *  to use as-is for this reason. */
function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function amzDateNow(): string {
  try {
    return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "19700101T000000Z";
  }
}

/**
 * Sign one AWS request (SigV4) and return the headers to send, including
 * `authorization`. Canonical query string is always empty here — every AWS
 * call this adapter makes is a POST with the request in the body, so there's
 * nothing to canonicalize there. Verified against AWS's published
 * `get-vanilla`/`post-vanilla` SigV4 test vectors in test/ephemeral-aws.test.ts.
 */
export async function awsSign(args: {
  method: string;
  host: string;
  path: string;
  region: string;
  service: string;
  headers: Record<string, string>;
  body: string;
  creds: AwsCreds;
  amzDate?: string;
}): Promise<Record<string, string>> {
  const amzDate = args.amzDate || amzDateNow();
  const dateStamp = amzDate.slice(0, 8);
  const toSign: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers)) toSign[k.toLowerCase()] = v;
  toSign.host = args.host;
  toSign["x-amz-date"] = amzDate;
  if (args.creds.sessionToken) toSign["x-amz-security-token"] = args.creds.sessionToken;

  const signedHeaderNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${String(toSign[k]).trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const payloadHash = await sha256Hex(args.body);
  const canonicalRequest = [args.method.toUpperCase(), args.path || "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${args.region}/${args.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmacSha256(utf8.encode(`AWS4${args.creds.secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, args.region);
  const kService = await hmacSha256(kRegion, args.service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return {
    ...toSign,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// --- tiny dependency-free XML reader (just enough for EC2 Query responses) -

export interface XmlEl {
  tag: string;
  children: XmlEl[];
  text: string;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Recursive-descent parse of a well-formed XML document into a plain tree.
 *  Handles nested elements, attributes (discarded — EC2 responses don't put
 *  data we need in them), self-closing tags, comments, and the `<?xml?>`
 *  prolog. This is not a general-purpose XML parser — just enough for AWS's
 *  Query-protocol response shape, to avoid a real XML dependency for the one
 *  provider that needs it. */
export function parseXml(xml: string): XmlEl {
  let i = 0;
  const n = xml.length;
  const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  function skipSpace() {
    while (i < n && isSpace(xml.charAt(i))) i++;
  }
  function skipMisc() {
    for (;;) {
      skipSpace();
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (xml.startsWith("<!", i)) {
        const end = xml.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        continue;
      }
      break;
    }
  }
  function readName(): string {
    const start = i;
    while (i < n && !isSpace(xml.charAt(i)) && xml.charAt(i) !== ">" && xml.charAt(i) !== "/" && xml.charAt(i) !== "=") i++;
    return xml.slice(start, i);
  }
  function skipAttrs() {
    for (;;) {
      skipSpace();
      if (i >= n || xml.charAt(i) === ">" || xml.charAt(i) === "/") return;
      readName(); // attribute name — discarded
      skipSpace();
      if (xml.charAt(i) === "=") {
        i++;
        skipSpace();
        const quote = xml.charAt(i);
        if (quote === '"' || quote === "'") {
          i++;
          const end = xml.indexOf(quote, i);
          i = end < 0 ? n : end + 1;
        } else {
          while (i < n && !isSpace(xml.charAt(i)) && xml.charAt(i) !== ">") i++;
        }
      }
    }
  }
  function parseElement(): XmlEl {
    i++; // '<'
    const tag = readName();
    skipAttrs();
    skipSpace();
    const el: XmlEl = { tag, children: [], text: "" };
    if (xml.charAt(i) === "/") {
      i += 2; // '/>'
      return el;
    }
    i++; // '>'
    let text = "";
    while (i < n) {
      if (xml.startsWith("</", i)) {
        const end = xml.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        break;
      }
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (xml.charAt(i) === "<") {
        el.children.push(parseElement());
        continue;
      }
      const start = i;
      while (i < n && xml.charAt(i) !== "<") i++;
      text += xml.slice(start, i);
    }
    el.text = decodeXmlEntities(text).trim();
    return el;
  }
  skipMisc();
  if (i >= n || xml.charAt(i) !== "<") return { tag: "", children: [], text: "" };
  return parseElement();
}

export function xmlChild(el: XmlEl | undefined, tag: string): XmlEl | undefined {
  return el?.children.find((c) => c.tag === tag);
}
export function xmlChildren(el: XmlEl | undefined, tag: string): XmlEl[] {
  return el ? el.children.filter((c) => c.tag === tag) : [];
}
/** Depth-first search for the first descendant with this tag, anywhere in the
 *  subtree — used to pull error codes/messages and single-instance fields out
 *  of AWS's responses without depending on their exact nesting depth. */
export function xmlFind(el: XmlEl | undefined, tag: string): XmlEl | undefined {
  if (!el) return undefined;
  if (el.tag === tag) return el;
  for (const c of el.children) {
    const hit = xmlFind(c, tag);
    if (hit) return hit;
  }
  return undefined;
}

function awsFormBody(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");
}

function ec2Host(region: string): string {
  return `ec2.${region}.amazonaws.com`;
}
function ssmHost(region: string): string {
  return `ssm.${region}.amazonaws.com`;
}

/** One signed EC2 Query-protocol call. Returns the parsed XML root and throws
 *  with the provider's own error code/message on failure. */
async function awsEc2Call(
  exec: ExecFn,
  creds: AwsCreds,
  region: string,
  action: string,
  params: Record<string, string | undefined>,
  actionLabel: string,
): Promise<XmlEl> {
  const host = ec2Host(region);
  const body = awsFormBody({ Action: action, Version: "2016-11-15", ...params });
  const headers = await awsSign({
    method: "POST",
    host,
    path: "/",
    region,
    service: "ec2",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
    creds,
  });
  const res = await call(exec, { method: "POST", url: `https://${host}/`, headers, body });
  const xml = typeof res.body === "string" && res.body.trim() ? parseXml(res.body) : { tag: "", children: [], text: "" };
  if (res.status >= 300) {
    const code = xmlFind(xml, "Code")?.text;
    const message = xmlFind(xml, "Message")?.text;
    throw new Error(`AWS failed to ${actionLabel} (HTTP ${res.status}${code ? `: ${code}` : ""}${message ? ` — ${message}` : ""})`);
  }
  return xml;
}

/** One signed SSM (JSON protocol) call — only used to resolve the current
 *  Ubuntu AMI id via a Canonical-published public parameter. */
async function awsSsmGetParameter(exec: ExecFn, creds: AwsCreds, region: string, name: string): Promise<string> {
  const host = ssmHost(region);
  const body = JSON.stringify({ Name: name });
  const headers = await awsSign({
    method: "POST",
    host,
    path: "/",
    region,
    service: "ssm",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameter" },
    body,
    creds,
  });
  const res = await call(exec, { method: "POST", url: `https://${host}/`, headers, body });
  if (res.status >= 300) {
    const msg = extractProviderMessage(res.body) || (res.body && typeof res.body === "object" ? String((res.body as any).__type ?? "") : "");
    throw new Error(`AWS failed to resolve the Ubuntu AMI (HTTP ${res.status}${msg ? `: ${msg}` : ""})`);
  }
  const value = res.body && typeof res.body === "object" ? (res.body as any)?.Parameter?.Value : undefined;
  if (!value) throw new Error("AWS SSM did not return an AMI id");
  return String(value);
}

// Canonical publishes the current Ubuntu 24.04 (Noble) amd64 AMI id per
// region as a public SSM parameter, so we always launch the latest image
// instead of a hardcoded id that eventually goes stale. Memoized per region
// (the value doesn't depend on which account looks it up) for the lifetime of
// the JS context, same pattern as Hetzner's server-type cache below.
const AWS_UBUNTU_AMI_PARAM = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";
const awsAmiCache = new Map<string, Promise<string>>();
function resolveUbuntuAmi(exec: ExecFn, creds: AwsCreds, region: string): Promise<string> {
  return memoizeByKey(awsAmiCache, region, () => awsSsmGetParameter(exec, creds, region, AWS_UBUNTU_AMI_PARAM));
}

function mapAwsStatus(name: string | undefined): string {
  switch (name) {
    case "running":
      return "running";
    case "pending":
      return "starting";
    case "stopping":
    case "stopped":
    case "shutting-down":
      return "stopped";
    case "terminated":
      return "gone";
    default:
      return "starting";
  }
}

const AWS_REGIONS = [
  { id: "us-east-1", label: "US East (N. Virginia)" },
  { id: "us-west-2", label: "US West (Oregon)" },
  { id: "eu-west-1", label: "Europe (Ireland)" },
  { id: "eu-central-1", label: "Europe (Frankfurt)" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { id: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
];

// Curated x86_64 choices rather than EC2's overwhelming native catalog. T3 is
// retained for economy profiles; current-generation M/R plans make large and
// memory-heavy agent work possible without adding another provider. Prices are
// indicative Linux on-demand rates in us-east-1 and vary by region.
const AWS_AGENT_ROOT_DISK_GIB = 40;
const awsSize = (id: string, label: string, vcpus: number, memoryGiB: number, pricePerHour: number): ProviderSize => ({
  id, label, vcpus, memoryMiB: memoryGiB * 1024, diskGiB: AWS_AGENT_ROOT_DISK_GIB,
  architecture: "x86_64", pricePerHour, priceSource: "indicative",
});
const AWS_SIZES: ProviderSize[] = [
  awsSize("t3.micro", "t3.micro · 2 vCPU · 1 GB", 2, 1, 0.0104),
  awsSize("t3.small", "t3.small · 2 vCPU · 2 GB", 2, 2, 0.0208),
  awsSize("t3.medium", "t3.medium · 2 vCPU · 4 GB", 2, 4, 0.0416),
  awsSize("t3.large", "t3.large · 2 vCPU · 8 GB", 2, 8, 0.0832),
  awsSize("t3.xlarge", "t3.xlarge · 4 vCPU · 16 GB", 4, 16, 0.1664),
  awsSize("t3.2xlarge", "t3.2xlarge · 8 vCPU · 32 GB", 8, 32, 0.3328),
  awsSize("m7i.xlarge", "m7i.xlarge · 4 vCPU · 16 GB", 4, 16, 0.2016),
  awsSize("m7i.2xlarge", "m7i.2xlarge · 8 vCPU · 32 GB", 8, 32, 0.4032),
  awsSize("r7i.2xlarge", "r7i.2xlarge · 8 vCPU · 64 GB", 8, 64, 0.5292),
  awsSize("r7i.4xlarge", "r7i.4xlarge · 16 vCPU · 128 GB", 16, 128, 1.0584),
];

export const awsProvider: ProviderAdapter = {
  id: "aws",
  name: "AWS EC2",
  currency: "USD",
  regions: AWS_REGIONS,
  defaultRegion: "us-east-1",
  sizes: AWS_SIZES,
  defaultSize: "m7i.xlarge",
  async validateToken({ exec, token, region }) {
    const creds = parseAwsToken(token);
    await awsEc2Call(exec, creds, region || awsProvider.defaultRegion, "DescribeInstances", { MaxResults: "5" }, "validate credential");
  },
  async listSizes({ exec, token, region }) {
    const creds = parseAwsToken(token);
    const reg = region || awsProvider.defaultRegion;
    const params: Record<string, string> = {};
    AWS_SIZES.forEach((s, idx) => {
      params[`InstanceType.${idx + 1}`] = s.id;
    });
    let xml: XmlEl;
    try {
      xml = await awsEc2Call(exec, creds, reg, "DescribeInstanceTypes", params, "list instance types");
    } catch {
      return AWS_SIZES; // best-effort — keep the static list rather than failing the picker
    }
    let offered: Set<string> | undefined;
    try {
      const offeringParams: Record<string, string> = { LocationType: "region" };
      AWS_SIZES.forEach((s, idx) => {
        offeringParams[`Filter.1.Value.${idx + 1}`] = s.id;
      });
      offeringParams["Filter.1.Name"] = "instance-type";
      const offerings = await awsEc2Call(exec, creds, reg, "DescribeInstanceTypeOfferings", offeringParams, "list instance offerings");
      offered = new Set(xmlChildren(xmlChild(offerings, "instanceTypeOfferingSet"), "item")
        .map((item) => xmlChild(item, "instanceType")?.text || "")
        .filter(Boolean));
    } catch {
      // Older least-privilege policies may not include this read-only action.
      // Keep the type definitions rather than breaking an existing profile;
      // launch still returns the provider's precise capacity/permission error.
    }
    const rows = xmlChildren(xmlChild(xml, "instanceTypeSet"), "item")
      .map((item): ProviderSize | null => {
        const id = xmlChild(item, "instanceType")?.text || "";
        const vcpus = xmlChild(xmlChild(item, "vCpuInfo"), "defaultVCpus")?.text;
        const memMib = xmlChild(xmlChild(item, "memoryInfo"), "sizeInMiB")?.text;
        const gb = memMib ? Math.round(Number(memMib) / 1024) : undefined;
        // EC2's DescribeInstanceTypes carries no pricing, so carry the static
        // indicative price across by instance-type id for the cost hint.
        const catalog = AWS_SIZES.find((s) => s.id === id);
        if (!id || (offered && !offered.has(id))) return null;
        return {
          ...catalog,
          id,
          label: `${id} · ${vcpus ?? "?"} vCPU · ${gb ?? "?"} GB`,
          vcpus: vcpus ? Number(vcpus) : catalog?.vcpus,
          memoryMiB: memMib ? Number(memMib) : catalog?.memoryMiB,
        };
      })
      .filter((r): r is ProviderSize => Boolean(r));
    return rows.length ? rows : AWS_SIZES;
  },
  async provision({ exec, token, config, userData }) {
    const creds = parseAwsToken(token);
    const region = config.region || awsProvider.defaultRegion;
    const name = `bivy-${config.slug}`;
    const amiId = config.image ? String(config.image) : await resolveUbuntuAmi(exec, creds, region);
    const xml = await awsEc2Call(
      exec,
      creds,
      region,
      "RunInstances",
      {
        ImageId: amiId,
        InstanceType: config.size || awsProvider.defaultSize,
        MinCount: "1",
        MaxCount: "1",
        UserData: b64(utf8.encode(userData)),
        InstanceInitiatedShutdownBehavior: "terminate",
        // Canonical's minimal root volume is too small for dependency caches,
        // browser installs and normal monorepo builds. gp3 is deleted with the
        // instance, preserving the ephemeral cost/lifecycle contract.
        "BlockDeviceMapping.1.DeviceName": "/dev/sda1",
        "BlockDeviceMapping.1.Ebs.VolumeSize": String(AWS_AGENT_ROOT_DISK_GIB),
        "BlockDeviceMapping.1.Ebs.VolumeType": "gp3",
        "BlockDeviceMapping.1.Ebs.DeleteOnTermination": "true",
        // EC2 makes RunInstances idempotent for this token. A retry after a
        // timeout returns the original instance rather than billing for another.
        ...(config.attemptId ? { ClientToken: String(config.attemptId) } : {}),
        "TagSpecification.1.ResourceType": "instance",
        "TagSpecification.1.Tag.1.Key": "Name",
        "TagSpecification.1.Tag.1.Value": name,
        "TagSpecification.1.Tag.2.Key": "bivy",
        "TagSpecification.1.Tag.2.Value": "ephemeral",
        ...(config.attemptId ? {
          "TagSpecification.1.Tag.3.Key": "bivy-attempt",
          "TagSpecification.1.Tag.3.Value": String(config.attemptId),
        } : {}),
        ...(config.ownershipTag ? {
          "TagSpecification.1.Tag.4.Key": "bivy-account",
          "TagSpecification.1.Tag.4.Value": String(config.ownershipTag),
        } : {}),
      },
      "launch instance",
    );
    const item = xmlChild(xmlChild(xml, "instancesSet"), "item");
    const instanceId = xmlChild(item, "instanceId")?.text;
    if (!instanceId) throw new Error("AWS did not return an instance id");
    const stateName = xmlChild(xmlChild(item, "instanceState"), "name")?.text;
    // A public IP is usually assigned immediately when launching into a
    // default VPC/subnet, but isn't guaranteed at RunInstances time — status()
    // picks it up on the next poll if it's missing here, same as Fly.
    const ip = xmlChild(item, "ipAddress")?.text || xmlFind(xmlChild(item, "networkInterfaceSet"), "publicIp")?.text || null;
    return {
      id: instanceId,
      provider: "aws",
      name,
      region,
      status: mapAwsStatus(stateName),
      ip: ip || null,
      createdAt: nowIso(),
      ttlMinutes: config.ttlMinutes,
    };
  },
  async status({ exec, token, machine }) {
    const creds = parseAwsToken(token);
    let xml: XmlEl;
    try {
      xml = await awsEc2Call(exec, creds, machine.region, "DescribeInstances", { "InstanceId.1": machine.id }, "get instance");
    } catch (err) {
      if (String((err as Error).message || "").includes("InvalidInstanceID.NotFound")) return "gone";
      throw err;
    }
    const item = xmlChild(xmlFind(xml, "instancesSet"), "item");
    if (!item) return "gone";
    return mapAwsStatus(xmlChild(xmlChild(item, "instanceState"), "name")?.text);
  },
  async destroy({ exec, token, machine }) {
    const creds = parseAwsToken(token);
    try {
      await awsEc2Call(exec, creds, machine.region, "TerminateInstances", { "InstanceId.1": machine.id }, "terminate instance");
    } catch (err) {
      if (!String((err as Error).message || "").includes("InvalidInstanceID.NotFound")) throw err;
    }
  },
  // EC2 has no cross-region "list by tag" call — a DescribeInstances Filter is
  // always scoped to the region it's sent to. Scanning the whole curated
  // region list keeps this correct even if an account's config region ever
  // changed; it's bounded (six regions) and this only runs on the slow,
  // infrequent orphan-sweep cadence, not the fast convergence loop. One
  // region failing (e.g. not opted into that region) is skipped, not fatal.
  async discover({ exec, token, ownershipTag }) {
    const creds = parseAwsToken(token);
    const found: EphemeralMachine[] = [];
    for (const region of AWS_REGIONS.map((r) => r.id)) {
      let xml: XmlEl;
      try {
        xml = await awsEc2Call(
          exec,
          creds,
          region,
          "DescribeInstances",
          {
            "Filter.1.Name": "tag:bivy-account",
            "Filter.1.Value.1": ownershipTag,
            "Filter.2.Name": "instance-state-name",
            "Filter.2.Value.1": "pending",
            "Filter.2.Value.2": "running",
            "Filter.2.Value.3": "stopping",
            "Filter.2.Value.4": "stopped",
          },
          "list instances",
        );
      } catch {
        continue;
      }
      for (const reservation of xmlChildren(xmlChild(xml, "reservationSet"), "item")) {
        for (const item of xmlChildren(xmlChild(reservation, "instancesSet"), "item")) {
          const instanceId = xmlChild(item, "instanceId")?.text;
          if (!instanceId) continue;
          const stateName = xmlChild(xmlChild(item, "instanceState"), "name")?.text;
          const attemptTag = xmlChildren(xmlChild(item, "tagSet"), "item").find((t) => xmlChild(t, "key")?.text === "bivy-attempt");
          found.push({
            id: instanceId,
            provider: "aws",
            name: instanceId,
            region,
            status: mapAwsStatus(stateName),
            ip: xmlChild(item, "ipAddress")?.text || null,
            createdAt: xmlChild(item, "launchTime")?.text || "",
            attemptId: attemptTag ? xmlChild(attemptTag, "value")?.text : undefined,
          });
        }
      }
    }
    return found;
  },
};
