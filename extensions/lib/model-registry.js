/**
 * Resolve an API key across multiple pi runtime generations.
 *
 * Newer runtimes expose modelRegistry.getApiKey(model).
 * Older runtimes may only expose getApiKeyForProvider(provider)
 * or authStorage.getApiKey(provider).
 */
export async function getModelApiKey(ctx, model) {
	const modelRegistry = ctx.modelRegistry;

	if (typeof modelRegistry?.getApiKey === "function") {
		return modelRegistry.getApiKey(model);
	}

	if (typeof modelRegistry?.getApiKeyForProvider === "function") {
		return modelRegistry.getApiKeyForProvider(model.provider);
	}

	if (typeof modelRegistry?.authStorage?.getApiKey === "function") {
		return modelRegistry.authStorage.getApiKey(model.provider);
	}

	return undefined;
}
