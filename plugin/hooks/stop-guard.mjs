import { block, countTasks, enabled, mcpCall, failOpen } from "./common.mjs";

failOpen(async () => {
  if (!enabled("enforce_stop")) return;

  const claims = await mcpCall(
    "task_list",
    '{"status":"em_execucao","claimed_by":"me","limit":2}',
  );
  if (!claims) return;

  if (countTasks(claims) > 0) {
    block(
      "An OverClick card is still claimed by this token. Deliver it or call task_release before stopping.",
    );
  }
});
