# Extension Testing

Extension integration tests use the **faux mock provider** from `@earendil-works/pi-ai` plus the pi SDK (`createAgentSession`) to drive scripted tool-call sequences end-to-end.

## Boilerplate

```ts
import {
    AuthStorage,
    createAgentSession,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    registerFauxProvider,
} from "@earendil-works/pi-ai";
import myExtension from "../extensions/my-extension.js";

// 1. Register faux provider & set a dummy API key
const faux = registerFauxProvider();
const model = faux.getModel()!;
const authStorage = AuthStorage.inMemory();
authStorage.setRuntimeApiKey(model.provider, "fake-key");
const modelRegistry = ModelRegistry.inMemory(authStorage);

// 2. Build a minimal resource loader with the extension under test
const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-test-agent"),
    settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
    }),
    noExtensions: true,   // skip auto-discovery
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [myExtension],  // inject only the extension under test
    systemPromptOverride: () => "You are a test assistant.",
});
await resourceLoader.reload();

// 3. Create session with faux model
const { session } = await createAgentSession({
    cwd,
    model,
    thinkingLevel: "off",
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    authStorage,
    modelRegistry,
});

// 4. Script faux responses (must end with a non-toolUse stop)
faux.setResponses([
    fauxAssistantMessage(
        fauxToolCall("read", { path: "/tmp/file.txt" }),
        { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(fauxText("done")),
]);

// 5. Collect events via subscribe, then prompt
session.subscribe((event) => { /* collect tool_execution_end */ });
await session.prompt("go");
session.dispose();
faux.unregister();
```

See `tests/file-guard.test.ts` for a complete reference implementation.
