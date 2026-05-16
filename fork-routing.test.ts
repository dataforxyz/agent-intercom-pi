import test from "node:test";
import assert from "node:assert/strict";
import { buildIntercomStatus, getForkHandlerIdentity, isForkHandlerSession } from "./fork-routing.ts";

test("buildIntercomStatus tags intercom fork handler sessions", () => {
  assert.equal(
    buildIntercomStatus("thinking", "reviewing", {
      PI_INTERCOM_FORK_HANDLER: "1",
      PI_INTERCOM_FORK_HANDLER_RUN_ID: "icfh_123",
    }),
    "thinking · reviewing · fork-handler:intercom:icfh_123",
  );
});

test("buildIntercomStatus tags return_on and subagent fork handler sessions", () => {
  assert.equal(
    buildIntercomStatus("idle", undefined, {
      PI_RETURN_ON_HANDLER: "1",
      PI_RETURN_ON_HANDLER_RUN_ID: "roh_abc",
    }),
    "idle · fork-handler:return-on:roh_abc",
  );
  assert.equal(
    buildIntercomStatus("tool:bash", undefined, {
      PI_SUBAGENT_BACKGROUND_HANDLER: "1",
      PI_SUBAGENT_BACKGROUND_HANDLER_RUN_ID: "sbf_def",
    }),
    "tool:bash · fork-handler:subagent:sbf_def",
  );
});

test("getForkHandlerIdentity gives visible fork session names", () => {
  assert.deepEqual(
    getForkHandlerIdentity({ PI_SUBAGENT_BACKGROUND_HANDLER: "1", PI_SUBAGENT_BACKGROUND_HANDLER_RUN_ID: "sbf_mp7m9yxl_jqn3ap_async-step-complete" }),
    {
      kind: "subagent",
      runId: "sbf_mp7m9yxl_jqn3ap_async-step-complete",
      statusTag: "fork-handler:subagent:sbf_mp7m9yxl_jqn3ap_async-step-complete",
      sessionName: "fork-subagent-mp7m9yxl-jqn3ap",
    },
  );
});

test("isForkHandlerSession detects fork handler status tags", () => {
  assert.equal(isForkHandlerSession({ status: "thinking · fork-handler:intercom:icfh_123" }), true);
  assert.equal(isForkHandlerSession({ status: "idle · fork-handler:return-on:roh_abc" }), true);
  assert.equal(isForkHandlerSession({ status: "idle · researching" }), false);
  assert.equal(isForkHandlerSession({}), false);
});
