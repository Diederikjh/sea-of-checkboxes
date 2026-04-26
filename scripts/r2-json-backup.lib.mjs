import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

export const R2_JSON_BACKUP_FORMAT = "sea-of-checkboxes.r2-json-backup.v1";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const S3_SERVICE = "s3";
const R2_REGION = "auto";

const HTTP_METADATA_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-type",
  "expires",
];

export function parseDotenvText(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

export function loadR2BackupEnvFromDotenv({
  cwd = process.cwd(),
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
} = {}) {
  const envPath = path.join(cwd, ".env.local");
  if (!existsSync(envPath)) {
    return {};
  }
  return parseDotenvText(readFileSync(envPath, "utf8"));
}

export function printR2JsonBackupHelp() {
  return `Usage:
  pnpm r2:backup -- --bucket <bucket> --output <backup.json> [--prefix <key-prefix>]
  pnpm r2:restore -- --bucket <bucket> --input <backup.json> --yes [--prefix <key-prefix>]

Commands:
  backup     Copy every matching R2 object into one JSON backup file.
  restore    Recreate objects from a JSON backup file. Existing keys are overwritten.

Required credentials:
  R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID
  R2_ACCESS_KEY_ID or CLOUDFLARE_R2_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY or CLOUDFLARE_R2_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY

Options:
  --bucket <name>              R2 bucket name.
  --output <path>              Backup JSON path for backup.
  --input <path>               Backup JSON path for restore.
  --prefix <key-prefix>        Only back up or restore keys with this prefix.
  --account-id <id>            Cloudflare account ID.
  --access-key-id <id>         R2 S3 access key ID.
  --secret-access-key <secret> R2 S3 secret access key.
  --endpoint <url>             Override S3 endpoint.
  --dry-run                    For restore, read the backup and report what would be written.
  --yes                        Required for restore writes.
  --help                       Show this help.
`;
}

export function parseR2JsonBackupArgs(argv, { env = process.env } = {}) {
  const [rawCommand, ...rawRest] = argv;
  const command = rawCommand === "--help" || rawCommand === "-h" ? "" : rawCommand;
  const rest = rawCommand === "--help" || rawCommand === "-h" ? [rawCommand, ...rawRest] : rawRest;
  const options = {
    command,
    bucket: "",
    input: "",
    output: "",
    prefix: "",
    endpoint: "",
    accountId: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    dryRun: false,
    yes: false,
    help: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    const nextValue = () => {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    if (arg === "--bucket") {
      options.bucket = nextValue();
    } else if (arg === "--input") {
      options.input = nextValue();
    } else if (arg === "--output") {
      options.output = nextValue();
    } else if (arg === "--prefix") {
      options.prefix = nextValue();
    } else if (arg === "--endpoint") {
      options.endpoint = nextValue();
    } else if (arg === "--account-id") {
      options.accountId = nextValue();
    } else if (arg === "--access-key-id") {
      options.accessKeyId = nextValue();
    } else if (arg === "--secret-access-key") {
      options.secretAccessKey = nextValue();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.accountId ||= env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "";
  options.accessKeyId ||=
    env.R2_ACCESS_KEY_ID || env.CLOUDFLARE_R2_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || "";
  options.secretAccessKey ||=
    env.R2_SECRET_ACCESS_KEY ||
    env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ||
    env.AWS_SECRET_ACCESS_KEY ||
    "";
  options.sessionToken ||= env.R2_SESSION_TOKEN || env.AWS_SESSION_TOKEN || "";
  options.endpoint ||= env.R2_ENDPOINT || "";

  if (!options.endpoint && options.accountId) {
    options.endpoint = `https://${options.accountId}.r2.cloudflarestorage.com`;
  }

  return options;
}

export function normalizeR2SecretAccessKey(value) {
  return value.startsWith("cfat_") ? sha256Hex(value) : value;
}

export async function resolveR2RuntimeCredentials(options, { fetchImpl = fetch } = {}) {
  if (options.command === "restore" && options.dryRun) {
    return options;
  }
  if (!options.secretAccessKey.startsWith("cfat_")) {
    return options;
  }
  if (!options.accountId) {
    throw new Error("Missing R2_ACCOUNT_ID; required when using a raw cfat_ R2 API token.");
  }

  const permission = options.command === "restore" ? "object-read-write" : "object-read-only";
  const body = {
    bucket: options.bucket,
    parentAccessKeyId: options.accessKeyId,
    permission,
    ttlSeconds: 3600,
    ...(options.prefix ? { prefixes: [options.prefix] } : {}),
  };
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/r2/temp-access-credentials`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.secretAccessKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const errors = Array.isArray(payload?.errors) ? JSON.stringify(payload.errors) : "Unknown error";
    throw new Error(`R2 temporary credential creation failed (${response.status}): ${errors}`);
  }

  const result = payload?.result ?? {};
  if (!result.accessKeyId || !result.secretAccessKey || !result.sessionToken) {
    throw new Error("R2 temporary credential creation did not return accessKeyId, secretAccessKey, and sessionToken.");
  }

  return {
    ...options,
    accessKeyId: result.accessKeyId,
    secretAccessKey: result.secretAccessKey,
    sessionToken: result.sessionToken,
  };
}

export function validateR2JsonBackupOptions(options) {
  if (options.help) {
    return;
  }
  if (options.command !== "backup" && options.command !== "restore") {
    throw new Error("Expected command to be 'backup' or 'restore'.");
  }
  if (!options.bucket) {
    throw new Error("Missing --bucket.");
  }
  const needsR2Access = options.command === "backup" || !options.dryRun;
  if (needsR2Access) {
    for (const [key, label] of [
      ["endpoint", "--endpoint or R2_ACCOUNT_ID"],
      ["accessKeyId", "--access-key-id or R2_ACCESS_KEY_ID"],
      ["secretAccessKey", "--secret-access-key or R2_SECRET_ACCESS_KEY"],
    ]) {
      if (!options[key]) {
        throw new Error(`Missing ${label}.`);
      }
    }
  }
  if (options.command === "backup" && !options.output) {
    throw new Error("Missing --output for backup.");
  }
  if (options.command === "restore" && !options.input) {
    throw new Error("Missing --input for restore.");
  }
  if (options.command === "restore" && !options.dryRun && !options.yes) {
    throw new Error("Restore overwrites existing keys. Pass --yes to write, or --dry-run to inspect.");
  }
}

export function parseListObjectsV2Xml(xml) {
  const objects = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    const rawKey = decodeXmlEntities(readXmlTag(block, "Key") ?? "");
    const key = safeDecodeURIComponent(rawKey);
    objects.push({
      key,
      lastModified: decodeXmlEntities(readXmlTag(block, "LastModified") ?? ""),
      etag: decodeXmlEntities(readXmlTag(block, "ETag") ?? "").replace(/^"|"$/g, ""),
      size: Number.parseInt(readXmlTag(block, "Size") ?? "0", 10),
      storageClass: decodeXmlEntities(readXmlTag(block, "StorageClass") ?? ""),
    });
  }

  return {
    objects,
    isTruncated: decodeXmlEntities(readXmlTag(xml, "IsTruncated") ?? "") === "true",
    nextContinuationToken: decodeXmlEntities(readXmlTag(xml, "NextContinuationToken") ?? ""),
  };
}

function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1] ?? null;
}

function decodeXmlEntities(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function collectObjectHeaders(headers) {
  const httpMetadata = {};
  const customMetadata = {};

  for (const name of HTTP_METADATA_HEADERS) {
    const value = headers.get(name);
    if (value) {
      httpMetadata[name] = value;
    }
  }

  for (const [name, value] of headers.entries()) {
    if (name.startsWith("x-amz-meta-")) {
      customMetadata[name.slice("x-amz-meta-".length)] = value;
    }
  }

  return { httpMetadata, customMetadata };
}

export async function backupR2ToJson(options, { fetchImpl = fetch, log = console.error } = {}) {
  const outputDir = path.dirname(options.output);
  if (outputDir && outputDir !== ".") {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const stream = fs.createWriteStream(options.output, { encoding: "utf8" });
  let first = true;
  let count = 0;
  let totalBytes = 0;

  try {
    await writeText(stream, "{\n");
    await writeJsonField(stream, "format", R2_JSON_BACKUP_FORMAT, true);
    await writeJsonField(stream, "createdAt", new Date().toISOString());
    await writeJsonField(stream, "bucket", options.bucket);
    await writeJsonField(stream, "prefix", options.prefix);
    await writeText(stream, ',\n  "objects": [\n');

    for await (const listedObject of listR2Objects(options, { fetchImpl })) {
      const object = await getR2Object(options, listedObject.key, { fetchImpl });
      const body = Buffer.from(await object.arrayBuffer());
      const { httpMetadata, customMetadata } = collectObjectHeaders(object.headers);
      const entry = {
        key: listedObject.key,
        size: body.byteLength,
        listedSize: listedObject.size,
        etag: listedObject.etag,
        lastModified: listedObject.lastModified,
        storageClass: listedObject.storageClass || undefined,
        httpMetadata,
        customMetadata,
        bodyEncoding: "base64",
        body: body.toString("base64"),
      };

      await writeText(stream, `${first ? "" : ",\n"}    ${JSON.stringify(entry)}`);
      first = false;
      count += 1;
      totalBytes += body.byteLength;
      if (count % 100 === 0) {
        log(`Backed up ${count} objects (${totalBytes} bytes)`);
      }
    }

    await writeText(stream, "\n  ]\n}\n");
  } finally {
    await closeWritable(stream);
  }

  return { count, totalBytes, output: options.output };
}

export async function restoreR2FromJson(options, { fetchImpl = fetch, log = console.error } = {}) {
  let count = 0;
  let skipped = 0;
  let totalBytes = 0;

  await readBackupObjects(options.input, async (entry) => {
    if (options.prefix && !entry.key.startsWith(options.prefix)) {
      skipped += 1;
      return;
    }
    if (entry.bodyEncoding !== "base64" || typeof entry.body !== "string") {
      throw new Error(`Unsupported body encoding for ${entry.key}`);
    }
    const body = Buffer.from(entry.body, "base64");
    if (!options.dryRun) {
      await putR2Object(options, entry.key, body, entry, { fetchImpl });
    }
    count += 1;
    totalBytes += body.byteLength;
    if (count % 100 === 0) {
      log(`${options.dryRun ? "Checked" : "Restored"} ${count} objects (${totalBytes} bytes)`);
    }
  });

  return { count, skipped, totalBytes, dryRun: options.dryRun };
}

export async function* listR2Objects(options, { fetchImpl = fetch } = {}) {
  let continuationToken = "";
  do {
    const query = {
      "list-type": "2",
      "encoding-type": "url",
      ...(options.prefix ? { prefix: options.prefix } : {}),
      ...(continuationToken ? { "continuation-token": continuationToken } : {}),
    };
    const response = await signedR2Fetch(options, {
      method: "GET",
      key: "",
      query,
      fetchImpl,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`R2 list failed (${response.status}): ${text}`);
    }
    const page = parseListObjectsV2Xml(text);
    for (const object of page.objects) {
      yield object;
    }
    continuationToken = page.isTruncated ? page.nextContinuationToken : "";
  } while (continuationToken);
}

async function getR2Object(options, key, { fetchImpl }) {
  const response = await signedR2Fetch(options, {
    method: "GET",
    key,
    fetchImpl,
  });
  if (!response.ok) {
    throw new Error(`R2 get failed for ${key} (${response.status}): ${await response.text()}`);
  }
  return response;
}

async function putR2Object(options, key, body, entry, { fetchImpl }) {
  const headers = {};
  for (const name of HTTP_METADATA_HEADERS) {
    const value = entry.httpMetadata?.[name];
    if (value) {
      headers[name] = value;
    }
  }
  for (const [name, value] of Object.entries(entry.customMetadata ?? {})) {
    if (typeof value === "string" && value.length > 0) {
      headers[`x-amz-meta-${name}`] = value;
    }
  }

  const response = await signedR2Fetch(options, {
    method: "PUT",
    key,
    headers,
    body,
    fetchImpl,
  });
  if (!response.ok) {
    throw new Error(`R2 put failed for ${key} (${response.status}): ${await response.text()}`);
  }
}

export async function signedR2Fetch(options, request) {
  const body = request.body ?? Buffer.alloc(0);
  const payloadHash = request.body ? sha256Hex(body) : EMPTY_SHA256;
  const url = buildR2Url(options, request.key, request.query ?? {});
  const signedHeaders = signS3Request({
    method: request.method,
    url,
    headers: {
      ...(request.headers ?? {}),
      "x-amz-content-sha256": payloadHash,
      ...(options.sessionToken ? { "x-amz-security-token": options.sessionToken } : {}),
    },
    payloadHash,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
  });

  return request.fetchImpl(url, {
    method: request.method,
    headers: signedHeaders,
    ...(request.body ? { body: request.body } : {}),
  });
}

export function buildR2Url(options, key, query = {}) {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const keyPath = key ? `/${encodeS3Path(key)}` : "";
  const url = new URL(`${endpoint}/${encodeURIComponent(options.bucket)}${keyPath}`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== "") {
      url.searchParams.set(name, value);
    }
  }
  return url;
}

export function signS3Request({
  method,
  url,
  headers,
  payloadHash,
  accessKeyId,
  secretAccessKey,
  now = new Date(),
}) {
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const allHeaders = new Headers(headers);
  allHeaders.set("x-amz-date", amzDate);

  const canonicalHeaders = new Map();
  canonicalHeaders.set("host", url.host);
  for (const [name, value] of allHeaders.entries()) {
    canonicalHeaders.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }

  const signedHeaderNames = [...canonicalHeaders.keys()].sort();
  const canonicalHeadersText = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaders.get(name)}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQueryString(url.searchParams),
    canonicalHeadersText,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${R2_REGION}/${S3_SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, R2_REGION, S3_SERVICE);
  const signature = hmacHex(signingKey, stringToSign);

  allHeaders.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
  return allHeaders;
}

function canonicalQueryString(searchParams) {
  return [...searchParams.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
    )
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

function encodeS3Path(value) {
  return value.split("/").map(encodeRfc3986).join("/");
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function writeJsonField(stream, key, value, first = false) {
  await writeText(stream, `${first ? "" : ",\n"}  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
}

function writeText(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function closeWritable(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function readBackupObjects(input, onObject) {
  const stream = input instanceof fs.ReadStream ? input : fs.createReadStream(input, { encoding: "utf8" });
  let mode = "search";
  let searchBuffer = "";
  let objectText = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectCount = 0;

  const processText = async (text) => {
    for (const char of text) {
      if (mode === "between") {
        if (/\s|,/.test(char)) {
          continue;
        }
        if (char === "]") {
          mode = "done";
          continue;
        }
        if (char !== "{") {
          throw new Error("Invalid backup JSON: expected object in objects array.");
        }
        mode = "object";
        objectText = "{";
        depth = 1;
        inString = false;
        escaped = false;
        continue;
      }

      if (mode !== "object") {
        continue;
      }

      objectText += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const entry = JSON.parse(objectText);
          if (!entry || typeof entry.key !== "string") {
            throw new Error("Invalid backup JSON: object entry is missing key.");
          }
          objectCount += 1;
          await onObject(entry);
          mode = "between";
          objectText = "";
        }
      }
    }
  };

  for await (const chunk of stream) {
    if (mode === "search") {
      searchBuffer += chunk;
      const match = /"objects"\s*:\s*\[/.exec(searchBuffer);
      if (!match) {
        searchBuffer = searchBuffer.slice(-128);
        continue;
      }
      mode = "between";
      await processText(searchBuffer.slice(match.index + match[0].length));
      searchBuffer = "";
    } else if (mode !== "done") {
      await processText(chunk);
    }
  }

  if (mode === "search") {
    throw new Error("Invalid backup JSON: missing objects array.");
  }
  if (mode === "object") {
    throw new Error("Invalid backup JSON: unterminated object entry.");
  }
  return { objectCount };
}

export function isWritableStream(value) {
  return value instanceof Writable;
}
