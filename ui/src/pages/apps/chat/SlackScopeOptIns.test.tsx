// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SlackScopeOptIns } from "./SlackScopeOptIns";
import type { SlackOptInScopeGroup } from "@paperclipai/shared";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: {
  value?: SlackOptInScopeGroup[];
  installed?: SlackOptInScopeGroup[];
  disabled?: boolean;
  onChange?: (groups: SlackOptInScopeGroup[]) => void;
}) {
  const onChange = props.onChange ?? vi.fn();
  await act(async () => root.render(
    <SlackScopeOptIns
      value={props.value ?? []}
      installed={props.installed}
      disabled={props.disabled}
      onChange={onChange}
    />,
  ));
  return onChange;
}

function checkboxes() {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
}

it("offers every opt-in group off by default", async () => {
  await render({});
  expect(container.textContent).toContain("Extra Slack permissions");
  const boxes = checkboxes();
  expect(boxes).toHaveLength(3);
  expect(boxes.every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);
  for (const label of ["Channel management", "Proactive DMs", "File upload"]) {
    expect(container.textContent).toContain(label);
  }
});

it("explains that each group sends the install to admin review", async () => {
  await render({});
  const helps = [...container.querySelectorAll('[id^="slack-scope-"]')].map((node) => node.textContent ?? "");
  expect(helps).toHaveLength(3);
  for (const help of helps) {
    expect(help).toContain("admin review");
  }
  // Scope names make the actual grant explicit.
  expect(helps[0]).toContain("channels:manage");
  expect(helps[1]).toContain("im:write");
  expect(helps[2]).toContain("files:write");
});

it("adds a group on check and removes it on uncheck without touching the others", async () => {
  const onChange = await render({ value: ["proactive_dms"] });
  const boxes = checkboxes();
  expect(boxes[1]!.getAttribute("aria-checked")).toBe("true");
  await act(async () => boxes[0]!.click());
  expect(onChange).toHaveBeenLastCalledWith(["channel_management", "proactive_dms"]);
  // Controlled: re-render with the parent's next value, then uncheck.
  await render({ value: ["channel_management", "proactive_dms"], onChange });
  await act(async () => checkboxes()[1]!.click());
  expect(onChange).toHaveBeenLastCalledWith(["channel_management"]);
});

it("prompts for a reconnect only when the requested set differs from the installed set", async () => {
  await render({ value: [], installed: [] });
  expect(container.textContent).not.toContain("reconnect this connection");
  await render({ value: ["file_upload"], installed: [] });
  expect(container.textContent).toContain("reconnect this connection");
  expect(container.textContent).toContain("current permissions stay in place");
});

it("disables every control while pending", async () => {
  await render({ disabled: true });
  expect(checkboxes().every((box) => box.disabled)).toBe(true);
});
