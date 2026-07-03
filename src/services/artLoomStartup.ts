export const refreshArtLoomCapabilitiesOnStartup = async (
    artLoomEnabled: boolean,
    refreshCapabilities: () => Promise<void>,
): Promise<boolean> => {
    if (!artLoomEnabled) {
        return false;
    }

    await refreshCapabilities();
    return true;
};
