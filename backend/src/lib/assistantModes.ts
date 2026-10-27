// What a session was started to do. The assistant already has a tool for each
// of these (workflows, playbooks, tabular reviews, library search); a mode
// tells the model which one the user reached for, so "workflow" starts from
// the user's workflows instead of answering from scratch. Chat adds nothing.

export const ASSISTANT_MODES = [
  "chat",
  "workflow",
  "playbook",
  "tabular",
  "library",
] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

export function parseAssistantMode(
  value: unknown,
): { ok: true; value: AssistantMode } | { ok: false; detail: string } {
  if (value === undefined || value === null) return { ok: true, value: "chat" };
  if ((ASSISTANT_MODES as readonly unknown[]).includes(value))
    return { ok: true, value: value as AssistantMode };
  return { ok: false, detail: `mode must be one of ${ASSISTANT_MODES.join(", ")}` };
}

const DIRECTIVES: Record<Exclude<AssistantMode, "chat">, string> = {
  workflow:
    "SESSION MODE: WORKFLOW. The user wants to run a workflow. Call list_workflows first, pick the workflow that best fits the request (ask with ask_inputs if several fit), read it with read_workflow, and follow it.",
  playbook:
    "SESSION MODE: PLAYBOOK. The user wants a playbook run. Call list_playbooks first, pick the playbook that best fits (ask with ask_inputs if several fit or if no document is chosen), and run it with run_playbook on the relevant document.",
  tabular:
    "SESSION MODE: TABULAR REVIEW. The user wants a tabular review: the same questions asked across a set of documents. Agree the documents and columns with the user (ask_inputs if unclear), then call create_tabular_review and give them the link it returns.",
  library:
    "SESSION MODE: LIBRARY SEARCH. The user wants to find material in the library. Search with find_documents (scope library, then templates) before answering, try alternative wording, and answer from what you found, citing the documents.",
};

/** Extra system-prompt text for a mode, or an empty string for plain chat. */
export function modeDirective(mode: AssistantMode | null | undefined): string {
  return !mode || mode === "chat" ? "" : DIRECTIVES[mode];
}
