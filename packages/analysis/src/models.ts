import type { AiModel } from '@design-index/shared';

export const GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const CAPABILITIES_URL = 'https://models.dev/api.json';

// Reviewed 2026-10-26: exact IDs with image-input metadata at models.dev, intersected with
// the live Go catalog. Endpoints/pricing/privacy: https://opencode.ai/v2/docs/console/go.
// Prices are conservative upper tiers, not discounted/off-peak prices. No family-name inference.
function model(id: string, name: string, apiFamily: AiModel['apiFamily'], input: number, output: number, structuredOutput = true, privacyNotice = 'No model training; documented retention: 0 days.'): AiModel {
  return { id, name, apiFamily, inputUsdPerMillion: input, outputUsdPerMillion: output, structuredOutput, privacyNotice, vision: true, trainsOnData: false };
}
const retained = 'No model training; documented retention: up to 30 days.';
const legacy = 'Legacy Go entry: image input is confirmed by matching Console metadata. Verify current provider retention in Console.';
const contributor = 'Contributor tier: prompts and outputs may be used for model training; not zero-data-retention. Requires explicit app consent and Console privacy permission.';

export const MODELS: readonly AiModel[] = [
  model('claude-haiku-5-5', 'Claude Haiku 5.5', 'anthropic', 0.5, 2.5, true, retained),
  model('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'chat-completions', 0.3, 1.2, true, 'No model training; current ZDR agreement through 2026-10-31. Requires Global region permission in Console.'),
  model('gemini-4-argon', 'Gemini 4 Argon', 'google', 4, 20),
  model('gpt-6-luna', 'GPT-6 Luna', 'responses', 0.2, 0.75, true, retained),
  model('gpt-5.6-luna', 'GPT-5.6 Luna', 'responses', 0.4, 1.8, true, retained),
  model('grok-4.7', 'Grok 4.7', 'responses', 4, 12, true, retained),
  model('grok-4.6', 'Grok 4.6', 'responses', 4, 12, true, legacy),
  model('glm-5.3-flash', 'GLM-5.3-Flash', 'chat-completions', 0.15, 0.5),
  model('kimi-k3.1-pro', 'Kimi K3.1 Pro', 'chat-completions', 2, 10),
  model('kimi-k3', 'Kimi K3', 'chat-completions', 3, 15),
  model('kimi-k2.7-code', 'Kimi K2.7 Code', 'chat-completions', 0.95, 4),
  model('kimi-k2.6', 'Kimi K2.6', 'chat-completions', 0.95, 4, false, legacy),
  model('qwen3.8-max', 'Qwen3.8 Max', 'anthropic', 2, 6),
  model('qwen3.8-flash', 'Qwen3.8 Flash', 'anthropic', 0.15, 0.47),
  model('qwen3.7-plus', 'Qwen3.7 Plus', 'anthropic', 1.2, 4.8, false),
  model('qwen3.6-plus', 'Qwen3.6 Plus', 'anthropic', 0.5, 3, false, legacy),
  model('mimo-v2.6-flash', 'MiMo V2.6 Flash', 'chat-completions', 0.14, 0.28, false),
  model('mimo-v2.6-pro', 'MiMo V2.6 Pro', 'chat-completions', 0.435, 0.87, false),
  model('mimo-v2.5', 'MiMo V2.5', 'chat-completions', 0.14, 0.28, false),
  model('minimax-m3.1-flash', 'MiniMax M3.1 Flash', 'chat-completions', 0.15, 0.6, false),
  model('minimax-m3', 'MiniMax M3', 'anthropic', 0.6, 2.4, false),
  model('step-5-preview', 'Step 5 Preview', 'chat-completions', 1, 2.7),
  { ...model('muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 'responses', 0.1, 0.2, true, contributor), trainsOnData: true },
  { ...model('muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 'responses', 0.1, 0.2, true, contributor), trainsOnData: true },
];

export function modelById(id: string): AiModel | undefined { return MODELS.find((model) => model.id === id && model.vision); }

type Capability = { modalities?: { input?: unknown; output?: unknown } };

/** Both catalogs must agree: listed in Go + explicit image input. Never infer vision from a name. */
export function filterVisionCatalog(go: unknown, capabilities: unknown): AiModel[] {
  const inventory = go as { data?: { id?: unknown }[] } | null;
  const metadata = capabilities as Record<string, { models?: Record<string, Capability> }> | null;
  if (!Array.isArray(inventory?.data) || !metadata?.['opencode-go']?.models) throw new Error('Invalid model catalog.');
  const ids = new Set(inventory.data.map((entry) => entry.id));
  return MODELS.filter((model) => {
    if (!ids.has(model.id)) return false;
    // An explicit Go record takes precedence, even if another provider advertises vision.
    const info = metadata['opencode-go']!.models![model.id] ?? metadata.opencode?.models?.[model.id];
    return Array.isArray(info?.modalities?.input) && info.modalities.input.includes('image')
      && Array.isArray(info.modalities.output) && info.modalities.output.includes('text');
  });
}

async function catalogJson(url: string, transport: typeof fetch): Promise<unknown> {
  const response = await transport(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'design-index/0.2.0' } });
  if (!response.ok) throw new Error('Catalog unavailable.');
  const declared = Number(response.headers.get('content-length'));
  if (declared > 16_000_000) throw new Error('Catalog too large.');
  const text = await response.text();
  if (text.length > 16_000_000) throw new Error('Catalog too large.');
  return JSON.parse(text);
}

export async function refreshCatalog(transport: typeof fetch = fetch): Promise<AiModel[]> {
  const [go, capabilities] = await Promise.all([catalogJson(GO_MODELS_URL, transport), catalogJson(CAPABILITIES_URL, transport)]);
  return filterVisionCatalog(go, capabilities);
}
