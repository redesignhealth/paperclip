import { expect, type Page } from "@playwright/test";

/** The connect step's Claude tile. */
export const CLAUDE_SOURCE = /^Claude/;

/**
 * The connect step answers its own row with Hermes on arrival and collapses the
 * row behind that choice. Specs that exercise another source press Back first,
 * which returns the row to the state they were written against — nothing
 * selected, nothing started — and then press their tile.
 */
export async function returnToSourceRow(page: Page): Promise<void> {
  const checked = page.locator('[role="radio"][aria-checked="true"]');
  await expect(page.getByRole("radio", { name: /^Hermes/ })).toBeChecked({ timeout: 30_000 });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(checked).toHaveCount(0, { timeout: 15_000 });
}
