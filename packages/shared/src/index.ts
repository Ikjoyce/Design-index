import { z } from 'zod';
import { ITEM_STATUSES, PALETTE_ROLES } from './browser.js';
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
});
