export const INTERCOM_CONTROL_REGISTER_EVENT = "intercom:control:register";
export const INTERCOM_CONTROL_SEND_EVENT = "intercom:control:send";
export const INTERCOM_CONTROL_RECEIVED_EVENT = "intercom:control";
export const INTERCOM_CONTROL_DELIVERY_EVENT = "intercom:control:delivery";

export const MAX_CONTROL_TYPE_LENGTH = 128;
export const MAX_CONTROL_DATA_BYTES = 16 * 1024;

export interface IntercomControlEnvelope {
	type: string;
	version: number;
	data?: unknown;
}

export interface IntercomControlRegistration {
	type: string;
	version: number;
}

export interface IntercomControlSendRequest {
	requestId: string;
	to: string;
	control: IntercomControlEnvelope;
	fallbackText?: string;
	messageId?: string;
}

export interface IntercomControlReceivedEvent {
	from: {
		id: string;
		name?: string;
		cwd: string;
		model: string;
		origin?: "local" | "remote";
		parentSessionId?: string;
		rootSessionId?: string;
	};
	messageId: string;
	receivedAt: number;
	control: IntercomControlEnvelope;
}

export interface IntercomControlDeliveryEvent {
	requestId: string;
	delivered: boolean;
	targetSessionId?: string;
	messageId?: string;
	deliveryId?: string;
	code?: string;
	error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isIntercomControlEnvelope(value: unknown): value is IntercomControlEnvelope {
	if (!isObject(value)) return false;
	if (
		typeof value.type !== "string"
		|| value.type.length === 0
		|| value.type.length > MAX_CONTROL_TYPE_LENGTH
		|| !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.type)
	) {
		return false;
	}
	if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
		return false;
	}
	if (value.data === undefined) return true;
	try {
		const encoded = JSON.stringify(value.data);
		return encoded !== undefined && Buffer.byteLength(encoded, "utf-8") <= MAX_CONTROL_DATA_BYTES;
	} catch {
		return false;
	}
}

export function parseIntercomControlRegistration(value: unknown): IntercomControlRegistration | null {
	if (!isObject(value)) return null;
	const candidate = { type: value.type, version: value.version };
	return isIntercomControlEnvelope(candidate) ? candidate : null;
}

export function parseIntercomControlSendRequest(value: unknown): IntercomControlSendRequest | null {
	if (!isObject(value)) return null;
	if (
		typeof value.requestId !== "string"
		|| value.requestId.trim().length === 0
		|| typeof value.to !== "string"
		|| value.to.trim().length === 0
		|| !isIntercomControlEnvelope(value.control)
	) {
		return null;
	}
	if (value.fallbackText !== undefined && typeof value.fallbackText !== "string") return null;
	if (value.messageId !== undefined && (typeof value.messageId !== "string" || value.messageId.length === 0)) return null;
	const fallbackText = typeof value.fallbackText === "string" ? value.fallbackText : undefined;
	const messageId = typeof value.messageId === "string" ? value.messageId : undefined;
	return {
		requestId: value.requestId,
		to: value.to,
		control: value.control,
		...(fallbackText !== undefined ? { fallbackText } : {}),
		...(messageId !== undefined ? { messageId } : {}),
	};
}

export function intercomControlKey(control: Pick<IntercomControlEnvelope, "type" | "version">): string {
	return `${control.type}@${control.version}`;
}
