import {
  block,
  enabled,
  hookHarness,
  mcpCall,
  parseJson,
  readStdin,
  recommendationHarness,
  failOpen,
} from "./common.mjs";

// The shell hook read the type straight off the raw payload with a grep rather
// than a parser, taking the LAST occurrence. Keep that: a nested contract can
// mention "type" too, and the tool_input one is written last.
function taskTypeOf(rawInput) {
  const matches = rawInput.match(/"type"\s*:\s*"(feature|bug|rfc)"/g);
  if (!matches || !matches.length) return "";
  return matches[matches.length - 1].match(/"(feature|bug|rfc)"$/)[1];
}

failOpen(async () => {
  if (!enabled("enforce_harness")) return;

  const rawInput = readStdin();
  const taskType = taskTypeOf(rawInput);
  if (!taskType) {
    block("OverClick could not determine the task type for harness recommendation.");
    return;
  }

  const recommendation = await mcpCall("harness_recommend", JSON.stringify({ type: taskType }));
  if (!recommendation) {
    block("OverClick could not read the current harness recommendation. Retry before task_create.");
    return;
  }

  const hookInput = parseJson(rawInput);
  const actual = hookInput ? hookHarness(hookInput) : "";
  const expected = recommendationHarness(recommendation);

  if (!actual || actual !== expected) {
    block("Call harness_recommend and use its current CLI, model, and effort in task_create.");
  }
});
