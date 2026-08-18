ALTER TABLE "execution_attempt" ADD COLUMN "model_source" text;--> statement-breakpoint

-- OCL-29: repair attempts created on 2026-08-18, the day the generic Codex
-- labels were reported. The date is fixed deliberately: deploying this
-- migration later must not reinterpret a different day's historical claims.
WITH raw_attempt AS (
  SELECT
    ea.id,
    ea.model AS declared_model,
    CASE
      WHEN ea.executor ~ '^\s*\{' THEN ea.executor::jsonb
      ELSE jsonb_build_object('cli', ea.executor)
    END AS executor_json,
    t.harness
  FROM execution_attempt ea
  JOIN task t ON t.id = ea.task_id
  WHERE ea.started_at >= TIMESTAMPTZ '2026-08-18T03:00:00Z'
    AND ea.started_at < TIMESTAMPTZ '2026-08-19T03:00:00Z'
), identity AS (
  SELECT
    id,
    declared_model,
    executor_json,
    lower(trim(COALESCE(executor_json->>'cli', ''))) AS declared_cli,
    lower(trim(COALESCE(declared_model, ''))) AS declared_key,
    lower(trim(COALESCE(harness->>'cli', ''))) AS harness_cli,
    lower(trim(COALESCE(harness->>'model', ''))) AS harness_model
  FROM raw_attempt
), resolved AS (
  SELECT
    id,
    executor_json,
    CASE
      WHEN declared_cli = 'overclock' AND harness_cli <> '' THEN harness_cli
      WHEN declared_cli = 'codex cli' THEN 'codex'
      ELSE NULLIF(declared_cli, '')
    END AS cli,
    CASE
      WHEN declared_key IN ('', 'gpt-5', 'codex', 'claude', 'o4-mini')
        AND harness_model <> ''
        THEN replace(regexp_replace(harness_model, '^claude-', ''), '.', '-')
      WHEN declared_key IN ('gpt-5', 'o4-mini')
        AND declared_cli IN ('codex', 'codex cli')
        THEN 'gpt-5-6-sol'
      WHEN declared_key = 'gpt-5-codex' THEN 'gpt-5-3-codex-spark'
      WHEN declared_key IN (
        'gpt-5.3-codex-spark',
        'openai/gpt-5.3-codex-spark',
        'codex/gpt-5.3-codex-spark'
      ) THEN 'gpt-5-3-codex-spark'
      WHEN declared_key IN ('gpt-5.6-sol', 'openai/gpt-5.6-sol')
        THEN 'gpt-5-6-sol'
      WHEN declared_key IN ('kimi', 'kimi-code/k3', 'moonshot/k3') THEN 'k3'
      WHEN declared_key <> '' THEN replace(
        regexp_replace(
          regexp_replace(declared_key, '^[a-z0-9_.-]+/', ''),
          '^claude-',
          ''
        ),
        '.',
        '-'
      )
      ELSE NULL
    END AS model,
    CASE
      WHEN declared_key IN ('', 'gpt-5', 'codex', 'claude', 'o4-mini')
        AND (
          harness_model <> '' OR
          (declared_key IN ('gpt-5', 'o4-mini') AND declared_cli IN ('codex', 'codex cli'))
        )
        THEN 'harness'
      WHEN declared_key <> '' THEN 'declared'
      ELSE NULL
    END AS model_source
  FROM identity
)
UPDATE execution_attempt ea
SET
  executor = CASE
    WHEN resolved.cli IS NULL THEN resolved.executor_json::text
    ELSE jsonb_set(resolved.executor_json, '{cli}', to_jsonb(resolved.cli), true)::text
  END,
  model = resolved.model,
  model_source = resolved.model_source
FROM resolved
WHERE ea.id = resolved.id;
