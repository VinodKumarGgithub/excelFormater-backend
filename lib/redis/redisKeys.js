// utils/redisKeys.ts
export const redisKeys = {
    apiData: (sessionId, reqId) => `apidata:${sessionId}:${reqId}`,
    apiStats: (sessionId) => `apistats:${sessionId}`,
    apiRequests: (sessionId) => `apirequests:${sessionId}`,
    sessionConfig: (sessionId) => `session:${sessionId}`
  };
  