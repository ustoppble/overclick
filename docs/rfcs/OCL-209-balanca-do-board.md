# RFC OCL-209: a balança do board (o antes)

- **Data:** 2026-09-23
- **Status:** medição entregue. Nenhum corte foi implementado: cada candidato vira um card próprio na missão "Dieta agressiva do OverClick".
- **Alvo (correção do dono, 2026-09-23):** a métrica principal é o **tempo de parede** por interação com o board. Os caracteres entram só para explicar esse tempo. O custo de **leitura** (o que o board devolve) é medido separado do custo de **escrita** (o que o board exige que o modelo escreva).
- **Versão medida:** OverClick v0.3.20 (a `origin/main` desta data, que é a versão no ar).

## Resposta curta

1. **O tempo vai quase todo no modelo escrevendo.** Nos 497 registros de card medidos desde 09/09, o agente passa 23,4 s (p50) em turnos de board, e 22,9 s disso é o modelo gerando a chamada. O servidor responde em 0,2 s. Nas 503 execuções medidas, os turnos de board somam 29,1 s: 27,9 s de escrita e 0,7 s de servidor. Ler a resposta (prefill) custa de 0,04 a 0,07 s por 1.000 tokens, enquanto escrever custa de 8 a 12 s por 1.000 tokens. Por token, escrever é **150 a 250 vezes mais caro** que ler.
2. **O card completo, registrar + executar, custa ≈ 52 s de board** (soma das medianas). De 96% a 98% desse tempo é escrita.
3. **Três pontos concentram o tempo:**
   - `task_create`: 18,6 s de escrita em 100% dos registros;
   - `task_deliver`: 14,1 s por chamada, 1,31 chamadas por execução;
   - o script de medição de usage que o modelo digita antes de entregar: 10,2 s, em 85% das entregas.
4. **Exceção:** o `task_search` é a única ferramenta em que o servidor domina. A mediana foi de 12 s em 22/09 e de 5,4 s em 23/09, com pico de 60 s.
5. **Âncora do `project_list` (20.038 chars):**
   - **O número exato não se confirma.** Hoje a resposta tem **24.202 chars**. Foram 12 chamadas reais no dia, todas com esse tamanho, incluindo a chamada direta deste executor às 15:44. O workspace tem 61 projetos, e 20.038 é o tamanho de 17 e 18/09, quando havia 51.
   - **A proporção se confirma:** quando o `project_list` aparece num registro, ele é 62% (p50) de tudo que se leu no episódio.
   - **Em tempo, porém, ele não é o pior:** custa 2,9 s por chamada e aparece em 20% dos registros, o que dá ≈ 0,6 s por card. O `task_create` escrito custa **~30 vezes mais tempo** por card. O OCL-208 vale, mas não é o primeiro da fila.

## Método

**Tudo é medido em respostas e contadores reais, não em leitura de código.** São três fontes.

1. **Transcripts reais do dono:**
   - Claude Code, nas duas contas: 10.524 chamadas ao board em 1.160 sessões, de 18/08 a 23/09.
   - Codex: 3.855 chamadas em 418 sessões.

   A tabela usa a janela de 09/09 a 23/09. O símbolo † marca as ferramentas com menos de 5 chamadas na janela, para as quais vale o histórico inteiro. O tempo de cada chamada é medido nos carimbos de hora do próprio transcript:
   - **escrita** = do último evento de entrada da requisição até o bloco `tool_use` completo (TTFT + raciocínio + argumentos);
   - **servidor** = do fim da mensagem até o `tool_result` (rede + hooks + board);
   - **leitura** = prefill da resposta na requisição seguinte. A taxa foi medida nos mesmos dados: +0,069 s por 1k tokens novos no opus-5 (n=1.192) e +0,038 s no opus-5-5 (n=92);
   - **parede** = escrita + servidor + leitura, em mensagens com uma única chamada.

   O tempo do servidor inclui a verificação do commit no GitHub feita pelo `task_deliver`.
2. **Regime pequeno e curva:** o código real do servidor (`invokeTool`, o mesmo caminho do `server.ts`) chamado sobre PGlite:
   - primeiro num workspace novo (1 organização, 1 projeto), passando pelas **32 ferramentas** com argumentos do tamanho mediano real;
   - depois o mesmo banco cresce até 4 organizações, 61 projetos, 51 missões e 600 cards, com pontos de medida no caminho;
   - um handshake MCP real (`createOverclickMcpServer` + client em memória) mede as instruções e as definições.

   Arquivo: `apps/web/src/mcp/ocl209-payload-bench.integration.test.ts`. Ele só roda com `OCL209_BENCH_OUT` definido.
3. **Chamadas diretas deste executor no board real**, em 2026-09-23 das 15:24 às 15:44, medidas no próprio transcript.

**Tokenizador:** o do próprio modelo (família Claude 5), medido pelos contadores de usage que a API grava nos transcripts:
- resposta JSON devolvida: **2,3 chars/token** (n=405 no opus-5, 75 no opus-5-5, 188 no fable-5);
- chamada escrita pelo modelo: **1,95 chars/token + ~80 tokens fixos** (n=1.559 no opus-5, 161 no opus-5-5).

A calibração bate com a medição do OVKA-525: 32,7k chars = 14,2k tokens, ou seja, 2,30 chars/token.

**Relógio do modelo (mesma base):**

| Modelo | Escrita | TTFT |
|---|---|---|
| opus-5 | 86 tok/s | 1,6 s |
| opus-5-5 | 128 tok/s | 1,2 s |
| sonnet-5 | 147 tok/s | 3,0 s |
| fable-5 | 80 tok/s | 2,4 s |

**Scripts:** `scripts/ocl-209/`. Os mineradores guardam só tamanhos e tempos; o conteúdo dos payloads fica numa cópia local, fora do repositório.

## A tabela, por ferramenta

A tabela está ordenada da mais cara para a mais barata **em tempo total consumido na janela** (N × parede p50):

| Ferramenta | Tempo total na janela |
|---|---|
| `task_create` | 4,2 h |
| `task_deliver` | 2,2 h |
| `task_update` | 1,6 h |
| `task_claim` | 0,6 h |
| `task_search` | 0,6 h |
| receita de usage digitada | 0,5 h |
| `task_get` | 0,4 h |
| todas as outras | ≤ 0,2 h cada |

**Legenda das colunas**

- **Tempos** (medianas, segundos):
  - *parede*, *escrita*, *servidor* e *leitura* seguem as definições do Método;
  - *domina* aponta a maior das três parcelas.
- **Tokens:**
  - *SAÍDA tok (args)* = tokens que o modelo escreveu nos argumentos da chamada;
  - *saída da msg* = todos os tokens da mensagem que carrega a chamada, raciocínio incluído;
  - *ENTRADA tok* = tokens da resposta devolvida.
- **Tamanho da resposta em chars, nos regimes:**
  - *pequeno* = workspace novo no PGlite;
  - *real p50/p90* = respostas reais na janela;
  - *real hoje* = chamada direta de 23/09;
  - *crescido* = o mesmo PGlite com 4 orgs, 61 projetos, 51 missões e 600 cards.
- **Outras colunas:**
  - *definição* = chars da descrição + schema servidos no handshake;
  - *chamadas/card* = chamadas por episódio de registro (497) + por episódio de execução (503);
  - *Codex escrita* = a mesma medida no Codex, onde o modelo ainda escreve o JS em volta da chamada (code mode);
  - *recusa %* = chamadas recusadas. Cada recusa obriga a reescrever tudo.
- ‡ A linha da receita conta só a receita literal (N=122). Medida de forma ampla (qualquer script que lê o `.jsonl` e soma tokens antes da entrega), a cerimônia de usage aparece em **85% das 543 entregas**, com **1.199 chars p50** (4.206 no p90) e **10,2 s p50 de escrita** (21,3 s no p90).

| # | ferramenta | N real | parede p50 | escrita p50 | servidor p50 | leitura p50 | domina | SAÍDA tok (args) | saída da msg p50 | ENTRADA tok p50 | pequeno (chars) | real p50/p90 (chars) | real hoje (chars) | crescido PGlite | definição (chars) | chamadas/card: registrar + executar | Codex escrita p50 (N) | recusa % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | task_create | 809 | 18.8 s | 18.6 s | 0.17 s | 0.01 s | escrita | 941 | 1.9k | 98 | 207 | 226 / 278 | — | 209 | 4.1k | 1.00 + 0.25 | 21.0 s (164) | 6 |
| 2 | task_deliver | 545 | 14.4 s | 14.1 s | 0.41 s | 0.02 s | escrita | 1.1k | 1.4k | 307 | 603 | 707 / 796 | — | 787 | 3.9k | 0.00 + 1.31 | 19.7 s (357) | 6 |
| 3 | task_update | 865 | 6.5 s | 6.2 s | 0.16 s | 0.02 s | escrita | 330 | 999 | 229 | 623 | 526 / 1.5k | — | 625 | 3.4k | 0.10 + 0.23 | 15.3 s (342) | 4 |
| 4 | task_claim | 585 | 3.7 s | 2.8 s | 0.18 s | 0.80 s | escrita | 146 | 325 | 10.1k | 22.2k | 23.1k / 37.6k | 27.0k | 23.2k | 1.5k | 0.02 + 1.25 | 6.6 s (381) | 4 |
| 5 | task_search | 169 | 12.8 s | 2.2 s | 8.92 s | 0.07 s | servidor | 117 | 275 | 1.1k | 469 | 2.5k / 5.0k | 2.4k | 2.3k | 1.6k | 0.12 + 0.05 | 7.8 s (125) | 13 |
| 6 | receita de usage digitada (Bash) ‡ | 122 | 13.3 s | 13.2 s | 0.15 s | 0.01 s | escrita | 2.2k | 1.8k | 153 | — | 352 / 398 | — | — | — | 0.00 + 0.22 | — s (0) | 0 |
| 7 | task_get | 400 | 3.2 s | 2.5 s | 0.15 s | 0.10 s | escrita | 101 | 409 | 1.5k | 2.0k | 3.5k / 34.9k | 6.4k | 2.0k | 1.4k | 0.12 + 0.24 | 8.0 s (440) | 1 |
| 8 | harness_recommend (removida na v0.3.19, OCL-202) | 107 | 6.4 s | 6.3 s | 0.15 s | 0.01 s | escrita | 89 | 432 | 109 | — | 251 / 292 | — | — | — | 0.17 + 0.03 | 3.7 s (11) | 3 |
| 9 | mission_create | 35 | 12.2 s | 12.1 s | 0.16 s | 0.04 s | escrita | 594 | 1.1k | 531 | 1.3k | 1.2k / 2.7k | — | — | 906 | 0.04 + 0.00 | 15.4 s (10) | 20 |
| 10 | task_list | 100 | 4.2 s | 3.8 s | 0.16 s | 0.09 s | escrita | 114 | 394 | 1.3k | 253 | 2.9k / 17.7k | 10.1k | 8.5k | 2.6k | 0.04 + 0.07 | 6.2 s (43) | 12 |
| 11 | project_list | 139 | 2.9 s | 2.2 s | 0.16 s | 0.52 s | escrita | 81 | 264 | 8.7k | 360 | 20.0k / 24.2k | 24.2k | 24.9k | 596 | 0.20 + 0.00 | 6.2 s (30) | 6 |
| 12 | branch_register | 137 | 2.6 s | 2.3 s | 0.14 s | 0.09 s | escrita | 109 | 436 | 1.4k | 2.3k | 3.2k / 4.8k | 4.1k | 2.3k | 446 | 0.01 + 0.27 | 6.2 s (135) | 0 |
| 13 | mission_update | 16 | 15.8 s | 15.7 s | 0.15 s | 0.39 s | escrita | 421 | 1.4k | 1.6k | 377 | 3.8k / 7.8k | — | — | 3.1k | 0 | 29.8 s (3) | 6 |
| 14 | task_reopen | 17 | 7.6 s | 7.4 s | 0.16 s | 0.04 s | escrita | 888 | 923 | 796 | 1.8k | 1.8k / 4.0k | — | — | 851 | 0 | 17.1 s (1) | 24 |
| 15 | insights_query † | 27 | 4.2 s | 3.4 s | 0.78 s | 0.04 s | escrita | 90 | 174 | 709 | 5.6k | 1.6k / 9.9k | 291.9k | 8.5k | 995 | 0.00 + 0.01 | 12.7 s (1) | 0 |
| 16 | harness_list (removida na v0.3.19) | 17 | 5.3 s | 1.3 s | 0.74 s | 0.48 s | escrita | 81 | 466 | 6.9k | — | 15.9k / 16.1k | — | — | — | 0.02 + 0.00 | 6.4 s (10) | 6 |
| 17 | task_heartbeat | 9 | 8.3 s | 8.0 s | 0.27 s | 0.00 s | escrita | 91 | 877 | 80 | 180 | 183 / 183 | — | 182 | 618 | 0.00 + 0.02 | 8.6 s (23) | 0 |
| 18 | project_update | 8 | 7.9 s | 7.7 s | 0.13 s | 0.01 s | escrita | 113 | 1.2k | 61 | 270 | 141 / 390 | — | — | 3.9k | 0 | 25.5 s (1) | 0 |
| 19 | mission_list | 14 | 4.4 s | 1.9 s | 0.17 s | 1.26 s | escrita | 89 | 346 | 9.1k | 204 | 20.9k / 25.3k | 28.1k | 11.9k | 571 | 0.01 + 0.00 | 8.9 s (5) | 14 |
| 20 | task_release | 12 | 4.1 s | 4.0 s | 0.14 s | 0.00 s | escrita | 219 | 780 | 56 | 125 | 128 / 129 | — | — | 748 | 0.00 + 0.01 | 8.0 s (7) | 0 |
| 21 | mission_attempt_start † | 2 | 22.0 s | 17.3 s | 4.54 s | 0.12 s | escrita | 263 | 3.5k | 501 | 1.1k | 1.2k / 1.2k | — | — | 1.1k | 0 | 12.4 s (1) | 0 |
| 22 | mission_report_usage † | 3 | 11.9 s | 11.6 s | 0.17 s | 0.17 s | escrita | 351 | 1.4k | 713 | 1.3k | 1.6k / 1.7k | — | — | 1.5k | 0 | 13.8 s (13) | 0 |
| 23 | project_create | 8 | 4.3 s | 4.1 s | 0.13 s | 0.02 s | escrita | 174 | 398 | 251 | 499 | 577 / 881 | — | — | 1.5k | 0.01 + 0.00 | 8.0 s (12) | 0 |
| 24 | organization_list † | 3 | 8.9 s | 8.8 s | 0.14 s | 0.02 s | escrita | 81 | 155 | 313 | 189 | 719 / 719 | 719 | 722 | 324 | 0 | — s (0) | 0 |
| 25 | executors_update † | 3 | 8.6 s | 8.4 s | 0.08 s | — s | escrita | 96 | 169 | — | 152 | — / — | — | — | 1.5k | 0 | 7.9 s (4) | 100 |
| 26 | task_delete | 12 | 2.1 s | 2.0 s | 0.14 s | 0.01 s | escrita | 90 | 298 | 55 | 125 | 127 / 128 | — | — | 431 | 0 | — s (0) | 17 |
| 27 | project_delete † | 1 | 24.6 s | 24.3 s | 0.31 s | 0.02 s | escrita | 97 | 1.7k | 75 | 164 | 173 / 173 | — | — | 816 | 0 | — s (0) | 0 |
| 28 | mission_get | 6 | 4.1 s | 3.9 s | 0.12 s | 0.08 s | escrita | 114 | 288 | 348 | 201 | 800 / 6.6k | — | 244 | 532 | 0.01 + 0.00 | 3.9 s (1) | 17 |
| 29 | harness_set † (removida na v0.3.19) | 3 | 5.3 s | 5.2 s | 0.11 s | 0.01 s | escrita | 137 | 240 | 75 | — | 172 / 181 | — | — | — | 0 | — s (0) | 33 |
| 30 | project_get | 7 | 1.9 s | 1.6 s | 0.32 s | 0.01 s | escrita | 100 | 217 | 217 | 357 | 500 / 966 | — | 418 | 740 | 0 | 7.3 s (6) | 14 |
| 31 | mission_delete † | 1 | 2.1 s | 2.0 s | 0.15 s | 0.00 s | escrita | 107 | 81 | 60 | 156 | 137 / 137 | — | — | 570 | 0 | — s (0) | 0 |
| 32 | organization_get | 0 | sem uso | — | — | — | — | — | — | — | 201 | — / — | 208 | 207 | 495 | 0 | — s (0) | — |
| 33 | organization_create | 0 | sem uso | — | — | — | — | — | — | — | 203 | — / — | — | — | 432 | 0 | — s (0) | — |
| 34 | organization_update | 0 | sem uso | — | — | — | — | — | — | — | 410 | — / — | — | — | 775 | 0 | — s (0) | — |
| 35 | organization_delete | 0 | sem uso | — | — | — | — | — | — | — | 161 | — / — | — | — | 906 | 0 | — s (0) | — |
| 36 | project_context_refresh | 0 | sem uso | — | — | — | — | — | — | — | 153 | — / — | — | — | 725 | 0 | — s (0) | — |

**Custo fixo por sessão, pago antes de qualquer chamada:**
- **Definições das 32 ferramentas:** 43.550 chars (~19k tokens). As maiores:

  | Ferramenta | Chars da definição |
  |---|---|
  | `task_create` | 4.095 |
  | `project_update` | 3.932 |
  | `task_deliver` | 3.863 |
  | `task_update` | 3.375 |
  | `mission_update` | 3.120 |
  | `task_list` | 2.587 |

  O Codex carrega as 32 de uma vez. O Claude carrega sob demanda: em 744 registros, houve 0,53 turno de ToolSearch por registro, a **5,9 s** cada.
- **Instruções do servidor:** 2.758 chars num workspace novo e 9.782 com 20 projetos documentados, porque cada projeto com contexto pendura uma linha de ~350 chars. O Claude Code corta em 2.048.

## O fluxo "registrar um card e executá-lo", ferramenta por ferramenta

### Registrar

Janela: do prompt ao resultado do `task_create`, em 497 episódios reais.
- **Parede:** 43,1 s p50.
- **Turnos de board:** 23,4 s (22,9 s escrita + 0,2 s servidor).
- **Lido do board:** 277 chars p50.

| Chamada | Vezes por registro | Custo por chamada (p50) |
|---|---|---|
| `task_create` | 1,00 | 18,6 s de escrita, 941 tokens de args, 1,9k tokens na mensagem |
| ToolSearch (carregar as ferramentas do board, Claude) | 0,53 | 5,9 s |
| `project_list` | 0,20 | 2,9 s e 24,2k chars (62% de tudo que se leu no episódio quando aparece) |
| `harness_recommend` | 0,17 | 6,4 s (já removido pela OCL-202) |
| `task_search` | 0,12 | 12,8 s, dominado pelo servidor |
| `task_get` | 0,12 | 3,2 s |
| `task_update` | 0,10 | 6,5 s |
| `mission_create` | 0,04 | 12,2 s |
| `task_list` | 0,04 | 4,2 s |

### Executar

Janela: do `task_claim` ao `task_deliver` do mesmo card, em 503 episódios reais.
- **Episódio inteiro:** 524,6 s, quase tudo trabalho de verdade.
- **Turnos de board:** 29,1 s (27,9 s escrita + 0,7 s servidor).
- **Lido do board:** 26,6k chars p50.

| Chamada | Vezes por execução | Custo por chamada (p50) |
|---|---|---|
| `task_claim` | 1,25 | 3,7 s, 23,1k chars (37,6k no p90) |
| `task_get` | 0,24 | 3,2 s. Em 11% dos claims ele vem logo antes, para o mesmo card (leitura redundante: o claim devolve tudo). |
| `branch_register` | 0,27 | 2,6 s, e devolve o card inteiro (3,2k) |
| `task_update` | 0,23 | 6,5 s |
| medição de usage digitada | 0,85 | 10,2 s |
| `task_deliver` | 1,31 (inclui recusas e reentregas) | 14,4 s, 1,1k tokens de args |
| `task_create` (cards derivados que o worker abre) | 0,25 | 18,8 s |
| `task_heartbeat` | 0,02 | 8,3 s |

### Onde concentra

| Parcela | Conta | Por card |
|---|---|---|
| `task_create` | 18,6 s × 1,25 | ≈ 23 s |
| `task_deliver` | 14,1 s × 1,31 | ≈ 18 s |
| medição de usage | 10,2 s × 0,85 | ≈ 9 s |
| `task_claim` | 3,7 s × 1,25 | ≈ 5 s |
| ToolSearch | 5,9 s × 0,53 | ≈ 3 s |
| todo o resto | — | < 5 s |

O conteúdo do contrato é o_que/por_que/como_confirmo no create e resumo/evidência na entrega. Ele responde por **~2/3 do tempo de escrita** e não se corta. A **cerimônia em volta dele** (medição de usage, campos que o board já sabe, recusas por formato, chamadas extras) soma **≈ 15 s por card, cerca de 27%**, e pode sair sem piorar o card.

## O que dentro do payload é usado e o que nunca é lido

### Leitura

- **`project_list`** (24,2k chars, 61 projetos, ~400 chars por projeto):
  - **Usado:** a decisão seguinte (`task_create`) consome **um** `id_prefix` de 61, ou seja, 1,6% do payload. Das 757 criações medidas, 96% usam prefixo e 4% usam uuid.
  - **Nunca lido para decidir:** contagens por status (22%), `organization_id` + `organization_name` repetidos em cada projeto (22%), `created_at` (10%), `next_number` (4%) e `has_context` (5%).
- **`task_claim`** (27,0k chars neste card; 22,2k já num workspace novo, então o tamanho não vem do workspace):
  - **Usado:** o contrato, a convenção de branch, o `claimed_at`, uma cópia da receita e o contrato do executor.
  - **Duplicado ou irrelevante:**

    | Trecho | Chars | Por que sobra |
    |---|---|---|
    | `usage_recipe` | 6,6k | repete a seção "Measuring this run" |
    | contrato em `task{}` | 2,9k | repete o que já está no `briefing_markdown` |
    | "Mission orchestration telemetry" | 2,1k | o próprio texto diz que não é para worker de card |
    | "Shared context edits" | 0,5k | não se aplica a quem só executa o card |
    | contextos "not configured" | 0,2k | não trazem informação |

    São **~12,3k, 45% do claim**, que saem sem perder nada.
- **`branch_register`:** devolve o card inteiro (3,2k chars p50; 4,1k aqui) só para confirmar um campo.
- **`task_list` padrão:** devolve os 50 cards **mais antigos**. Hoje isso significa cards de 18/08, quase todos `feito`, então a fila de verdade exige uma segunda chamada com filtro.
- **`mission_list` sem filtro:** 121 missões e 28,1k chars, concluídas incluídas, com a organização repetida em cada linha.
- **`insights_query` sem `group_by`:** **291.908 chars**, contra a própria descrição ("omit for totals and the reopen rate only"). Vêm `combined_groups.by_mission` (166k), `by_project` (79k) e `by_model` (29k). O Claude Code recusa respostas acima de 25k tokens e grava num arquivo: o conteúdo inteiro fica ilegível e força turnos extras. No workspace novo a mesma chamada devolve 5,6k.
- **Respostas de escrita** (`task_create`, `task_update`, `task_deliver`, `task_release`, `task_heartbeat`): já voltam como ack de 125 a 800 chars e não pesam.

### Escrita: o que o modelo digita e o board já sabe

- **`task_create`** (941 tokens de args p50, medido de 09/09 a 23/09):

  | Campo | Chars (p50) | Presença | Situação |
  |---|---|---|---|
  | `como_confirmo` | 537 | 98% | contrato, fica |
  | `o_que` | 430 | 98% | contrato, fica |
  | `por_que` | 154 | 98% | contrato, fica |
  | `origem` | 135 | 99% | cli e sessão, que o board pode tirar do cliente MCP e do token |
  | `harness` | 54 | **91%** | **ignorado desde a OCL-202**, e 10 recusas por harness mal-formado em 2 semanas |
- **`task_deliver`** (1,1k tokens):

  | Campo | Chars (p50) | Presença | Situação |
  |---|---|---|---|
  | `evidence` | 707 | 97% | substância, fica |
  | `summary` | 608 | 100% | substância, fica |
  | `transcript` | 201 | 93% | já foi declarado no claim |
  | `usage` | 138 | 98% | — |
  | `how_to_verify` | 142 | 90% | — |
  | `branch` | 23 | 84% | já registrado ou dado pela convenção |
- **Recusas que obrigam a reescrever tudo:**
  - `task_create`, 6%: harness como string, `como_confirmo` como string e título acima de 200 chars;
  - `task_deliver`, 6%: evidence como string em 21 das 31 recusas;
  - `task_claim`, 4%: modelo fora do enum em 10 casos, ALREADY_CLAIMED em 9;
  - `task_update`, 4%: chaves desconhecidas.

## Candidatos a corte

A regra do dono: quando um corte de escrita e um de leitura disputam prioridade, **o de escrita vence**. Cada linha diz o que cortar, por que é seguro e o que se perde.

**Escrita e turnos (ganham tempo)**

1. **[ESCRITA] Medir o usage sem digitar script.**
   - **O quê:** o board (plugin) ou o app entrega um comando curto já instalado, ou o app anexa o usage do pane.
   - **Ganho:** ~10 s em 85% das entregas, ≈ 9 s por card.
   - **Seguro porque:** o número continua medido do mesmo transcript.
   - **Perde-se:** nada.
2. **[ESCRITA] `task_deliver` aceita a forma curta.**
   - **O quê:** `evidence` como string ou lista de strings; `transcript` e `branch` herdados do claim quando omitidos.
   - **Ganho:** ~150 tokens por entrega, e some ~70% das recusas do deliver (cada uma custa ~14 s de reescrita).
   - **Perde-se:** nada, é o mesmo dado numa forma mais curta.
3. **[ESCRITA] `task_create` sem cerimônia.**
   - **O quê:** tirar `harness` do schema (ignorado, 91% escrevem, 10 recusas); `origem` opcional, com o cli e o token como padrão; `como_confirmo` aceitando "passo → esperado" em texto.
   - **Ganho:** ~1–2 s por card, e somem ~45% das recusas do create (cada uma custa ~18 s).
   - **Seguro porque:** o_que/por_que/como_confirmo continuam **obrigatórios**.
   - **Perde-se:** a origem declarada à mão quando difere do token. Compensa porque em 99% das chamadas ela repete o que o board já sabe.
4. **[ESCRITA] Aceitar o id do modelo como o CLI o reporta.**
   - **O quê:** tratar `claude-opus-5-5` como o id do catálogo no `task_claim`.
   - **Ganho:** some a recusa com reescrita (10 casos em 2 semanas).
   - **Perde-se:** nada.
5. **[TURNO] `branch_register` deixa de ser uma chamada.**
   - **O quê:** o branch vai no claim ou no deliver, que já aceita `branch`.
   - **Ganho:** 1 turno de 2,6 s em 27% das execuções, mais 3,2k chars lidos.
   - **Perde-se:** o registro do branch antes da entrega. Compensa porque a convenção do branch já vem no claim.
6. **[TURNO] OCL-208: resolver o projeto pelo repositório.**
   - **Medido:** em 757 criações reais, o remote ou o caminho do repo acertaria o projeto sozinho em **78%** (591). Seria ambíguo em 3% e apontaria outro projeto em 12%: são cards registrados de outro repositório, como este. Por isso o `project_id` explícito continua aceito.
   - **Ganho:** 2,9 s e 24k chars em 20% dos registros, ≈ 0,6 s por card.
   - **Veredito:** vale, mas é o sexto em tempo, não o primeiro.
7. **[TURNO] As ferramentas do board já chegam carregadas no pane do Claude.**
   - **O quê:** o app pré-carrega as definições do board, ou as definições ficam enxutas o bastante para não serem adiadas.
   - **Ganho:** 5,9 s × 0,53 ≈ 3 s por registro.
   - **Perde-se:** contexto fixo, que compensa se o candidato 13 encolher as definições.

**Servidor**

8. **[SERVIDOR] `task_search` com índice e limite no banco.**
   - **Medido:** p50 de 5–12 s nos dois últimos dias, p90 de 50–60 s. No PGlite o tempo cresce linearmente com o número de cards (10 ms com 50, 82 ms com 600).
   - **Nota:** é tempo de servidor, não de escrita nem de leitura.
   - **Perde-se:** nada.

**Leitura (ganham contexto e conta)**

9. **[LEITURA] Claim sem duplicatas.**
   - **O quê:** tirar `usage_recipe` (que repete o briefing), o contrato duplicado em `task{}`, a telemetria de orquestração para worker de card e a seção de edição de contexto.
   - **Ganho:** 27k → ~15k; com o candidato 1, ~8k.
   - **Perde-se:** nada, porque o que sai já está no briefing.
10. **[LEITURA] `insights_query` sem `group_by` devolve só totais, como a descrição promete.**
    - **Ganho:** 292k → ~2k.
    - **Perde-se:** nada, porque os grupos continuam disponíveis com `group_by`.
11. **[LEITURA] `project_list` e `mission_list` enxutos.**
    - **O quê:** só prefixo, nome e repo; `mission_list` mostra só as ativas por padrão.
    - **Ganho:** 24,2k → ~8k e 28,1k → ~10k.
    - **Perde-se:** contagens e organização por linha, que continuam disponíveis via `organization_list` e filtro.
12. **[LEITURA] `branch_register` (e qualquer escrita) devolve ack de ~150 chars**, não o card de 3–4k.
13. **[LEITURA fixa] Definições e instruções menores.**
    - **O quê:** encurtar as 6 maiores definições (21,1k de 43,6k) e parar de pendurar trechos de contexto de projeto nas instruções.
    - **Ganho:** contexto fixo menor em toda sessão, e as instruções param de crescer ~350 chars por projeto documentado.
    - **Perde-se:** os trechos de contexto de projeto nas instruções. Compensa porque o Claude Code já os corta em 2.048 chars.
14. **[LEITURA] `task_list` padrão vira a fila:** `aberto`/`em_execucao`, mais novos primeiro, em vez dos 50 mais antigos.

**Nota sobre o raciocínio antes de escrever.** No `task_create`, a mensagem tem 1,9k tokens para 941 de argumentos: metade é o modelo pensando no card. Isso é o custo de compor um contrato bom, e a dieta não mexe nele. O ganho está na cerimônia em volta do contrato.
