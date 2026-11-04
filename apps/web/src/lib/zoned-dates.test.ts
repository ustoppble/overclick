import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One zone for every date the board prints (E7 review).
 *
 * `toLocaleDateString()` and `getDate()` answer in the zone of whoever runs
 * them: the server renders a client component with its clock's zone and the
 * browser hydrates it with another, so a card touched at 22:30 in São Paulo
 * reads one day on one side and the next on the other. `lib/format.ts` is the
 * only place that formats a date, and it names the zone. Nothing else in the
 * app may call the locale formatters or read local date parts.
 */

const SRC = path.resolve(__dirname, "..");
const RAW_DATE_CALL =
  /\.toLocale(?:Date|Time)?String\(|\.get(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds)\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("dates are formatted in one place", () => {
  it("no source outside lib/format.ts calls a locale date formatter or reads local date parts", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.relative(SRC, file) !== path.join("lib", "format.ts"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${path.relative(SRC, file)}:${i + 1}` }))
          .filter(({ line }) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
          .filter(({ line }) => RAW_DATE_CALL.test(line))
          .map(({ at }) => at),
      );
    expect(offenders, `route these through lib/format.ts:\n${offenders.join("\n")}`).toEqual([]);
  });
});
