// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { HtmlDocumentBody } from "./HtmlDocumentBody";

describe("HtmlDocumentBody", () => {
  it("renders in a sandboxed iframe and toggles to source", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<HtmlDocumentBody html="<!doctype html><p>hi</p>" title="demo" />));
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Raw"]')!.click());
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toContain("<p>hi</p>");
    act(() => root.unmount());
  });
});
