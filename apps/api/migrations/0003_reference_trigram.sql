-- Fragment search on references: `lower(col) like lower('%fragment%')` is served by these trigram indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX transaction_reference_trgm_idx ON transaction USING gin (lower(reference) gin_trgm_ops);
CREATE INDEX transaction_project_reference_trgm_idx ON transaction USING gin (lower(project_reference) gin_trgm_ops);
CREATE INDEX attempt_provider_reference_trgm_idx ON transaction_attempt USING gin (lower(provider_reference) gin_trgm_ops);
CREATE INDEX attempt_operator_reference_trgm_idx ON transaction_attempt USING gin (lower(operator_reference) gin_trgm_ops);
CREATE INDEX preview_reference_trgm_idx ON preview USING gin (lower(reference) gin_trgm_ops);
CREATE INDEX preview_project_reference_trgm_idx ON preview USING gin (lower(project_reference) gin_trgm_ops);
