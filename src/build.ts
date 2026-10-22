declare const __WAYLINE_API_URL__: string;
declare const __WAYLINE_BUILD_ENV__: string;
declare const __WAYLINE_VERSION__: string;

export const buildInfo = {
  apiURL: typeof __WAYLINE_API_URL__ === "string" ? __WAYLINE_API_URL__ : "http://127.0.0.1",
  environment: typeof __WAYLINE_BUILD_ENV__ === "string" ? __WAYLINE_BUILD_ENV__ : "test",
  version: typeof __WAYLINE_VERSION__ === "string" ? __WAYLINE_VERSION__ : "test",
} as const;
