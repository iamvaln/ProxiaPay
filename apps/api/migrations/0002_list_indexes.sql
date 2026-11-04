-- Indexes for the paged console lists (default order, prefix search).
CREATE INDEX transaction_created_idx ON transaction (created_at DESC, id DESC);
CREATE INDEX transaction_reference_prefix_idx ON transaction (reference text_pattern_ops);
CREATE INDEX alert_raised_idx ON alert (raised_at DESC, id DESC);
