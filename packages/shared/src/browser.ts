/** Browser-safe contracts and utilities; no model client, credentials, or validation runtime. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;
export const ITEM_STATUSES = ['queued', 'analyzing', 'writing_prompt', 'ready', 'needs_review'] as const;
export const PALETTE_ROLES = ['background', 'surface', 'text', 'muted-text', 'accent', 'border'] as const;
export type PaletteRole = typeof PALETTE_ROLES[number];
export const FACETS = ['style', 'color', 'layout', 'typography', 'motion', 'component'] as const;
export type Facet = typeof FACETS[number];
export const VOCABULARY: Record<Facet, readonly string[]> = {
  style: ['minimal', 'brutalist', 'glassmorphism', 'neumorphism', 'editorial', 'retro', 'skeuomorphic', 'industrial', 'organic'],
  color: ['light', 'dark', 'warm', 'cool', 'monochrome', 'muted', 'vibrant', 'high-contrast', 'low-contrast'],
  layout: ['bento-grid', 'grid', 'split-screen', 'centered-hero', 'sidebar', 'single-column', 'dense', 'spacious'],
  typography: ['serif', 'sans-serif', 'geometric-sans', 'monospace', 'display-type', 'mixed-pairing', 'high-weight-contrast'],
  motion: ['unknown', 'static', 'hover-effects', 'scroll-triggered', 'parallax', 'page-transitions', 'loops'],
  component: ['hero', 'pricing-table', 'nav', 'card', 'form', 'footer', 'dashboard', 'mobile-screen'],
};
export type VocabularyTerms = Record<Facet, string[]>;
export interface VocabularyState {
  revision: number;
  terms: VocabularyTerms;
  aliases: Record<Facet, Record<string, string>>;
  retiredTerms: VocabularyTerms;
  updatedAt: string;
}
export function defaultVocabulary(): VocabularyState {
  return {
    revision: 1, updatedAt: '',
    terms: Object.fromEntries(FACETS.map((facet) => [facet, [...VOCABULARY[facet]]])) as VocabularyTerms,
    aliases: Object.fromEntries(FACETS.map((facet) => [facet, {}])) as VocabularyState['aliases'],
    retiredTerms: { style: [], color: [], layout: [], typography: [], motion: [], component: [] },
  };
}
export function canonicalLabel(vocabulary: VocabularyState, facet: Facet, value: string): string {
  const seen = new Set<string>();
  while (Object.hasOwn(vocabulary.aliases[facet], value) && !seen.has(value)) { seen.add(value); value = vocabulary.aliases[facet][value]!; }
  return value;
}
export const PROMPT_VARIANTS = ['agent', 'general', 'vibe'] as const;
export type PromptVariant = typeof PROMPT_VARIANTS[number];
export const PROMPT_VARIANT_NAMES: Record<PromptVariant, string> = { agent: 'Coding agent', general: 'Design tool', vibe: 'Vibe' };

export interface SuggestedLabel { value: string; confidence: number }
export interface ItemLabel extends SuggestedLabel { facet: Facet; origin: 'model' | 'user'; state: 'suggested' | 'accepted' | 'rejected' }
export interface AnalysisResult {
  summary: string;
  labels: Record<Facet, SuggestedLabel[]>;
  palette_roles: Record<PaletteRole, string | null>;
  type_notes: string;
  motion_notes: string;
  free_tags: string[];
  quality: { issues: string[] };
  review: { needs_review: boolean; reasons: string[] };
}
export interface SavedPrompt { id: string; body: string; version: number; editedByUser: boolean; assumptions: string[]; modelId: string; analysisId: string; variant: PromptVariant; createdAt: string }
export interface PromptHistory { variant: PromptVariant; current: SavedPrompt | null; versions: SavedPrompt[]; total: number; offset: number; limit: number }
export interface PromptJob { status: 'queued' | 'running' | 'completed' | 'failed'; error: string | null }
export interface ItemIntelligence {
  analysis: (AnalysisResult & { id: string; modelId: string; createdAt: string; vocabularyRevision: number }) | null;
  labels: ItemLabel[];
  prompt: SavedPrompt | null;
  prompts: Record<PromptVariant, SavedPrompt | null>;
  promptJobs: Partial<Record<PromptVariant, PromptJob>>;
  analysisError: string | null;
}

export interface AiSettings {
  allowImageSharing: boolean;
  analyzeModel: string;
  promptModel: string;
  allowModelTraining: boolean;
}
export interface AiModel {
  id: string; name: string; vision: boolean; inputUsdPerMillion: number; outputUsdPerMillion: number;
  apiFamily: 'anthropic' | 'responses' | 'chat-completions' | 'google';
  structuredOutput: boolean;
  trainsOnData: boolean;
  privacyNotice: string;
}
export const MODEL_MAX_OUTPUT_TOKENS = 4096;
export interface AiStatus {
  settings: AiSettings;
  keyConfigured: boolean;
  models: AiModel[];
  usage: { month: string; inputTokens: number; outputTokens: number; uncertainCalls: number; calls: number };
  analysis: 'not_configured' | 'paused' | 'running' | 'waiting';
  retryAt: string | null;
  queued: number;
  running: number;
  failed: number;
  message: string;
}

/** Shared UI/server readiness checks; the provider key itself never crosses this boundary. */
export function activationBlockers(settings: AiSettings, keyConfigured: boolean, models: readonly AiModel[]): string[] {
  const blockers: string[] = [];
  if (!keyConfigured) blockers.push('The server needs an OpenCode Go API key in the project .env. Restart the server after adding it.');
  const selected = [settings.analyzeModel, settings.promptModel].map((id) => models.find((model) => model.id === id && model.vision));
  if (selected.some((model) => !model)) blockers.push('A selected vision model is not in the current Go catalog. Choose an available vision model for both roles.');
  if (!settings.allowImageSharing) blockers.push('Approve image-sharing to start automatic analysis. Go runs remotely even though this library is local.');
  if (selected.some((model) => model?.trainsOnData) && !settings.allowModelTraining) blockers.push('Contributor models require explicit consent to provider training. Choose another model or grant that separate consent.');
  return blockers;
}

export interface PaletteColor {
  hex: string;
  oklab: [number, number, number];
  weight: number;
  source: 'pixels' | 'css';
  role: PaletteRole | null;
}

export interface LibraryItem {
  id: string;
  type: 'image' | 'url' | 'element';
  title: string;
  note: string;
  status: typeof ITEM_STATUSES[number];
  capturedAt: string;
  width: number;
  height: number;
  previewUrl: string;
  originalUrl: string;
  palette: PaletteColor[];
  intelligence: ItemIntelligence;
  sourceUrl: string | null;
  facts: PageFacts | null;
  assets: LibraryAsset[];
}

export const ASSET_KINDS = ['original', 'preview', 'full_page', 'viewport', 'mobile', 'element_crop'] as const;
export type AssetKind = typeof ASSET_KINDS[number];
export interface LibraryAsset { id: string; kind: AssetKind; url: string; width: number; height: number }
export interface PageFacts {
  fonts: string[];
  styles: { tag: string; fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; padding: string; gap: string; borderRadius: string; boxShadow: string }[];
  colors: { hex: string; weight: number }[];
  animations: { name: string; duration: string; easing: string }[];
  transitions: { property: string; duration: string; easing: string }[];
  libraries: string[];
  warnings: string[];
  truncated: boolean;
}
export interface CaptureSettings { approvedLocalOrigins: string[] }
export interface InboxImport {
  fileName: string; status: 'imported' | 'failed'; itemId: string | null; deduplicated: boolean;
  error: string | null; updatedAt: string; retryAt: string | null;
}
export interface InboxStatus {
  enabled: boolean; directory: string | null; scanning: boolean; pending: number; lastScanAt: string | null;
  error: string | null; revision: string; imported: number; failed: number; recent: InboxImport[];
}
export interface UrlCaptureRequest { url: string; title: string; note: string; colorScheme: 'light' | 'dark' }
export interface CaptureJob extends UrlCaptureRequest { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; error: string | null; itemId: string | null; deduplicated: boolean; createdAt: string }
export interface EvaluationSample { itemId: string; title: string; previewUrl: string; labels: VocabularyTerms; scoredFacets: Facet[]; note: string; version: number }
export interface EvaluationScores { truePositives: number; falsePositives: number; falseNegatives: number; exactFacets: number; scoredFacets: number; precision: number | null; recall: number | null; f1: number | null; exactAgreement: number }
export interface EvaluationTrial {
  id: string; runId: string; itemId: string; modelId: string; title: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  schemaValid: boolean | null; valid: boolean | null; result: AnalysisResult | null;
  scores: EvaluationScores | null; latencyMs: number | null; error: string | null;
  inputTokens: number | null; outputTokens: number | null;
  attempted: boolean;
}
export interface EvaluationSummary { modelId: string; trials: number; finished: number; attempted: number; responses: number; valid: number; schemaValid: number; averageLatencyMs: number | null; inputTokens: number; outputTokens: number; scores: EvaluationScores }
export interface EvaluationRun { id: string; name: string; status: 'queued' | 'running' | 'completed' | 'cancelled'; createdAt: string; vocabularyRevision: number; sampleCount: number; modelIds: string[]; summaries: EvaluationSummary[]; trials: EvaluationTrial[] }

/** Score only explicitly hand-labeled facets. Invalid model output never receives exact-match credit. */
export function scoreEvaluation(expected: VocabularyTerms, scored: readonly Facet[], predicted: AnalysisResult | null): EvaluationScores {
  let truePositives = 0, falsePositives = 0, falseNegatives = 0, exactFacets = 0;
  for (const facet of scored) {
    const gold = new Set(expected[facet]);
    const actual = new Set(predicted?.labels[facet].map((label) => label.value) ?? []);
    for (const value of actual) if (gold.has(value)) truePositives++; else falsePositives++;
    for (const value of gold) if (!actual.has(value)) falseNegatives++;
    if (predicted && gold.size === actual.size && [...gold].every((value) => actual.has(value))) exactFacets++;
  }
  return evaluationScores(truePositives, falsePositives, falseNegatives, exactFacets, scored.length);
}
export function evaluationScores(truePositives: number, falsePositives: number, falseNegatives: number, exactFacets: number, scoredFacets: number): EvaluationScores {
  const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null;
  const recall = truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : null;
  return { truePositives, falsePositives, falseNegatives, exactFacets, scoredFacets, precision, recall,
    f1: 2 * truePositives + falsePositives + falseNegatives ? 2 * truePositives / (2 * truePositives + falsePositives + falseNegatives) : null,
    exactAgreement: scoredFacets ? exactFacets / scoredFacets : 0 };
}

export interface LibraryPage {
  items: LibraryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CaptureResult {
  item: LibraryItem;
  deduplicated: boolean;
}

export function paletteToCss(palette: readonly PaletteColor[], roles?: Partial<Record<PaletteRole, string | null>>): string {
  if (roles) {
    const entries = Object.entries(roles).filter((entry): entry is [PaletteRole, string] => !!entry[1] && palette.some((color) => color.hex === entry[1]));
    const used = new Set(entries.map(([, hex]) => hex));
    return `:root {\n${[
      ...entries.map(([role, hex]) => `  --${role}: ${hex};`),
      ...palette.filter((color) => !used.has(color.hex)).map((color, index) => `  --color-${index + 1}: ${color.hex};`),
    ].join('\n')}\n}\n`;
  }
  const declarations = palette.map((color, index) => {
    const name = color.role ?? `color-${index + 1}`;
    return `  --${name}: ${color.hex};`;
  });
  return `:root {\n${declarations.join('\n')}\n}\n`;
}
