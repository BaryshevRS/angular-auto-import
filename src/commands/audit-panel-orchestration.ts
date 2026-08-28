export interface AuditPanelFixAllOptions<ApplyResult, Report> {
  setLoading(loading: boolean): void;
  apply(): PromiseLike<ApplyResult>;
  refresh(): PromiseLike<Report>;
  render(report: Report): void;
}

export async function runAuditPanelFixAll<ApplyResult, Report>(
  options: AuditPanelFixAllOptions<ApplyResult, Report>
): Promise<ApplyResult> {
  options.setLoading(true);

  try {
    return await options.apply();
  } finally {
    try {
      const report = await options.refresh();
      options.render(report);
    } finally {
      options.setLoading(false);
    }
  }
}
