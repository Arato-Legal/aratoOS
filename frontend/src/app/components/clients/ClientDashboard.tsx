"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    addClientContact,
    deleteClient,
    deleteClientContact,
    getClient,
    listProjects,
    setMatterClient,
    updateClient,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { PERSONAL_WORKSPACE } from "@/app/contexts/WorkspaceContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { ClientChatsSection } from "./ClientChatsSection";
import { ClientDriveFolder } from "./ClientDriveFolder";
import { ClientMemorySection } from "./ClientMemorySection";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { FORM_CONTROL_GLASS_CLASS } from "@/app/components/ui/form-field";
import { cn } from "@/app/lib/utils";
import type {
    ClientContact,
    ClientDetail,
    ClientKind,
    ClientStatus,
    Project,
} from "../shared/types";
import {
    DashboardPage,
    DashboardSection,
    HubfloLink,
    DashboardSkeleton,
    EditableField,
    SelectField,
    STATUS_LABELS,
    formatDate,
} from "./DashboardPrimitives";

const KIND_OPTIONS: { value: ClientKind; label: string }[] = [
    { value: "organization", label: "Organization" },
    { value: "individual", label: "Individual" },
];
const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as ClientStatus[]).map(
    (value) => ({ value, label: STATUS_LABELS[value] }),
);

export function ClientDashboard({ clientId }: { clientId: string }) {
    const router = useRouter();
    const [client, setClient] = useState<ClientDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [attempt, setAttempt] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getClient(clientId)
            .then((detail) => {
                if (!cancelled) setClient(detail);
            })
            .catch((error) => {
                if (cancelled) return;
                notifyError(error, {
                    action: "load the client",
                    dedupeKey: `client-${clientId}`,
                    onRetry: () => setAttempt((n) => n + 1),
                });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [clientId, attempt]);

    const reload = useCallback(() => setAttempt((n) => n + 1), []);

    const save = useCallback(
        async (payload: Parameters<typeof updateClient>[1]) => {
            try {
                const next = await updateClient(clientId, payload);
                setClient((prev) => (prev ? { ...prev, ...next } : prev));
            } catch (error) {
                notifyError(error, { action: "save the client" });
                reload();
            }
        },
        [clientId, reload],
    );

    if (loading && !client) return <DashboardSkeleton />;
    if (!client) {
        return (
            <div className="flex h-full min-h-0 flex-col">
                <PageHeader
                    breadcrumbs={[
                        { label: "Clients", onClick: () => router.push("/clients") },
                        { label: "Not found" },
                    ]}
                />
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <PageHeader
                breadcrumbs={[
                    { label: "Clients", onClick: () => router.push("/clients") },
                    { label: client.name },
                ]}
            />
            <DashboardPage>
                <div>
                    <h1 className="break-words font-serif text-3xl text-gray-900">
                        {client.name}
                    </h1>
                    <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-gray-500">
                        <span>
                            {client.client_number ? `${client.client_number} · ` : ""}
                            {STATUS_LABELS[client.status]} · Added{" "}
                            {formatDate(client.created_at)}
                        </span>
                        <HubfloLink href={client.hubflo_url} />
                    </p>
                </div>

                <DashboardSection title="Details">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <EditableField
                            label="Name"
                            value={client.name}
                            onSave={(name) => (name ? save({ name }) : reload())}
                        />
                        <EditableField
                            label="Client number"
                            value={client.client_number}
                            onSave={(client_number) => save({ client_number })}
                        />
                        <SelectField
                            label="Status"
                            value={client.status}
                            options={STATUS_OPTIONS}
                            onChange={(status) => void save({ status })}
                        />
                        <SelectField
                            label="Type"
                            value={client.kind}
                            options={KIND_OPTIONS}
                            onChange={(kind) => void save({ kind })}
                        />
                        <EditableField
                            label="Source"
                            value={client.source}
                            placeholder="Referral, website…"
                            onSave={(source) => save({ source })}
                        />
                        <EditableField
                            label="Email"
                            type="email"
                            value={client.email}
                            onSave={(email) => save({ email })}
                        />
                        <EditableField
                            label="Phone"
                            type="tel"
                            value={client.phone}
                            onSave={(phone) => save({ phone })}
                        />
                        <div className="sm:col-span-2">
                            <EditableField
                                label="Address"
                                value={client.address}
                                onSave={(address) => save({ address })}
                            />
                        </div>
                    </div>
                </DashboardSection>

                <ContactsSection
                    clientId={client.id}
                    contacts={client.contacts}
                    onChanged={reload}
                />

                <MattersSection client={client} onChanged={reload} />

                <ClientChatsSection clientId={client.id} />

                <ClientMemorySection clientId={client.id} />

                <ClientDriveFolder
                    clientId={client.id}
                    orgId={client.org_id}
                    folderName={client.drive_folder_name}
                    onChange={reload}
                />

                <DashboardSection title="Notes">
                    <EditableField
                        label="Notes"
                        multiline
                        value={client.notes}
                        placeholder="Background, preferences, anything to remember…"
                        onSave={(notes) => save({ notes })}
                    />
                </DashboardSection>

                {client.can_delete && (
                    <div>
                        <PillButtonUI
                            tone="danger"
                            onClick={() => setConfirmDelete(true)}
                        >
                            Delete client
                        </PillButtonUI>
                    </div>
                )}
            </DashboardPage>

            <ConfirmPopup
                open={confirmDelete}
                title="Delete this client?"
                message="The client and its contacts are removed. Its matters are kept and become unassigned."
                confirmLabel="Delete client"
                confirmVariant="danger"
                confirmStatus={deleting ? "loading" : "idle"}
                onCancel={() => setConfirmDelete(false)}
                onConfirm={async () => {
                    setDeleting(true);
                    try {
                        await deleteClient(client.id);
                        router.push("/clients");
                    } catch (error) {
                        notifyError(error, { action: "delete the client" });
                        setDeleting(false);
                        setConfirmDelete(false);
                    }
                }}
            />
        </div>
    );
}

function ContactsSection({
    clientId,
    contacts,
    onChanged,
}: {
    clientId: string;
    contacts: ClientContact[];
    onChanged: () => void;
}) {
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState({ name: "", role: "", email: "", phone: "" });
    const [busy, setBusy] = useState(false);

    const add = async () => {
        if (!draft.name.trim() || busy) return;
        setBusy(true);
        try {
            await addClientContact(clientId, {
                name: draft.name.trim(),
                role: draft.role.trim() || null,
                email: draft.email.trim() || null,
                phone: draft.phone.trim() || null,
            });
            setDraft({ name: "", role: "", email: "", phone: "" });
            setAdding(false);
            onChanged();
        } catch (error) {
            notifyError(error, { action: "add the contact" });
        } finally {
            setBusy(false);
        }
    };

    return (
        <DashboardSection
            title="Contacts"
            action={
                <PillButtonUI
                    tone="white"
                    size="sm"
                    onClick={() => setAdding((v) => !v)}
                    aria-expanded={adding}
                >
                    {adding ? "Cancel" : "Add contact"}
                </PillButtonUI>
            }
        >
            {contacts.length === 0 && !adding && (
                <p className="text-sm text-gray-500">No contacts yet.</p>
            )}
            <ul className="flex flex-col divide-y divide-gray-100">
                {contacts.map((contact) => (
                    <li
                        key={contact.id}
                        className="flex flex-wrap items-start gap-x-6 gap-y-1 py-2"
                    >
                        <div className="min-w-0 flex-1">
                            <p className="break-words text-sm font-medium text-gray-900">
                                {contact.name}
                            </p>
                            {contact.role && (
                                <p className="break-words text-xs text-gray-500">
                                    {contact.role}
                                </p>
                            )}
                        </div>
                        <div className="min-w-0 text-xs text-gray-600">
                            {contact.email && (
                                <p className="break-all">{contact.email}</p>
                            )}
                            {contact.phone && <p>{contact.phone}</p>}
                            <HubfloLink href={contact.hubflo_url} />
                        </div>
                        <PillButtonUI
                            tone="white"
                            size="sm"
                            aria-label={`Remove ${contact.name}`}
                            onClick={async () => {
                                try {
                                    await deleteClientContact(clientId, contact.id);
                                    onChanged();
                                } catch (error) {
                                    notifyError(error, {
                                        action: "remove the contact",
                                    });
                                }
                            }}
                        >
                            Remove
                        </PillButtonUI>
                    </li>
                ))}
            </ul>
            {adding && (
                <form
                    className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void add();
                    }}
                >
                    {(
                        [
                            ["name", "Name"],
                            ["role", "Role"],
                            ["email", "Email"],
                            ["phone", "Phone"],
                        ] as const
                    ).map(([key, label]) => (
                        <input
                            key={key}
                            aria-label={label}
                            placeholder={label}
                            type={key === "email" ? "email" : "text"}
                            value={draft[key]}
                            onChange={(e) =>
                                setDraft((d) => ({ ...d, [key]: e.target.value }))
                            }
                            className={cn(FORM_CONTROL_GLASS_CLASS, "h-10")}
                        />
                    ))}
                    <div className="sm:col-span-2">
                        <PillButtonUI
                            type="submit"
                            tone="black"
                            loading={busy}
                            disabled={!draft.name.trim()}
                        >
                            Save contact
                        </PillButtonUI>
                    </div>
                </form>
            )}
        </DashboardSection>
    );
}

function MattersSection({
    client,
    onChanged,
}: {
    client: ClientDetail;
    onChanged: () => void;
}) {
    const router = useRouter();
    const [options, setOptions] = useState<Project[] | null>(null);
    const [choice, setChoice] = useState("");

    useEffect(() => {
        let cancelled = false;
        listProjects({ workspace: client.org_id ?? PERSONAL_WORKSPACE })
            .then((projects) => {
                if (!cancelled) setOptions(projects);
            })
            .catch(() => {
                if (!cancelled) setOptions([]);
            });
        return () => {
            cancelled = true;
        };
    }, [client.org_id, client.matters.length]);

    const attached = new Set(client.matters.map((m) => m.id));
    const available = (options ?? []).filter(
        (p) => !attached.has(p.id) && p.access_role === "owner",
    );

    const attach = async () => {
        if (!choice) return;
        try {
            await setMatterClient(choice, client.id);
            setChoice("");
            onChanged();
        } catch (error) {
            notifyError(error, { action: "attach the matter" });
        }
    };

    return (
        <DashboardSection title="Matters">
            {client.matters.length === 0 ? (
                <p className="text-sm text-gray-500">
                    No matters yet. Attach an existing matter below.
                </p>
            ) : (
                <ul className="flex flex-col divide-y divide-gray-100">
                    {client.matters.map((matter) => (
                        <li key={matter.id} className="py-2">
                            <button
                                type="button"
                                onClick={() => router.push(`/matters/${matter.id}`)}
                                className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            >
                                <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                                    {matter.name}
                                </span>
                                {matter.cm_number && (
                                    <span className="text-xs text-gray-500">
                                        {matter.cm_number}
                                    </span>
                                )}
                                {matter.practice && (
                                    <span className="text-xs text-gray-500">
                                        {matter.practice}
                                    </span>
                                )}
                                <span className="ml-auto text-xs text-gray-400">
                                    Updated {formatDate(matter.updated_at)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {available.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                        aria-label="Matter to attach"
                        value={choice}
                        onChange={(e) => setChoice(e.target.value)}
                        className={cn(FORM_CONTROL_GLASS_CLASS, "h-10 sm:w-72")}
                    >
                        <option value="">Attach a matter…</option>
                        {available.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                    <PillButtonUI
                        tone="white"
                        disabled={!choice}
                        onClick={() => void attach()}
                    >
                        Attach
                    </PillButtonUI>
                </div>
            )}
        </DashboardSection>
    );
}
