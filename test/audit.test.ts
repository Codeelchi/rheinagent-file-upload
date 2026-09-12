import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  AuditBusinessVerificationError,
  AuditHubClientError,
  AuditHubUnavailable,
  AuditIncompleteError,
  auditCriticalWrite,
  auditInvocation,
  checkHubEndpointReachable,
  checkHubServiceHealthy,
  loadAuditConfig,
  sanitizeMetadata,
  type AuditConfig,
} from "../src/lib/audit.js";

type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
};

type MockDecision = {
  status?: number;
  body?: Record<string, unknown>;
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createCredential(): Promise<{ credentialPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rheinagent-audit-test-"));
  const credentialPath = path.join(dir, "credential.txt");
  await fs.writeFile(credentialPath, "test-credential\n", "utf-8");
  return { credentialPath, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function startMockHub(
  decide?: (request: RecordedRequest, index: number) => MockDecision,
): Promise<{ baseUrl: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf-8");
    const request: RecordedRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
    };
    requests.push(request);

    let decision: MockDecision = decide?.(request, requests.length - 1) ?? {};
    if (!decision.body) {
      if (request.url === "/healthz") decision = { ...decision, body: { status: "ok" } };
      else if (request.url === "/v1/service/health") decision = { ...decision, body: { status: "HEALTHY" } };
      else if (request.url === "/v1/events/begin") {
        decision = {
          ...decision,
          body: { status: "intent_durable", correlation_id: "corr-12345678", intent_sequence: 1 },
        };
      } else decision = { ...decision, body: { status: "recorded" } };
    }
    res.statusCode = decision.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(decision.body));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: "http://127.0.0.1:" + address.port,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withHubEnv<T>(baseUrl: string, credentialPath: string, fn: () => Promise<T>): Promise<T> {
  return withEnv(
    {
      RA_AUDIT_MODE: "hub",
      RA_AUDIT_ENDPOINT: baseUrl,
      RA_AUDIT_SERVICE_ID: "service-test",
      RA_AUDIT_CREDENTIAL_PATH: credentialPath,
      RA_AUDIT_ALLOW_PRIVATE_HTTP: undefined,
    },
    fn,
  );
}

test("loadAuditConfig defaults to off and rejects invalid modes", async () => {
  await withEnv({ RA_AUDIT_MODE: undefined }, () => {
    assert.equal(loadAuditConfig().mode, "off");
  });
  await withEnv({ RA_AUDIT_MODE: "bogus" }, () => {
    assert.throws(() => loadAuditConfig(), AuditHubClientError);
  });
});

test("metadata sanitizer enforces allowlist, denylist and max string length", () => {
  const sanitized = sanitizeMetadata(
    {
      processor_id: "text_extract",
      password: "must-never-appear",
      notes: "x".repeat(400),
      ignored: "not-allowlisted",
    },
    ["processor_id", "password", "notes", "ignored_never"],
  );
  assert.deepEqual(Object.keys(sanitized).sort(), ["notes", "processor_id"]);
  assert.equal(sanitized.processor_id, "text_extract");
  assert.equal(String(sanitized.notes).length, 256);
});

test("liveness and authenticated service health use canonical endpoints", async () => {
  const hub = await startMockHub();
  const credential = await createCredential();
  try {
    const cfg: AuditConfig = {
      mode: "hub",
      endpoint: hub.baseUrl,
      serviceId: "service-test",
      credentialPath: credential.credentialPath,
      protocolVersion: "rheinagent-audit/1",
      allowPrivateHttp: false,
    };
    assert.equal(await checkHubEndpointReachable(cfg), true);
    assert.equal(await checkHubServiceHealthy(cfg), true);
    assert.equal(hub.requests[0].url, "/healthz");
    assert.equal(hub.requests[1].url, "/v1/service/health");
    assert.equal(hub.requests[1].headers.authorization, "Bearer test-credential");
    assert.equal(hub.requests[1].headers["x-ra-service-id"], "service-test");
  } finally {
    await hub.close();
    await credential.cleanup();
  }
});

test("hub mode with incomplete config is unhealthy and unreachable port reports false", async () => {
  const incomplete: AuditConfig = {
    mode: "hub",
    protocolVersion: "rheinagent-audit/1",
    allowPrivateHttp: false,
  };
  assert.equal(await checkHubEndpointReachable(incomplete), undefined);
  assert.equal(await checkHubServiceHealthy(incomplete), false);
  assert.equal(
    await checkHubEndpointReachable({ ...incomplete, endpoint: "http://127.0.0.1:1" }),
    false,
  );
});

test("invocation sends canonical action/tool/result body and authenticated headers", async () => {
  const hub = await startMockHub();
  const credential = await createCredential();
  try {
    await withHubEnv(hub.baseUrl, credential.credentialPath, async () => {
      await auditInvocation("rheinagent_file_list", { result_count: 2, filename: "secret.txt" });
    });
    assert.equal(hub.requests.length, 1);
    const request = hub.requests[0];
    assert.equal(request.url, "/v1/events/invocation");
    assert.deepEqual(request.body, {
      action: "file.list",
      tool: "rheinagent_file_list",
      metadata: { result_count: 2 },
      result: "success",
    });
    assert.equal(request.headers.authorization, "Bearer test-credential");
    assert.equal(request.headers["x-ra-service-id"], "service-test");
    assert.equal(typeof request.headers["x-ra-request-id"], "string");
  } finally {
    await hub.close();
    await credential.cleanup();
  }
});

test("invocation fails open on Hub unavailability but propagates 4xx contract/auth errors", async () => {
  const unavailable = await startMockHub(() => ({ status: 503, body: { error: "unavailable" } }));
  const denied = await startMockHub(() => ({ status: 403, body: { error: "denied" } }));
  const credential = await createCredential();
  try {
    await withHubEnv(unavailable.baseUrl, credential.credentialPath, async () => {
      await auditInvocation("rheinagent_file_list", { result_count: 1 });
    });
    await withHubEnv(denied.baseUrl, credential.credentialPath, async () => {
      await assert.rejects(
        () => auditInvocation("rheinagent_file_list", { result_count: 1 }),
        (error: unknown) => error instanceof AuditHubClientError && !(error instanceof AuditHubUnavailable),
      );
    });
  } finally {
    await unavailable.close();
    await denied.close();
    await credential.cleanup();
  }
});

test("critical write follows INTENT APPLY VERIFY RESULT with correlation id", async () => {
  const hub = await startMockHub();
  const credential = await createCredential();
  try {
    const result = await withHubEnv(hub.baseUrl, credential.credentialPath, async () => {
      return auditCriticalWrite(
        {
          toolName: "rheinagent_file_upload_finalize",
          metadata: { mime_category: "text", final_size_bytes: 4 },
        },
        async () => ({ business: "done" }),
        async () => ({ verification_result: "ok" }),
      );
    });
    assert.deepEqual(result, { business: "done" });
    assert.deepEqual(hub.requests.map((request) => request.url), [
      "/v1/events/begin",
      "/v1/events/phase",
      "/v1/events/phase",
      "/v1/events/phase",
    ]);
    assert.deepEqual(hub.requests[0].body, {
      action: "file.upload.finalize",
      tool: "rheinagent_file_upload_finalize",
      metadata: { mime_category: "text", final_size_bytes: 4 },
    });
    assert.deepEqual(hub.requests[1].body, { correlation_id: "corr-12345678", phase: "APPLY" });
    assert.deepEqual(hub.requests[2].body, {
      correlation_id: "corr-12345678",
      phase: "VERIFY",
      metadata: { verification_result: "ok" },
    });
    assert.deepEqual(hub.requests[3].body, {
      correlation_id: "corr-12345678",
      phase: "RESULT",
      result: "success",
      metadata: { verification_result: "ok" },
    });
    for (const request of hub.requests) {
      assert.equal("request_id" in request.body, false);
      assert.equal(typeof request.headers["x-ra-request-id"], "string");
    }
  } finally {
    await hub.close();
    await credential.cleanup();
  }
});

test("critical write fails closed before mutation when durable INTENT is unavailable", async () => {
  const hub = await startMockHub((request) =>
    request.url === "/v1/events/begin"
      ? { status: 503, body: { error: "journal_unavailable" } }
      : {},
  );
  const credential = await createCredential();
  let mutated = false;
  try {
    await withHubEnv(hub.baseUrl, credential.credentialPath, async () => {
      await assert.rejects(
        () => auditCriticalWrite(
          { toolName: "rheinagent_file_delete_apply" },
          async () => {
            mutated = true;
            return "deleted";
          },
        ),
        AuditHubUnavailable,
      );
    });
    assert.equal(mutated, false);
  } finally {
    await hub.close();
    await credential.cleanup();
  }
});

test("post-mutation Hub failure surfaces AUDIT_INCOMPLETE instead of false business failure", async () => {
  const hub = await startMockHub((request) =>
    request.url === "/v1/events/phase" && request.body.phase === "APPLY"
      ? { status: 503, body: { error: "journal_unavailable" } }
      : {},
  );
  const credential = await createCredential();
  let mutated = false;
  try {
    await withHubEnv(hub.baseUrl, credential.credentialPath, async () => {
      await assert.rejects(
        () => auditCriticalWrite(
          { toolName: "rheinagent_file_rename", metadata: { mime_category: "text" } },
          async () => {
            mutated = true;
            return { renamed: true };
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof AuditIncompleteError);
          assert.equal(error.code, "AUDIT_INCOMPLETE");
          assert.equal(error.mutationApplied, true);
          assert.equal(error.failedPhase, "APPLY");
          return true;
        },
      );
    });
    assert.equal(mutated, true);
  } finally {
    await hub.close();
    await credential.cleanup();
  }
});

test("failed business postcondition records RESULT failure and surfaces a distinct error", async () => {
  const hub = await startMockHub();
  const credential = await createCredential();
  try {
    await withHubEnv(hub.baseUrl, credential.credentialPath, async () => {
      await assert.rejects(
        () => auditCriticalWrite(
          { toolName: "rheinagent_file_process_apply", metadata: { processor_id: "text_extract" } },
          async () => ({ completed: true }),
          async () => {
            throw new Error("postcondition mismatch");
          },
        ),
        AuditBusinessVerificationError,
      );
    });
    assert.equal(hub.requests.length, 3);
    assert.deepEqual(hub.requests[1].body, { correlation_id: "corr-12345678", phase: "APPLY" });
    assert.deepEqual(hub.requests[2].body, {
      correlation_id: "corr-12345678",
      phase: "RESULT",
      result: "failure",
      error_category: "validation_failed",
    });
  } finally {
    await hub.close();
    await credential.cleanup();
  }
});
