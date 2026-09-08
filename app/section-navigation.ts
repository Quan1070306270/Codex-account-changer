/** Select by section start rather than a visibility ratio, including very tall sections. */
export function sectionAtPosition(
  sections: Array<{ id: string; top: number }>,
  anchor: number,
  atBottom = false,
): string | null {
  if (!sections.length) return null;
  if (atBottom) return sections.at(-1)?.id ?? null;
  let selected = sections[0].id;
  for (const section of sections) {
    // Scrolling can round to physical pixels while layout retains fractional pixels.
    if (section.top <= anchor + 2) selected = section.id;
  }
  return selected;
}
