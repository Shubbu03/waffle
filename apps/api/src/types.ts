export type AppEnv = {
  Bindings: { remoteAddress?: string; server?: unknown };
  Variables: { requestId: string; attemptId?: string; failure?: unknown; errorCode?: string };
};
