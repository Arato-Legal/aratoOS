"use client";

import { useState } from "react";
import { createClient } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { useWorkspaceParam } from "@/app/contexts/WorkspaceContext";
import type { Client, ClientKind, ClientStatus } from "../shared/types";
import { Modal } from "../modals/Modal";
import { FieldLabel, FormTextInput } from "../ui/form-field";
import { SelectField, STATUS_LABELS } from "./DashboardPrimitives";

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (client: Client) => void;
}

export function NewClientModal({ open, onClose, onCreated }: Props) {
    const workspace = useWorkspaceParam();
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [kind, setKind] = useState<ClientKind>("organization");
    const [status, setStatus] = useState<ClientStatus>("active");
    const [saving, setSaving] = useState(false);

    const reset = () => {
        setName("");
        setEmail("");
        setKind("organization");
        setStatus("active");
    };

    const submit = async () => {
        if (!name.trim() || saving) return;
        setSaving(true);
        try {
            const client = await createClient(
                { name: name.trim(), email: email.trim() || null, kind, status },
                workspace,
            );
            reset();
            onCreated(client);
        } catch (error) {
            notifyError(error, { action: "create the client" });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            open={open}
            onClose={() => {
                reset();
                onClose();
            }}
            size="md"
            breadcrumbs={["New client"]}
            primaryAction={{
                label: "Create client",
                onClick: () => void submit(),
                disabled: !name.trim() || saving,
            }}
        >
            <form
                className="flex flex-col gap-4 p-4"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <div className="flex flex-col gap-1">
                    <FieldLabel htmlFor="new-client-name">Name</FieldLabel>
                    <FormTextInput
                        id="new-client-name"
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Client name"
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <FieldLabel htmlFor="new-client-email">Email</FieldLabel>
                    <FormTextInput
                        id="new-client-email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Optional"
                    />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <SelectField
                        label="Type"
                        value={kind}
                        onChange={setKind}
                        options={[
                            { value: "organization", label: "Organization" },
                            { value: "individual", label: "Individual" },
                        ]}
                    />
                    <SelectField
                        label="Status"
                        value={status}
                        onChange={setStatus}
                        options={(
                            Object.keys(STATUS_LABELS) as ClientStatus[]
                        ).map((value) => ({ value, label: STATUS_LABELS[value] }))}
                    />
                </div>
            </form>
        </Modal>
    );
}
