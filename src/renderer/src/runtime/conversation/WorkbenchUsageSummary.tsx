import { type ReactElement, useMemo } from "react";

import {
  ChatTaskUsagePopover,
  type ChatTaskUsageTotals,
} from "@velaros-ai/ui/conversation";

import { useWorkbenchI18n } from "../../i18n/WorkbenchLocalizationProvider";
import {
  type StandaloneUsageTelemetry,
  summarizeStandaloneUsage,
} from "../standaloneUsageTelemetry";

function totals(
  entries: readonly StandaloneUsageTelemetry[],
): ChatTaskUsageTotals {
  const value = summarizeStandaloneUsage(entries);
  return {
    requests: value.requests,
    inputTokens: value.input,
    outputTokens: value.output,
    cacheReadTokens: value.cacheRead,
    incompleteRequests: value.missing,
    cacheMissingRequests: value.cacheMissing,
  };
}

export function WorkbenchUsageSummary({
  entries,
  startedAt,
}: {
  entries: readonly StandaloneUsageTelemetry[];
  startedAt: number | null;
}): ReactElement {
  const { locale } = useWorkbenchI18n();
  const zh = locale === "zh-CN";
  const summary = useMemo(() => {
    const current = entries.filter(
      (entry) => !startedAt || entry.timestamp >= startedAt,
    );
    return totals(current);
  }, [entries, startedAt]);
  return (
    <ChatTaskUsagePopover
      locale={locale}
      total={summary}
      labels={{
        title: zh ? "本次任务用量" : "Task usage",
        requests: zh ? "请求数" : "Requests",
        input: zh ? "输入" : "Input",
        output: zh ? "输出" : "Output",
        cache: zh ? "缓存命中" : "Cache hit",
      }}
    />
  );
}
