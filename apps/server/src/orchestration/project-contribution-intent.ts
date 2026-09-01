export function requiresProjectContributionRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (isSharedWorkspaceDeliverableRequest(normalized)) return false;
  if (isConversationalNoop(normalized)) return false;
  if (/^(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/i.test(normalized)) {
    return false;
  }
  if (/^(explain|summari[sz]e|inspect|diagnose|analy[sz]e|review|check|find|look up|show|tell me)\b/i.test(normalized)) {
    return false;
  }
  return /\b(build|create|generate|implement|add|fix|repair|update|change|modify|edit|refactor|remove|delete|write|commit|ship|scaffold)\b/i
    .test(normalized);
}

export function isSharedWorkspaceDeliverableRequest(text: string): boolean {
  if (/(?:\$COMMON_WORKSPACE\b|\bCOMMON_WORKSPACE\b|\/common-workspace\b)/i.test(text)) {
    return true;
  }
  if (/\b(?:skill hub|publish(?:ed|ing)?\s+(?:it\s+)?to\s+the\s+skill\s+hub)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:create|build|generate|scaffold|publish|package)\b/i.test(text) &&
    /\b(?:reusable\s+)?(?:codex\s+)?skill(?:\s+package)?\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

function isConversationalNoop(text: string): boolean {
  return /^(hi|hello|hey|yo|thanks|thank you|ok|okay|cool|nice|sounds good|ping|test)[.!?]*$/i
    .test(text);
}
