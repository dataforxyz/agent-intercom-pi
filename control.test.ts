import test from "node:test";
import assert from "node:assert/strict";
import {
	intercomControlKey,
	isIntercomControlEnvelope,
	parseIntercomControlRegistration,
	parseIntercomControlSendRequest,
} from "./control.ts";

test("structured intercom controls validate bounded typed envelopes", () => {
	const control = { type: "reload-runtime.request", version: 1, data: { requestId: "request-1" } };
	assert.equal(isIntercomControlEnvelope(control), true);
	assert.equal(intercomControlKey(control), "reload-runtime.request@1");
	assert.deepEqual(parseIntercomControlRegistration(control), {
		type: "reload-runtime.request",
		version: 1,
	});

	assert.equal(isIntercomControlEnvelope({ type: "", version: 1 }), false);
	assert.equal(isIntercomControlEnvelope({ type: "bad type", version: 1 }), false);
	assert.equal(isIntercomControlEnvelope({ type: "reload", version: 0 }), false);
	assert.equal(isIntercomControlEnvelope({
		type: "reload",
		version: 1,
		data: "x".repeat(17 * 1024),
	}), false);
});

test("control send requests require correlation and target fields", () => {
	assert.deepEqual(parseIntercomControlSendRequest({
		requestId: "delivery-1",
		to: "worker",
		messageId: "message-1",
		fallbackText: "Compatible reload extension required.",
		control: { type: "reload-runtime.request", version: 1, data: { requestId: "reload-1" } },
	}), {
		requestId: "delivery-1",
		to: "worker",
		messageId: "message-1",
		fallbackText: "Compatible reload extension required.",
		control: { type: "reload-runtime.request", version: 1, data: { requestId: "reload-1" } },
	});
	assert.equal(parseIntercomControlSendRequest({
		requestId: "",
		to: "worker",
		control: { type: "reload", version: 1 },
	}), null);
});
