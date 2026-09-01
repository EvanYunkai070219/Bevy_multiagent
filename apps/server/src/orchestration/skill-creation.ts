export function isSkillCreationRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (/SKILL\.md/i.test(normalized)) return true;
  return (
    /\b(create|build|generate|scaffold|write|update|improve|revise|validate|test)\b.{0,120}\bskill(s)?\b/i
      .test(normalized) ||
    /\bskill(s)?\b.{0,120}\b(create|creation|generation|generator|scaffold|package|quality|validator|validation|forward-test)\b/i
      .test(normalized)
  );
}
