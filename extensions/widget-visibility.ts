/**
 * Widget visibility UI state and helpers.
 *
 * The workflow widget (extensions/state.ts updateUi) is hidden by
 * default; the /task command toggles it and session_start resets it.
 */

/**
 * Whether the workflow widget is currently shown.
 *
 * In-memory UI state only: hidden by default, never persisted, resets on
 * session reload. Toggled by the /task command (extensions/index.ts).
 */
let widgetVisible = false;

/**
 * Read the current widget visibility.
 *
 * Used by updateUi (extensions/state.ts) to gate widget rendering.
 *
 * @returns true when the widget is currently visible.
 */
export function isWidgetVisible(): boolean {
  return widgetVisible;
}

/**
 * Toggle workflow widget visibility.
 *
 * Flips the in-memory `widgetVisible` flag and returns the new value.
 * The caller re-renders via updateUi afterwards. State is not
 * persisted: a session reload starts hidden again.
 *
 * @returns true when the widget is now visible.
 */
export function toggleWidgetVisible(): boolean {
  widgetVisible = !widgetVisible;
  return widgetVisible;
}

/**
 * Reset widget visibility to hidden.
 *
 * Called on session_start so every session — including a resume in the
 * same process — starts with the workflow widget hidden.
 */
export function resetWidgetVisibility(): void {
  widgetVisible = false;
}
