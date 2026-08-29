import { relations } from "drizzle-orm";
import { executionAttempt } from "./execution-attempt";
import { handoff } from "./handoff";
import { mcpToken } from "./mcp-token";
import { mission } from "./mission";
import { missionAttempt } from "./mission-attempt";
import { missionAttemptReport } from "./mission-attempt-report";
import { organization } from "./organization";
import { project } from "./project";
import { projectContextAudit } from "./project-context-audit";
import { taskComment } from "./task-comment";
import { task } from "./task";
import { user } from "./user";
import { workspace } from "./workspace";
import { cardapioEntry } from "./cardapio-entry";
import { modelPrice } from "./model-price";
import { usageRecipe } from "./usage-recipe";

export const workspaceRelations = relations(workspace, ({ many }) => ({
  organizations: many(organization),
  missions: many(mission),
  projects: many(project),
  mcpTokens: many(mcpToken),
  cardapioEntries: many(cardapioEntry),
  modelPrices: many(modelPrice),
  usageRecipes: many(usageRecipe),
}));

export const organizationRelations = relations(
  organization,
  ({ one, many }) => ({
    workspace: one(workspace, {
      fields: [organization.workspaceId],
      references: [workspace.id],
    }),
    projects: many(project),
    missions: many(mission),
  }),
);

export const modelPriceRelations = relations(modelPrice, ({ one }) => ({
  workspace: one(workspace, {
    fields: [modelPrice.workspaceId],
    references: [workspace.id],
  }),
}));

export const usageRecipeRelations = relations(usageRecipe, ({ one }) => ({
  workspace: one(workspace, {
    fields: [usageRecipe.workspaceId],
    references: [workspace.id],
  }),
}));

export const cardapioEntryRelations = relations(cardapioEntry, ({ one }) => ({
  workspace: one(workspace, {
    fields: [cardapioEntry.workspaceId],
    references: [workspace.id],
  }),
}));

export const missionRelations = relations(mission, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [mission.workspaceId],
    references: [workspace.id],
  }),
  organization: one(organization, {
    fields: [mission.organizationId],
    references: [organization.id],
  }),
  tasks: many(task),
  attempts: many(missionAttempt),
}));

export const projectContextAuditRelations = relations(
  projectContextAudit,
  ({ one }) => ({
    project: one(project, {
      fields: [projectContextAudit.projectId],
      references: [project.id],
    }),
  }),
);

export const projectRelations = relations(project, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [project.workspaceId],
    references: [workspace.id],
  }),
  organization: one(organization, {
    fields: [project.organizationId],
    references: [organization.id],
  }),
  tasks: many(task),
  missionAttempts: many(missionAttempt),
  contextAudits: many(projectContextAudit),
}));

export const missionAttemptRelations = relations(
  missionAttempt,
  ({ one, many }) => ({
    mission: one(mission, {
      fields: [missionAttempt.missionId],
      references: [mission.id],
    }),
    project: one(project, {
      fields: [missionAttempt.projectId],
      references: [project.id],
    }),
    reports: many(missionAttemptReport),
  }),
);

export const missionAttemptReportRelations = relations(
  missionAttemptReport,
  ({ one }) => ({
    attempt: one(missionAttempt, {
      fields: [missionAttemptReport.missionAttemptId],
      references: [missionAttempt.id],
    }),
  }),
);

export const taskRelations = relations(task, ({ one, many }) => ({
  project: one(project, {
    fields: [task.projectId],
    references: [project.id],
  }),
  mission: one(mission, {
    fields: [task.missionId],
    references: [mission.id],
  }),
  parent: one(task, {
    fields: [task.parentId],
    references: [task.id],
    relationName: "subtasks",
  }),
  subtasks: many(task, { relationName: "subtasks" }),
  supersedes: one(task, {
    fields: [task.supersedesId],
    references: [task.id],
    relationName: "task_supersedes",
  }),
  supersededBy: one(task, {
    fields: [task.supersededById],
    references: [task.id],
    relationName: "task_superseded_by",
  }),
  createdBy: one(user, {
    fields: [task.createdByUserId],
    references: [user.id],
  }),
  reviewer: one(user, {
    fields: [task.devolveParaUserId],
    references: [user.id],
  }),
  attempts: many(executionAttempt),
  handoffs: many(handoff),
  comments: many(taskComment),
}));

export const executionAttemptRelations = relations(
  executionAttempt,
  ({ one, many }) => ({
    task: one(task, {
      fields: [executionAttempt.taskId],
      references: [task.id],
    }),
    handoffs: many(handoff),
  }),
);

export const handoffRelations = relations(handoff, ({ one }) => ({
  task: one(task, {
    fields: [handoff.taskId],
    references: [task.id],
  }),
  attempt: one(executionAttempt, {
    fields: [handoff.attemptId],
    references: [executionAttempt.id],
  }),
}));

export const mcpTokenRelations = relations(mcpToken, ({ one }) => ({
  workspace: one(workspace, {
    fields: [mcpToken.workspaceId],
    references: [workspace.id],
  }),
  createdBy: one(user, {
    fields: [mcpToken.createdByUserId],
    references: [user.id],
  }),
}));

export const taskCommentRelations = relations(taskComment, ({ one }) => ({
  task: one(task, {
    fields: [taskComment.taskId],
    references: [task.id],
  }),
  author: one(user, {
    fields: [taskComment.authorUserId],
    references: [user.id],
  }),
}));
