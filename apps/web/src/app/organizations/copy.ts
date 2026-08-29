/**
 * Organizations copy lives with the page, the way Insights does, so this card
 * ships without touching the shared dictionary for text only one screen says.
 * Same product voice: direct, no enthusiasm, no em dash.
 */
const en = {
  title: "Organizations",
  sub: "One section per business: the repositories under it, the missions still running, and what the work there consumed.",
  backToBoard: "Board",
  manage: "Manage in Settings",
  projects: "Projects",
  activeMissions: "Active missions",
  noProjects: "No project here yet.",
  noMissions: "No mission running.",
  totalTokens: "Tokens",
  totalTime: "Execution time",
  totalCost: "Cost",
  attempts: "Attempts",
  /** Elapsed never joins the execution sum: it is said apart, with its count. */
  elapsedNote: (value: string, n: number) =>
    `+ ${value} elapsed on ${n} run${n === 1 ? "" : "s"} that reported no execution time`,
  noCost: "not priced",
  estimatedCount: (n: number) => `${n} estimated`,
  missingCount: (n: number) => `${n} usage not reported`,
  allReported: "all usage reported",
  openBoard: "Open on the board",
  empty:
    "No organization yet. Settings is where the first one is created.",
};

export type OrganizationsCopy = typeof en;

const ptBR: OrganizationsCopy = {
  title: "Organizações",
  sub: "Uma seção por negócio: os repositórios dele, as missões ainda em curso e o que o trabalho ali consumiu.",
  backToBoard: "Board",
  manage: "Gerenciar em Configurações",
  projects: "Projetos",
  activeMissions: "Missões ativas",
  noProjects: "Nenhum projeto aqui ainda.",
  noMissions: "Nenhuma missão em curso.",
  totalTokens: "Tokens",
  totalTime: "Tempo de execução",
  totalCost: "Custo",
  attempts: "Tentativas",
  elapsedNote: (value: string, n: number) =>
    `+ ${value} de espera em ${n} execuç${n === 1 ? "ão" : "ões"} que não reportaram tempo de execução`,
  noCost: "sem preço",
  estimatedCount: (n: number) => `${n} estimada${n === 1 ? "" : "s"}`,
  missingCount: (n: number) => `${n} sem uso reportado`,
  allReported: "todo uso reportado",
  openBoard: "Abrir no board",
  empty:
    "Nenhuma organização ainda. A primeira se cria em Configurações.",
};

export function organizationsCopy(lang: string | null | undefined): OrganizationsCopy {
  return lang === "pt-BR" ? ptBR : en;
}
