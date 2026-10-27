"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useWorkspaceIdentity } from "@/app/hooks/useWorkspaceIdentity";
import { useChatRoute } from "@/app/hooks/useChatRoute";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { AssistantChatPane } from "@/app/components/assistant/AssistantChatPane";
import { AssistantDocumentPanelHost } from "@/app/components/assistant/AssistantDocumentPanelHost";
import { useAssistantDocumentPanel } from "@/app/components/assistant/useAssistantDocumentPanel";

// Serves `/clients/:id/assistant` (a new chat) and
// `/clients/:id/assistant/chat/:chatId`: an assistant session run at the
// client level. It reads the documents and memory of the client's matters
// that share with it and that the caller can open, read-only, and offers the
// same modes as a matter (chat, workflow, playbook, tabular review, library
// search) from the composer.

function ClientAssistantForClient({ clientId }: { clientId: string }) {
    const base = `/clients/${clientId}/assistant`;
    const { chatId, openChat, adoptChat, claimCreated } = useChatRoute(
        `${base}/chat`,
        base,
    );
    const documentPanel = useAssistantDocumentPanel();
    const { setSideChatId } = useChatHistoryContext();
    useEffect(() => {
        setSideChatId(null);
    }, [setSideChatId]);

    return (
        <div className="relative flex h-full w-full overflow-x-clip">
            <AssistantChatPane
                clientId={clientId}
                chatId={chatId}
                openChat={openChat}
                adoptChat={adoptChat}
                claimCreated={claimCreated}
                documentPanel={documentPanel}
            />
            <AssistantDocumentPanelHost panel={documentPanel} />
        </div>
    );
}

export function ClientAssistant() {
    const identity = useWorkspaceIdentity();
    const params = useParams<{ id: string }>();
    const clientId = Array.isArray(params?.id) ? params.id[0] : params?.id;
    if (!clientId) return null;
    return (
        <ClientAssistantForClient
            key={`${identity}:${clientId}`}
            clientId={clientId}
        />
    );
}
