# Conversation History

画布节点的累计历史窗口。

- `conversationHistory.ts`：按目标轮次截断 agent 事件历史，并合并同一消息的流式答复/思考片段。
- `ConversationHistoryWindow.tsx`：从 `/api/agents/:id/history` 读取事件，在独立模态窗口中展示用户输入、思考、答复、工具调用/结果、状态、compact 与最终结果。
- 点击画布节点主体打开；按钮、输入控件、拖动和缩放操作不会触发。
