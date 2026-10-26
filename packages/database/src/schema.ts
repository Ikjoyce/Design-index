import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { PaletteRole } from '@design-index/shared';

export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['image', 'url', 'element'] }).notNull(),
  title: text('title').notNull(),
  note: text('note').notNull().default(''),
  contentHash: text('content_hash').notNull().unique(),
  status: text('status', { enum: ['queued', 'analyzing', 'writing_prompt', 'ready', 'needs_review'] }).notNull(),
  capturedAt: text('captured_at').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
});

export const assets = sqliteTable('assets', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['original', 'preview'] }).notNull(),
  path: text('path').notNull(),
  mime: text('mime').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
});

export const paletteColors = sqliteTable('palette_colors', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  hex: text('hex').notNull(),
  l: real('l').notNull(),
  a: real('a').notNull(),
  b: real('b').notNull(),
  role: text('role').$type<PaletteRole | null>(),
  weight: real('weight').notNull(),
  source: text('source', { enum: ['pixels', 'css'] }).notNull(),
  position: integer('position').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['analyze'] }).notNull(),
  status: text('status', { enum: ['queued', 'running', 'completed', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: text('created_at').notNull(),
});
