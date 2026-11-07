-- The activity feed is read newest-first (ORDER BY "createdAt" DESC, LIMIT 50)
-- and ActivityLog only had indexes on actorId and (entityType, entityId), so
-- every read sorted the whole table.
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog" ("createdAt" DESC);
