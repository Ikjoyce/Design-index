import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { Library, ClaimedJob, EvaluationClaim, TrialInput, TrialMetadata } from '@design-index/database';
import { analysisInput, assertInputBounds, createGoProvider, hasMotionEvidence, MAX_OUTPUT_TOKENS, MODELS, modelById, modelSystemPrompt, promptInput, PROMPT_VERSION, ProviderError, refreshCatalog, validateAnalysis, validatePrompt, WRITE_PROMPT_VERSION } from '@design-index/analysis';
import type { AnalysisProvider } from '@design-index/analysis';
import { activationBlockers, aiSettingsSchema, analysisResultSchema, FACETS, paletteToCss } from '@design-index/shared';
import type { AiSettings, AiStatus, LibraryItem, PromptVariant, VocabularyState } from '@design-index/shared';

function cacheKey(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export class AiConfigurationError extends Error {}

export function createAiService(options: { library: Library; libraryDir: string; apiKey?: string; provider?: AnalysisProvider; intervalMs?: number; refreshModelsOnStart?: boolean }) {
  const { library, libraryDir } = options;
  const store = library.intelligence;
  const keyConfigured = !!options.apiKey?.trim();
  const provider = options.provider ?? (keyConfigured ? createGoProvider(options.apiKey!.trim()) : undefined);
  let catalog = [...MODELS];
  let active: Promise<void> | undefined;
  let requestAbort: AbortController | undefined;
  let interval: NodeJS.Timeout | undefined;
  let stopping = false;
  let retryAfter = 0;
  let attention = '';
  let catalogRefreshing = false;
  let activeEvaluation: EvaluationClaim | undefined;
  let activeModelId: string | undefined;

  function status(): AiStatus {
    const settings = store.settings();
    const evaluations = library.evaluations.counts();
    const blockers = activationBlockers(settings, keyConfigured, catalog);
    const analysis = !keyConfigured ? 'not_configured' : blockers.length ? 'paused' : retryAfter > Date.now() ? 'waiting' : 'running';
    return {
      settings, keyConfigured, models: catalog, usage: store.usage(), analysis, retryAt: analysis === 'waiting' ? new Date(retryAfter).toISOString() : null,
      queued: store.queueCount() + (evaluations.queued ?? 0), running: store.runningCount() + (evaluations.running ?? 0), failed: store.failedCount(),
      message: blockers[0] || (analysis === 'waiting' ? 'OpenCode Go rate-limited the request. Queued work will resume automatically after its retry delay.' : attention || 'New inspiration is processed automatically through OpenCode Go. Usage limits and billing are managed in your Go account.'),
    };
  }

  async function invoke(job: ClaimedJob | EvaluationClaim, modelId: string, text: string, image?: Uint8Array) {
    const model = modelById(modelId)!;
    const evaluation = !('kind' in job);
    const release = () => { if ('kind' in job) store.releaseJob(job); else library.evaluations.release(job); };
    if (stopping) { release(); return null; }
    if (model.trainsOnData && !store.settings().allowModelTraining) throw new ProviderError('privacy');
    assertInputBounds(model, 'kind' in job ? job.kind : 'analyze', text, image);
    const callId = 'kind' in job ? store.beginCall(job, modelId) : store.beginEvaluationCall(job, modelId);
    if (!callId) { release(); return null; }
    requestAbort = new AbortController();
    activeModelId = modelId;
    try {
      const result = await provider!.generate({ stage: 'kind' in job ? job.kind : 'analyze', modelId, sessionId: evaluation ? `eval-${cacheKey({ run: (job as EvaluationClaim).run_id, item: job.item_id })}` : job.item_id, text, image, variant: 'kind' in job && job.kind === 'write_prompt' ? job.variant : undefined, allowModelTraining: store.settings().allowModelTraining, signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(60_000)]) });
      const validCount = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
      store.settle(callId, validCount(result.inputTokens) ? result.inputTokens : null, validCount(result.outputTokens) ? result.outputTokens : null);
      attention = '';
      return result;
    } catch (error) {
      store.settle(callId, null, null);
      throw error;
    } finally { requestAbort = undefined; activeModelId = undefined; }
  }

  async function analyze(job: ClaimedJob, item: LibraryItem, settings: AiSettings) {
    const vocabulary = library.vocabulary.current();
    const text = analysisInput(item, false, vocabulary);
    const key = cacheKey({ stage: 'analyze', hash: store.contentHash(item.id), text, model: settings.analyzeModel, prompt: PROMPT_VERSION, vocabulary: vocabulary.revision });
    const cached = store.cachedAnalysis(key);
    if (cached) { store.completeAnalysis(job, JSON.parse(cached.result_json), settings.analyzeModel, key, PROMPT_VERSION, vocabulary.revision); return; }
    const asset = library.getAsset(item.id, 'preview');
    if (!asset) throw new Error('Missing preview.');
    const originalPreview = await readFile(resolve(libraryDir, asset.path));
    // At most 768x768 pixels plus <=60KB of text, independent of account usage limits.
    const image = await sharp(originalPreview).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
    store.setItemStatus(item.id, 'analyzing');
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await invoke(job, settings.analyzeModel, analysisInput(item, attempt > 0, vocabulary), image);
      if (!reply) return;
      const result = validateAnalysis(reply.output, item.palette, vocabulary.terms, hasMotionEvidence(item.facts));
      if (result && item.facts?.warnings.length) { result.review.needs_review = true; result.review.reasons = [...new Set([...result.review.reasons, ...item.facts.warnings])].slice(0, 10); }
      if (result) { store.completeAnalysis(job, result, settings.analyzeModel, key, PROMPT_VERSION, vocabulary.revision); return; }
    }
    store.fail(job, 'Analysis failed validation twice. Review this reference or retry with another model.');
  }

  async function writePrompt(job: ClaimedJob, item: LibraryItem, settings: AiSettings) {
    const analysis = item.intelligence.analysis;
    if (!analysis || analysis.id !== job.analysis_id) throw new Error('Missing active analysis.');
    const text = promptInput(item, analysis, false, job.variant);
    const key = cacheKey({ stage: 'write_prompt', analysis: analysis.id, text, variant: job.variant, model: settings.promptModel, version: WRITE_PROMPT_VERSION });
    const cached = store.cachedPrompt(key);
    if (cached) { store.completePrompt(job, cached.body, JSON.parse(cached.assumptions_json), settings.promptModel, key); return; }
    for (let attempt = 0; attempt < 2; attempt++) {
      // The second call uses the validated visual analysis; no need to transmit the image twice.
      const reply = await invoke(job, settings.promptModel, promptInput(item, analysis, attempt > 0, job.variant));
      if (!reply) return;
      const result = validatePrompt(reply.output, item.palette, job.variant);
      if (result) {
        const body = job.variant === 'agent' ? `${result.body}\n\n## Tokens\n\n\`\`\`css\n${paletteToCss(item.palette, analysis.palette_roles)}\`\`\`\n` : result.body;
        store.completePrompt(job, body, result.assumptions, settings.promptModel, key);
        return;
      }
    }
    store.fail(job, 'Prompt failed validation twice. Your analysis is saved; review before retrying.');
  }

  async function workOne() {
    store.recoverExpired();
    library.evaluations.recoverExpired();
    const settings = store.settings();
    if (stopping || catalogRefreshing || !provider || activationBlockers(settings, keyConfigured, catalog).length || retryAfter > Date.now()) return;
    retryAfter = 0;
    const job = store.claim();
    if (!job) { await workEvaluation(); return; }
    try {
      const item = library.getItem(job.item_id);
      if (!item) throw new Error('Missing reference.');
      if (job.kind === 'analyze') await analyze(job, item, settings);
      else await writePrompt(job, item, settings);
    } catch (error) {
      const message = requestFailure(error);
      // Only an explicit rejection is safe to retry automatically. Unknown outcomes are not replayed.
      if (error instanceof ProviderError && error.code === 'limits' && job.attempts < 3 && !stopping) store.releaseJob(job);
      else store.fail(job, message);
    }
  }

  function requestFailure(error: unknown): string {
    if (error instanceof ProviderError && error.code === 'limits') retryAfter = Math.max(retryAfter, Date.now() + (Number.isFinite(error.retryAfterMs) ? Math.min(7 * 86_400_000, Math.max(1000, error.retryAfterMs)) : 60_000));
    const message = error instanceof AiConfigurationError ? error.message : error instanceof ProviderError
      ? error.code === 'input' ? 'Analysis input exceeded local limits. No model request was sent.'
        : error.code === 'privacy' ? 'Provider-training consent is required for this model. No request was sent.'
          : error.code === 'limits' ? 'OpenCode Go rate-limited this request. DI will respect its retry delay; usage is managed in your Go account.'
            : error.code === 'credentials' ? 'Go rejected the key, subscription, privacy permissions, or model access. Check your Go account and server .env. New inspiration will still be attempted automatically.'
              : error.code === 'timeout' ? 'Request interrupted or timed out. Its outcome is unknown; review this reference before retrying. New inspiration will still be attempted automatically.'
                : 'Go request failed. Review this reference or retry; later inspiration will still be processed automatically.'
      : 'Could not complete analysis. Check the local preview and library storage before retrying.';
    if (!stopping) attention = message;
    return message;
  }

  async function workEvaluation() {
    const trial = library.evaluations.claim();
    if (!trial) return;
    activeEvaluation = trial;
    let started: number | undefined;
    try {
      if (!catalog.some((model) => model.id === trial.model_id && model.vision)) throw new AiConfigurationError('Trial model is no longer an available vision model. No request was sent.');
      if (modelById(trial.model_id)?.trainsOnData && !store.settings().allowModelTraining) throw new AiConfigurationError('This evaluation model requires provider-training consent. No request was sent.');
      const asset = library.getAsset(trial.item_id, 'preview');
      if (!asset) throw new AiConfigurationError('Evaluation preview is missing.');
      const image = await sharp(await readFile(resolve(libraryDir, asset.path))).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      const metadata = JSON.parse(trial.metadata_json) as TrialMetadata;
      if (createHash('sha256').update(image).digest('hex') !== metadata.imageSha256 || modelSystemPrompt(modelById(trial.model_id)!, 'analyze') !== metadata.system || PROMPT_VERSION !== metadata.promptVersion || JSON.stringify(modelById(trial.model_id)) !== JSON.stringify(metadata.model)) throw new AiConfigurationError('Frozen evaluation image, model configuration, or prompt changed. No request was sent; start a new run.');
      started = performance.now();
      const reply = await invoke(trial, trial.model_id, trial.input_text, image);
      if (!reply) return;
      const schemaValid = analysisResultSchema.safeParse(reply.output).success;
      // Do not repair motion predictions to "unknown": a benchmark must measure the model's labels.
      const result = validateAnalysis(reply.output, JSON.parse(trial.palette_json), (JSON.parse(trial.vocabulary_json) as VocabularyState).terms, true);
      library.evaluations.finish(trial, result, schemaValid, Math.round(performance.now() - started), result ? null : 'Output failed schema, palette, or vocabulary validation.', reply.output);
    } catch (error) {
      const cancelled = library.evaluations.run(trial.run_id)?.status === 'cancelled';
      if (!cancelled) {
        const message = requestFailure(error);
        library.evaluations.finish(trial, null, null, started === undefined ? null : Math.round(performance.now() - started), message);
      }
    } finally { activeEvaluation = undefined; }
  }

  function runOnce(): Promise<void> {
    active ??= workOne().finally(() => { active = undefined; });
    return active;
  }
  function wake() {
    if (interval && !stopping) void runOnce().catch(() => { attention = 'Worker paused after a storage error. Restart after checking the library.'; stopping = true; });
  }

  async function refreshModels() {
    const next = await refreshCatalog();
    if (stopping) throw new AiConfigurationError('Server is stopping.');
    catalog = next;
    if (attention.startsWith('Catalog refresh unavailable;')) attention = '';
    const settings = store.settings();
    if ([settings.analyzeModel, settings.promptModel, ...(activeModelId ? [activeModelId] : [])].some((id) => !catalog.some((model) => model.id === id && model.vision))) {
      requestAbort?.abort();
      attention = 'AI paused: a selected model is no longer confirmed as an available Go vision model. Choose another vision model.';
    }
    return status();
  }

  return {
    status, runOnce,
    updateSettings(input: unknown) {
      const parsed = aiSettingsSchema.safeParse(input);
      if (!parsed.success) throw new AiConfigurationError('Invalid AI settings.');
      const settings = parsed.data;
      const selected = [modelById(settings.analyzeModel), modelById(settings.promptModel)];
      if (selected.some((model) => !model?.vision)) throw new AiConfigurationError('Both roles require a confirmed OpenCode Go image-input model.');
      const blockers = activationBlockers(settings, keyConfigured, catalog);
      if (settings.allowImageSharing && blockers.length) throw new AiConfigurationError(blockers.join(' '));
      store.setSettings(settings);
      if (!settings.allowImageSharing || !settings.allowModelTraining && activeModelId && modelById(activeModelId)?.trainsOnData) requestAbort?.abort();
      attention = '';
      wake();
      return status();
    },
    refreshModels,
    async startEvaluation(name: string, modelIds: string[], sampleIds: string[]) {
      if (modelIds.length < 2 || modelIds.length > 4 || new Set(modelIds).size !== modelIds.length || !sampleIds.length || sampleIds.length > 30 || new Set(sampleIds).size !== sampleIds.length) throw new AiConfigurationError('Choose 2–4 distinct models and 1–30 distinct hand-labeled references.');
      const config = store.settings();
      if (!provider || activationBlockers(config, keyConfigured, catalog).length) throw new AiConfigurationError('Approve image sharing and choose available models before starting a model evaluation.');
      const selected = modelIds.map((id) => catalog.find((model) => model.id === id && model.vision));
      if (selected.some((model) => !model)) throw new AiConfigurationError('Choose available vision models.');
      if (selected.some((model) => model?.trainsOnData) && !config.allowModelTraining) throw new AiConfigurationError('Contributor evaluation requires separate provider-training consent.');
      const vocabulary = library.vocabulary.current();
      const samples = library.evaluations.samples();
      const inputs: TrialInput[] = [];
      for (const id of sampleIds) {
        const sample = samples.find((sample) => sample.itemId === id), item = library.getItem(id);
        if (!sample || !item) throw new AiConfigurationError('Every evaluation reference must have saved hand labels.');
        for (const facet of FACETS) if (sample.labels[facet].some((value) => !vocabulary.terms[facet].includes(value))) throw new AiConfigurationError('Update retired hand labels before starting the evaluation.');
        // Never leak accepted labels or ground-truth annotations to the model being measured.
        const blind = { ...item, intelligence: { ...item.intelligence, labels: [] } };
        const asset = library.getAsset(id, 'preview');
        if (!asset) throw new AiConfigurationError('Evaluation preview is missing.');
        const image = await sharp(await readFile(resolve(libraryDir, asset.path))).resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
        const imageSha256 = createHash('sha256').update(image).digest('hex');
        const input = analysisInput(blind, false, vocabulary);
        for (const modelId of modelIds) {
          const model = modelById(modelId)!;
          try { assertInputBounds(model, 'analyze', input, image); }
          catch { throw new AiConfigurationError('Evaluation input exceeded local limits. No request was sent.'); }
          inputs.push({ itemId: id, title: item.title, modelId, input, palette: item.palette, vocabulary, labels: sample.labels, scoredFacets: sample.scoredFacets, metadata: { imageSha256, promptVersion: PROMPT_VERSION, system: modelSystemPrompt(model, 'analyze'), model, sampleVersion: sample.version, maxOutputTokens: MAX_OUTPUT_TOKENS } });
        }
      }
      const run = library.evaluations.createRun(name, inputs);
      wake(); return run;
    },
    cancelEvaluation(runId: string) { library.evaluations.cancel(runId); if (activeEvaluation?.run_id === runId) requestAbort?.abort(); return library.evaluations.run(runId); },
    generatePrompt(itemId: string, variant: PromptVariant) {
      const config = store.settings();
      if (activationBlockers(config, keyConfigured, catalog).length) throw new AiConfigurationError('Approve image sharing and choose available models before generating a prompt variant.');
      store.queuePrompt(itemId, variant); wake();
    },
    retry(itemId: string) {
      const config = store.settings();
      if (activationBlockers(config, keyConfigured, catalog).length) throw new AiConfigurationError('Approve image sharing and choose available models before requesting analysis.');
      store.requeue(itemId); wake();
    },
    start() {
      if (interval) return;
      interval = setInterval(wake, options.intervalMs ?? 750);
      interval.unref();
      if (options.refreshModelsOnStart) {
        catalogRefreshing = true;
        void refreshModels().catch(() => { if (!stopping) attention = 'Catalog refresh unavailable; showing the reviewed vision-model snapshot. Refresh again to check current Go availability.'; })
          .finally(() => { catalogRefreshing = false; wake(); });
      } else wake();
    },
    async stop() {
      stopping = true;
      if (interval) clearInterval(interval);
      requestAbort?.abort();
      await active;
    },
  };
}

export type AiService = ReturnType<typeof createAiService>;
