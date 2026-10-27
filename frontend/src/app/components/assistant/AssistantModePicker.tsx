"use client";

import { cn } from "@/app/lib/utils";
import type { AssistantMode } from "../shared/types";

export const ASSISTANT_MODE_OPTIONS: { id: AssistantMode; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "workflow", label: "Workflow" },
    { id: "playbook", label: "Playbook" },
    { id: "tabular", label: "Tabular review" },
    { id: "library", label: "Library search" },
];

/** What the next message is for. It applies to one message, then returns to Chat. */
export function AssistantModePicker({
    mode,
    onChange,
    disabled,
}: {
    mode: AssistantMode;
    onChange: (mode: AssistantMode) => void;
    disabled?: boolean;
}) {
    return (
        <div
            role="radiogroup"
            aria-label="Session mode"
            className="flex flex-wrap gap-1 px-4 pt-3"
        >
            {ASSISTANT_MODE_OPTIONS.map((option) => {
                const selected = option.id === mode;
                return (
                    <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={disabled}
                        onClick={() => onChange(option.id)}
                        className={cn(
                            "rounded-full px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50",
                            selected
                                ? "bg-gray-900 text-white"
                                : "text-gray-600 hover:bg-gray-100",
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
