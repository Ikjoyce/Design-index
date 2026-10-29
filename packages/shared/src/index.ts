import { z } from 'zod';
import { FACETS, ITEM_STATUSES, PALETTE_ROLES, PROMPT_VARIANTS } from './browser.js';
export * from './browser.js';

export const itemStatusSchema = z.enum(ITEM_STATUSES);
export const paletteRoleSchema = z.enum(PALETTE_ROLES);

export const captureFieldsSchema = z.object({
  title: z.string().trim().max(160).default(''),
  note: z.string().trim().max(2000).default(''),
});

export const editItemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  note: z.string().trim().max(2000),
}).strict();
export const searchSchema = z.object({
  q: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  facet: z.enum(FACETS).optional(),
  label: z.string().max(80).optional(),
});

const label = z.object({ value: z.string().min(1).max(80), confidence: z.number().min(0).max(1) }).strict();
export const analysisResultSchema = z.object({
  summary: z.string().min(1).max(1000),
  labels: z.object({ style: z.array(label).max(3), color: z.array(label).max(3), layout: z.array(label).max(3), typography: z.array(label).max(3), motion: z.array(label).max(3), component: z.array(label).max(3) }).strict(),
  palette_roles: z.object({ background: z.string().nullable(), surface: z.string().nullable(), text: z.string().nullable(), 'muted-text': z.string().nullable(), accent: z.string().nullable(), border: z.string().nullable() }).strict(),
  type_notes: z.string().max(2000), motion_notes: z.string().max(2000),
  free_tags: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80)).max(5),
  quality: z.object({ issues: z.array(z.string().max(200)).max(10) }).strict(),
  review: z.object({ needs_review: z.boolean(), reasons: z.array(z.string().max(200)).max(10) }).strict(),
}).strict();

export const generatedPromptSchema = z.object({ body: z.string().min(20).max(16000), assumptions: z.array(z.string().max(300)).max(12) }).strict();
export const aiSettingsSchema = z.object({
  allowImageSharing: z.boolean(),
  analyzeModel: z.string().min(1).max(100), promptModel: z.string().min(1).max(100),
  allowModelTraining: z.boolean().default(false),
}).strict();
export const labelEditSchema = z.object({ facet: z.enum(FACETS), value: z.string().min(1).max(80), state: z.enum(['accepted', 'rejected']) }).strict();
export const promptVariantSchema = z.enum(PROMPT_VARIANTS);
export const promptEditSchema = z.object({ body: z.string().trim().min(1).max(20000), baseVersion: z.number().int().positive(), variant: promptVariantSchema.default('agent') }).strict();
export const promptGenerateSchema = z.object({ variant: promptVariantSchema }).strict();
export const promptRestoreSchema = z.object({ variant: promptVariantSchema, baseVersion: z.number().int().min(0) }).strict();
export const promptHistorySchema = z.object({ variant: promptVariantSchema.default('agent'), offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) });
const vocabularyTerm = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const facetTerms = z.array(vocabularyTerm).min(1).max(60).refine((terms) => new Set(terms).size === terms.length, 'Remove duplicate labels.');
export const vocabularyTermsSchema = z.object({ style: facetTerms, color: facetTerms, layout: facetTerms, typography: facetTerms, motion: facetTerms, component: facetTerms }).strict()
  .refine((terms) => terms.motion.includes('unknown'), 'Keep the motion label unknown for still-image captures.')
  .refine((terms) => JSON.stringify(terms).length <= 20_000, 'Vocabulary must be under 20,000 characters.');
export const vocabularyEditSchema = z.object({ baseRevision: z.number().int().positive(), terms: vocabularyTermsSchema }).strict();
export const vocabularyRenameSchema = z.object({ baseRevision: z.number().int().positive(), facet: z.enum(FACETS), from: vocabularyTerm, to: vocabularyTerm }).strict().refine((value) => value.from !== value.to, 'Choose a different target label.');
export const urlCaptureSchema = captureFieldsSchema.extend({ url: z.string().trim().min(1).max(2048), colorScheme: z.enum(['light', 'dark']).default('light') }).strict();
export const captureSettingsSchema = z.object({ approvedLocalOrigins: z.array(z.string().trim().max(200)).max(10) }).strict();
const goldTerms = z.array(vocabularyTerm).max(10).refine((values) => new Set(values).size === values.length);
export const evaluationSampleSchema = z.object({
  labels: z.object({ style: goldTerms, color: goldTerms, layout: goldTerms, typography: goldTerms, motion: goldTerms, component: goldTerms }).strict(),
  scoredFacets: z.array(z.enum(FACETS)).min(1).max(6).refine((values) => new Set(values).size === values.length),
  note: z.string().trim().max(1000).default(''), baseVersion: z.number().int().min(0),
}).strict();
export const evaluationRunSchema = z.object({ name: z.string().trim().min(1).max(120), modelIds: z.array(z.string().min(1).max(100)).min(2).max(4).refine((values) => new Set(values).size === values.length), sampleIds: z.array(z.string().min(1).max(80)).min(1).max(30).refine((values) => new Set(values).size === values.length), confirmModelCalls: z.literal(true) }).strict();
