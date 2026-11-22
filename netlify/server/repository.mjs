import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { trips } from '../../db/schema.ts';

const fields = { trip: trips.document, rev: trips.revision };

export async function readTrip() {
  const [saved] = await db.select(fields).from(trips).where(eq(trips.id, 'main'));
  return saved || { trip: null, rev: 0 };
}

export async function writeTrip(trip, base) {
  // The revision condition is checked by Postgres, including concurrent saves.
  const query = base === 0
    ? db.insert(trips).values({ id: 'main', revision: 1, document: trip }).onConflictDoNothing()
    : db.update(trips).set({ document: trip, revision: base + 1, updatedAt: new Date() })
      .where(and(eq(trips.id, 'main'), eq(trips.revision, base)));
  const [saved] = await query.returning(fields);
  return saved || null;
}
