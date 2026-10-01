// Not part of the suite: a proof run over Pawel's real open tasks (snapshot of
// 2026-10-01 11:38), printing the tiers, the reason line on every Now and
// Next tile, and the same map with every date moved into the future. Run:
//   npx vitest run real-data.proof --reporter=basic
import { it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { buildMap } from "./model";
import { buildHeat, heatOrder, heatStats } from "./heat";
import type { MapTask } from "./server";
import { task, data } from "./fixtures";

const DIR = "/Users/wiz/.bb/thread-storage/thr_7mbqu2j4zn/v0116";
const OUT = "/Users/wiz/.bb/thread-storage/thr_mgh5t7c2uk/v0117";
const now = new Date("2026-10-01T12:30:00").getTime();
const DAY = 86400000;
const day = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function load(shift: (due: string | null, index: number) => string | null) {
  const tasks: MapTask[] = [];
  const projects: { id: string; name: string; prefix: string }[] = [];
  let index = 0;
  for (const file of readdirSync(DIR).filter((f) => /^tasks-[A-Z]+\.json$/.test(f)).sort()) {
    const raw = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
    for (const t of raw.tasks ?? []) {
      if (!projects.some((p) => p.id === t.projectId))
        projects.push({ id: t.projectId, name: t.key.split("-")[0], prefix: t.key.split("-")[0] });
      tasks.push(
        task({
          id: t.id, projectId: t.projectId, key: t.key, title: t.title, status: t.status,
          priority: t.priority, dueDate: shift(t.dueDate, index++), dateKind: "deadline",
          createdAt: t.createdAt, updatedAt: t.updatedAt, statusSince: t.updatedAt,
          threadIds: [], sessionLinks: [],
        }),
      );
    }
  }
  const snapshot = { ...data(tasks), projects: projects.map((p) => ({ ...p, linkedBbProjectId: null })) };
  return buildMap(snapshot as never, [], {}, now);
}
function report(title: string, roots: ReturnType<typeof load>) {
  const areas = buildHeat(roots, now);
  const stats = heatStats(areas, now);
  const lines: string[] = [`# ${title}`, `stats: ${JSON.stringify(stats)}`];
  const hist = { now: 0, next: 0, later: 0 };
  const rows: string[] = ["", "| key | tier | rank | priority | date | reason on the tile | title |", "|---|---|---|---|---|---|---|"];
  const all: { key: string; tier: string; rank?: number; pull: number }[] = [];
  for (const area of areas) {
    const tiles = heatOrder(area.tiles).filter((t) => t.item);
    lines.push(`## ${area.title}  tier ${area.tier}  weight ${area.weight}  tiles ${tiles.length}`);
    for (const t of tiles) {
      hist[t.tier]++;
      const key = t.item!.task?.key ?? t.id;
      all.push({ key, tier: t.tier, rank: t.rank, pull: t.pull });
      lines.push(`  ${t.rank ? `#${t.rank} ` : "   "}${key.padEnd(8)} ${t.tier.padEnd(5)} pull ${t.pull.toFixed(3)}  size ${t.weight.toFixed(3)}  ${(t.item!.task?.priority ?? "").padEnd(6)} ${(t.timing?.label ?? "").padEnd(14)} ${t.reason ? `"${t.reason}"` : ""}  ${t.item!.title.slice(0, 44)}`);
      if (t.tier !== "later")
        rows.push(`| ${key} | ${t.tier} | ${t.rank ?? ""} | ${t.item!.task?.priority} | ${t.timing?.label ?? ""} | ${t.reason} | ${t.item!.title.slice(0, 50).replace(/\|/g, "/")} |`);
    }
  }
  const cases = ["WIZ-70", "WIZ-91", "WIZ-110", "WIZ-33"].map((k) => {
    const t = areas.flatMap((a) => a.tiles).find((t) => t.item?.task?.key === k);
    return t ? `- ${k}: **${t.tier}**${t.rank ? ` #${t.rank}` : ""}, label row says "${t.reason || t.timing?.label}" (priority ${t.item!.task?.priority}, ${t.timing?.label})` : `- ${k}: not drawn`;
  });
  return [
    ...lines.slice(0, 2),
    `tiers: now ${hist.now} · next ${hist.next} · later ${hist.later}  (drawn ${all.length})`,
    "", "## His four cases", ...cases, "", "## Every Now and Next tile", ...rows, "", "## All tiles", ...lines.slice(2),
  ].join("\n");
}
it("tiers the real data", () => {
  const real = report("Real data, 2026-10-01", load((due) => due));
  // The same tasks with every date in the future: the slipped ones spread over
  // the next five weeks, the current ones kept as they are.
  const future = report(
    "No-overdue fixture: every past date moved ahead",
    load((due, index) => {
      if (!due) return due;
      const days = (Date.parse(`${due}T00:00:00`) - now) / DAY;
      return days < -0.5 ? day(now + (1 + (index % 35)) * DAY) : due;
    }),
  );
  writeFileSync(`${OUT}/real-data-tiers.md`, `${real}\n\n${future}\n`);
  console.log(real);
  console.log(future);
});
