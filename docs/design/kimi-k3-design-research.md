# Kimi K3 para criação de design system — evidência, não reputação

> OCL-113. Pesquisa sobre se (e por que) o Kimi K3 se destaca em criação de design
> system/identidade visual, com evidência pública verificável e auditoria da
> entrega interna real (OCL-81). Onde um dado não foi encontrável, isto diz
> "não confirmado" em vez de afirmar.

## 1. Benchmarks públicos — evidência real, com data e amostra

Fonte primária: [Arena.ai](https://x.com/arena/status/2077824029126504525) (post
oficial, 16-17/07/2026) e leaderboards derivados que espelham os mesmos números
([Winzheng](https://www.winzheng.com/en/article/kimi-k3-tops-frontend-code-arena-moonshot-ai),
[FourWeekMBA](https://fourweekmba.com/ai-kimi-k3-moonshot-ai-arena-frontend-code-leaderboard-open-wei/),
[Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3)).

**Frontend Code Arena (Arena.ai), 17/07/2026:**

| Modelo | Elo | Votos válidos |
|---|---|---|
| Kimi K3 | 1679 (#1) | 1.757 |
| Claude Fable 5 | 1631 (#2) | 2.505 |
| GPT-5.6 Sol | 1618 (#3) | 2.542 |

- Kimi K3 subiu 17 posições em relação ao Kimi K2.6 (#18, 1515 pontos) — salto de
  164 pontos numa única geração de modelo.
- Por domínio: K3 ficou em #1 em 6 das 7 categorias avaliadas (inclui
  **Reference-Based Design** e Brand & Marketing — as mais próximas de "criar
  design system"), perdendo só em Gaming (#2, atrás do Fable 5).
- **Ressalva honesta:** a amostra do K3 (1.757 votos) é ~30% menor que a do
  Fable 5 e do GPT-5.6 Sol (2.5k+ votos cada) — o ranking é real, mas com menos
  observações que os concorrentes diretos nessa leitura.

**Design Arena Website leaderboard** ([BenchLM.ai](https://benchlm.ai/benchmarks/designarenawebsite),
dado atualizado 20/08/2026 — comparação direta com os modelos que a gente usa):

| Modelo | Elo |
|---|---|
| **Kimi K3** | **1368 (#1)** |
| Muse Spark 1.2 | 1329 |
| **Claude Opus 5** | **1327** |
| Claude Fable 5 | 1314 |
| Claude Opus 4.7 | 1307 |
| Claude Sonnet 4.6 | 1297 |
| **Claude Sonnet 5** | **1286** |

- Isto é a comparação lado a lado que o card pediu: K3 bate Opus 5 por 41 pontos
  de Elo e Sonnet 5 por 82 pontos, especificamente em geração de website/UI.
- Nota de metodologia do próprio benchmark: essa tabela é "exibida como
  referência, mas excluída da fórmula de score oficial" do site — ou seja, é
  um leaderboard secundário/experimental do Design Arena, não o headline
  principal. Tratar como sinal forte, não como veredito absoluto.
- Cross-check: outro espelho do mesmo leaderboard (benchmarklist.com/design_arena)
  retornou 403 ao fetch direto — **não confirmado** por uma segunda fonte
  independente além do BenchLM.ai; os números acima vêm de uma única fonte.

**Conclusão da seção:** há evidência pública real, com números e data, de que
K3 lidera tanto o Frontend Code Arena quanto o Design Arena Website — inclusive
à frente de Opus 5 e Sonnet 5 nominalmente. Isso não é reputação vaga; é
ranking de arena com Elo e contagem de votos. A ressalva é amostra menor no
Frontend Arena e fonte única (não cruzada) no Design Arena Website.

## 2. Comparação de custo — dado, não anedota

| Modelo | Input / 1M tok | Output / 1M tok | Reasoning effort |
|---|---|---|---|
| Kimi K3 | $3,00 | $15,00 | **travado em max** — sem variante barata ([fonte](https://benchlm.ai/moonshot/api-pricing)) |
| Claude Opus 5 | $5,00 | $25,00 | ajustável (inclui fast mode $10/$50, batch 50% off) |
| Claude Sonnet 5 | $2,00 | $10,00 | ajustável |

- No preço nominal por token, K3 fica **entre** Sonnet 5 e Opus 5 — mais caro
  que Sonnet 5, mais barato que Opus 5. Isoladamente isso não explica a
  instabilidade de crédito observada internamente.
- O ponto que dói na prática é outro: K3 "sempre raciocina", `reasoning_effort`
  preso em `max`, sem modo mais barato para tarefas simples — todo uso de K3
  paga o teto de reasoning, mesmo quando a tarefa não precisa. Isso é
  consistente com o padrão observado aqui (painéis K3 batendo limite de
  crédito antes de entregar), mas o preço por token sozinho não é a causa —
  é o volume de tokens de reasoning por chamada, que não temos telemetria
  própria pra medir exatamente (**não confirmado** quanto ao múltiplo exato
  de tokens gastos por tarefa vs Claude).

## 3. Auditoria interna — OCL-81 (a entrega real do K3 como design system)

Card: [OCL-81](https://github.com/ustoppble/overclick) — "Design system do
OverClick (K3)", harness `kimi/k3/max`, commit `74f7b83`, custo medido
**US$ 0,575** (cost_source: computed), `delivery_verification: verified`.

**O que foi entregue** (`docs/design/system/`, 1.105 linhas em 6 arquivos):
components.md/html, composition.md, decisions.md, microcopy.md, README.md.

- **Aderência a tokens: sólida.** `grep` por literais hex (`#rrggbb`) em
  `components.md` e `components.html` retornou **zero ocorrências** — a regra
  "só token, nunca hex" (doutrina §5.1) foi seguida à risca em toda a
  entrega, incluindo o exemplar HTML renderizável.
- **Qualidade do raciocínio de design: alta.** `decisions.md` documenta 9+
  decisões (D1-D9) no formato gap → decisão → rationale, cada uma citando o
  estado real do CSS legado (ex.: D1 lista literalmente as 9 variações de
  tamanho de fonte espalhadas em `nebula.css` — 9, 9.5, 10... 13.5px — antes
  de propor os 5 tokens que as substituem). Isso é auditoria real do código
  existente, não um sistema genérico copiado de outro lugar.
- **Especificação executável:** `components.md` define cada componente com
  altura exata, padding em `--oc-space-*`, estados rest/hover/focus/active/
  disabled listados na ordem de camada, e nota explícita de que "um executor
  consegue aplicar sem decidir nada visual" — o objetivo declarado do card.
- **Tentativa 2, não tentativa 1.** O harness registrado no card diz
  "tentativa 2: a entrega anterior foi reprovada, então o card subiu um elo
  da cadeia" — ou seja, essa entrega de qualidade só veio depois de uma
  primeira tentativa rejeitada. **Não confirmado** o que especificamente
  falhou na tentativa 1 (sem comentário registrado no card sobre o motivo).

**A instabilidade de crédito é real, mas não é o mesmo caso.** Não é anedota
solta — está documentada em cards próprios do board:

- [OCL-56](https://github.com/ustoppble/overclick) (origem): *"k3 do
  pane-3402 morreu por LIMITE sem produzir commit; dono moveu pra opus-5"* —
  card reaberto e entregue por Opus 5 (US$ 29,14, harness `opus-5/high`).
- [OCL-57](https://github.com/ustoppble/overclick): mesmo padrão — "k3 caiu
  por limite; há trabalho parcial NÃO commitado no worktree".
- [OCL-115/116/117](https://github.com/ustoppble/overclick) (as 3 "bancadas"
  de Design System v2 pedidas em paralelo em 20/08/2026): status
  **descartado**, mas o comentário do próprio card esclarece que **não foi
  falha do K3** — o dono mudou de estratégia (de 3 bancadas competindo para 3
  pesquisas colaborativas) antes de qualquer pane K3 produzir algo:
  *"K3 abertos à mão nem chegaram a produzir; custo mínimo preservado."*
  **Correção necessária:** não contar essas 3 como evidência de instabilidade
  — é decisão de produto, não falha de execução.

**Conclusão da seção:** a amostra real (OCL-81) confirma que K3, quando
completa, produz um design system tecnicamente rigoroso — zero hex, decisões
justificadas com evidência do código legado, specs executáveis por outro
agente. Mas a mesma missão (UX v2) tem pelo menos dois casos documentados
(OCL-34→56, OCL-35/36→57) de painel K3 morrendo por limite de crédito sem
commit, forçando reexecução por Opus 5 a custo bem mais alto (~50x nominal
nesse caso específico, embora as tarefas não sejam idênticas em escopo — não
é comparação controlada).

## 4. K3 vs Opus 5 vs Sonnet 5 — por dimensão, com o rótulo dado/anedota

| Dimensão | K3 ganha? | Base |
|---|---|---|
| Ranking em geração de UI/website (Elo público) | **Sim** — #1 no Frontend Code Arena e no Design Arena Website | Dado (§1) |
| Aderência estrita a tokens (zero hex) na amostra interna | Empatou/cumpriu — 100% na amostra OCL-81 | Dado (§3), amostra n=1 |
| Densidade de rationale por decisão de design | Alta na amostra OCL-81 (decisions.md cita o CSS legado linha a linha) | Dado (§3), amostra n=1, sem comparação lado a lado com Opus/Sonnet na mesma tarefa |
| Custo por token | Fica no meio (Sonnet5 < K3 < Opus5) | Dado (§2) |
| Estabilidade/conclusão da tarefa sem cair por limite | **Não** — pior que Opus 5 nesta missão | Dado (§3), 2 casos documentados |
| Velocidade percebida | K3 mais lento (relatado no card, "caro/lento/instável") | Anedota rotulada como tal — sem medição de latência própria |
| Variedade de composição / densidade visual | Não medido internamente | **Não confirmado** |

Não encontrei nenhuma comparação pública controlada (mesmo prompt, mesmo
avaliador) entre K3, Opus 5 e Sonnet 5 especificamente para "criar um design
system do zero" (tokens + componentes + decisions.md) — os leaderboards
existentes medem geração de website/frontend code de forma mais ampla, não a
tarefa específica de design system. A comparação de dimensão específica
"design system" vem só da amostra interna (n=1, OCL-81), que não teve
controle (Opus/Sonnet não rodaram a mesma tarefa em paralelo pra comparar
diretamente).

## 5. Conclusão acionável

**A tese "K3 se destaca em design/frontend" tem evidência real, não é só
reputação.** Dois leaderboards públicos independentes (Arena.ai Frontend Code
Arena e Design Arena Website, ambos de 2026, com Elo e contagem de votos)
colocam K3 à frente de Opus 5, Sonnet 5, Fable 5 e GPT-5.6 Sol em tarefas de
geração de UI/frontend, incluindo a categoria mais próxima de "design system"
(Reference-Based Design). A amostra interna (OCL-81) confirma qualidade real
quando a entrega completa: zero violação de token, decisões rastreáveis ao
código legado, spec executável.

**Mas a instabilidade de crédito também é real e documentada**, não é
percepção: dois casos concretos (OCL-56, OCL-57) de painel K3 morrendo por
limite sem commit na mesma missão, forçando reexecução por Opus 5. As 3
bancadas descartadas (OCL-115/116/117) **não contam** como evidência de
falha — foram canceladas por decisão de escopo antes de produzir, não por
travarem.

**Recomendação de política de harness:** manter K3 como executor de CRIAÇÃO
de design system (não para aplicação/manutenção — isso já é a divisão de
trabalho atual, K3 cria / Opus aplica), mas **condicionar a janela de
execução**: só disparar K3 quando (a) o escopo cabe numa única entrega sem
handoff entre panes (K3 trava em `max` reasoning e não tem variante barata
para retomar barato) e (b) há folga de crédito/tempo suficiente pro efeito
"sempre raciocina em max" não bater limite no meio da tarefa. Se a janela de
crédito estiver apertada ou a tarefa for grande (ex.: as bancadas v2
"absurdas, completas, com motion"), a evidência de OCL-56/57 diz para ir
direto de Opus 5 e não arriscar a queda de K3 no meio do caminho — não porque
K3 seja pior no resultado, mas porque o modo de falha dele (morre sem commit)
é mais caro que rodar Opus 5 desde o início quando o crédito está curto.

Não há evidência suficiente (nenhuma fonte encontrada) para dizer que a
vantagem de K3 se generaliza para qualquer forma de trabalho visual (ex.:
motion/glass complexos das bancadas v2 canceladas) — os leaderboards citados
medem geração de UI/website em geral, não especificamente sistemas de
design com motion e profundidade. Isso fica **não confirmado**.

## Fontes

- [Arena.ai — post oficial (X), 17/07/2026](https://x.com/arena/status/2077824029126504525)
- [Winzheng — Kimi K3 Tops Frontend Code Arena, 17/07/2026](https://www.winzheng.com/en/article/kimi-k3-tops-frontend-code-arena-moonshot-ai)
- [FourWeekMBA — Kimi-K3 Takes Top Spot](https://fourweekmba.com/ai-kimi-k3-moonshot-ai-arena-frontend-code-leaderboard-open-wei/)
- [Tom's Hardware — Kimi K3 2.8T parameter model](https://www.tomshardware.com/tech-industry/artificial-intelligence/moonshot-releases-2-8-trillion-parameter-kimi-k3)
- [BenchLM.ai — Design Arena Website leaderboard, dado 20/08/2026](https://benchlm.ai/benchmarks/designarenawebsite)
- [BenchLM.ai — Kimi API pricing, ago/2026](https://benchlm.ai/moonshot/api-pricing)
- Claude API pricing (Opus 5 $5/$25, Sonnet 5 $2/$10) — consenso de múltiplas
  fontes de pricing consultadas em 21/08/2026 (coursiv.io, eesel.ai, tminusai.com)
- Cards internos OverClick: OCL-81, OCL-56, OCL-57, OCL-115, OCL-116, OCL-117
  (board `overclick`, consultados 21/08/2026)
- `docs/design/system/` neste repo (commit `74f7b83`) — auditoria direta do
  código entregue
