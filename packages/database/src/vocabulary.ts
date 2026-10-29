import type Database from 'better-sqlite3';
import { canonicalLabel, defaultVocabulary, FACETS, vocabularyTermsSchema } from '@design-index/shared';
import type { AnalysisResult, Facet, VocabularyState, VocabularyTerms } from '@design-index/shared';
import { ConflictError } from './errors.js';

export function createVocabularyStore(sqlite: Database.Database) {
  function current(): VocabularyState {
    const row = sqlite.prepare('SELECT * FROM vocabulary_revisions ORDER BY revision DESC LIMIT 1').get() as { revision: number; terms_json: string; created_at: string };
    const state = { ...defaultVocabulary(), revision: row.revision, terms: JSON.parse(row.terms_json) as VocabularyTerms, updatedAt: row.created_at };
    for (const alias of sqlite.prepare('SELECT facet,source,target FROM vocabulary_aliases').all() as { facet: Facet; source: string; target: string }[]) state.aliases[alias.facet][alias.source] = alias.target;
    return state;
  }
  function get(): VocabularyState {
    const state = current();
    const seen = Object.fromEntries(FACETS.map((facet) => [facet, new Set<string>()])) as Record<Facet, Set<string>>;
    const analyses = sqlite.prepare('SELECT a.result_json FROM analyses a JOIN items i ON i.active_analysis_id=a.id').all() as { result_json: string }[];
    for (const row of analyses) {
      const result = JSON.parse(row.result_json) as AnalysisResult;
      for (const facet of FACETS) for (const label of result.labels[facet]) seen[facet].add(canonicalLabel(state, facet, label.value));
    }
    for (const row of sqlite.prepare('SELECT DISTINCT facet,value FROM label_overrides').all() as { facet: Facet; value: string }[]) seen[row.facet].add(canonicalLabel(state, row.facet, row.value));
    for (const facet of FACETS) state.retiredTerms[facet] = [...seen[facet]].filter((term) => !state.terms[facet].includes(term)).sort();
    return state;
  }
  function write(terms: VocabularyTerms): void {
    const parsed = vocabularyTermsSchema.safeParse(terms);
    if (!parsed.success) throw new ConflictError('Use unique lowercase kebab-case labels, keep at least one per facet, and retain motion:unknown.');
    sqlite.prepare('INSERT INTO vocabulary_revisions(terms_json,created_at) VALUES(?,?)').run(JSON.stringify(parsed.data), new Date().toISOString());
  }
  function assertRevision(revision: number): VocabularyState {
    const state = current();
    if (revision !== state.revision) throw new ConflictError('Vocabulary changed. Reload it before saving.');
    return state;
  }
  return {
    current, get,
    equivalents(facet: Facet, value: string): string[] {
      const state = current();
      const target = canonicalLabel(state, facet, value);
      return [...new Set([target, ...Object.keys(state.aliases[facet]).filter((source) => canonicalLabel(state, facet, source) === target)])];
    },
    save(baseRevision: number, terms: VocabularyTerms) {
      return sqlite.transaction(() => {
        const state = assertRevision(baseRevision);
        for (const facet of FACETS) if (terms[facet].some((term) => Object.hasOwn(state.aliases[facet], term))) throw new ConflictError('A renamed label cannot be reintroduced under its old name. Choose a new name.');
        if (JSON.stringify(terms) !== JSON.stringify(state.terms)) write(terms);
        return get();
      })();
    },
    rename(baseRevision: number, facet: Facet, from: string, to: string) {
      return sqlite.transaction(() => {
        const state = assertRevision(baseRevision);
        if (!state.terms[facet].includes(from) || from === to) throw new ConflictError('Choose an active source label and a different target.');
        if (facet === 'motion' && from === 'unknown') throw new ConflictError('The motion label unknown is reserved for still-image captures.');
        if (Object.hasOwn(state.aliases[facet], to)) throw new ConflictError('The target was already renamed. Use its current canonical name.');
        const conflicting = sqlite.prepare('SELECT 1 FROM label_overrides a JOIN label_overrides b ON a.item_id=b.item_id AND a.facet=b.facet WHERE a.facet=? AND a.value=? AND b.value=? AND a.state!=b.state LIMIT 1').get(facet, from, to);
        if (conflicting) throw new ConflictError('Merge would conflict with manual accept/reject decisions. Resolve those decisions first.');
        state.terms[facet] = [...new Set(state.terms[facet].map((term) => term === from ? to : term))];
        write(state.terms);
        const revision = current().revision;
        sqlite.prepare('UPDATE vocabulary_aliases SET target=?,revision=? WHERE facet=? AND target=?').run(to, revision, facet, from);
        sqlite.prepare('INSERT INTO vocabulary_aliases VALUES(?,?,?,?)').run(facet, from, to, revision);
        sqlite.prepare('INSERT INTO label_overrides(item_id,facet,value,state) SELECT item_id,facet,?,state FROM label_overrides WHERE facet=? AND value=? ON CONFLICT(item_id,facet,value) DO NOTHING').run(to, facet, from);
        sqlite.prepare('DELETE FROM label_overrides WHERE facet=? AND value=?').run(facet, from);
        return get();
      })();
    },
  };
}

export type VocabularyStore = ReturnType<typeof createVocabularyStore>;
