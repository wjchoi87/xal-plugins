import {
  activeProfileId,
  getReports,
  modelCountByStatus,
  type SourceReport,
} from "./models";
import { toProviderModelId } from "./model-sources";
import { PROVIDER_NAME } from "./provider";
import type { Command, CommandContext } from "./types";

function printReport(
  print: (line: string) => void,
  report: SourceReport,
): void {
  const header = report.source === "zen" ? "ZEN FREE" : "GO FREE";
  print("");
  print(
    `${header} (${report.origin}${report.error ? ` — ${report.error}` : ""})`,
  );
  const free = report.evaluations.filter(
    (record) => record.evaluation.status === "free",
  );
  if (free.length === 0) {
    print("  (none)");
  } else {
    for (const record of free) {
      print(
        `  ${record.model.upstreamId}\n    reason=${record.evaluation.reason} confidence=${record.evaluation.confidence}`,
      );
    }
  }

  const dropped = report.evaluations.filter(
    (record) => record.evaluation.status !== "free",
  );
  print("DROPPED");
  if (dropped.length === 0) {
    print("  (none)");
  } else {
    for (const record of dropped) {
      print(
        `  ? ${toProviderModelId(report.source, record.model.upstreamId)}\n    reason=${record.evaluation.reason}`,
      );
    }
  }
  const counts = modelCountByStatus(report);
  print(
    `  ${report.source === "zen" ? "Zen" : "Go"} Free: ${counts.free}, Dropped: ${counts.paid + counts.unknown}, Unknown: ${counts.unknown}`,
  );
}

export const debugCommand: Command = {
  name: "opencode-free",
  aliases: [],
  describe: `inspect ${PROVIDER_NAME} model classification`,
  hidden: true,
  async run(args: string[], ctx: CommandContext): Promise<void> {
    if (args[0] !== "models") {
      throw new Error("usage: opencode-free models");
    }
    const profileId = activeProfileId();
    if (!profileId) {
      ctx.print(
        `${PROVIDER_NAME}: no active profile yet. Run /models once, then retry this command.`,
      );
      return;
    }
    const reports = await getReports(profileId, true);
    for (const report of reports) {
      printReport(ctx.print, report);
    }
  },
};
