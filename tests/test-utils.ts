/**
 * Shared test utilities for extension integration tests.
 */

import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Create a ModelRuntime for testing with the faux provider.
 * Registers the faux provider with an in-memory credential store
 * and sets a runtime API key so the auth pipeline succeeds.
 */
export async function createFauxModelRuntime(
    faux: FauxProviderRegistration,
): Promise<ModelRuntime> {
    const model = faux.getModel()!;
    const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
    });
    modelRuntime.registerProvider(model.provider, {
        name: "Faux",
        api: faux.api,
        authHeader: true,
        baseUrl: "http://localhost:0/faux",
        models: faux.models.map((m) => ({
            id: m.id,
            name: m.name,
            baseUrl: m.baseUrl ?? "http://localhost:0/faux",
            api: m.api,
            reasoning: m.reasoning ?? false,
            input: m.input,
            cost: m.cost,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
        })),
    });
    await modelRuntime.setRuntimeApiKey(model.provider, "fake-key");
    return modelRuntime;
}
