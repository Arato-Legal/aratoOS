"use client";

import { use } from "react";
import { MatterDocumentEditor } from "@/app/components/clients/MatterDocumentEditor";

interface Props {
    params: Promise<{ projectId: string; documentId: string }>;
}

export default function MatterDocumentEditPage({ params }: Props) {
    const { projectId, documentId } = use(params);
    return <MatterDocumentEditor projectId={projectId} documentId={documentId} />;
}
