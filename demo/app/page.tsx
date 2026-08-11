"use client";

import { useState } from "react";
import { useMockAgent } from "@/components/chat/mockAgent";
import Conversation from "@/components/chat/Conversation";
import Workspace from "@/components/chat/Workspace";
import Sidebar from "@/components/chat/Sidebar";

export default function Home() {
  const e = useMockAgent();
  const [wsClosed, setWsClosed] = useState(false);
  const [drawer, setDrawer] = useState<null | "schema" | "code">(null);
  // 工作台模态：模型编辑器（已发布）> 初始化建模向导；问数页纯对话，取数详情融合在答案卡里
  const mode = e.badges.version ? "editor" : "wizard";
  const inChat = e.activeConv === "chat";
  const showWs = !inChat;
  // 侧栏资源 → 画布抽屉（schema/code）；ontology 就是画布本身 → 切回构建页看画布
  const openSurface = (kind: string) => {
    if (kind === "schema") setDrawer("schema");
    else if (kind === "code") setDrawer("code");
    else if (kind === "ontology") {
      e.switchConv("flow");
      setDrawer(null);
    }
  };

  return (
    <div className={`app3 always-ws ${wsClosed ? "ws-closed" : ""} ${inChat ? "no-ws" : "no-conv"}`}>
      {e.notice && <div className="toast">{e.notice}</div>}
      <Sidebar
        wsList={e.wsList}
        activeWs={e.activeWs}
        onSwitchWs={e.switchWorkspace}
        onNewWs={e.newWorkspace}
        badges={e.badges}
        steps={e.steps}
        onStep={e.stepClick}
        onOpenView={openSurface}
        convs={e.convs}
        activeConv={e.activeConv}
        onSwitchConv={e.switchConv}
        chats={e.chats}
        activeChatId={e.activeChatId}
        onNewChat={e.newChat}
        onSwitchChat={e.switchChat}
      />
      {inChat && (
        <Conversation
          msgs={e.msgs}
          busy={e.busy}
          onSubmit={e.turn}
          onHero={(key) => {
            const f = {
              connect: e.actConnect,
              model: e.actDraft,
              integrate: e.actIntegrate,
              publish: e.actPublish,
              generate: e.actGenerate,
            }[key];
            f?.();
          }}
          inputHint="给 Ontos 派个活，或随便问…"
          steps={e.steps}
          onLocked={e.lockedHint}
          onOpenArtifact={(kind) => openSurface(kind)}
          onReplay={() => e.ui(e.replay)}
        />
      )}
      {showWs && (
        <Workspace
          mode={mode}
          badges={e.badges}
          data={e.data}
          collapsed={wsClosed}
          onToggleCollapse={() => setWsClosed(!wsClosed)}
        drawer={drawer}
        onDrawer={setDrawer}
        pickerOpen={e.pickerOpen}
        onPicker={e.setPickerOpen}
        connectFlow={e.connectFlow}
        connectActions={{
          test: () => e.ui(e.connectTest),
          save: () => e.ui(e.connectSave),
          addMore: () => e.ui(e.connectAddMore),
          finish: () => e.ui(e.connectFinish),
        }}
        decisionOpen={e.decisionOpen}
        onDecisionOpen={e.setDecisionOpen}
        actions={{
          applyObjectYaml: e.applyObjectYaml,
          updateObject: e.updateObject,
          regenerate: () => e.ui(e.regenerate),
          replay: () => e.ui(e.replay),
          reopenDecisions: () => e.ui(e.reopenDecisions),
          confirmDrafts: () => e.ui(e.confirmDrafts),
          setDecision: (k, t) => e.ui(() => e.setDecision(k, t)),
          toggleIgnore: e.toggleIgnore,
          replanObject: (n) => e.ui(() => e.replanObject(n)),
          connect: e.actConnect,
          draft: e.actDraft,
          integrate: e.actIntegrate,
          decideAll: e.actDecideSuggested,
          publish: e.actPublish,
          generate: e.actGenerate,
          rollback: (v) => e.ui(() => e.rollbackTo(v)),
          stage: e.stageTable,
          unstage: e.unstageTable,
          stageAll: e.stageAll,
          createObject: e.createObject,
          createLink: e.createLink,
          renameLink: e.renameLink,
          deleteLink: e.deleteLink,
          deleteObject: e.deleteObject,
        }}
        />
      )}
    </div>
  );
}
