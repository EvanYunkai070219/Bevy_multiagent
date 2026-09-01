// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownText } from "./MarkdownText";
import {
  OperatorMessage,
  WorkspaceImage,
  isWorkspacePath,
  looksLikeImage,
} from "./WorkspaceFile";
import { api } from "./api";

afterEach(() => {
  cleanup();
  // Spies persist across tests in a file otherwise, so call counts leak.
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom has no object URLs; the component only needs a stable string back.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("looksLikeImage", () => {
  it("recognises raster images whatever the case or query", () => {
    expect(looksLikeImage("outputs/chart.PNG")).toBe(true);
    expect(looksLikeImage("a/b/shot.jpeg?v=2")).toBe(true);
  });

  it("does not treat SVG as a previewable image", () => {
    // It renders as a document and can carry script.
    expect(looksLikeImage("diagram.svg")).toBe(false);
  });

  it("does not treat a text file as an image", () => {
    expect(looksLikeImage("report.txt")).toBe(false);
  });
});

describe("isWorkspacePath", () => {
  it("accepts the shapes an agent writes", () => {
    expect(isWorkspacePath("outputs/chart.png")).toBe(true);
    expect(isWorkspacePath("/workspace/outputs/chart.png")).toBe(true);
  });

  it("leaves anything with a scheme alone", () => {
    expect(isWorkspacePath("https://example.com/a.png")).toBe(false);
    expect(isWorkspacePath("data:image/png;base64,AAA")).toBe(false);
    expect(isWorkspacePath("//example.com/a.png")).toBe(false);
  });
});

describe("WorkspaceImage", () => {
  it("fetches the bytes and renders them", async () => {
    const spy = vi
      .spyOn(api, "workspaceFile")
      .mockResolvedValue(new Blob(["x"], { type: "image/png" }));

    render(<WorkspaceImage agentId="agent-1" path="outputs/chart.png" alt="chart" />);

    await waitFor(() => expect(screen.getByAltText("chart")).toBeTruthy());
    expect(spy).toHaveBeenCalledWith("agent-1", "outputs/chart.png");
  });

  it("names the file it could not read instead of showing a broken frame", async () => {
    vi.spyOn(api, "workspaceFile").mockRejectedValue(new Error("gone"));

    render(<WorkspaceImage agentId="agent-1" path="outputs/missing.png" alt="" />);

    await waitFor(() => expect(screen.getByText("outputs/missing.png")).toBeTruthy());
  });
});

describe("MarkdownText workspace images", () => {
  it("serves an image the agent wrote out of that agent's workspace", async () => {
    const spy = vi
      .spyOn(api, "workspaceFile")
      .mockResolvedValue(new Blob(["x"], { type: "image/png" }));

    render(
      <MarkdownText agentId="agent-1">{"![the chart](outputs/chart.png)"}</MarkdownText>,
    );

    await waitFor(() => expect(screen.getByAltText("the chart")).toBeTruthy());
    expect(spy).toHaveBeenCalledWith("agent-1", "outputs/chart.png");
  });

  it("leaves an external image to the browser", () => {
    const spy = vi.spyOn(api, "workspaceFile");

    render(
      <MarkdownText agentId="agent-1">
        {"![remote](https://example.com/a.png)"}
      </MarkdownText>,
    );

    expect(screen.getByAltText("remote").getAttribute("src")).toBe(
      "https://example.com/a.png",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing special without an agent to resolve against", () => {
    const spy = vi.spyOn(api, "workspaceFile");

    render(<MarkdownText>{"![the chart](outputs/chart.png)"}</MarkdownText>);

    expect(spy).not.toHaveBeenCalled();
  });

});

describe("OperatorMessage", () => {
  it("shows the picture someone attached instead of the path they sent", async () => {
    // The path is appended to the prompt because the Agent needs it. A person
    // picked a picture and wants to see the picture.
    vi.spyOn(api, "workspaceFile").mockResolvedValue(
      new Blob(["x"], { type: "image/jpeg" }),
    );

    render(
      <OperatorMessage
        agentId="agent-1"
        content={"uploads/holiday.jpg\n生成一个他的卡通图片"}
      />,
    );

    await waitFor(() => expect(screen.getByAltText("uploads/holiday.jpg")).toBeTruthy());
    expect(screen.getByText("生成一个他的卡通图片")).toBeTruthy();
  });

  it("offers a non-image attachment as a download", () => {
    render(<OperatorMessage agentId="agent-1" content={"uploads/notes.pdf\nsummarise it"} />);

    expect(screen.getByRole("button", { name: /uploads\/notes\.pdf/ })).toBeTruthy();
    expect(screen.getByText("summarise it")).toBeTruthy();
  });

  it("leaves ordinary prose alone, including a sentence that mentions a path", () => {
    render(
      <OperatorMessage
        agentId="agent-1"
        content={"please read uploads/notes.pdf and summarise"}
      />,
    );

    expect(document.querySelector(".message-files")).toBeNull();
    expect(screen.getByText("please read uploads/notes.pdf and summarise")).toBeTruthy();
  });
});
