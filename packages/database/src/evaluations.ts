import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalLabel, evaluationSampleSchema, evaluationScores, FACETS, scoreEvaluation } from '@design-index/shared';
import type { AiModel, AnalysisResult, EvaluationRun, EvaluationSample, EvaluationScores, EvaluationSummary, EvaluationTrial, Facet, PaletteColor, VocabularyState, VocabularyTerms } from '@design-index/shared';
import type { VocabularyStore } from './vocabulary.js';
import { ConflictError } from './errors.js';

export interface EvaluationClaim { id: string; run_id: string; item_id: string; model_id: string; input_text: string; palette_json: string; vocabulary_json: string; gold_json: string; facets_json: string; metadata_json: string; lease_token: string }
export interface TrialMetadata { imageSha256: string; system: string; promptVersion: string; model: AiModel; sampleVersion: number; maxOutputTokens: number }
export interface TrialInput { itemId: string; modelId: string; title: string; input: string; palette: PaletteColor[]; vocabulary: VocabularyState; labels: VocabularyTerms; scoredFacets: Facet[]; metadata: TrialMetadata }
export function createEvaluationStore(sqlite: Database.Database, vocabulary: VocabularyStore) {
  function samples(): EvaluationSample[] {
    const state = vocabulary.current();
    return (sqlite.prepare('SELECT s.*,i.title FROM evaluation_samples s JOIN items i ON i.id=s.item_id ORDER BY i.captured_at,s.item_id').all() as { item_id: string; title: string; labels_json: string; facets_json: string; note: string; version: number }[]).map((row) => {
      const labels = JSON.parse(row.labels_json) as VocabularyTerms;
      for (const facet of FACETS) labels[facet] = [...new Set(labels[facet].map((value) => canonicalLabel(state, facet, value)))];
      return { itemId: row.item_id, title: row.title, previewUrl: `/api/items/${row.item_id}/assets/preview`, labels, scoredFacets: JSON.parse(row.facets_json), note: row.note, version: row.version };
    });
  }
  function updateRun(id: string) {
    sqlite.prepare("UPDATE evaluation_runs SET status='completed' WHERE id=? AND status!='cancelled' AND NOT EXISTS(SELECT 1 FROM evaluation_trials WHERE run_id=? AND status IN ('queued','running'))").run(id, id);
  }
  function recoverExpired() {
    sqlite.transaction(() => {
      const expired = sqlite.prepare("SELECT id,run_id FROM evaluation_trials WHERE status='running' AND lease_until<=?").all(new Date().toISOString()) as { id: string; run_id: string }[];
      for (const trial of expired) {
        sqlite.prepare("UPDATE model_calls SET state='uncertain' WHERE job_id=? AND state='reserved'").run(trial.id);
        sqlite.prepare("UPDATE evaluation_trials SET status='failed',valid=0,error='Interrupted trial; request outcome is unknown. Review before retrying.',lease_token=NULL,lease_until=NULL WHERE id=?").run(trial.id);
        updateRun(trial.run_id);
      }
    })();
  }
  function run(id: string): EvaluationRun | undefined {
    const row = sqlite.prepare('SELECT * FROM evaluation_runs WHERE id=?').get(id) as { id: string; name: string; status: EvaluationRun['status']; created_at: string; vocabulary_revision: number; model_ids_json: string; sample_count: number } | undefined;
    if (!row) return undefined;
    const rows = sqlite.prepare(`SELECT t.*,c.input_tokens,c.output_tokens,c.state AS call_state FROM evaluation_trials t LEFT JOIN model_calls c ON c.job_id=t.id WHERE t.run_id=? ORDER BY t.model_id,t.item_id`).all(id) as (EvaluationClaim & { title: string; status: EvaluationTrial['status']; schema_valid: number | null; valid: number | null; result_json: string | null; latency_ms: number | null; error: string | null; input_tokens: number | null; output_tokens: number | null; call_state: string | null })[];
    const trials: EvaluationTrial[] = rows.map((trial) => {
      const result = trial.result_json ? JSON.parse(trial.result_json) as AnalysisResult : null;
      const scores = ['completed', 'failed'].includes(trial.status) ? scoreEvaluation(JSON.parse(trial.gold_json), JSON.parse(trial.facets_json), result) : null;
      return { id: trial.id, runId: trial.run_id, itemId: trial.item_id, modelId: trial.model_id, title: trial.title, status: trial.status, schemaValid: trial.schema_valid === null ? null : !!trial.schema_valid, valid: trial.valid === null ? null : !!trial.valid, result, scores, latencyMs: trial.latency_ms, error: trial.error, inputTokens: trial.input_tokens ?? null, outputTokens: trial.output_tokens ?? null, attempted: trial.call_state !== null };
    });
    const modelIds = JSON.parse(row.model_ids_json) as string[];
    const summaries: EvaluationSummary[] = modelIds.map((modelId) => {
      const group = trials.filter((trial) => trial.modelId === modelId);
      const scores = group.flatMap((trial) => trial.scores ? [trial.scores] : []);
      const sum = (field: keyof Pick<EvaluationScores, 'truePositives' | 'falsePositives' | 'falseNegatives' | 'exactFacets' | 'scoredFacets'>) => scores.reduce((total, score) => total + score[field], 0);
      const latencies = group.flatMap((trial) => trial.latencyMs === null ? [] : [trial.latencyMs]);
      return { modelId, trials: group.length, finished: group.filter((trial) => ['completed', 'failed', 'cancelled'].includes(trial.status)).length, attempted: group.filter((trial) => trial.attempted).length, responses: group.filter((trial) => trial.schemaValid !== null).length, valid: group.filter((trial) => trial.valid).length, schemaValid: group.filter((trial) => trial.schemaValid).length, averageLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, inputTokens: group.reduce((sum, trial) => sum + (trial.inputTokens ?? 0), 0), outputTokens: group.reduce((sum, trial) => sum + (trial.outputTokens ?? 0), 0), scores: evaluationScores(sum('truePositives'), sum('falsePositives'), sum('falseNegatives'), sum('exactFacets'), sum('scoredFacets')) };
    });
    return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, vocabularyRevision: row.vocabulary_revision, sampleCount: row.sample_count, modelIds, summaries, trials };
  }
  return {
    samples, run, recoverExpired,
    counts() { return sqlite.prepare("SELECT sum(status='queued') AS queued,sum(status='running') AS running FROM evaluation_trials").get() as { queued: number | null; running: number | null }; },
    report(id: string) {
      const result = run(id); if (!result) return undefined;
      const snapshots = (sqlite.prepare('SELECT * FROM evaluation_trials WHERE run_id=? ORDER BY model_id,item_id').all(id) as (EvaluationClaim & { raw_output_json: string | null })[]).map((trial) => ({
        trialId: trial.id, itemId: trial.item_id, modelId: trial.model_id, input: JSON.parse(trial.input_text), vocabulary: JSON.parse(trial.vocabulary_json), palette: JSON.parse(trial.palette_json), expectedLabels: JSON.parse(trial.gold_json), scoredFacets: JSON.parse(trial.facets_json), metadata: JSON.parse(trial.metadata_json), rawOutput: trial.raw_output_json ? JSON.parse(trial.raw_output_json) : null,
      }));
      return { version: 1, run: result, snapshots, scoring: 'Micro-averaged label precision/recall/F1 and exact facet agreement over explicitly scored facets. Failed/invalid finished trials count as missing predictions. Cancelled/pending trials are excluded. Motion labels are scored without image-only repair. Images are referenced by SHA-256 of the normalized 768px WebP, not embedded.' };
    },
    saveSample(itemId: string, labels: VocabularyTerms, scoredFacets: Facet[], note: string, baseVersion: number) {
      if (!evaluationSampleSchema.safeParse({ labels, scoredFacets, note, baseVersion }).success) throw new ConflictError('Save explicit scored facets, up to 10 unique hand labels per facet, and the current entry version.');
      sqlite.transaction(() => {
        if (!sqlite.prepare('SELECT 1 FROM items WHERE id=?').get(itemId)) throw new ConflictError('Reference not found.');
        const current = sqlite.prepare('SELECT version FROM evaluation_samples WHERE item_id=?').get(itemId) as { version: number } | undefined;
        if ((current?.version ?? 0) !== baseVersion) throw new ConflictError('Hand labels changed. Reload before saving.');
        if (!current && (sqlite.prepare('SELECT count(*) AS count FROM evaluation_samples').get() as { count: number }).count >= 30) throw new ConflictError('The benchmark set is limited to 30 references. Remove an entry before adding another.');
        const terms = vocabulary.current();
        for (const facet of FACETS) if (labels[facet].some((value) => !terms.terms[facet].includes(value))) throw new ConflictError('Hand labels must use the active vocabulary.');
        sqlite.prepare('INSERT INTO evaluation_samples VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET labels_json=excluded.labels_json,facets_json=excluded.facets_json,note=excluded.note,version=excluded.version').run(itemId, JSON.stringify(labels), JSON.stringify(scoredFacets), note, baseVersion + 1);
      })();
      return samples();
    },
    removeSample(itemId: string, version: number) {
      const result = sqlite.prepare('DELETE FROM evaluation_samples WHERE item_id=? AND version=?').run(itemId, version);
      if (!result.changes) throw new ConflictError('Hand-label entry changed or no longer exists. Reload before removing.');
    },
    listRuns() { return (sqlite.prepare('SELECT id FROM evaluation_runs ORDER BY created_at DESC,id DESC LIMIT 20').all() as { id: string }[]).map(({ id }) => ({ ...run(id)!, trials: [] })); },
    createRun(name: string, inputs: TrialInput[]): EvaluationRun {
      return sqlite.transaction(() => {
        if (sqlite.prepare("SELECT 1 FROM evaluation_runs WHERE status IN ('queued','running')").get()) throw new ConflictError('An evaluation is already queued/running. Complete or cancel it first.');
        const id = randomUUID(), models = [...new Set(inputs.map((input) => input.modelId))];
        sqlite.prepare("INSERT INTO evaluation_runs VALUES(?,?,'queued',?,?,?,?,?)").run(id, name, new Date().toISOString(), inputs[0]!.vocabulary.revision, JSON.stringify(models), new Set(inputs.map((input) => input.itemId)).size, 0);
        const insert = sqlite.prepare("INSERT INTO evaluation_trials(id,run_id,item_id,model_id,title,status,input_text,palette_json,vocabulary_json,gold_json,facets_json,metadata_json) VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?)");
        for (const input of inputs) insert.run(randomUUID(), id, input.itemId, input.modelId, input.title, input.input, JSON.stringify(input.palette), JSON.stringify(input.vocabulary), JSON.stringify(input.labels), JSON.stringify(input.scoredFacets), JSON.stringify(input.metadata));
        return run(id)!;
      })();
    },
    claim(): EvaluationClaim | undefined {
      return sqlite.transaction(() => {
        recoverExpired();
        const candidate = sqlite.prepare("SELECT t.id FROM evaluation_trials t JOIN evaluation_runs r ON r.id=t.run_id WHERE t.status='queued' AND r.status IN ('queued','running') ORDER BY r.created_at,t.id LIMIT 1").get() as { id: string } | undefined;
        if (!candidate) return undefined;
        const trial = sqlite.prepare("UPDATE evaluation_trials SET status='running',lease_token=?,lease_until=? WHERE id=? RETURNING *").get(randomUUID(), new Date(Date.now() + 120_000).toISOString(), candidate.id) as EvaluationClaim;
        sqlite.prepare("UPDATE evaluation_runs SET status='running' WHERE id=?").run(trial.run_id);
        return trial;
      })();
    },
    release(trial: EvaluationClaim) { sqlite.prepare("UPDATE evaluation_trials SET status='queued',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(trial.id, trial.lease_token); },
    finish(trial: EvaluationClaim, result: AnalysisResult | null, schemaValid: boolean | null, latencyMs: number | null, error: string | null, rawOutput: unknown = null) {
      sqlite.transaction(() => {
        sqlite.prepare("UPDATE evaluation_trials SET status=?,result_json=?,schema_valid=?,valid=?,latency_ms=?,error=?,raw_output_json=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=? AND lease_until>?")
          .run(schemaValid === null ? 'failed' : 'completed', result ? JSON.stringify(result) : null, schemaValid === null ? null : schemaValid ? 1 : 0, result ? 1 : 0, latencyMs, error, JSON.stringify(rawOutput ?? null), trial.id, trial.lease_token, new Date().toISOString());
        updateRun(trial.run_id);
      })();
    },
    cancel(id: string) {
      sqlite.transaction(() => {
        if (!run(id)) throw new ConflictError('Evaluation not found.');
        sqlite.prepare("UPDATE evaluation_runs SET status='cancelled' WHERE id=? AND status!='completed'").run(id);
        sqlite.prepare("UPDATE model_calls SET state='uncertain' WHERE state='reserved' AND job_id IN (SELECT id FROM evaluation_trials WHERE run_id=? AND status='running')").run(id);
        sqlite.prepare("UPDATE evaluation_trials SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE run_id=? AND status IN ('queued','running')").run(id);
      })();
    },
  };
}
