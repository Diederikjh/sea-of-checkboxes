import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  R2_JSON_BACKUP_FORMAT,
  backupR2ToJson,
  buildR2Url,
  normalizeR2SecretAccessKey,
  parseDotenvText,
  parseListObjectsV2Xml,
  parseR2JsonBackupArgs,
  readBackupObjects,
  resolveR2RuntimeCredentials,
  restoreR2FromJson,
  signS3Request,
} from "./r2-json-backup.lib.mjs";

describe("r2-json-backup lib", () => {
  it("parses credentials and defaults from env", () => {
    const options = parseR2JsonBackupArgs(
      ["backup", "--bucket", "sea-of-checkboxes-tiles", "--output", "backup.json"],
      {
        env: {
          R2_ACCOUNT_ID: "acc_123",
          R2_ACCESS_KEY_ID: "key_123",
          R2_SECRET_ACCESS_KEY: "secret_123",
        },
      }
    );

    expect(options).toMatchObject({
      command: "backup",
      bucket: "sea-of-checkboxes-tiles",
      output: "backup.json",
      endpoint: "https://acc_123.r2.cloudflarestorage.com",
      accessKeyId: "key_123",
      secretAccessKey: "secret_123",
    });
  });

  it("normalizes raw R2 cfat tokens into S3 secret access keys", () => {
    const token = "cfat_example_token";

    expect(normalizeR2SecretAccessKey(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizeR2SecretAccessKey("already-secret")).toBe("already-secret");
  });

  it("exchanges raw cfat tokens for temporary S3 credentials", async () => {
    const calls = [];
    const resolved = await resolveR2RuntimeCredentials(
      {
        command: "backup",
        accountId: "acc_123",
        bucket: "bucket",
        prefix: "tiles/v1/",
        accessKeyId: "parent_access",
        secretAccessKey: "cfat_parent_token",
      },
      {
        async fetchImpl(url, init) {
          calls.push({ url, init });
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                accessKeyId: "temp_access",
                secretAccessKey: "temp_secret",
                sessionToken: "temp_session",
              },
            }),
            { status: 200 }
          );
        },
      }
    );

    expect(resolved).toMatchObject({
      accessKeyId: "temp_access",
      secretAccessKey: "temp_secret",
      sessionToken: "temp_session",
    });
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc_123/r2/temp-access-credentials"
    );
    expect(JSON.parse(calls[0].init.body)).toEqual({
      bucket: "bucket",
      parentAccessKeyId: "parent_access",
      permission: "object-read-only",
      ttlSeconds: 3600,
      prefixes: ["tiles/v1/"],
    });
  });

  it("does not create temporary credentials for restore dry runs", async () => {
    const resolved = await resolveR2RuntimeCredentials(
      {
        command: "restore",
        bucket: "bucket",
        input: "backup.json",
        dryRun: true,
        secretAccessKey: "cfat_parent_token",
      },
      {
        async fetchImpl() {
          throw new Error("should not fetch");
        },
      }
    );

    expect(resolved).toMatchObject({
      command: "restore",
      dryRun: true,
      secretAccessKey: "cfat_parent_token",
    });
  });

  it("parses dotenv values used by the script", () => {
    expect(parseDotenvText(`
R2_ACCOUNT_ID=acc
R2_ACCESS_KEY_ID="key"
R2_SECRET_ACCESS_KEY='secret'
`)).toEqual({
      R2_ACCOUNT_ID: "acc",
      R2_ACCESS_KEY_ID: "key",
      R2_SECRET_ACCESS_KEY: "secret",
    });
  });

  it("parses ListObjectsV2 XML pages", () => {
    const page = parseListObjectsV2Xml(`
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <Contents>
    <Key>tiles%2Fv1%2Ftx%3D0%2Fty%3D0.json</Key>
    <LastModified>2026-04-26T10:00:00.000Z</LastModified>
    <ETag>&quot;abc&quot;</ETag>
    <Size>42</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <NextContinuationToken>next-token</NextContinuationToken>
</ListBucketResult>`);

    expect(page).toEqual({
      isTruncated: true,
      nextContinuationToken: "next-token",
      objects: [
        {
          key: "tiles/v1/tx=0/ty=0.json",
          lastModified: "2026-04-26T10:00:00.000Z",
          etag: "abc",
          size: 42,
          storageClass: "STANDARD",
        },
      ],
    });
  });

  it("builds R2 path-style URLs with encoded object keys", () => {
    const url = buildR2Url(
      {
        endpoint: "https://acc.r2.cloudflarestorage.com",
        bucket: "bucket",
      },
      "tiles/v1/tx=1/ty=hello world.json",
      { "list-type": "2" }
    );

    expect(url.toString()).toBe(
      "https://acc.r2.cloudflarestorage.com/bucket/tiles/v1/tx%3D1/ty%3Dhello%20world.json?list-type=2"
    );
  });

  it("signs requests with SigV4 authorization", () => {
    const headers = signS3Request({
      method: "GET",
      url: new URL("https://acc.r2.cloudflarestorage.com/bucket?list-type=2"),
      headers: { "x-amz-content-sha256": "hash" },
      payloadHash: "hash",
      accessKeyId: "access",
      secretAccessKey: "secret",
      now: new Date("2026-04-26T12:13:14.000Z"),
    });

    expect(headers.get("x-amz-date")).toBe("20260426T121314Z");
    expect(headers.get("Authorization")).toContain("Credential=access/20260426/auto/s3/aws4_request");
    expect(headers.get("Authorization")).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  it("streams object entries from the generated backup shape", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-json-backup-"));
    const input = path.join(dir, "backup.json");
    fs.writeFileSync(
      input,
      JSON.stringify({
        format: R2_JSON_BACKUP_FORMAT,
        createdAt: "2026-04-26T00:00:00.000Z",
        bucket: "bucket",
        objects: [
          { key: "a.json", bodyEncoding: "base64", body: Buffer.from("{}").toString("base64") },
          { key: "b.json", bodyEncoding: "base64", body: Buffer.from("[]").toString("base64") },
        ],
      }),
      "utf8"
    );

    const keys = [];
    const result = await readBackupObjects(input, async (entry) => {
      keys.push(entry.key);
    });

    expect(result.objectCount).toBe(2);
    expect(keys).toEqual(["a.json", "b.json"]);
  });

  it("backs up and restores object bodies and metadata through the R2 API shape", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2-json-backup-"));
    const output = path.join(dir, "backup.json");
    const baseOptions = {
      endpoint: "https://acc.r2.cloudflarestorage.com",
      bucket: "bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
      prefix: "tiles/",
    };
    const listedXml = `
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>tiles%2Fa.json</Key><Size>5</Size><ETag>&quot;etag-a&quot;</ETag></Contents>
</ListBucketResult>`;
    const fetchForBackup = async (url, init) => {
      if (init.method === "GET" && url.searchParams.get("list-type") === "2") {
        return new Response(listedXml, { status: 200 });
      }
      if (init.method === "GET" && url.pathname.endsWith("/tiles/a.json")) {
        return new Response("hello", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "x-amz-meta-origin": "unit-test",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    const backup = await backupR2ToJson(
      { ...baseOptions, command: "backup", output },
      { fetchImpl: fetchForBackup, log: () => {} }
    );
    expect(backup).toMatchObject({ count: 1, totalBytes: 5 });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      format: R2_JSON_BACKUP_FORMAT,
      bucket: "bucket",
      objects: [
        {
          key: "tiles/a.json",
          bodyEncoding: "base64",
          body: Buffer.from("hello").toString("base64"),
        },
      ],
    });

    const puts = [];
    const fetchForRestore = async (url, init) => {
      puts.push({
        pathname: url.pathname,
        body: Buffer.from(init.body).toString("utf8"),
        contentType: init.headers.get("content-type"),
        origin: init.headers.get("x-amz-meta-origin"),
      });
      return new Response("", { status: 200 });
    };

    const restore = await restoreR2FromJson(
      { ...baseOptions, command: "restore", input: output, yes: true, dryRun: false },
      { fetchImpl: fetchForRestore, log: () => {} }
    );

    expect(restore).toMatchObject({ count: 1, totalBytes: 5 });
    expect(puts).toEqual([
      {
        pathname: "/bucket/tiles/a.json",
        body: "hello",
        contentType: "text/plain",
        origin: "unit-test",
      },
    ]);
  });
});
