import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { describe, test } from "bun:test";

import {
  conversationEnUSMessages,
  conversationZhCNMessages,
} from "@velaros-ai/ui/conversation";

function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

void describe("Workbench shared chat scrolling", () => {
  void test("keeps the conversation body mounted while streaming revisions advance", () => {
    const adapter = readSource(
      "src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx",
    );
    const panel = readSource(
      "src/renderer/src/components/chat/WorkbenchChatPanel.tsx",
    );

    assert.match(
      adapter,
      /useScrollToBottom<HTMLDivElement>\(\s*chat\.revision,/u,
    );
    assert.match(adapter, /conversationRefreshKey=\{conversationRefreshKey\}/u);
    assert.doesNotMatch(adapter, /conversationRefreshKey=\{chat\.revision\}/u);
    assert.match(panel, /conversationRefreshKey=\{currentSession\.id\}/u);
  });

  void test("starts with ordinary auto-follow instead of a forced follow lock", () => {
    const adapter = readSource(
      "src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx",
    );

    assert.match(adapter, /useScrollToBottom<HTMLDivElement>/u);
    assert.doesNotMatch(
      adapter,
      /const \[followLocked,\s*setFollowLocked\]\s*=\s*useState\(true\)/u,
    );
  });

  void test("lets the Workbench header hide the entire shared navigator", () => {
    const panel = readSource(
      "src/renderer/src/components/chat/WorkbenchChatPanel.tsx",
    );
    const adapter = readSource(
      "src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx",
    );

    // 楼层导航默认收起，点标题栏的开关才出来。
    assert.match(panel, /createChatScrollNavigatorVisibilityStore\(true\)/u);
    assert.match(panel, /useChatScrollNavigatorHidden/u);
    assert.match(panel, /ChatScrollNavigatorVisibilityToggle/u);
    assert.match(panel, /hidden=\{scrollNavigatorHidden\}/u);
    assert.match(
      panel,
      /onHiddenChange=\{WorkbenchChatScrollNavigatorVisibility\.setHidden\}/u,
    );
    assert.match(adapter, /scrollNavigatorHidden=\{scrollNavigatorHidden\}/u);
  });

  void test("adapts every shared navigator and user-message action label", () => {
    for (const catalog of [
      conversationEnUSMessages,
      conversationZhCNMessages,
    ]) {
      assert.equal(typeof catalog.chat.copyPrompt, "string");
      assert.equal(typeof catalog.chat.copyGuidance, "string");
      assert.equal(typeof catalog.chat.keepFollowing, "string");
      assert.equal(typeof catalog.chat.stopFollowing, "string");
      assert.equal(typeof catalog.chat.toggleScrollNavigator, "string");
    }

    for (const [localePath, sharedCatalogName] of [
      ["src/renderer/src/i18n/messages/en-US.ts", "conversationEnUSMessages"],
      ["src/renderer/src/i18n/messages/zh-CN.ts", "conversationZhCNMessages"],
    ] as const) {
      const hostMessages = readSource(localePath);

      assert.match(
        hostMessages,
        new RegExp(`mergeConversationMessages\\(${sharedCatalogName},`),
      );
      assert.doesNotMatch(hostMessages, /copyPrompt:/u);
      assert.doesNotMatch(hostMessages, /copyGuidance:/u);
      assert.doesNotMatch(hostMessages, /keepFollowing:/u);
      assert.doesNotMatch(hostMessages, /stopFollowing:/u);
      assert.doesNotMatch(hostMessages, /toggleScrollNavigator:/u);
    }
  });

  void test("enters stopping before the cancel IPC and releases forced follow", () => {
    const adapter = readSource(
      "src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx",
    );
    const stopStart = adapter.indexOf("async function stop()");
    const stopEnd = adapter.indexOf("\n  }\n", stopStart);
    const stopSource = adapter.slice(stopStart, stopEnd);

    assert.ok(stopStart >= 0);
    assert.ok(stopEnd > stopStart);
    assert.ok(stopSource.includes("setFollowLocked(false)"));
    assert.ok(stopSource.includes("beginStandaloneAgentStop(state)"));
    assert.ok(
      stopSource.indexOf("awaitStandaloneAgentStopSettlement") >
        stopSource.indexOf("beginStandaloneAgentStop"),
    );
    assert.match(
      stopSource,
      /requestAbort:\s*async \(\)\s*=>[\s\S]*velarosWorkbenchConversation\.cancel\(\{/u,
    );
    assert.match(stopSource, /terminalSettlement:\s*run\.terminalSettlement/u);
    assert.match(stopSource, /timeoutMs:\s*WorkbenchAgentStopSettlementTimeoutMs/u);
    // 没等到终态（取消被拒、出错或超时）：明确按停止失败收尾，不伪装成已中止。
    assert.match(
      stopSource,
      /finishRun\(run, \{\n\s*kind: 'error',[\s\S]*t\('workbench\.chatStopFailed'\)/u,
    );
    assert.doesNotMatch(stopSource, /kind: 'aborted'/u);
    assert.match(
      adapter,
      /streaming: \{\s*isStreaming:\s*isRunActive,\s*canStop:\s*isRunActive,\s*onStop:\s*stop,/u,
    );
    assert.match(adapter, /const isRunActive = isActiveChatRun\(chat\.status\)/u);
    assert.match(adapter, /WorkbenchAgentStopSettlementTimeoutMs\s*=\s*15_000/u);
  });

  void test("keeps the persisted right chat pane resize handle hittable", () => {
    const presentation = readSource(
      "src/renderer/src/StandaloneWorkbenchPagePresentation.tsx",
    );
    const controller = readSource(
      "src/renderer/src/hooks/useWorkbenchLayoutController.ts",
    );
    const layoutModel = readSource(
      "src/renderer/src/models/layout/workbenchLayoutModel.ts",
    );
    const viewport = readSource(
      "src/renderer/src/models/layout/workbenchViewport.ts",
    );

    assert.match(
      presentation,
      /className=\{`\$\{styles\.verticalResizeHandle\} \$\{styles\.rightResizeHandle\}`\}/u,
    );
    assert.match(presentation, /layout\.beginResizePane\('right', event\)/u);
    assert.match(
      presentation,
      /aria-label=\{t\('workbench\.resizeRightPane'\)\}/u,
    );
    // 拖拽中逐帧直写外壳变量，松手才写回 React 状态；右栏宽度随左移变宽。
    assert.match(controller, /window\.requestAnimationFrame\(applyDraft\)/u);
    assert.match(controller, /setLayoutSizes\(draftSizes\)/u);
    assert.match(layoutModel, /startSizes\.rightPaneWidth - delta\.x/u);
    assert.match(layoutModel, /velaros\.workbench\.layout\.v1/u);
    assert.match(viewport, /right:\s*\{\s*min:\s*360,\s*max:\s*720\s*\}/u);
  });
});
