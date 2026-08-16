"use client";

import { useEffect, useState } from "react";
import { useMockAgent } from "@/components/chat/mockAgent";
import Conversation from "@/components/chat/Conversation";
import Workspace from "@/components/chat/Workspace";
import Sidebar from "@/components/chat/Sidebar";

export default function Home() {
  const e = useMockAgent();
  const [drawer, setDrawer] = useState<null | "schema" | "code">(null);
  // 保存连接后自动打开表结构抽屉（表在那里加入画布）
  useEffect(() => {
    if (e.schemaTick > 0) setDrawer("schema");
  }, [e.schemaTick]);
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
    <div className={`app3 always-ws ${inChat ? "no-ws" : "no-conv"}`}>
      {e.notice && <div className="toast">{e.notice}</div>}
      <Sidebar
        wsList={e.wsList}
        activeWs={e.activeWs}
        onSwitchWs={e.switchWorkspace}
        onNewWs={e.newWorkspace}
        badges={e.badges}
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
          drawer={drawer}
          onDrawer={setDrawer}
        connectFlow={e.connectFlow}
        connectActions={{
          test: () => e.ui(e.connectTest),
          save: () => e.ui(e.connectSave),
        }}
        decisionOpen={e.decisionOpen}
        onDecisionOpen={e.setDecisionOpen}
        generating={e.generating}
        identityAsk={e.identityAsk}
        actions={{
          applyObjectYaml: e.applyObjectYaml,
          updateObject: e.updateObject,
          replay: () => e.ui(e.replay),
          confirmDrafts: () => e.ui(e.confirmDrafts),
          setDecision: (k, t) => e.ui(() => e.setDecision(k, t)),
          toggleIgnore: e.toggleIgnore,
          replanObject: (n) => e.ui(() => e.replanObject(n)),
          connect: e.actConnect,
          draft: e.actDraft,
          integrate: e.actIntegrate,
          decideAll: e.actDecideSuggested,
          publish: e.actPublish,
          publishChanges: () => e.ui(e.publishChanges),
          discardChanges: () => e.ui(e.discardChanges),
          rollback: (v) => e.ui(() => e.rollbackTo(v)),
          unstage: e.unstageTable,
          toggleStage: e.toggleStageSelect,
          toggleStageColumn: e.toggleStageColumn,
          selectAllTables: e.selectAllTables,
          clearStaging: e.clearStaging,
          generate: () =>
            e.ui(async () => {
              await e.generateFromStaging();
              setDrawer(null); // 生成完收起表结构，画面只剩画布 + 至多一张抉择卡
            }),
          confirmIdentity: (keep) => e.ui(() => e.confirmIdentity(keep)),
          createObject: e.createObject,
          createLink: e.createLink,
          updateLink: e.updateLink,
          setQuestions: e.setQuestions,
          deleteLink: e.deleteLink,
          deleteObject: e.deleteObject,
        }}
        />
      )}
    </div>
  );
}
