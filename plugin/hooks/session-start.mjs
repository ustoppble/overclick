import { mcpCall, renderBoard, failOpen } from "./common.mjs";

failOpen(async () => {
  const queue = await mcpCall("task_list", '{"status":"aberto","limit":10}');
  const claims = await mcpCall(
    "task_list",
    '{"status":"em_execucao","claimed_by":"me","limit":10}',
  );

  if (!queue) return;
  process.stdout.write("OverClick board snapshot\n");

  const open = renderBoard(queue, "Open queue");
  if (!open) return;
  process.stdout.write(`${open.join("\n")}\n`);

  if (!claims) return;
  const mine = renderBoard(claims, "Your active claims");
  if (mine) process.stdout.write(`${mine.join("\n")}\n`);
});
