import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createExtensionModelQuery } from "../../src/extensibility/extensions/model-api";

function model(id: string, name: string, provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

const claude = model("claude-opus-4-8", "Claude Opus 4.8", "anthropic");
const claudePrev = model("claude-opus-4-7", "Claude Opus 4.7", "anthropic");
const sonnet = model("claude-sonnet-4-8", "Claude Sonnet 4.8", "anthropic");
const gpt = model("gpt-5.4", "GPT-5.4", "openai");
const gptMini = model("gpt-5.4-mini", "GPT-5.4 Mini", "openai");

const available = [claude, sonnet, gpt, gptMini] as Model<Api>[];

/** Minimal registry stub: only the methods the facade, core resolver and fallback lookup touch. */
function registry(): ModelRegistry {
	return {
		getAvailable: () => available,
		find: (provider: string, id: string) => available.find(m => m.provider === provider && m.id === id),
		hasProvider: (provider: string) => ["anthropic", "openai", "openai-codex"].includes(provider),
	} as unknown as ModelRegistry;
}

describe("createExtensionModelQuery", () => {
	test("current() reflects the live session model, read lazily", () => {
		let active: Model<Api> | undefined = claude;
		const q = createExtensionModelQuery(registry(), undefined, () => active);
		expect(q.current()).toBe(claude);
		active = gpt;
		expect(q.current()).toBe(gpt);
	});

	test("resolve() matches model strings through the core resolver", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.resolve("anthropic/claude-opus-4-8")).toBe(claude);
		expect(q.resolve("gpt-5.4")?.provider).toBe("openai");
		expect(q.resolve("definitely-not-a-model")).toBeUndefined();
	});

	test("resolve() honors configured role aliases via the same settings-backed path as core", () => {
		const settings = Settings.isolated({ modelRoles: { slow: "anthropic/claude-opus-4-8" } });
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.resolve("@slow")).toBe(claude);
	});

	test("family() groups a vendor's point releases and separates vendors", () => {
		const q = createExtensionModelQuery(registry(), undefined, () => undefined);
		expect(q.family(claude)).toBe(q.family(claudePrev));
		expect(q.family(claude)).not.toBe(q.family(gpt));
	});

	test("fallbacks() follows a role's model chain, skipping models that aren't signed in", () => {
		const settings = Settings.isolated({
			modelRoles: { smol: "anthropic/claude-sonnet-4-8:medium" },
			retry: { fallbackChains: { "anthropic/claude-sonnet-4-8": ["openai-codex/gpt-9", "openai/gpt-5.4"] } },
		});
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.fallbacks("@smol")).toEqual([gpt]);
		expect(q.fallbacks("anthropic/claude-sonnet-4-8")).toEqual([gpt]);
	});

	test("fallbacks() walks each candidate's own chain after it, once per model", () => {
		const settings = Settings.isolated({
			retry: {
				fallbackChains: {
					"anthropic/claude-opus-4-8": ["openai/gpt-5.4", "anthropic/claude-sonnet-4-8"],
					"openai/gpt-5.4": ["openai/gpt-5.4-mini", "anthropic/claude-opus-4-8"],
				},
			},
		});
		const q = createExtensionModelQuery(registry(), settings, () => undefined);
		expect(q.fallbacks("anthropic/claude-opus-4-8")).toEqual([gpt, gptMini, sonnet]);
	});

	test("fallbacks() honours an empty exact chain over a provider wildcard, and the off switch", () => {
		const chains = { "anthropic/claude-opus-4-8": [], "anthropic/*": ["openai/gpt-5.4"] };
		const on = Settings.isolated({ retry: { fallbackChains: chains } });
		const q = createExtensionModelQuery(registry(), on, () => undefined);
		expect(q.fallbacks("anthropic/claude-opus-4-8")).toEqual([]);
		expect(q.fallbacks("anthropic/claude-sonnet-4-8")).toEqual([gpt]);

		const off = Settings.isolated({ retry: { modelFallback: false, fallbackChains: chains } });
		expect(createExtensionModelQuery(registry(), off, () => undefined).fallbacks("anthropic/claude-sonnet-4-8")).toEqual(
			[],
		);
	});
});
