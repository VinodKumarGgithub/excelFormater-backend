// utils/redisKeys.ts
export const redisKeys = {
    apiData: (sessionId, reqId) => `apidata:${sessionId}:${reqId}`,
    apiStats: (sessionId) => `apistats:${sessionId}`,
    apiRequests: (sessionId) => `apirequests:${sessionId}`,
    sessionConfig: (sessionId) => `session:${sessionId}`,
    apiChart: (sessionId) => `api:chart:${sessionId}`,
    // Set-based keys for exact counts
    apiSuccess: (sessionId) => `apistats:${sessionId}:success`,
    apiFailure: (sessionId) => `apistats:${sessionId}:failure`,
    apiTotal: (sessionId) => `apistats:${sessionId}:total`
  };
  