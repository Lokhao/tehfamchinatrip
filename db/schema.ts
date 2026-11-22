import { pgTable, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const trips = pgTable('trips', {
  id: text().primaryKey(),
  revision: integer().notNull(),
  document: jsonb().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
