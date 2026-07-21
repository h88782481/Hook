export type BootProfile = {
  startupMode: "silent" | "visible";
  initialUiMode: "overlay" | "tray" | "canvas";
  autoStartCapture: boolean;
};

export const defaultBootProfile: BootProfile = {
  startupMode: "silent",
  initialUiMode: "overlay",
  autoStartCapture: false,
};

const normalizeStartupMode = (value: unknown): BootProfile["startupMode"] =>
  value === "visible" ? "visible" : "silent";

const normalizeInitialUiMode = (value: unknown): BootProfile["initialUiMode"] => {
  if (value === "tray" || value === "canvas" || value === "overlay") return value;
  return defaultBootProfile.initialUiMode;
};

export const normalizeBootProfile = (
  value: Partial<BootProfile> | null | undefined,
): BootProfile => ({
  startupMode: normalizeStartupMode(value?.startupMode),
  initialUiMode: normalizeInitialUiMode(value?.initialUiMode),
  autoStartCapture:
    typeof value?.autoStartCapture === "boolean"
      ? value.autoStartCapture
      : defaultBootProfile.autoStartCapture,
});
