# OCL-209: a balança do board

Scripts que produziram `docs/rfcs/OCL-209-balanca-do-board.md`. Eles leem transcripts reais de CLI e o bench PGlite, e gravam só tamanhos e tempos. O conteúdo dos payloads vai para um arquivo local, usado para tokenizar e analisar campos, e nunca entra no repositório.

```bash
mkdir -p /tmp/ocl209 && cd /tmp/ocl209
# 1. transcripts do Claude Code que chamaram o board (todas as contas)
grep -rl --include='*.jsonl' '"name":"mcp__overclick__' ~/.claude/projects <outros CLAUDE_CONFIG_DIR>/projects > claude-files.txt
node <repo>/scripts/ocl-209/mine-claude.mjs claude-calls.jsonl claude-payloads.jsonl $(cat claude-files.txt)
node <repo>/scripts/ocl-209/mine-sessions.mjs sessions.jsonl $(cat claude-files.txt)
# 2. rollouts do Codex (code mode: tools.mcp__overclick__X(...))
grep -rlE 'tools\.mcp__overclick__|"name":"mcp__overclick__' ~/.codex/sessions > codex-files.txt
node <repo>/scripts/ocl-209/mine-codex.mjs codex-calls.jsonl codex-payloads.jsonl $(cat codex-files.txt)
# 3. tokenizador e relógio do modelo, medidos pelos contadores de usage
node <repo>/scripts/ocl-209/calibrate.mjs claude-calls.jsonl
node <repo>/scripts/ocl-209/speed.mjs claude-calls.jsonl
# 4. regime pequeno + curva + handshake (código real do servidor sobre PGlite)
(cd <repo>/apps/web && OCL209_BENCH_OUT=/tmp/ocl209/bench.jsonl pnpm exec vitest run src/mcp/ocl209-payload-bench.integration.test.ts)
# 5. fluxo registrar/executar e a tabela
node <repo>/scripts/ocl-209/flow.mjs sessions.jsonl --since=2026-09-09 --json flow.json
node <repo>/scripts/ocl-209/table.mjs claude-calls.jsonl codex-calls.jsonl bench.jsonl --since=2026-09-09 --flow=flow.json
node <repo>/scripts/ocl-209/aggregate.mjs claude-calls.jsonl --since=2026-09-09
```

## Modelo de tempo

Vale para cada mensagem do modelo que carrega uma chamada ao board.

- `escrita` = carimbo do bloco `tool_use` − último evento `user` antes da mensagem (TTFT + raciocínio + argumentos).
- `servidor` = `tool_result` − último bloco da mensagem (rede + hooks + board). Se o resultado chega antes do fim da mensagem, porque houve execução em streaming, usa-se `tool_result` − bloco da chamada.
- `leitura` = tokens da resposta × custo de prefill por 1k tokens novos, medido no modelo (`speed.mjs`).

Para rodar depois de um corte e comparar com o antes, basta repetir os passos 1 a 5 com `--since` na data do corte.
