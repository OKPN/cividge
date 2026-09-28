// Presentation-only token editing. The saved filename policy is still the
// canonical pattern or {original}; this does not create another domain state.
export function insertFilenamePatternToken(draft, token, selectionStart, selectionEnd) {
  const text = String(draft ?? "");
  const inserted = String(token ?? "");
  if (!text.trim() || text.trim() === "{original}") {
    return { value: inserted, cursor: inserted.length };
  }

  const start = Math.min(Math.max(Number(selectionStart) || 0, 0), text.length);
  const end = Math.min(Math.max(Number(selectionEnd) || start, start), text.length);
  return {
    value: text.slice(0, start) + inserted + text.slice(end),
    cursor: start + inserted.length,
  };
}
