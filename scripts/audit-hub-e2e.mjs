import assert from "node:assert/strict";
import {
  auditCriticalWrite,
  auditInvocation,
  checkHubEndpointReachable,
  checkHubServiceHealthy,
  loadAuditConfig,
} from "../dist/src/lib/audit.js";

const cfg = loadAuditConfig();
assert.equal(cfg.mode, "hub", "RA_AUDIT_MODE must be hub for this E2E smoke");
assert.equal(await checkHubEndpointReachable(cfg), true, "Audit Hub liveness failed");
assert.equal(await checkHubServiceHealthy(cfg), true, "authenticated Audit Hub service health failed");

await auditInvocation("rheinagent_file_list", { result_count: 0 });

let successMutationRan = false;
const businessResult = await auditCriticalWrite(
  {
    toolName: "rheinagent_file_upload_finalize",
    metadata: { mime_category: "text", final_size_bytes: 7 },
  },
  async () => {
    successMutationRan = true;
    return { accepted: true };
  },
  async () => ({ verification_result: "ok" }),
);
assert.equal(successMutationRan, true);
assert.deepEqual(businessResult, { accepted: true });

const originalServiceId = process.env.RA_AUDIT_SERVICE_ID;
let blockedMutationRan = false;
let failClosedObserved = false;
try {
  process.env.RA_AUDIT_SERVICE_ID = "00000000-0000-4000-8000-000000000000";
  await auditCriticalWrite(
    { toolName: "rheinagent_file_delete_apply" },
    async () => {
      blockedMutationRan = true;
      return { deleted: true };
    },
  );
} catch {
  failClosedObserved = true;
} finally {
  if (originalServiceId === undefined) delete process.env.RA_AUDIT_SERVICE_ID;
  else process.env.RA_AUDIT_SERVICE_ID = originalServiceId;
}
assert.equal(failClosedObserved, true, "invalid service identity must fail before mutation");
assert.equal(blockedMutationRan, false, "fail-closed path executed the mutation");

console.log(JSON.stringify({
  live_hub: true,
  authenticated_health: true,
  invocation_recorded: true,
  critical_lifecycle_completed: true,
  fail_closed_pre_intent: true,
  mutation_blocked_on_invalid_service: true,
}));
