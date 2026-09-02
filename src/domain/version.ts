/**
 * Single source of the shipping version string, mirrored from package.json
 * at release time. Kept as a constant so the Device Check report can carry a
 * build identifier without importing JSON into the bundle graph.
 */
export const APP_VERSION = '1.1.1'
