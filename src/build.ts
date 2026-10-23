declare const __WAYLINE_VERSION__: string;

const DEFAULT_API_URL = "https://back.wayline.studio";

export const buildInfo = {
  apiURL: process.env.WAYLINE_CLI_BASE_URL?.trim() || DEFAULT_API_URL,
  version: typeof __WAYLINE_VERSION__ === "string" ? __WAYLINE_VERSION__ : "test",
} as const;
