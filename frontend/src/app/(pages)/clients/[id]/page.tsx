"use client";

import { use } from "react";
import { ClientDashboard } from "@/app/components/clients/ClientDashboard";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ClientDetailPage({ params }: Props) {
    const { id } = use(params);
    return <ClientDashboard clientId={id} />;
}
