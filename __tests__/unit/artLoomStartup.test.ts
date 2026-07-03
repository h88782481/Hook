import { describe, expect, it, vi } from "vitest";

import { refreshArtLoomCapabilitiesOnStartup } from "../../src/services/artLoomStartup";

describe("refreshArtLoomCapabilitiesOnStartup", () => {
    it("skips capability refresh when ArtLoom is disabled", async () => {
        const refresh = vi.fn().mockResolvedValue(undefined);

        const refreshed = await refreshArtLoomCapabilitiesOnStartup(false, refresh);

        expect(refreshed).toBe(false);
        expect(refresh).not.toHaveBeenCalled();
    });

    it("refreshes capabilities exactly once when ArtLoom is enabled", async () => {
        const refresh = vi.fn().mockResolvedValue(undefined);

        const refreshed = await refreshArtLoomCapabilitiesOnStartup(true, refresh);

        expect(refreshed).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(1);
    });
});
