// How the chat engine reaches the tabular module without importing it.
//
// create_tabular_review has to call the tabular module, which itself reaches
// back into the chat engine. A static import from the engine would make that
// a cycle (and the architecture test only allows a module's facade anyway), so
// the chat module's service file registers the creator once at load time.

type Creator = typeof import("../../../tabular/tabular.service").createTabularReview;

let creator: Creator | null = null;

export function registerTabularReviewCreator(fn: Creator): void {
  creator = fn;
}

export function getTabularReviewCreator(): Creator | null {
  return creator;
}
