/**
 * Model query facade exposed to extensions as `ctx.models`.
 *
 * Read-only: lets an extension select a model the same way core does — list
 * authenticated models, read the session model, resolve a model string or role
 * alias, follow its retry fallback chain, and compare model families — without
 * touching the mutable registry or duplicating resolution/family heuristics.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import {
	expandRoleAlias,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelRoleValue,
} from "../../config/model-resolver";
import { cfgDisabledProviders } from "../../config/model-settings";
import type { Settings } from "../../config/settings";
import {
	findRetryFallbackCandidates,
	getRetryFallbackChains,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "../../session/retry-fallback-chains";
import { cfgRetry } from "../../session/settings";
import type { ExtensionModelQuery } from "./types";

/**
 * Build the `ctx.models` facade. `getModel` is read lazily so `current()` always
 * reflects the live session model (it can change mid-session via `/model`).
 */
export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
): ExtensionModelQuery {
	return {
		list: () => modelRegistry.getAvailable(),
		current: () => getModel(),
		// resolveModelRoleValue expands a role alias (`@slow`) to its full configured
		// priority list and tries each pattern — the same path core selection uses — so a
		// fallback model lower in the list still resolves. Plain model strings pass through
		// as a single pattern.
		resolve: (spec: string): Model<Api> | undefined =>
			resolveModelRoleValue(spec, modelRegistry.getAvailable(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model,
		family: (model: Model<Api>): string =>
			model.identity.class === "unknown" ? model.provider.toLowerCase() : model.identity.class,
		fallbacks: (spec: string): Model<Api>[] => (settings ? resolveFallbackModels(spec, modelRegistry, settings) : []),
	};
}

/**
 * Resolve `spec` the way eval's `completion()` resolves a tier primary, then walk
 * its retry fallback chain depth-first so each candidate's own chain follows it.
 * A role alias hints its role's chain, as the tier does there.
 */
function resolveFallbackModels(spec: string, modelRegistry: ModelRegistry, settings: Settings): Model<Api>[] {
	const retry = cfgRetry.get(settings);
	if (!retry.enabled || !retry.modelFallback) return [];
	const trimmed = spec.trim();
	const selector = expandRoleAlias(trimmed, settings);
	const primary = resolveModelFromString(
		selector,
		modelRegistry.getAvailable(),
		getModelMatchPreferences(settings),
	);
	if (!primary) return [];

	const context: RetryFallbackResolutionContext = {
		chains: getRetryFallbackChains(settings),
		getModelRole: role => settings.getModelRole(role),
		modelLookup: modelRegistry,
	};
	const disabledProviders = new Set(cfgDisabledProviders.get(settings));
	const seen = new Set([formatModelStringWithRouting(primary)]);
	const expanded = new Set<string>();
	const out: Model<Api>[] = [];
	const walk = (current: string, model: Model<Api>, roleHint: string | undefined): void => {
		if (expanded.has(current)) return;
		expanded.add(current);
		const chainKey = resolveRetryFallbackChainKey(context, current, model, roleHint);
		if (!chainKey) return;
		for (const entry of findRetryFallbackCandidates(context, chainKey, current, model, {
			allowMissingPrimary: true,
		})) {
			const candidate = resolveModelOverride([entry.raw], modelRegistry, settings).model;
			if (!candidate || disabledProviders.has(candidate.provider)) continue;
			const identity = formatModelStringWithRouting(candidate);
			if (seen.has(identity)) continue;
			seen.add(identity);
			out.push(candidate);
			walk(entry.raw, candidate, undefined);
		}
	};
	walk(selector, primary, trimmed.startsWith("@") ? trimmed.slice(1) : undefined);
	return out;
}
