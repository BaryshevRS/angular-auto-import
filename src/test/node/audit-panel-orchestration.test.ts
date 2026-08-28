import * as assert from "node:assert";
import { runAuditPanelFixAll } from "../../commands/audit-panel-orchestration";

interface ApplyResult {
  applied: boolean;
}

interface Report {
  revision: number;
}

describe("Audit panel Fix All orchestration", () => {
  it("shows loading, applies directly, refreshes, and renders the fresh report in order", async () => {
    const calls: string[] = [];
    const freshReport: Report = { revision: 2 };

    const result = await runAuditPanelFixAll<ApplyResult, Report>({
      setLoading: (loading: boolean) => calls.push(`loading:${loading}`),
      apply: async () => {
        calls.push("apply");
        return { applied: true };
      },
      refresh: async () => {
        calls.push("refresh");
        return freshReport;
      },
      render: (report: Report) => {
        assert.strictEqual(report, freshReport, "render must receive the report returned by refresh");
        calls.push(`render:${report.revision}`);
      },
    });

    assert.deepStrictEqual(result, { applied: true });
    assert.deepStrictEqual(calls, ["loading:true", "apply", "refresh", "render:2", "loading:false"]);
  });

  it("still refreshes and renders after apply reports that nothing was applied", async () => {
    const calls: string[] = [];

    const result = await runAuditPanelFixAll<ApplyResult, Report>({
      setLoading: (loading: boolean) => calls.push(`loading:${loading}`),
      apply: async () => {
        calls.push("apply:false");
        return { applied: false };
      },
      refresh: async () => {
        calls.push("refresh");
        return { revision: 3 };
      },
      render: (report: Report) => calls.push(`render:${report.revision}`),
    });

    assert.deepStrictEqual(result, { applied: false });
    assert.deepStrictEqual(calls, ["loading:true", "apply:false", "refresh", "render:3", "loading:false"]);
  });

  it("refreshes and renders in finally before propagating an apply failure", async () => {
    const calls: string[] = [];
    const failure = new Error("apply failed");

    await assert.rejects(
      runAuditPanelFixAll<ApplyResult, Report>({
        setLoading: (loading: boolean) => calls.push(`loading:${loading}`),
        apply: async () => {
          calls.push("apply:throw");
          throw failure;
        },
        refresh: async () => {
          calls.push("refresh");
          return { revision: 4 };
        },
        render: (report: Report) => calls.push(`render:${report.revision}`),
      }),
      (error: unknown) => error === failure
    );

    assert.deepStrictEqual(calls, ["loading:true", "apply:throw", "refresh", "render:4", "loading:false"]);
  });
});
