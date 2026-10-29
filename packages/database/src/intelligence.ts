import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { aiSettingsSchema, canonicalLabel, FACETS, PROMPT_VARIANTS } from '@design-index/shared';
import type { AiSettings, AnalysisResult, Facet, ItemIntelligence, ItemLabel, PromptHistory, PromptJob, PromptVariant, SavedPrompt } from '@design-index/shared';
import type { VocabularyStore } from './vocabulary.js';
import type { EvaluationClaim } from './evaluations.js';
import { ConflictError } from './errors.js';
export { ConflictError } from './errors.js';

export interface ClaimedJob {
  id: string; item_id: string; kind: 'analyze' | 'write_prompt'; attempts: number;
  run_id: string; analysis_id: string | null; lease_token: string; lease_until: string;
  variant: PromptVariant;
}
type AnalysisRow = { id: string; model_id: string; result_json: string; created_at: string; vocabulary_revision: number };
type PromptRow = { id: string; analysis_id: string; model_id: string; body: string; version: number; edited_by_user: number; assumptions_json: string; variant: PromptVariant; created_at: string };

export function createIntelligenceStore(sqlite: Database.Database, vocabulary: VocabularyStore) {
  function settings(): AiSettings {
    const row = sqlite.prepare('SELECT json FROM ai_settings WHERE id=1').get() as { json: string };
    return aiSettingsSchema.parse(JSON.parse(row.json));
  }
  function setSettings(value: AiSettings) { sqlite.prepare('UPDATE ai_settings SET json=? WHERE id=1').run(JSON.stringify(value)); }
  function mapPrompt(row: PromptRow): SavedPrompt {
    return { id: row.id, body: row.body, version: row.version, editedByUser: !!row.edited_by_user, assumptions: JSON.parse(row.assumptions_json), modelId: row.model_id, analysisId: row.analysis_id, variant: row.variant, createdAt: row.created_at };
  }
  function prompt(itemId: string, variant: PromptVariant = 'agent'): SavedPrompt | null {
    const row = sqlite.prepare('SELECT * FROM prompts WHERE item_id=? AND variant=? AND (edited_by_user=1 OR analysis_id=(SELECT active_analysis_id FROM items WHERE id=?)) ORDER BY edited_by_user DESC,version DESC LIMIT 1').get(itemId, variant, itemId) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }
  function state(itemId: string): ItemIntelligence {
    const row = sqlite.prepare('SELECT a.* FROM analyses a JOIN items i ON i.active_analysis_id=a.id WHERE i.id=?').get(itemId) as AnalysisRow | undefined;
    const result = row ? JSON.parse(row.result_json) as AnalysisResult : null;
    const terms = vocabulary.current();
    const labels: ItemLabel[] = [];
    if (result) for (const facet of FACETS) for (const suggestion of result.labels[facet]) {
      const value = canonicalLabel(terms, facet, suggestion.value);
      const prior = labels.find((label) => label.facet === facet && label.value === value);
      if (prior) prior.confidence = Math.max(prior.confidence, suggestion.confidence);
      else labels.push({ ...suggestion, value, facet, origin: 'model', state: 'suggested' });
    }
    const overrides = sqlite.prepare('SELECT facet,value,state FROM label_overrides WHERE item_id=?').all(itemId) as { facet: Facet; value: string; state: 'accepted' | 'rejected' }[];
    for (const override of overrides) {
      const index = labels.findIndex((label) => label.facet === override.facet && label.value === override.value);
      const manual: ItemLabel = { ...override, confidence: 1, origin: 'user' };
      if (index >= 0) labels[index] = manual;
      else labels.push(manual);
    }
    const error = sqlite.prepare("SELECT error FROM jobs WHERE item_id=? AND status='failed' AND (kind='analyze' OR variant='agent') ORDER BY created_at DESC LIMIT 1").get(itemId) as { error: string | null } | undefined;
    const prompts = Object.fromEntries(PROMPT_VARIANTS.map((variant) => [variant, prompt(itemId, variant)])) as ItemIntelligence['prompts'];
    const promptJobs: ItemIntelligence['promptJobs'] = {};
    for (const job of sqlite.prepare("SELECT variant,status,error FROM jobs WHERE item_id=? AND kind='write_prompt'").all(itemId) as (PromptJob & { variant: PromptVariant })[]) promptJobs[job.variant] = { status: job.status, error: job.error };
    return { analysis: result && row ? { ...result, id: row.id, modelId: row.model_id, createdAt: row.created_at, vocabularyRevision: row.vocabulary_revision } : null, labels, prompt: prompts.agent, prompts, promptJobs, analysisError: error?.error ?? null };
  }
  function reindex(itemId: string) {
    const info = state(itemId);
    const text = [info.analysis?.summary, info.analysis?.type_notes, info.analysis?.motion_notes,
      ...(info.analysis?.free_tags ?? []), ...info.labels.filter((label) => label.state !== 'rejected').map((label) => label.value), ...Object.values(info.prompts).map((prompt) => prompt?.body)].filter(Boolean).join(' ');
    sqlite.prepare('UPDATE items SET search_text=? WHERE id=?').run(text, itemId);
  }
  function assertLease(job: ClaimedJob) {
    const owned = sqlite.prepare("SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(job.id, job.lease_token, new Date().toISOString());
    if (!owned) throw new ConflictError('Job lease expired.');
  }
  function usage(month = new Date().toISOString().slice(0, 7)) {
    const row = sqlite.prepare(`SELECT coalesce(sum(input_tokens),0) AS inputTokens,coalesce(sum(output_tokens),0) AS outputTokens,
      sum(CASE WHEN state='uncertain' THEN 1 ELSE 0 END) AS uncertainCalls,count(*) AS calls FROM model_calls WHERE month=?`).get(month) as { inputTokens: number; outputTokens: number; uncertainCalls: number | null; calls: number };
    return { ...row, month, uncertainCalls: row.uncertainCalls ?? 0 };
  }
  function nextVersion(itemId: string, variant: PromptVariant = 'agent'): number {
    return (sqlite.prepare('SELECT coalesce(max(version),0)+1 AS version FROM prompts WHERE item_id=? AND variant=?').get(itemId, variant) as { version: number }).version;
  }
  function beginCall(jobId: string, itemId: string, stage: string, variant: PromptVariant, modelId: string, assertOwner: () => void): string | null {
    return sqlite.transaction(() => {
      assertOwner();
      const config = settings();
      if (!config.allowImageSharing) return null;
      const id = randomUUID();
      // Legacy state "reserved" now means an in-flight request record, never held funds.
      sqlite.prepare("INSERT INTO model_calls(id,job_id,item_id,stage,model_id,month,created_at,reserved_usd,state,provider,variant) VALUES(?,?,?,?,?,?,?,?,'reserved','opencode-go',?)")
        .run(id, jobId, itemId, stage, modelId, new Date().toISOString().slice(0, 7), new Date().toISOString(), 0, variant);
      return id;
    })();
  }

  return {
    settings, setSettings, state, prompt, usage,
    reindexAll() { for (const row of sqlite.prepare('SELECT id FROM items').all() as { id: string }[]) reindex(row.id); },
    promptHistory(itemId: string, variant: PromptVariant, limit = 20, offset = 0): PromptHistory {
      const rows = sqlite.prepare('SELECT * FROM prompts WHERE item_id=? AND variant=? ORDER BY version DESC LIMIT ? OFFSET ?').all(itemId, variant, limit, offset) as PromptRow[];
      const total = (sqlite.prepare('SELECT count(*) AS total FROM prompts WHERE item_id=? AND variant=?').get(itemId, variant) as { total: number }).total;
      return { variant, current: prompt(itemId, variant), versions: rows.map(mapPrompt), total, limit, offset };
    },
    queuePrompt(itemId: string, variant: PromptVariant) {
      sqlite.transaction(() => {
        const row = sqlite.prepare('SELECT active_analysis_id FROM items WHERE id=?').get(itemId) as { active_analysis_id: string | null } | undefined;
        if (!row?.active_analysis_id) throw new ConflictError('Analyze this reference before generating a prompt variant.');
        if (sqlite.prepare("SELECT 1 FROM jobs WHERE item_id=? AND (kind='analyze' AND status IN ('queued','running') OR kind='write_prompt' AND variant=? AND status IN ('queued','running'))").get(itemId, variant)) throw new ConflictError('This analysis or prompt variant is already queued/running.');
        sqlite.prepare("INSERT INTO jobs(id,item_id,kind,status,created_at,run_id,analysis_id,variant) VALUES(?,?,'write_prompt','queued',?,?,?,?) ON CONFLICT(item_id,kind,variant) DO UPDATE SET status='queued',attempts=0,created_at=excluded.created_at,run_id=excluded.run_id,analysis_id=excluded.analysis_id,error=NULL,lease_token=NULL,lease_until=NULL")
          .run(randomUUID(), itemId, new Date().toISOString(), randomUUID(), row.active_analysis_id, variant);
        if (variant === 'agent') sqlite.prepare("UPDATE items SET status='writing_prompt' WHERE id=?").run(itemId);
      })();
    },
    queueCount: () => (sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE status='queued'").get() as { count: number }).count,
    runningCount: () => (sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE status='running'").get() as { count: number }).count,
    failedCount: () => (sqlite.prepare("SELECT count(*) AS count FROM jobs WHERE status='failed'").get() as { count: number }).count,
    requeue(itemId: string) {
      sqlite.transaction(() => {
        if (!sqlite.prepare('SELECT 1 FROM items WHERE id=?').get(itemId)) throw new ConflictError('Reference not found.');
        if (sqlite.prepare("SELECT 1 FROM jobs WHERE item_id=? AND status='running'").get(itemId)) throw new ConflictError('Analysis is already running.');
        sqlite.prepare('DELETE FROM jobs WHERE item_id=?').run(itemId);
        sqlite.prepare("INSERT INTO jobs(id,item_id,kind,status,created_at,run_id) VALUES(?,?,'analyze','queued',?,?)").run(randomUUID(), itemId, new Date().toISOString(), randomUUID());
        sqlite.prepare("UPDATE items SET status='queued' WHERE id=?").run(itemId);
      })();
    },
    claim(): ClaimedJob | undefined {
      return sqlite.transaction(() => {
        const id = (sqlite.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined)?.id;
        if (!id) return undefined;
        return sqlite.prepare("UPDATE jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=?,error=NULL WHERE id=? AND status='queued' RETURNING *")
          .get(randomUUID(), new Date(Date.now() + 120_000).toISOString(), id) as ClaimedJob;
      })();
    },
    recoverExpired() {
      sqlite.transaction(() => {
        const expired = sqlite.prepare("SELECT id,item_id FROM jobs WHERE status='running' AND lease_until<=?").all(new Date().toISOString()) as { id: string; item_id: string }[];
        for (const job of expired) {
          sqlite.prepare("UPDATE model_calls SET state='uncertain' WHERE job_id=? AND state='reserved'").run(job.id);
          sqlite.prepare("UPDATE jobs SET status='failed',error='Interrupted analysis. Request outcome is unknown; review before retrying.',lease_token=NULL,lease_until=NULL WHERE id=?").run(job.id);
          sqlite.prepare("UPDATE items SET status='needs_review' WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND (kind='analyze' OR variant='agent'))").run(job.item_id, job.id);
        }
      })();
    },
    beginCall(job: ClaimedJob, modelId: string): string | null {
      return beginCall(job.id, job.item_id, job.kind, job.variant, modelId, () => {
        assertLease(job);
        sqlite.prepare('UPDATE jobs SET lease_until=? WHERE id=? AND lease_token=?').run(new Date(Date.now() + 120_000).toISOString(), job.id, job.lease_token);
      });
    },
    beginEvaluationCall(trial: EvaluationClaim, modelId: string): string | null {
      return beginCall(trial.id, trial.item_id, 'evaluation', 'agent', modelId, () => {
        if (!sqlite.prepare("SELECT 1 FROM evaluation_trials t JOIN evaluation_runs r ON r.id=t.run_id WHERE t.id=? AND t.status='running' AND t.lease_token=? AND t.lease_until>? AND r.status!='cancelled'").get(trial.id, trial.lease_token, new Date().toISOString())) throw new ConflictError('Evaluation lease expired or run cancelled.');
      });
    },
    settle(callId: string, inputTokens: number | null, outputTokens: number | null) {
      sqlite.prepare("UPDATE model_calls SET state=?,input_tokens=?,output_tokens=? WHERE id=? AND state IN ('reserved','uncertain')")
        .run(inputTokens === null || outputTokens === null ? 'uncertain' : 'completed', inputTokens, outputTokens, callId);
    },
    releaseJob(job: ClaimedJob) {
      sqlite.transaction(() => {
        const changed = sqlite.prepare("UPDATE jobs SET status='queued',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(job.id, job.lease_token);
        if (changed.changes && (job.kind === 'analyze' || job.variant === 'agent')) sqlite.prepare('UPDATE items SET status=? WHERE id=?').run(job.kind === 'analyze' ? 'queued' : 'writing_prompt', job.item_id);
      })();
    },
    fail(job: ClaimedJob, message: string) {
      sqlite.transaction(() => {
        const changed = sqlite.prepare("UPDATE jobs SET status='failed',error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(message, job.id, job.lease_token);
        if (changed.changes && (job.kind === 'analyze' || job.variant === 'agent')) sqlite.prepare("UPDATE items SET status='needs_review' WHERE id=?").run(job.item_id);
      })();
    },
    cachedAnalysis(cacheKey: string) { return sqlite.prepare('SELECT id,result_json FROM analyses WHERE cache_key=?').get(cacheKey) as { id: string; result_json: string } | undefined; },
    completeAnalysis(job: ClaimedJob, result: AnalysisResult, modelId: string, cacheKey: string, promptVersion: string, vocabularyRevision = 1): string {
      return sqlite.transaction(() => {
        assertLease(job);
        const cached = sqlite.prepare('SELECT id FROM analyses WHERE cache_key=?').get(cacheKey) as { id: string } | undefined;
        const id = cached?.id ?? randomUUID();
        if (!cached) sqlite.prepare("INSERT INTO analyses(id,item_id,model_id,prompt_version,cache_key,result_json,created_at,provider,vocabulary_revision) VALUES(?,?,?,?,?,?,?,'opencode-go',?)").run(id, job.item_id, modelId, promptVersion, cacheKey, JSON.stringify(result), new Date().toISOString(), vocabularyRevision);
        sqlite.prepare("UPDATE items SET active_analysis_id=?,status='writing_prompt' WHERE id=?").run(id, job.item_id);
        sqlite.prepare("UPDATE jobs SET status='completed',lease_token=NULL,lease_until=NULL WHERE id=?").run(job.id);
        sqlite.prepare("INSERT INTO jobs(id,item_id,kind,status,created_at,run_id,analysis_id,variant) VALUES(?,?,'write_prompt','queued',?,?,?,'agent') ON CONFLICT(item_id,kind,variant) DO UPDATE SET status='queued',attempts=0,created_at=excluded.created_at,run_id=excluded.run_id,analysis_id=excluded.analysis_id,error=NULL,lease_token=NULL,lease_until=NULL")
          .run(randomUUID(), job.item_id, new Date().toISOString(), job.run_id, id);
        reindex(job.item_id);
        return id;
      })();
    },
    cachedPrompt(cacheKey: string) { return sqlite.prepare('SELECT body,assumptions_json FROM prompts WHERE cache_key=?').get(cacheKey) as { body: string; assumptions_json: string } | undefined; },
    completePrompt(job: ClaimedJob, body: string, assumptions: string[], modelId: string, cacheKey: string) {
      sqlite.transaction(() => {
        assertLease(job);
        if (!job.analysis_id) throw new ConflictError('Analysis is missing.');
        const existing = sqlite.prepare('SELECT id FROM prompts WHERE cache_key=?').get(cacheKey);
        if (!existing) sqlite.prepare("INSERT INTO prompts(id,item_id,analysis_id,model_id,body,assumptions_json,version,cache_key,created_at,provider,variant) VALUES(?,?,?,?,?,?,?,?,?,'opencode-go',?)")
          .run(randomUUID(), job.item_id, job.analysis_id, modelId, body, JSON.stringify(assumptions), nextVersion(job.item_id, job.variant), cacheKey, new Date().toISOString(), job.variant);
        const analysis = state(job.item_id).analysis;
        if (job.variant === 'agent') sqlite.prepare('UPDATE items SET status=? WHERE id=?').run(analysis?.review.needs_review ? 'needs_review' : 'ready', job.item_id);
        sqlite.prepare("UPDATE jobs SET status='completed',lease_token=NULL,lease_until=NULL,error=NULL WHERE id=?").run(job.id);
        reindex(job.item_id);
      })();
    },
    editLabel(itemId: string, facet: Facet, value: string, status: 'accepted' | 'rejected') {
      sqlite.transaction(() => {
        sqlite.prepare('INSERT INTO label_overrides VALUES(?,?,?,?) ON CONFLICT(item_id,facet,value) DO UPDATE SET state=excluded.state').run(itemId, facet, canonicalLabel(vocabulary.current(), facet, value), status);
        reindex(itemId);
      })();
    },
    editPrompt(itemId: string, body: string, baseVersion: number, variant: PromptVariant = 'agent'): SavedPrompt {
      return sqlite.transaction(() => {
        const current = prompt(itemId, variant);
        if (!current || current.version !== baseVersion) throw new ConflictError('Prompt changed. Reload it before saving.');
        sqlite.prepare('INSERT INTO prompts(id,item_id,analysis_id,model_id,body,assumptions_json,edited_by_user,version,created_at,provider,variant) SELECT ?,item_id,analysis_id,model_id,?,assumptions_json,1,?,?,provider,variant FROM prompts WHERE id=?')
          .run(randomUUID(), body, nextVersion(itemId, variant), new Date().toISOString(), current.id);
        reindex(itemId);
        return prompt(itemId, variant)!;
      })();
    },
    restorePrompt(itemId: string, revisionId: string, variant: PromptVariant, baseVersion: number): SavedPrompt {
      return sqlite.transaction(() => {
        const current = prompt(itemId, variant);
        if ((current?.version ?? 0) !== baseVersion) throw new ConflictError('Prompt changed. Reload it before restoring a revision.');
        const source = sqlite.prepare('SELECT * FROM prompts WHERE id=? AND item_id=? AND variant=?').get(revisionId, itemId, variant) as PromptRow | undefined;
        if (!source) throw new ConflictError('Prompt revision not found for this item and variant.');
        sqlite.prepare("INSERT INTO prompts(id,item_id,analysis_id,model_id,body,assumptions_json,edited_by_user,version,created_at,provider,variant) SELECT ?,item_id,analysis_id,model_id,body,assumptions_json,1,?,?,provider,variant FROM prompts WHERE id=?")
          .run(randomUUID(), nextVersion(itemId, variant), new Date().toISOString(), source.id);
        reindex(itemId);
        return prompt(itemId, variant)!;
      })();
    },
    setItemStatus(itemId: string, status: 'analyzing' | 'writing_prompt') { sqlite.prepare('UPDATE items SET status=? WHERE id=?').run(status, itemId); },
    contentHash(itemId: string): string { return (sqlite.prepare('SELECT content_hash FROM items WHERE id=?').get(itemId) as { content_hash: string }).content_hash; },
  };
}
