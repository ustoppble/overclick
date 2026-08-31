/**
 * Insights copy lives with the page so this card ships without touching the
 * shared dictionary. Same product voice: direct, no enthusiasm, no em dash.
 */
import type { Lang } from "../../lib/i18n";

const en = {
  /** The locale the money formatter reads off any copy object in hand. */
  lang: "en" as Lang,
  title: "Insights",
  sub: "What this board consumes: execution and orchestration tokens and time per project, per mission, per release, per executor, per model, per card.",
  backToBoard: "Board",
  totalCost: "Total cost",
  totalTokens: "Total tokens",
  totalTime: "Execution time",
  /** Elapsed never joins the execution sum: it is said apart, with its count. */
  elapsedNote: (value: string, n: number) =>
    `+ ${value} elapsed on ${n} run${n === 1 ? "" : "s"} that reported no execution time`,
  elapsedTag: (value: string) => `open for ${value}`,
  attempts: "Attempts",
  executionLine: "execution",
  orchestrationLine: "orchestration",
  totalLine: "total",
  executionSubtotal: (tokens: string, time: string, attempts: number) =>
    `execution ${tokens} · ${time} · ${attempts} attempt${attempts === 1 ? "" : "s"}`,
  orchestrationSubtotal: (tokens: string, time: string, attempts: number) =>
    `orchestration ${tokens} · ${time} · ${attempts} attempt${attempts === 1 ? "" : "s"}`,
  estimatedCount: (n: number) => `${n} estimated`,
  missingCount: (n: number) => `${n} usage not reported`,
  zeroUsageCount: (n: number) => `${n} reported zero usage`,
  suspectCount: (n: number) => `${n} suspect`,
  unverifiedCount: (n: number) => `${n} commit${n === 1 ? "" : "s"} unverified`,
  suspectSeparate: (tokens: string) =>
    `${tokens} above the possible claim window, marked suspect in the total`,
  allReported: "all usage reported",
  byProject: "By project",
  byMission: "By mission",
  byExecutor: "By executor",
  byModel: "By model",
  sharedModelsNote: (n: number) =>
    `${n} run${n === 1 ? "" : "s"} switched model. Tokens are split per model; the duration is not, so the times below overlap.`,
  reopenedByModel: "Reopened rate by model",
  perCard: "Cost per card",
  perCardNoMoney: "Per card",
  colName: "name",
  colCard: "card",
  colProject: "project",
  colMission: "mission",
  colModel: "model",
  colCost: "cost",
  colTokens: "tokens",
  colTime: "execution",
  colAttempts: "attempts",
  colUnverified: "unverified",
  colDeliveries: "deliveries",
  colReopened: "reopened",
  colRate: "rate",
  noMission: "no mission",
  noModel: "model not reported",
  modelFromHarness: "via harness",
  costNotReported: "not reported",
  /** Never "US$ 0.00": a model nobody priced did not work for free. */
  costNoPrice: "no price",
  costNoPriceFor: (models: string) => `no price for ${models}`,
  costZeroUsage: "usage reported as zero",
  noPriceTitle: (tokens: string) =>
    `${tokens} spent by a model with no price in Settings, counted apart from the cost`,
  unpricedTokensNote: (tokens: string) =>
    `${tokens} on models with no price, not in the total above`,
  estimatedTag: "estimated",
  missingTag: "usage not reported",
  colSource: "cost from",
  sourceComputed: "computed",
  sourceReported: "agent reported",
  sourceEstimated: "estimated",
  sourceMixed: "mixed",
  sourceNone: "—",
  computedCount: (n: number) => `${n} computed`,
  reportedCount: (n: number) => `${n} agent reported`,
  unpricedCount: (n: number) => `${n} unpriced model`,
  noCostSource: "no cost to attribute",
  pricesNote: "Cost is computed and frozen from the price table when deliver or task_update reports tokens.",
  sortHint: "click a column to sort",
  trendCostTitle: "Spend over time",
  trendTokensTitle: "Tokens over time",
  trendAttempts: (n: number) => `${n} run${n === 1 ? "" : "s"}`,
  trendPeak: (value: string, day: string) => `peak ${value} · ${day}`,
  trendDays: (n: number) => `${n} day${n === 1 ? "" : "s"}`,
  shareCostTitle: "Share of cost by model",
  shareTokensTitle: "Share of tokens by model",
  shareNote: "share among the models below",
  /** Footnote qualifiers: the marker, what it means, then the rows it hits. */
  footEstimated: (items: string) => `≈ estimated: ${items}`,
  footMissing: (items: string) => `○ usage not reported: ${items}`,
  footZeroUsage: (items: string) => `0 usage reported as zero: ${items}`,
  footSuspect: (items: string) => `! suspect usage, counted in the total: ${items}`,
  footElapsed: (items: string) => `+ elapsed, never added: ${items}`,
  footUnpriced: (items: string) => `no price: ${items}`,
  footUnverified: (items: string) => `commit not found on remote: ${items}`,
  /** Inline key so every table symbol is readable without leaving the page. */
  symbolsLegend:
    "⌀ no price · ! suspect usage · + elapsed only · ≈ estimated · 0 zero usage · ○ usage not reported",
  emptyTitle: "Nothing measured yet.",
  empty:
    "No delivered work yet. When an agent claims and delivers a card, its tokens and time land here.",
  emptyCta: "Open the board",
  emptyReopens:
    "No deliveries to measure. The reopened rate appears after the first review cycle.",
  /**
   * The board hands its filter over in the link, so the page says what it is
   * counting and offers the way back to the whole workspace.
   */
  filteredBy: "Counting only",
  filterProjects: (n: number) => `${n} project${n === 1 ? "" : "s"}`,
  filterMission: "one mission",
  filterNoMission: "cards with no mission",
  filterRelease: (value: string) => `release ${value}`,
  filterNoRelease: "cards with no release",
  filterTypes: (values: string[]) => `type ${values.join(" or ")}`,
  filterPriorities: (values: string[]) => {
    const labels: Record<string, string> = {
      urgente: "urgent",
      alta: "high",
      media: "medium",
      baixa: "low",
    };
    return `priority ${values.map((value) => labels[value] ?? value).join(" or ")}`;
  },
  clearFilter: "Count everything",
};

export type InsightsCopy = typeof en;

const ptBR: InsightsCopy = {
  lang: "pt-BR" as Lang,
  title: "Insights",
  sub: "O que este board consome: tokens e tempo de execução e orquestração por projeto, por missão, por release, por executor, por modelo, por card.",
  backToBoard: "Board",
  totalCost: "Custo total",
  totalTokens: "Tokens totais",
  totalTime: "Tempo de execução",
  elapsedNote: (value: string, n: number) =>
    `+ ${value} decorrido${n === 1 ? "" : "s"} em ${n} execuç${n === 1 ? "ão que não reportou" : "ões que não reportaram"} tempo de execução`,
  elapsedTag: (value: string) => `aberto por ${value}`,
  attempts: "Execuções",
  executionLine: "execução",
  orchestrationLine: "orquestração",
  totalLine: "total",
  executionSubtotal: (tokens: string, time: string, attempts: number) =>
    `execução ${tokens} · ${time} · ${attempts} execuç${attempts === 1 ? "ão" : "ões"}`,
  orchestrationSubtotal: (tokens: string, time: string, attempts: number) =>
    `orquestração ${tokens} · ${time} · ${attempts} execuç${attempts === 1 ? "ão" : "ões"}`,
  estimatedCount: (n: number) => `${n} estimado${n === 1 ? "" : "s"}`,
  missingCount: (n: number) => `${n} sem uso reportado`,
  zeroUsageCount: (n: number) => `${n} com uso reportado como zero`,
  suspectCount: (n: number) => `${n} suspeito${n === 1 ? "" : "s"}`,
  unverifiedCount: (n: number) => `${n} commit${n === 1 ? "" : "s"} não verificado${n === 1 ? "" : "s"}`,
  suspectSeparate: (tokens: string) =>
    `${tokens} acima do possível na janela do claim, marcados como suspeitos no total`,
  allReported: "todo uso reportado",
  byProject: "Por projeto",
  byMission: "Por missão",
  byExecutor: "Por executor",
  byModel: "Por modelo",
  sharedModelsNote: (n: number) =>
    `${n} execuç${n === 1 ? "ão trocou" : "ões trocaram"} de modelo. Os tokens são separados por modelo; a duração não, então os tempos abaixo se sobrepõem.`,
  reopenedByModel: "Taxa de reabertura por modelo",
  perCard: "Custo por card",
  perCardNoMoney: "Por card",
  colName: "nome",
  colCard: "card",
  colProject: "projeto",
  colMission: "missão",
  colModel: "modelo",
  colCost: "custo",
  colTokens: "tokens",
  colTime: "execução",
  colAttempts: "execuções",
  colUnverified: "não verificados",
  colDeliveries: "entregas",
  colReopened: "reabertos",
  colRate: "taxa",
  noMission: "sem missão",
  noModel: "modelo não reportado",
  modelFromHarness: "via harness",
  costNotReported: "não reportado",
  costNoPrice: "sem preço",
  costNoPriceFor: (models: string) => `sem preço para ${models}`,
  costZeroUsage: "uso reportado como zero",
  noPriceTitle: (tokens: string) =>
    `${tokens} gastos por um modelo sem preço em Configurações, contados à parte do custo`,
  unpricedTokensNote: (tokens: string) =>
    `${tokens} em modelos sem preço, fora do total acima`,
  estimatedTag: "estimado",
  missingTag: "uso não reportado",
  colSource: "custo veio de",
  sourceComputed: "calculado",
  sourceReported: "reportado pelo agente",
  sourceEstimated: "estimado",
  sourceMixed: "misto",
  sourceNone: "—",
  computedCount: (n: number) => `${n} calculado${n === 1 ? "" : "s"}`,
  reportedCount: (n: number) => `${n} reportado${n === 1 ? "" : "s"} pelo agente`,
  unpricedCount: (n: number) => `${n} modelo${n === 1 ? "" : "s"} sem preço`,
  noCostSource: "nenhum custo para atribuir",
  pricesNote: "O custo é calculado e congelado pela tabela de preços quando deliver ou task_update reporta tokens.",
  sortHint: "clique numa coluna para ordenar",
  trendCostTitle: "Gasto ao longo do tempo",
  trendTokensTitle: "Tokens ao longo do tempo",
  trendAttempts: (n: number) => `${n} execuç${n === 1 ? "ão" : "ões"}`,
  trendPeak: (value: string, day: string) => `pico ${value} · ${day}`,
  trendDays: (n: number) => `${n} dia${n === 1 ? "" : "s"}`,
  shareCostTitle: "Participação no custo por modelo",
  shareTokensTitle: "Participação nos tokens por modelo",
  shareNote: "participação entre os modelos abaixo",
  footEstimated: (items: string) => `≈ estimado: ${items}`,
  footMissing: (items: string) => `○ sem uso reportado: ${items}`,
  footZeroUsage: (items: string) => `0 uso reportado como zero: ${items}`,
  footSuspect: (items: string) => `! uso suspeito, somado no total: ${items}`,
  footElapsed: (items: string) => `+ decorrido, não somado: ${items}`,
  footUnpriced: (items: string) => `sem preço: ${items}`,
  footUnverified: (items: string) => `commit não encontrado no remoto: ${items}`,
  symbolsLegend:
    "⌀ sem preço · ! uso suspeito · + só decorrido · ≈ estimado · 0 uso reportado como zero · ○ sem uso reportado",
  emptyTitle: "Nada medido ainda.",
  empty:
    "Nenhuma entrega ainda. Quando um agente pegar e entregar um card, os tokens e o tempo aparecem aqui.",
  emptyCta: "Abrir o board",
  emptyReopens:
    "Nenhuma entrega para medir. A taxa de reabertura aparece depois do primeiro ciclo de revisão.",
  filteredBy: "Contando apenas",
  filterProjects: (n: number) => `${n} projeto${n === 1 ? "" : "s"}`,
  filterMission: "uma missão",
  filterNoMission: "cards sem missão",
  filterRelease: (value: string) => `release ${value}`,
  filterNoRelease: "cards sem release",
  filterTypes: (values) => `tipo ${values.join(" ou ")}`,
  filterPriorities: (values) => {
    const labels: Record<string, string> = {
      urgente: "urgente",
      alta: "alta",
      media: "média",
      baixa: "baixa",
    };
    return `prioridade ${values.map((value) => labels[value] ?? value).join(" ou ")}`;
  },
  clearFilter: "Contar tudo",
};

export function insightsCopy(lang: string | null | undefined): InsightsCopy {
  return lang === "pt-BR" ? ptBR : en;
}
