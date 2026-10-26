"use client";

import { use } from "react";
import { MatterDashboard } from "@/app/components/clients/MatterDashboard";

interface Props {
    params: Promise<{ projectId: string }>;
}

export default function MatterDashboardPage({ params }: Props) {
    const { projectId } = use(params);
    return <MatterDashboard projectId={projectId} />;
}
