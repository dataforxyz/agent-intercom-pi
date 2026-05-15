import test from "node:test";
import assert from "node:assert/strict";
import { buildIntercomStatus, isForkHandlerSession } from "./fork-routing.ts";

test("buildIntercomStatus tags fork handler sessions", () => {
  assert.equal(
    buildIntercomStatus("thinking", "reviewing", {
      PI_INTERCOM_FORK_HANDLER: "1",
      PI_INTERCOM_FORK_HANDLER_RUN_ID: "icfh_123",
    }),
    "thinking · reviewing · fork-handler:icfh_123",
  );
});

test("isForkHandlerSession detects fork handler status tags", () => {
  assert.equal(isForkHandlerSession({ status: "thinking · fork-handler:icfh_123" }), true);
  assert.equal(isForkHandlerSession({ status: "idle · researching" }), false);
  assert.equal(isForkHandlerSession({}), false);
});
